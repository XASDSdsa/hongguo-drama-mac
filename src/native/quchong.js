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

// 默认只做便宜的调色、锐化和变速（每集在范围内随机取值）；旋转、RGB 偏移、噪点、暗角、变调、均衡器
// 都比较吃时间，默认关闭，需要时在参数面板里手动打开。
const DEFAULTS = Object.freeze({
  crop_ratio: 0.94,
  center_exclude: 20,
  speed_min: 1.03,
  speed_max: 1.21,
  brightness_min: -0.1445,
  brightness_max: 0.1474,
  contrast_min: 0.878,
  contrast_max: 1.1227,
  gamma_min: 0.8781,
  gamma_max: 1.1227,
  saturation_min: 0.7982,
  saturation_max: 1.2841,
  hue_min: -8.6,
  hue_max: 7.7,
  unsharp_min: -0.86,
  unsharp_max: 0.73,
  rotation_max: 0,
  rgb_shift: 0,
  noise_min: 0,
  noise_max: 0,
  vignette: false,
  pitch_min: 1,
  pitch_max: 1,
  orig_volume: 0.5,
  bgm_volume: 0.15,
  eq_enable: false,
  encoder: DEFAULT_ENCODER,
  quality: 'standard',
  jobs: DEFAULT_JOBS,
});

function validateOptions(input = {}) {
  const opts = { ...DEFAULTS, ...input };
  const numeric = [
    ['crop_ratio', 0.85, 1],
    ['center_exclude', 0, 90],
    ['speed_min', 1, 1.3],
    ['speed_max', 1, 1.3],
    ['rotation_max', 0, 0.02],
    ['rgb_shift', 0, 5],
    ['noise_min', 0, 15],
    ['noise_max', 0, 15],
    ['brightness_min', -0.5, 0.5],
    ['brightness_max', -0.5, 0.5],
    ['contrast_min', 0.5, 1.5],
    ['contrast_max', 0.5, 1.5],
    ['gamma_min', 0.5, 2],
    ['gamma_max', 0.5, 2],
    ['saturation_min', 0.3, 2],
    ['saturation_max', 0.3, 2],
    ['hue_min', -30, 30],
    ['hue_max', -30, 30],
    ['unsharp_min', -2, 2],
    ['unsharp_max', -2, 2],
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
      (['rgb_shift', 'noise_min', 'noise_max', 'jobs'].includes(key) && !Number.isInteger(value))
    ) {
      throw new Error(`参数无效：${key}`);
    }
  }
  for (const name of ['speed', 'pitch', 'noise', 'brightness', 'contrast', 'gamma', 'saturation', 'hue', 'unsharp']) {
    if (opts[`${name}_min`] > opts[`${name}_max`]) throw new Error('参数下限不能大于上限');
  }
  if (!['auto', 'cpu', 'videotoolbox', 'nvenc', 'amf', 'qsv'].includes(opts.encoder)) throw new Error('编码器无效');
  if (!['standard', 'lean'].includes(opts.quality)) throw new Error('画质选项无效');
  for (const key of ['vignette', 'eq_enable']) {
    if (typeof opts[key] !== 'boolean') throw new Error(`参数无效：${key}`);
  }
  return opts;
}

/**
 * 随机裁边的位置（0 = 靠一边，1 = 靠另一边）：避开正中间那一段。
 * exclude 是百分比，20 表示 0.4 ~ 0.6 之间不取，免得有的集正好裁在正中、和原画面几乎没区别。
 */
function offAxisCenter(random, exclude) {
  const gap = Math.min(0.9, Math.max(0, Number(exclude) / 100));
  const u = random() * (1 - gap);
  return u < 0.5 - gap / 2 ? u : u + gap;
}

function rollParams(opts, random = Math.random) {
  const randint = (min, max) => Math.floor(random() * (max - min + 1)) + min;
  const between = (min, max) => min + random() * (max - min);
  return {
    BRIGHTNESS: between(opts.brightness_min, opts.brightness_max),
    CONTRAST: between(opts.contrast_min, opts.contrast_max),
    GAMMA: between(opts.gamma_min, opts.gamma_max),
    SATURATION: between(opts.saturation_min, opts.saturation_max),
    HUE: between(opts.hue_min, opts.hue_max),
    UNSHARP: between(opts.unsharp_min, opts.unsharp_max),
    SPEED: between(opts.speed_min, opts.speed_max),
    PITCH: between(opts.pitch_min, opts.pitch_max),
    ROT: between(0, opts.rotation_max),
    CX: offAxisCenter(random, opts.center_exclude),
    CY: offAxisCenter(random, opts.center_exclude),
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

// Windows「自动」时实际试编一帧，确认显卡编码真的能用：很多笔记本是没有 NVENC 的 GeForce MX / GT 1030，
// 或者驱动太旧。按显卡顺序试 NVENC → QSV → AMF，都不行就用 CPU。每个 FFmpeg 只试一次，结果缓存。
const encoderProbes = new Map();
const ADAPTER_PATTERN = { nvenc: /nvidia/i, qsv: /(intel|uhd|iris|arc)/i, amf: /(amd|radeon)/i };

function probeEncoder(ffmpegPath, name) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      [
        '-hide_banner',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=256x256:d=0.2',
        '-frames:v',
        '1',
        '-pix_fmt',
        'yuv420p',
        ...encoderArgs(name, false, 256, 256),
        '-f',
        'null',
        '-',
      ],
      { windowsHide: true, timeout: 20000 },
      (error) => resolve(!error),
    );
  });
}

