/**
 * Local video processing used by the Mac app.
 *
 * This is the Node/FFmpeg port of quchong_app's media pipeline.  It deliberately
 * has no Electron dependency so it can be regression-tested with a temporary
 * video and reused by the main process.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Keep the number of FFmpeg processes bounded.  A single x264 process already
// uses several codec threads, so running one process per CPU core can make the
// desktop unresponsive.  Two to four concurrent episodes is a good default;
// users can still change it in the processing screen.
const CPU_COUNT = typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : os.cpus().length;
const DEFAULT_JOBS = Math.max(2, Math.min(4, Math.floor(CPU_COUNT / 2) || 2));
const PROCESS_IDLE_TIMEOUT_MS = 180_000;
const HARDWARE_ENCODERS = Object.freeze(['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_videotoolbox']);
const ENCODER_PROBE_CACHE = new Map();

const DEFAULTS = Object.freeze({
  crop_ratio: 0.94,
  speed_min: 1.03,
  speed_max: 1.05,
  rotation_max: 0.008,
  rgb_shift: 2,
  noise_min: 4,
  noise_max: 7,
  contrast: 1.06,
  saturation: 1.25,
  hue_range: 12,
  vignette: true,
  black_intro: true,
  pitch_min: 1.04,
  pitch_max: 1.07,
  orig_volume: 0.5,
  bgm_volume: 0.15,
  eq_enable: true,
  resolution: '1080x1920',
  encoder: 'auto',
  quality: 'standard',
  jobs: DEFAULT_JOBS,
});

function validateOptions(input = {}) {
  const opts = { ...DEFAULTS, ...input };
  const numeric = [
    ['crop_ratio', 0.85, 1], ['speed_min', 1, 1.1], ['speed_max', 1, 1.1],
    ['rotation_max', 0, 0.02], ['rgb_shift', 0, 5], ['noise_min', 0, 15],
    ['noise_max', 0, 15], ['contrast', 0.9, 1.3], ['saturation', 0.8, 1.6],
    ['hue_range', 0, 30], ['pitch_min', 1, 1.1], ['pitch_max', 1, 1.1],
    ['orig_volume', 0.1, 1], ['bgm_volume', 0, 0.5], ['jobs', 1, 8],
  ];
  for (const [key, min, max] of numeric) {
    const value = opts[key];
    if (!Number.isFinite(value) || value < min || value > max ||
        (['rgb_shift', 'noise_min', 'noise_max', 'hue_range', 'jobs'].includes(key) && !Number.isInteger(value))) {
      throw new Error(`参数无效：${key}`);
    }
  }
  if (opts.speed_min > opts.speed_max || opts.pitch_min > opts.pitch_max || opts.noise_min > opts.noise_max) {
    throw new Error('参数下限不能大于上限');
  }
  if (!['1080x1920', '720x1280'].includes(opts.resolution)) throw new Error('分辨率无效');
  if (!['auto', 'cpu', 'videotoolbox', 'nvenc', 'amf', 'qsv'].includes(opts.encoder)) throw new Error('编码器无效');
  if (!['standard', 'lean'].includes(opts.quality)) throw new Error('画质选项无效');
  for (const key of ['vignette', 'black_intro', 'eq_enable']) {
    if (typeof opts[key] !== 'boolean') throw new Error(`参数无效：${key}`);
  }
  return opts;
}

function rollParams(opts, random = Math.random) {
  const randint = (min, max) => Math.floor(random() * (max - min + 1)) + min;
  const between = (min, max) => min + random() * (max - min);
  return {
    HUE: randint(-opts.hue_range, opts.hue_range),
    SPEED: between(opts.speed_min, opts.speed_max),
    PITCH: between(opts.pitch_min, opts.pitch_max),
    ROT: between(0, opts.rotation_max),
    CX: random(), CY: random(),
    NOISE: randint(opts.noise_min, opts.noise_max),
  };
}

function detectEncoder(requested, platform = process.platform, available = null) {
  if (requested !== 'auto') return requested;
  if (platform === 'darwin') return 'videotoolbox';
  if (platform === 'win32' && Array.isArray(available)) {
    if (available.includes('h264_nvenc')) return 'nvenc';
    if (available.includes('h264_amf')) return 'amf';
    if (available.includes('h264_qsv')) return 'qsv';
  }
  return 'cpu';
}

function encoderArgs(name, lean, width, height) {
  if (name === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', lean ? '24' : '21'];
  if (name === 'amf') return ['-c:v', 'h264_amf', '-quality', lean ? 'speed' : 'balanced'];
  if (name === 'qsv') return ['-c:v', 'h264_qsv', '-global_quality', lean ? '25' : '21'];
  if (name === 'videotoolbox') {
    let bitrate = Math.max(1500, Math.floor(width * height * 0.00386));
    if (lean) bitrate = Math.floor(bitrate / 2);
    return ['-c:v', 'h264_videotoolbox', '-b:v', `${bitrate}k`, '-maxrate', `${Math.floor(bitrate * 1.5)}k`, '-bufsize', `${bitrate * 2}k`];
  }
  return ['-c:v', 'libx264', '-preset', 'fast', '-crf', lean ? '23' : '20'];
}

function buildCommand({ src, dst, bgm, opts: rawOpts, rolled, media, encoder }) {
  const opts = validateOptions(rawOpts);
  const r = rolled || rollParams(opts);
  const [width, height] = opts.resolution.split('x').map(Number);
  const speed = r.SPEED;
  const intro = opts.black_intro ? 0.3 : 0;
  const hasAudio = media.has_audio;
  const origin = hasAudio ? Math.min(media.video_start, media.audio_start) : media.video_start;
  const videoDelay = Math.max(0, (media.video_start - origin) / speed + intro);
  const audioDelay = Math.max(0, (media.audio_start - origin) / speed + intro);
  const horizontal = media.video_width > media.video_height;
  const vf = [
    `crop=iw*${opts.crop_ratio}:ih*${opts.crop_ratio}:x=(iw-ow)*${r.CX.toFixed(6)}:y=(ih-oh)*${r.CY.toFixed(6)}`,
  ];
  const filters = [];
  let videoInput = '[0:V:0]';
  if (horizontal) {
    // Keep the source's landscape composition while filling the portrait canvas.
    filters.push('[0:V:0]split=2[bgsrc][fgsrc]');
    filters.push(`[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:1,setsar=1[bg]`);
    filters.push(`[fgsrc]${vf.join(',')},scale=${width}:-2,setsar=1[fg]`);
    filters.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[vbase]');
    videoInput = '[vbase]';
    vf.length = 0;
  }
  if (!horizontal) {
    if (r.ROT > 0) vf.push(`rotate=${r.ROT.toFixed(6)}:fillcolor=black`);
    vf.push(`scale=w='trunc(min(${width},${height}*dar)/2)*2':h='trunc(min(${height},${width}/dar)/2)*2'`, 'setsar=1');
  } else if (r.ROT > 0) {
    vf.push(`rotate=${r.ROT.toFixed(6)}:fillcolor=black`, `scale=w='trunc(min(${width},${height}*dar)/2)*2':h='trunc(min(${height},${width}/dar)/2)*2'`, 'setsar=1');
  }
  if (opts.rgb_shift > 0) vf.push(`rgbashift=rh=${opts.rgb_shift}:rv=1:gh=0:gv=0:bh=-${opts.rgb_shift}:bv=1`);
  if (r.NOISE > 0) vf.push(`noise=alls=${r.NOISE}:allf=t`);
  vf.push('unsharp=5:5:0.8');
  vf.push(`setpts=(PTS-STARTPTS)/${speed.toFixed(6)}`);
  vf.push(`eq=contrast=${opts.contrast}:saturation=${opts.saturation},hue=h=${r.HUE}`);
  if (opts.vignette) vf.push('vignette=PI/5');
  vf.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  if (videoDelay > 0) vf.push(`tpad=start_duration=${videoDelay.toFixed(6)}:color=black`);
  if (opts.black_intro) vf.push(`fade=t=in:st=${videoDelay.toFixed(6)}:d=0.3`);

  filters.push(`${videoInput}${vf.join(',')}[v]`);
  const inputs = ['-i', src];
  const audioOutput = hasAudio || Boolean(bgm);
  if (hasAudio) {
    const af = ['asetpts=PTS-STARTPTS', 'aresample=44100', `asetrate=44100*${r.PITCH.toFixed(6)}`, 'aresample=44100', `atempo=${(speed / r.PITCH).toFixed(6)}`];
    if (opts.eq_enable) af.push('equalizer=f=1200:t=q:w=1:g=1.5');
    if (audioDelay > 0) af.push(`adelay=delays=${(audioDelay * 1000).toFixed(3)}:all=1`);
    af.push(`volume=${opts.orig_volume}`, 'apad');
    filters.push(`[0:a:0]${af.join(',')}[oa]`);
  }
  if (bgm) {
    inputs.push('-stream_loop', '-1', '-i', bgm);
    filters.push(`[1:a:0]asetpts=PTS-STARTPTS,volume=${opts.bgm_volume}[ba]`);
  }
  if (audioOutput) {
    const source = hasAudio && bgm
      ? '[oa][ba]amix=inputs=2:duration=first:dropout_transition=0'
      : hasAudio ? '[oa]' : '[ba]';
    const separator = source.includes('amix=') ? ',' : '';
    filters.push(`${source}${separator}aformat=channel_layouts=stereo,aresample=async=1[a]`);
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]'];
  if (audioOutput) args.push('-map', '[a]', '-shortest');
  args.push('-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', ...encoderArgs(encoder, opts.quality === 'lean', width, height));
  if (audioOutput) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-map_metadata', '-1', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', dst);
  return { args, rolled: r, duration: (media.duration + Math.max(0, media.video_start - media.audio_start)) / speed + intro };
}

function execJson(ffprobePath, args, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(ffprobePath, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim().slice(-3000)));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`ffprobe 返回无效数据：${e.message}`)); }
    });
    const abort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      child.once('close', () => signal.removeEventListener('abort', abort));
    }
  });
}

async function probeMedia(ffprobePath, file, signal) {
  const data = await execJson(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,start_time,width,height:stream_disposition=attached_pic', '-of', 'json', file], signal);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const videos = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const start = (list) => Number.isFinite(Number(list[0]?.start_time)) ? Number(list[0].start_time) : 0;
  const duration = Number(data.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    has_video: videos.length > 0,
    has_audio: audios.length > 0,
    video_width: Number(videos[0]?.width) || 0,
    video_height: Number(videos[0]?.height) || 0,
    video_start: start(videos),
    audio_start: start(audios),
  };
}

/**
 * Return the H.264 hardware encoders advertised by this FFmpeg build.
 *
 * FFmpeg can list an encoder even when the machine does not have the matching
 * device.  The actual encode is still treated as the final capability check;
 * runJob retries with libx264 when that check fails.  The probe is cached per
 * FFmpeg path because every episode in a batch uses the same binary.
 */
