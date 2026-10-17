#!/usr/bin/env python3
"""Validate a generated Jianying draft without opening the Jianying app."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def validate_dialogue_tracks(content: dict, manifest: dict, tracks: dict) -> None:
    if manifest.get("boundary_policy") != "shot_cut_requires_acoustic_pause" or manifest.get("alignment_algorithm") != "visual-shot-on-acoustic-pause-v1":
        raise SystemExit("草稿未按气口落在切镜上才切，请继续完整流程后重新生成。")
    expected_tracks = manifest["tracks"]
    video_rows = expected_tracks["video"].get("clips", [])
    native_video = tracks["视频片段"]["segments"]
    if len(video_rows) != len(native_video):
        raise SystemExit("video manifest/native segment count mismatch")
    shots = {}
    source_ids = []
    for row, segment in zip(video_rows, native_video):
        if row.get("shot_id") in shots or not row.get("source_shot_ids"):
            raise SystemExit("video shot mapping is missing or duplicated")
        target = segment["target_timerange"]
        if target != {"start": row["start_us"], "duration": row["duration_us"]}:
            raise SystemExit("video native bounds differ from final shot manifest")
        shots[row["shot_id"]] = (target["start"], target["start"] + target["duration"])
        source_ids.extend(row["source_shot_ids"])
    if len(source_ids) != len(set(source_ids)):
        raise SystemExit("visual shot duplicated in final video manifest")
    if len(tracks["背景声"]["segments"]) != 1:
        raise SystemExit("background must remain one full-episode segment")
    if len(tracks["特效声"]["segments"]) != len(video_rows):
        raise SystemExit("effects must have one segment per final shot")
    for row, native, expected in zip(video_rows, tracks["特效声"]["segments"], expected_tracks["effects"]["segments"]):
        if expected.get("shot_id") != row["shot_id"] or native["target_timerange"] != {"start": row["start_us"], "duration": row["duration_us"]}:
            raise SystemExit("effects do not follow final shot boundaries")

    texts = {row["id"]: row for row in content.get("materials", {}).get("texts", [])}
    audios = {row["id"]: row for row in content.get("materials", {}).get("audios", [])}
    def coverage(start: int, end: int) -> list[dict]:
        if not shots or not 0 <= start < end <= max(bounds[1] for bounds in shots.values()):
            raise SystemExit("dialogue interval exceeds video timeline")
        return [{"shot_id": shot_id, "start_us": max(start, bounds[0]), "end_us": min(end, bounds[1])}
                for shot_id, bounds in shots.items() if start < bounds[1] and end > bounds[0]]
    if manifest.get("subtitle_policy") != "voice-segments-v1":
        raise SystemExit("字幕未按现有人声逐条对应，请重新导出字幕并生成草稿。")
    utterances = {}
    subtitles_by_voice = {}
    actual_spans = {}
    def normalized(value):
        return re.sub(r"[\r\n]+", " ", str(value)).strip()
    expected_subtitles = expected_tracks["subtitles"].get("segments", [])
    native_subtitles = tracks["字幕"]["segments"]
    if len(native_subtitles) != len(expected_subtitles) or len(native_subtitles) != expected_tracks["subtitles"]["cue_count"]:
        raise SystemExit("字幕 native/manifest count mismatch (missing or duplicated dialogue)")
    previous_subtitle_end = 0
    for row, segment in zip(expected_subtitles, native_subtitles):
        utterance_id = row.get("utterance_id")
        if not utterance_id:
            raise SystemExit("字幕 utterance is missing")
        target = segment["target_timerange"]
        if target != {"start": row["start_us"], "duration": row["duration_us"]}:
            raise SystemExit("字幕 native bounds differ from manifest")
        start, end = target["start"], target["start"] + target["duration"]
        if start < previous_subtitle_end or end <= start:
            raise SystemExit("subtitle spans overlap or have invalid duration")
        previous_subtitle_end = end
        overlap = coverage(start, end)
        if row.get("shot_ids") != [item["shot_id"] for item in overlap] or row.get("shot_segments") != overlap:
            raise SystemExit(f"字幕 index does not cover all overlapping visual shots: {utterance_id}")
        voice_id = row.get("voice_segment_id")
        if not voice_id or voice_id in subtitles_by_voice or row.get("cue_id") != voice_id:
            raise SystemExit("subtitle voice reference is missing or duplicated")
        material = texts.get(segment["material_id"], {})
        text = json.loads(material.get("content", "{}")).get("text")
        if text != row.get("text") or not normalized(text):
            raise SystemExit(f"subtitle text lost/changed/duplicated: {utterance_id}")
        if not row["source_start_us"] <= start < end <= row["source_end_us"]:
            raise SystemExit(f"subtitle exceeds source utterance: {utterance_id}")
        if row.get("source_shot_ids") != [item["shot_id"] for item in coverage(row["source_start_us"], row["source_end_us"])]:
            raise SystemExit(f"subtitle source-shot mapping is incomplete: {utterance_id}")
        source = {field: row.get(field) for field in ("source_text", "source_start_us", "source_end_us", "speech_spans", "source_shot_ids")}
        if not normalized(source["source_text"]) or not source["speech_spans"]:
            raise SystemExit(f"subtitle source metadata missing: {utterance_id}")
        group = utterances.setdefault(utterance_id, {"source": source, "cues": []})
        if group["source"] != source:
            raise SystemExit(f"inconsistent subtitle source metadata: {utterance_id}")
        group["cues"].append(row)
        subtitles_by_voice[voice_id] = row

    expected_voice = expected_tracks["voice"].get("segments", [])
    native_voice = tracks["配音"]["segments"]
    if len(native_voice) != len(expected_voice) or len(native_voice) != len(native_subtitles):
        raise SystemExit("配音 native/manifest count mismatch (missing or duplicated dialogue)")
    voice_ids = set()
    previous_voice_end = 0
    for row, segment in zip(expected_voice, native_voice):
        utterance_id = row.get("utterance_id")
        voice_id = row.get("segment_id")
        if not utterance_id or not voice_id or voice_id in voice_ids:
            raise SystemExit(f"voice span is missing or duplicated: {utterance_id}")
        voice_ids.add(voice_id)
        subtitle = subtitles_by_voice.get(voice_id)
        target = segment["target_timerange"]
        if not subtitle or subtitle["utterance_id"] != utterance_id or normalized(subtitle["source_text"]) != normalized(row.get("text", "")):
            raise SystemExit(f"subtitle and voice are not paired: {voice_id}")
        if target != {"start": subtitle["start_us"], "duration": subtitle["duration_us"]}:
            raise SystemExit(f"subtitle and voice bounds differ: {voice_id}")
        start, end = target["start"], target["start"] + target["duration"]
        if start < previous_voice_end or end <= start:
            raise SystemExit("voice spans overlap or have invalid duration")
        previous_voice_end = end
        if target != {"start": row["start_us"], "duration": row["duration_us"]} or row.get("shot_ids") != [item["shot_id"] for item in coverage(start, end)] or row.get("shot_segments") != coverage(start, end):
            raise SystemExit(f"voice native bounds or visual-shot index differ from manifest: {voice_id}")
        actual_spans.setdefault(utterance_id, []).append({"start_us": start, "end_us": end})
        material_path = Path(audios.get(segment["material_id"], {}).get("path", ""))
        if not material_path.is_file() or material_path.resolve() != Path(row["path"]).resolve():
            raise SystemExit(f"voice material mismatch: {utterance_id}")
    if set(utterances) != {row.get("utterance_id") for row in expected_voice} or voice_ids != set(subtitles_by_voice):
        raise SystemExit("voice/subtitle pairing is missing or duplicated")
    for utterance_id, group in utterances.items():
        source = group["source"]
        cues = sorted(group["cues"], key=lambda row: row["start_us"])
        if normalized("".join(row["text"] for row in cues)) != normalized(source["source_text"]):
            raise SystemExit(f"subtitle split lost, duplicated, or changed text: {utterance_id}")
        spans = sorted(actual_spans.get(utterance_id, []), key=lambda item: (item["start_us"], item["end_us"]))
        if spans != source["speech_spans"] or spans[0]["start_us"] != source["source_start_us"] or spans[-1]["end_us"] != source["source_end_us"]:
            raise SystemExit(f"voice spans lost, duplicated, or silence gaps filled: {utterance_id}")



def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} DRAFT_DIR", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    content_path = root / "draft_info.json"
    if not content_path.is_file():
        # Jianying <= 5.9 used the legacy filename. Keep the validator able
        # to inspect old fixtures, but always prefer the native 6+ file.
        content_path = root / "draft_content.json"
    manifest_path = root / "hongguo-draft-manifest.json"
    meta_path = root / "draft_meta_info.json"
    for path in (content_path, manifest_path, meta_path):
        if not path.is_file():
            raise SystemExit(f"missing: {path}")
    content = json.loads(content_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("draft_id") and meta.get("draft_id") != content.get("id"):
        raise SystemExit("draft id mismatch between draft_info.json and draft_meta_info.json")
    if meta.get("draft_fold_path") and Path(meta["draft_fold_path"]).resolve() != root:
        raise SystemExit("draft path mismatch between draft_info.json and draft_meta_info.json")
    tracks = {track["name"]: track for track in content.get("tracks", [])}
    required = {"视频片段": "video", "公司水印": "text", "文案": "text", "配音": "audio", "背景声": "audio", "特效声": "audio", "字幕": "text"}
    for name, kind in required.items():
        track = tracks.get(name)
        if not track or track.get("type") != kind:
            raise SystemExit(f"invalid track: {name}")
    if tracks["字幕"].get("attribute") != 1:
        raise SystemExit("subtitle track must be hidden while retaining its segments")
    duration = int(content["duration"])
    manifest_tracks = manifest.get("tracks", {})
    expected_positions = {"bottom_left": (-0.82, -0.82), "top_right": (0.66, 0.94)}
    for name, manifest_key in (("公司水印", "watermark"), ("文案", "disclaimer")):
        expected = manifest_tracks.get(manifest_key, {})
        segments = tracks[name].get("segments", [])
        if expected.get("enabled"):
            if len(segments) != 1:
                raise SystemExit(f"{name} must have one full-episode segment")
            target = segments[0].get("target_timerange", {})
            if target.get("start") != 0 or target.get("duration") != duration:
                raise SystemExit(f"{name} timeline is invalid: {target}")
            position = expected.get("position")
            if position in expected_positions:
                transform = segments[0].get("clip", {}).get("transform", {})
                expected_x, expected_y = expected_positions[position]
                if abs(float(transform.get("x", 0.0)) - expected_x) > 1e-9 or abs(float(transform.get("y", 0.0)) - expected_y) > 1e-9:
                    raise SystemExit(f"{name} position mismatch: {transform}")
            material_id = segments[0].get("material_id")
            material = next((item for item in content.get("materials", {}).get("texts", []) if item.get("id") == material_id), None)
            if not material:
                raise SystemExit(f"{name} text material is missing")
            try:
                material_text = json.loads(material.get("content", "{}")).get("text")
            except json.JSONDecodeError as error:
                raise SystemExit(f"{name} text material is invalid: {error}")
            if material_text != expected.get("text"):
                raise SystemExit(f"{name} text mismatch: {material_text!r}")
        elif segments:
            raise SystemExit(f"{name} is disabled but still contains segments")
    for segment in tracks["字幕"].get("segments", []):
        scale = segment.get("clip", {}).get("scale", {})
        if abs(float(scale.get("x", 0.0)) - 0.01) > 1e-9 or abs(float(scale.get("y", 0.0)) - 0.01) > 1e-9:
            raise SystemExit(f"subtitle scale must be 1%: {scale}")
    video = tracks["视频片段"]["segments"]
    if len(video) != manifest["tracks"]["video"]["clip_count"]:
        raise SystemExit("video clip count mismatch")
    cursor = 0
    for segment in video:
        target = segment["target_timerange"]
        if target["start"] != cursor or target["duration"] <= 0:
            raise SystemExit(f"video timeline gap/overlap at {target}")
        cursor = target["start"] + target["duration"]
        material_id = segment["material_id"]
        material = next(item for item in content["materials"]["videos"] if item["id"] == material_id)
        if not Path(material["path"]).is_file():
            raise SystemExit(f"missing video material: {material['path']}")
    if cursor != duration:
        raise SystemExit(f"video duration mismatch: {cursor} != {duration}")
    for name, manifest_key in (("背景声", "background"), ("特效声", "effects")):
        segments = tracks[name]["segments"]
        if len(segments) != manifest["tracks"][manifest_key]["clip_count"]:
            raise SystemExit(f"{manifest_key} segment count mismatch")
        cursor = 0
        for segment in segments:
            target = segment["target_timerange"]
            if target["start"] != cursor or target["duration"] <= 0:
                raise SystemExit(f"{name} timeline gap/overlap at {target}")
            cursor = target["start"] + target["duration"]
        if cursor != duration:
            raise SystemExit(f"{name} duration mismatch: {cursor} != {duration}")

    voice = tracks["配音"]["segments"]
    if len(voice) != manifest["tracks"]["voice"]["clip_count"]:
        raise SystemExit("voice segment count mismatch")
    previous_end = 0
    for segment in voice:
        target = segment["target_timerange"]
        if target["start"] < previous_end or target["duration"] <= 0:
            raise SystemExit(f"voice timeline overlap/invalid duration at {target}")
        previous_end = target["start"] + target["duration"]
    validate_dialogue_tracks(content, manifest, tracks)
    print(f"PASS Jianying draft: {len(video)} video clips, {len(voice)} voice clips, 1 background stem, {len(tracks['特效声']['segments'])} shot effects clips, {len(tracks['字幕']['segments'])} subtitles, duration {duration}us")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
