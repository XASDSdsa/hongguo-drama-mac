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
const CPU_COUNT = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const DEFAULT_JOBS = Math.max(2, Math.min(4, Math.floor(CPU_COUNT / 2) || 2));
const DEFAULT_ENCODER = process.platform === 'darwin' ? 'videotoolbox' : process.platform === 'win32' ? 'auto' : 'cpu';
let windowsAdapters = '';
let windowsGpuReady = false;

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
  encoder: DEFAULT_ENCODER,
  quality: 'standard',
  jobs: DEFAULT_JOBS,
});

function validateOptions(input = {}) {
  const opts = { ...DEFAULTS, ...input };
  const numeric = [
    ['crop_ratio', 0.85, 1],
    ['speed_min', 1, 1.3],
    ['speed_max', 1, 1.3],
    ['rotation_max', 0, 0.02],
    ['rgb_shift', 0, 5],
    ['noise_min', 0, 15],
    ['noise_max', 0, 15],
    ['contrast', 0.9, 1.3],
    ['saturation', 0.8, 1.6],
    ['hue_range', 0, 30],
    ['pitch_min', 1, 1.1],
    ['pitch_max', 1, 1.1],
    ['orig_volume', 0.1, 1],
    ['bgm_volume', 0, 0.5],
    ['jobs', 1, 8],
  ];
  for (const [key, min, max] of numeric) {
    const value = opts[key];
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (['rgb_shift', 'noise_min', 'noise_max', 'hue_range', 'jobs'].includes(key) && !Number.isInteger(value))
    ) {
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
    CX: random(),
    CY: random(),
    NOISE: randint(opts.noise_min, opts.noise_max),
  };
}

function detectEncoder(requested, platform = process.platform, adapters = '') {
  if (requested !== 'auto') return requested;
  if (platform === 'darwin') return 'videotoolbox';
  if (platform === 'win32') {
    const names = Array.isArray(adapters) ? adapters.join('\n') : String(adapters || '');
    if (/nvidia/i.test(names)) return 'nvenc';
    if (/(amd|radeon)/i.test(names)) return 'amf';
    if (/(intel|uhd|iris|arc)/i.test(names)) return 'qsv';
  }
  return 'cpu';
}

function setWindowsAdapters(adapters) {
  windowsAdapters = Array.isArray(adapters) ? adapters.filter(Boolean).join('\n') : String(adapters || '');
  windowsGpuReady = true;
}

function resolveEncoder(requested, platform = process.platform) {
  if (requested !== 'auto' || platform !== 'win32') return detectEncoder(requested, platform);
  // 显卡名单由应用启动时写入。名单还没到时保持 auto，开始编码时再读缓存。
  if (!windowsGpuReady) return 'auto';
  return detectEncoder(requested, platform, windowsAdapters);
}