function probeHardwareEncoders(ffmpegPath) {
  if (ENCODER_PROBE_CACHE.has(ffmpegPath)) return ENCODER_PROBE_CACHE.get(ffmpegPath);
  const promise = new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (_error, stdout = '', stderr = '') => {
      const text = `${stdout}\n${stderr}`;
      resolve(HARDWARE_ENCODERS.filter((name) => new RegExp(`\\b${name}\\b`).test(text)));
    });
  });
  ENCODER_PROBE_CACHE.set(ffmpegPath, promise);
  promise.catch(() => ENCODER_PROBE_CACHE.delete(ffmpegPath));
  return promise;
}

function tailPush(state, chunk) {
  state.text += chunk.toString('utf8');
  if (state.text.length > 10000) state.text = state.text.slice(-10000);
}

function runProcess(ffmpegPath, args, duration, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errors = { text: '' };
    let output = '';
    let abortKillTimer = null;
    let watchdogTimer = null;
    let watchdogTriggered = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (signal) signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const touchWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        if (settled || child.exitCode != null) return;
        watchdogTriggered = true;
        child.kill('SIGTERM');
        abortKillTimer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 2000);
      }, PROCESS_IDLE_TIMEOUT_MS);
    };
    const abort = () => {
      if (child.exitCode != null) return;
      child.kill('SIGTERM');
      abortKillTimer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 2000);
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    touchWatchdog();
    child.stdout.on('data', (chunk) => {
      touchWatchdog();
      output += chunk.toString('utf8');
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('out_time_us=')) continue;
        const value = Number(line.slice(12));
        if (Number.isFinite(value) && duration > 0) onProgress?.(Math.max(0, Math.min(99, value / 1e6 / duration * 100)));
      }
    });
    child.stderr.on('data', (chunk) => { touchWatchdog(); tailPush(errors, chunk); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, sig) => {
      if (signal?.aborted) return finish(new Error('已取消'));
      if (watchdogTriggered) return finish(new Error(`ffmpeg 长时间无输出（超过 ${Math.round(PROCESS_IDLE_TIMEOUT_MS / 1000)} 秒），已自动终止；可能是硬件编码不可用或输入文件异常`));
      if (code !== 0) return finish(new Error(`ffmpeg 退出码 ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}\n${errors.text.slice(-6000)}`));
      finish();
    });
  });
}

