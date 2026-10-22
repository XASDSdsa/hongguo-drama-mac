"""Local structured worker. Results go to JSON; stdout is progress NDJSON only."""
import argparse
import json
import os
from pathlib import Path
import unicodedata
import sys
import wave

# Windows consoles default to cp1252; progress lines carry Chinese text and the parent reads UTF-8.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8')


def progress(value, message):
    print(json.dumps(dict(type='progress', progress=value, message=message), ensure_ascii=False), flush=True)


def detect(args):
    import numpy as np
    import torch
    from vendor.transnetv2_pytorch import TransNetV2
    torch.set_num_threads(args.threads)
    if args.device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('Selected CUDA device is unavailable; no automatic fallback')
    if args.device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('Selected MPS device is unavailable; no automatic fallback')
    model = TransNetV2()
    model.load_state_dict(torch.load(args.model, map_location='cpu', weights_only=True))
    model.eval().to(args.device)
    frame_bytes = 27 * 48 * 3
    size = os.path.getsize(args.input)
    if not size or size % frame_bytes:
        raise ValueError('Decoded RGB data is incomplete')
    frames = np.memmap(args.input, dtype=np.uint8, mode='r', shape=(size // frame_bytes, 27, 48, 3))
    single, all_frames = [], []
    with torch.inference_mode():
        for offset in range(0, len(frames), 50):
            indices = np.clip(np.arange(offset - 25, offset + 75), 0, len(frames) - 1)
            batch = torch.from_numpy(np.array(frames[indices])).unsqueeze(0).to(args.device)
            one, many = model(batch)
            count = min(50, len(frames) - offset)
            single.extend(torch.sigmoid(one)[0, 25:25 + count, 0].cpu().tolist())
            all_frames.extend(torch.sigmoid(many['many_hot'])[0, 25:25 + count, 0].cpu().tolist())
            progress(100 * (offset + count) / len(frames), f'TransNet V2 {offset + count}/{len(frames)}')
    return dict(single=single, all=all_frames, model=dict(name='TransNet V2', revision='85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed', runtime='torch', runtime_version=torch.__version__, device=args.device))


def verify_shots(args):
    import numpy as np
    from shot_verification import candidate_frames, verify
    from shot_duration import minimum_duration
    media = json.loads(Path(args.timeline).read_text(encoding='utf-8'))
    predictions = json.loads(Path(args.predictions).read_text(encoding='utf-8'))
    pts = np.asarray([f['start'] for f in media['frames']], dtype=np.float64)
    scores = np.asarray(predictions['single'], dtype=np.float64)
    count = media['frame_count']
    end = float(media['video_end'])
    if (len(pts) != count or len(scores) != count or count < 1
            or not np.all(np.isfinite(pts)) or not np.all(np.isfinite(scores))
            or np.any(scores < 0) or np.any(scores > 1)
            or pts[0] < 0 or np.any(np.diff(pts) <= 0)
            or not np.isfinite(end) or end <= pts[-1]
            or args.threshold != 0.5):
        raise ValueError('Invalid verification timeline or prediction scores')
    if os.path.getsize(args.input) != count * 90 * 160 * 3:
        raise ValueError('Verification RGB frames do not match source timeline')
    frames = np.memmap(args.input, dtype=np.uint8, mode='r', shape=(count, 90, 160, 3))
    origin = float(pts[0])
    relative_pts = pts - origin
    # TransNet V2 flags the LAST frame of the outgoing shot (its one-hot training label sits on the
    # frame before the cut), so the next shot starts one frame later. Verification runs on the model
    # frame; every frame reported below is the first frame of the next shot.
    model_frames = [frame for frame in candidate_frames(scores, args.threshold) if frame + 1 < count]
    progress(10, '复核亮度变化、特效闪光和真实画面变化')
    verified_model, decisions = verify(frames, relative_pts, model_frames, end - origin)
    boundaries = [frame + 1 for frame in verified_model]
    boundary_scores = np.concatenate(([0.0], scores[:-1]))  # boundary b carries the score of model frame b - 1
    cuts, warning = minimum_duration(boundaries, pts, end, boundary_scores, 2)
    for decision in decisions:
        decision['model_frame'] = decision['frame']
        decision['frame'] += 1
        decision['time'] = float(pts[decision['frame']])
    progress(100, f'复核完成：{len(cuts) + 1} 个分镜，短片段合并且保留全部帧')
    return dict(algorithm_id='transnetv2-temporal-min2s-v2', threshold=args.threshold,
                boundary_convention='first_frame_of_next_shot',
                minimum_duration=2, frame_count=count, candidate_frames=[frame + 1 for frame in model_frames],
                verified_candidate_frames=boundaries, decisions=decisions, cuts=cuts,
                duration_merged_frames=[b for b in boundaries if b not in cuts],
                warnings=[warning] if warning else [])


def punctuate_segments(segments, punctuation):
    """Recover sentence boundaries with context, retaining original VAD timing."""
    if not segments:
        return segments
    def content(text):
        return ''.join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith('P'))
    originals = [content(segment['text']) for segment in segments]
    if any(not text for text in originals):
        raise ValueError('标点输入含没有文字的识别段')
    restored = punctuation.add_punctuation(' '.join(segment['text'] for segment in segments))
    if content(restored) != ''.join(originals):
        raise ValueError('标点模型改变了识别文字，已保留原文')
    # Assign punctuation following the final character to that VAD segment.
    # A VAD pause does not insert a full stop; only the model's actual sentence
    # marks will later create sentences, using acoustic alignment for timing.
    pieces, index, consumed = ['' for _ in segments], 0, 0
    for char in restored:
        is_content = bool(content(char))
        if is_content and consumed == len(originals[index]):
            index += 1
            consumed = 0
        if index >= len(pieces):
            raise ValueError('标点回填文字数量不一致')
        pieces[index] += char
        consumed += int(is_content)
    if [content(piece) for piece in pieces] != originals:
        raise ValueError('标点回填未完整保留识别文字')
    return [{**segment, 'text': piece.strip()} for segment, piece in zip(segments, pieces)]


def restore_punctuation(segments, punctuation):
    try:
        return punctuate_segments(segments, punctuation), 'ct_transformer_global', []
    except Exception as error:
        # The model can truncate a long input; recover each VAD independently
        # so one changed/missing word cannot discard the whole episode's marks.
        warnings = [dict(code='punctuation_global_fallback', reason=str(error))]
    restored, recovered = [], 0
    for index, segment in enumerate(segments):
        try:
            restored.extend(punctuate_segments([segment], punctuation))
            recovered += 1
        except Exception as error:
            restored.append(dict(segment))
            warnings.append(dict(code='punctuation_unresolved', segment_index=index,
                                 start=segment.get('start'), end=segment.get('end'),
                                 reason=str(error)))
    return restored, 'ct_transformer_vad' if recovered else None, warnings


def transcribe(args):
    import numpy as np
    import sherpa_onnx as sherpa
    recognizer = sherpa.OfflineRecognizer.from_paraformer(paraformer=args.model, tokens=args.tokens, num_threads=args.threads, sample_rate=16000, feature_dim=80, provider=args.device)
    cfg = sherpa.VadModelConfig()
    cfg.silero_vad.model = args.vad
    cfg.silero_vad.threshold = args.threshold
    cfg.silero_vad.min_silence_duration = args.min_silence
    cfg.silero_vad.min_speech_duration = args.min_speech
    cfg.silero_vad.max_speech_duration = 20
    cfg.sample_rate = 16000
    cfg.num_threads = args.threads
    cfg.provider = args.device
    vad = sherpa.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)
    punctuation = None
    if args.punctuation:
        pc = sherpa.OfflinePunctuationConfig(model=sherpa.OfflinePunctuationModelConfig(ct_transformer=args.punctuation, num_threads=args.threads, provider=args.device))
        punctuation = sherpa.OfflinePunctuation(pc)
    segments, vad_segments, warnings = [], [], []
    with wave.open(args.input, 'rb') as wav:
        if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError('ASR requires 16kHz mono PCM16')
        total = wav.getnframes()
        window = cfg.silero_vad.window_size

        def drain():
            while not vad.empty():
                start = int(vad.front.start)
                samples = np.asarray(vad.front.samples, dtype=np.float32).copy()
                vad.pop()
                count = min(len(samples), total - start)
                if count <= 0:
                    continue
                # Keep VAD intervals for diagnostics. The Node timeline builder
                # only uses text-bearing ASR segments for the human-voice mask;
                # VAD-only intervals are not allowed to add sound to that track.
                vad_segments.append(dict(start_sample=start, end_sample_exclusive=start + count,
                                         start=start / 16000, end=(start + count) / 16000))
                stream = recognizer.create_stream()
                stream.accept_waveform(16000, samples[:count])
                recognizer.decode_stream(stream)
                text = stream.result.text.strip()
                if text:
                    segments.append(dict(start_sample=start, end_sample_exclusive=start + count, start=start / 16000, end=(start + count) / 16000, text=text))
                else:
                    warnings.append(dict(start=start / 16000, end=(start + count) / 16000, reason='VAD detected speech but recognition was empty'))

        consumed = 0
        while True:
            raw = wav.readframes(window)
            if not raw:
                break
            samples = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768
            consumed += len(samples)
            if len(samples) < window:
                samples = np.pad(samples, (0, window - len(samples)))
            vad.accept_waveform(samples)
            drain()
            if consumed % (window * 100) == 0:
                progress(consumed / total * 100, f'已识别 {len(segments)} 段台词')
        vad.flush()
        drain()
    boundary_source = None
    if punctuation and segments:
        progress(98, '结合整集上下文恢复句末标点')
        segments, boundary_source, punctuation_warnings = restore_punctuation(segments, punctuation)
        warnings.extend(punctuation_warnings)
    return dict(segments=segments, vad_segments=vad_segments, warnings=warnings, sample_rate=16000,
                sentence_boundary_source=boundary_source, runtime_version=sherpa.__version__,
                timing_method='vad_segment', duration=total / 16000)