async function resolveWorkingEncoder(requested, ffmpegPath, platform = process.platform) {
  const picked = resolveEncoder(requested, platform);
  if (requested !== 'auto' || platform !== 'win32' || !ffmpegPath || ['cpu', 'auto'].includes(picked)) return picked;
  // 首选显卡编码试编成功就一直用；退到别的编码器时只记 10 分钟（可能只是当时显卡正忙），之后再试一次首选。
  const cached = encoderProbes.get(ffmpegPath);
  if (cached && !(cached.fallback && Date.now() - cached.at > 10 * 60 * 1000)) return cached.promise;
  const entry = { at: Date.now(), fallback: false, promise: null };
  entry.promise = (async () => {
    const order = [
      ...new Set([picked, ...['nvenc', 'qsv', 'amf'].filter((name) => ADAPTER_PATTERN[name].test(windowsAdapters))]),
    ];
    for (const name of order)
      if (await probeEncoder(ffmpegPath, name)) {
        entry.fallback = name !== picked;
        return name;
      }
    entry.fallback = true;
    return 'cpu';
  })();
  encoderProbes.set(ffmpegPath, entry);
  return entry.promise;
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

/** 原声的处理链：整条滤镜图里和“分开处理音频”那一步用的是同一份，保证两条路出来的声音一样。 */
function audioChain({ safe, speed, pitch, eq, volume, audioDelay, padTo }) {
  // 音调没变（默认）时只需要变速，不用 asetrate 折腾一圈。
  const shifted = !safe && Math.abs(pitch - 1) > 1e-6;
  const af = shifted
    ? [
        'asetpts=PTS-STARTPTS',
        'aresample=44100',
        `asetrate=44100*${pitch.toFixed(6)}`,
        'aresample=44100',
        `atempo=${(speed / pitch).toFixed(6)}`,
      ]
    : ['asetpts=PTS-STARTPTS', 'aresample=44100', `atempo=${speed.toFixed(6)}`];
  if (eq && !safe) af.push('equalizer=f=1200:t=q:w=1:g=1.5');
  if (audioDelay > 0) af.push(`adelay=delays=${(audioDelay * 1000).toFixed(3)}:all=1`);
  af.push(`volume=${volume}`);
  // 补静音只补到成片结束稍后一点，不用无限长的 apad：配合 -shortest 时，较老的 FFmpeg 会在收尾时报错。
  if (!safe && padTo) af.push(`apad=whole_dur=${padTo.toFixed(3)}`);
  return af;
}

function buildCommand({ src, dst, bgm, opts: rawOpts, rolled, media, encoder, audioMode = 'full' }) {
  const opts = validateOptions(rawOpts);
  const r = rolled || rollParams(opts);
  // 不改分辨率：成品和原视频一样大（宽高取偶数）。裁掉边缘后再放回原尺寸，不加黑边、不横竖屏改构图。
  const even = (value) => Math.max(2, Math.floor(Number(value) / 2) * 2);
  const width = even(media.video_width);
  const height = even(media.video_height);
  const speed = r.SPEED;
  // external：音频交给单独的几步处理（见 renderAudioSeparately），这条命令只出视频，不碰音轨也不混 BGM。
  const external = audioMode === 'external';
  const sourceHasAudio = media.has_audio;
  const hasAudio = sourceHasAudio && !external;
  const origin = sourceHasAudio ? Math.min(media.video_start, media.audio_start) : media.video_start;
  const videoDelay = Math.max(0, (media.video_start - origin) / speed);
  const audioDelay = Math.max(0, (media.audio_start - origin) / speed);
  const sourceDuration = media.video_duration > 0 ? media.video_duration : media.duration;
  const outputDuration = sourceDuration / speed + videoDelay;
  const vf = [
    `crop=iw*${opts.crop_ratio}:ih*${opts.crop_ratio}:x=(iw-ow)*${r.CX.toFixed(6)}:y=(ih-oh)*${r.CY.toFixed(6)}`,
  ];
  const filters = [];
  const videoInput = '[0:V:0]';
  const sourceAudio = '[0:a:0]';
  if (r.ROT > 0) vf.push(`rotate=${r.ROT.toFixed(6)}:fillcolor=black`);
  // 裁剪和旋转会改变尺寸，这里统一缩回原来的大小。
  vf.push(`scale=${width}:${height}`, 'setsar=1');
  // rgbashift 只能在 RGB 里做，噪点也留在 RGB 里加（和以前的画面效果、码率一致），
  // 加完立刻转回 yuv420p：以前整条后续滤镜链都按 4:4:4 全分辨率在跑，数据量翻倍，白白变慢。
  if (opts.rgb_shift > 0) vf.push(`rgbashift=rh=${opts.rgb_shift}:rv=1:gh=0:gv=0:bh=-${opts.rgb_shift}:bv=1`);
  if (r.NOISE > 0) vf.push(`noise=alls=${r.NOISE}:allf=t`);
  if (opts.rgb_shift > 0) vf.push('format=yuv420p');
  // 锐化量为负是轻微模糊；接近 0 时等于什么都没做，直接跳过省时间。3×3 比 5×5 快三成。
  if (Math.abs(r.UNSHARP) >= 0.05) vf.push(`unsharp=3:3:${r.UNSHARP.toFixed(4)}`);
  vf.push(`setpts=(PTS-STARTPTS)/${speed.toFixed(6)}`);
  vf.push(
    `eq=brightness=${r.BRIGHTNESS.toFixed(4)}:contrast=${r.CONTRAST.toFixed(4)}:gamma=${r.GAMMA.toFixed(4)}:saturation=${r.SATURATION.toFixed(4)},hue=h=${r.HUE.toFixed(2)}`,
  );
  // dither=0：关掉暗角自带的逐像素抖动，肉眼看不出，但每帧省不少计算。
  if (opts.vignette) vf.push('vignette=PI/5:dither=0');
  if (videoDelay > 0) vf.push(`tpad=start_duration=${videoDelay.toFixed(6)}:color=black`);

  filters.push(`${videoInput}${vf.join(',')}[v]`);
  const inputs = ['-i', src];
  const bgmIndex = 1;
  const audioOutput = hasAudio || (Boolean(bgm) && !external);
  if (hasAudio) {
    // safe：音频编码反复失败时的最简音频链——只变速，不改音高、不均衡、不补静音，换取这一集能出成品。
    const safe = audioMode === 'safe';
    const af = audioChain({
      safe,
      speed,
      pitch: r.PITCH,
      eq: opts.eq_enable,
      volume: opts.orig_volume,
      audioDelay,
      padTo: outputDuration + 1,
    });
    filters.push(`${sourceAudio}${af.join(',')}[oa]`);
  }
  if (bgm && !external) {
    inputs.push('-stream_loop', '-1', '-i', bgm);
    filters.push(`[${bgmIndex}:a:0]asetpts=PTS-STARTPTS,volume=${opts.bgm_volume}[ba]`);
  }
  if (audioOutput) {
    const source =
      hasAudio && bgm ? '[oa][ba]amix=inputs=2:duration=first:dropout_transition=0' : hasAudio ? '[oa]' : '[ba]';
    const separator = source.includes('amix=') ? ',' : '';
    filters.push(
      `${source}${separator}aformat=channel_layouts=stereo${audioMode === 'safe' ? '' : ',aresample=async=1'}[a]`,
    );
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
  else args.push('-an');
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
  return { args, rolled: r, duration: outputDuration, filters: filters.join(';'), audioDelay, speed };
}

function execJson(ffprobePath, args, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      ffprobePath,
      args,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, windowsHide: true, timeout: 120000 },
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
      'format=duration,start_time:stream=codec_type,start_time,duration,width,height,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate',
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
  // 手机拍的竖屏视频常常是「横着存 + 旋转 90°」：FFmpeg 解码时会自动转正，所以宽高要按转正后的算，
  // 否则成品会被压扁。
  const sideRotation = (videos[0]?.side_data_list || []).find((item) => item && item.rotation != null)?.rotation;
  const rotation = Number(sideRotation ?? videos[0]?.tags?.rotate ?? 0) || 0;
  const turned = Math.abs(Math.round(rotation)) % 180 === 90;
  // 像素不是正方形（SAR 不是 1:1，少见的变形存储）时按显示宽度算，否则成品会被压窄。
  const [sarNum, sarDen] = String(videos[0]?.sample_aspect_ratio || '1:1')
    .split(':')
    .map(Number);
  const sar = sarNum > 0 && sarDen > 0 ? sarNum / sarDen : 1;
  const codedWidth = Math.round((Number(videos[0]?.width) || 0) * sar);
  const codedHeight = Number(videos[0]?.height) || 0;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    video_duration:
      Number.isFinite(streamDuration) && streamDuration > 0
        ? streamDuration
        : Math.max(0, (duration || 0) - Math.max(0, start(videos) - formatStart)),
    has_video: videos.length > 0,
    has_audio: audios.length > 0,
    video_width: turned ? codedHeight : codedWidth,
    video_height: turned ? codedWidth : codedHeight,
    video_start: start(videos),
    audio_start: start(audios),
  };
}

