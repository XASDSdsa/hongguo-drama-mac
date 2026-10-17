'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run, blocked, sha256 } = require('./io');
const { resolveBundledRuntime } = require('../faster-whisper');
const SENTENCE_ALIGNMENT = 'paraformer-ct-global-whisper-audio-pause-v4';
const root = path.resolve(__dirname, '../../..');
function runtime(settings = {}) {
  const platform = settings.platform || process.platform;
  const arch = settings.arch || process.arch;
  const home = settings.structure_runtime_dir || (settings.isPackaged ? path.join(settings.resourcesPath, 'video-structure') : path.join(root, 'build/video-structure', `${platform}-${arch}`));
  const exe = platform === 'win32' ? '.exe' : '';
  const bundled = path.join(home, 'worker', `hongguo-structure${exe}`);
  const interpreters = [path.join(root, '.cache/video-structure', 'venv-' + platform + '-' + arch), path.join(root, '.cache/video-structure/venv')].map(dir => path.join(dir, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  const python = interpreters.find(file => fs.existsSync(file));
  const command = fs.existsSync(bundled) ? bundled : !settings.isPackaged && python ? python : null;
  return { home, command, prefix: command === python ? [path.join(__dirname, 'runner.py')] : [], binary: path.join(home, 'bin', `sherpa-onnx-offline-source-separation${exe}`), models: path.join(home, 'models'), sentence: resolveBundledRuntime(settings) };
}
function params(id, settings, rt) {
  const threads = Number(settings.structure_threads ?? Math.max(1, Math.min(4, os.availableParallelism?.() || os.cpus().length)));
  if (!Number.isInteger(threads) || threads < 1 || threads > 32) throw new Error('处理线程数必须为 1–32 的整数');
  const common = { threads };
  if (id === 'shots') return { ...common, algorithm_id: 'transnetv2-temporal-min2s-v1', minimum_duration: 2, threshold: 0.5, device: settings.structure_device || 'cpu', model: path.join(rt.models, 'transnetv2.pth'), model_id: 'TransNetV2@85cef72' };
  if (id === 'clips') return { ...common, audio_mode: settings.structure_clip_audio || 'original' };
  if (id === 'separation') return { ...common, binary: rt.binary, provider: settings.structure_sherpa_provider || 'cpu', model: path.join(rt.models, 'UVR-MDX-NET-Inst_HQ_3.onnx'), model_id: 'sherpa-onnx/UVR-MDX-NET-Inst_HQ_3' };
  if (id === 'transcript') return { ...common, provider: settings.structure_sherpa_provider || 'cpu', model: path.join(rt.models, 'sherpa-onnx-paraformer-zh-small-2024-03-09/model.int8.onnx'), tokens: path.join(rt.models, 'sherpa-onnx-paraformer-zh-small-2024-03-09/tokens.txt'), vad: path.join(rt.models, 'silero_vad.onnx'), punctuation: settings.structure_punctuation_model || path.join(rt.models, 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/model.int8.onnx'), vad_threshold: 0.5, min_silence: 0.5, min_speech: 0.25, model_id: 'sherpa-onnx/paraformer-zh-small-2024-03-09', sentence_alignment: SENTENCE_ALIGNMENT, sentence_command: rt.sentence?.command || null, sentence_prefix: rt.sentence?.prefixArgs || [], sentence_model: rt.sentence?.modelPath || null, sentence_device: 'cpu', sentence_compute_type: 'int8' };
  return {};
}
async function identity(id, config, rt, signal) {
  const files = ['model', 'tokens', 'vad', 'punctuation', 'binary'].map(k => config[k]).filter(Boolean);
  if (['shots', 'transcript'].includes(id)) files.push(rt.command, ...rt.prefix);
  if (['shots', 'transcript', 'separation'].includes(id)) files.push(path.join(rt.home, 'runtime.json'));
  if (id === 'transcript') {
    files.push(config.sentence_command, ...(config.sentence_prefix || []));
    if (config.sentence_model) files.push(...['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'].map(file => path.join(config.sentence_model, file)));
  }
  if (id === 'shots' && rt.prefix.length) files.push(...['vendor/transnetv2_pytorch.py', 'shot_verification.py', 'shot_duration.py'].map(file => path.join(__dirname, file)));
  const hashes = {};
  for (const file of files) hashes[file || '(missing runtime)'] = file && fs.existsSync(file) ? await sha256(file, signal) : null;
  return hashes;
}
function requireRuntime(id, config, rt) {
  if (['separation', 'transcript'].includes(id) && config.provider !== 'cpu') throw blocked('当前内置 sherpa-onnx 为 CPU 版本；请选 CPU。不会静默切换执行设备。');
  if (['shots', 'transcript'].includes(id) && !rt.command) throw blocked('内置结构化拆解运行时未准备完成，请使用包含该运行时的应用包');
  if (id === 'transcript' && (!config.sentence_command || !fs.existsSync(config.sentence_command) || !config.sentence_model || !['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'].every(file => fs.existsSync(path.join(config.sentence_model, file))))) throw blocked('内置句级时间对齐引擎不完整，请使用完整安装包');
  for (const key of ['model', 'tokens', 'vad', 'punctuation', 'binary']) {
    const file = config[key];
    if (file && !fs.existsSync(file)) throw blocked(`缺少 ${key}：${file}`);
  }
  if (id === 'shots' && (config.threshold !== 0.5 || !['cpu', 'cuda', 'mps'].includes(config.device))) throw new Error('TransNet V2 阈值或设备配置无效');
}
async function availability(settings) {
  const rt = runtime(settings);
  const modules = {};
  for (const id of ['shots', 'separation', 'transcript']) {
    try { requireRuntime(id, params(id, settings, rt), rt); modules[id] = { ready: true }; }
    catch (e) { modules[id] = { ready: false, error: e.message }; }
  }
  let versions = null;
  if (rt.command) { try { versions = JSON.parse((await run(rt.command, [...rt.prefix, 'status'])).stdout); } catch (e) { modules.shots = modules.transcript = { ready: false, error: e.message }; } }
  if (modules.shots.ready && versions?.shot_algorithm !== 'transnetv2-temporal-min2s-v1') modules.shots = { ready: false, error: '内置分镜运行时需要更新，缺少已确认的时间连续性复核算法' };
  if (modules.transcript.ready && versions?.sentence_boundary !== 'ct_transformer_global') modules.transcript = { ready: false, error: '内置句级识别引擎需要更新，请使用完整安装包' };
  const device = settings.structure_device || 'cpu';
  if (modules.shots.ready && device !== 'cpu' && !versions?.[device]) modules.shots = { ready: false, error: `所选 ${device} 在当前运行时不可用，不会自动切换` };
  return { home: rt.home, modules, versions, ready: Object.values(modules).every(m => m.ready) };
}
module.exports = { runtime, params, identity, requireRuntime, availability };
