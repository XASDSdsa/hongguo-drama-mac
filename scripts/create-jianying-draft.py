#!/usr/bin/env python3
"""Create a first native Jianying draft from one structure project.

This adapter deliberately uses only the project's checked outputs.  It does
not recalculate shot boundaries or concatenate the voice/background tracks.
The generated draft is a local preview until it has been opened and saved by
the target Jianying version.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

# Prefer the checked-out current fork when this repository has one.  The
# package published as 0.3.1 still writes the legacy draft_content.json name,
# which Jianying 6+ treats as a damaged project when placed in its draft root.
_repo_root = Path(__file__).resolve().parents[1]
_local_library = os.environ.get("JIANYING_PYJY_SOURCE") or str(
    _repo_root / ".cache" / "pyJianYingDraft-src-20261015"
)
if (_local_library and (Path(_local_library) / "pyJianYingDraft").is_dir()):
    sys.path.insert(0, _local_library)

import pyJianYingDraft as draft


TOLERANCE = 0.002
EFFECTS_FILTER = "highpass=f=900,acompressor=threshold=0.1:ratio=3:attack=5:release=50,alimiter=limit=0.95"
DEFAULT_WATERMARK = "XX传媒"
DEFAULT_DISCLAIMER = "剧情纯属虚构 请勿代入现实"
BOUNDARY_POLICY = "shot_cut_requires_acoustic_pause"
ALIGNMENT_ALGORITHM = "visual-shot-on-acoustic-pause-v1"
SUBTITLE_POLICY = "voice-segments-v1"
PAUSE_SECONDS = 0.12
# Mirrors PAUSE_TIERS in alignment.js: a cut must sit at least `margin` inside a pause of at least `pause` seconds.
# Levels 1-2 only break up segments longer than the maximum and never cut inside speech.
PAUSE_TIERS = ({"level": 0, "pause": 0.12, "margin": 0.03}, {"level": 1, "pause": 0.09, "margin": 0.02}, {"level": 2, "pause": 0.07, "margin": 0.015})


def progress(value: float, message: str) -> None:
    print(json.dumps({"type": "progress", "progress": value, "message": message}, ensure_ascii=False), flush=True)


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def module_data(project_dir: Path, project: dict, module: str) -> tuple[dict, Path]:
    record = project["modules"].get(module)
    if not record or record.get("status") != "succeeded":
        raise RuntimeError(f"模块 {module} 未完成，不能创建剪映草稿")
    result_path = project_dir / record["result_path"]
    if not result_path.is_file():
        raise FileNotFoundError(f"模块 {module} 结果不存在：{result_path}")
    return read_json(result_path), result_path.parent


def require_file(path: Path, label: str) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"{label}不存在：{path}")
    return path


def us(seconds: float) -> int:
    return int(round(float(seconds) * 1_000_000))


def subtitle_text(value: str) -> str:
    return re.sub(r"[\r\n]+", " ", str(value)).strip()


def speech_ranges(transcript: dict) -> list[tuple[float, float]]:
    voices = (transcript.get("voice_timeline") or {}).get("segments") or []
    source = voices if voices else transcript.get("utterances") or []
    ranges = []
    for item in source:
        start, end = float(item["start"]), float(item["end"])
        if end > start:
            ranges.append((start, end))
    ranges.sort()
    merged: list[tuple[float, float]] = []
    for start, end in ranges:
        if merged and start <= merged[-1][1] + 1e-9:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def acoustic_pauses(transcript: dict, min_pause: float = PAUSE_SECONDS) -> list[tuple[float, float]]:
    speech = speech_ranges(transcript)
    return [(speech[index][1], speech[index + 1][0]) for index in range(len(speech) - 1) if speech[index + 1][0] - speech[index][1] >= min_pause - 1e-4]


def breath_on_cut(time: float, transcript: dict, level: int = 0) -> bool:
    tier = PAUSE_TIERS[level]
    if any(start < time < end for start, end in speech_ranges(transcript)):
        return False
    margin = tier["margin"]
    return any(start + margin - 1e-6 <= time <= end - margin + 1e-6 for start, end in acoustic_pauses(transcript, tier["pause"]))


def output_groups(raw_shots: list[dict], transcript: dict) -> list[list[dict]]:
    """Standard (level 0) grouping; segments longer than the maximum are split by groups_from_decisions."""
    original = sorted(raw_shots, key=lambda item: int(item["order"]))
    if not original:
        return []
    groups = [[original[0]]]
    for raw in original[1:]:
        if breath_on_cut(float(raw["start"]), transcript):
            groups.append([raw])
        else:
            groups[-1].append(raw)
    return groups


def groups_from_decisions(raw_shots: list[dict], aligned: dict, transcript: dict) -> list[list[dict]]:
    """Rebuild the output groups from the recorded decisions, re-checking each one against the audio."""
    original = sorted(raw_shots, key=lambda item: int(item["order"]))
    if not original:
        return []
    decisions = aligned.get("boundary_decisions")
    if aligned.get("pause_tiers") != list(PAUSE_TIERS) or not isinstance(decisions, list) or len(decisions) != len(original) - 1:
        raise RuntimeError("最终分段的气口判定记录缺失或版本不一致，请继续完整流程重新关联。")
    relaxed_allowed = bool(aligned.get("max_shot_seconds"))
    groups = [[original[0]]]
    for raw, decision in zip(original[1:], decisions):
        if decision.get("frame") != raw.get("start_frame") or us(decision.get("time")) != us(raw.get("start")):
            raise RuntimeError(f"气口判定与画面切镜不对应：{raw.get('shot_id')}")
        status, tier = decision.get("status"), decision.get("tier", 0)
        if status == "kept":
            if tier not in (0, 1, 2) or (tier > 0 and not relaxed_allowed) or not breath_on_cut(float(raw["start"]), transcript, tier):
                raise RuntimeError(f"切镜没有落在满足要求的气口上却被切开：{raw.get('shot_id')}")
            groups.append([raw])
        elif status == "merged":
            if breath_on_cut(float(raw["start"]), transcript, 0):
                raise RuntimeError(f"气口落在切镜上却被并进同一段：{raw.get('shot_id')}")
            groups[-1].append(raw)
        else:
            raise RuntimeError(f"气口判定状态无效：{raw.get('shot_id')}")
    return groups


def validate_dialogue_timeline(aligned: dict, clips: dict, transcript: dict, export: dict, srt_path: Path, raw_shots: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """Cut only where a visual boundary and an acoustic pause coincide."""
    if aligned.get("algorithm_id") != ALIGNMENT_ALGORITHM or aligned.get("boundary_policy") != BOUNDARY_POLICY or clips.get("boundary_policy") != BOUNDARY_POLICY:
        raise RuntimeError("当前项目仍按画面切点直接切断，请点击「继续完整流程」，按气口落在切镜上才切之后再生成剪映草稿。")
    final_shots = sorted(aligned.get("shots", []), key=lambda item: int(item["order"]))
    ordered_clips = sorted(clips.get("clips", []), key=lambda item: int(item["order"]))
    if not final_shots or len(final_shots) != len(ordered_clips):
        raise RuntimeError("最终分镜与视频切片数量不一致，请继续完整流程重新导出。")
    original_shots = sorted(raw_shots.get("shots", []), key=lambda item: int(item["order"]))
    groups = groups_from_decisions(original_shots, aligned, transcript)
    expected_merged = sum(len(group) - 1 for group in groups)
    if len(final_shots) != len(groups) or aligned.get("merged_boundary_count") != expected_merged or aligned.get("raw_shot_count") != len(original_shots):
        raise RuntimeError("最终分段没有遵守「只有气口落在切镜上才切」，请继续完整流程重新关联。")
    by_id = {}
    previous_frame = 0
    previous_end_us = 0
    source_ids = []
    for shot, clip, group in zip(final_shots, ordered_clips, groups):
        shot_id = shot["shot_id"]
        ids = [item["shot_id"] for item in group]
        first, last = group[0], group[-1]
        if shot_id in by_id or any(shot.get(key) != clip.get(key) for key in ("shot_id", "order", "start_frame", "end_frame_exclusive", "source_shot_ids")) or any(us(shot[key]) != us(clip[key]) for key in ("start", "end")):
            raise RuntimeError(f"视频切片不匹配已索引的分镜：{shot_id}，请继续完整流程重新导出。")
        if shot.get("source_shot_ids") != ids or shot.get("start_frame") != first.get("start_frame") or shot.get("end_frame_exclusive") != last.get("end_frame_exclusive") or us(shot.get("start")) != us(first.get("start")) or us(shot.get("end")) != us(last.get("end")):
            raise RuntimeError(f"最终分段没有覆盖对应的画面切镜：{shot_id}")
        internals = shot.get("internal_boundaries") or []
        if len(internals) != len(group) - 1:
            raise RuntimeError(f"被并掉的切镜没有记在段内：{shot_id}")
        for boundary, raw in zip(internals, group[1:]):
            if boundary.get("frame") != raw.get("start_frame") or us(boundary.get("time")) != us(raw.get("start")) or breath_on_cut(float(raw["start"]), transcript, 0):
                raise RuntimeError(f"气口落在切镜上却被并进同一段，或段内切镜记录不对：{raw.get('shot_id')}")
        for earlier, later in zip(group, group[1:]):
            if earlier.get("end_frame_exclusive") != later.get("start_frame") or us(earlier.get("end")) != us(later.get("start")):
                raise RuntimeError(f"原始画面切镜不连续：{later.get('shot_id')}")
        if not isinstance(shot.get("start_frame"), int) or not isinstance(shot.get("end_frame_exclusive"), int) or shot["start_frame"] != previous_frame or shot["end_frame_exclusive"] <= previous_frame or us(shot["start"]) != previous_end_us or us(shot["end"]) <= previous_end_us:
            raise RuntimeError(f"最终分镜帧区间或时间线不连续：{shot_id}")
        previous_frame = shot["end_frame_exclusive"]
        previous_end_us = us(shot["end"])
        source_ids.extend(ids)
        by_id[shot_id] = shot
    if source_ids != [item["shot_id"] for item in original_shots] or len(source_ids) != len(set(source_ids)):
        raise RuntimeError("最终分镜重复、遗漏或打乱了画面切镜，请重新建立台词索引。")

    def coverage(start: float, end: float, label: str) -> list[dict]:
        begin, finish = us(start), us(end)
        if not 0 <= begin < finish <= previous_end_us:
            raise RuntimeError(f"{label}超出视频时间线或区间无效，不允许截断音频/台词。")
        return [{"shot_id": shot["shot_id"], "start_us": max(begin, us(shot["start"])), "end_us": min(finish, us(shot["end"]))}
                for shot in final_shots if begin < us(shot["end"]) and finish > us(shot["start"])]

    utterances = transcript.get("utterances", [])
    utterance_ids = [item["utterance_id"] for item in utterances]
    associations = aligned.get("associations", [])
    if len(set(utterance_ids)) != len(utterance_ids) or len(associations) != len(utterances):
        raise RuntimeError("台词关联存在重复或遗漏，请重新建立台词索引。")
    association_map = {item["utterance_id"]: item for item in associations}
    if len(association_map) != len(utterances) or set(association_map) != set(utterance_ids):
        raise RuntimeError("台词关联存在重复或遗漏，请重新建立台词索引。")
    cues = export.get("subtitle_cues")
    voices = sorted(transcript.get("voice_timeline", {}).get("segments", []), key=lambda item: (float(item["start"]), float(item["end"])))
    if export.get("subtitle_policy") != SUBTITLE_POLICY or not isinstance(cues, list) or len(cues) != len(voices):
        raise RuntimeError("字幕未按现有人声片段逐条对应，请点击「继续完整流程」重新导出字幕。")
    cue_map = {cue.get("voice_segment_id"): cue for cue in cues}
    if len(cue_map) != len(cues) or set(cue_map) != {voice.get("segment_id") for voice in voices}:
        raise RuntimeError("字幕与人声映射存在重复或遗漏，请重新导出字幕。")
    voice_map = {utterance_id: [] for utterance_id in utterance_ids}
    previous_voice_end = 0
    voice_ids = set()
    for index, voice in enumerate(voices):
        utterance_id = voice.get("utterance_id")
        if not utterance_id and len(voices) == len(utterances):
            utterance_id = utterances[index]["utterance_id"]
        if utterance_id not in voice_map or not voice.get("segment_id") or voice["segment_id"] in voice_ids or us(voice["start"]) < previous_voice_end or us(voice["end"]) <= us(voice["start"]):
            raise RuntimeError("人声区间重复、重叠或缺少完整台词关联，请重新识别台词。")
        previous_voice_end = us(voice["end"])
        voice_ids.add(voice["segment_id"])
        voice_map[utterance_id].append(voice)
    voice_rows, subtitle_rows = [], []
    for utterance in utterances:
        utterance_id = utterance["utterance_id"]
        overlap = coverage(utterance["start"], utterance["end"], f"台词 {utterance_id}")
        shot_ids = [item["shot_id"] for item in overlap]
        association = association_map[utterance_id]
        association_segments = [{"shot_id": item["shot_id"], "start_us": us(item["start"]), "end_us": us(item["end"])} for item in association.get("segments", [])]
        if association.get("shot_ids") != shot_ids or association_segments != overlap or any(us(association[key]) != us(utterance[key]) for key in ("start", "end")) or any(utterance_id not in by_id[shot_id].get("utterance_ids", []) for shot_id in shot_ids):
            raise RuntimeError(f"台词索引没有完整覆盖全部视觉分镜：{utterance_id}")
        spans = utterance.get("speech_spans", [{"start": utterance["start"], "end": utterance["end"]}])
        sentence_voices = voice_map[utterance_id]
        if not spans or len(sentence_voices) != len(spans):
            raise RuntimeError(f"人声有声片段存在遗漏或重复：{utterance_id}")
        expected_spans = []
        utterance_cues = []
        previous_span_end = us(utterance["start"])
        for span, voice in zip(spans, sentence_voices):
            first, last = us(span["start"]), us(span["end"])
            if not previous_span_end <= first < last <= us(utterance["end"]):
                raise RuntimeError(f"台词有声片段区间无效：{utterance_id}")
            previous_span_end = last
            voice_overlap = coverage(voice["start"], voice["end"], f"人声 {voice.get('segment_id')}")
            if subtitle_text(voice.get("text", "")) != subtitle_text(utterance["text"]) or any(us(voice[key]) != us(span[key]) for key in ("start", "end")):
                raise RuntimeError(f"人声片段与原始有声区间不一致：{utterance_id}")
            expected_spans.append({"start_us": first, "end_us": last})
            # Visual intersections are index metadata; audio and subtitle
            # retain the same measured speech span even across visual cuts.
            voice_rows.append({**voice, "utterance_id": utterance_id,
                               "shot_ids": [item["shot_id"] for item in voice_overlap],
                               "shot_segments": voice_overlap})
            cue = cue_map[voice["segment_id"]]
            cue_text = re.sub(r"[\r\n]+", " ", str(cue.get("text", "")))
            if cue.get("cue_id") != voice["segment_id"] or cue.get("utterance_id") != utterance_id or cue.get("shot_ids") != [item["shot_id"] for item in voice_overlap] or not cue_text.strip() or any(us(cue[key]) != us(voice[key]) for key in ("start", "end")):
                raise RuntimeError(f"字幕没有精确对应人声片段：{voice['segment_id']}")
            utterance_cues.append({"cue_id": cue["cue_id"], "voice_segment_id": voice["segment_id"], "utterance_id": utterance_id, "shot_ids": [item["shot_id"] for item in voice_overlap], "source_shot_ids": shot_ids, "shot_segments": voice_overlap, "text": cue_text, "source_text": subtitle_text(utterance["text"]), "start_us": first, "duration_us": last - first, "source_start_us": us(utterance["start"]), "source_end_us": us(utterance["end"])})
        if expected_spans[0]["start_us"] != us(utterance["start"]) or expected_spans[-1]["end_us"] != us(utterance["end"]):
            raise RuntimeError(f"人声遗漏台词首尾：{utterance_id}")
        if subtitle_text("".join(cue["text"] for cue in utterance_cues)) != subtitle_text(utterance["text"]):
            raise RuntimeError(f"字幕分段后文字有遗漏、重复或改写：{utterance_id}")
        subtitle_rows.extend({**cue, "speech_spans": expected_spans} for cue in utterance_cues)
    subtitle_rows.sort(key=lambda row: (row["start_us"], row["duration_us"]))
    content = srt_path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").strip()
    blocks = re.split(r"\n\s*\n", content) if content else []
    if len(blocks) != len(subtitle_rows):
        raise RuntimeError("SRT 字幕存在重复或遗漏，请重新导出字幕。")
    for index, (block, cue) in enumerate(zip(blocks, sorted(subtitle_rows, key=lambda row: row["start_us"])), 1):
        lines = block.splitlines()
        match = re.fullmatch(r"(\d+):(\d{2}):(\d{2}),(\d{3}) --> (\d+):(\d{2}):(\d{2}),(\d{3})", lines[1] if len(lines) > 1 else "")
        if not match or lines[0] != str(index) or subtitle_text("\n".join(lines[2:])) != subtitle_text(cue["text"]):
            raise RuntimeError(f"SRT 字幕与最终映射不一致：第 {index} 条")
        values = list(map(int, match.groups()))
        times = [((values[i] * 3600 + values[i + 1] * 60 + values[i + 2]) * 1000 + values[i + 3]) * 1000 for i in (0, 4)]
        if any(abs(actual - expected) > 1000 for actual, expected in zip(times, [cue["start_us"], cue["start_us"] + cue["duration_us"]])):
            raise RuntimeError(f"SRT 时间与最终分镜映射不一致：第 {index} 条")
    return ordered_clips, voice_rows, subtitle_rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从结构化拆解项目创建第一版剪映草稿")
    parser.add_argument("project_dir", type=Path, help="包含 project.json 的结构化项目目录")
    parser.add_argument("--name", default="episode-103-v1", help="剪映草稿名称")
    parser.add_argument("--output-root", type=Path, help="剪映草稿根目录，默认项目目录/jianying/draft")
    parser.add_argument("--jianying-user-data", type=Path, help="剪映 User Data 目录；写入真实草稿根目录时用于注册 root_meta_info")
    parser.add_argument("--ffmpeg", type=Path, help="用于拆分音频的 FFmpeg；默认从 FFMPEG 环境变量或 PATH 查找")
    parser.add_argument("--watermark", default=DEFAULT_WATERMARK, help=f"公司水印文字，默认：{DEFAULT_WATERMARK}；传空字符串可关闭")
    parser.add_argument("--disclaimer", default=DEFAULT_DISCLAIMER, help=f"文案文字，默认：{DEFAULT_DISCLAIMER}；传空字符串可关闭")
    parser.add_argument("--force", action="store_true", help="覆盖同名草稿")
    return parser.parse_args()


def resolve_ffmpeg(value: Path | None) -> Path:
    candidate = value or (Path(os.environ["FFMPEG"]) if os.environ.get("FFMPEG") else None)
    if candidate and candidate.is_file():
        return candidate.resolve()
    found = shutil.which("ffmpeg")
    if found:
        return Path(found).resolve()
    raise RuntimeError("创建分割音频需要 FFmpeg；请通过 --ffmpeg 指定可执行文件")


def resolve_ffprobe(ffmpeg: Path) -> Path:
    """Use the same bundled FFmpeg toolchain for media metadata.

    pyJianYingDraft delegates metadata parsing to libmediainfo.  That parser
    can fail transiently while a freshly copied MP4 is being registered, even
    though FFmpeg can read the file.  The bundled ffprobe is the authoritative
    media reader for this workflow, so material metadata is built from it.
    """
    sibling = ffmpeg.with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if sibling.is_file():
        return sibling.resolve()
    found = shutil.which("ffprobe")
    if found:
        return Path(found).resolve()
    raise RuntimeError("创建剪映草稿需要 ffprobe；请将 ffprobe 放在 FFmpeg 同目录或加入 PATH")


def probe_media(ffprobe: Path, path: Path, cache: dict[str, dict]) -> dict:
    """Read a media file with ffprobe and cache the result for this draft."""
    key = str(path.resolve())
    if key in cache:
        return cache[key]
    result = subprocess.run([
        str(ffprobe), "-v", "error", "-show_entries",
        "stream=index,codec_type,width,height,duration:format=duration",
        "-of", "json", str(path),
    ], capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or "未知错误"
        raise RuntimeError(f"ffprobe 无法读取素材 {path}：{detail}")
    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"ffprobe 返回了无效媒体信息：{path}") from error
    cache[key] = metadata
    return metadata


def _probe_duration_us(metadata: dict, stream: dict, path: Path) -> int:
    value = stream.get("duration") or metadata.get("format", {}).get("duration")
    try:
        duration = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"素材没有可用时长：{path}") from error
    duration_us = us(duration)
    if duration_us <= 0:
        raise RuntimeError(f"素材时长无效：{path}")
    return duration_us


def video_material_from_ffprobe(path: Path, ffprobe: Path, cache: dict[str, dict]):
    """Construct a VideoMaterial without calling its libmediainfo parser."""
    metadata = probe_media(ffprobe, path, cache)
    stream = next((item for item in metadata.get("streams", []) if item.get("codec_type") == "video"), None)
    if not stream:
        raise RuntimeError(f"素材没有视频轨道：{path}")
    try:
        width = int(stream["width"])
        height = int(stream["height"])
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError(f"素材缺少画面尺寸：{path}") from error
    # __new__ keeps pyJianYingDraft's export/segment behavior while bypassing
    # only the unreliable MediaInfo.parse call in VideoMaterial.__init__.
    material = object.__new__(draft.VideoMaterial)
    material.material_id = uuid.uuid4().hex
    material.local_material_id = ""
    material.check_flag = 63487
    material.material_name = path.name
    material.path = str(path.resolve())
    material.duration = _probe_duration_us(metadata, stream, path)
    material.width = width
    material.height = height
    material.crop_settings = draft.CropSettings()
    material.material_type = "video"
    material.beauty_face_auto_preset_infos = []
    material.beauty_face_preset_infos = []
    material.beauty_body_preset_id = ""
    material.beauty_body_auto_preset = None
    material.beauty_face_auto_preset = draft.VideoMaterial._default_beauty_face_auto_preset()
    material.is_unified_beauty_mode = False
    return material


def audio_material_from_ffprobe(path: Path, ffprobe: Path, cache: dict[str, dict]):
    """Construct an AudioMaterial from ffprobe metadata."""
    metadata = probe_media(ffprobe, path, cache)
    stream = next((item for item in metadata.get("streams", []) if item.get("codec_type") == "audio"), None)
    if not stream:
        raise RuntimeError(f"素材没有音频轨道：{path}")
    material = object.__new__(draft.AudioMaterial)
    material.material_id = uuid.uuid4().hex
    material.material_name = path.name
    material.path = str(path.resolve())
    material.duration = _probe_duration_us(metadata, stream, path)
    return material


def render_audio_clip(ffmpeg: Path, source: Path, output: Path, start: float, end: float) -> None:
    duration = end - start
    if start < -TOLERANCE or end <= start:
        raise RuntimeError(f"音频区间无效：{start}–{end}")
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        str(ffmpeg), "-nostdin", "-y", "-v", "error", "-i", str(source),
        "-af", ",".join([
            f"atrim=start={max(0.0, start):.6f}:end={end:.6f}",
            "asetpts=PTS-STARTPTS", "apad", f"atrim=duration={duration:.6f}", "asetpts=PTS-STARTPTS",
        ]),
        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(output),
    ], check=True)


def copy_media(source: Path, output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, output)
    return output


def render_effect_track(ffmpeg: Path, source: Path, output: Path, duration: float) -> None:
    """Create an editable, approximate effects track from the background stem.

    The stem separator does not provide a semantic SFX stem.  A high-pass and
    light dynamics pass is a deterministic approximation that keeps the exact
    episode clock and gives the draft a separate effects track for later edits.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        str(ffmpeg), "-nostdin", "-y", "-v", "error", "-i", str(source),
        "-af", f"{EFFECTS_FILTER},apad,atrim=duration={duration:.6f},asetpts=PTS-STARTPTS",
        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(output),
    ], check=True)


