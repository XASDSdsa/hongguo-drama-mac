"""TransNet V2 flags the LAST frame of the outgoing shot; a cut must be the FIRST frame of the next shot.

Regression for the one-frame leak (each clip began with the previous shot's final frame). Needs numpy + OpenCV only.
"""
import json
import sys
import tempfile
import types
from pathlib import Path

import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'src/native/video-structure'))
import runner  # noqa: E402

FPS = 25
COUNT = 300


def scenes(cuts):
    """Frames of unrelated random textures; `cuts` are the first frames of the new scenes."""
    frames = np.empty((COUNT, 90, 160, 3), np.uint8)
    edges = [0, *cuts, COUNT]
    for index in range(len(edges) - 1):
        texture = np.random.default_rng(100 + index).integers(0, 255, (90, 160, 3), dtype=np.uint8)
        frames[edges[index]:edges[index + 1]] = texture
    return frames


def verify(flagged, cuts=(100, 200)):
    score = np.full(COUNT, 0.01)
    for frame, value in flagged.items():
        score[frame] = value
    pts = [i / FPS for i in range(COUNT)]
    with tempfile.TemporaryDirectory() as temp:
        temp = Path(temp)
        scenes(cuts).tofile(temp / 'review.rgb')
        (temp / 'timeline.json').write_text(json.dumps(dict(frame_count=COUNT, video_end=COUNT / FPS, frames=[dict(start=t) for t in pts])))
        (temp / 'predictions.json').write_text(json.dumps(dict(single=score.tolist(), all=score.tolist())))
        args = types.SimpleNamespace(input=str(temp / 'review.rgb'), timeline=str(temp / 'timeline.json'),
                                     predictions=str(temp / 'predictions.json'), threshold=0.5)
        return runner.verify_shots(args)


# The model flags frames 99 and 199 (last frames of scenes 1 and 2); scenes 2 and 3 start at 100 and 200.
result = verify({99: 0.96, 199: 0.99})
assert result['algorithm_id'] == 'transnetv2-temporal-min2s-v2'
assert result['boundary_convention'] == 'first_frame_of_next_shot'
assert result['cuts'] == [100, 200], result['cuts']
assert result['candidate_frames'] == result['verified_candidate_frames'] == [100, 200]
assert [(d['frame'], d['model_frame'], d['status']) for d in result['decisions']] == [(100, 99, 'kept'), (200, 199, 'kept')]
assert result['decisions'][0]['time'] == 100 / FPS
assert result['duration_merged_frames'] == []

# A flag on the very last frame is not a cut: there is no next shot.
assert verify({99: 0.96, COUNT - 1: 0.9})['cuts'] == [100]

# The 2 s rule counts true shot lengths. Scene 1 = 50 frames is exactly 2.0 s and is kept; 49 frames is not.
exact = verify({49: 0.9}, cuts=(50,))
assert exact['cuts'] == [50] and exact['warnings'] == [], exact
short = verify({48: 0.9}, cuts=(49,))
assert short['cuts'] == [] and short['duration_merged_frames'] == [49], short

print('PASS cut frame = first frame of the next shot; 2 s rule uses true boundaries; last-frame flag ignored')
