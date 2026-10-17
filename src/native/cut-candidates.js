'use strict';

const { spawn } = require('node:child_process');
const { refineSplitPoints } = require('./cut-point-refiner');

function runFfmpeg(ffmpegPath, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      try {
        child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
      } catch (_) {}
      finish(new Error('任务已取消'));
    };
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2 * 1024 * 1024);
    });
    child.once('error', (error) => finish(new Error(`无法启动边界扫描 FFmpeg：${error.message}`)));
    child.once('close', (code) => {
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

async function collectCutCandidates(ffmpegPath, inputPath, options = {}) {
  if (!ffmpegPath) return [];
  const silenceNoise = String(options.silenceNoise || '-35dB');
  const silenceDuration = Number.isFinite(Number(options.silenceDuration))
    ? Math.max(0.1, Number(options.silenceDuration))
    : 0.25;
  const sceneThreshold = Number.isFinite(Number(options.sceneChangeThreshold))
    ? Number(options.sceneChangeThreshold)
    : 0.4;
  const [silenceLog, sceneLog] = await Promise.all([
    runFfmpeg(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        inputPath,
        '-vn',
        '-af',
        `silencedetect=noise=${silenceNoise}:d=${silenceDuration}`,
        '-f',
        'null',
        '-',
      ],
      options.signal,
    ),
    runFfmpeg(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        inputPath,
        '-vf',
        `select='gt(scene,${sceneThreshold})',showinfo`,
        '-an',
        '-f',
        'null',
        '-',
      ],
      options.signal,
    ),
  ]);
  const candidates = [];
  const silencePattern = /silence_(start|end):\s*([\d.]+)/g;
  for (const match of String(silenceLog || '').matchAll(silencePattern)) {
    const time = Number(match[2]);
    if (Number.isFinite(time))
      candidates.push({ time, silence: true, speechEnergy: 0, confidence: 0.8, reason: '静音边界' });
  }
  const scenePattern = /pts_time:\s*([\d.]+)/g;
  for (const match of String(sceneLog || '').matchAll(scenePattern)) {
    const time = Number(match[1]);
    if (Number.isFinite(time))
      candidates.push({ time, sceneChange: true, sceneScore: sceneThreshold, confidence: 0.7, reason: '镜头切换' });
  }
  return candidates.sort((a, b) => a.time - b.time);
}

async function refineAnalysisCutPoints(analysis, options = {}) {
  const points = Array.isArray(analysis?.split_points) ? analysis.split_points : [];
  if (!points.length) return analysis;
  let candidates = [];
  let scanError = '';
  try {
    candidates = await collectCutCandidates(options.ffmpegPath, options.inputPath, options);
  } catch (error) {
    scanError = String(error?.message || error);
  }
  const refined = refineSplitPoints(points, candidates, options);
  return {
    ...analysis,
    split_points: refined.map((item) => ({
      time: item.time,
      reason: item.reason || (scanError ? `边界扫描失败：${scanError}` : item.status === 'warn' ? item.reason : ''),
      semantic_time: item.semanticTime,
      boundary_status: item.status,
      boundary_source: item.source,
      ...(item.distance == null ? {} : { boundary_distance: item.distance }),
    })),
  };
}

module.exports = { collectCutCandidates, refineAnalysisCutPoints };
