'use strict';
// 重新拆分：把选中的若干集接成一条连续时间线，按「成品时长范围」重新切成新的集。
// 切点优先落在镜头切换、人说完话的停顿处和原集交界处，不会硬切在半句话中间。
// 这个模块只负责「找切点」和「规划每一集」。顺序是：
//   1. 每个原集先各自在倍数区间里随机取一个变速倍数；
//   2. 变速后的各集首尾相接成一条时间线（这条线上的时间就是成品里的时间）；
//   3. 按成品时长在切点处切开，得到去重前的新集；
// 之后由 quchong.runJob 把每个新集存成去重前的中间文件，再统一加去重特效、重新编码。
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const DETECTOR_VERSION = 1;
const GRID_STEP = 0.5; // 没有合适切点时，允许在这个精度上硬切，保证总能排得开。
const EDGE_MARGIN = 0.4; // 离每集可用区间两端太近的切点不要。
const SCENE_SCORE = 0.55;
const JUNCTION_SCORE = 1;
const GAP_JUNCTION_SCORE = 1.3; // 缺集造成的剧情跳跃，尽量落在两集之间。

// 末尾剩下一点点（不到最短时长的四分之一）的内容，直接并进最后一集，不再要求它落在时长范围内。
const TAIL_ABSORB_RATIO = 0.25;

const DEFAULT_SPLIT = Object.freeze({ min_len: 30, max_len: 65, head_trim: 1.1, tail_trim: 1.2, start_number: 1 });

function validateSplit(input = {}) {
  const split = { ...DEFAULT_SPLIT, ...input };
  const range = [
    ['min_len', 5, 600],
    ['max_len', 5, 900],
    ['head_trim', 0, 30],
    ['tail_trim', 0, 30],
  ];
  for (const [key, min, max] of range) {
    if (!Number.isFinite(split[key]) || split[key] < min || split[key] > max) throw new Error(`参数无效：${key}`);
  }
  if (!Number.isInteger(split.start_number) || split.start_number < 1 || split.start_number > 9999)
    throw new Error('参数无效：start_number');
  if (split.max_len - split.min_len < 1) throw new Error('成品时长的最长要比最短至少多 1 秒');
  return split;
}

// ---------- 切点检测（FFmpeg） ----------

function capture(ffmpegPath, args, signal, stream) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (chunk) => {
      out += chunk.toString('utf8');
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    };
    child[stream].on('data', keep);
    const onAbort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('已取消'));
      code === 0 ? resolve(out) : reject(new Error(`ffmpeg 退出码 ${code}\n${out.slice(-1500)}`));
    });
  });
}

/** 只解码音频，找出安静的停顿（人说完一句话的地方）。 */
async function detectPauses(ffmpegPath, file, signal) {
  const text = await capture(
    ffmpegPath,
    ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', 'silencedetect=noise=-32dB:d=0.3', '-f', 'null', '-'],
    signal,
    'stderr',
  );
  const pauses = [];
  let start = null;
  for (const line of text.split(/\r?\n/)) {
    const begin = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (begin) start = Math.max(0, Number(begin[1]));
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && start !== null) {
      pauses.push({ start, end: Number(end[1]) });
      start = null;
    }
  }
  return pauses.filter((item) => item.end > item.start);
}

/** 缩小画面后找镜头切换，速度比整帧检测快得多。 */
async function detectScenes(ffmpegPath, file, signal) {
  const text = await capture(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-an',
      '-vf',
      "scale=160:-2,select='gt(scene,0.35)',metadata=print:file=-",
      '-f',
      'null',
      '-',
    ],
    signal,
    'stdout',
  );
  const scenes = [];
  for (const match of text.matchAll(/pts_time:\s*([\d.]+)/g)) scenes.push(Number(match[1]));
  return scenes;
}

async function detectOne(ffmpegPath, file, signal) {
  // 某一项检测失败（比如没有音轨）不影响另一项，只是少一类切点。
  const [pauses, scenes] = await Promise.all([
    detectPauses(ffmpegPath, file, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return [];
    }),
    detectScenes(ffmpegPath, file, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return [];
    }),
  ]);
  return { pauses, scenes };
}

/** 检测结果缓存在应用私有目录（按文件路径+大小+修改时间），同一批视频换参数重排时不用重新分析。 */
async function analyzeSources({ ffmpegPath, files, cacheDir, concurrency = 3, signal, onProgress }) {
  const result = new Map();
  const queue = [...files];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new Error('已取消');
      const file = queue.shift();
      let cacheFile = null;
      if (cacheDir) {
        const stat = await fsp.stat(file);
        const key = crypto
          .createHash('sha1')
          .update(`${DETECTOR_VERSION}|${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`)
          .digest('hex');
        cacheFile = path.join(cacheDir, `${key}.json`);
        try {
          result.set(file, JSON.parse(await fsp.readFile(cacheFile, 'utf8')));
        } catch (_) {}
      }
      if (!result.has(file)) {
        const found = await detectOne(ffmpegPath, file, signal);
        result.set(file, found);
        if (cacheFile) {
          try {
            await fsp.mkdir(cacheDir, { recursive: true });
            await fsp.writeFile(cacheFile, JSON.stringify(found));
          } catch (_) {}
        }
      }
      onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker));
  return result;
}

