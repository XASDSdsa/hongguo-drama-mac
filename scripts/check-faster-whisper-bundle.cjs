const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function verifyBundle(root, platform, arch) {
  const target = `${platform}-${arch}`;
  const bundle = path.join(root, 'build/faster-whisper', target);
  const manifestFile = path.join(bundle, 'manifest.json');
  if (!fs.existsSync(manifestFile))
    throw new Error(
      `缺少内置字幕引擎 ${target}。请在对应系统构建机运行 npm run setup:transcription；不能发布缺少运行时的安装包。`,
    );
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.platform !== target || manifest.offlineSelfTest !== true) throw new Error('字幕引擎未通过离线识别检查');
  if (manifest.sentenceAlignmentSelfTest !== true || manifest.sentenceAlignmentAlgorithm !== 'whisper-audio-pause-v4')
    throw new Error('内置句级声学对齐尚未通过离线检查，请在构建机运行 npm run setup:transcription');
  if (platform === 'darwin' && (!manifest.minimumMacOS || Number(manifest.minimumMacOS) > 13))
    throw new Error('字幕引擎尚未通过 macOS 13 兼容性检查，请重新构建');
  const files = [
    platform === 'win32' ? 'hongguo-transcribe.exe' : 'hongguo-transcribe',
    'models/tiny/model.bin',
    'models/tiny/config.json',
    'models/tiny/tokenizer.json',
    'models/tiny/vocabulary.txt',
  ];
  if (platform === 'win32') {
    for (const name of [
      'cublas64_12.dll',
      'cublasLt64_12.dll',
      'cudnn64_9.dll',
      'cudnn_ops64_9.dll',
      'cudart64_12.dll',
    ])
      files.push(`_internal/cuda/${name}`);
    for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) files.push(`_internal/${name}`);
  }
  for (const file of files) {
    const full = path.join(bundle, file);
    if (!fs.existsSync(full) || !fs.statSync(full).size) throw new Error(`内置字幕资源缺失：${file}`);
  }
  for (const [file, expected] of Object.entries(manifest.sha256 || {})) {
    const full = path.resolve(bundle, file);
    if (!full.startsWith(bundle + path.sep)) throw new Error('无效的字幕引擎资源路径');
    const actual = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (actual !== expected) throw new Error(`内置字幕资源校验失败：${file}`);
  }
  return bundle;
}

module.exports = async (context) => {
  const arch = require('builder-util').Arch[context.arch];
  verifyBundle(context.packager.projectDir, context.electronPlatformName, arch);
};
module.exports.verifyBundle = verifyBundle;
if (require.main === module) {
  try {
    console.log(`PASS ${verifyBundle(path.resolve(__dirname, '..'), process.platform, process.arch)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
