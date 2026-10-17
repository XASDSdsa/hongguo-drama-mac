"""Align text to audio; only confirmed acoustic pauses may cut voice clips."""
from __future__ import annotations

import math
import unicodedata

ALGORITHM = 'whisper-audio-pause-v4'
PAUSE_SPLIT_SECONDS = 0.20


def spoken_characters(text):
    return ''.join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith('P'))


def _fallback(segment, source_id, reason):
    row = {**segment, 'timing_method': 'vad_segment_unresolved',
           'source_segment_ids': [source_id], 'needs_review': True}
    row['speech_spans'] = [_speech_span(row)]
    warning = {'reason': '句级声学对齐待检查，已保留完整原台词段：' + reason,
               'code': 'sentence_alignment_unresolved', 'source_segment_ids': [source_id],
               'start': segment['start_sample'] / 16000, 'end': segment['end_sample_exclusive'] / 16000}
    return [row], warning


def _speech_span(row):
    result = {key: row[key] for key in ('start_sample', 'end_sample_exclusive', 'start', 'end', 'source_segment_ids')}
    for key in ('source_text_start', 'source_text_end'):
        if key in row:
            result[key] = row[key]
    return result


def _slice_by_spoken_offsets(text, start, end):
    """Return the text between spoken-character offsets.

    Punctuation and closing quotes stay attached to the preceding piece.  We
    only call this at measured word boundaries, so no character timing is
    invented and no word is cut in half.
    """
    total = len(spoken_characters(text))
    if not 0 <= start < end <= total:
        raise ValueError('停顿分句文字范围无效')
    if start == 0:
        begin = 0
    else:
        count, begin = 0, None
        for index, char in enumerate(text):
            if not unicodedata.category(char).startswith('P') and not char.isspace():
                if count == start:
                    begin = index
                    break
                count += 1
        if begin is None:
            raise ValueError('停顿分句起点不在文字边界')
    if end == total:
        finish = len(text)
    else:
        count, finish = 0, None
        for index, char in enumerate(text):
            if not unicodedata.category(char).startswith('P') and not char.isspace():
                if count == end:
                    finish = index
                    break
                count += 1
        if finish is None:
            raise ValueError('停顿分句终点不在文字边界')
    piece = text[begin:finish]
    if not spoken_characters(piece):
        raise ValueError('停顿分句为空')
    return piece


def acoustic_evidence(audio, rate=16000, detector=None):
    """A cut requires sustained quiet PCM AND VAD non-speech, never punctuation."""
    import numpy as np
    samples = np.asarray(audio, dtype=np.float32)
    if samples.ndim != 1 or not np.isfinite(samples).all():
        raise ValueError('声学分析需要有限单声道采样')
    if detector is None:
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        detector = lambda data: get_speech_timestamps(data, VadOptions(
            min_silence_duration_ms=200, min_speech_duration_ms=100,
            max_speech_duration_s=float('inf'), speech_pad_ms=0), sampling_rate=rate)
    speech = detector(samples)
    previous = 0
    for span in speech:
        a, b = span.get('start'), span.get('end')
        if not isinstance(a, int) or not isinstance(b, int) or a < previous or b <= a or b > len(samples):
            raise ValueError('VAD声学区间无效')
        previous = b
    frame = max(1, round(rate * .01))
    if not len(samples):
        return dict(speech=[], pauses=[], quiet=[])
    padded = np.pad(samples, (0, (-len(samples)) % frame))
    energies = np.sqrt(np.mean(padded.reshape(-1, frame).astype(np.float64) ** 2, axis=1))
    positive = np.sort(energies[energies > 0])
    body = float(positive[int((len(positive) - 1) * .8)]) if len(positive) else 0
    threshold = min(10 ** (-38 / 20), body * 10 ** (-24 / 20))
    quiet, first = [], None
    minimum = round(PAUSE_SPLIT_SECONDS * rate)
    for index in range(len(energies) + 1):
        low = index < len(energies) and energies[index] <= threshold
        if low and first is None:
            first = index * frame
        elif not low and first is not None:
            last = min(index * frame, len(samples))
            if last - first >= minimum:
                quiet.append(dict(start=first, end=last))
            first = None
    pauses = []
    for before, after in zip(speech, speech[1:]):
        for interval in quiet:
            a, b = max(before['end'], interval['start']), min(after['start'], interval['end'])
            if b - a >= minimum:
                pauses.append(dict(start=a, end=b))
    return dict(speech=speech, pauses=pauses, quiet=quiet)


