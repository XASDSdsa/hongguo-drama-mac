"""Regression gate for the shot algorithm using real TransNet V2 scores from episode 103."""
import json
from pathlib import Path
import sys

import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'src/native/video-structure'))
from shot_duration import minimum_duration  # noqa: E402
from shot_verification import candidate_frames  # noqa: E402

b = json.loads((root / 'docs/algorithms/shot-boundary/baseline-ep103.json').read_text())
scores = np.asarray(b['single_scores'])
assert len(scores) == len(b['frame_times']) == b['frame_count']

# Every approved model frame must still be a candidate (verification can only remove candidates).
model_frames = [f for f in candidate_frames(scores) if f + 1 < len(scores)]
assert set(b['verified_model_frames']) <= set(model_frames)

# Model frame = last frame of the outgoing shot; the cut is the next frame, carrying the model frame's score.
boundaries = [f + 1 for f in b['verified_model_frames']]
boundary_scores = np.concatenate(([0.0], scores[:-1]))
cuts, warning = minimum_duration(boundaries, b['frame_times'], b['source_duration'], boundary_scores, 2)
assert cuts == b['expected_cuts'] and warning is None, (cuts, warning)
edges = [b['frame_times'][0], *[b['frame_times'][c] for c in cuts], b['source_duration']]
assert len(edges) - 1 == b['expected_shots']
assert abs(min(y - x for x, y in zip(edges, edges[1:])) - b['expected_min_seconds']) < 1e-5
assert minimum_duration([], [2.1, 2.14], 2.18, [0, 0], 2) == ([], 'source_shorter_than_minimum')

# Candidate selection under the 2 s rule maximizes expected value (confidence - 0.5), not the raw sum.
times = [i / 25 for i in range(250)]
def pick(cuts_scores):
    score = [0.0] * 250
    for cut, value in cuts_scores.items():
        score[cut] = value
    return minimum_duration(sorted(cuts_scores), times, 10.0, score, 2)[0]
# Two weak cuts 1.8 s apart must not beat one strong cut between them.
assert pick({100: 0.55, 145: 0.99, 190: 0.55}) == [145]
# A cluster of confident cuts keeps the two outer ones (more true cuts survive than with the middle one alone).
assert pick({100: 0.92, 145: 0.985, 190: 0.95}) == [100, 190]
print(f"PASS episode 103: {b['expected_shots']} shots, {len(cuts)} cuts, minimum {b['expected_min_seconds']}s; short source kept whole")
