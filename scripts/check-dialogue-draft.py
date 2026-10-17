#!/usr/bin/env python3
"""Regression checks for unchanged voice clips and exactly paired subtitles."""
from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def load_adapter():
    spec = importlib.util.spec_from_file_location("hongguo_create_jianying_draft", Path(__file__).with_name("create-jianying-draft.py"))
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def write_srt(srt, cues):
    def timestamp(seconds):
        millis = round(seconds * 1000)
        return f"{millis // 3600000:02d}:{millis // 60000 % 60:02d}:{millis // 1000 % 60:02d},{millis % 1000:03d}"
    srt.write_text("\n\n".join(f"{i}\n{timestamp(row['start'])} --> {timestamp(row['end'])}\n{row['text']}" for i, row in enumerate(cues, 1)) + "\n", encoding="utf-8")


def assemble(adapter, raw, transcript, cues):
    groups = adapter.output_groups(raw["shots"], transcript)
    shots = []
    for group in groups:
        first, last = group[0], group[-1]
        shot_id = f"s{first['start_frame']}-{last['end_frame_exclusive']}"
        shot = {
            "shot_id": shot_id,
            "order": len(shots) + 1,
            "start": first["start"],
            "end": last["end"],
            "start_frame": first["start_frame"],
            "end_frame_exclusive": last["end_frame_exclusive"],
            "source_shot_ids": [row["shot_id"] for row in group],
            "internal_boundaries": [{"time": row["start"], "frame": row["start_frame"], "status": "merged"} for row in group[1:]],
            "utterance_ids": [row["utterance_id"] for row in transcript["utterances"] if row["start"] < last["end"] and row["end"] > first["start"]],
        }
        shots.append(shot)
    associations = []
    for row in transcript["utterances"]:
        owners = [shot for shot in shots if row["start"] < shot["end"] and row["end"] > shot["start"]]
        associations.append({"utterance_id": row["utterance_id"], "start": row["start"], "end": row["end"], "shot_ids": [shot["shot_id"] for shot in owners], "segments": [{"shot_id": shot["shot_id"], "start": max(row["start"], shot["start"]), "end": min(row["end"], shot["end"])} for shot in owners]})
        if len(owners) == 1:
            associations[-1]["shot_id"] = owners[0]["shot_id"]
    for cue in cues:
        owners = [shot["shot_id"] for shot in shots if cue["start"] < shot["end"] and cue["end"] > shot["start"]]
        cue["shot_ids"] = owners
        if len(owners) == 1:
            cue["shot_id"] = owners[0]
        else:
            cue.pop("shot_id", None)
    decisions = []
    for group in groups:
        for index, row in enumerate(group):
            if row is raw["shots"][0]:
                continue
            decisions.append({"time": row["start"], "frame": row["start_frame"], "status": "merged" if index else "kept"})
    aligned = {
        "pause_tiers": list(adapter.PAUSE_TIERS),
        "max_shot_seconds": 60,
        "boundary_decisions": decisions,
        "algorithm_id": adapter.ALIGNMENT_ALGORITHM,
        "boundary_policy": adapter.BOUNDARY_POLICY,
        "raw_shot_count": len(raw["shots"]),
        "merged_boundary_count": sum(len(group) - 1 for group in groups),
        "shots": shots,
        "associations": associations,
    }
    clips = {"boundary_policy": aligned["boundary_policy"], "alignment_algorithm_id": aligned["algorithm_id"], "clips": [{**row, "path": f"shot-{row['order']}.mp4"} for row in shots]}
    return aligned, clips