def align_segment(segment, words, source_id, evidence=None):
    """Text labels audio; no acoustic evidence means no interior cut."""
    rate = 16000
    a, b = segment['start_sample'], segment['end_sample_exclusive']
    count, text = b - a, segment['text']
    measured, content, previous_end = [], '', 0
    for word in words:
        value = spoken_characters(str(word.get('word', '')))
        if not value:
            continue
        try:
            start, end, probability = float(word['start']), float(word['end']), float(word['probability'])
            if not all(map(math.isfinite, (start, end, probability))) or not 0 <= probability <= 1:
                raise ValueError('无效声学数值')
            first, last = round(start * rate), round(end * rate)
            if first < previous_end or first < 0 or last < first or last > count:
                raise ValueError('词时间倒置、重叠或超出原始语音段')
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            return _fallback(segment, source_id, str(exc))
        measured.append(dict(first=a + first, last=a + last, probability=probability,
                             text_start=len(content), text_end=len(content) + len(value)))
        content += value
        previous_end = last
    if not measured or content != spoken_characters(text):
        return _fallback(segment, source_id, '对齐词与识别原文不一致')
    if measured[-1]['last'] <= measured[0]['first']:
        return _fallback(segment, source_id, '整段没有可定位的发声时长')
    evidence = evidence or dict(speech=[], pauses=[])
    pad, tolerance = 640, 1280  # 40ms protection, 80ms alignment uncertainty.
    cuts, unresolved = [], []
    for pause in evidence['pauses']:
        left, right = pause['start'], pause['end']
        if left <= a or right >= b:
            continue
        candidates = []
        for i, (before, after) in enumerate(zip(measured, measured[1:]), 1):
            if (before['first'] < left and right < after['last']
                    and left - tolerance <= before['last'] <= right + tolerance
                    and left - tolerance <= after['first'] <= right + tolerance
                    and min(before['probability'], after['probability']) >= .01):
                candidates.append(i)
        if len(candidates) != 1 or (cuts and candidates[0] <= cuts[-1]['index']):
            unresolved.append(dict(start=left / rate, end=right / rate))
            continue
        cuts.append(dict(index=candidates[0], start=left, end=right))
    # Audio protects real speech at recognition-window edges when DTW drifts.
    # DTW can miss a quiet initial/final syllable. Preserve source endpoints;
    # only PCM-confirmed silence outside VAD speech may shorten them.
    first, last = a, b
    for quiet in evidence.get('quiet', []):
        if quiet['start'] <= a and a < quiet['end'] < b:
            candidate = min(measured[0]['first'], quiet['end'] - pad)
            if candidate > a and not any(s['start'] < candidate and s['end'] > a for s in evidence['speech']):
                first = candidate
        if a < quiet['start'] < b and quiet['end'] >= b:
            candidate = max(measured[-1]['last'], quiet['start'] + pad)
            if candidate < b and not any(s['start'] < b and s['end'] > candidate for s in evidence['speech']):
                last = candidate
    bounds = [0] + [cut['index'] for cut in cuts] + [len(measured)]
    output = []
    for i, (left, right) in enumerate(zip(bounds, bounds[1:])):
        start = first if i == 0 else max(a, cuts[i - 1]['end'] - pad)
        end = last if i == len(bounds) - 2 else min(b, cuts[i]['start'] + pad)
        if end <= start:
            return _fallback(segment, source_id, '声学切分出现无效区间')
        text_start, text_end = measured[left]['text_start'], measured[right - 1]['text_end']
        row = dict(start_sample=start, end_sample_exclusive=end, start=start / rate, end=end / rate,
                   text=_slice_by_spoken_offsets(text, text_start, text_end), timing_method=ALGORITHM,
                   source_segment_ids=[source_id], source_text_start=text_start, source_text_end=text_end,
                   sentence_boundary_source='acoustic_pause' if cuts else 'continuous_audio')
        if cuts:
            row['boundary_reason'] = '实际音频持续低能量且VAD确认为非语音'
        if unresolved or any(w['probability'] < .01 or w['first'] == w['last'] for w in measured[left:right]):
            row['needs_review'] = True
        row['speech_spans'] = [_speech_span(row)]
        output.append(row)
    warning = None
    if not any(s['start'] < b and s['end'] > a for s in evidence['speech']):
        for row in output:
            row['needs_review'] = True
        warning = dict(code='acoustic_speech_unresolved', reason='VAD未确认本段语音，保留原音频区间待核对，未按文字切割', source_segment_ids=[source_id])
    if unresolved:
        warning = dict(code='acoustic_pause_text_unresolved', reason='音频存在停顿，但文字定位不可靠，保留连续片段待核对，未猜测切字',
                       source_segment_ids=[source_id], pauses=unresolved)
    elif warning is None and any(r.get('needs_review') for r in output):
        warning = dict(code='audio_alignment_low_confidence', reason='文字声学对齐置信度偏低；未使用标点增加切口',
                       source_segment_ids=[source_id], start=output[0]['start'], end=output[-1]['end'])
    return output, warning


