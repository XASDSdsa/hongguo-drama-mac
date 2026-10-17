#!/usr/bin/env python3
"""Run PySceneDetect AdaptiveDetector and emit a JSON cut list.

This helper intentionally has no FFmpeg/scene-threshold fallback. The caller
must surface the missing PySceneDetect dependency as a blocked stage instead
of silently changing the boundary algorithm.
"""
import argparse
import json
import sys


def _load_api():
    try:
        from scenedetect import AdaptiveDetector, SceneManager, open_video
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "未找到 PySceneDetect，AdaptiveDetector 阶段无法运行；"
            "请在应用运行时提供已打包的 scenedetect 环境，不会自动改用其他算法。"
        ) from exc
    return AdaptiveDetector, SceneManager, open_video


def detect(input_path, min_scene_seconds=0.2, adaptive_threshold=3.0):
    AdaptiveDetector, SceneManager, open_video = _load_api()

    # PyAV is already part of the pinned faster-whisper runtime.  It preserves
    # container PTS for VFR inputs and avoids a second OpenCV decode path.
    video = open_video(input_path, backend="pyav", suppress_output=True)
    fps = float(video.frame_rate)
    min_scene_len = max(1, round(float(min_scene_seconds) * fps))
    manager = SceneManager()
    manager.add_detector(
        AdaptiveDetector(
            adaptive_threshold=float(adaptive_threshold),
            min_scene_len=min_scene_len,
        )
    )
    manager.detect_scenes(video=video)
    scenes = manager.get_scene_list()
    cuts = []
    for index, (start, end) in enumerate(scenes):
        start_frame = int(start.get_frames())
        end_frame = int(end.get_frames())
        if index > 0 and start_frame > 0:
            cuts.append({
                "frame": start_frame,
                "score": None,
                "reason": "AdaptiveDetector 镜头边界",
                "boundary_kind": "hard_cut",
            })
        if end_frame <= start_frame:
            continue
    return {"fps": fps, "cuts": cuts}


def self_test():
    AdaptiveDetector, SceneManager, open_video = _load_api()
    detector = AdaptiveDetector(adaptive_threshold=3.0, min_scene_len=1)
    if detector is None or SceneManager is None or open_video is None:
        raise RuntimeError("PySceneDetect AdaptiveDetector 初始化失败")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--min-scene-seconds", type=float, default=0.2)
    parser.add_argument("--adaptive-threshold", type=float, default=3.0)
    args = parser.parse_args()
    print(json.dumps(detect(args.input, args.min_scene_seconds, args.adaptive_threshold), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