def split_audio_tracks(ffmpeg: Path, draft_dir: Path, vocals: Path, voice_segments: list[dict]) -> list[dict]:
    """Render only recognized dialogue intervals as independent voice assets.

    Background stays a full-length timeline asset. Effects are cut separately
    at shot boundaries by ``split_effect_track`` while preserving the clock.
    """
    audio_dir = draft_dir / "素材" / "音频"
    voice_rows = []
    previous_end = -1.0
    for index, item in enumerate(sorted(voice_segments, key=lambda row: (float(row["start"]), float(row["end"]))), 1):
        start = max(0.0, float(item["start"]))
        end = float(item["end"])
        if end <= start:
            continue
        if start < previous_end - TOLERANCE:
            raise RuntimeError(f"人声区间重叠：{start:.6f} < {previous_end:.6f}")
        previous_end = end
        start_us = us(start)
        end_us = us(end)
        duration_us = end_us - start_us
        if duration_us <= 0:
            continue
        output = audio_dir / f"人声-第{index:03d}段.wav"
        render_audio_clip(ffmpeg, vocals, output, start, end)
        voice_rows.append({"segment_id": item["segment_id"], "utterance_id": item["utterance_id"], "shot_ids": item["shot_ids"], "shot_segments": item["shot_segments"], "start_us": start_us, "duration_us": duration_us, "path": str(output), "sha256": sha256(output), "text": subtitle_text(item.get("text", ""))})
        progress(25 + 25 * index / max(1, len(voice_segments)), f"生成人声片段 {index}/{len(voice_segments)}")
    return voice_rows


