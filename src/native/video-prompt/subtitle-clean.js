'use strict';
// 分镜工程图四宫格关键帧去字幕：只处理这几张小图，视频本身不动，关键帧还是原来那一刻的那一帧。
//
// 1) 整集先抽十来帧（说话时刻和没人说话的空档对照），找出字幕所在的那一条横带（字幕位置一部剧基本固定）。
//    找不到说明这一集没有烧进画面的字幕，什么都不做。
// 2) 每张关键帧在这条横带里找出字幕（亮色字 + 深色描边 / 阴影），把整行字框起来，
//    用框上面、框下面真实的画面纹理一块一块补上（从上往下补一份、从下往上补一份，按高度渐变混合）。
// 3) 补完再找一次字：还找得到就算没去干净（画面校验里不写「无字幕水印」）。
// 全部在本机算，不调接口、不花钱，一张一秒左右。

const { spawn } = require('node:child_process');

const WORK_WIDTH = 640; // 在 640 宽上找字和补图，出图时再缩到页面用的大小

/** 跑 FFmpeg，可选把 input 写进 stdin，返回 stdout 的字节。 */
function ffmpegBuffer(ffmpeg, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const tail = Buffer.concat(err).toString('utf8').split('\n').filter(Boolean).slice(-2).join(' ');
      reject(new Error(`FFmpeg 失败：${tail || `退出码 ${code}`}`));
    });
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** 在 640 宽上处理时的尺寸（偶数）；读不到画幅返回 null。 */
function workSize(size) {
  if (!size?.width || !size?.height) return null;
  const width = Math.min(WORK_WIDTH, size.width - (size.width % 2));
  const height = Math.max(2, Math.round((width * size.height) / size.width / 2) * 2);
  return { width, height };
}

