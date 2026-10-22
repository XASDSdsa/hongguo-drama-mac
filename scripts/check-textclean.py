"""Keyframe text cleaning: which recognizer readings count as text (taken from a real episode: subtitles, name cards
and a document title are text; a hair clip read as '0', prison-uniform stripes read as '1' / '三' are not), and vertical
name cards laid out as a line for the recognizer. No models needed."""
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/native/video-structure'))
from textclean import DEFAULTS, readable, TextReader  # noqa: E402

cases = [
    ('三年前', 1.00, True), ('男主', 0.80, True), ('林', 0.93, True), ('你倩', 0.60, True), ('林大县元', 0.71, True),
    ('所有责任都落落到了我身上', 0.87, True), ('设备转让让协司', 0.99, True), ('c', 0.52, True), ('D', 0.9, True),
    ('0', 0.32, False), ('1', 0.35, False), ('三', 0.52, False), ('111', 0.8, False), ('川', 0.7, False),
    ('o', 0.6, False), ('一二', 0.84, False), ('一二', 0.9, True), ('', 0.99, False), ('  ', 0.99, False),
    ('好', 0.45, False), ('你好', 0.5, False),
]
for text, conf, expect in cases:
    assert readable(text, conf, DEFAULTS) is expect, (text, conf, expect)

reader = TextReader.__new__(TextReader)
import cv2  # noqa: E402
reader.cv2 = cv2
vertical = np.zeros((300, 60, 3), np.uint8)
line = reader.horizontal(vertical)
assert line.shape == (60, 300, 3), line.shape  # five stacked characters -> one line of five
assert reader.horizontal(np.zeros((40, 200, 3), np.uint8)).shape == (40, 200, 3)  # horizontal text unchanged
print('PASS text cleaning: readings judged like the real episode (text kept, hair clip / stripes refused); vertical cards read as a line')
