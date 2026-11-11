'use strict';
// Build the matching Windows exe + ASAR without re-bundling the installed runtimes.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const { extractFile } = require('@electron/asar');
const { verifyPlayerBundle } = require('./check-hongguo-player.cjs');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const baseVersions = ['1.2.39', '1.2.40', '1.2.41', '1.2.42', '1.2.43', '1.2.44', '1.2.45', '1.2.46', '1.2.47', '1.2.48'];
const exeName = `${pkg.build.productName}.exe`;
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  assert.equal(process.platform, 'win32', 'Build this quick update on Windows');
  verifyPlayerBundle(root);
  const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'quick'));
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(out, 'work-'));
  try {
    const config = structuredClone(pkg.build);
    delete config.beforePack;
    config.extraResources = [];
    config.win.extraResources = [{ from: path.join(root, 'build/hongguo-player/win32-x64'), to: 'hongguo-player' }];
    config.win.extraFiles = [];
    config.directories.output = path.join(work, 'builder');
    const configFile = path.join(work, 'builder.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    await build({ targets: Platform.WINDOWS.createTarget('dir', Arch.x64), config: configFile, publish: 'never' });
    const unpacked = path.join(config.directories.output, 'win-unpacked');
    const exe = path.join(unpacked, exeName);
    const asar = path.join(unpacked, 'resources', 'app.asar');
    assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).version, pkg.version);
    for (const file of ['main.js', 'src/native/app-source.js', 'src/native/native-player.js', 'src/native/hongguo.js', 'dist-react/index.html', 'src/native/cost-report/page-look.js', 'src/native/cost-report/font-check.js', 'src/native/cost-report/wps.js']) {
      assert.deepEqual(extractFile(asar, path.normalize(file)), fs.readFileSync(path.join(root, file)), file);
    }
    const wire = await getCurrentFuseWire(exe);
    for (const option of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) {
      assert.equal(wire[FuseV1Options[option]], 49, option);
    }
    for (const option of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) {
      assert.equal(wire[FuseV1Options[option]], 48, option);
    }
    const probe = path.join(work, 'startup.json');
    execFileSync(exe, [`--user-data-dir=${path.join(work, 'user-data')}`], {
      cwd: unpacked,
      env: { ...process.env, AI_DRAMA_STARTUP_PROBE: probe },
      stdio: 'inherit',
      timeout: 60_000,
      windowsHide: true,
    });
    const startup = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.ok(Number.isFinite(startup.activationLoaded) && startup.pageLoaded == null, JSON.stringify(startup));

    const stage = path.join(work, 'stage');
    fs.mkdirSync(stage);
    fs.copyFileSync(exe, path.join(stage, exeName));
    fs.copyFileSync(asar, path.join(stage, 'app.asar'));
    for (const name of ['update.cmd', 'update.ps1', 'README.txt']) {
      fs.copyFileSync(path.join(__dirname, 'quick-update', name), path.join(stage, name));
    }
    const player = path.join(root, 'build/hongguo-player/win32-x64');
    fs.cpSync(player, path.join(stage, 'hongguo-player'), { recursive: true });
    const files = [exeName, 'app.asar', ...fs.readdirSync(player, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => 'hongguo-player/' + path.relative(player, path.join(item.parentPath, item.name)).split(path.sep).join('/'))];
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
      version: pkg.version,
      requires: baseVersions,
      sha256: Object.fromEntries(files.map((name) => [name, sha256(path.join(stage, name))])),
    }, null, 2));
    require('./check-player-update.cjs').verifyPlayerUpdate(stage, unpacked, work);
    const zip = path.join(out, `ai-drama-assistant-${pkg.version}-update.zip`);
    if (fs.existsSync(zip)) fs.unlinkSync(zip);
    execFileSync('7z.exe', ['a', '-tzip', '-mx=5', zip, '*'], { cwd: stage, stdio: 'inherit' });
    execFileSync('7z.exe', ['t', zip], { stdio: 'inherit' });
    console.log(`Quick update verified: ${zip}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
