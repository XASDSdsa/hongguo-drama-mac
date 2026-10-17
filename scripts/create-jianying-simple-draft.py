#!/usr/bin/env python3
"""Create a three-track Jianying draft (文案 / 视频 / 音频) from one structure project.

The simple scheme does no extra processing: it reuses the structure project's
final shot list and subtitle cues and cuts the original video directly in the
draft.  No clip files are rendered and no voice / background / effect tracks
are built (the structure analysis itself still ran before this script).

  视频  one segment per final shot, taken from the original video
  音频  the original audio, one full-length segment
  文案  one text segment per subtitle cue

The multi-track variant stays in create-jianying-draft.py; this file only
reuses its media helpers.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
from pathlib import Path


def _load_base():
    path = Path(__file__).with_name("create-jianying-draft.py")
    spec = importlib.util.spec_from_file_location("hongguo_jianying_base", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


base = _load_base()
draft = base.draft
TOLERANCE = base.TOLERANCE
SCHEMA = "hongguo-jianying-draft/simple-v1"
TRACK_VIDEO = "视频"
TRACK_AUDIO = "音频"
TRACK_TEXT = "文案"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从结构化拆解项目创建三分轨（文案/视频/音频）剪映草稿")
    parser.add_argument("project_dir", type=Path, help="包含 project.json 的结构化项目目录")
    parser.add_argument("--name", required=True, help="剪映草稿名称")
    parser.add_argument("--output-root", type=Path, help="剪映草稿根目录，默认项目目录/jianying/draft")
    parser.add_argument("--jianying-user-data", type=Path, help="剪映 User Data 目录；写入真实草稿根目录时用于注册 root_meta_info")
    parser.add_argument("--ffmpeg", type=Path, help="用来读取素材信息的 FFmpeg 所在位置（同目录的 ffprobe）")
    parser.add_argument("--force", action="store_true", help="覆盖同名草稿")
    return parser.parse_args()


def clip_rows(clips: dict, duration: float) -> list[dict]:
    """Final shots in timeline order; they must cover the episode without gaps."""
    ordered = sorted(clips.get("clips", []), key=lambda item: int(item["order"]))
    if not ordered:
        raise RuntimeError("分镜结果是空的，不能生成剪映草稿")
    rows = []
    previous_end = 0.0
    for item in ordered:
        start, end = float(item["start"]), float(item["end"])
        if end <= start or abs(start - previous_end) > TOLERANCE:
            raise RuntimeError(f"分镜时间线存在缺口或反向区间：{item.get('shot_id')}")
        start_us, end_us = base.us(start), base.us(end)
        if end_us <= start_us:
            raise RuntimeError(f"分镜时长舍入为 0：{item.get('shot_id')}")
        rows.append({
            "shot_id": item.get("shot_id"),
            "order": int(item["order"]),
            "start_us": start_us,
            "duration_us": end_us - start_us,
        })
        previous_end = end
    if abs(previous_end - duration) > 0.05:
        raise RuntimeError(f"分镜总时长与视频不一致：{previous_end:.3f} != {duration:.3f}")
    return rows


def parse_srt(path: Path) -> list[dict]:
    content = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").strip()
    rows = []
    for block in re.split(r"\n\s*\n", content) if content else []:
        lines = block.splitlines()
        match = re.fullmatch(r"(\d+):(\d{2}):(\d{2}),(\d{3}) --> (\d+):(\d{2}):(\d{2}),(\d{3})", lines[1] if len(lines) > 1 else "")
        if not match:
            continue
        v = list(map(int, match.groups()))
        start = (v[0] * 3600 + v[1] * 60 + v[2]) + v[3] / 1000
        end = (v[4] * 3600 + v[5] * 60 + v[6]) + v[7] / 1000
        rows.append({"start": start, "end": end, "text": "\n".join(lines[2:])})
    return rows


def text_rows(export: dict, export_dir: Path, duration: float) -> list[dict]:
    cues = export.get("subtitle_cues")
    source = cues if isinstance(cues, list) and cues else None
    if source is None and export.get("srt"):
        srt = export_dir / export["srt"]
        source = parse_srt(srt) if srt.is_file() else []
    rows = []
    for cue in source or []:
        text = base.subtitle_text(cue.get("text", ""))
        start, end = float(cue["start"]), float(cue["end"])
        if not text or end <= start or start < -TOLERANCE:
            continue
        end = min(end, duration)
        start_us, end_us = base.us(max(0.0, start)), base.us(end)
        if end_us > start_us:
            rows.append({"text": text, "start_us": start_us, "duration_us": end_us - start_us})
    rows.sort(key=lambda row: (row["start_us"], row["duration_us"]))
    # 同一时间线上文案不重叠：后一条晚于前一条结束，否则把前一条截短。
    for current, following in zip(rows, rows[1:]):
        if current["start_us"] + current["duration_us"] > following["start_us"]:
            current["duration_us"] = max(1, following["start_us"] - current["start_us"])
    return rows


def main() -> int:
    args = parse_args()
    project_dir = args.project_dir.resolve()
    project = base.read_json(base.require_file(project_dir / "project.json", "项目清单"))
    media, _ = base.module_data(project_dir, project, "media")
    clips, _ = base.module_data(project_dir, project, "clips")
    export, export_dir = base.module_data(project_dir, project, "export")
    source = base.require_file(Path(project["input_path"]), "原视频")

    video_stream = next((item for item in media.get("streams") or [] if item.get("codec_type") == "video"), None)
    if not video_stream:
        raise RuntimeError("media.json 没有视频流")
    width, height = int(video_stream["width"]), int(video_stream["height"])
    avg_rate = str(video_stream.get("avg_frame_rate") or "")
    try:
        numerator, denominator = avg_rate.split("/", 1)
        fps = max(1, int(round(float(numerator) / float(denominator))))
    except (ValueError, ZeroDivisionError):
        fps = int(round(float(str(video_stream.get("r_frame_rate", "25/1")).split("/")[0])))
    duration = float(media["video_end"])
    duration_us = base.us(duration)
    has_audio = any(item.get("codec_type") == "audio" for item in media.get("streams") or [])

    shots = clip_rows(clips, duration)
    texts = text_rows(export, export_dir, duration)
    base.progress(10, f"已读取分镜 {len(shots)} 个、文案 {len(texts)} 条")

    ffmpeg = base.resolve_ffmpeg(args.ffmpeg)
    ffprobe = base.resolve_ffprobe(ffmpeg)
    probe_cache: dict[str, dict] = {}

    output_root = (args.output_root or project_dir / "jianying" / "draft").resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    draft_dir = output_root / args.name
    folder = draft.DraftFolder(
        str(output_root),
        user_data_path=str(args.jianying_user_data.resolve()) if args.jianying_user_data else None,
    )
    if folder.has_draft(args.name):
        if not args.force:
            raise FileExistsError(f"草稿已存在：{draft_dir}，使用 --force 覆盖")
        folder.remove(args.name)
    elif draft_dir.exists():
        if not args.force:
            raise FileExistsError(f"草稿目录已存在但未注册：{draft_dir}")
        shutil.rmtree(draft_dir)

    script = folder.create_draft(args.name, width, height, fps=fps, maintrack_adsorb=False)
    tracks = [draft.TrackSpec(draft.TrackType.video, TRACK_VIDEO), draft.TrackSpec(draft.TrackType.text, TRACK_TEXT)]
    if has_audio:
        tracks.append(draft.TrackSpec(draft.TrackType.audio, TRACK_AUDIO))
    script.append_tracks(tracks)

    # 素材拷进草稿自己的文件夹，之后挪动或删除原视频也不会让草稿丢素材。
    asset = base.copy_media(source, draft_dir / "素材" / "视频" / source.name)
    base.progress(40, "已整理素材")

    video = base.video_material_from_ffprobe(asset, ffprobe, probe_cache)
    for row in shots:
        window = draft.trange(row["start_us"], duration=row["duration_us"])
        # 音频单独一条轨，画面片段静音，避免声音叠两层。
        script.add_segment(
            draft.VideoSegment(video, window, source_timerange=window, speed=1.0, volume=0.0),
            track=TRACK_VIDEO,
        )
    if has_audio:
        audio = base.audio_material_from_ffprobe(asset, ffprobe, probe_cache)
        length = min(duration_us, audio.duration)
        window = draft.trange(0, duration=length)
        script.add_segment(draft.AudioSegment(audio, window, source_timerange=window, volume=1.0), track=TRACK_AUDIO)
    for row in texts:
        script.add_segment(
            draft.TextSegment(
                row["text"],
                draft.trange(row["start_us"], duration=row["duration_us"]),
                style=draft.TextStyle(size=7.0, color=(1.0, 1.0, 1.0), align=1, auto_wrapping=True, max_line_width=0.82),
                clip_settings=draft.ClipSettings(transform_y=-0.78),
            ),
            track=TRACK_TEXT,
        )
    script.save()
    base.progress(92, "视频、音频、文案三条轨道已保存")

    manifest = {
        "schema": SCHEMA,
        "draft_name": args.name,
        "draft_dir": str(draft_dir),
        "source_project": str(project_dir / "project.json"),
        "source_video": str(asset),
        "canvas": {"width": width, "height": height, "fps": fps, "duration_us": duration_us},
        "tracks": {
            "video": {"name": TRACK_VIDEO, "clip_count": len(shots), "clips": shots},
            "audio": {"name": TRACK_AUDIO, "present": has_audio, "scope": "full_episode"},
            "text": {"name": TRACK_TEXT, "cue_count": len(texts), "segments": texts},
        },
    }
    (draft_dir / "hongguo-draft-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "success": True,
        "draft_dir": str(draft_dir),
        "draft_info": str(draft_dir / "draft_info.json"),
        "manifest": str(draft_dir / "hongguo-draft-manifest.json"),
        "fps": fps,
        "duration_us": duration_us,
        "clip_count": len(shots),
        "subtitle_count": len(texts),
        "track_mode": "simple",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
