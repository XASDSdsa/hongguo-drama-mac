'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractFile } = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const pkg = require('../package.json');
async function main() {
  const app = path.resolve(process.argv[2]);
  const resources = path.join(app, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  assert.equal(JSON.parse(extractFile(archive, 'package.json')).version, pkg.version);
  for (const name of ['main.js', 'preload.js', 'src/native/ai-config.js', 'src/native/ai-providers.json', 'src/native/native-player.js']) {
    assert.deepEqual(extractFile(archive, name), fs.readFileSync(path.join(__dirname, '..', name)), name);
  }
  const components = ['bin/ffmpeg', 'bin/ffprobe', 'bin/whisper-cli', 'models/ggml-tiny.bin',
    'faster-whisper/transcribe-worker', 'video-structure/worker/structure-worker', 'jianying/jianying-runtime',
    'LibreOffice.app/Contents/MacOS/soffice', 'title-fonts', 'hongguo-player/runtime/Contents/Home/bin/java', 'hongguo-player/player.jar'];
  for (const name of components) assert.ok(fs.existsSync(path.join(resources, name)), name);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const exe = path.join(app, 'Contents/MacOS', pkg.build.productName);
  const wire = await getCurrentFuseWire(exe);
  for (const option of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) assert.equal(wire[FuseV1Options[option]], 49);
  for (const option of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) assert.equal(wire[FuseV1Options[option]], 48);
  const java = path.join(resources, 'hongguo-player/runtime/Contents/Home/bin/java');
  assert.match(execFileSync('file', [java], { encoding: 'utf8' }), /arm64/);
  execFileSync(java, ['-version'], { stdio: 'inherit' });
  const resolver = JSON.parse(execFileSync(java, ['-cp', [path.join(resources, 'hongguo-player/player.jar'), path.join(resources, 'hongguo-player/lib/*')].join(path.delimiter),
    'com.hongguotv.core.DesktopPlayerKt', 'invalid-id'], { encoding: 'utf8', timeout: 20000 }));
  assert.equal(resolver.ok, false);
  const probe = path.resolve('dist/mac-startup.json');
  execFileSync(exe, ['--user-data-dir=' + path.resolve('dist/mac-probe-userdata')], {
    env: { ...process.env, AI_DRAMA_STARTUP_PROBE: probe }, stdio: 'inherit', timeout: 60000,
  });
  const startup = JSON.parse(fs.readFileSync(probe));
  assert.ok(Number.isFinite(startup.activationLoaded) && startup.pageLoaded == null, 'License gate must precede main UI');
  fs.writeFileSync('dist/mac-package-acceptance.json', JSON.stringify({ version: pkg.version, platform: 'darwin-arm64',
    components, signed: 'ad-hoc', notarized: false, sourceMatch: true, resolverRuns: true, startup }, null, 2));
  console.log('PASS full Mac package: current source/version, all runtimes, strict signature, ARM64 resolver and startup license gate');
}
main().catch(error => { console.error(error); process.exit(1); });
