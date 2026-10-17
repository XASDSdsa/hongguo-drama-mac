'use strict';

/** Bundled faster-whisper adapter.
 *
 * Runtime selection happens once per batch.  A CUDA failure is reported to the
 * user; this module intentionally does not switch to CPU halfway through a
 * batch because that makes speed and results unpredictable.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { correctSrtBounds } = require('./srt');

const DEFAULT_MODEL = 'tiny';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function usableFile(file) {
  try { return !!file && fs.statSync(file).isFile() && fs.statSync(file).size > 0; }
  catch (_) { return false; }
}

function scriptCandidates(settings = {}) {
  const projectRoot = settings.projectRoot || path.resolve(__dirname, '../..');
  return [...new Set([
    settings.faster_whisper_script_path,
    process.resourcesPath && path.join(process.resourcesPath, 'faster_whisper_cli.py'),
    path.join(__dirname, 'faster_whisper_cli.py'),
    path.join(projectRoot, 'src', 'native', 'faster_whisper_cli.py'),
  ].filter(Boolean))];
}

function resolveScript(settings = {}) {
  return scriptCandidates(settings).find(usableFile) || null;
}

function resolvePython(settings = {}) {
  // Explicit development/test override only; installed apps never search PATH.
  return settings.isPackaged ? null : String(settings.faster_whisper_python_path || process.env.FASTER_WHISPER_PYTHON || '').trim() || null;
}

function resolveBundledRuntime(settings = {}) {
  const platform = settings.platform || process.platform;
  const arch = settings.arch || process.arch;
  const resources = settings.resourcesPath || process.resourcesPath;
  const roots = [resources && path.join(resources, 'faster-whisper')];
  if (!settings.isPackaged) roots.push(path.join(settings.projectRoot || path.resolve(__dirname, '../..'), 'build/faster-whisper', `${platform}-${arch}`));
  for (const root of roots.filter(Boolean)) {
    const command = path.join(root, platform === 'win32' ? 'hongguo-transcribe.exe' : 'hongguo-transcribe');
    const modelPath = path.join(root, 'models/tiny');
    if (usableFile(command) && ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'].every(file => usableFile(path.join(modelPath, file)))) {
      return { command, prefixArgs: [], bundled: true, modelPath, model: DEFAULT_MODEL };
    }
  }
  return null;
}

function resolveBundledSceneDetector(settings = {}) {
  const platform = settings.platform || process.platform;
  const resources = settings.resourcesPath || process.resourcesPath;
  const root = settings.projectRoot || path.resolve(__dirname, '../..');
  const roots = [resources && path.join(resources, 'faster-whisper')];
  if (!settings.isPackaged) roots.push(path.join(root, 'build/faster-whisper', `${platform}-${settings.arch || process.arch}`));
  for (const candidateRoot of roots.filter(Boolean)) {
    const command = path.join(candidateRoot, platform === 'win32' ? 'hongguo-transcribe.exe' : 'hongguo-transcribe');
    if (usableFile(command)) return { command, prefixArgs: [], bundled: true };
  }
  return null;
}

function cleanOutput(value) {
  const text = String(value || '');
  return text.length > MAX_OUTPUT_BYTES ? text.slice(-MAX_OUTPUT_BYTES) : text;
}

function runPython(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('任务已取消'));
    const label = options.label || 'faster-whisper';
    const child = spawn(command, args, { windowsHide: true, cwd: options.cwd || undefined, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...options.env } });
    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    let settled = false;
    let failure = null;
    let killTimer = null;
    const terminate = error => {
      if (failure || settled) return;
      failure = error;
      try { child.kill('SIGTERM'); } catch (_) {}
      // Only escalate an explicit cancellation/probe timeout. A slow or long
      // transcription never has an inactivity deadline.
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1500);
    };
    const timer = options.timeoutMs > 0 ? setTimeout(() => terminate(new Error(`${label} 检查超时`)), options.timeoutMs) : null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(result);
    };
    // Do not release a queue slot until the process and its output pipes close.
    const abort = () => terminate(new Error('任务已取消'));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout = cleanOutput(stdout + String(chunk)); });
    child.stderr?.on('data', chunk => {
      const text = String(chunk);
      stderr = cleanOutput(stderr + text);
      progressBuffer = cleanOutput(progressBuffer + text);
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop();
      for (const line of lines) {
        const match = /^PROGRESS\s+([0-9.]+)\s*(.*)$/i.exec(line.trim());
        if (match && !failure) options.onProgress?.({ progress: Math.max(0, Math.min(100, Number(match[1]) || 0)), message: match[2] || '' });
      }
    });
    child.once('error', error => { failure ||= new Error(`无法启动 ${label}：${error.message}`); });
    child.once('close', code => {
      if (failure) finish(failure);
      else if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
        finish(new Error(`${label} 退出码 ${code}${detail ? `：${detail.replace(/^ERROR\s*/i, '')}` : ''}`));
      } else finish(null, { stdout, stderr });
    });
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    }
  });
}

