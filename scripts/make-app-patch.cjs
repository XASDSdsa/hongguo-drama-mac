'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractFile } = require('@electron/asar');
const { makePatch, hash, invariantHash } = require('./app-patch/pe-patch.cjs');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
const pkg = require('../package.json');
const root = path.join(__dirname, '..');
const BASE_SOURCE = '455cf677e758b05ceec49c5b7955a54e000365f1';
const files = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));

async function main() {
  assert.equal(process.platform, 'win32');
  const [baseDir, quickDir, output] = process.argv.slice(2).map(p => path.resolve(p));
  fs.mkdirSync(output, { recursive: true });
  // A changed bundled runtime needs its own deliberate upgrade, never a silent
  // fallback that sends several GB for an ordinary interface change.
  execFileSync('git', ['diff', '--exit-code', BASE_SOURCE, '--',
    'scripts/hongguo-player', 'scripts/setup-hongguo-player.cjs',
    'scripts/setup-libreoffice-win.ps1', 'scripts/setup-faster-whisper.cjs',
    'scripts/setup-whisper.js', 'scripts/setup-video-structure.cjs',
    'scripts/setup-jianying-runtime.cjs', 'scripts/setup-title-fonts.cjs',
    'scripts/create-jianying-draft.py', 'scripts/create-jianying-simple-draft.py', 'scripts/check-jianying-draft.py',
  ], { cwd: root, stdio: 'inherit' });
  const work = path.join(output, 'patch-work');
  fs.mkdirSync(work, { recursive: true });
  const base = path.join(work, 'base'), target = path.join(work, 'target');
  for (const [source, destination] of [[baseDir, base], [quickDir, target]]) {
    const zip = files(source).find(file => /-(?:update|patch-baseline)\.zip$/.test(file));
    assert.ok(zip, 'Verified quick-update artifact required');
    if (source === baseDir) assert.equal(hash(fs.readFileSync(zip)), '9f07dc0b2d0f38355b7def6c9e4de9d341241bdfcf832b0f1e5a900c9104bad8', 'Accepted baseline archive checksum');
    execFileSync('7z.exe', ['x', '-y', '-bd', '-o' + destination, zip], { stdio: 'ignore' });
  }
  const oldManifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json')));
  const newManifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json')));
  assert.equal(oldManifest.version, '1.2.51');
  assert.equal(newManifest.version, pkg.version);
  const baseline = JSON.parse(fs.readFileSync(path.join(base, 'baseline.json')));
  const reconstructed = fs.readFileSync(path.join(target, 'changeFileName.exe'));
  assert.equal(reconstructed.length, baseline.size);
  assert.equal(invariantHash(reconstructed, baseline.parts), baseline.immutableSha256);
  for (const part of baseline.parts) fs.readFileSync(path.join(base, part.file)).copy(reconstructed, part.offset);
  assert.equal(hash(reconstructed), baseline.sha256);
  fs.writeFileSync(path.join(base, 'changeFileName.exe'), reconstructed);
  for (const stage of [base, target]) {
    const manifest = stage === base ? oldManifest : newManifest;
    for (const name of ['changeFileName.exe', 'app.asar', 'app-update.yml']) {
      assert.equal(hash(fs.readFileSync(path.join(stage, name))), manifest.sha256[name]);
    }
  }
  const oldPackage = JSON.parse(extractFile(path.join(base, 'app.asar'), 'package.json'));
  const newPackage = JSON.parse(extractFile(path.join(target, 'app.asar'), 'package.json'));
  const oldSourcePackage = JSON.parse(execFileSync('git', ['show', BASE_SOURCE + ':package.json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(oldPackage.version, '1.2.51');
  assert.equal(newPackage.version, pkg.version);
  assert.deepEqual(newPackage.dependencies, pkg.dependencies);
  assert.equal(oldSourcePackage.devDependencies.electron, pkg.devDependencies.electron);
  assert.deepEqual(oldSourcePackage.build.win.extraResources, pkg.build.win.extraResources);
  assert.deepEqual(oldSourcePackage.build.extraResources, pkg.build.extraResources);
  for (const [name, sha256] of Object.entries(oldManifest.sha256)) {
    if (name.startsWith('hongguo-player/runtime/')) assert.equal(newManifest.sha256[name], sha256, 'JRE changed: ' + name);
  }
  // The accepted 1.2.51 artifact, not an arbitrary same-version executable.
  assert.equal(oldManifest.sha256['changeFileName.exe'], '6ec08a5862a796c0e8cd8a5fcd1cf6ead5f825cec17f34d282dc10ed6e9615c8');
  const pe = makePatch(fs.readFileSync(path.join(base, 'changeFileName.exe')), fs.readFileSync(path.join(target, 'changeFileName.exe')));
  const payload = path.join(work, 'payload');
  fs.mkdirSync(payload, { recursive: true });
  for (const part of pe.parts) fs.writeFileSync(path.join(payload, part.file), part.data);
  const manifest = { format: 1, version: pkg.version, minimumVersion: '1.2.51',
    exe: { ...pe, parts: pe.parts.map(({ data, ...part }) => part) },
    sha256: Object.fromEntries(['app.asar', 'app-update.yml'].map(name => [name, newManifest.sha256[name]])) };
  fs.writeFileSync(path.join(payload, 'patch.json'), JSON.stringify(manifest, null, 2));
  for (const name of ['app.asar', 'app-update.yml']) fs.copyFileSync(path.join(target, name), path.join(payload, name));
  fs.copyFileSync(path.join(__dirname, 'app-patch/apply.ps1'), path.join(payload, 'apply.ps1'));
  const installer = path.join(output, `changeFileName-Setup-${pkg.version}.exe`);
  const nsis = await getMakeNsisPath();
  execFileSync(nsis.path, ['/V2', `/DVERSION=${pkg.version}`, `/DOUTPUT=${installer}`, `/DPAYLOAD=${payload}`, path.join(__dirname, 'app-patch/install.nsi')],
    { env: { ...process.env, ...nsis.env }, stdio: 'inherit' });
  const bytes = fs.statSync(installer).size;
  assert.ok(bytes < 25 * 1024 * 1024, `Small update exceeds 25 MiB (${bytes}); refuse full-package fallback`);
  execFileSync(process.execPath, [path.join(__dirname, 'make-update-release.cjs'), output], { stdio: 'inherit' });
  const releasePath = path.join(output, `release-${pkg.version}.json`);
  const release = JSON.parse(fs.readFileSync(releasePath));
  release.updateType = 'application-patch';
  release.minimumVersion = '1.2.51';
  release.releaseNotes = '剧集管理中移除海报角标输入栏；本次只更新应用程序，保留已安装的运行库。';
  fs.writeFileSync(releasePath, JSON.stringify(release, null, 2));
  fs.writeFileSync(path.join(output, 'patch-paths.json'), JSON.stringify({ base, target, payload, installer, bytes }));
  console.log(`PASS small application update: ${bytes} bytes; no Electron body, JRE, FFmpeg, models or Office runtime payload`);
}
main().catch(error => { console.error(error); process.exit(1); });
