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
const { normalizeSrt } = require('./srt');

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

function cleanOutput(value) {
  const text = String(value || '');
  return text.length > MAX_OUTPUT_BYTES ? text.slice(-MAX_OUTPUT_BYTES) : text;
}

function runPython(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: options.cwd || undefined, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...options.env } });
    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    let settled = false;
    const timer = options.timeoutMs > 0 ? setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish(new Error('faster-whisper 转写超时')); 
    }, options.timeoutMs) : null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => {
      try { child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'); } catch (_) {}
      finish(new Error('任务已取消'));
    };
    child.stdout?.on('data', chunk => { stdout = cleanOutput(stdout + String(chunk)); });
    child.stderr?.on('data', chunk => {
      const text = String(chunk);
      stderr = cleanOutput(stderr + text);
      progressBuffer += text;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop();
      for (const line of lines) {
        const match = /^PROGRESS\s+([0-9.]+)\s*(.*)$/i.exec(line.trim());
        if (match) options.onProgress?.({ progress: Math.max(0, Math.min(100, Number(match[1]) || 0)), message: match[2] || '' });
      }
    });
    child.once('error', error => finish(new Error(`无法启动 faster-whisper：${error.message}`)));
    child.once('close', code => {
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
        finish(new Error(`faster-whisper 退出码 ${code}${detail ? `：${detail.replace(/^ERROR\s*/i, '')}` : ''}`));
      } else finish(null, { stdout, stderr });
    });
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    }
  });
}

async function prepareRuntime(settings = {}) {
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
    const result = await runPython(worker.command, [...worker.prefixArgs, '--probe'], { timeoutMs: 30_000 });
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
    probe: probeResult,
  };
}

async function transcribeToSrt(inputPath, outputPath, runtime, options = {}) {
  if (!usableFile(inputPath)) throw new Error('待转写的去重视频不存在或为空');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const args = [
    ...runtime.prefixArgs,
    '--input', inputPath,
    '--output', outputPath,
    '--model', runtime.modelPath || runtime.model,
    '--device', runtime.device,
    '--compute-type', runtime.computeType,
    '--language', options.language || runtime.language || 'zh',
  ];
  if (runtime.bundled) args.push('--local-files-only');
  await runPython(runtime.command, args, {
    signal: options.signal,
    timeoutMs: Number(options.timeoutMs) || 0,
    onProgress: options.onProgress,
  });
  if (!usableFile(outputPath)) throw new Error('faster-whisper 没有生成 SRT 文件');
  const content = await fsp.readFile(outputPath, 'utf8');
  const normalized = normalizeSrt(content);
  if (normalized !== content) await fsp.writeFile(outputPath, normalized, 'utf8');
  return { outputPath, entries: normalized.trim().split(/\n\s*\n/).length, device: runtime.device, computeType: runtime.computeType };
}

async function checkRuntime(settings = {}) {
  try {
    const runtime = await prepareRuntime(settings);
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
};
