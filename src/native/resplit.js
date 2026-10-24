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

// 短剧平台提审要求每集不少于 30 秒。
const PLATFORM_MIN_SECONDS = 30;
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
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const keep = (chunk) => {
      out += chunk.toString('utf8');
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    };
    child[stream].on('data', keep);
    // 另一路输出也要读走：不读的话管道写满，FFmpeg 会卡住不动（长视频的进度信息很多）。
    // 只留最后一段，出错时报给调用方（比如「找不到英伟达显卡」就在 stderr 里）。
    let tail = '';
    child[stream === 'stdout' ? 'stderr' : 'stdout'].on('data', (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000);
    });
    const onAbort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('已取消'));
      code === 0
        ? resolve(out)
        : reject(new Error(`ffmpeg 退出码 ${code}\n${(stream === 'stderr' ? out : tail).slice(-1500)}`));
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

const SCENE_FILTER = "select='gt(scene,0.35)',metadata=print:file=-";
const D3D11_SCALE = `scale_d3d11=width=160:height=-2:format=nv12,hwdownload,format=nv12,${SCENE_FILTER}`;
// 英伟达的 PCI 厂商号。D3D11 不点名时用的是「接着显示器的那块显卡」：显示器插在主板上就是核显，
// 独立显卡反而闲着（实测 RTX 4070 SUPER 0%、AMD 核显解码 100%）。所以先点名用英伟达。
const NVIDIA_VENDOR_ID = '0x10de';

/**
 * 找镜头切换的几种做法，按顺序试，前一种失败就换下一种（切点一个不少）：
 * - d3d11-nvidia（Windows）：点名用英伟达显卡解码 + 缩小；没有英伟达显卡时 FFmpeg 直接报错，换下一种；
 * - d3d11（Windows）：默认显卡（接显示器的那块）解码 + 缩小，只把 160 宽的小图拷回内存，CPU 几乎不动；
 * - hwaccel：显卡解码、CPU 缩小（-hwaccel auto；Mac 是苹果芯片的硬件解码）；
 * - cpu：全用 CPU 解码，跳过去块滤波（快两三成，找镜头切换不受影响）。
 * 以前只有后两种：Windows 上 -hwaccel auto 显卡用不上时会悄悄改回 CPU 解码，不报错，分析切点时 CPU 占满。
 */
