"""Storyboard keyframes: find every piece of overlay text anywhere in the frame (subtitles wherever they sit, name cards,
vertical captions, titles) with the PP-OCRv3 DB text detector through OpenCV, keep only boxes that look like real
overlay text (thin gray-white / yellow strokes, several of them; ears, eyes and highlights are refused), repaint them
with LaMa (only crops around the text), then look again; text still found where it was gets a second pass."""
import time
import numpy as np

DET_MEAN = (122.67891434, 116.66876762, 104.00698793)
# Defaults; the app sends its own values with every job (so they can be tuned without rebuilding this runtime).
DEFAULTS = dict(binary=0.3, polygon=0.5, unclip=2.0, min_share=0.004, min_strokes=3, contrast=40, min_luma=90,
                context=96, lama_width=640, grow=3, passes=2)


class TextFinder:
    def __init__(self, path):
        import cv2
        self.cv2 = cv2
        self.model = cv2.dnn_TextDetectionModel_DB(path)
        self.model.setBinaryThreshold(0.3)
        self.model.setPolygonThreshold(0.5)
        self.model.setMaxCandidates(200)
        self.model.setUnclipRatio(2.0)

    def configure(self, options):
        self.options = options
        self.model.setBinaryThreshold(float(options['binary']))
        self.model.setPolygonThreshold(float(options['polygon']))
        self.model.setUnclipRatio(float(options['unclip']))

    def raw(self, rgb):
        h, w = rgb.shape[:2]
        size = (max(32, int(round(w / 32)) * 32), max(32, int(round(h / 32)) * 32))
        self.model.setInputParams(1.0 / 255.0, size, DET_MEAN, False)
        boxes, scores = self.model.detect(np.ascontiguousarray(rgb))
        return [np.array(b, np.float32) for b in boxes], [float(s) for s in scores]

    def looks_like_text(self, rgb, box):
        """Overlay text: gray-white or yellow strokes, thin (darker on both sides within 3 px), several separate strokes.
        Ears, eyes, highlights and skin are rejected."""
        h, w = rgb.shape[:2]
        x0, y0 = np.maximum(np.floor(box.min(0)).astype(int), 0)
        x1, y1 = np.minimum(np.ceil(box.max(0)).astype(int), [w - 1, h - 1])
        if x1 - x0 < 6 or y1 - y0 < 6 or (x1 - x0) * (y1 - y0) > 0.3 * w * h:
            return False, 'size'
        crop = rgb[y0:y1 + 1, x0:x1 + 1].astype(np.float32)
        luma = 0.299 * crop[..., 0] + 0.587 * crop[..., 1] + 0.114 * crop[..., 2]
        # 笔画多粗跟字多大走：框（检测框比字大一圈）短边的 1/16 左右，至少 3 像素
        options = getattr(self, 'options', DEFAULTS)
        k, c = max(3, int(round(min(x1 - x0, y1 - y0) / 16))), float(options['contrast'])
        H, W = luma.shape
        pad = np.pad(luma, k, mode='edge')
        def side(dy, dx):
            low = np.full_like(luma, 255.0)
            for d in range(1, k + 1):
                low = np.minimum(low, pad[k + dy * d:k + dy * d + H, k + dx * d:k + dx * d + W])
            return low
        thin = ((side(0, -1) <= luma - c) & (side(0, 1) <= luma - c)) | ((side(-1, 0) <= luma - c) & (side(1, 0) <= luma - c))
        sat = crop.max(-1) - crop.min(-1)
        r, g, b = crop[..., 0], crop[..., 1], crop[..., 2]
        colour = (sat <= 60) | ((r >= 120) & (g >= 100) & (b <= r - 40))  # gray-white or yellow
        strokes = thin & colour & (luma >= float(options['min_luma']))
        share = strokes.sum() / strokes.size
        count, _ = TextFinder._components(strokes)
        info = f'k={k} share={share:.4f} strokes={count} gray={float((colour & (luma >= 90)).mean()):.2f}'
        if share < float(options['min_share']):
            return False, 'no thin strokes ' + info
        if count < int(options['min_strokes']):
            return False, 'too few strokes ' + info
        return True, info

    @staticmethod
    def _components(mask):
        import cv2
        n, _ = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
        return n - 1, None

    def find(self, rgb):
        boxes, scores = self.raw(rgb)
        kept, rejected = [], []
        for box, score in zip(boxes, scores):
            ok, why = self.looks_like_text(rgb, box)
            (kept if ok else rejected).append((box, score, why))
        return kept, rejected