def split_effect_track(ffmpeg: Path, draft_dir: Path, effects: Path, clip_rows: list[dict]) -> list[dict]:
    """Cut the estimated effects stem at the exact video shot boundaries."""
    audio_dir = draft_dir / "素材" / "音频"
    rows = []
    for index, item in enumerate(clip_rows, 1):
        start = float(item["start_us"]) / 1_000_000
        end = start + float(item["duration_us"]) / 1_000_000
        output = audio_dir / f"特效声-分镜-第{index:03d}段.wav"
        render_audio_clip(ffmpeg, effects, output, start, end)
        rows.append({
            "shot_id": item["shot_id"],
            "order": item["order"],
            "start_us": item["start_us"],
            "duration_us": item["duration_us"],
            "path": str(output),
            "sha256": sha256(output),
        })
        progress(50 + 35 * index / max(1, len(clip_rows)), f"生成分镜特效声 {index}/{len(clip_rows)}")
    return rows


def add_preset_text_tracks(script, duration_us: int, watermark: str, disclaimer: str) -> None:
    """Add the two editable overlay tracks used by every generated draft.

    They are ordinary text tracks so the user can edit or remove them in
    Jianying.  Both cover the whole episode clock and are independent of the
    hidden subtitle track.
    """
    if watermark:
        script.add_segment(
            draft.TextSegment(
                watermark,
                draft.trange(0, duration=duration_us),
                style=draft.TextStyle(size=4.0, color=(1.0, 1.0, 1.0), alpha=0.58, align=0),
                clip_settings=draft.ClipSettings(transform_x=-0.82, transform_y=-0.82),
            ),
            track="公司水印",
        )
    if disclaimer:
        script.add_segment(
            draft.TextSegment(
                disclaimer,
                draft.trange(0, duration=duration_us),
                style=draft.TextStyle(size=4.0, color=(1.0, 1.0, 1.0), alpha=0.72, align=2, auto_wrapping=True, max_line_width=0.9),
                clip_settings=draft.ClipSettings(transform_x=0.66, transform_y=0.94),
            ),
            track="文案",
        )