def join_continuous_windows(rows, sources, evidence):
    """An uncapped VAD and PCM must confirm speech across an ASR window cut."""
    result = []
    for row in rows:
        if not result:
            result.append(row)
            continue
        previous = result[-1]
        before_id, after_id = previous['source_segment_ids'][-1], row['source_segment_ids'][0]
        before, after = sources[before_id], sources[after_id]
        left, right = before['end_sample_exclusive'], after['start_sample']
        different = before_id != after_id and 0 <= right - left <= 3200
        margin = 1280
        continuous = any(s['start'] <= left - margin and s['end'] >= right + margin for s in evidence['speech'])
        quiet = any(s['start'] < right + margin and s['end'] > left - margin for s in evidence['quiet'])
        if not different or not continuous or quiet:
            result.append(row)
            continue
        merged = {**previous, 'text': previous['text'] + row['text'], 'end_sample_exclusive': row['end_sample_exclusive'],
                  'end': row['end'], 'source_segment_ids': list(dict.fromkeys(previous['source_segment_ids'] + row['source_segment_ids'])),
                  'sentence_boundary_source': 'continuous_audio', 'boundary_reason': '实际语音连续，取消识别窗口人工切口'}
        merged.pop('source_text_start', None)
        merged.pop('source_text_end', None)
        if row.get('needs_review'):
            merged['needs_review'] = True
        merged['speech_spans'] = [_speech_span(merged)]
        result[-1] = merged
    return result


def align_transcript(data, audio, aligner, progress=None, detector=None):
    rate = data.get('sample_rate')
    duration = data.get('duration')
    if rate != 16000 or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('句级对齐需要有效的 16kHz 原始识别结果')
    if abs(len(audio) / rate - duration) > 1 / rate + 1e-9:
        raise ValueError('对齐音频时长与原始识别结果不一致')
    segments = data.get('segments')
    if not isinstance(segments, list):
        raise ValueError('原始识别结果缺少 segments')
    previous_end = 0
    for segment in segments:
        a, b, text = segment.get('start_sample'), segment.get('end_sample_exclusive'), segment.get('text')
        if type(a) is not int or type(b) is not int or a < previous_end or b <= a or b > len(audio):
            raise ValueError('原始识别段采样区间重叠或越界')
        if not isinstance(text, str) or not spoken_characters(text):
            raise ValueError('原始识别段缺少可对齐台词')
        previous_end = b
    output, warnings, unresolved, sources = [], list(data.get('warnings') or []), 0, {}
    evidence = acoustic_evidence(audio, rate, detector)
    for i, segment in enumerate(segments):
        a, b = segment['start_sample'], segment['end_sample_exclusive']
        source_id = segment.get('segment_id') or f'vad:{a}-{b}'
        source = {**segment, 'start': a / rate, 'end': b / rate}
        sources[source_id] = source
        try:
            words = aligner(segment['text'], audio[a:b])
            rows, warning = align_segment(source, words, source_id, evidence)
        except Exception as exc:
            rows, warning = _fallback(source, source_id, f'对齐引擎失败：{type(exc).__name__}: {exc}')
        output.extend(rows)
        if warning:
            warnings.append(warning)
            unresolved += 1
        if progress:
            progress((i + 1) / max(1, len(segments)) * 100, f'已对齐 {i + 1}/{len(segments)} 段，{unresolved} 段待检查')
    before_join = len(output)
    output = join_continuous_windows(output, sources, evidence)
    if ''.join(spoken_characters(s['text']) for s in output) != ''.join(spoken_characters(s['text']) for s in segments):
        raise ValueError('对齐后台词未完整保留')
    return {**data, 'segments': output, 'warnings': warnings, 'timing_method': ALGORITHM,
            'alignment_summary': {'source_segments': len(segments), 'sentences': len(output), 'unresolved_segments': unresolved,
                                  'unresolved_sentence_boundaries': sum(bool(row.get('needs_review')) for row in output),
                                  'continuous_window_joins': before_join - len(output)}}


def whisper_aligner(model):
    from faster_whisper.tokenizer import Tokenizer
    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task='transcribe', language='zh')

    def align(text, audio):
        if len(audio) > model.feature_extractor.n_samples:
            raise ValueError('原始语音段超过模型窗口，不能截断后声称完整对齐')
        # Punctuation has no speech; do not let punctuation tokens stretch nearby words.
        acoustic_text = ''.join(c for i, c in enumerate(text)
                                if not unicodedata.category(c).startswith('P')
                                or (c == '.' and i > 0 and i + 1 < len(text)
                                    and text[i - 1].isdigit() and text[i + 1].isdigit()))
        features = model.feature_extractor(audio)
        encoded = model.encode(features)
        return model.find_alignment(tokenizer, [tokenizer.encode(acoustic_text)], encoded,
                                    num_frames=max(1, min(len(audio) // 160, 3000)))[0]
    return align