async function sameFileOrPath(src, dst) {
  if (path.resolve(src) === path.resolve(dst)) return true;
  try {
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (_) { return false; }
}

async function runJob({ ffmpegPath, ffprobePath, src, dst, bgm = null, opts, signal, onProgress, onLog }) {
  const options = validateOptions(opts);
  if (!path.isAbsolute(src) || !path.isAbsolute(dst)) throw new Error('输入和输出路径必须是绝对路径');
  if (await sameFileOrPath(src, dst)) throw new Error('输入与输出指向同一文件，已拒绝覆盖');
  if (fs.existsSync(dst)) throw new Error(`输出已存在，已拒绝覆盖：${dst}`);
  const media = await probeMedia(ffprobePath, src, signal);
  if (!media.has_video) throw new Error(`输入没有可用视频轨：${src}`);
  if (bgm) {
    const music = await probeMedia(ffprobePath, bgm, signal);
    if (!music.has_audio) throw new Error(`BGM 没有可用音频轨：${bgm}`);
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = path.join(path.dirname(dst), `.hongguo-quchong-${randomUUID()}.mp4`);
  let rolled;
  try {
    rolled = rollParams(options);
    if (signal?.aborted) throw new Error('已取消');
    const available = options.encoder === 'auto' ? await probeHardwareEncoders(ffmpegPath) : null;
    const first = detectEncoder(options.encoder, process.platform, available);
    const candidates = [first];
    // Windows FFmpeg builds usually advertise all three hardware encoders.
    // Try them in a deterministic order so a missing NVIDIA device can fall
    // through to an attached AMD/Intel device before giving up on hardware.
    if (options.encoder === 'auto' && process.platform === 'win32') {
      for (const [name, ffmpegName] of [['nvenc', 'h264_nvenc'], ['amf', 'h264_amf'], ['qsv', 'h264_qsv']]) {
        if (available?.includes(ffmpegName) && !candidates.includes(name)) candidates.push(name);
      }
    }
    if (!candidates.includes('cpu')) candidates.push('cpu');
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const encoder = candidates[index];
      const command = buildCommand({ src, dst: tmp, bgm, opts: options, rolled, media, encoder });
      onLog?.(`[开始] ${path.basename(src)} 编码器=${encoder} 参数=${JSON.stringify(rolled)}`);
      try {
        await runProcess(ffmpegPath, command.args, command.duration, onProgress, signal);
        lastError = null;
        break;
      } catch (error) {
        if (signal?.aborted) throw new Error('已取消');
        lastError = error;
        if (index >= candidates.length - 1) throw error;
        const next = candidates[index + 1];
        onLog?.(`[重试] ${encoder} 硬编失败，改用 ${next === 'cpu' ? 'CPU' : next}：${error.message}`);
        try { await fsp.unlink(tmp); } catch (_) {}
      }
    }
    if (lastError) throw lastError;
    if (signal?.aborted) throw new Error('已取消');
    const result = await probeMedia(ffprobePath, tmp, signal);
    const stat = await fsp.stat(tmp);
    if (!stat.size || !result.has_video) throw new Error('输出验证失败：文件为空或没有视频轨');
    if (signal?.aborted) throw new Error('已取消');
    try { await fsp.link(tmp, dst); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`输出已存在，已拒绝覆盖：${dst}`); throw error; }
    onProgress?.(100);
    onLog?.(`[完成] ${path.basename(src)}`);
    return { success: true, path: dst, rolled };
  } finally {
    try { await fsp.unlink(tmp); } catch (_) {}
  }
}

module.exports = { DEFAULTS, validateOptions, rollParams, detectEncoder, encoderArgs, buildCommand, probeMedia, runJob };
