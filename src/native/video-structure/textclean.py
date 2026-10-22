"""Storyboard keyframes: find every piece of text anywhere in the frame (subtitles wherever they sit, name cards,
vertical captions, titles) with the PP-OCRv3 DB text detector through OpenCV, keep only boxes the PP-OCRv3 recognizer
can actually read as characters (the way PaddleOCR drops low-score boxes; striped patches, hair clips, eyes and
highlights read as nothing), repaint them with LaMa (only crops around the text), then look again; text still read
where it was painted gets a second pass. Without the recognizer, a stroke check decides instead."""
import time
import numpy as np

DET_MEAN = (122.67891434, 116.66876762, 104.00698793)
# Defaults; the app sends its own values with every job (so they can be tuned without rebuilding this runtime).
DEFAULTS = dict(binary=0.3, polygon=0.5, unclip=2.0, min_share=0.004, min_strokes=3, many_strokes=5, contrast=40,
                min_luma=90, light_background=140, context=96, lama_width=640, grow=3, passes=2,
                rec_min=0.55, rec_single=0.5, rec_stripy=0.85)
# What stripes, bars, edges and round highlights read as: such a reading only counts when the recognizer is very sure.
STRIPY = set('1lIi|!丨一二三川-_—=.:·,，。、\'"`~0oO○〇°')


