'use strict';

/**
 * Local whisper.cpp adapter.
 *
 * This module deliberately has no network fallback.  The caller must choose
 * the OpenAI transcriber explicitly; a missing local binary/model is reported
 * as a clear, actionable error instead of silently creating an API bill.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { stageAscii } = require('./ascii-paths');
const { spawn } = require('node:child_process');

const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function executableName(name, platform = process.platform) {
  return platform === 'win32' && !String(name).toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
}

function fileUsable(file, executable = false, platform = process.platform) {
  if (!file) return false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0) return false;
    fs.accessSync(file, executable && platform !== 'win32' ? fs.constants.X_OK : fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function firstUsable(candidates, executable = false, platform = process.platform) {
  for (const candidate of candidates) {
    if (fileUsable(candidate, executable, platform)) return candidate;
  }
  return null;
}

function pathEntries(envPath, delimiter = path.delimiter) {
  return String(envPath || '')
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function binaryCandidates(config = {}) {
  const platform = config.platform || process.platform;
  const arch = config.arch || process.arch;
  const exeNames = [
    ...new Set(
      [config.whisper_binary_name, 'whisper-cli', 'whisper', 'main']
        .filter(Boolean)
        .map((name) => executableName(name, platform)),
    ),
  ];
  const roots = [
    config.whisper_binary_path,
    config.resourcesPath && path.join(config.resourcesPath, 'bin'),
    config.resourcesPath && path.join(config.resourcesPath, 'whisper'),
    config.projectRoot && path.join(config.projectRoot, 'build', 'whisper', `${platform}-${arch}`),
    config.projectRoot && path.join(config.projectRoot, 'build', 'whisper'),
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    const value = String(root);
    // A configured path may point directly to the executable.
    if (path.extname(value) || (/[\\/]$/.test(value) === false && fileUsable(value, true, platform)))
      candidates.push(value);
    for (const name of exeNames) candidates.push(path.join(value, name));
  }
  for (const dir of pathEntries(config.path || process.env.PATH)) {
    for (const name of exeNames) candidates.push(path.join(dir, name));
  }
  return [...new Set(candidates)];
}

function modelCandidates(config = {}) {
  const platform = config.platform || process.platform;
  const arch = config.arch || process.arch;
  const names = [...new Set([config.whisper_model_name, 'ggml-tiny.bin'].filter(Boolean))];
  const roots = [
    config.whisper_model_path,
    config.resourcesPath && path.join(config.resourcesPath, 'models'),
    config.resourcesPath && path.join(config.resourcesPath, 'bin'),
    config.resourcesPath && path.join(config.resourcesPath, 'whisper', 'models'),
    config.projectRoot && path.join(config.projectRoot, 'build', 'whisper', `${platform}-${arch}`, 'models'),
    config.projectRoot && path.join(config.projectRoot, 'build', 'whisper', 'models'),
    config.projectRoot && path.join(config.projectRoot, 'build', 'whisper'),
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    const value = String(root);
    // A configured path may point directly to a model even when it has a
    // non-standard extension (the bundled default remains ggml-tiny.bin).
    if (path.extname(value) === '.bin' || fileUsable(value)) candidates.push(value);
    for (const name of names) candidates.push(path.join(value, name));
  }
  return [...new Set(candidates)];
}

function normalizeConfig(settings = {}) {
  return {
    platform: settings.platform || process.platform,
    arch: settings.arch || process.arch,
    resourcesPath: settings.resourcesPath || process.resourcesPath || '',
    projectRoot: settings.projectRoot || path.resolve(__dirname, '../..'),
    path: settings.whisper_path || process.env.PATH,
    whisper_binary_path: String(settings.whisper_binary_path || process.env.WHISPER_CPP_BIN || '').trim(),
    whisper_model_path: String(settings.whisper_model_path || process.env.WHISPER_CPP_MODEL || '').trim(),
    whisper_binary_name: String(settings.whisper_binary_name || '').trim(),
    whisper_model_name: String(settings.whisper_model_name || 'ggml-tiny.bin').trim(),
    language: String(settings.whisper_language || settings.ai_language || DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE,
    threads: Number.isInteger(Number(settings.whisper_threads))
      ? Math.max(0, Math.min(32, Number(settings.whisper_threads)))
      : 0,
    timeoutMs: Number.isInteger(Number(settings.whisper_timeout_ms))
      ? Math.max(10_000, Math.min(60 * 60 * 1000, Number(settings.whisper_timeout_ms)))
      : DEFAULT_TIMEOUT_MS,
  };
}

function resolveWhisper(config = {}) {
  const normalized = normalizeConfig(config);
  const binaryPath = firstUsable(binaryCandidates(normalized), true, normalized.platform);
  const modelPath = firstUsable(modelCandidates(normalized), false, normalized.platform);
  const missing = [];
  if (!binaryPath) missing.push('whisper.cpp 可执行文件');
  if (!modelPath) missing.push('ggml-tiny.bin 模型');
  return {
    available: missing.length === 0,
    binaryPath,
    modelPath,
    missing,
    config: normalized,
  };
}

function unavailableError(result) {
  const locations = [
    '设置中填写 whisper.cpp 可执行文件和模型路径',
    '或将它们放到应用 Resources/bin 与 Resources/models 目录',
  ];
  const error = new Error(
    `本地 whisper.cpp 未就绪：缺少 ${result.missing.join('、')}。${locations.join('；')}。不会自动调用 OpenAI。`,
  );
  error.code = 'WHISPER_NOT_READY';
  error.missing = result.missing;
  return error;
}

function appendOutput(state, chunk, maxBytes = MAX_OUTPUT_BYTES) {
  if (state.bytes >= maxBytes) return;
  const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  const room = maxBytes - state.bytes;
  state.text += value.slice(0, room);
  state.bytes += Buffer.byteLength(value.slice(0, room));
}

function runWhisper(binaryPath, args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Windows development setups sometimes expose whisper through a .cmd
    // wrapper. Packaged builds use whisper-cli.exe, but accepting the wrapper
    // keeps the explicit settings path testable on every platform.
    const child = spawn(binaryPath, args, {
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath),
    });
    const stdout = { text: '', bytes: 0 };
    const stderr = { text: '', bytes: 0 };
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      finish(new Error('whisper.cpp 转写超时，请降低模型或并发数'));
    }, timeoutMs);
    const abort = () => {
      try {
        child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
      } catch (_) {}
      finish(new Error('任务已取消'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    child.stdout?.on('data', (chunk) => appendOutput(stdout, chunk));
    child.stderr?.on('data', (chunk) => appendOutput(stderr, chunk));
    child.once('error', (error) => finish(new Error(`无法启动 whisper.cpp：${error.message}`)));
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = stderr.text.trim().split(/\r?\n/).slice(-3).join(' ');
        finish(new Error(`whisper.cpp 退出码 ${code}${detail ? `：${detail}` : ''}`));
      } else finish(null, { stdout: stdout.text, stderr: stderr.text });
    });
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

function cleanTranscript(value) {
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  const timestamp = /^\s*\[[0-9:.]+\s*-->\s*[0-9:.]+\]\s*/;
  const lines = String(value || '')
    .replace(ansi, '')
    .split(/\r?\n/);
  const output = [];
  for (const raw of lines) {
    const line = raw.replace(timestamp, '').trim();
    if (!line) continue;
    if (
      /^(whisper_(print|load)|system_info|main:|ggml_|sampling strategy|output_txt:|output_json:|[0-9]+ threads)/i.test(
        line,
      )
    )
      continue;
    output.push(line);
  }
  return output
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function transcribeAudio(audioPath, options = {}, settings = {}) {
  const result = resolveWhisper(settings);
  if (!result.available) throw unavailableError(result);
  if (!fileUsable(audioPath, false, result.config.platform)) throw new Error('待转写音频不存在或为空');
  // Windows 上的 whisper-cli（MSVC 编译）把模型路径当 UTF-8 解析，中文 Windows 传的是 GBK：
  // 装在「AI短剧助手」文件夹里、或剧名带中文时就读不了。路径有中文时先放到纯英文路径的临时目录。
  const staged = await stageAscii(
    { models: { model: result.modelPath }, inputs: { audio: audioPath } },
    { platform: result.config.platform, root: options.asciiRoot },
  );
  const tempDir = staged.stage || (await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-drama-whisper-')));
  const outputPrefix = path.join(tempDir, 'transcript');
  const args = [
    '-m',
    staged.paths.model,
    '-f',
    staged.paths.audio,
    '-l',
    String(options.language || result.config.language),
    '-nt',
    '-otxt',
    '-of',
    outputPrefix,
  ];
  if (result.config.threads > 0) args.push('-t', String(result.config.threads));
  try {
    const command = await runWhisper(result.binaryPath, args, options.signal, result.config.timeoutMs);
    let text = '';
    const outputFile = `${outputPrefix}.txt`;
    if (fileUsable(outputFile)) text = await fsp.readFile(outputFile, 'utf8');
    if (!text) text = command.stdout;
    text = cleanTranscript(text);
    if (!text) throw new Error('whisper.cpp 未识别到可用对白');
    return text;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await staged.cleanup();
  }
}

function checkWhisper(settings = {}) {
  const result = resolveWhisper(settings);
  return {
    available: result.available,
    binaryPath: result.binaryPath,
    modelPath: result.modelPath,
    missing: result.missing,
    message: result.available ? '本地 whisper.cpp 已就绪' : `缺少 ${result.missing.join('、')}，不会自动调用 OpenAI`,
  };
}

module.exports = {
  checkWhisper,
  cleanTranscript,
  normalizeConfig,
  resolveWhisper,
  transcribeAudio,
};
