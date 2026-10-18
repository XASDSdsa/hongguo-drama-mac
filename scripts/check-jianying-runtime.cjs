const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function verifyBundle(root, platform, arch) {
  // 两个发布平台都必须带上剪映运行时：用户电脑上没有 Python，缺了它就生成不了剪映草稿。
  if (!['darwin', 'win32'].includes(platform)) return null;
  const target = `${platform}-${arch}`;
  const executableName = platform === 'win32' ? 'hongguo-jianying.exe' : 'hongguo-jianying';
  const bundle = path.join(root, 'build', 'jianying', target);
  const manifestPath = path.join(bundle, 'manifest.json');
  if (!fs.existsSync(manifestPath))
    throw new Error(`缺少剪映 Python 运行时 ${target}；请在对应构建机执行 npm run setup:jianying`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.platform !== target || manifest.runtime !== executableName || manifest.offlineSelfTest !== true) {
    throw new Error('剪映 Python 运行时尚未通过离线自检');
  }
  const executable = path.join(bundle, executableName);
  if (!fs.existsSync(executable) || !fs.statSync(executable).size) throw new Error('剪映 Python 运行时可执行文件缺失');
  for (const [relative, expected] of Object.entries(manifest.sha256 || {})) {
    const full = path.resolve(bundle, relative);
    if (!full.startsWith(bundle + path.sep)) throw new Error('剪映运行时资源路径无效');
    if (!fs.existsSync(full) || createHash('sha256').update(fs.readFileSync(full)).digest('hex') !== expected) {
      throw new Error(`剪映运行时资源校验失败：${relative}`);
    }
  }
  return bundle;
}

module.exports = { verifyBundle };
if (require.main === module) {
  try {
    console.log(`PASS ${verifyBundle(path.resolve(__dirname, '..'), process.platform, process.arch)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