def text_mask(shape, boxes, grow):
    import cv2
    mask = np.zeros(shape[:2], np.uint8)
    for box, _, _ in boxes:
        cv2.fillPoly(mask, [np.round(box).astype(np.int32)], 1)
    if grow > 0:
        mask = cv2.dilate(mask, np.ones((2 * grow + 1, 2 * grow + 1), np.uint8))
    return mask


def regions(mask, context):
    """Crops around each group of text (overlapping crops merged) with `context` pixels of picture around it."""
    import cv2
    h, w = mask.shape
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    rects = []
    for i in range(1, n):
        x, y, bw, bh = stats[i][:4]
        m = max(context, bh)
        rects.append([max(0, x - m), max(0, y - m), min(w, x + bw + m), min(h, y + bh + m)])
    merged = True
    while merged:
        merged = False
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                a, b = rects[i], rects[j]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    rects[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    rects.pop(j)
                    merged = True
                    break
            if merged:
                break
    return rects


def lama_fill(model, torch, rgb, mask, rect, scale=1.0):
    """Repaint the masked pixels inside rect with LaMa. scale < 1 runs LaMa on a smaller copy (the storyboard keyframes are
    shown at 320 / 560 wide, so a 1080p frame does not need a 1080p repaint) and scales the repaint back up; only the
    masked pixels are replaced, everything else keeps the original pixels."""
    import cv2
    x0, y0, x1, y1 = rect
    crop = rgb[y0:y1, x0:x1]
    keep = mask[y0:y1, x0:x1] > 0
    h, w = keep.shape
    if scale < 1.0:
        sw, sh = max(8, int(round(w * scale))), max(8, int(round(h * scale)))
        small = cv2.resize(crop, (sw, sh), interpolation=cv2.INTER_AREA)
        small_mask = cv2.resize(keep.astype(np.uint8), (sw, sh), interpolation=cv2.INTER_AREA) > 0
    else:
        sw, sh, small, small_mask = w, h, crop, keep
    m = small_mask.astype(np.float32)
    ph, pw = (8 - sh % 8) % 8, (8 - sw % 8) % 8
    img = np.pad(small, ((0, ph), (0, pw), (0, 0)), mode='symmetric')
    mm = np.pad(m, ((0, ph), (0, pw)), mode='symmetric')
    with torch.no_grad():
        out = model(torch.from_numpy(img.copy()).permute(2, 0, 1)[None].float() / 255, torch.from_numpy(mm.copy())[None, None])
    out = (out[0].permute(1, 2, 0).numpy() * 255).round().clip(0, 255).astype(np.uint8)[:sh, :sw]
    if (sw, sh) != (w, h):
        out = cv2.resize(out, (w, h), interpolation=cv2.INTER_CUBIC)
    region = rgb[y0:y1, x0:x1]
    region[keep] = out[keep]


def clean_frame(finder, model, torch, rgb, options=None):
    """Find text anywhere, repaint it, look again; text still found where it was painted gets one more pass.
    Returns (cleaned image, info): boxes kept (x0, y0, x1, y1, why), boxes refused (why), residue, seconds."""
    started = time.time()
    options = {**DEFAULTS, **(options or {})}
    finder.configure(options)
    rgb = rgb.copy()
    h, w = rgb.shape[:2]
    grow = max(2, round(w / 640 * float(options['grow'])))
    context = max(48, round(w / 640 * float(options['context'])))
    passes = int(options['passes'])
    found, rejected = finder.find(rgb)
    painted = np.zeros((h, w), np.uint8)
    current = found
    for _pass in range(passes):
        if not current:
            break
        mask = text_mask(rgb.shape, current, grow)
        painted |= mask
        for rect in regions(mask, context):
            lama_fill(model, torch, rgb, mask, rect, scale=min(1.0, float(options['lama_width']) / w))
        again, _refused = finder.find(rgb)
        current = [item for item in again if _overlap(painted, item[0]) > 0.3]
    boxes = [[int(v) for v in (*np.floor(box.min(0)), *np.ceil(box.max(0)))] + [why] for box, _, why in found]
    return rgb, dict(boxes=boxes, rejected=[why for _, _, why in rejected], residue=bool(current), seconds=round(time.time() - started, 3))


def _overlap(mask, box):
    import cv2
    m = np.zeros_like(mask)
    cv2.fillPoly(m, [np.round(box).astype(np.int32)], 1)
    area = m.sum()
    return float((m & mask).sum()) / area if area else 0.0
