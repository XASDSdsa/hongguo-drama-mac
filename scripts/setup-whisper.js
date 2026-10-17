#!/usr/bin/env node
/*
 * Prepare local whisper.cpp resources for packaging.
 *
 * This script intentionally never downloads an executable or model by itself:
 * release builds must use pinned, reviewed artifacts. Supply the paths via
 * WHISPER_CPP_BIN / WHISPER_CPP_MODEL or pass --binary / --model, then the
 * files are copied into build/whisper for electron-builder extraResources.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const platform = process.platform;
const arch = process.arch;
const binaryName = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const targetBinDir = path.join(root, 'build', 'whisper', `${platform}-${arch}`);
const targetModelDir = path.join(root, 'build', 'whisper', 'models');
const targetBin = path.join(targetBinDir, binaryName);
const targetModel = path.join(targetModelDir, 'ggml-tiny.bin');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function copyIfSupplied(source, target, label) {
  if (!source) return false;
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label}不存在：${resolved}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(resolved, target);
  if (process.platform !== 'win32' && label.includes('可执行')) fs.chmodSync(target, 0o755);
  console.log(`已准备 ${label}：${target}`);
  return true;
}

try {
  const copiedBin = copyIfSupplied(
    option('--binary') || process.env.WHISPER_CPP_BIN,
    targetBin,
    'whisper.cpp 可执行文件',
  );
  const copiedModel = copyIfSupplied(
    option('--model') || process.env.WHISPER_CPP_MODEL,
    targetModel,
    'ggml-tiny.bin 模型',
  );
  const hasBin = fs.existsSync(targetBin) && fs.statSync(targetBin).isFile();
  const hasModel = fs.existsSync(targetModel) && fs.statSync(targetModel).isFile() && fs.statSync(targetModel).size > 0;
  if (!hasBin || !hasModel) {
    console.error('本地 whisper.cpp 资源未完整准备，打包将保留明确的“未就绪”状态：');
    if (!hasBin) console.error(`  缺少：${targetBin}`);
    if (!hasModel) console.error(`  缺少：${targetModel}`);
    console.error('请使用 --binary / --model，或设置 WHISPER_CPP_BIN / WHISPER_CPP_MODEL。');
    process.exitCode = 2;
  } else {
    console.log(
      `whisper.cpp 已就绪（${platform}-${arch}，tiny 模型）${copiedBin || copiedModel ? '，资源已更新' : ''}`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
