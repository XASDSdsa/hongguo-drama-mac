'use strict';

const { spawn } = require('node:child_process');
const { decideShotCuts } = require('./cut-point-refiner');

// 测量间隙用的最短静音。必须低于气口门槛 0.18 秒，才能把更短的字间粘连
// 也量出来，再交给 decideShotCuts 丢掉。这里的 0.05 秒不是切断条件。
const GAP_MEASURE_SECONDS = 0.05;

function runFfmpeg(ffmpegPath, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      try { child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'); } catch (_) {}
      finish(new Error('任务已取消'));
    };
    child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-2 * 1024 * 1024); });
    child.once('error', error => finish(new Error(`无法启动边界扫描 FFmpeg：${error.message}`)));
    child.once('close', code => {
      // FFmpeg returns non-zero on SIGINT and on some demuxers after emitting
      // useful logs.  A caller can still inspect the candidates parsed below;
      // only an empty process output is treated as an actual scan failure.
      if (code !== 0 && !stderr.trim()) finish(new Error(`边界扫描 FFmpeg 退出码 ${code}`));
      else finish(null, stderr);
    });
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

function parseDuration(log) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(log || ''));
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseShots(log) {
  const shots = [];
  for (const match of String(log || '').matchAll(/pts_time:\s*([\d.]+)/g)) {
    const time = Number(match[1]);
    if (Number.isFinite(time)) shots.push(time);
  }
  return shots;
}

function parseSilences(log) {
  const silences = [];
  let open = null;
  const pattern = /silence_(start|end):\s*([\d.]+)/g;
  for (const match of String(log || '').matchAll(pattern)) {
    const time = Number(match[2]);
    if (!Number.isFinite(time)) continue;
    if (match[1] === 'start') open = time;
    else if (open != null && time > open) {
      silences.push({ start: open, end: time });
      open = null;
    }
  }
  return { silences, openStart: open };
}

function speechFromSilences(silences, duration) {
  const gaps = (Array.isArray(silences) ? silences : [])
    .map(item => ({ start: Number(item.start), end: Number(item.end) }))
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const gap of gaps) {
    const last = merged[merged.length - 1];
    if (!last || gap.start > last.end) merged.push({ start: gap.start, end: gap.end });
    else last.end = Math.max(last.end, gap.end);
  }
  const endLimit = Number.isFinite(duration) ? duration : (merged.length ? merged[merged.length - 1].end : null);
  if (endLimit == null) return [];
  const speech = [];
  let cursor = 0;
  for (const gap of merged) {
    const gapStart = Math.max(0, gap.start);
    if (gapStart > cursor) speech.push({ start: cursor, end: Math.min(gapStart, endLimit) });
    cursor = Math.max(cursor, gap.end);
    if (cursor >= endLimit) return speech.filter(item => item.end > item.start);
  }
  if (cursor < endLimit) speech.push({ start: cursor, end: endLimit });
  return speech.filter(item => item.end > item.start);
}

function hasAudioStream(log) {
  return /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Audio:/.test(String(log || ''));
}

/**
 * 从整段扫描日志读出切镜和有声区间。没有音轨视为空语音。
 * 静音区间只用来反推语音空隙，不会直接变成切点。
 */
function measurementsFromLogs(silenceLog, sceneLog) {
  const silenceText = String(silenceLog || '');
  const sceneText = String(sceneLog || '');
  const duration = parseDuration(silenceText) ?? parseDuration(sceneText);
  if (duration == null) throw new Error('边界扫描没有读到视频时长');
  const shots = parseShots(sceneText);
  if (!hasAudioStream(silenceText)) return { shots, speech: [], duration };
  const parsed = parseSilences(silenceText);
  const silences = parsed.silences.slice();
  if (parsed.openStart != null && duration > parsed.openStart) silences.push({ start: parsed.openStart, end: duration });
  return { shots, speech: speechFromSilences(silences, duration), duration };
}

async function measureShotBreath(ffmpegPath, inputPath, options = {}) {
  const sceneThreshold = Number.isFinite(Number(options.sceneChangeThreshold)) ? Number(options.sceneChangeThreshold) : 0.4;
  // -35dB 只划分「有没有语音」，用来量气口的长度。低于这个电平不算在说话。
  // 它和 0.05 秒的测量下限都不能单独切断。
  const silenceNoise = String(options.silenceNoise || '-35dB');
  const [silenceLog, sceneLog] = await Promise.all([
    runFfmpeg(ffmpegPath, ['-hide_banner', '-nostats', '-i', inputPath, '-vn', '-af', `silencedetect=noise=${silenceNoise}:d=${GAP_MEASURE_SECONDS}`, '-f', 'null', '-'], options.signal),
    runFfmpeg(ffmpegPath, ['-hide_banner', '-nostats', '-i', inputPath, '-vf', `select='gt(scene,${sceneThreshold})',showinfo`, '-an', '-f', 'null', '-'], options.signal),
  ]);
  return measurementsFromLogs(silenceLog, sceneLog);
}

function cutRecord(cut) {
  return {
    time: cut.time,
    reason: cut.reason,
    boundary_status: cut.status,
    boundary_source: cut.source,
    breath_start: cut.breath_start,
    breath_end: cut.breath_end,
  };
}

/**
 * 分析链路写出的切点。模型带回来的 split_points 在这里丢掉。
 * 没有视频可测时不发明切点；测到了就只保留落在气口上的切镜。
 */
async function refineAnalysisCutPoints(analysis, options = {}) {
  const base = analysis && typeof analysis === 'object' ? analysis : {};
  const provided = Array.isArray(options.shots) || Array.isArray(options.speech);
  let measured;
  if (provided) {
    measured = {
      shots: options.shots || [],
      speech: options.speech || [],
      duration: options.duration,
    };
  } else if (!options.ffmpegPath && !options.inputPath) {
    return { ...base, split_points: [] };
  } else if (!options.ffmpegPath || !options.inputPath) {
    throw new Error('缺少视频或 FFmpeg，无法按画面切镜和气口决定切断');
  } else {
    measured = await measureShotBreath(options.ffmpegPath, options.inputPath, options);
  }
  const cuts = decideShotCuts({
    ...measured,
    breathGapSeconds: options.breathGapSeconds,
    toleranceSeconds: options.toleranceSeconds,
  });
  return { ...base, split_points: cuts.map(cutRecord) };
}

module.exports = {
  GAP_MEASURE_SECONDS,
  measurementsFromLogs,
  measureShotBreath,
  refineAnalysisCutPoints,
};