const ENCODER_RETRY_DELAYS = [1500, 4000];
const DISK_FULL = /No space left on device|ENOSPC|There is not enough space on the disk/i;
function diskFullError(error) {
  return new Error(`磁盘空间不足：输出位置所在的磁盘写满了，请清理磁盘后再处理。\n${error.message}`);
}
/**
 * 报错里说「没有空间」时再看一眼磁盘真实剩余空间：个别 FFmpeg 版本的滤镜内部也会报这句话（磁盘其实还有很多空间），
 * 不能因此把整批停掉。读不到剩余空间时相信报错。
 */
async function reallyOutOfSpace(message, dir) {
  if (!DISK_FULL.test(message)) return false;
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize) < 1024 ** 3;
  } catch (_) {
    return true;
  }
}

// 显卡编码会话：NVIDIA 消费级显卡同时能开的编码会话有限（旧驱动 3 个、新驱动 8 个，OBS、录屏软件也会占用）。
// 遇到「会话已满」不算失败：把上限降到现在正在用的数量，多出来的集排队，等别的集编完再继续。
// 上限每过一分钟没再遇到「已满」就放宽一路（录屏软件关掉后能慢慢恢复）；全部空闲后完全恢复。
const NVENC_SESSION_FULL = /OpenEncodeSessionEx failed: (out of memory \(10\)|incompatible client key \(21\))/i;
const hwSessions = { limit: Infinity, active: 0, waiters: [], lastFullAt: 0 };