function encoderArgs(name, lean, width, height) {
  if (name === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', lean ? '24' : '21'];
  if (name === 'amf') return ['-c:v', 'h264_amf', '-quality', 'speed'];
  if (name === 'qsv') return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', lean ? '25' : '21'];
  if (name === 'videotoolbox') {
    let bitrate = Math.max(1500, Math.floor(width * height * 0.00386));
    if (lean) bitrate = Math.floor(bitrate / 2);
    return [
      '-c:v',
      'h264_videotoolbox',
      '-b:v',
      `${bitrate}k`,
      '-maxrate',
      `${Math.floor(bitrate * 1.5)}k`,
      '-bufsize',
      `${bitrate * 2}k`,
    ];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', lean ? '23' : '20'];
}

function buildCommand({ src, dst, bgm, opts: rawOpts, rolled, media, encoder, segments }) {
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
  const sourceDuration = media.video_duration > 0 ? media.video_duration : media.duration;
  const outputDuration = sourceDuration / speed + videoDelay;
  const vf = [
    `crop=iw*${opts.crop_ratio}:ih*${opts.crop_ratio}:x=(iw-ow)*${r.CX.toFixed(6)}:y=(ih-oh)*${r.CY.toFixed(6)}`,
  ];
  const filters = [];
  // 多个片段时，先在滤镜图里把它们按顺序接成一条，后面的处理和单个文件完全一致。
  const pieces = Array.isArray(segments) && segments.length ? segments : null;
  const joined = !!pieces && pieces.length > 1;
  if (joined) {
    const width0 = media.video_width,
      height0 = media.video_height;
    const labels = [];
    pieces.forEach((_, index) => {
      filters.push(`[${index}:V:0]setsar=1,scale=${width0}:${height0}[sv${index}]`);
      labels.push(`[sv${index}]`);
      if (hasAudio) {
        filters.push(
          `[${index}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[sa${index}]`,
        );
        labels.push(`[sa${index}]`);
      }
    });
    filters.push(`${labels.join('')}concat=n=${pieces.length}:v=1:a=${hasAudio ? 1 : 0}[cv]${hasAudio ? '[ca]' : ''}`);
  }
  const sourceVideo = joined ? '[cv]' : '[0:V:0]';
  const sourceAudio = joined ? '[ca]' : '[0:a:0]';
  let videoInput = sourceVideo;
  if (horizontal) {
    // Keep the source's landscape composition while filling the portrait canvas.
    filters.push(`${sourceVideo}split=2[bgsrc][fgsrc]`);
    filters.push(
      `[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=20:1,setsar=1[bg]`,
    );
    filters.push(`[fgsrc]${vf.join(',')},scale=${width}:-2,setsar=1[fg]`);
    filters.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[vbase]');
    videoInput = '[vbase]';
    vf.length = 0;
  }
  if (!horizontal) {
    if (r.ROT > 0) vf.push(`rotate=${r.ROT.toFixed(6)}:fillcolor=black`);
    vf.push(`scale=w='trunc(min(${width},${height}*dar)/2)*2':h='trunc(min(${height},${width}/dar)/2)*2'`, 'setsar=1');
  } else if (r.ROT > 0) {
    vf.push(
      `rotate=${r.ROT.toFixed(6)}:fillcolor=black`,
      `scale=w='trunc(min(${width},${height}*dar)/2)*2':h='trunc(min(${height},${width}/dar)/2)*2'`,
      'setsar=1',
    );
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
  const inputs = pieces
    ? pieces.flatMap((piece) => [
        '-ss',
        Number(piece.start).toFixed(3),
        '-t',
        Number(piece.duration).toFixed(3),
        '-i',
        piece.src,
      ])
    : ['-i', src];
  const bgmIndex = pieces ? pieces.length : 1;
  const audioOutput = hasAudio || Boolean(bgm);
  if (hasAudio) {
    const af = [
      'asetpts=PTS-STARTPTS',
      'aresample=44100',
      `asetrate=44100*${r.PITCH.toFixed(6)}`,
      'aresample=44100',
      `atempo=${(speed / r.PITCH).toFixed(6)}`,
    ];
    if (opts.eq_enable) af.push('equalizer=f=1200:t=q:w=1:g=1.5');
    if (audioDelay > 0) af.push(`adelay=delays=${(audioDelay * 1000).toFixed(3)}:all=1`);
    // 补静音只补到成片结束稍后一点，不用无限长的 apad：配合 -shortest 时，较老的 FFmpeg 会在收尾时报错。
    af.push(`volume=${opts.orig_volume}`, `apad=whole_dur=${(outputDuration + 1).toFixed(3)}`);
    filters.push(`${sourceAudio}${af.join(',')}[oa]`);
  }
  if (bgm) {
    inputs.push('-stream_loop', '-1', '-i', bgm);
    filters.push(`[${bgmIndex}:a:0]asetpts=PTS-STARTPTS,volume=${opts.bgm_volume}[ba]`);
  }
  if (audioOutput) {
    const source =
      hasAudio && bgm ? '[oa][ba]amix=inputs=2:duration=first:dropout_transition=0' : hasAudio ? '[oa]' : '[ba]';
    const separator = source.includes('amix=') ? ',' : '';
    filters.push(`${source}${separator}aformat=channel_layouts=stereo,aresample=async=1[a]`);
  }
  // The info-level mov muxer message is the only reliable start signal for
  // faststart's second pass; media timestamp progress stops during that pass.
  const args = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-nostdin',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[v]',
  ];
  if (audioOutput) args.push('-map', '[a]', '-shortest');
  args.push(
    '-fps_mode',
    'passthrough',
    '-pix_fmt',
    'yuv420p',
    ...encoderArgs(encoder, opts.quality === 'lean', width, height),
  );
  if (audioOutput) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-map_metadata', '-1', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', dst);
  // Audio/container duration can exceed the video. -shortest finishes at the
  // transformed video end, so the progress denominator must use that stream.
  return { args, rolled: r, duration: outputDuration };
}

function execJson(ffprobePath, args, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      ffprobePath,
      args,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error((stderr || error.message).trim().slice(-3000)));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`ffprobe 返回无效数据：${e.message}`));
        }
      },
    );
    const abort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      child.once('close', () => signal.removeEventListener('abort', abort));
    }
  });
}

