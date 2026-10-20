'use strict';
// 有些打包进来的命令行工具（人声分离 sherpa-onnx、字幕 whisper.cpp 的 MSVC 版）在 Windows 上把参数里的路径
// 当 UTF-8 解析，而中文 Windows 传给程序的参数是 GBK：路径里只要有中文（剧名、用户名、安装在「AI短剧助手」
// 文件夹），工具就说文件不存在或直接报错。这里提供一个纯英文路径的临时目录，把要交给这类工具的文件放进去。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const isAscii = (value) => /^[\x00-\x7f]*$/.test(String(value));

/** 找一个路径里只有英文字符、能写的临时目录；都不行返回 null。 */
function asciiScratchRoot(env = process.env) {
  const candidates = [os.tmpdir(), env.PROGRAMDATA, env.PUBLIC, path.parse(os.tmpdir()).root].filter(Boolean);
  for (const base of candidates) {
    const dir = path.join(base, 'ai-drama-ascii');
    if (!isAscii(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {}
  }
  return null;
}

/** 同一个盘用硬链接（不占空间、瞬间完成），否则复制（先写临时名再改名，不留半截文件）。 */
async function placeFile(from, to) {
  try {
    await fsp.link(from, to);
  } catch (_) {
    const temp = `${to}.${process.pid}.part`;
    await fsp.copyFile(from, temp);
    await fsp.rename(temp, to);
  }
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (_) {
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

/** 大文件（模型）放一份在固定位置反复用：大小对得上就不再放。 */
async function cachedAsciiCopy(file, root) {
  if (isAscii(file)) return file;
  const cached = path.join(root, 'models', path.basename(file));
  const [want, have] = await Promise.all([fsp.stat(file), fsp.stat(cached).catch(() => null)]);
  if (!have || have.size !== want.size) {
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await fsp.rm(cached, { force: true });
    await placeFile(file, cached);
  }
  return cached;
}

/**
 * 为一次工具调用准备纯英文路径。
 *   models  — 大文件，缓存复用（返回同名 key 的新路径）
 *   inputs  — 每次放进本次的临时目录
 *   outputs — 先写到临时目录，调用 finish() 时挪回原位置
 * 不是 Windows、或者所有路径都是英文时原样返回（stage 为 null）。
 * 用完一定要调用 cleanup()。
 */
async function stageAscii({ models = {}, inputs = {}, outputs = {} }, { platform = process.platform, root } = {}) {
  const all = [...Object.values(models), ...Object.values(inputs), ...Object.values(outputs)];
  const identity = { ...models, ...inputs, ...outputs };
  if (platform !== 'win32' || all.every(isAscii))
    return { paths: identity, stage: null, finish: async () => {}, cleanup: async () => {} };
  const base = root === undefined ? asciiScratchRoot() : root;
  if (!base) throw new Error('找不到只含英文字符的临时文件夹：这个工具读不了带中文的路径');
  const stage = path.join(base, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(stage, { recursive: true });
  const paths = {};
  for (const [key, file] of Object.entries(models)) paths[key] = await cachedAsciiCopy(file, base);
  for (const [key, file] of Object.entries(inputs)) {
    if (isAscii(file)) paths[key] = file;
    else {
      paths[key] = path.join(stage, `${key}${path.extname(file)}`);
      await placeFile(file, paths[key]);
    }
  }
  for (const [key, file] of Object.entries(outputs)) paths[key] = path.join(stage, `${key}${path.extname(file)}`);
  return {
    paths,
    stage,
    async finish() {
      for (const [key, file] of Object.entries(outputs))
        if (fs.existsSync(paths[key])) await moveFile(paths[key], file);
    },
    async cleanup() {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    },
  };
}

module.exports = { isAscii, asciiScratchRoot, placeFile, moveFile, stageAscii };