function acquireHwSession(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消'));
    if (hwSessions.active < hwSessions.limit) {
      hwSessions.active += 1;
      return resolve();
    }
    const waiter = { resolve, reject, signal };
    const onAbort = () => {
      const index = hwSessions.waiters.indexOf(waiter);
      if (index >= 0) hwSessions.waiters.splice(index, 1);
      reject(new Error('已取消'));
    };
    waiter.onAbort = onAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
    hwSessions.waiters.push(waiter);
  });
}

function releaseHwSession() {
  hwSessions.active = Math.max(0, hwSessions.active - 1);
  if (hwSessions.active === 0 && !hwSessions.waiters.length) hwSessions.limit = Infinity;
  else if (Number.isFinite(hwSessions.limit) && Date.now() - hwSessions.lastFullAt > 60_000) {
    hwSessions.limit += 1;
    hwSessions.lastFullAt = Date.now();
  }
  while (hwSessions.waiters.length && hwSessions.active < hwSessions.limit) {
    const next = hwSessions.waiters.shift();
    next.signal?.removeEventListener('abort', next.onAbort);
    hwSessions.active += 1;
    next.resolve();
  }
}
// FFmpeg 7 把失败的输出流写在日志里：aost#0:1/aac 是音频编码器。收尾时的 [aac @ …] Qavg 统计行不代表音频失败。
const AUDIO_FAILURE = /aost#\d+:\d+\/aac[^\n]*(error code|Terminating thread|Invalid argument)/i;

// 一次失败里，FFmpeg 会在「真正出错的那一路」之后，把被连累退出的每一路（包括没出错的音频编码器）
// 也打印成 "Task finished with error code: -22"。这些行只是连累，不是原因。
const COLLATERAL =
  /Task finished with error code|Terminating thread with return code|Conversion failed|Nothing was written|Could not open encoder before EOF|Error sending frames to consumers|Qavg|^frame=|^size=/i;
const ERROR_WORDS =
  /error|invalid|fail|cannot|can't|could not|unable|not supported|no such|incompatible|out of range|too many|do not match|mismatch|impossible/i;
const HEADER_LINE =
  /^(Input #|Output #|Stream #|Stream mapping|Metadata:|Duration:|major_brand|minor_version|compatible_brands|encoder\s*:|comment\s*:|handler_name|vendor_id|Side data|cpb:)/i;
const AUDIO_ONLY_SOURCE =
  /aost#|enc:aac|\[aac @|Parsed_(aresample|aformat|atempo|asetrate|adelay|apad|volume|amix|asetpts|equalizer|anull)/i;

/** 最先出现的、真正的报错行（不是被连累打印的那些）。没有就返回空串。 */
function rootCause(message) {
  const lines = String(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !HEADER_LINE.test(line) && !COLLATERAL.test(line) && ERROR_WORDS.test(line)) || '';
}

/** 失败真的出在音频编码上：有 aac 的报错，而且在它之前没有别的路先出错。 */
function isAudioEncoderFailure(message) {
  if (!AUDIO_FAILURE.test(message)) return false;
  const root = rootCause(message);
  return !root || AUDIO_ONLY_SOURCE.test(root);
}

/** 从 FFmpeg 的一大段输出里挑出真正的报错行：输入文件信息放在最前面，直接截头会把原因截掉。 */
function keyDiagnostics(message) {
  const lines = String(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exit = lines.find((line) => /^ffmpeg 退出码/.test(line)) || '';
  const hits = lines.filter(
    (line) =>
      !/^(Input #|Stream #|Metadata:|Duration:|major_brand|minor_version|compatible_brands|encoder\s*:|comment\s*:)/i.test(
        line,
      ) &&
      /error|invalid|fail|cannot|can't|unable|not supported|no such|unknown|incompatible|out of range|too many|session/i.test(
        line,
      ),
  );
  // 最先出现的真正原因排第一，再跟最后几行报错；中间被连累打印的重复行不重复写。
  const root = rootCause(message);
  const picked = [...new Set([root, ...hits.slice(-3)].filter(Boolean))].slice(0, 4).join(' / ');
  return (picked || lines.slice(-2).join(' / ') || exit).slice(0, 300);
}

function tailPush(state, chunk) {
  state.text += chunk.toString('utf8');
  if (state.text.length > 10000) state.text = state.text.slice(-10000);
}

function runProcess(ffmpegPath, args, duration, onProgress, signal, onStage, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
      // 日志很长时开头会被截掉：第一个真正的报错行先记下来，最后一起带上。
      if (!errors.first) errors.first = rootCause(errors.text);
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
          new Error(
            `ffmpeg 退出码 ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}\n${
              errors.first && !errors.text.slice(-6000).includes(errors.first) ? `${errors.first}\n` : ''
            }${errors.text.slice(-6000)}`,
          ),
        );
      finish();
    });
  });
}