def fixture(adapter, srt: Path, first_end: float = 2.2):
    raw = {"shots": [{"shot_id": f"raw{i}", "order": i, "start": i - 1, "end": i, "start_frame": (i - 1) * 25, "end_frame_exclusive": i * 25} for i in range(1, 4)]}
    utterances = [{"utterance_id": "u1", "text": "这是一句连续跨镜头的完整台词", "start": 0.2, "end": first_end}, {"utterance_id": "u2", "text": "同一镜头第二句", "start": 2.3, "end": 2.5}, {"utterance_id": "u3", "text": "同一镜头第三句", "start": 2.6, "end": 2.8}]
    transcript = {"utterances": utterances, "voice_timeline": {"segments": [{**row, "segment_id": f"v{i}"} for i, row in enumerate(utterances)]}}
    export = {"subtitle_policy": "voice-segments-v1", "subtitle_cues": [{**row, "cue_id": f"v{i}", "voice_segment_id": f"v{i}", "text": row["text"]} for i, row in enumerate(transcript["voice_timeline"]["segments"])]}
    aligned, clips = assemble(adapter, raw, transcript, export["subtitle_cues"])
    write_srt(srt, export["subtitle_cues"])
    return aligned, clips, transcript, export, srt, raw


def main() -> int:
    adapter = load_adapter()
    with tempfile.TemporaryDirectory(prefix="hongguo-dialogue-draft-") as directory:
        root = Path(directory)
        srt = root / "字幕.srt"
        for first_end, clip_count in ((1.2, 2), (2.2, 1)):
            values = fixture(adapter, srt, first_end)
            clip_rows, voice_rows, subtitles = adapter.validate_dialogue_timeline(*values)
            # 1.2s 结束的话在 2 秒气口上切开；2.2s 的话盖住两刀，整集并成一段。
            assert len(clip_rows) == clip_count
            assert len(subtitles) == len(voice_rows) == 3
            assert voice_rows[0]["segment_id"] == subtitles[0]["voice_segment_id"] == "v0"
            assert voice_rows[0]["shot_ids"] == [clip_rows[0]["shot_id"]]
            assert subtitles[0]["shot_ids"] == [clip_rows[0]["shot_id"]]
            later = clip_rows[-1]["shot_id"]
            assert subtitles[1]["shot_ids"] == subtitles[2]["shot_ids"] == [later]
            assert subtitles[0]["duration_us"] == round((first_end - 0.2) * 1000000)
            for voice, subtitle in zip(voice_rows, subtitles):
                assert voice["segment_id"] == subtitle["voice_segment_id"]
                assert adapter.us(voice["start"]) == subtitle["start_us"]
                assert adapter.us(voice["end"]) == subtitle["start_us"] + subtitle["duration_us"]
        aligned, clips, transcript, export, _, raw = values
        cases = [
            ("legacy alignment", lambda a, c, t, e, s, r: a.update(algorithm_id="visual-shots-with-dialogue-index-v2")),
            ("outdated clips", lambda a, c, t, e, s, r: c["clips"][0].update(end=0.9)),
            ("dropped visual shot", lambda a, c, t, e, s, r: r["shots"].pop()),
            ("changed raw boundary", lambda a, c, t, e, s, r: r["shots"][0].update(end=0.9)),
            ("utterance past video", lambda a, c, t, e, s, r: t["utterances"][0].update(end=3.2)),
            ("voice truncated", lambda a, c, t, e, s, r: t["voice_timeline"]["segments"][0].update(end=1.2)),
            ("duplicate association", lambda a, c, t, e, s, r: a["associations"].append(a["associations"][0])),
            ("missing overlap shot", lambda a, c, t, e, s, r: a["associations"][0]["shot_ids"].pop()),
            ("missing overlap segment", lambda a, c, t, e, s, r: a["associations"][0]["segments"].pop()),
            ("wrong overlap range", lambda a, c, t, e, s, r: a["associations"][0]["segments"][0].update(end=0.8)),
            ("missing subtitle", lambda a, c, t, e, s, r: e["subtitle_cues"].pop()),
            ("truncated subtitle", lambda a, c, t, e, s, r: e["subtitle_cues"][0].update(end=1)),
            ("changed subtitle text", lambda a, c, t, e, s, r: e["subtitle_cues"][0].update(text="被改了")),
            ("cut kept inside speech", lambda a, c, t, e, s, r: a["boundary_decisions"][0].update(status="kept", tier=0)),
            ("relaxed cut without a limit", lambda a, c, t, e, s, r: (a.update(max_shot_seconds=None), a["boundary_decisions"][-1].update(status="kept", tier=1))),
            ("missing decision record", lambda a, c, t, e, s, r: a["boundary_decisions"].pop()),
            ("old subtitle policy", lambda a, c, t, e, s, r: e.pop("subtitle_policy")),
            ("duplicated voice reference", lambda a, c, t, e, s, r: e["subtitle_cues"][1].update(voice_segment_id="v0")),
            ("sub-millisecond subtitle drift", lambda a, c, t, e, s, r: e["subtitle_cues"][0].update(start=.200001)),
        ]
        for label, mutate in cases:
            altered = copy.deepcopy(values)
            mutate(*altered)
            try:
                adapter.validate_dialogue_timeline(*altered)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"accepted {label}")
        original_srt = srt.read_text(encoding="utf-8")
        srt.write_text(original_srt.replace("同一镜头第二句", "错误字幕"), encoding="utf-8")
        try:
            adapter.validate_dialogue_timeline(*values)
        except RuntimeError:
            pass
        else:
            raise AssertionError("accepted changed SRT text")
        srt.write_text(original_srt, encoding="utf-8")
        # A silence gap divides both the voice clips and their subtitle pieces.
        first = transcript["utterances"][0]
        first["speech_spans"] = [{"start": .2, "end": .800333}, {"start": 1.200123, "end": 2.2}]
        voices = transcript["voice_timeline"]["segments"]
        transcript["voice_timeline"]["segments"] = [{**voices[0], **span, "segment_id": f"v0-span{i}"} for i, span in enumerate(first["speech_spans"])] + voices[1:]
        pieces = ["这是一句连续", "跨镜头的完整台词"]
        export["subtitle_cues"] = [{**span, "cue_id": f"v0-span{i}", "voice_segment_id": f"v0-span{i}", "utterance_id": "u1", "text": pieces[i]} for i, span in enumerate(first["speech_spans"])] + export["subtitle_cues"][1:]
        aligned, clips = assemble(adapter, raw, transcript, export["subtitle_cues"])
        values = (aligned, clips, transcript, export, srt, raw)
        write_srt(srt, export["subtitle_cues"])
        _, gaps, subtitles = adapter.validate_dialogue_timeline(*values)
        # The breath at 1s is a real pause on a visual cut, so that cut stays.
        # The later visual cut sits inside the second span and is merged.
        assert len(subtitles) == len(gaps) == 4
        source_gap_rows = [row for row in gaps if row["segment_id"] in {"v0-span0", "v0-span1"}]
        assert [(row["start"], row["end"]) for row in source_gap_rows] == [(.2, .800333), (1.200123, 2.2)]
        assert all(row["utterance_id"] == "u1" for row in source_gap_rows)
        assert [row["text"] for row in subtitles[:2]] == pieces
        for subtitle in subtitles[:2]:
            source_row = next(row for row in source_gap_rows if row["segment_id"] == subtitle["voice_segment_id"])
            assert subtitle["start_us"] == adapter.us(source_row["start"])
            assert subtitle["duration_us"] == adapter.us(source_row["end"]) - adapter.us(source_row["start"])
        # Preserve genuine repeated words and spaces across the audio gap.
        for source, text_pieces in (("等等", ["等", "等"]), ("先说 hello 再说", ["先说 hello ", "再说"])):
            altered = copy.deepcopy(values)
            altered[2]["utterances"][0]["text"] = source
            for row in altered[2]["voice_timeline"]["segments"][:2]:
                row["text"] = source
            for row, text in zip(altered[3]["subtitle_cues"][:2], text_pieces):
                row["text"] = text
            write_srt(srt, altered[3]["subtitle_cues"])
            _, _, actual = adapter.validate_dialogue_timeline(*altered)
            assert "".join(row["text"] for row in actual[:2]) == source
            altered[3]["subtitle_cues"][1]["text"] = source
            try:
                adapter.validate_dialogue_timeline(*altered)
            except RuntimeError:
                pass
            else:
                raise AssertionError("accepted repetition of the complete utterance on each voice clip")
        write_srt(srt, export["subtitle_cues"])
        altered = copy.deepcopy(values)
        altered[2]["voice_timeline"]["segments"].pop(1)
        try:
            adapter.validate_dialogue_timeline(*altered)
        except RuntimeError:
            pass
        else:
            raise AssertionError("accepted missing speech span")

        repository = Path(__file__).resolve().parents[1]
        bundled = repository / "build/ffmpeg/darwin-arm64/ffmpeg"
        ffmpeg = adapter.resolve_ffmpeg(bundled if bundled.is_file() else None)
        def run(*args):
            result = subprocess.run(list(map(str, args)), capture_output=True, text=True, encoding="utf-8")
            if result.returncode:
                raise AssertionError(result.stderr or result.stdout)
            return result
        for row in clips["clips"]:
            run(ffmpeg, "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=black:size=64x64:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", root / row["path"])
        run(ffmpeg, "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-ac", "2", root / "声音.wav")
        transcript["voice_timeline"]["path"] = "声音.wav"
        transcript["background_timeline"] = {"path": "声音.wav"}
        export["srt"] = srt.name
        modules = {"media": {"video_end": 3, "streams": [{"codec_type": "video", "width": 64, "height": 64, "avg_frame_rate": "25/1"}]}, "shots": raw, "clips": clips, "separation": {}, "transcript": transcript, "alignment": aligned, "export": export}
        project = {"project_id": "dialogue-draft-test", "modules": {}}
        for name, result in modules.items():
            filename = f"{name}.json"
            (root / filename).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            project["modules"][name] = {"status": "succeeded", "result_path": filename}
        (root / "project.json").write_text(json.dumps(project), encoding="utf-8")
        run(sys.executable, repository / "scripts/create-jianying-draft.py", root, "--name", "视觉分镜台词索引回归", "--output-root", root / "drafts", "--ffmpeg", ffmpeg)
        draft_dir = root / "drafts/视觉分镜台词索引回归"
        checker = repository / "scripts/check-jianying-draft.py"
        run(sys.executable, checker, draft_dir)
        content_path = draft_dir / "draft_info.json"
        native = json.loads(content_path.read_text(encoding="utf-8"))
        tracks = {track["name"]: track for track in native["tracks"]}
        assert len(tracks["字幕"]["segments"]) == 4
        assert len(tracks["配音"]["segments"]) == 4
        assert tracks["字幕"]["segments"][0]["target_timerange"] == {"start": 200000, "duration": 600333}
        assert tracks["字幕"]["segments"][1]["target_timerange"] == {"start": 1200123, "duration": 999877}
        assert [row["target_timerange"] for row in tracks["配音"]["segments"]] == [row["target_timerange"] for row in tracks["字幕"]["segments"]] == [
            {"start": 200000, "duration": 600333},
            {"start": 1200123, "duration": 999877},
            {"start": 2300000, "duration": 200000},
            {"start": 2600000, "duration": 200000},
        ]
        native_cases = [
            ("字幕", lambda track: track["segments"][0]["target_timerange"].update(duration=1100000)),
            ("配音", lambda track: track["segments"][0]["target_timerange"].update(duration=1100000)),
            ("特效声", lambda track: track["segments"][0]["target_timerange"].update(duration=900000)),
            ("字幕", lambda track: track["segments"].append(copy.deepcopy(track["segments"][0]))),
        ]
        for name, mutate in native_cases:
            altered = copy.deepcopy(native)
            mutate(next(row for row in altered["tracks"] if row["name"] == name))
            content_path.write_text(json.dumps(altered, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run([sys.executable, str(checker), str(draft_dir)], capture_output=True, text=True)
            assert result.returncode != 0, f"accepted corrupt {name} native track"
        content_path.write_text(json.dumps(native, ensure_ascii=False), encoding="utf-8")
        manifest_path = draft_dir / "hongguo-draft-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        checker_spec = importlib.util.spec_from_file_location("hongguo_check_jianying_draft", checker)
        validator = importlib.util.module_from_spec(checker_spec)
        checker_spec.loader.exec_module(validator)

        def set_bounds(content, manifest, kind, index, start, end):
            record = manifest["tracks"][kind]
            row = record["segments"][index]
            row.update(start_us=start, duration_us=end - start)
            native_track = next(track for track in content["tracks"] if track["name"] == record["name"])
            native_track["segments"][index]["target_timerange"] = {"start": start, "duration": end - start}
            row["shot_segments"] = [{"shot_id": shot["shot_id"], "start_us": max(start, shot["start_us"]), "end_us": min(end, shot["start_us"] + shot["duration_us"])} for shot in manifest["tracks"]["video"]["clips"] if start < shot["start_us"] + shot["duration_us"] and end > shot["start_us"]]
            row["shot_ids"] = [part["shot_id"] for part in row["shot_segments"]]

        # Keep native and manifest bounds consistent: these cases must fail
        # because the dialogue pairing is wrong, not a stale manifest check.
        paired_cases = [
            ("subtitle shifted one microsecond", lambda c, m: set_bounds(c, m, "subtitles", 0, 200001, 800333)),
            ("voice shifted one microsecond", lambda c, m: set_bounds(c, m, "voice", 0, 200001, 800333)),
            ("duplicate voice id", lambda c, m: m["tracks"]["voice"]["segments"][1].update(segment_id="v0-span0")),
            ("legacy source id alias", lambda c, m: m["tracks"]["voice"]["segments"][0].update(segment_id="v0-span0:shot:s1", source_segment_id="v0-span0")),
            ("paired clips overlap", lambda c, m: [set_bounds(c, m, kind, 0, 200000, 1250000) for kind in ("voice", "subtitles")]),
            ("paired clips fill part of a silence gap", lambda c, m: [set_bounds(c, m, kind, 0, 200000, 900000) for kind in ("voice", "subtitles")]),
        ]
        for label, mutate in paired_cases:
            changed_native, changed_manifest = copy.deepcopy(native), copy.deepcopy(manifest)
            mutate(changed_native, changed_manifest)
            try:
                validator.validate_dialogue_tracks(changed_native, changed_manifest, {track["name"]: track for track in changed_native["tracks"]})
            except SystemExit:
                pass
            else:
                raise AssertionError(f"accepted {label}")
        manifest_cases = [
            ("missing overlap", lambda item: item["tracks"]["subtitles"]["segments"][0]["shot_ids"].pop()),
            ("duplicate voice reference", lambda item: item["tracks"]["subtitles"]["segments"][1].update(voice_segment_id="v0-span0", cue_id="v0-span0")),
            ("changed source text", lambda item: [row.update(source_text="不同文字") for row in item["tracks"]["subtitles"]["segments"][:2]]),
            ("filled silence gap", lambda item: [row.update(speech_spans=[{"start_us": 200000, "end_us": 2200000}]) for row in item["tracks"]["subtitles"]["segments"][:2]]),
        ]
        for label, mutate in manifest_cases:
            altered = copy.deepcopy(manifest)
            mutate(altered)
            manifest_path.write_text(json.dumps(altered, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run([sys.executable, str(checker), str(draft_dir)], capture_output=True, text=True)
            assert result.returncode != 0, f"accepted corrupt manifest: {label}"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        run(sys.executable, checker, draft_dir)
    print("PASS voice-paired subtitles: exact microseconds, real silence gaps, no text loss or repetition, cuts only where a breath lands on a visual cut")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
