#!/usr/bin/env python3
"""Generate a complete SRT with faster-whisper.

The Electron main process starts this file as an external Python process.  A
separate process keeps model memory and failures away from the renderer and
lets several episodes run concurrently.  Device selection is resolved once by
the caller and is never changed half way through an episode.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

DLL_DIRECTORIES = []


def prepare_bundled_runtime() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    if getattr(sys, 'frozen', False):
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        if sys.platform == 'win32':
            internal = Path(sys._MEIPASS)
            directories = [internal, internal / 'cuda', internal / 'ctranslate2']
            for directory in directories:
                if directory.is_dir():
                    DLL_DIRECTORIES.append(os.add_dll_directory(str(directory)))
                    os.environ['PATH'] = str(directory) + os.pathsep + os.environ.get('PATH', '')


def emit_progress(percent: float, message: str) -> None:
    value = max(0.0, min(100.0, float(percent)))
    print(f"PROGRESS {value:.1f} {message}", file=sys.stderr, flush=True)


def detect_cuda() -> bool:
    try:
        import ctranslate2  # type: ignore

        count = getattr(ctranslate2, "get_cuda_device_count", None)
        return bool(count and count() > 0)
    except Exception:
        return False


def probe() -> int:
    result = {
        "python": sys.executable,
        "faster_whisper": False,
        "cuda": False,
        "bundled": bool(getattr(sys, 'frozen', False)),
        "error": "",
    }
    try:
        import faster_whisper  # noqa: F401  # type: ignore

        result["faster_whisper"] = True
        result["cuda"] = detect_cuda()
    except Exception as exc:  # pragma: no cover - depends on user runtime
        result["error"] = str(exc)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    # Probe is a capability query.  A missing package is represented in JSON
    # so the Electron side can show the actionable install/path error instead
    # of treating the query itself as a crashed transcription process.
    return 0


def load_model(args):
    from faster_whisper import WhisperModel

    device = args.device
    if device == 'auto':
        device = 'cuda' if detect_cuda() else 'cpu'
    compute_type = args.compute_type
    if compute_type == 'auto':
        compute_type = 'float16' if device == 'cuda' else 'int8'
    return WhisperModel(args.model, device=device, compute_type=compute_type,
                        local_files_only=args.local_files_only or bool(getattr(sys, 'frozen', False)))


def self_test(args) -> int:
    import numpy as np
    from faster_whisper.vad import get_speech_timestamps

    audio = np.zeros(16000, dtype=np.float32)
    get_speech_timestamps(audio)
    model = load_model(args)
    segments, _ = model.transcribe(audio, language='zh', beam_size=1, vad_filter=False)
    list(segments)
    print(json.dumps({'ok': True, 'bundled': bool(getattr(sys, 'frozen', False)),
                      'model': str(args.model), 'device': args.device, 'vad': True}), flush=True)
    return 0


def timestamp(seconds: float) -> str:
    millis = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_srt(output: Path, segments, duration: float) -> int:
    rows = []
    for segment in segments:
        start = max(0.0, float(getattr(segment, "start", 0.0) or 0.0))
        end = max(0.0, float(getattr(segment, "end", 0.0) or 0.0))
        if duration > 0:
            start = min(start, duration)
            end = min(end, duration)
        text = str(getattr(segment, "text", "") or "").replace("\r", "").strip()
        if end <= start or not text:
            continue
        rows.append((start, end, text))
    if not rows:
        raise RuntimeError("faster-whisper 未识别到可用字幕")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{output.stem}-", suffix=".tmp", dir=output.parent)
    os.close(fd)
    temporary_path = Path(temporary)
    try:
        with temporary_path.open("w", encoding="utf-8", newline="\n") as handle:
            for index, (start, end, text) in enumerate(rows, 1):
                handle.write(f"{index}\n{timestamp(start)} --> {timestamp(end)}\n{text}\n\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, output)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
    return len(rows)


def transcribe(args: argparse.Namespace) -> int:
    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.is_file() or input_path.stat().st_size <= 0:
        raise RuntimeError(f"输入视频不存在或为空：{input_path}")
    emit_progress(0, "加载模型")
    model = load_model(args)
    emit_progress(1, "开始转写")
    segments, info = model.transcribe(
        str(input_path),
        language=args.language or None,
        vad_filter=True,
        beam_size=1,
        word_timestamps=False,
        condition_on_previous_text=False,
    )
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    # transcribe() returns a lazy generator.  Consume it here so progress is
    # emitted while decoding rather than after the entire file is finished.
    collected = []
    for segment in segments:
        collected.append(segment)
        end = float(getattr(segment, "end", 0.0) or 0.0)
        percent = 2.0 if duration <= 0 else min(98.0, max(2.0, end / duration * 98.0))
        emit_progress(percent, "识别字幕")
    count = write_srt(output_path, collected, duration)
    emit_progress(100, f"完成 {count} 条字幕")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--language", default="zh")
    args = parser.parse_args()
    if args.probe:
        return probe()
    if not args.self_test and (not args.input or not args.output):
        parser.error("转写需要 --input 和 --output")
    try:
        if args.self_test:
            return self_test(args)
        return transcribe(args)
    except Exception as exc:
        print(f"ERROR {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    prepare_bundled_runtime()
    raise SystemExit(main())
