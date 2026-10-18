// Build-machine setup only; the shipped app never runs pip or system Python.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const target = `${process.platform}-${process.arch}`;
const sourceFiles = [
  'scripts/build-jianying-runtime.py',
  'scripts/jianying-runtime-launcher.py',
  'scripts/jianying-runtime.spec',
  'scripts/create-jianying-draft.py',
  'scripts/check-jianying-draft.py',
  'scripts/jianying-requirements.txt',
];
const sourceRoot = process.env.JIANYING_PYJY_SOURCE || path.join(root, '.cache', 'pyJianYingDraft-src-20261015');
if (fs.existsSync(sourceRoot)) {
  const walk = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '.git' || entry.name === '__pycache__') return [];
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  for (const file of walk(sourceRoot).sort()) sourceFiles.push(path.relative(root, file));
}
const buildId = createHash('sha256')
  .update(
    Buffer.concat(
      sourceFiles
        .filter((file) => fs.existsSync(path.join(root, file)))
        .map((file) => fs.readFileSync(path.join(root, file))),
    ),
  )
  .digest('hex');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || `${command} failed (${result.status})`);
}

try {
  if (!['darwin-arm64', 'win32-x64'].includes(target))
    throw new Error(`Unsupported Jianying runtime target: ${target}`);
  const executableName = process.platform === 'win32' ? 'hongguo-jianying.exe' : 'hongguo-jianying';
  const output = path.join(root, 'build', 'jianying', target);
  const manifestPath = path.join(output, 'manifest.json');
  if (!process.argv.includes('--force') && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      manifest.buildId === buildId &&
      manifest.offlineSelfTest === true &&
      fs.existsSync(path.join(output, executableName))
    ) {
      console.log(`剪映 Python 运行时已经就绪：${target}`);
      process.exit(0);
    }
  }
  const candidates = process.env.JIANYING_BUILD_PYTHON
    ? [[process.env.JIANYING_BUILD_PYTHON]]
    : process.platform === 'win32'
      ? [['py', '-3.12'], ['python']]
      : [['python3.12'], ['python3']];
  const found = candidates.find(
    ([command, ...args]) =>
      spawnSync(command, [...args, '-c', 'import sys;sys.exit(0 if sys.version_info[:2] == (3,12) else 1)'], {
        windowsHide: true,
      }).status === 0,
  );
  if (!found) throw new Error('构建机需要 Python 3.12，可设置 JIANYING_BUILD_PYTHON；用户安装包不需要此环境');
  const venv = path.join(root, '.cache', 'jianying-venv');
  const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) run(found[0], [...found.slice(1), '-m', 'venv', venv]);
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pyinstaller>=6,<7']);
  // NumPy 2.5 currently publishes arm64 wheels with a macOS 14 minimum.
  // The app declares macOS 13 support, so keep this adapter on the same
  // macOS-13-compatible NumPy line used by the bundled structure runtime.
  run(python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--only-binary=:all:',
    'pymediainfo',
    'imageio',
    'numpy==1.26.4',
    'pillow',
  ]);
  if (fs.existsSync(path.join(sourceRoot, 'pyJianYingDraft'))) {
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--editable', sourceRoot]);
  } else {
    run(python, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '-r',
      path.join(root, 'scripts', 'jianying-requirements.txt'),
    ]);
  }
  run(python, [path.join(root, 'scripts', 'build-jianying-runtime.py'), target, buildId]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
