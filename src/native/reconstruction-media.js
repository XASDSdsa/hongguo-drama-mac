'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

function parseFraction(value, fallback = [0, 1]) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (/^\d+$/.test(text)) return [Number(text), 1];
  const match = text.match(/^(\d+)\/(\d+)$/);
  if (!match || Number(match[2]) === 0) return fallback;
  return [Number(match[1]), Number(match[2])];
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (options.signal) options.signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => {
      try { child.kill(); } catch (_) {}
      finish(new Error('媒体任务已取消'));
    };
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', error => finish(error));
    child.once('close', code => {
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0) finish(null, result);
      else finish(new Error(`${path.basename(executable)} 退出码 ${code}\n${result.stderr.slice(-3000)}`));
    });
  });
}

function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function chooseVideoStream(probe) {
  return (probe.streams || []).find(item => item.codec_type === 'video') || null;
}

function chooseAudioStream(probe) {
  return (probe.streams || []).find(item => item.codec_type === 'audio') || null;
}

function normalizeProbe(probe, inputPath, sourceSha256 = null) {
  const video = chooseVideoStream(probe);
  const audio = chooseAudioStream(probe);
  if (!video) throw new Error('视频没有可用的视频流');
  const [fpsNum, fpsDen] = parseFraction(video.avg_frame_rate || video.r_frame_rate, [0, 1]);
  const [rFpsNum, rFpsDen] = parseFraction(video.r_frame_rate || video.avg_frame_rate, [fpsNum, fpsDen]);
  const duration = Number(video.duration || probe.format?.duration || 0);
  const totalFrames = Number(video.nb_frames) > 0
    ? Number(video.nb_frames)
    : Math.max(0, Math.round(duration * fpsNum / fpsDen));
  const [timeBaseNum, timeBaseDen] = parseFraction(video.time_base, [1, 1000000]);
  return {
    original_file: inputPath,
    working_file: inputPath,
    source_sha256: sourceSha256,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps_num: fpsNum,
    fps_den: fpsDen,
    variable_frame_rate: fpsNum !== rFpsNum || fpsDen !== rFpsDen,
    total_frames: totalFrames,
    duration_us: Math.round(duration * 1000000),
    has_audio: !!audio,
    audio_sample_rate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    normalized: false,
    time_base_num: timeBaseNum,
    time_base_den: timeBaseDen,
    start_time: Number(video.start_time || probe.format?.start_time || 0),
    rotation: Number(video.tags?.rotate || video.side_data_list?.find(item => item.rotation != null)?.rotation || 0),
    video_codec: video.codec_name || null,
    audio_codec: audio?.codec_name || null,
  };
}

async function probeMedia(ffprobePath, inputPath, options = {}) {
  if (!ffprobePath) throw new Error('未找到 ffprobe，无法建立媒体基准');
  if (!inputPath || !fs.existsSync(inputPath)) throw new Error('输入视频不存在');
  const sourceSha256 = options.sourceSha256 || await fileSha256(inputPath);
  const result = await runProcess(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', inputPath,
  ], options);
  let probe;
  try { probe = JSON.parse(result.stdout); } catch (_) { throw new Error('ffprobe 返回的数据不是有效 JSON'); }
  return normalizeProbe(probe, inputPath, sourceSha256);
}

function mediaNeedsNormalization(media) {
  return !media || media.normalized !== true
    && (Number(media.start_time || 0) !== 0 || Number(media.rotation || 0) !== 0 || media.variable_frame_rate === true || !Number.isSafeInteger(Number(media.fps_num)) || !Number.isSafeInteger(Number(media.fps_den)));
}

function frameToUs(frameIndex, fpsNum, fpsDen) {
  if (!Number.isSafeInteger(Number(frameIndex)) || !Number.isSafeInteger(Number(fpsNum)) || !Number.isSafeInteger(Number(fpsDen)) || fpsNum <= 0 || fpsDen <= 0) throw new Error('无法用无效帧率换算时间');
  return Math.round(Number(frameIndex) * Number(fpsDen) * 1000000 / Number(fpsNum));
}

function usToFrame(timeUs, fpsNum, fpsDen) {
  if (!Number.isFinite(Number(timeUs)) || !Number.isSafeInteger(Number(fpsNum)) || !Number.isSafeInteger(Number(fpsDen)) || fpsNum <= 0 || fpsDen <= 0) throw new Error('无法用无效帧率换算帧号');
  return Math.round(Number(timeUs) * Number(fpsNum) / Number(fpsDen) / 1000000);
}

async function normalizeMedia({ ffmpegPath, ffprobePath, media, outputPath, signal }) {
  if (!ffmpegPath || !ffprobePath) throw new Error('缺少 FFmpeg/ffprobe，无法生成工作副本');
  if (!media?.original_file || !outputPath) throw new Error('缺少媒体标准化路径');
  const fps = `${media.fps_num || 30}/${media.fps_den || 1}`;
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${crypto.randomUUID()}.tmp.mp4`;
  try {
    // ffmpeg applies the rotate tag / display matrix itself when transcoding (autorotate)
    // and clears the metadata on output. Adding transpose here would rotate a second time,
    // so only the frame rate is normalised; the re-probed output carries the final size.
    const filters = [`fps=${fps}`];
    await runProcess(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', media.original_file,
      '-map', '0:v:0', '-map', '0:a?', '-vf', filters.join(','), '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-af', 'aresample=async=1:first_pts=0', '-movflags', '+faststart', temporary,
    ], { signal });
    await fsp.rename(temporary, outputPath);
    const normalized = await probeMedia(ffprobePath, outputPath, { signal });
    normalized.original_file = media.original_file;
    normalized.working_file = outputPath;
    normalized.source_sha256 = media.source_sha256;
    normalized.normalized = true;
    return normalized;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

module.exports = {
  parseFraction,
  runProcess,
  fileSha256,
  probeMedia,
  normalizeProbe,
  normalizeMedia,
  mediaNeedsNormalization,
  frameToUs,
  usToFrame,
};