def inpaint_server(args):
    """LaMa (big-lama TorchScript) inpainting for keyframe subtitles. Resident: the model loads once,
    then one JSON job per stdin line -> one JSON reply per stdout line. A job names a raw RGB crop
    (width*height*3 bytes), a mask (width*height bytes, non-zero = repaint) and where to write the
    model's RGB output (same size, not composited: the caller pastes back only the masked box)."""
    import time
    import numpy as np
    import torch
    torch.set_num_threads(max(1, args.threads))
    # Weights are stored as float16 to keep the installer small; compute in float32.
    model = torch.jit.load(args.model, map_location='cpu').eval().float()
    with torch.no_grad():
        model(torch.zeros(1, 3, 64, 64), torch.zeros(1, 1, 64, 64))
    finder = None
    if args.detector:
        from textclean import TextFinder
        finder = TextFinder(args.detector)
    print(json.dumps(dict(type='ready', torch=torch.__version__, threads=torch.get_num_threads(), detector=bool(finder))), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = {}
        try:
            job = json.loads(line)
            width, height = int(job['width']), int(job['height'])
            if width < 8 or height < 8 or width > 4096 or height > 4096:
                raise ValueError('bad crop size')
            image = np.frombuffer(Path(job['input']).read_bytes(), np.uint8)
            mask = np.frombuffer(Path(job['mask']).read_bytes(), np.uint8) if job.get('mask') else np.zeros(width * height, np.uint8)
            if image.size != width * height * 3 or mask.size != width * height:
                raise ValueError('crop or mask size mismatch')
            image = image.reshape(height, width, 3)
            if job.get('op') == 'clean':
                # Whole keyframe: find the text anywhere, repaint it, look again. No mask from the caller.
                if finder is None:
                    raise ValueError('text detector not loaded')
                from textclean import clean_frame
                cleaned, info = clean_frame(finder, model, torch, image, job.get('options'))
                temporary = job['output'] + '.tmp'
                Path(temporary).write_bytes(np.ascontiguousarray(cleaned).tobytes())
                os.replace(temporary, job['output'])
                print(json.dumps(dict(type='done', id=job.get('id'), **info), ensure_ascii=False), flush=True)
                continue
            mask = (mask.reshape(height, width) > 0).astype(np.float32)
            pad_h, pad_w = (8 - height % 8) % 8, (8 - width % 8) % 8
            padded = np.pad(image, ((0, pad_h), (0, pad_w), (0, 0)), mode='symmetric')
            padded_mask = np.pad(mask, ((0, pad_h), (0, pad_w)), mode='symmetric')
            started = time.time()
            with torch.no_grad():
                output = model(torch.from_numpy(padded.copy()).permute(2, 0, 1)[None].float() / 255,
                               torch.from_numpy(padded_mask.copy())[None, None])
            result = (output[0].permute(1, 2, 0).numpy() * 255).round().clip(0, 255).astype(np.uint8)[:height, :width]
            temporary = job['output'] + '.tmp'
            Path(temporary).write_bytes(np.ascontiguousarray(result).tobytes())
            os.replace(temporary, job['output'])
            print(json.dumps(dict(type='done', id=job.get('id'), seconds=round(time.time() - started, 3))), flush=True)
        except Exception as error:  # one bad job must not stop the server
            print(json.dumps(dict(type='error', id=job.get('id'), message=f'{type(error).__name__}: {error}'), ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('module', choices=['shots', 'verify-shots', 'transcript', 'status', 'inpaint'])
    parser.add_argument('--input')
    parser.add_argument('--output')
    parser.add_argument('--model')
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--timeline')
    parser.add_argument('--predictions')
    parser.add_argument('--tokens')
    parser.add_argument('--vad')
    parser.add_argument('--punctuation')
    parser.add_argument('--threshold', type=float, default=0.5)
    parser.add_argument('--min-silence', type=float, default=0.5)
    parser.add_argument('--min-speech', type=float, default=0.25)
    parser.add_argument('--detector')
    args = parser.parse_args()
    if args.module == 'inpaint':
        inpaint_server(args)
        return
    if args.module == 'status':
        import torch
        import sherpa_onnx
        import cv2
        print(json.dumps(dict(torch=torch.__version__, sherpa_onnx=sherpa_onnx.__version__, cuda=torch.cuda.is_available(), mps=torch.backends.mps.is_available(), sherpa_providers=['cpu'], opencv=cv2.__version__, shot_algorithm='transnetv2-temporal-min2s-v2', sentence_boundary='ct_transformer_global')))
        return
    result = {'shots': detect, 'verify-shots': verify_shots, 'transcript': transcribe}[args.module](args)
    temporary = args.output + '.tmp'
    Path(temporary).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    os.replace(temporary, args.output)


if __name__ == '__main__':
    main()