/**
 * 把同一文件夹里的临时成品改成正式名字，绝不覆盖已有文件。
 * 优先用硬链接（目标已存在时直接失败）；U 盘、移动硬盘常见的 FAT32/exFAT 和部分网络盘不支持硬链接，
 * 这时先确认目标不存在再改名（同一文件夹内改名不占额外空间）。
 */
async function publishOutput(tmp, dst) {
  try {
    await fsp.link(tmp, dst);
    return;
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`输出已存在，已拒绝覆盖：${dst}`);
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS', 'EINVAL', 'EISDIR'].includes(error.code)) throw error;
  }
  if (fs.existsSync(dst)) throw new Error(`输出已存在，已拒绝覆盖：${dst}`);
  await fsp.rename(tmp, dst);
}

/**
 * 删掉文件夹里上次中断（崩溃、断电、强制退出）留下的临时文件：.ai-drama-quchong-*.mp4 / -pre-*.mkv / -sep-* 目录。
 * 只删超过 maxAgeMs 没动过的，正在写的临时文件一直在更新修改时间，不会被误删。
 */
async function sweepStaleTemps(dir, maxAgeMs = 2 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (_) {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith('.ai-drama-quchong-')) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (Date.now() - stat.mtimeMs < maxAgeMs) continue;
      await fsp.rm(full, { recursive: true, force: true });
      removed += 1;
    } catch (_) {}
  }
  return removed;
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

/**
 * 保底：同一条命令里音频编码反复失败时，视频和音频分开做。
 * 视频照常出（不带声音）；原声单独解成标准 PCM，最后才编码成 AAC，和视频直接封装在一起。
 * 这样 AAC 编码器吃到的是干净、规整的音频，不受原视频里各种怪时间戳、怪声道的影响。
 */
