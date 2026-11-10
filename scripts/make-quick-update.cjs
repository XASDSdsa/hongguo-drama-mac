'use strict';
// Build the matching Windows exe + ASAR without re-bundling the installed runtimes.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const { extractFile } = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const pkg = require('../package.json');
const { setupReportFonts } = require('./setup-report-fonts.cjs');

const root = path.join(__dirname, '..');
const baseVersion = '1.2.39';
const exeName = `${pkg.build.productName}.exe`;
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  assert.equal(process.platform, 'win32', 'Build this quick update on Windows');
  const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'quick'));
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(out, 'work-'));
  try {
    const config = structuredClone(pkg.build);
    delete config.beforePack;
    config.extraResources = [];
    config.win.extraResources = [];
    config.win.extraFiles = [];
    config.directories.output = path.join(work, 'builder');
    const configFile = path.join(work, 'builder.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    await build({ targets: Platform.WINDOWS.createTarget('dir', Arch.x64), config: configFile, publish: 'never' });
    const unpacked = path.join(config.directories.output, 'win-unpacked');
    const exe = path.join(unpacked, exeName);
    const asar = path.join(unpacked, 'resources', 'app.asar');
    assert.equal(JSON.parse(extractFile(asar, 'package.json').toString()).version, pkg.version);
    for (const file of ['dist-react/index.html', 'src/native/cost-report/page-look.js']) {
      assert.ok(extractFile(asar, path.normalize(file)).length > 0);
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
    const fontDir = path.join(stage, 'fonts');
    await setupReportFonts(fontDir);
    fs.copyFileSync(exe, path.join(stage, exeName));
    fs.copyFileSync(asar, path.join(stage, 'app.asar'));
    for (const name of ['update.cmd', 'update.ps1', 'README.txt']) {
      fs.copyFileSync(path.join(__dirname, 'quick-update', name), path.join(stage, name));
    }
    const files = [exeName, 'app.asar', ...fs.readdirSync(fontDir).map((name) => `fonts/${name}`)];
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
      version: pkg.version,
      requires: baseVersion,
      sha256: Object.fromEntries(files.map((name) => [name, sha256(path.join(stage, name))])),
    }, null, 2));
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
