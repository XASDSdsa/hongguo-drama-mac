'use strict';
// Reuse the large, already accepted 1.2.49 runtimes; replace only verified quick-update files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { extractFile } = require('@electron/asar');
const { build, Platform, Arch } = require('electron-builder');
const pkg = require('../package.json');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));
async function main() {
  assert.equal(process.platform, 'win32');
  const [oldFolder, quickFolder, destination] = process.argv.slice(2).map(p => path.resolve(p));
  const setup = files(oldFolder).find(p => /Setup.*\.exe$/i.test(p));
  const update = files(quickFolder).find(p => p.endsWith('-update.zip'));
  assert.ok(setup && update, 'Accepted full installer and new quick update are both required');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-repack-'));
  const nsis = path.join(temp, 'old-nsis');
  const unpacked = path.join(temp, 'app');
  const stage = path.join(temp, 'stage');
  execFileSync('7z.exe', ['x', '-y', '-bd', `-o${nsis}`, setup], { stdio: 'ignore' });
  const application = files(nsis).find(p => /app-64\.7z$/i.test(p));
  assert.ok(application, 'Accepted NSIS installer must contain app-64.7z');
  execFileSync('7z.exe', ['x', '-y', '-bd', `-o${unpacked}`, application], { stdio: 'ignore' });
  fs.rmSync(nsis, { recursive: true, force: true });
  const previous = JSON.parse(extractFile(path.join(unpacked, 'resources/app.asar'), 'package.json').toString()).version;
  assert.equal(previous, '1.2.49', 'Only reuse the fully accepted runtime baseline');
  const testInstall = path.join(temp, 'changeFileName更新安装测试');
  fs.mkdirSync(testInstall);
  for (const entry of fs.readdirSync(unpacked)) {
    if (entry === 'resources') continue;
    fs.cpSync(path.join(unpacked, entry), path.join(testInstall, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(testInstall, 'resources'));
  fs.copyFileSync(path.join(unpacked, 'resources/app.asar'), path.join(testInstall, 'resources/app.asar'));
  execFileSync('7z.exe', ['x', '-y', '-bd', `-o${stage}`, update], { stdio: 'ignore' });
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json')));
  assert.equal(manifest.version, pkg.version);
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    assert.ok(name === 'changeFileName.exe' || name === 'app.asar' || name === 'app-update.yml' || /^hongguo-player\/([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(name));
    assert.ok(!name.split('/').includes('..'));
    const source = path.join(stage, name);
    assert.equal(sha256(source), expected, name);
    const target = name === 'changeFileName.exe' ? path.join(unpacked, name) : path.join(unpacked, 'resources', name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  }
  for (const name of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LibreOffice/program/soffice.com', 'faster-whisper', 'video-structure', 'jianying', 'title-fonts', 'hongguo-player/runtime/bin/java.exe']) {
    assert.ok(fs.existsSync(path.join(unpacked, 'resources', name)), name);
  }
  fs.mkdirSync(destination, { recursive: true });
  const config = structuredClone(pkg.build); delete config.beforePack; config.directories.output = destination;
  await build({ targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), prepackaged: unpacked, config, publish: 'never' });
  execFileSync(process.execPath, [path.join(__dirname, 'make-update-release.cjs'), destination], { stdio: 'inherit' });
  fs.writeFileSync(path.join(destination, 'acceptance-paths.json'), JSON.stringify({ testInstall, previous, unpacked, destination }));
  console.log('PASS repacked full automatic-update installer with accepted runtimes and matching 1.2.51 source');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