async function renderSeparately({
  ffmpegPath,
  build,
  src,
  bgm,
  options,
  rolled,
  speed,
  output,
  signal,
  onProgress,
  onLog,
  onStage,
}) {
  const work = path.join(path.dirname(output), `.ai-drama-quchong-sep-${randomUUID()}`);
  await fsp.mkdir(work, { recursive: true });
  const quiet = (args) =>
    runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], 0, null, signal);
  try {
    const videoFile = path.join(work, 'video.mp4');
    const command = build('external', videoFile);
    onLog?.('[降级] 视频和音频改为分开处理：先出画面，再把原声单独转成标准格式后编码');
    await runProcess(
      ffmpegPath,
      command.args,
      command.duration,
      (value) => onProgress?.(value * 0.9),
      signal,
      onStage,
      onLog,
    );
    onStage?.('finalizing');
    // 原声单独解成标准 PCM（44.1k 立体声），后面的编码只吃这份干净的音频。
    const full = path.join(work, 'audio.wav');
    await quiet(['-i', src, '-map', '0:a:0', '-vn', '-sn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', full]);
    const audioFile = path.join(work, 'audio.m4a');
    const encode = async (safe) => {
      const filters = [
        `[0:a:0]${audioChain({
          safe,
          speed,
          pitch: rolled.PITCH,
          eq: options.eq_enable,
          volume: options.orig_volume,
          audioDelay: command.audioDelay,
          // 原声比画面短时补静音到画面长度：合并时不能让短的音轨把画面截短。
          padTo: command.duration,
        }).join(',')}[oa]`,
      ];
      const inputs = ['-i', full];
      let source = '[oa]';
      if (bgm) {
        inputs.push('-stream_loop', '-1', '-i', bgm);
        filters.push(`[1:a:0]asetpts=PTS-STARTPTS,volume=${options.bgm_volume}[ba]`);
        source = '[oa][ba]amix=inputs=2:duration=first:dropout_transition=0,';
      }
      filters.push(`${source}aformat=channel_layouts=stereo[a]`);
      await quiet([
        ...inputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[a]',
        '-t',
        command.duration.toFixed(3),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        audioFile,
      ]);
    };
    try {
      await encode(false);
    } catch (error) {
      if (signal?.aborted) throw error;
      onLog?.(`[降级] 分开编码音频仍失败（${keyDiagnostics(error.message)}），改用只变速的最简音频处理`);
      await encode(true);
    }
    await quiet([
      '-i',
      videoFile,
      '-i',
      audioFile,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      // 音轨在上一步已按画面长度截好（-t），这里不用 -shortest：音轨短时它会把画面一起截短。
      '-map_metadata',
      '-1',
      '-movflags',
      '+faststart',
      output,
    ]);
    return command;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** 单个视频：加去重特效，重新编码成成品。 */
async function encodeOne({
  ffmpegPath,
  ffprobePath,
  src,
  dst,
  speed = null,
  bgm = null,
  opts,
  signal,
  onProgress,
  onLog,
  onStage,
}) {
  const startedAt = Date.now();
  const options = validateOptions(opts);
  const inputs = [src];
  if (inputs.some((file) => !path.isAbsolute(file)) || !path.isAbsolute(dst))
    throw new Error('输入和输出路径必须是绝对路径');
  for (const file of inputs) {
    if (await sameFileOrPath(file, dst)) throw new Error('输入与输出指向同一文件，已拒绝覆盖');
  }
  if (fs.existsSync(dst)) throw new Error(`输出已存在，已拒绝覆盖：${dst}`);
  if (speed != null && !(Number.isFinite(speed) && speed >= 0.5 && speed <= 2)) throw new Error('变速倍数无效');
  onStage?.('probing');
  const media = await probeMedia(ffprobePath, src, signal);
  if (!media.has_video) throw new Error(`输入没有可用视频轨：${src}`);
  if (bgm) {
    const music = await probeMedia(ffprobePath, bgm, signal);
    if (!music.has_audio) throw new Error(`BGM 没有可用音频轨：${bgm}`);
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = path.join(path.dirname(dst), `.ai-drama-quchong-${randomUUID()}.mp4`);
  let rolled;
  let holdingSession = false;
  try {
    rolled = rollParams(options);
    // 重新拆分时变速已经在前一步做完，这一步固定按 1 倍走。
    if (speed != null) rolled.SPEED = speed;
    if (signal?.aborted) throw new Error('已取消');
    const firstChoice = resolveEncoder(options.encoder, process.platform);
    const encoder = await resolveWorkingEncoder(options.encoder, ffmpegPath, process.platform);
    if (encoder !== firstChoice && firstChoice !== 'auto')
      onLog?.(`[编码器] 这台电脑的显卡编码（${firstChoice}）试编失败，改用 ${encoder === 'cpu' ? 'CPU' : encoder}`);
    const build = (audioMode, output = tmp) =>
      buildCommand({
        src: inputs[0],
        dst: output,
        bgm,
        opts: options,
        rolled,
        media,
        encoder,
        audioMode,
      });
    let command = build('full');
    onLog?.(`[开始] ${path.basename(dst)} 编码器=${encoder} 参数=${JSON.stringify(rolled)}`);
    onStage?.('encoding');
    // 硬件编码器同时开多路时偶尔会初始化失败（同一秒起 4 路最常见），隔几秒重来一次就好了；
    // 重试用的仍是同一个编码器，不会悄悄换成别的。显卡驱动版本不兼容这类必然失败的不重试。
    const retryable = encoder !== 'cpu' && encoder !== 'auto';
    if (encoder === 'nvenc') {
      await acquireHwSession(signal);
      holdingSession = true;
    }
    let audioStep = 0;
    let sessionWaits = 0;
    let soloSessionFails = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await runProcess(ffmpegPath, command.args, command.duration, onProgress, signal, onStage, onLog);
        break;
      } catch (error) {
        if (signal?.aborted) throw new Error('已取消');
        // 磁盘写满：换参数、换编码器、重试都没用，直接说清楚（批次会停下剩下的集）。
        if (await reallyOutOfSpace(error.message, path.dirname(dst))) throw diskFullError(error);
        // 显卡编码会话已满：排队等别的集编完再来，不算失败、不占重试次数。
        // 我们自己没有别的集在用显卡却还是满的（会话全被别的软件占着、显存不够）：等也没用，试两次就按失败处理。
        const othersHolding = hwSessions.active - (holdingSession ? 1 : 0) > 0;
        if (!othersHolding && NVENC_SESSION_FULL.test(error.message)) soloSessionFails += 1;
        if (
          encoder === 'nvenc' &&
          NVENC_SESSION_FULL.test(error.message) &&
          sessionWaits < 40 &&
          soloSessionFails <= 2
        ) {
          sessionWaits += 1;
          hwSessions.lastFullAt = Date.now();
          hwSessions.limit = Math.max(1, hwSessions.active - 1);
          releaseHwSession();
          holdingSession = false;
          if (sessionWaits === 1)
            onLog?.(
              `[排队] 显卡同时编码的数量到上限了（同时处理的集数太多，或录屏等软件占用），这一集等别的集编完再继续（同时最多 ${hwSessions.limit} 路）`,
            );
          onProgress?.(0);
          await new Promise((resolve) => setTimeout(resolve, 1500 + Math.floor(Math.random() * 1500)));
          await acquireHwSession(signal);
          holdingSession = true;
          attempt -= 1;
          continue;
        }
        const nvencApi =
          encoder === 'nvenc' &&
          error.message.match(
            /Driver does not support the required nvenc API version\.\s*Required:\s*([\d.]+)\s+Found:\s*([\d.]+)/i,
          );
        if (nvencApi) {
          throw new Error(
            `NVENC 初始化失败：应用自带的 FFmpeg 需要 NVENC API ${nvencApi[1]}，当前显卡驱动提供 ${nvencApi[2]}，版本不兼容。请更新 NVIDIA 显卡驱动，或在「设置 → 去重编码方式」改成「只用 CPU」后重试；未自动切换编码器。\n${error.message}`,
          );
        }
        // 失败在音频编码上（和显卡无关）：同样的参数再来一遍也一样会失败，所以先换一组随机参数，再不行用最简音频链。
        if (isAudioEncoderFailure(error.message)) {
          if (audioStep < 2) {
            audioStep += 1;
            if (audioStep === 1) {
              rolled = rollParams(options);
              if (speed != null) rolled.SPEED = speed;
            }
            command = build(audioStep === 2 ? 'safe' : 'full');
            onLog?.(
              audioStep === 1
                ? `[重试] 音频编码失败（${keyDiagnostics(error.message)}），换一组随机参数重来`
                : `[降级] 音频编码仍失败，这一集改用最简音频处理（只变速，不改音高）`,
            );
            onProgress?.(0);
            continue;
          }
          // 最后一招：视频和音频分开做。没有原声的素材不会走到这里（失败只可能出在 BGM/编码器上）。
          if (audioStep === 2 && media.has_audio) {
            audioStep = 3;
            onProgress?.(0);
            try {
              await renderSeparately({
                ffmpegPath,
                build,
                src: inputs[0],
                bgm,
                options,
                rolled,
                speed: rolled.SPEED,
                output: tmp,
                signal,
                onProgress,
                onLog,
                onStage,
              });
              break;
            } catch (separateError) {
              if (signal?.aborted) throw new Error('已取消');
              throw new Error(
                `音频编码失败（已换参数、简化音频、视频音频分开处理后仍失败），与显卡/编码器无关。原因：${keyDiagnostics(error.message)}；分开处理时：${keyDiagnostics(separateError.message)}\n[滤镜] ${command.filters}\n${error.message}`,
              );
            }
          }
          throw new Error(
            `音频编码失败（已换参数、简化音频后仍失败），与显卡/编码器无关。原因：${keyDiagnostics(error.message)}\n[滤镜] ${command.filters}\n${error.message}`,
          );
        }
        if (retryable && attempt < ENCODER_RETRY_DELAYS.length) {
          const wait =
            ENCODER_RETRY_DELAYS[attempt] + Math.floor(Math.random() * Math.min(1500, ENCODER_RETRY_DELAYS[attempt]));
          onLog?.(
            `[重试] ${encoder} 编码失败（${keyDiagnostics(error.message)}），${Math.round(wait / 100) / 10} 秒后第 ${attempt + 2} 次尝试`,
          );
          onProgress?.(0);
          await new Promise((resolve) => setTimeout(resolve, wait));
          if (signal?.aborted) throw new Error('已取消');
          continue;
        }
        if (encoder === 'nvenc' && NVENC_SESSION_FULL.test(error.message)) {
          throw new Error(
            `显卡编码器打不开：显卡的编码通道被别的软件（录屏、直播、另一个剪辑软件）占满，或显存不够。请关掉这些软件后重试，或在「设置 → 去重编码方式」改成「只用 CPU」。\n${error.message}`,
          );
        }
        if (encoder !== 'cpu') {
          throw new Error(
            `${encoder} 编码失败${attempt ? `（已重试 ${attempt} 次）` : ''}，未自动切换编码器。可在「设置 → 去重编码方式」改成「只用 CPU」后重试。原因：${keyDiagnostics(error.message)}\n${error.message}`,
          );
        }
        throw error;
      }
    }
    // 编码做完就把显卡会话让给排队的集，检查和保存不占会话。
    if (holdingSession) {
      holdingSession = false;
      releaseHwSession();
    }
    if (signal?.aborted) throw new Error('已取消');
    onStage?.('validating');
    const result = await probeMedia(ffprobePath, tmp, signal);
    const stat = await fsp.stat(tmp);
    if (!stat.size || !result.has_video) throw new Error('输出验证失败：文件为空或没有视频轨');
    if (signal?.aborted) throw new Error('已取消');
    onStage?.('saving');
    await publishOutput(tmp, dst);
    onProgress?.(100);
    onLog?.(`[完成] ${path.basename(dst)}`);
    return {
      success: true,
      path: dst,
      rolled,
      encodeSeconds: (Date.now() - startedAt) / 1000,
      outputSeconds: Number(result.duration) || 0,
    };
  } finally {
    if (holdingSession) releaseHwSession();
    try {
      await fsp.unlink(tmp);
    } catch (_) {}
  }
}