async function probeMedia(ffprobePath, file, signal) {
  const data = await execJson(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,start_time:stream=codec_type,start_time,duration,width,height:stream_disposition=attached_pic',
      '-of',
      'json',
      file,
    ],
    signal,
  );
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const videos = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const start = (list) => (Number.isFinite(Number(list[0]?.start_time)) ? Number(list[0].start_time) : 0);
  const duration = Number(data.format?.duration);
  const streamDuration = Number(videos[0]?.duration);
  const formatStart = Number(data.format?.start_time) || 0;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    video_duration:
      Number.isFinite(streamDuration) && streamDuration > 0
        ? streamDuration
        : Math.max(0, (duration || 0) - Math.max(0, start(videos) - formatStart)),
    has_video: videos.length > 0,
    has_audio: audios.length > 0,
    video_width: Number(videos[0]?.width) || 0,
    video_height: Number(videos[0]?.height) || 0,
    video_start: start(videos),
    audio_start: start(audios),
  };
}

function tailPush(state, chunk) {
  state.text += chunk.toString('utf8');
  if (state.text.length > 10000) state.text = state.text.slice(-10000);
}

function runProcess(ffmpegPath, args, duration, onProgress, signal, onStage, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errors = { text: '' };
    let output = '';
    let abortKillTimer = null;
    let finalizing = false;
    let progressBlock = {};
    let lastProgressLog = null;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (signal) signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => {
      if (child.exitCode != null) return;
      child.kill('SIGTERM');
      abortKillTimer = setTimeout(() => {
        if (child.exitCode == null) child.kill('SIGKILL');
      }, 2000);
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    // A quiet process can still be draining an encoder, writing the trailer,
    // or moving a large MP4's index. Only cancellation or an actual process
    // failure may end the job; elapsed time and percentages are not failures.
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const lines = output.split(/\r?\n/);
      output = lines.pop() || '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator < 0) continue;
        const key = line.slice(0, separator),
          value = line.slice(separator + 1);
        progressBlock[key] = value;
        if (key === 'progress') {
          const now = Date.now();
          if (value === 'end' || lastProgressLog === null || now - lastProgressLog >= 10_000) {
            onLog?.(
              `[${value === 'end' ? '进度结束' : '编码进度'}] frame=${progressBlock.frame || 'N/A'} fps=${progressBlock.fps || 'N/A'} out_time=${progressBlock.out_time || 'N/A'} speed=${progressBlock.speed || 'N/A'}`,
            );
            lastProgressLog = now;
          }
          // FFmpeg also emits progress=end on failure. It is not a success
          // signal; only media timestamps estimate encoding progress.
          progressBlock = {};
          continue;
        }
        if (key !== 'out_time_us') continue;
        const elapsed = Number(value);
        if (Number.isFinite(elapsed) && duration > 0)
          onProgress?.(Math.max(0, Math.min(99, (elapsed / 1e6 / duration) * 100)));
      }
    });
    child.stderr.on('data', (chunk) => {
      tailPush(errors, chunk);
      if (!finalizing && /Starting second pass: moving the moov atom/i.test(errors.text)) {
        finalizing = true;
        onLog?.('[收尾] FFmpeg 正在将 MP4 播放索引移至文件开头');
        onStage?.('finalizing');
      }
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, sig) => {
      if (signal?.aborted) return finish(new Error('已取消'));
      if (code !== 0)
        return finish(
          new Error(`ffmpeg 退出码 ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}\n${errors.text.slice(-6000)}`),
        );
      finish();
    });
  });
}