/** 抽一帧原始 RGB。 */
async function grabRaw(ffmpeg, inputPath, time, dims, signal) {
  const data = await ffmpegBuffer(
    ffmpeg,
    ['-v', 'error', '-ss', String(Math.max(0, time)), '-i', inputPath, '-frames:v', '1', '-vf', `scale=${dims.width}:${dims.height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    null,
    signal,
  );
  if (data.length !== dims.width * dims.height * 3) throw new Error('关键帧尺寸不对');
  return { width: dims.width, height: dims.height, data };
}

/** 原始 RGB → JPEG（缩到 outWidth 宽）。 */
function encodeJpeg(ffmpeg, image, outWidth, quality, signal) {
  return ffmpegBuffer(
    ffmpeg,
    ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${image.width}x${image.height}`, '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${outWidth},iw)':-2:flags=area`, '-q:v', String(quality), '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
    image.data,
    signal,
  );
}

// ===== 找字 =====

/** 字幕像素的颜色：白字（不太饱和）或黄字。 */
function isBright(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 170) return false;
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  return hi - lo <= 70 || (r >= 170 && g >= 150 && b <= 150);
}

/**
 * y0–y1 行里「亮色、而且旁边 radius 像素内有深色描边」的像素。
 * 返回 { mask, runs }：mask 是整图大小的 0/1，runs[y] 是这一行有多少段连续的候选像素（字的笔画多，段数就多）。
 */
function textCandidates(image, y0, y1, radius) {
  const { width: W, height: H, data } = image;
  const top = Math.max(0, y0 - radius);
  const bottom = Math.min(H - 1, y1 + radius);
  const rows = bottom - top + 1;
  // 深色像素，先横向、再纵向做最大值滤波 = 「附近有深色」
  const dark = new Uint8Array(W * rows);
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma <= 90) dark[(y - top) * W + x] = 1;
    }
  }
  const nearH = new Uint8Array(W * rows);
  for (let r = 0; r < rows; r++) {
    let last = -1e9;
    for (let x = 0; x < W; x++) {
      if (dark[r * W + x]) last = x;
      if (x - last <= radius) nearH[r * W + x] = 1;
    }
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) {
      if (dark[r * W + x]) last = x;
      if (last - x <= radius) nearH[r * W + x] = 1;
    }
  }
  // 亮像素的积分图：字幕是「细亮笔画 + 深色描边」，周围一圈亮的占不到六成；
  // 浅底深字（屏幕、招牌、白纸上的字）周围大多是亮的，不算。
  const bright = new Uint8Array(W * rows);
  for (let y = top; y <= bottom; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (isBright(data[i], data[i + 1], data[i + 2])) bright[(y - top) * W + x] = 1;
    }
  const integral = new Uint32Array((W + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let line = 0;
    for (let x = 0; x < W; x++) {
      line += bright[r * W + x];
      integral[(r + 1) * (W + 1) + x + 1] = integral[r * (W + 1) + x + 1] + line;
    }
  }
  const win = radius * 2;
  const brightShare = (x, r) => {
    const xa = Math.max(0, x - win);
    const xb = Math.min(W - 1, x + win);
    const ra = Math.max(0, r - win);
    const rb = Math.min(rows - 1, r + win);
    const sum =
      integral[(rb + 1) * (W + 1) + xb + 1] - integral[ra * (W + 1) + xb + 1] - integral[(rb + 1) * (W + 1) + xa] + integral[ra * (W + 1) + xa];
    return sum / ((xb - xa + 1) * (rb - ra + 1));
  };
  const mask = new Uint8Array(W * H);
  const runs = new Uint16Array(H);
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    let inRun = false;
    const r0 = y - top;
    for (let x = 0; x < W; x++) {
      let hit = false;
      if (bright[r0 * W + x]) {
        let near = 0;
        for (let dy = -radius; dy <= radius && !near; dy++) {
          const r = r0 + dy;
          if (r >= 0 && r < rows && nearH[r * W + x]) near = 1;
        }
        hit = !!near && brightShare(x, r0) < 0.6;
      }
      if (hit) {
        mask[y * W + x] = 1;
        if (!inRun) runs[y] += 1;
      }
      inRun = hit;
    }
  }
  return { mask, runs };
}

const MIN_RUNS = 6; // 一行里至少这么多段笔画才算「有字」
const radiusFor = (width) => Math.max(2, Math.round((width / WORK_WIDTH) * 3));

/**
 * 从几帧样本里找字幕横带，在画面 30%–97% 高度里找。
 * - 样本分「正在说话」和「没人说话」两组：字幕只在说话时出现，画面里本来就有的字（招牌、屏幕、静止的标识）
 *   两组都有，所以一行的分数 = 说话组里有字的比例 − 没说话组里有字的比例。
 * - 字幕每句不一样，画面里的字一直是那几个：说话组各帧在这条里的「字形」几乎一样的，不算字幕。
 * - 字幕左右居中：字的左右中点不在画面正中附近的，不算字幕。
 * 分数够高的行连成一条（两行字幕中间的行距也并进来）。返回 { y0, y1, height, frameHeight }，找不到返回 null。
 */
function findSubtitleBand(spokenImages, silentImages = []) {
  if (!spokenImages.length) return null;
  const { width: W, height: H } = spokenImages[0];
  const radius = radiusFor(W);
  const from = Math.floor(H * 0.3);
  const to = Math.floor(H * 0.97);
  const scan = (images) => images.map((image) => textCandidates(image, from, to, radius));
  const share = (scans) => {
    const hits = new Float32Array(H);
    for (const { runs } of scans) for (let y = from; y <= to; y++) if (runs[y] >= MIN_RUNS) hits[y] += 1;
    return hits.map((value) => value / Math.max(1, scans.length));
  };
  const spokenScans = scan(spokenImages);
  const spoken = share(spokenScans);
  const silent = silentImages.length >= 2 ? share(scan(silentImages)) : new Float32Array(H);
  const score = new Float32Array(H);
  const rows = [];
  // 至少两帧在这一行都看到字（样本少时一帧偶然像字不算）
  const least = Math.max(0.3, Math.min(1, 2 / spokenScans.length));
  for (let y = from; y <= to; y++) {
    score[y] = spoken[y] - silent[y];
    if (spoken[y] >= least - 1e-6 && score[y] >= 0.25) rows.push(y);
  }
  if (rows.length < Math.max(3, H * 0.008)) return null;
  // 连成段：缝隙不超过 2% 画面高（行距）
  const gap = Math.max(3, Math.round(H * 0.02));
  const groups = [];
  for (const y of rows) {
    const last = groups.at(-1);
    if (last && y - last.y1 <= gap) last.y1 = y;
    else groups.push({ y0: y, y1: y, score: 0 });
  }
  for (const group of groups) for (let y = group.y0; y <= group.y1; y++) group.score += score[y];
  // 字形一样不一样：说话组两两比这条里的候选像素重合度（交集 / 并集），平均超过 0.6 就是画面里本来的字
  const sameShape = (group) => {
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < spokenScans.length; i++)
      for (let j = i + 1; j < spokenScans.length; j++) {
        const a = spokenScans[i].mask;
        const b = spokenScans[j].mask;
        let both = 0;
        let either = 0;
        for (let p = group.y0 * W; p < (group.y1 + 1) * W; p++) {
          if (a[p] && b[p]) both += 1;
          if (a[p] || b[p]) either += 1;
        }
        if (either < W * 0.5) continue; // 有一帧这条里几乎没字，不比
        total += both / either;
        pairs += 1;
      }
    return pairs ? total / pairs : 0;
  };
  // 字幕是左右居中的：说话组各帧这条里字的左右中点都在画面正中附近（画面里的字多半靠一边）
  const centered = (group) => {
    const centers = [];
    for (const { mask } of spokenScans) {
      let minX = W;
      let maxX = -1;
      for (let y = group.y0; y <= group.y1; y++)
        for (let x = 0; x < W; x++)
          if (mask[y * W + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
      if (maxX - minX > W * 0.08) centers.push((minX + maxX) / 2 / W);
    }
    if (!centers.length) return false;
    centers.sort((a, b) => a - b);
    return Math.abs(centers[Math.floor(centers.length / 2)] - 0.5) <= 0.08;
  };
  const candidates = groups
    .filter((group) => {
      const height = group.y1 - group.y0 + 1;
      return height >= H * 0.012 && height <= H * 0.1; // 字幕一两行，最多占画面高的一成
    })
    .sort((a, b) => b.score - a.score);
  const best = candidates.find((group) => centered(group) && sameShape(group) < 0.6);
  if (!best) return null;
  return { y0: best.y0, y1: best.y1, height: best.y1 - best.y0 + 1, frameHeight: H };
}

// ===== 补图 =====

/** 把 mask 膨胀 radius 像素（方形）。 */
function dilate(mask, W, H, radius) {
  const horizontal = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let last = -1e9;
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) last = x;
      if (x - last <= radius) horizontal[y * W + x] = 1;
    }
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) {
      if (mask[y * W + x]) last = x;
      if (last - x <= radius) horizontal[y * W + x] = 1;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let last = -1e9;
    for (let y = 0; y < H; y++) {
      if (horizontal[y * W + x]) last = y;
      if (y - last <= radius) out[y * W + x] = 1;
    }
    last = 1e9;
    for (let y = H - 1; y >= 0; y--) {
      if (horizontal[y * W + x]) last = y;
      if (last - y <= radius) out[y * W + x] = 1;
    }
  }
  return out;
}

/**
 * 一张图横带里字幕笔画要盖住的像素（含描边和外面一圈虚边）。band 按 frameHeight 高的图给出，会换算到这张图。
 * 这一帧横带里没有字（这一刻没台词）、或者满画面花纹，返回 null。
 */
function subtitleCover(image, band) {
  const { width: W, height: H } = image;
  const scale = H / (band.frameHeight || H);
  const pad = Math.round(band.height * scale * 0.3) + 2;
  const y0 = Math.max(0, Math.round(band.y0 * scale) - pad);
  const y1 = Math.min(H - 1, Math.round(band.y1 * scale) + pad);
  const radius = radiusFor(W);
  // 横带上方同样高的一条做对照：草地、树叶、闪光这类花纹满画面都是，对照那条也一样「像字」，就不是字幕
  const refTop = Math.max(0, y0 - (y1 - y0 + 1) * 2);
  const { mask, runs } = textCandidates(image, refTop, y1, radius);
  const textRows = [];
  let bandRuns = 0;
  for (let y = y0; y <= y1; y++) {
    bandRuns += runs[y];
    if (runs[y] >= MIN_RUNS) textRows.push(y);
  }
  if (textRows.length < Math.max(3, (y1 - y0) * 0.12)) return null;
  let refRuns = 0;
  let refRows = 0;
  for (let y = refTop; y < y0 - radius; y++) {
    refRuns += runs[y];
    refRows += 1;
  }
  if (refRows && bandRuns / (y1 - y0 + 1) < (refRuns / refRows) * 2.5 + 1) return null;
  // 只留有字的那几行附近、字的左右范围里的候选，别的亮边（白衣服、窗户）不碰
  const rowTop = Math.max(y0, textRows[0] - radius);
  const rowBottom = Math.min(y1, textRows.at(-1) + radius);
  const xs = [];
  for (const y of textRows) for (let x = 0; x < W; x++) if (mask[y * W + x]) xs.push(x);
  xs.sort((a, b) => a - b);
  const xLeft = Math.max(0, xs[Math.floor(xs.length * 0.01)] - radius * 2);
  const xRight = Math.min(W - 1, xs[Math.floor(xs.length * 0.99)] + radius * 2);
  const kept = new Uint8Array(W * H);
  for (let y = rowTop; y <= rowBottom; y++)
    for (let x = xLeft; x <= xRight; x++) if (mask[y * W + x]) kept[y * W + x] = 1;
  // 粗笔画的字（「等」「懂」这种）中间亮的一大块，周围亮的占比高，上面没算进候选：紧挨着已找到的字、又是亮色的像素也算
  const zone = dilate(kept, W, H, radius * 2);
  const { data } = image;
  for (let y = rowTop; y <= rowBottom; y++)
    for (let x = xLeft; x <= xRight; x++) {
      const p = y * W + x;
      if (!kept[p] && zone[p] && isBright(data[p * 3], data[p * 3 + 1], data[p * 3 + 2])) kept[p] = 1;
    }
  // 描边和外面那圈发虚的暗边也要盖住
  return dilate(kept, W, H, radius + 2);
}

// ===== 本地补图：用旁边真实的纹理块补（不是从四周抹匀）=====

/**
 * 样本块补图（Criminisi 一类做法的简化版）：从外往里，一块一块地补。每次在要补的地方周围（search 像素内）
 * 找一块和它已知部分最像的、完全没被字盖住的真实画面（树皮、衣服、背景），把这块的像素抄过来。
 * 找的时候稍微偏向近处的块，免得从远处抄来不相干的东西。补出来是真实纹理，不会是一团糊。原地修改，返回补了多少像素。
 */
function patchInpaint(image, mask, { patch = 7, search = 30, direction = 'both' } = {}) {
  const { width: W, height: H, data } = image;
  const half = patch >> 1;
  const known = new Uint8Array(W * H);
  let todo = 0;
  let minX = W;
  let maxX = -1;
  let minY = H;
  let maxY = -1;
  for (let p = 0; p < W * H; p++) {
    if (mask[p]) {
      todo += 1;
      const x = p % W;
      const y = (p - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else known[p] = 1;
  }
  if (!todo) return 0;
  const total = todo;
  // 上下要能够到框外面：竖着找的范围至少到框高的一半再多一点；横着按 search
  const searchX = search;
  const searchY = Math.max(search, Math.ceil((maxY - minY + 1) / 2) + half + 4);
  // 能当样本的块：整块都在画面里、一个像素都没被字盖住（用原来的遮罩算）
  const sx0 = Math.max(half, minX - searchX - half);
  const sx1 = Math.min(W - 1 - half, maxX + searchX + half);
  const sy0 = Math.max(half, minY - searchY - half);
  const sy1 = Math.min(H - 1 - half, maxY + searchY + half);
  const bw = sx1 - sx0 + 1 + patch;
  const bh = sy1 - sy0 + 1 + patch;
  const ox = sx0 - half;
  const oy = sy0 - half;
  const integral = new Int32Array((bw + 1) * (bh + 1));
  for (let y = 0; y < bh; y++) {
    let row = 0;
    for (let x = 0; x < bw; x++) {
      const gx = ox + x;
      const gy = oy + y;
      row += gx >= 0 && gy >= 0 && gx < W && gy < H && mask[gy * W + gx] ? 1 : 0;
      integral[(y + 1) * (bw + 1) + x + 1] = integral[y * (bw + 1) + x + 1] + row;
    }
  }
  const cleanSource = (cx, cy) => {
    const x0 = cx - half - ox;
    const y0 = cy - half - oy;
    const x1 = x0 + patch;
    const y1 = y0 + patch;
    return integral[y1 * (bw + 1) + x1] - integral[y0 * (bw + 1) + x1] - integral[y1 * (bw + 1) + x0] + integral[y0 * (bw + 1) + x0] === 0;
  };
  const confidence = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) if (known[p]) confidence[p] = 1;
  // direction：both 四周往里；down 只从上往下长（这一点的正上方已知才补）；up 只从下往上长
  const onFront = (p) => {
    const x = p % W;
    const y = (p - x) / W;
    if (direction === 'down') return y > 0 && known[p - W] === 1;
    if (direction === 'up') return y < H - 1 && known[p + W] === 1;
    return (x > 0 && known[p - 1]) || (x < W - 1 && known[p + 1]) || (y > 0 && known[p - W]) || (y < H - 1 && known[p + W]);
  };
  while (todo > 0) {
    const before = todo;
    // 这一圈边上的点，按「周围已知的多不多」排：已知多的先补，补得准
    const front = [];
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const p = y * W + x;
        if (known[p] || !onFront(p)) continue;
        let c = 0;
        for (let dy = -half; dy <= half; dy++)
          for (let dx = -half; dx <= half; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H) c += confidence[ny * W + nx];
          }
        front.push({ p, c: c / (patch * patch) });
      }
    if (!front.length) break;
    front.sort((a, b) => b.c - a.c);
    for (const { p, c } of front) {
      if (known[p]) continue;
      const px = p % W;
      const py = (p - px) / W;
      // 找最像的样本块（只比目标块里已知的像素），近处的稍微占便宜
      let best = Infinity;
      let bx = -1;
      let by = -1;
      const qx0 = Math.max(sx0, px - searchX);
      const qx1 = Math.min(sx1, px + searchX);
      const qy0 = Math.max(sy0, py - searchY);
      const qy1 = Math.min(sy1, py + searchY);
      for (let qy = qy0; qy <= qy1; qy++)
        for (let qx = qx0; qx <= qx1; qx++) {
          if (!cleanSource(qx, qy)) continue;
          let ssd = ((qx - px) * (qx - px) + (qy - py) * (qy - py)) * 2;
          for (let dy = -half; dy <= half && ssd < best; dy++) {
            const ty = py + dy;
            if (ty < 0 || ty >= H) continue;
            for (let dx = -half; dx <= half; dx++) {
              const tx = px + dx;
              if (tx < 0 || tx >= W) continue;
              const t = ty * W + tx;
              if (!known[t]) continue;
              const q = ((qy + dy) * W + qx + dx) * 3;
              const a = data[t * 3] - data[q];
              const b = data[t * 3 + 1] - data[q + 1];
              const d = data[t * 3 + 2] - data[q + 2];
              ssd += a * a + b * b + d * d;
            }
          }
          if (ssd < best) {
            best = ssd;
            bx = qx;
            by = qy;
          }
        }
      if (bx < 0) continue;
      for (let dy = -half; dy <= half; dy++) {
        const ty = py + dy;
        if (ty < 0 || ty >= H) continue;
        for (let dx = -half; dx <= half; dx++) {
          const tx = px + dx;
          if (tx < 0 || tx >= W) continue;
          const t = ty * W + tx;
          if (known[t]) continue;
          const q = ((by + dy) * W + bx + dx) * 3;
          data[t * 3] = data[q];
          data[t * 3 + 1] = data[q + 1];
          data[t * 3 + 2] = data[q + 2];
          known[t] = 1;
          confidence[t] = c;
          todo -= 1;
        }
      }
    }
    if (todo === before) break; // 这一圈一个都没补上（附近找不到干净的样本块）：别再转了
  }
  // 万一还剩（画面边上、整片都被盖住）：剩下的用四周的颜色补上，不留原来的字
  if (todo > 0) {
    const rest = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) if (!known[p]) rest[p] = 1;
    fillFromNeighbors(image, rest);
  }
  return total;
}

/** 从四周往里一圈圈用已知邻居的平均补满（只给样本块补不到的零星像素兜底）。 */
function fillFromNeighbors(image, mask) {
  const { width: W, height: H, data } = image;
  const known = new Uint8Array(W * H);
  let pending = [];
  for (let p = 0; p < W * H; p++) {
    if (mask[p]) pending.push(p);
    else known[p] = 1;
  }
  while (pending.length) {
    const ready = [];
    const waiting = [];
    for (const p of pending) {
      const x = p % W;
      const y = (p - x) / W;
      let n = 0;
      const sum = [0, 0, 0];
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !known[ny * W + nx]) continue;
        for (let c = 0; c < 3; c++) sum[c] += data[(ny * W + nx) * 3 + c];
        n += 1;
      }
      if (n) ready.push([p, sum.map((v) => v / n)]);
      else waiting.push(p);
    }
    if (!ready.length) break;
    for (const [p, value] of ready) {
      for (let c = 0; c < 3; c++) data[p * 3 + c] = value[c];
      known[p] = 1;
    }
    pending = waiting;
  }
}

/**
 * 字幕整行的框：有字的那几行 + 字的左右范围，再往外扩一点（上下各 4 像素加两成行高，左右各半个字宽），
 * 两头整个字都在白衣服上认不出来的也盖得住。
 */
function lineBox(cover, W, H, image = null) {
  let minX = W;
  let maxX = -1;
  let minY = H;
  let maxY = -1;
  for (let p = 0; p < W * H; p++)
    if (cover[p]) {
      const x = p % W;
      const y = (p - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  if (maxX < 0) return null;
  const lineHeight = maxY - minY + 1;
  const padY = 4 + Math.round(lineHeight * 0.2);
  const padX = Math.round(Math.min(lineHeight, 60) * 0.5);
  const box = new Uint8Array(W * H);
  const x0 = Math.max(0, minX - padX);
  const x1 = Math.min(W - 1, maxX + padX);
  let y0 = Math.max(0, minY - padY);
  let y1 = Math.min(H - 1, maxY + padY);
  if (image) {
    // 往上下扩的时候碰到一条明显的横边（桌沿、画框、衣服下摆）就停在它前面，别把它框进来、补的时候抄成条纹
    const { data } = image;
    const luma = (x, y) => 0.299 * data[(y * W + x) * 3] + 0.587 * data[(y * W + x) * 3 + 1] + 0.114 * data[(y * W + x) * 3 + 2];
    const edgeAt = (y) => {
      if (y < 1 || y > H - 2) return 0;
      let sum = 0;
      for (let x = x0; x <= x1; x++) sum += Math.abs(luma(x, y + 1) - luma(x, y - 1));
      return sum / (x1 - x0 + 1);
    };
    const near = [];
    for (let y = Math.max(1, minY - padY * 3); y <= Math.min(H - 2, maxY + padY * 3); y++) if (y < minY - 1 || y > maxY + 1) near.push(edgeAt(y));
    near.sort((a, b) => a - b);
    const typical = near.length ? near[Math.floor(near.length / 2)] : 0;
    const strong = Math.max(10, typical * 4);
    for (let y = minY - 2; y >= minY - padY && y >= 1; y--)
      if (edgeAt(y) > strong) {
        y0 = Math.min(minY - 2, y + 2);
        break;
      }
    for (let y = maxY + 2; y <= maxY + padY && y <= H - 2; y++)
      if (edgeAt(y) > strong) {
        y1 = Math.max(maxY + 2, y - 2);
        break;
      }
  }
  for (let y = y0; y <= y1; y++) box.fill(1, y * W + x0, y * W + x1 + 1);
  return { box, x0, x1, y0, y1 };
}

/**
 * 补字幕整行的框：从上往下补一份、从下往上补一份，再按高度渐变混在一起——框的上半部分接着框上面的画面，
 * 下半部分接着框下面的画面，中间慢慢过渡，不会有上下两边碰头的那条横线。原地修改。
 */
function fillBox(image, lb) {
  const { width: W, data } = image;
  const down = { ...image, data: Buffer.from(data) };
  const up = { ...image, data: Buffer.from(data) };
  patchInpaint(down, lb.box, { patch: 7, search: 32, direction: 'down' });
  patchInpaint(up, lb.box, { patch: 7, search: 32, direction: 'up' });
  const h = lb.y1 - lb.y0;
  for (let y = lb.y0; y <= lb.y1; y++) {
    const t0 = h ? (y - lb.y0) / h : 0.5;
    const t = t0 * t0 * (3 - 2 * t0); // 两头平缓
    for (let x = lb.x0; x <= lb.x1; x++) {
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(down.data[i + c] * (1 - t) + up.data[i + c] * t);
    }
  }
}

/**
 * 补字幕整行的框（不抄纹理块）：每一列从框上沿的颜色渐变到框下沿的颜色（上下各取 3 行平均、左右稍微抹匀），
 * 竖着的线条（领口、树干、门框）能接上，也不会把框边上的东西一块块抄进来变成一道道条纹；
 * 再把框正上方、正下方原画面的细颗粒（减掉平滑后剩下的那点）按高度渐变叠回去，看着还是原片的质感，不是一块糊。原地修改。
 */
function blendBox(image, { x0, x1, y0, y1 }) {
  const { width: W, height: H, data } = image;
  const h = y1 - y0 + 1;
  const w = x1 - x0 + 1;
  const rows = 3;
  const edge = (from, step) => {
    const out = new Float32Array(w * 3);
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let k = 0; k < rows; k++) {
          const y = from + step * k;
          if (y < 0 || y >= H) continue;
          sum += data[(y * W + x0 + x) * 3 + c];
          n += 1;
        }
        out[x * 3 + c] = n ? sum / n : 128;
      }
    // 左右抹匀一点，免得一列一列的噪点变成竖条
    const smooth = new Float32Array(w * 3);
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let k = -2; k <= 2; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          sum += out[xx * 3 + c];
          n += 1;
        }
        smooth[x * 3 + c] = sum / n;
      }
    return smooth;
  };
  const top = edge(y0 - 1, -1);
  const bottom = edge(y1 + 1, 1);
  // 细颗粒：从框正上方 / 正下方同样高的一块里取「原像素 − 3×3 平均」
  const grain = (offset) => (x, y) => {
    const yy = y + offset;
    if (yy < 1 || yy >= H - 1) return [0, 0, 0];
    const result = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(W - 1, x + dx));
          sum += data[((yy + dy) * W + xx) * 3 + c];
        }
      result[c] = data[(yy * W + x) * 3 + c] - sum / 9;
    }
    // 颗粒只要细小的起伏：大的（某条边、某根线）不是颗粒，不往框里搬
    if (Math.max(Math.abs(result[0]), Math.abs(result[1]), Math.abs(result[2])) > 18) return [0, 0, 0];
    return result;
  };
  const above = grain(-h);
  const below = grain(h);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const t0 = h > 1 ? y / (h - 1) : 0.5;
    const t = t0 * t0 * (3 - 2 * t0);
    for (let x = 0; x < w; x++) {
      const ga = above(x0 + x, y0 + y);
      const gb = below(x0 + x, y0 + y);
      for (let c = 0; c < 3; c++) {
        const base = top[x * 3 + c] * (1 - t) + bottom[x * 3 + c] * t;
        out[(y * w + x) * 3 + c] = base + ga[c] * (1 - t) + gb[c] * t;
      }
    }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) data[((y0 + y) * W + x0 + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(out[(y * w + x) * 3 + c])));
}

/**
 * 字幕整行的框：两种补法都做一遍——抄真实纹理块（fillBox，纹理最自然，但框边上紧挨着一条横线时会抄出一道道条纹）
 * 和按列渐变加原片颗粒（blendBox，不会出条纹，但复杂纹理处会有竖着的抹痕）。
 * 再按 24 像素宽一条一条比：哪种补出来的「横竖纹理多少」和框上下真实画面最接近就用哪种，条和条之间渐变着接。原地修改。
 */
function cleanBox(image, lb) {
  const { width: W, height: H, data } = image;
  const patchFill = { ...image, data: Buffer.from(data) };
  const blendFill = { ...image, data: Buffer.from(data) };
  fillBox(patchFill, lb);
  blendBox(blendFill, lb);
  const h = lb.y1 - lb.y0 + 1;
  const luma = (buf, x, y) => 0.299 * buf[(y * W + x) * 3] + 0.587 * buf[(y * W + x) * 3 + 1] + 0.114 * buf[(y * W + x) * 3 + 2];
  // 一行（xa–xb）上下方向的平均起伏：一条横线在这里会特别大
  const rowEdge = (buf, xa, xb, y) => {
    if (y < 1 || y > H - 2) return 0;
    let sum = 0;
    // 和上一行、下一行各比一次取大的：一像素宽的细条纹（上下两行颜色一样）也量得出来
    for (let x = xa; x <= xb; x++) {
      const here = luma(buf, x, y);
      sum += Math.max(Math.abs(luma(buf, x, y + 1) - here), Math.abs(here - luma(buf, x, y - 1)));
    }
    return sum / (xb - xa + 1);
  };
  const STRIP = 24;
  const choice = [];
  for (let xa = lb.x0; xa <= lb.x1; xa += STRIP) {
    const xb = Math.min(lb.x1, xa + STRIP - 1);
    // 框上下真实画面每一行的起伏取中位数（上面紧挨着一条横边也不会把它带偏）
    const context = [];
    for (let y = lb.y0 - h; y <= lb.y0 - 2; y++) context.push(rowEdge(data, xa, xb, y));
    for (let y = lb.y1 + 2; y <= lb.y1 + h; y++) context.push(rowEdge(data, xa, xb, y));
    context.sort((p, q) => p - q);
    const typical = context.length ? context[Math.floor(context.length / 2)] : 0;
    // 抄纹理块补出来的这一条里，起伏特别大（比四周平常的大 4 倍以上）的行有几行：三行以上就是抄出了条纹，这一条改用渐变
    let striped = 0;
    for (let y = lb.y0; y <= lb.y1; y++) if (rowEdge(patchFill.data, xa, xb, y) > Math.max(12, typical * 4)) striped += 1;
    choice.push(striped >= 3 ? 0 : 1); // 1 = 抄纹理块
  }
  // 每一列用抄纹理块的比例：条中间按这一条的选择，靠近相邻条的 8 像素渐变过去
  for (let x = lb.x0; x <= lb.x1; x++) {
    const k = Math.min(choice.length - 1, Math.floor((x - lb.x0) / STRIP));
    const into = (x - lb.x0) % STRIP;
    let weight = choice[k];
    if (into < 8 && k > 0) weight = choice[k - 1] + (choice[k] - choice[k - 1]) * ((into + 0.5) / 8);
    for (let y = lb.y0; y <= lb.y1; y++) {
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(patchFill.data[i + c] * weight + blendFill.data[i + c] * (1 - weight));
    }
  }
  return choice;
}

/** 任意图片字节 → width×height 的原始 RGB。 */
async function decodeRaw(ffmpeg, bytes, width, height, signal) {
  const data = await ffmpegBuffer(
    ffmpeg,
    ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    bytes,
    signal,
  );
  if (data.length !== width * height * 3) throw new Error('图片尺寸不对');
  return data;
}

/**
 * 抽一张关键帧并去字幕，按 sizes（[{ width, quality }]）各出一张 JPEG（四宫格用 320 宽；起幅那张顺便出 560 宽给视频首帧）。
 * 返回 { outputs: [字节…], cleaned, clean, reason }：
 *   cleaned 补过字幕；clean 最后这张图里检测不到字幕；reason：'none' 这一刻没字幕 / 'residue' 补完还检测到字。
 */
async function cleanKeyframe({ ffmpeg, inputPath, time, band, dims, sizes, signal }) {
  const original = await grabRaw(ffmpeg, inputPath, time, dims, signal);
  const cover = subtitleCover(original, band);
  let image = original;
  let cleaned = false;
  let clean = true;
  let reason = 'none';
  if (cover) {
    const lb = lineBox(cover, original.width, original.height, original);
    if (lb) {
      image = { ...original, data: Buffer.from(original.data) };
      cleanBox(image, lb);
      cleaned = true;
      clean = !subtitleCover(image, band);
      reason = clean ? '' : 'residue';
    }
  }
  const outputs = [];
  for (const size of sizes) {
    const bytes = await encodeJpeg(ffmpeg, image, size.width, size.quality, signal);
    if (bytes.length < 100) throw new Error('关键帧编码失败');
    outputs.push(bytes);
  }
  return { outputs, cleaned, clean, reason };
}

/** 从列表里均匀挑最多 count 个。 */
function spread(list, count) {
  const n = Math.min(count, list.length);
  return Array.from({ length: n }, (_, k) => list[Math.floor(((k + 0.5) * list.length) / n)]);
}

/**
 * 挑样本时间：有逐句时间（utterances）时，「说话」取每句中间，「没说话」取两句之间空出 0.6 秒以上的空档中间；
 * 没有逐句时间就按分镜（有台词 / 没台词）取分镜中间。只在要分析的分镜范围里挑。
 */
function sampleTimes(rows, utterances) {
  const start = rows[0].start;
  const end = rows.at(-1).end;
  const lines = (Array.isArray(utterances) ? utterances : [])
    .map((u) => ({ start: Number(u.start), end: Number(u.end), text: String(u.text || '').trim() }))
    .filter((u) => u.text && Number.isFinite(u.start) && Number.isFinite(u.end) && u.end > u.start && u.end > start && u.start < end)
    .sort((a, b) => a.start - b.start);
  if (lines.length) {
    const spoken = lines.map((u) => (Math.max(u.start, start) + Math.min(u.end, end)) / 2);
    const silent = [];
    let cursor = start;
    for (const u of [...lines, { start: end, end }]) {
      if (u.start - cursor >= 0.6) silent.push((cursor + u.start) / 2);
      cursor = Math.max(cursor, u.end);
    }
    return { spoken, silent };
  }
  const mid = (row) => (row.start + row.end) / 2;
  return { spoken: rows.filter((row) => row.dialogue?.length).map(mid), silent: rows.filter((row) => !row.dialogue?.length).map(mid) };
}

/**
 * 整集找字幕横带：说话的时刻抽最多 10 帧、没人说话的时刻抽最多 6 帧做对照（都均匀挑）。
 * 返回 { band, dims }，没字幕时 band 为 null。
 */
async function detectEpisodeBand({ ffmpeg, inputPath, rows, utterances, size, signal }) {
  const dims = workSize(size);
  if (!dims || !rows?.length) return { band: null, dims };
  const grab = async (times) => {
    const images = [];
    for (const time of times) {
      signal?.throwIfAborted?.();
      try {
        images.push(await grabRaw(ffmpeg, inputPath, time, dims, signal));
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return images;
  };
  const { spoken, silent } = sampleTimes(rows, utterances);
  if (!spoken.length) return { band: null, dims }; // 整集没台词，就没有字幕
  const band = findSubtitleBand(await grab(spread(spoken, 10)), await grab(spread(silent, 6)));
  return { band, dims };
}

module.exports = {
  WORK_WIDTH,
  workSize,
  grabRaw,
  encodeJpeg,
  decodeRaw,
  textCandidates,
  findSubtitleBand,
  sampleTimes,
  subtitleCover,
  patchInpaint,
  lineBox,
  fillBox,
  blendBox,
  cleanBox,
  detectEpisodeBand,
  cleanKeyframe,
};
