"""Regression gate for the user-approved shot algorithm; optional decoded .npy fixture."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
frozen = root / 'docs/algorithms/shot-boundary-v1'
live = root / 'src/native/video-structure'
for source, target in [('verify.py', 'shot_verification.py'), ('duration_policy.py', 'shot_duration.py')]:
    assert (frozen / source).read_bytes() == (live / target).read_bytes(), 'Approved algorithm changed: ' + target
sys.path.insert(0, str(live))
from shot_duration import minimum_duration
b = json.loads((frozen / 'accepted-baseline.json').read_text())
cuts, warning = minimum_duration(b['verified_candidate_frames'], b['frame_times'], b['source_duration'], b['predictions']['single'], 2)
assert cuts == b['accepted']['cuts'] and warning is None
assert minimum_duration([], [2.1, 2.14], 2.18, [0, 0], 2) == ([], 'source_shorter_than_minimum')
if len(sys.argv) > 1:
    import numpy as np
    from shot_verification import candidate_frames, verify
    frames = np.load(sys.argv[1], mmap_mode='r')
    verified, decisions = verify(frames, np.array(b['frame_times']), candidate_frames(b['predictions']['single']), b['source_duration'])
    assert verified == b['verified_candidate_frames']
    assert [d['status'] for d in decisions] == [d['status'] for d in b['verification_decisions']]
print('PASS live algorithm equals frozen code; 22 approved shots; minimum 2s; short offset source')
