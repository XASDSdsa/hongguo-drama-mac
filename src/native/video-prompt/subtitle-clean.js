'use strict';
// 分镜工程图四宫格关键帧去字幕：只处理这几张小图，视频本身不动，关键帧还是原来那一刻的那一帧。
//
// 1) 整集先抽十来帧（说话时刻和没人说话的空档对照），找出字幕所在的那一条横带（字幕位置一部剧基本固定）。
//    找不到说明这一集没有烧进画面的字幕，什么都不做。
// 2) 每张关键帧在这条横带里找出字幕笔画（亮色字 + 深色描边），截字幕附近的一块方图交给作图模型去字，
//    回来的图只取字幕笔画那一点像素、边缘柔化后贴回原帧；其余像素一个不动。
// 3) 作图模型没配、调用失败、或者回来的图和原图对不齐（模型改了构图）：保留原图（带字幕），不出半成品。

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

// ===== 交给作图模型、贴回原帧 =====

/** 原始 RGB / RGBA → PNG（可以顺便缩放到 outSize×outSize）。 */
function encodePng(ffmpeg, data, width, height, pixFmt, outSize, signal) {
  const scale = outSize ? ['-vf', `scale=${outSize}:${outSize}:flags=lanczos`] : [];
  return ffmpegBuffer(
    ffmpeg,
    ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${width}x${height}`, '-i', 'pipe:0', ...scale, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
    data,
    signal,
  );
}

/** 任意图片字节 → width×height 的原始 RGB。 */
async function decodeRaw(ffmpeg, bytes, width, height, signal) {
  const data = await ffmpegBuffer(
    ffmpeg,
    ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    bytes,
    signal,
  );
  if (data.length !== width * height * 3) throw new Error('作图结果尺寸不对');
  return data;
}

/** 截字幕附近的一块方图：边长 = 图的短边，字幕在方图中间（靠边时贴边）。 */
function squareAround(cover, W, H) {
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
  const side = Math.min(W, H);
  const left = Math.max(0, Math.min(W - side, Math.round((minX + maxX) / 2 - side / 2)));
  const top = Math.max(0, Math.min(H - side, Math.round((minY + maxY) / 2 - side / 2)));
  return { left, top, side };
}

function cropRgb(image, { left, top, side }) {
  const out = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) image.data.copy(out, y * side * 3, ((top + y) * image.width + left) * 3, ((top + y) * image.width + left + side) * 3);
  return out;
}

/** 3×3 盒式模糊 passes 遍，把 0/1 的盖住区域变成边缘柔和的 0–1。 */
function softAlpha(cover, W, H, passes) {
  let alpha = Float32Array.from(cover);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            sum += alpha[ny * W + nx];
            n += 1;
          }
        next[y * W + x] = sum / n;
      }
    alpha = next;
  }
  for (let p = 0; p < W * H; p++) if (cover[p]) alpha[p] = 1; // 字本身一定全换掉
  return alpha;
}

/**
 * 把作图模型回来的方图贴回原帧：只换字幕笔画那一点（边缘柔化），其余像素不动。
 * 先用字幕四周一圈（没被字盖住的地方）对齐两张图的整体颜色；这一圈差得太多说明模型改了构图，返回 false 不贴。
 */
function pasteBack(image, cover, region, ai) {
  const { width: W, data } = image;
  const { left, top, side } = region;
  const local = new Uint8Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) local[y * side + x] = cover[(top + y) * W + left + x];
  const outer = dilate(local, side, side, 6);
  const inner = dilate(local, side, side, 2);
  const sum = [0, 0, 0];
  let count = 0;
  for (let p = 0; p < side * side; p++) {
    if (!outer[p] || inner[p]) continue;
    const q = ((top + Math.floor(p / side)) * W + left + (p % side)) * 3;
    for (let c = 0; c < 3; c++) sum[c] += ai[p * 3 + c] - data[q + c];
    count += 1;
  }
  if (count < 50) return false;
  const offset = sum.map((v) => v / count);
  let mad = 0;
  for (let p = 0; p < side * side; p++) {
    if (!outer[p] || inner[p]) continue;
    const q = ((top + Math.floor(p / side)) * W + left + (p % side)) * 3;
    for (let c = 0; c < 3; c++) mad += Math.abs(ai[p * 3 + c] - offset[c] - data[q + c]);
  }
  if (mad / count / 3 > 14) return false;
  const alpha = softAlpha(dilate(local, side, side, 1), side, side, 2);
  for (let p = 0; p < side * side; p++) {
    const a = alpha[p];
    if (a <= 0.003) continue;
    const q = ((top + Math.floor(p / side)) * W + left + (p % side)) * 3;
    for (let c = 0; c < 3; c++) {
      const value = Math.max(0, Math.min(255, ai[p * 3 + c] - offset[c]));
      data[q + c] = Math.round(data[q + c] * (1 - a) + value * a);
    }
  }
  return true;
}

const ERASE_PROMPT = [
  '这是短剧画面里字幕附近的一块截图。',
  '只去掉画面里烧进去的字幕文字（亮色的字和它的深色描边），把字后面被挡住的画面按周围的样子自然补全。',
  '其他所有内容——人物、脸、手、衣服、背景、光线、颜色、清晰度、构图和位置——都保持完全不变，不要移动或重画任何东西，不要加任何文字、水印或新东西。',
].join('\n');
const SEND_SIZE = 1024;

/**
 * 抽一张关键帧并去字幕。erase({ image, mask, prompt, signal }) → 图片字节（作图模型）；不给 erase 就只检查不去。
 * 去完再在字幕那一条里找一次字：还有就重新去一次；两次都不干净就保留原图。
 * 返回 { bytes, cleaned, clean, reason }：
 *   cleaned 去过字幕；clean 最后这张图里没检测到字幕；
 *   reason 没去成的原因：'none' 这一刻没字幕 / 'noEraser' 没配作图模型 / 'mismatch' 对不齐 / 'residue' 去完还有字 / 'failed' 调用失败。
 */
async function aiCleanFrame({ ffmpeg, inputPath, time, band, dims, outWidth, quality, erase, signal, retryWithinMs = 60000 }) {
  const original = await grabRaw(ffmpeg, inputPath, time, dims, signal);
  const cover = subtitleCover(original, band);
  let image = original;
  let cleaned = false;
  let reason = cover ? (erase ? '' : 'noEraser') : 'none';
  if (cover && erase) {
    const region = squareAround(cover, original.width, original.height);
    const crop = cropRgb(original, region);
    const maskRgba = Buffer.alloc(region.side * region.side * 4, 255);
    const editArea = dilate(
      Uint8Array.from({ length: region.side * region.side }, (_, p) => cover[(region.top + Math.floor(p / region.side)) * original.width + region.left + (p % region.side)]),
      region.side,
      region.side,
      3,
    );
    for (let p = 0; p < editArea.length; p++) if (editArea[p]) maskRgba[p * 4 + 3] = 0; // 透明 = 要改
    try {
      const [png, mask] = await Promise.all([
        encodePng(ffmpeg, crop, region.side, region.side, 'rgb24', SEND_SIZE, signal),
        encodePng(ffmpeg, maskRgba, region.side, region.side, 'rgba', SEND_SIZE, signal),
      ]);
      const started = Date.now();
      for (let attempt = 1; attempt <= 2 && !cleaned; attempt++) {
        if (attempt > 1 && Date.now() - started > retryWithinMs) break; // 第一次就很慢，不再重试
        const result = await erase({ image: png, mask, prompt: ERASE_PROMPT, signal, region, time, attempt });
        const ai = await decodeRaw(ffmpeg, result, region.side, region.side, signal);
        const candidate = { ...original, data: Buffer.from(original.data) };
        if (!pasteBack(candidate, cover, region, ai)) {
          reason = 'mismatch';
          continue;
        }
        if (subtitleCover(candidate, band)) {
          reason = 'residue'; // 去完那一条里还找得到字
          continue;
        }
        image = candidate;
        cleaned = true;
        reason = '';
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      reason = 'failed';
    }
  }
  const bytes = await encodeJpeg(ffmpeg, image, outWidth, quality, signal);
  if (bytes.length < 100) throw new Error('关键帧编码失败');
  return { bytes, cleaned, clean: !cover || cleaned, reason };
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
  ERASE_PROMPT,
  workSize,
  grabRaw,
  encodeJpeg,
  decodeRaw,
  textCandidates,
  findSubtitleBand,
  sampleTimes,
  subtitleCover,
  squareAround,
  pasteBack,
  detectEpisodeBand,
  aiCleanFrame,
};