async function prepareRuntime(settings = {}, options = {}) {
  const python = resolvePython(settings);
  let worker;
  if (python) {
    const script = resolveScript(settings);
    if (!script) throw new Error('开发模式的转写脚本不存在');
    worker = { command: python, prefixArgs: [script], python, script, bundled: false, model: settings.faster_whisper_model || DEFAULT_MODEL };
  } else worker = resolveBundledRuntime(settings);
  if (!worker) {
    const error = new Error('应用内置字幕引擎或模型缺失，请使用完整安装包更新应用');
    error.code = 'FASTER_WHISPER_BUNDLE_MISSING';
    throw error;
  }
  let probeResult;
  try {
    const result = await runPython(worker.command, [...worker.prefixArgs, '--probe'], { timeoutMs: 30_000, signal: options.signal });
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    probeResult = JSON.parse(line);
  } catch (error) {
    throw new Error(`faster-whisper 环境检查失败：${error.message}`);
  }
  if (!probeResult?.faster_whisper) {
    throw new Error(`字幕引擎无法加载${probeResult?.error ? `：${probeResult.error}` : ''}`);
  }
  const requestedDevice = String(settings.faster_whisper_device || 'auto').toLowerCase();
  const device = requestedDevice === 'auto' ? (probeResult.cuda ? 'cuda' : 'cpu') : requestedDevice;
  if (!['cpu', 'cuda'].includes(device)) throw new Error('faster-whisper 设备只能选择 auto、cuda 或 cpu');
  if (requestedDevice === 'cuda' && !probeResult.cuda) throw new Error('已指定 CUDA，但当前设备或显卡驱动不支持；不会自动切换到 CPU');
  const requestedCompute = String(settings.faster_whisper_compute_type || 'auto').toLowerCase();
  const computeType = requestedCompute === 'auto' ? (device === 'cuda' ? 'float16' : 'int8') : requestedCompute;
  return {
    ...worker,
    device,
    computeType,
    language: String(settings.whisper_language || 'zh').trim() || 'zh',
    ffmpegPath: settings.ffmpegPath || resolveMediaTool('ffmpeg', settings),
    ffprobePath: settings.ffprobePath || resolveMediaTool('ffprobe', settings),
    probe: probeResult,
  };
}

function resolveMediaTool(name, settings) {
  const platform = settings.platform || process.platform;
  const filename = name + (platform === 'win32' ? '.exe' : '');
  const resources = settings.resourcesPath || process.resourcesPath;
  const root = settings.projectRoot || path.resolve(__dirname, '../..');
  const candidates = [resources && path.join(resources, 'bin', filename)];
  if (!settings.isPackaged) candidates.push(path.join(root, 'build/ffmpeg', ...(platform === 'win32' ? [] : [`${platform}-${settings.arch || process.arch}`]), filename));
  return candidates.filter(Boolean).find(usableFile) || null;
}

async function prepareAudio(inputPath, outputPath, runtime, options = {}) {
  if (!runtime.ffmpegPath || !runtime.ffprobePath) throw new Error('应用内置 FFmpeg/ffprobe 缺失，无法校正字幕时间轴');
  const probe = await runPython(runtime.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration,start_time:stream=index,codec_type,start_time,duration:stream_tags=DURATION:stream_disposition=attached_pic', '-of', 'json', inputPath], { signal: options.signal, label: 'ffprobe' });
  const media = JSON.parse(probe.stdout);
  const video = media.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = media.streams?.find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('去重视频没有可用画面轨');
  if (!audio) throw new Error('去重视频没有音轨，无法识别对白');
  const videoStart = Number(video.start_time) || 0;
  const audioStart = Number(audio.start_time) || 0;
  const durationTag = /^(\d+):(\d+):([\d.]+)$/.exec(video.tags?.DURATION || '');
  const taggedEnd = durationTag ? Number(durationTag[1]) * 3600 + Number(durationTag[2]) * 60 + Number(durationTag[3]) : 0;
  const duration = Number(video.duration) > 0 ? Number(video.duration) : taggedEnd > videoStart ? taggedEnd - videoStart
    : Number(media.format?.duration) - Math.max(0, videoStart - (Number(media.format?.start_time) || 0));
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取去重视频的有效时长');
  const audioDurationTag = /^(\d+):(\d+):([\d.]+)$/.exec(audio.tags?.DURATION || '');
  const taggedAudioEnd = audioDurationTag ? Number(audioDurationTag[1]) * 3600 + Number(audioDurationTag[2]) * 60 + Number(audioDurationTag[3]) : NaN;
  const sourceAudioEnd = Number(audio.duration) > 0 ? audioStart + Number(audio.duration) : taggedAudioEnd;
  const audioEnd = Number.isFinite(sourceAudioEnd) ? Math.min(duration, sourceAudioEnd - videoStart) : duration;
  if (audioEnd <= Math.max(0, audioStart - videoStart)) throw new Error('音轨与画面没有重叠时间，无法识别对白');
  // Preserve source timestamps, then place audio on the video clock. first_pts
  // inserts leading silence or trims negative time; async=1 preserves gaps.
  await runPython(runtime.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-copyts', '-i', inputPath,
    '-map', `0:${audio.index}`, '-vn', '-af', `asetpts=PTS-(${videoStart})/TB,aresample=16000:async=1:first_pts=0,apad`,
    '-t', String(duration), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath], { signal: options.signal, label: '音频时间轴校正' });
  return { duration, videoStart, audioStart, audioOffset: audioStart - videoStart, audioEnd };
}