/**
 * 把检测结果整理成切点列表（源视频时间）：
 * 镜头切换落在停顿里 = 最好；单独的长停顿其次；单独的镜头切换再次。
 */
function cutCandidates({ pauses = [], scenes = [] }, lo, hi) {
  const found = [];
  const used = new Set();
  for (const pause of pauses) {
    const length = pause.end - pause.start;
    const scene = scenes.findIndex((t, i) => !used.has(i) && t >= pause.start - 0.2 && t <= pause.end + 0.2);
    if (scene >= 0) {
      used.add(scene);
      found.push({ t: Math.min(pause.end, Math.max(pause.start, scenes[scene])), score: 1 });
    } else {
      found.push({
        t: (pause.start + pause.end) / 2,
        score: 0.5 + 0.3 * Math.min(1, Math.max(0, (length - 0.3) / 0.7)),
      });
    }
  }
  scenes.forEach((t, i) => {
    if (!used.has(i)) found.push({ t, score: SCENE_SCORE });
  });
  return found.filter((item) => item.t > lo + EDGE_MARGIN && item.t < hi - EDGE_MARGIN).sort((a, b) => a.t - b.t);
}

// ---------- 规划 ----------

/**
 * 在连续时间线上选一组切点，使每一集的成品时长落在 [min_len, max_len]。
 * sources: [{ file, duration, candidates?: [{t, score}], gapBefore?: boolean }]，按播放顺序。
 * 每个原集先各自在 [speedMin, speedMax] 里随机取一个倍数，再按变速后的时间线切：
 * 切出来多长，成品就多长（再加片头黑场 intro），不需要再反推倍数。
 * 每一段 segment 带着自己所属原集的倍数；跨两个原集的新集里，前后两段倍数可以不同。
 */
function planPieces({ sources, split, speedMin, speedMax, intro = 0, random = Math.random }) {
  const options = validateSplit(split);
  const warnings = [];
  const timeline = [];
  let offset = 0;
  for (const source of sources) {
    const from = options.head_trim;
    const to = source.duration - options.tail_trim;
    if (!(to - from >= 1)) {
      warnings.push(`${path.basename(source.file)} 裁掉片头片尾后不足 1 秒，已跳过`);
      continue;
    }
    const speed = Number((speedMin + random() * (speedMax - speedMin)).toFixed(4));
    const span = (to - from) / speed; // 变速后这一集占多长
    timeline.push({ file: source.file, from, to, speed, span, offset, source });
    offset += span;
  }
  const total = offset;
  if (!timeline.length) return { pieces: [], warnings: [...warnings, '没有可用的视频'] };

  // 节点：起点、终点、原集交界、检测到的切点，加上保底的均匀网格。
  const nodes = new Map();
  const put = (time, score) => {
    const key = Math.round(time * 100);
    const old = nodes.get(key);
    if (!old || old.score < score) nodes.set(key, { t: key / 100, score });
  };
  for (let t = GRID_STEP; t < total; t += GRID_STEP) put(t, 0);
  timeline.forEach((item, index) => {
    if (index > 0) put(item.offset, item.source.gapBefore ? GAP_JUNCTION_SCORE : JUNCTION_SCORE);
    for (const cut of item.source.candidates || []) {
      if (cut.t > item.from + EDGE_MARGIN && cut.t < item.to - EDGE_MARGIN)
        put(item.offset + (cut.t - item.from) / item.speed, cut.score);
    }
  });
  nodes.delete(0);
  const inner = [...nodes.values()].filter((node) => node.t < total - 0.05).sort((a, b) => a.t - b.t);
  const times = [0, ...inner.map((node) => node.t), total];
  const scores = [0, ...inner.map((node) => node.score), 1];

  const midFinal = (options.min_len + options.max_len) / 2;
  const lengthMin = options.min_len - intro;
  const lengthMax = options.max_len - intro;
  if (!(lengthMin > 0)) throw new Error('成品时长太短');
  const preferred = midFinal - intro;

  const tailSlack = lengthMin * TAIL_ABSORB_RATIO;
  let tailAbsorbed = 0;
  const solve = (lastMin) => {
    const n = times.length;
    const best = new Array(n).fill(Infinity);
    const from = new Array(n).fill(-1);
    best[0] = 0;
    let low = 0;
    for (let j = 1; j < n; j++) {
      const isEnd = j === n - 1;
      const minimum = isEnd ? lastMin : lengthMin;
      while (low < j && times[j] - times[low] > lengthMax) low++;
      for (let i = low; i < j; i++) {
        const length = times[j] - times[i];
        if (length < minimum || !Number.isFinite(best[i])) continue;
        const cost = best[i] + (isEnd ? 0 : 1 - scores[j]) + 0.3 + (0.5 * Math.abs(length - preferred)) / preferred;
        if (cost < best[j]) {
          best[j] = cost;
          from[j] = i;
        }
      }
    }
    // 结尾：要么最后一集正好切到末尾；要么在离末尾不到 tailSlack 的地方收住，
    // 把剩下一点点内容直接并进最后一集（它可以比最长时长稍长）。
    let end = n - 1;
    let endCost = best[n - 1];
    for (let e = n - 2; e >= 1 && times[n - 1] - times[e] <= tailSlack; e--) {
      if (!Number.isFinite(best[e])) continue;
      const cost = best[e] - (1 - scores[e]); // 这里并不真的切，不计切点好坏
      if (cost < endCost) {
        endCost = cost;
        end = e;
      }
    }
    if (!Number.isFinite(endCost)) return null;
    const chain = [];
    for (let j = end; j > 0; j = from[j]) chain.unshift(j);
    if (end !== n - 1) {
      tailAbsorbed = times[n - 1] - times[end];
      chain[chain.length - 1] = n - 1;
    }
    return chain;
  };

  let route = solve(lengthMin);
  if (!route) {
    tailAbsorbed = 0;
    route = solve(Math.max(1, lengthMin * 0.5));
    if (route) warnings.push('最后一集比设定的最短时长短一些');
  }
  if (!route) {
    route = [times.length - 1];
    warnings.push(
      total < lengthMin
        ? '选中的内容加起来不够一集的最短时长，已整体生成一集'
        : '没有找到满足时长范围的切法，已整体生成一集',
    );
  }

  const pieces = [];
  let previous = 0;
  route.forEach((index, order) => {
    const start = times[previous];
    const end = times[index];
    previous = index;
    const length = end - start;
    const segments = [];
    for (const item of timeline) {
      const a = Math.max(start, item.offset);
      const b = Math.min(end, item.offset + item.span);
      if (b - a < 0.05) continue;
      // 变速后时间线上的 [a, b]，折回原片里就是 from + (a - offset) × 倍数 起的 (b - a) × 倍数 秒。
      segments.push({
        file: item.file,
        start: Number((item.from + (a - item.offset) * item.speed).toFixed(3)),
        duration: Number(((b - a) * item.speed).toFixed(3)),
        speed: item.speed,
      });
    }
    pieces.push({
      number: options.start_number + order,
      segments,
      length: Number(length.toFixed(3)),
      finalDuration: Number((length + intro).toFixed(2)),
    });
  });
  return { pieces, warnings, tailAbsorbed: Number(tailAbsorbed.toFixed(2)), totalSeconds: Number(total.toFixed(2)) };
}

