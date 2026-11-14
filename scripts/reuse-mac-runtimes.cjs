'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { extractFile } = require('@electron/asar');
const pkg = require('../package.json');
const BASE = '4ed04289f8b06c9b129175e5ced465403c4ca7b2';
const root = path.join(__dirname, '..');
const walk = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));
function main() {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const accepted = JSON.parse(execFileSync('git', ['show', BASE + ':package.json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(accepted.version, '1.2.38');
  assert.equal(pkg.devDependencies.electron, accepted.devDependencies.electron);
  assert.deepEqual(pkg.build.mac.extraResources.filter(item => item.to !== 'hongguo-player'), accepted.build.mac.extraResources);
  assert.deepEqual(pkg.build.extraResources, accepted.build.extraResources);
  execFileSync('git', ['diff', '--exit-code', BASE, '--', 'scripts/setup-ffmpeg-mac.js', 'scripts/setup-faster-whisper.cjs',
    'scripts/setup-video-structure.cjs', 'scripts/setup-jianying-runtime.cjs', 'scripts/setup-title-fonts.cjs',
    'scripts/setup-whisper.js', 'scripts/setup-libreoffice-mac.sh', 'scripts/jianying-requirements.txt'], { cwd: root, stdio: 'inherit' });
  const input = path.resolve(process.argv[2]);
  const dmg = walk(input).find(file => file.endsWith('.dmg'));
  const checksum = walk(input).find(file => file.endsWith('.sha256'));
  assert.ok(dmg && checksum, 'Accepted Mac DMG and its checksum required');
  const expected = fs.readFileSync(checksum, 'utf8').trim().split(/\s+/)[0];
  assert.equal(execFileSync('shasum', ['-a', '256', dmg], { encoding: 'utf8' }).split(/\s+/)[0], expected);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-mac-'));
  try {
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'inherit' });
    const app = fs.readdirSync(mount).find(name => name.endsWith('.app'));
    assert.ok(app);
    execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(mount, app)], { stdio: 'inherit' });
    const resources = path.join(mount, app, 'Contents/Resources');
    assert.equal(JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json')).version, accepted.version);
    for (const item of pkg.build.mac.extraResources) {
      if (!item.from.startsWith('build/') || item.to === 'hongguo-player') continue;
      const source = path.join(resources, item.to);
      const destination = path.join(root, item.from);
      if (item.filter) {
        fs.mkdirSync(destination, { recursive: true });
        for (const name of fs.readdirSync(source)) {
          if (!item.filter.some(pattern => new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name))) continue;
          fs.cpSync(path.join(source, name), path.join(destination, name), { recursive: true, verbatimSymlinks: true });
        }
      } else fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    }
    // The accepted DMG and its complete app signature authenticate these files.
    // App signing can alter a Mach-O signature after the original build manifest
    // was written; retain strict checks, rebasing only those signed executables.
    for (const folder of ['build/faster-whisper/darwin-arm64', 'build/video-structure/darwin-arm64', 'build/jianying/darwin-arm64']) {
      const base = path.join(root, folder);
      const file = path.join(base, folder.includes('video-structure') ? 'bundle.json' : 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(file));
      const rebased = [];
      for (const [name, expectedHash] of Object.entries(manifest.sha256 || {})) {
        const entry = path.resolve(base, name);
        assert.ok(entry.startsWith(base + path.sep));
        const actual = createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
        if (actual === expectedHash) continue;
        assert.match(execFileSync('file', [entry], { encoding: 'utf8' }), /Mach-O/, name);
        execFileSync('codesign', ['--verify', '--strict', entry], { stdio: 'inherit' });
        manifest.sha256[name] = actual;
        rebased.push(name);
      }
      manifest.reusedFrom = { version: accepted.version, run: '42785018549', signedFilesRebased: rebased };
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    }
  } finally {
    execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
    fs.rmSync(mount, { recursive: true, force: true });
  }
  fs.rmSync(input, { recursive: true, force: true });
  console.log('PASS reused unchanged accepted Mac runtimes; old application code excluded');
}
main();
