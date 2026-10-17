// Build from pinned source archives. See build/ffmpeg/MACOS-NOTICE.txt.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', 'build', 'ffmpeg');
const dest = path.join(root, 'darwin-arm64');
const script = path.resolve(__dirname, 'build-ffmpeg-source-mac.sh');
const manifestPath = path.join(dest, 'build-manifest.json');
const source = 'ffmpeg-9.0.2+x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55';
const names = ['ffmpeg', 'ffprobe'];
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  assert(process.platform === 'darwin' && process.arch === 'arm64', '需要 Apple Silicon macOS');
  const scriptHash = sha256(script);
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {}
  const valid =
    saved?.source === source &&
    saved?.script_sha256 === scriptHash &&
    names.every(
      (name) => fs.existsSync(path.join(dest, name)) && sha256(path.join(dest, name)) === saved.binaries?.[name],
    );
  if (!valid) {
    const buildRoot = path.join(root, '.source-build');
    console.log('首次从固定源码构建 FFmpeg / x264，通常需要数分钟。');
    execFileSync('/bin/bash', [script, buildRoot], { stdio: 'inherit' });
    fs.mkdirSync(dest, { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(buildRoot, 'artifacts', 'bin', name), path.join(dest, name));
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          source,
          script_sha256: scriptHash,
          binaries: Object.fromEntries(names.map((name) => [name, sha256(path.join(dest, name))])),
        },
        null,
        2,
      ) + '\n',
    );
  }
  for (const name of names) {
    const binary = path.join(dest, name);
    fs.chmodSync(binary, 0o755);
    execFileSync('/usr/bin/lipo', [binary, '-verify_arch', 'arm64']);
    const dependencies = execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .slice(1);
    assert(
      dependencies.length && dependencies.every((line) => /^\s+\/(usr\/lib|System\/Library)\//.test(line)),
      '工具含非系统动态库',
    );
    console.log(name + ': 源码构建校验、arm64 与系统库依赖通过');
  }
} catch (error) {
  console.error('Mac FFmpeg 准备失败：' + error.message);
  process.exitCode = 1;
}