/**
 * 不分析切点，只按每集时长估一下会得到多少集（开始处理前的预览用）。
 * sources: [{ file, duration }]，按播放顺序。真正的切法要等分析完切点才定，所以给「大约多少集」和一个范围：
 * 每集大致切在成品时长范围的中间偏长一点，再给 ±10% 的范围。
 */
function estimatePlan({ sources, split, speedMin, speedMax, intro = 0 }) {
  const options = validateSplit(split);
  let total = 0;
  let used = 0;
  for (const source of sources) {
    const usable = source.duration - options.head_trim - options.tail_trim;
    if (usable >= 1) {
      total += usable;
      used += 1;
    }
  }
  const lengthMin = options.min_len - intro;
  const preferred = (options.min_len + options.max_len) / 2 - intro;
  // 变速后的总时长：按倍数区间的中间值估。
  const finalTotal = total / ((speedMin + speedMax) / 2);
  if (!(total > 0) || !(lengthMin > 0)) {
    return {
      count: 0,
      minCount: 0,
      maxCount: 0,
      totalSeconds: 0,
      usedSources: 0,
      tailSlack: 0,
      finalMin: 0,
      finalMax: 0,
    };
  }
  const bound = (value) => Math.max(1, Math.floor(value));
  // 实际切点会让每集比「预定时长」平均略长一点点（模拟 10～80 集的整部剧，平均长约 1.1 倍），按这个估。
  const count = bound(Math.round(finalTotal / (preferred * 1.1)));
  return {
    count,
    minCount: bound(Math.round(count * 0.9)),
    maxCount: Math.max(count, Math.ceil(count * 1.1)),
    totalSeconds: Number(total.toFixed(1)),
    usedSources: used,
    // 结尾剩下不到这么多秒的零头，会直接并进最后一集。
    tailSlack: Number((lengthMin * TAIL_ABSORB_RATIO).toFixed(1)),
    finalMin: options.min_len,
    finalMax: options.max_len,
  };
}

module.exports = {
  DEFAULT_SPLIT,
  validateSplit,
  detectPauses,
  detectScenes,
  analyzeSources,
  cutCandidates,
  planPieces,
  estimatePlan,
  TAIL_ABSORB_RATIO,
};