def main() -> int:
    args = parse_args()
    project_dir = args.project_dir.resolve()
    project_path = require_file(project_dir / "project.json", "项目清单")
    project = read_json(project_path)

    media, _ = module_data(project_dir, project, "media")
    shots, _ = module_data(project_dir, project, "shots")
    clips, clips_dir = module_data(project_dir, project, "clips")
    separation, separation_dir = module_data(project_dir, project, "separation")
    transcript, transcript_dir = module_data(project_dir, project, "transcript")
    aligned, _ = module_data(project_dir, project, "alignment")
    export, export_dir = module_data(project_dir, project, "export")
    srt_path = require_file(export_dir / export["srt"], "SRT 字幕")
    ordered_clips, checked_voices, subtitle_rows = validate_dialogue_timeline(aligned, clips, transcript, export, srt_path, shots)
    progress(5, "已读取分镜、音轨和字幕")

    if shots.get("needs_review"):
        print("警告：分镜结果包含待复核项，本次生成标记为 preview_only。", file=sys.stderr)

    streams = media.get("streams") or []
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), None)
    if not video_stream:
        raise RuntimeError("media.json 没有视频流")
    width = int(video_stream["width"])
    height = int(video_stream["height"])
    # Jianying draft format requires an integer project FPS.  The source is
    # VFR; use the measured average rate only for the project canvas metadata.
    # Each clip still keeps its checked source duration and PTS-derived cut.
    avg_rate = str(video_stream.get("avg_frame_rate") or "")
    try:
        numerator, denominator = avg_rate.split("/", 1)
        fps = max(1, int(round(float(numerator) / float(denominator))))
    except (ValueError, ZeroDivisionError):
        fps = int(round(float(str(video_stream.get("r_frame_rate", "25/1")).split("/")[0])))

    episode_duration = float(media["video_end"])

    previous_end = 0.0
    clip_rows = []
    for item in ordered_clips:
        start = float(item["start"])
        end = float(item["end"])
        if start < -TOLERANCE or end <= start or abs(start - previous_end) > TOLERANCE:
            raise RuntimeError(f"镜头时间线存在缺口或反向区间：{item.get('shot_id')}")
        clip_path = require_file(clips_dir / item["path"], f"镜头 {item.get('order')} 视频")
        start_us = us(start)
        end_us = us(end)
        duration_us = end_us - start_us
        if duration_us <= 0:
            raise RuntimeError(f"镜头时长舍入为 0：{item.get('shot_id')}")
        clip_rows.append({
            "shot_id": item["shot_id"],
            "source_shot_ids": item["source_shot_ids"],
            "order": item["order"],
            "start_us": start_us,
            "duration_us": duration_us,
            "path": str(clip_path),
            # Keep the validated source as a read fallback.  MediaInfo can
            # intermittently fail while opening a just-copied file inside
            # Jianying's User Data directory even though FFmpeg and the file
            # hash are valid.  The source has already passed the same media
            # checks, so its metadata is safe to reuse for the copied asset.
            "source_path": str(clip_path),
            "sha256": sha256(clip_path),
        })
        previous_end = end
    if abs(previous_end - episode_duration) > TOLERANCE:
        raise RuntimeError(f"镜头总时长与视频不一致：{previous_end:.6f} != {episode_duration:.6f}")

    vocals = require_file(transcript_dir / transcript["voice_timeline"]["path"], "时间轴人声")
    background = require_file(transcript_dir / transcript["background_timeline"]["path"], "时间轴背景音")
    ffmpeg = resolve_ffmpeg(args.ffmpeg)
    ffprobe = resolve_ffprobe(ffmpeg)
    probe_cache: dict[str, dict] = {}

    output_root = (args.output_root or project_dir / "jianying" / "draft").resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    draft_dir = output_root / args.name
    draft_folder = draft.DraftFolder(
        str(output_root),
        user_data_path=str(args.jianying_user_data.resolve()) if args.jianying_user_data else None,
    )
    if draft_folder.has_draft(args.name):
        if not args.force:
            raise FileExistsError(f"草稿已存在：{output_root / args.name}，使用 --force 覆盖")
        draft_folder.remove(args.name)
    elif draft_dir.exists():
        if not args.force:
            raise FileExistsError(f"草稿目录已存在但未注册：{draft_dir}")
        shutil.rmtree(draft_dir)

    script = draft_folder.create_draft(args.name, width, height, fps=fps, maintrack_adsorb=False)
    script.append_tracks([
        draft.TrackSpec(draft.TrackType.video, "视频片段"),
        draft.TrackSpec(draft.TrackType.text, "公司水印"),
        draft.TrackSpec(draft.TrackType.text, "文案"),
        # Keep all subtitle segments editable on the timeline, but hide the
        # subtitle track in the initial draft.
        draft.TrackSpec(draft.TrackType.text, "字幕", mute=True),
        draft.TrackSpec(draft.TrackType.audio, "配音"),
        draft.TrackSpec(draft.TrackType.audio, "背景声"),
        draft.TrackSpec(draft.TrackType.audio, "特效声"),
    ])

    # Copy all user-facing media into Chinese-named folders. The required
    # Jianying control files (draft_info.json, draft_meta_info.json, etc.)
    # remain at the draft root with their native names.
    video_dir = draft_dir / "素材" / "视频"
    for index, row in enumerate(clip_rows, 1):
        source = Path(row["path"])
        output = video_dir / f"第{int(row['order']):03d}分镜.mp4"
        copy_media(source, output)
        row["path"] = str(output)
        row["sha256"] = sha256(output)
        progress(5 + 20 * index / len(clip_rows), f"整理分镜视频 {index}/{len(clip_rows)}")

    audio_dir = draft_dir / "素材" / "音频"
    vocals_asset = copy_media(vocals, audio_dir / "人声-整集时间轴.wav")
    background_asset = copy_media(background, audio_dir / "背景声-整集.wav")

    # Human-voice assets exist only for recognized dialogue intervals. The
    # background stays full length; the estimated effects stem is cut at the
    # exact shot boundaries so each effect asset maps to one video shot.
    voice_rows = split_audio_tracks(
        ffmpeg, draft_dir, vocals_asset,
        checked_voices,
    )

    duration_us = us(episode_duration)
    effects_record = transcript.get("effects_timeline") or {}
    effects_source = transcript_dir / str(effects_record.get("path", "")) if effects_record.get("path") else None
    effects_method = "pipeline_heuristic_highpass_from_background"
    if not effects_source or not effects_source.is_file():
        effects_source = audio_dir / "特效声-整集估计.wav"
        render_effect_track(ffmpeg, background_asset, effects_source, episode_duration)
        effects_method = "draft_derived_highpass_from_background"
    else:
        effects_source = copy_media(effects_source.resolve(), audio_dir / "特效声-整集估计.wav")
    effects_rows = split_effect_track(ffmpeg, draft_dir, effects_source, clip_rows)

    for row in clip_rows:
        target = draft.trange(row["start_us"], duration=row["duration_us"])
        # Audio is deliberately muted on video segments. Dialogue, background,
        # and estimated effects are supplied as aligned audio tracks.
        # Do not call VideoMaterial(path) here: pyJianYingDraft invokes
        # libmediainfo on every constructor and that parser can intermittently
        # reject a valid freshly copied MP4. ffprobe has already been used to
        # validate the project's media and supplies the same fields directly.
        material = video_material_from_ffprobe(Path(row["path"]), ffprobe, probe_cache)
        source = draft.trange(0, duration=material.duration)
        speed = material.duration / row["duration_us"]
        segment = draft.VideoSegment(material, target, source_timerange=source, speed=speed, volume=0.0)
        script.add_segment(segment, track="视频片段")

    for row in voice_rows:
        material = audio_material_from_ffprobe(Path(row["path"]), ffprobe, probe_cache)
        source = draft.trange(0, duration=material.duration)
        speed = material.duration / row["duration_us"]
        script.add_segment(draft.AudioSegment(material, draft.trange(row["start_us"], duration=row["duration_us"]), source_timerange=source, speed=speed, volume=1.0), track="配音")
    background_material = audio_material_from_ffprobe(background_asset, ffprobe, probe_cache)
    background_source = draft.trange(0, duration=background_material.duration)
    background_speed = background_material.duration / duration_us
    script.add_segment(draft.AudioSegment(background_material, draft.trange(0, duration=duration_us), source_timerange=background_source, speed=background_speed, volume=1.0), track="背景声")
    for row in effects_rows:
        material = audio_material_from_ffprobe(Path(row["path"]), ffprobe, probe_cache)
        source = draft.trange(0, duration=material.duration)
        speed = material.duration / row["duration_us"]
        script.add_segment(draft.AudioSegment(material, draft.trange(row["start_us"], duration=row["duration_us"]), source_timerange=source, speed=speed, volume=0.35), track="特效声")
    add_preset_text_tracks(script, duration_us, str(args.watermark or "").strip(), str(args.disclaimer or "").strip())
    # Match the voice clips in microseconds; SRT is only millisecond precision.
    for row in subtitle_rows:
        script.add_segment(
            draft.TextSegment(
                row["text"],
                draft.trange(row["start_us"], duration=row["duration_us"]),
                style=draft.TextStyle(size=5, align=1, auto_wrapping=True),
                clip_settings=draft.ClipSettings(scale_x=0.01, scale_y=0.01, transform_y=-0.8),
            ),
            track="字幕",
        )
    # Jianying 6+ (including the installed 11.6.0 build) reads the native
    # draft_info.json filename.  ScriptFile.save() also runs the library's
    # registration hook so draft_meta_info.json keeps the same draft_id.
    script.save()
    progress(94, "视频、配音、背景声、特效声、字幕和水印轨道已保存")

    manifest = {
        "schema": "hongguo-jianying-draft/v1",
        "boundary_policy": BOUNDARY_POLICY,
        "alignment_algorithm": ALIGNMENT_ALGORITHM,
        "subtitle_policy": SUBTITLE_POLICY,
        "status": "preview_only" if shots.get("needs_review") else "assembled",
        "project_id": project["project_id"],
        "source_project": str(project_path),
        "draft_name": args.name,
        "draft_dir": str(draft_dir),
        "canvas": {"width": width, "height": height, "fps": fps, "duration_us": duration_us},
        "tracks": {
            "video": {"name": "视频片段", "clip_count": len(clip_rows), "clips": [{key: value for key, value in row.items() if key != "source_path"} for row in clip_rows]},
            "voice": {"name": "配音", "source": str(vocals_asset), "clip_count": len(voice_rows), "segments": voice_rows},
            "background": {"name": "背景声", "source": str(background_asset), "clip_count": 1, "segments": [{"start_us": 0, "duration_us": duration_us, "path": str(background_asset), "sha256": sha256(background_asset)}]},
            "effects": {"name": "特效声", "source": str(effects_source), "clip_count": len(effects_rows), "segments": effects_rows, "method": effects_method, "cutoff_hz": 900, "default_volume": 0.35},
            "watermark": {"name": "公司水印", "text": str(args.watermark or "").strip(), "enabled": bool(str(args.watermark or "").strip()), "scope": "full_episode", "position": "bottom_left"},
            "disclaimer": {"name": "文案", "text": str(args.disclaimer or "").strip(), "enabled": bool(str(args.disclaimer or "").strip()), "scope": "full_episode", "position": "top_right"},
            "subtitles": {"name": "字幕", "path": str(srt_path), "sha256": sha256(srt_path), "cue_count": len(subtitle_rows), "segments": subtitle_rows, "visible": False, "scale": {"x": 0.01, "y": 0.01}},
        },
        "review_items": shots.get("review_items", []),
        "note": "草稿尚未在目标剪映版本完成打开、播放、保存、重开验收。",
    }
    (draft_dir / "hongguo-draft-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"success": True, "draft_dir": str(draft_dir), "draft_info": str(draft_dir / "draft_info.json"), "manifest": str(draft_dir / "hongguo-draft-manifest.json"), "fps": fps, "duration_us": duration_us, "clip_count": len(clip_rows), "subtitle_count": len(subtitle_rows), "status": manifest["status"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