async function sameFileOrPath(src, dst) {
  if (path.resolve(src) === path.resolve(dst)) return true;
  try {
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (_) {
    return false;
  }
}

async function runJob({
  ffmpegPath,
  ffprobePath,
  src,
  dst,
  segments = null,
  speed = null,
  bgm = null,
  opts,
  signal,
  onProgress,
  onLog,
  onStage,
}) {
  const options = validateOptions(opts);
  // segments：[{ src, start, duration }]，按顺序接成一条再处理；只传 src 就是整个文件。
  const pieces = Array.isArray(segments) && segments.length ? segments : null;
  const inputs = pieces ? pieces.map((piece) => piece.src) : [src];
  if (pieces) {
    for (const piece of pieces) {
      if (!Number.isFinite(piece.start) || piece.start < 0 || !Number.isFinite(piece.duration) || piece.duration <= 0)
        throw new Error('片段时间无效');
    }
  }
  if (inputs.some((file) => !path.isAbsolute(file)) || !path.isAbsolute(dst))
    throw new Error('输入和输出路径必须是绝对路径');
  for (const file of inputs) {
    if (await sameFileOrPath(file, dst)) throw new Error('输入与输出指向同一文件，已拒绝覆盖');
  }
  if (fs.existsSync(dst)) throw new Error(`输出已存在，已拒绝覆盖：${dst}`);
  if (speed != null && !(Number.isFinite(speed) && speed >= 0.5 && speed <= 2)) throw new Error('变速倍数无效');
  onStage?.('probing');
  let media;
  if (pieces) {
    const probed = new Map();
    for (const file of new Set(inputs)) probed.set(file, await probeMedia(ffprobePath, file, signal));
    const first = probed.get(inputs[0]);
    for (const [file, info] of probed) if (!info.has_video) throw new Error(`输入没有可用视频轨：${file}`);
    const withAudio = [...probed.values()].filter((info) => info.has_audio).length;
    if (withAudio !== 0 && withAudio !== probed.size) throw new Error('各集的音轨不一致，无法拼接');
    const total = pieces.reduce((sum, piece) => sum + piece.duration, 0);
    // 拼接后的时间轴从 0 开始，音画起点都是 0。
    media = {
      duration: total,
      video_duration: total,
      has_video: true,
      has_audio: withAudio > 0,
      video_width: first.video_width,
      video_height: first.video_height,
      video_start: 0,
      audio_start: 0,
    };
  } else {
    media = await probeMedia(ffprobePath, src, signal);
    if (!media.has_video) throw new Error(`输入没有可用视频轨：${src}`);
  }
  if (bgm) {
    const music = await probeMedia(ffprobePath, bgm, signal);
    if (!music.has_audio) throw new Error(`BGM 没有可用音频轨：${bgm}`);
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = path.join(path.dirname(dst), `.hongguo-quchong-${randomUUID()}.mp4`);
  let rolled;
  try {
    rolled = rollParams(options);
    // 重新拆分时变速倍数由规划阶段按成品时长算好，这里不再随机。
    if (speed != null) rolled.SPEED = speed;
    if (signal?.aborted) throw new Error('已取消');
    const encoder = await resolveEncoder(options.encoder, process.platform);
    const command = buildCommand({
      src: inputs[0],
      dst: tmp,
      bgm,
      opts: options,
      rolled,
      media,
      encoder,
      segments: pieces,
    });
    onLog?.(
      `[开始] ${path.basename(inputs[0])}${pieces ? ` 等 ${pieces.length} 段` : ''} 编码器=${encoder} 参数=${JSON.stringify(rolled)}`,
    );
    onStage?.('encoding');
    try {
      await runProcess(ffmpegPath, command.args, command.duration, onProgress, signal, onStage, onLog);
    } catch (error) {
      if (signal?.aborted) throw new Error('已取消');
      const nvencApi =
        encoder === 'nvenc' &&
        error.message.match(
          /Driver does not support the required nvenc API version\.\s*Required:\s*([\d.]+)\s+Found:\s*([\d.]+)/i,
        );
      if (nvencApi) {
        throw new Error(
          `NVENC 初始化失败：应用自带的 FFmpeg 需要 NVENC API ${nvencApi[1]}，当前显卡驱动提供 ${nvencApi[2]}，版本不兼容。需要使用与当前驱动 API 兼容的 FFmpeg 构建，未自动切换编码器。\n${error.message}`,
        );
      }
      if (encoder !== 'cpu') {
        throw new Error(`${encoder} 编码失败，未自动切换编码器，请检查对应显卡和驱动。\n${error.message}`);
      }
      throw error;
    }
    if (signal?.aborted) throw new Error('已取消');
    onStage?.('validating');
    const result = await probeMedia(ffprobePath, tmp, signal);
    const stat = await fsp.stat(tmp);
    if (!stat.size || !result.has_video) throw new Error('输出验证失败：文件为空或没有视频轨');
    if (signal?.aborted) throw new Error('已取消');
    onStage?.('saving');
    try {
      await fsp.link(tmp, dst);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`输出已存在，已拒绝覆盖：${dst}`);
      throw error;
    }
    onProgress?.(100);
    onLog?.(`[完成] ${path.basename(dst)}`);
    return { success: true, path: dst, rolled };
  } finally {
    try {
      await fsp.unlink(tmp);
    } catch (_) {}
  }
}

module.exports = {
  DEFAULTS,
  validateOptions,
  rollParams,
  detectEncoder,
  resolveEncoder,
  setWindowsAdapters,
  encoderArgs,
  buildCommand,
  probeMedia,
  runJob,
};