/**
 * 第一步（重新拆分）：每一段按自己的倍数变速，首尾接成一集，存成「去重前」的中间文件。
 * 视频用高质量 x264，声音存成 PCM（不经过 AAC），所以这一步不会碰到 AAC 编码；
 * 后面的去重特效和重新编码只面对这一个干净的文件。
 */
function buildPrepareCommand({ segments, media, dst }) {
  const even = (value) => Math.max(2, Math.floor(Number(value) / 2) * 2);
  const width = even(media.video_width);
  const height = even(media.video_height);
  const filters = [];
  const labels = [];
  segments.forEach((segment, index) => {
    const speed = segment.speed ?? 1;
    // 各集画面比例不同时按比例缩小再补黑边，不拉伸变形；尺寸相同时这两步什么都不做。
    // 先缩放再定 setsar：缩放会按新旧尺寸改写像素宽高比，顺序反了各段的 SAR 对不上，concat 会直接报 Invalid argument。
    // 第一个 scale 把非正方形像素（少见）还原成正方形，正常素材是原样通过。
    filters.push(
      `[${index}:V:0]scale=trunc(iw*sar/2)*2:ih,setsar=1,` +
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=(PTS-STARTPTS)/${speed.toFixed(6)}[sv${index}]`,
    );
    labels.push(`[sv${index}]`);
    if (media.has_audio) {
      if (segment.has_audio === false) {
        // 这一集没有音轨（个别集）：补同样长度的静音，别的集照常拼接。
        const seconds = (Number(segment.duration) / speed).toFixed(6);
        filters.push(
          `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${seconds},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[sa${index}]`,
        );
      } else {
        const tempo = speed === 1 ? '' : `,atempo=${speed.toFixed(6)}`;
        filters.push(
          `[${index}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS${tempo}[sa${index}]`,
        );
      }
      labels.push(`[sa${index}]`);
    }
  });
  filters.push(
    `${labels.join('')}concat=n=${segments.length}:v=1:a=${media.has_audio ? 1 : 0}[v]${media.has_audio ? '[a]' : ''}`,
  );
  const args = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-nostdin',
    '-y',
    ...segments.flatMap((segment) => [
      '-ss',
      Number(segment.start).toFixed(3),
      '-t',
      Number(segment.duration).toFixed(3),
      '-i',
      segment.src,
    ]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[v]',
  ];
  if (media.has_audio) args.push('-map', '[a]');
  // 中间文件只给下一步读：用最快的预设和很低的 crf（几乎无损），换时间；文件大一点没关系，用完就删。
  args.push('-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p');
  if (media.has_audio) args.push('-c:a', 'pcm_s16le');
  args.push('-progress', 'pipe:1', '-nostats', dst);
  const duration = segments.reduce((sum, segment) => sum + segment.duration / (segment.speed ?? 1), 0);
  return { args, duration, filters: filters.join(';') };
}

/**
 * 一集成品。只传 src：整个文件加去重特效、重新编码。
 * 传 segments（[{ src, start, duration, speed }]，重新拆分）：
 *   ① 各段按各自倍数变速并接成一集，存成去重前的中间文件；
 *   ② 对中间文件统一加去重特效、重新编码，成品写好后中间文件删除。
 */
async function runJob(args) {
  const { segments } = args;
  if (!Array.isArray(segments) || !segments.length) return encodeOne(args);
  const { ffmpegPath, ffprobePath, dst, signal, onProgress, onLog, onStage } = args;
  const parts = segments.map((segment) => ({
    src: segment.src,
    start: Number(segment.start),
    duration: Number(segment.duration),
    speed: segment.speed == null ? 1 : Number(segment.speed),
  }));
  for (const part of parts) {
    if (!Number.isFinite(part.start) || part.start < 0 || !Number.isFinite(part.duration) || part.duration <= 0)
      throw new Error('片段时间无效');
    if (!(part.speed >= 0.5 && part.speed <= 2)) throw new Error('变速倍数无效');
  }
  const files = [...new Set(parts.map((part) => part.src))];
  if (files.some((file) => !path.isAbsolute(file)) || !path.isAbsolute(dst))
    throw new Error('输入和输出路径必须是绝对路径');
  for (const file of files) {
    if (await sameFileOrPath(file, dst)) throw new Error('输入与输出指向同一文件，已拒绝覆盖');
  }
  if (fs.existsSync(dst)) throw new Error(`输出已存在，已拒绝覆盖：${dst}`);
  onStage?.('probing');
  const probed = new Map();
  for (const file of files) probed.set(file, await probeMedia(ffprobePath, file, signal));
  for (const [file, info] of probed) if (!info.has_video) throw new Error(`输入没有可用视频轨：${file}`);
  // 个别集没有音轨时，那几段补静音（见 buildPrepareCommand），不让整集失败。
  const withAudio = [...probed.values()].filter((info) => info.has_audio).length;
  for (const part of parts) part.has_audio = probed.get(part.src).has_audio;
  const first = probed.get(parts[0].src);
  const mergeStart = Date.now();
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const middle = path.join(path.dirname(dst), `.ai-drama-quchong-pre-${randomUUID()}.mkv`);
  try {
    const command = buildPrepareCommand({
      segments: parts,
      media: { has_audio: withAudio > 0, video_width: first.video_width, video_height: first.video_height },
      dst: middle,
    });
    onStage?.('merging');
    onLog?.(`[合并] ${parts.length} 段按各自的倍数变速并接成一集（去重前），再统一加去重特效重新编码`);
    try {
      await runProcess(
        ffmpegPath,
        command.args,
        command.duration,
        (value) => onProgress?.(value * 0.25),
        signal,
        null,
        onLog,
      );
    } catch (error) {
      if (signal?.aborted) throw new Error('已取消');
      if (await reallyOutOfSpace(error.message, path.dirname(dst))) throw diskFullError(error);
      throw new Error(
        `合并变速这一步失败（还没到去重编码）。原因：${keyDiagnostics(error.message)}\n[滤镜] ${command.filters}\n${error.message}`,
      );
    }
    const mergeSeconds = (Date.now() - mergeStart) / 1000;
    const done = await encodeOne({
      ...args,
      src: middle,
      segments: undefined,
      speed: 1,
      onProgress: (value) => onProgress?.(25 + value * 0.75),
    });
    return { ...done, mergeSeconds };
  } finally {
    await fsp.rm(middle, { force: true });
  }
}

module.exports = {
  DEFAULTS,
  ENCODER_RETRY_DELAYS,
  keyDiagnostics,
  rootCause,
  validateOptions,
  rollParams,
  detectEncoder,
  resolveEncoder,
  resolveWorkingEncoder,
  setWindowsAdapters,
  encoderArgs,
  buildCommand,
  probeMedia,
  runJob,
  sweepStaleTemps,
  publishOutput,
};
