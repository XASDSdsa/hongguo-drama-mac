const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function verifyBundle(root, platform, arch) {
  // The adapter is intentionally a Mac-only runtime. Windows builds keep the
  // existing system-Python fallback and should not require this resource.
  if (platform !== 'darwin') return null;
  const target = `${platform}-${arch}`;
  const bundle = path.join(root, 'build', 'jianying', target);
  const manifestPath = path.join(bundle, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少剪映 Python 运行时 ${target}；请在对应构建机执行 npm run setup:jianying`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.platform !== target || manifest.runtime !== 'hongguo-jianying' || manifest.offlineSelfTest !== true) {
    throw new Error('剪映 Python 运行时尚未通过离线自检');
  }
  const executable = path.join(bundle, 'hongguo-jianying');
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