function sceneMethods(platform = process.platform, hwaccel = true) {
  const methods = [];
  if (hwaccel && platform === 'win32') {
    methods.push({
      name: 'd3d11-nvidia',
      input: [
        '-init_hw_device',
        `d3d11va=scene:,vendor_id=${NVIDIA_VENDOR_ID}`,
        '-hwaccel',
        'd3d11va',
        '-hwaccel_device',
        'scene',
        '-hwaccel_output_format',
        'd3d11',
      ],
      vf: D3D11_SCALE,
    });
    methods.push({ name: 'd3d11', input: ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11'], vf: D3D11_SCALE });
  }
  if (hwaccel) methods.push({ name: 'hwaccel', input: ['-hwaccel', 'auto'], vf: `scale=160:-2,${SCENE_FILTER}` });
  methods.push({ name: 'cpu', input: ['-skip_loop_filter', 'all'], vf: `scale=160:-2,${SCENE_FILTER}` });
  return methods;
}

// hwaccel（-hwaccel auto）显卡用不上时 FFmpeg 会自己改用 CPU、不报错，所以只能写「自动」
const SCENE_METHOD_TEXT = {
  'd3d11-nvidia': '英伟达显卡（D3D11 解码 + 缩小）',
  d3d11: '默认显卡（D3D11 解码 + 缩小，接显示器的那块）',
  hwaccel: '自动解码（显卡用不上时是 CPU）',
  cpu: 'CPU',
};

// 这台电脑根本没有英伟达显卡：记下来，后面的视频不再每集先试一次。
const unavailableMethods = new Set();
const NO_ADAPTER = /Failed to find d3d11va adapter by vendor id/i;

/** 缩小画面后找镜头切换，速度比整帧检测快得多。返回切换时间（秒）的数组，数组上带 method（用的哪种做法）。 */
async function detectScenes(ffmpegPath, file, signal, { hwaccel = true, platform = process.platform } = {}) {
  const methods = sceneMethods(platform, hwaccel).filter((method) => !unavailableMethods.has(method.name));
  let lastError = null;
  for (const method of methods) {
    try {
      const text = await capture(
        ffmpegPath,
        ['-hide_banner', '-nostdin', ...method.input, '-i', file, '-an', '-vf', method.vf, '-f', 'null', '-'],
        signal,
        'stdout',
      );
      const scenes = [];
      for (const match of text.matchAll(/pts_time:\s*([\d.]+)/g)) scenes.push(Number(match[1]));
      scenes.method = method.name;
      return scenes;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (method.name === 'd3d11-nvidia' && NO_ADAPTER.test(String(error?.message || ''))) unavailableMethods.add(method.name);
      lastError = error;
    }
  }
  throw lastError;
}

async function detectOne(ffmpegPath, file, signal) {
  // 某一项检测失败（比如没有音轨）不影响另一项，只是少一类切点。
  let failed = false;
  let method = '';
  const [pauses, scenes] = await Promise.all([
    detectPauses(ffmpegPath, file, signal).catch((error) => {
      if (signal?.aborted) throw error;
      failed = true;
      return [];
    }),
    detectScenes(ffmpegPath, file, signal)
      .then((found) => {
        method = found.method || '';
        return [...found];
      })
      .catch((error) => {
        if (signal?.aborted) throw error;
        failed = true;
        return [];
      }),
  ]);
  return { pauses, scenes, failed, method };
}

/** 检测结果缓存在应用私有目录（按文件路径+大小+修改时间），同一批视频换参数重排时不用重新分析。 */
async function analyzeSources({ ffmpegPath, files, cacheDir, concurrency = 3, signal, onProgress }) {
  const result = new Map();
  result.methods = {}; // 这一次实际用哪种做法找的镜头切换：{ d3d11: 集数, hwaccel: …, cpu: … }（用缓存的不算）
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
        const { failed, method, ...found } = await detectOne(ffmpegPath, file, signal);
        if (method) result.methods[method] = (result.methods[method] || 0) + 1;
        result.set(file, found);
        // 检测出错（FFmpeg 临时失败等）时不缓存：下次重新分析，不让一次失败永远变成「没有切点」。
        if (cacheFile && !failed) {
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
 * 切出来多长，成品就多长，不需要再反推倍数。
 * 每一段 segment 带着自己所属原集的倍数；跨两个原集的新集里，前后两段倍数可以不同。
 */
function planPieces({ sources, split, speedMin, speedMax, random = Math.random }) {
  const options = validateSplit(split);
  const warnings = [];
  if (options.min_len < PLATFORM_MIN_SECONDS) warnings.push('每集最短时长不到 30 秒：短剧平台要求每集不少于 30 秒');
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
  const lengthMin = options.min_len;
  const lengthMax = options.max_len;
  if (!(lengthMin > 0)) throw new Error('成品时长太短');
  const preferred = midFinal;

  const tailSlack = lengthMin * TAIL_ABSORB_RATIO;
  let tailAbsorbed = 0;
  const solve = (lastMin, lastMax = lengthMax) => {
    const n = times.length;
    const best = new Array(n).fill(Infinity);
    const from = new Array(n).fill(-1);
    best[0] = 0;
    let low = 0;
    for (let j = 1; j < n; j++) {
      const isEnd = j === n - 1;
      const minimum = isEnd ? lastMin : lengthMin;
      while (low < j && times[j] - times[low] > lengthMax) low++;
      let first = low;
      if (isEnd) while (first > 0 && times[j] - times[first - 1] <= lastMax) first--;
      for (let i = first; i < j; i++) {
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
    // 结尾剩下的内容不够一集：先试着并进最后一集（最后一集可以比最长时长长一些），
    // 不让最后一集变短——平台要求每集不少于 30 秒。
    tailAbsorbed = 0;
    route = solve(lengthMin, lengthMax + lengthMin);
    if (route) warnings.push('最后一集比设定的最长时长长一些（结尾剩下的内容并进了最后一集）');
  }
  if (!route) {
    tailAbsorbed = 0;
    route = solve(Math.max(1, Math.min(lengthMin, PLATFORM_MIN_SECONDS), lengthMin * 0.5));
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
      finalDuration: Number(length.toFixed(2)),
    });
  });
  return { pieces, warnings, tailAbsorbed: Number(tailAbsorbed.toFixed(2)), totalSeconds: Number(total.toFixed(2)) };
}

/**
 * 不分析切点，只按每集时长估一下会得到多少集（开始处理前的预览用）。
 * sources: [{ file, duration }]，按播放顺序。真正的切法要等分析完切点才定，所以给「大约多少集」和一个范围：
 * 每集大致切在成品时长范围的中间偏长一点，再给 ±10% 的范围。
 */
function estimatePlan({ sources, split, speedMin, speedMax }) {
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
  const lengthMin = options.min_len;
  const preferred = (options.min_len + options.max_len) / 2;
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
  sceneMethods,
  SCENE_METHOD_TEXT,
  analyzeSources,
  cutCandidates,
  planPieces,
  estimatePlan,
  TAIL_ABSORB_RATIO,
};
