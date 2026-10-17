// Build-machine setup only. The shipped app never executes pip or system Python.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const target = `${process.platform}-${process.arch}`;
const output = path.join(root, 'build/faster-whisper', target);
const sources = ['scripts/faster-whisper-requirements.txt', 'scripts/faster-whisper.spec', 'scripts/build-faster-whisper.py', 'src/native/faster_whisper_cli.py', 'src/native/scenedetect_runner.py', 'src/native/sentence_alignment.py'];
const buildId = createHash('sha256').update(Buffer.concat(sources.map(file => fs.readFileSync(path.join(root, file))))).digest('hex');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${path.basename(command)} failed (${result.status})`);
}

try {
  if (!['darwin-arm64', 'win32-x64'].includes(target)) throw new Error(`Unsupported build target: ${target}`);
  const manifestPath = path.join(output, 'manifest.json');
  if (!process.argv.includes('--force') && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    let valid = false;
    try { require('./check-faster-whisper-bundle.cjs').verifyBundle(root, process.platform, process.arch); valid = true; } catch (_) {}
    if (manifest.buildId === buildId && valid) {
      console.log(`内置字幕引擎与 tiny 模型已准备：${target}`);
      process.exit(0);
    }
  }
  const candidates = process.env.FASTER_WHISPER_BUILD_PYTHON
    ? [[process.env.FASTER_WHISPER_BUILD_PYTHON]]
    : process.platform === 'win32' ? [['py', '-3.12'], ['python']] : [['python3.12'], ['python3']];
  const python = candidates.find(([command, ...args]) => spawnSync(command, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info[:2] == (3,12) else 1)'], { windowsHide: true }).status === 0);
  if (!python) throw new Error('构建机需要 Python 3.12；用户安装包不需要 Python。可通过 FASTER_WHISPER_BUILD_PYTHON 指定构建解释器。');
  const venv = path.join(root, '.cache/faster-whisper', `venv-${target}`);
  const executable = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(executable)) run(python[0], [...python.slice(1), '-m', 'venv', venv]);
  run(executable, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '-r', path.join(root, sources[0])]);
  run(executable, [path.join(root, 'scripts/build-faster-whisper.py'), target, buildId]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