class TextReader:
    """PP-OCRv3 recognizer (input pinned to 1x3x48x320 at build time so OpenCV DNN can run it) with its character list."""

    def __init__(self, path, keys):
        import cv2
        self.cv2 = cv2
        self.net = cv2.dnn.readNetFromONNX(path)
        with open(keys, encoding='utf-8') as handle:
            self.chars = [''] + handle.read().split('\n') + [' ']  # CTC blank first, space last (as PaddleOCR)

    def rectify(self, rgb, box):
        cv2 = self.cv2
        pts = np.array(box, np.float32)
        s = pts.sum(1)
        d = np.diff(pts, axis=1).ravel()
        tl, br, tr, bl = pts[np.argmin(s)], pts[np.argmax(s)], pts[np.argmin(d)], pts[np.argmax(d)]
        w = max(4, int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))))
        h = max(4, int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))))
        m = cv2.getPerspectiveTransform(np.array([tl, tr, br, bl], np.float32), np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32))
        return cv2.warpPerspective(rgb, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)

    def horizontal(self, crop):
        """Vertical text (name cards): cut into roughly square characters and lay them out left to right."""
        h, w = crop.shape[:2]
        if h < 1.5 * w:
            return crop
        n = max(1, int(round(h / w)))
        step = h / n
        return np.concatenate([self.cv2.resize(crop[int(i * step):int((i + 1) * step)], (w, w), interpolation=self.cv2.INTER_AREA) for i in range(n)], 1)

    def read_line(self, line):
        cv2 = self.cv2
        h, w = line.shape[:2]
        pieces = max(1, int(np.ceil(48 * w / h / 320)))  # the model reads at most 320 px wide at a time
        texts, confs = [], []
        for k in range(pieces):
            part = line[:, int(k * w / pieces):int((k + 1) * w / pieces)]
            pw = min(320, max(8, int(round(48 * part.shape[1] / h))))
            img = cv2.resize(part, (pw, 48), interpolation=cv2.INTER_AREA).astype(np.float32)[..., ::-1]  # RGB -> BGR
            blob = np.zeros((1, 3, 48, 320), np.float32)
            blob[0, :, :, :pw] = ((img / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)
            self.net.setInput(blob)
            probs = self.net.forward()[0]
            last = 0
            for i, p in zip(probs.argmax(1), probs.max(1)):
                if i != 0 and i != last and i < len(self.chars):
                    texts.append(self.chars[i])
                    confs.append(float(p))
                last = i
        return ''.join(texts).strip(), (float(np.mean(confs)) if confs else 0.0)

    def read(self, rgb, box):
        return self.read_line(self.horizontal(self.rectify(rgb, box)))


def readable(text, conf, options):
    core = [c for c in text if not c.isspace()]
    if not core:
        return False
    if all(c in STRIPY for c in core):
        return conf >= float(options['rec_stripy'])
    if len(core) == 1:
        return conf >= float(options['rec_single'])
    return conf >= float(options['rec_min'])


class TextFinder:
    def __init__(self, path, recognizer=None, keys=None):
        import cv2
        self.cv2 = cv2
        self.reader = TextReader(recognizer, keys) if recognizer and keys else None
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
        # The detector was trained on BGR (PaddleOCR reads with cv2); frames arrive as RGB, so swap.
        self.model.setInputParams(1.0 / 255.0, size, DET_MEAN, True)
        boxes, scores = self.model.detect(np.ascontiguousarray(rgb))
        return [np.array(b, np.float32) for b in boxes], [float(s) for s in scores]

    def looks_like_text(self, rgb, box):
        """Overlay text is a set of thin strokes: brighter (or, on a light background, darker) than the picture on both
        sides within a few pixels, and several separate strokes. Bright strokes must not be skin / orange tones.
        Ears, eyes, highlights and skin are refused. Returns (ok, reason)."""
        h, w = rgb.shape[:2]
        x0, y0 = np.maximum(np.floor(box.min(0)).astype(int), 0)
        x1, y1 = np.minimum(np.ceil(box.max(0)).astype(int), [w - 1, h - 1])
        if x1 - x0 < 6 or y1 - y0 < 6 or (x1 - x0) * (y1 - y0) > 0.3 * w * h:
            return False, 'size'
        options = getattr(self, 'options', DEFAULTS)
        crop = rgb[y0:y1 + 1, x0:x1 + 1].astype(np.float32)
        luma = 0.299 * crop[..., 0] + 0.587 * crop[..., 1] + 0.114 * crop[..., 2]
        # 笔画多粗跟字多大走：框（检测框比字大一圈）短边的 1/16 左右，至少 3 像素
        k, c = max(3, int(round(min(x1 - x0, y1 - y0) / 16))), float(options['contrast'])
        H, W = luma.shape
        directions = ((0, -1), (0, 1), (-1, 0), (1, 0))

        def side(channel, dy, dx, pick):
            pad = np.pad(channel, k, mode='edge')
            out = np.full_like(channel, 255.0 if pick is np.minimum else 0.0)
            for d in range(1, k + 1):
                out = pick(out, pad[k + dy * d:k + dy * d + H, k + dx * d:k + dx * d + W])
            return out

        def ridge(channel, pick, sign):
            # sign 1：比两边都高 c（亮笔画 / 更鲜艳的笔画）；sign -1：比两边都低 c（深色笔画）
            near = {d: side(channel, *d, pick) for d in directions}
            if sign > 0:
                return ((near[(0, -1)] <= channel - c) & (near[(0, 1)] <= channel - c)) | ((near[(-1, 0)] <= channel - c) & (near[(1, 0)] <= channel - c))
            return ((near[(0, -1)] >= channel + c) & (near[(0, 1)] >= channel + c)) | ((near[(-1, 0)] >= channel + c) & (near[(1, 0)] >= channel + c))

        r, g, b = crop[..., 0], crop[..., 1], crop[..., 2]
        sat = crop.max(-1) - crop.min(-1)
        gray = sat <= 60
        yellow = (r >= 120) & (g >= 100) & (b <= r - 40)
        skin = (r >= g) & (g >= b) & (g - b >= 15)  # skin, orange, brown
        colour = gray | yellow | ((sat > 60) & ~skin)  # gray-white, yellow / gold, red, blue, green...
        # 亮笔画（白字、灰字、黄字），或者比两边鲜艳得多的彩色笔画（红字、蓝字：亮度可能和背景差不多）
        bright = ridge(luma, np.minimum, 1) & colour & (luma >= float(options['min_luma']))
        vivid = ridge(sat, np.minimum, 1) & (sat >= 80) & ~skin
        strokes = bright | vivid

        def enough(mask, extra=0):
            share = float(mask.mean())
            count = TextFinder._components(mask)[0]
            ok = (share >= float(options['min_share']) and count >= int(options['min_strokes']) + extra) or (
                share >= float(options['min_share']) / 2 and count >= int(options['many_strokes']) + extra)
            return ok, f'share={share:.4f} strokes={count}'

        ok, info = enough(strokes)
        if ok:
            return True, f'text k={k} {info}'
        # 浅底深字（白底 / 黄底黑字的条幅、字卡）：背景要亮，笔画比两边都暗一截，而且要多几笔
        median = float(np.median(luma))
        if median >= float(options['light_background']):
            dark_ok, dark_info = enough(ridge(luma, np.maximum, -1), extra=2)
            if dark_ok:
                return True, f'dark k={k} {dark_info}'
            return False, f'not text k={k} {info}; dark {dark_info}'
        return False, f'not text k={k} {info}'

    @staticmethod
    def _components(mask):
        import cv2
        n, _ = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
        return n - 1, None

    def judge(self, rgb, box):
        """(ok, reason, text): with the recognizer, a box counts only when it reads as characters."""
        if self.reader is None:
            ok, why = self.looks_like_text(rgb, box)
            return ok, why, ''
        text, conf = self.reader.read(rgb, box)
        options = getattr(self, 'options', DEFAULTS)
        return readable(text, conf, options), f'read {text!r} {conf:.2f}', text

    def find(self, rgb):
        boxes, scores = self.raw(rgb)
        kept, rejected = [], []
        for box, score in zip(boxes, scores):
            ok, why, text = self.judge(rgb, box)
            (kept if ok else rejected).append((box, text, why))
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
    boxes = [[int(v) for v in (*np.floor(box.min(0)), *np.ceil(box.max(0)))] + [why, text] for box, text, why in found]
    return rgb, dict(boxes=boxes, rejected=[why for _, _, why in rejected], residue=bool(current), seconds=round(time.time() - started, 3))


def _overlap(mask, box):
    import cv2
    m = np.zeros_like(mask)
    cv2.fillPoly(m, [np.round(box).astype(np.int32)], 1)
    area = m.sum()
    return float((m & mask).sum()) / area if area else 0.0