async function transcribeToSrt(inputPath, outputPath, runtime, options = {}) {
  if (!usableFile(inputPath)) throw new Error('待转写的去重视频不存在或为空');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = await fsp.mkdtemp(path.join(path.dirname(outputPath), '.subtitle-'));
  const draftPath = path.join(temporary, 'output.srt');
  try {
    options.onProgress?.({ stage: 'extracting', progress: 0, message: '校正音频时间轴' });
    const audioPath = path.join(temporary, 'audio.wav');
    const timing = await prepareAudio(inputPath, audioPath, runtime, options);
    const args = [
      ...runtime.prefixArgs,
      '--input', audioPath,
      '--output', draftPath,
      '--duration', String(timing.duration),
      '--model', runtime.modelPath || runtime.model,
      '--device', runtime.device,
      '--compute-type', runtime.computeType,
      '--language', options.language || runtime.language || 'zh',
    ];
    if (runtime.bundled) args.push('--local-files-only');
    const result = await runPython(runtime.command, args, {
      signal: options.signal,
      onProgress: info => options.onProgress?.({ ...info, stage: 'aligning', progress: Math.min(99, info.progress) }),
    });
    if (!usableFile(draftPath)) throw new Error('faster-whisper 没有生成 SRT 文件');
    options.onProgress?.({ stage: 'validating', progress: 99, message: '校验字幕时间轴' });
    // VAD padding can place a word in leading/trailing silence. Constrain only
    // to known media boundaries, never to a guessed nearby semantic cut.
    const checked = correctSrtBounds(await fsp.readFile(draftPath, 'utf8'), timing);
    await fsp.writeFile(draftPath, checked.content, 'utf8');
    let alignment;
    try { alignment = JSON.parse(result.stdout.trim().split(/\r?\n/).pop()); } catch (_) {}
    if (alignment?.word_aligned !== true || alignment.entries !== checked.entries.length) throw new Error('字幕引擎未完成词级对齐校验，结果未保存');
    if (options.signal?.aborted) throw new Error('任务已取消');
    options.beforeCommit?.();
    // The short, synchronous rename keeps cancellation/source validation and
    // publication in one main-process turn. The worker only sees a draft path.
    fs.renameSync(draftPath, outputPath);
    return { outputPath, entries: checked.entries.length, timing: { ...timing, correctedCues: checked.correctedCues }, alignment, device: runtime.device, computeType: runtime.computeType };
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function checkRuntime(settings = {}) {
  try {
    const runtime = await prepareRuntime(settings);
    if (!runtime.ffmpegPath || !runtime.ffprobePath) throw new Error('应用内置 FFmpeg/ffprobe 缺失，请使用完整安装包更新应用');
    return { available: true, bundled: runtime.bundled, model: runtime.model, device: runtime.device, computeType: runtime.computeType, cuda: !!runtime.probe?.cuda, message: runtime.bundled ? '内置字幕引擎已就绪' : '开发字幕引擎已就绪' };
  } catch (error) {
    return { available: false, message: error.message, code: error.code || 'FASTER_WHISPER_NOT_READY' };
  }
}

module.exports = {
  checkRuntime,
  prepareRuntime,
  transcribeToSrt,
  resolvePython,
  resolveScript,
  resolveBundledRuntime,
  resolveBundledSceneDetector,
  prepareAudio,
};
