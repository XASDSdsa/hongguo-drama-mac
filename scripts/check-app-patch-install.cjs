'use strict';
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { hash } = require('./app-patch/pe-patch.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => hash(fs.readFileSync(file));
const quote = value => value.replace(/'/g, "''");
const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
let server;

async function main() {
  await app.whenReady();
  const output = path.resolve(process.argv[2]);
  const paths = JSON.parse(fs.readFileSync(path.join(output, 'patch-paths.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.payload, 'patch.json')));
  const oldManifest = JSON.parse(fs.readFileSync(path.join(paths.base, 'manifest.json')));
  const install = path.join(output, '安装位置 带空格与中文');
  fs.cpSync(path.dirname(process.execPath), install, { recursive: true });
  fs.rmSync(path.join(install, 'electron.exe'), { force: true });
  const resources = path.join(install, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.cpSync(path.join(paths.target, 'hongguo-player'), path.join(resources, 'hongguo-player'), { recursive: true });
  fs.cpSync(path.join(paths.base, 'hongguo-player'), path.join(resources, 'hongguo-player'), { recursive: true });
  const exe = path.join(install, 'changeFileName.exe');
  const archive = path.join(resources, 'app.asar');
  function resetBase() {
    fs.copyFileSync(path.join(paths.base, 'changeFileName.exe'), exe);
    for (const name of ['app.asar', 'app-update.yml']) fs.copyFileSync(path.join(paths.base, name), path.join(resources, name));
  }
  resetBase();
  assert.equal(require(archive + '/package.json').version, '1.2.51');
  const userData = path.join(output, '实际用户数据');
  fs.mkdirSync(userData, { recursive: true });
  const markers = { 'data.json': '{"setting":"keep"}', 'online-license.json': '{"license":"keep"}', 'cost-report-template.docx': 'preserve template' };
  for (const [name, content] of Object.entries(markers)) fs.writeFileSync(path.join(userData, name), content);
  // A large unrelated runtime file makes an accidental destructive install visible.
  const sentinel = path.join(resources, 'LibreOffice/runtime-must-stay.bin');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, Buffer.alloc(4 * 1024 * 1024, 73));
  const runtimeHashes = Object.fromEntries(['hongguo-player/runtime/bin/java.exe', 'hongguo-player/player.jar', 'LibreOffice/runtime-must-stay.bin'].map(name => [name, sha(path.join(resources, name))]));
  function runApply(script, succeeds = true, pattern) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallDir', install], { stdio: 'pipe', timeout: 90000, windowsHide: true });
      assert.ok(succeeds, 'Expected the real installer script to reject this update');
    } catch (error) {
      if (succeeds) throw error;
      assert.ok(error.status > 0, 'Must fail in PowerShell, not in the test assertion');
      if (pattern) assert.match(String(error.stdout), pattern);
    }
  }
  function assertBase() {
    assert.equal(sha(exe), oldManifest.sha256['changeFileName.exe']);
    assert.equal(sha(archive), oldManifest.sha256['app.asar']);
  }
  const script = path.join(paths.payload, 'apply.ps1');
  const source = fs.readFileSync(script, 'utf8');
  const checkpoint = '# Failure-injection tests replace this comment; production has no test switch.';
  assert.ok(source.includes(checkpoint));
  const injected = path.join(paths.payload, 'failure-test.ps1');
  fs.writeFileSync(injected, source.replace(checkpoint, "throw 'Injected mid-copy failure'"));
  runApply(injected, false, /Injected mid-copy failure/); assertBase();
  fs.writeFileSync(injected, source.replace(checkpoint, 'exit 7'));
  runApply(injected, false);
  assert.ok(fs.existsSync(path.join(install, '.app-update-transaction/pending.json')));
  runApply(script); // Journal restores the interrupted pair before applying again.
  assert.equal(sha(exe), manifest.exe.sha256); assert.equal(sha(archive), manifest.sha256['app.asar']);
  resetBase();
  const bad = fs.readFileSync(exe); bad[2000] ^= 1; fs.writeFileSync(exe, bad);
  runApply(script, false, /runtime differs/); assert.equal(sha(exe), hash(bad));
  resetBase();
  const goodAsar = fs.readFileSync(path.join(paths.payload, 'app.asar'));
  fs.writeFileSync(path.join(paths.payload, 'app.asar'), 'corrupt download');
  runApply(script, false, /checksum mismatch/); assertBase();
  fs.writeFileSync(path.join(paths.payload, 'app.asar'), goodAsar);
  fs.unlinkSync(injected);

  const metadata = JSON.parse(fs.readFileSync(path.join(output, `release-${manifest.version}.json`)));
  let servedBytes = 0;
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
    if (name === 'latest.yml') { res.end(JSON.stringify(metadata)); return; }
    const file = path.join(output, name);
    if (path.basename(name) !== name || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) { start = Number(range[1]); end = range[2] ? Math.min(end, Number(range[2])) : end; res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
    res.setHeader('Content-Length', end - start + 1); res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD') res.end(); else { servedBytes += end - start + 1; fs.createReadStream(file, { start, end }).pipe(res); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  // Load the actual old application's updater/controller, not this checkout's.
  const oldRequire = createRequire(archive + '/package.json');
  const { createAppUpdates } = oldRequire('./src/native/app-updates.js');
  const { NsisUpdater } = oldRequire('electron-updater');
  const updater = new NsisUpdater({ provider: 'generic', url: fixtureUrl, useMultipleRangeRequest: false });
  const updaterRequire = createRequire(oldRequire.resolve('electron-updater'));
  updater.currentVersion = updaterRequire('semver').parse('1.2.51');
  updater.forceDevUpdateConfig = true;
  const config = path.join(output, 'patch-test-update.yml');
  fs.writeFileSync(config, JSON.stringify({ provider: 'generic', url: fixtureUrl, updaterCacheDirName: 'changeFileName-small-update-test-' + Date.now() }));
  updater.updateConfigPath = config;
  let requestedQuit = false, busy = false;
  updater.app.quit = () => { requestedQuit = true; };
  const controller = createAppUpdates({ app: { isPackaged: true, getVersion: () => '1.2.51' }, updater,
    platform: 'win32', installDir: install, busy: () => busy });
  assert.equal((await controller.check()).success, true);
  assert.equal((await controller.download()).success, true);
  assert.equal(controller.snapshot().status, 'ready');
  busy = true; assert.equal((await controller.install()).success, false); assert.equal(requestedQuit, false);
  busy = false; assert.equal((await controller.install()).success, true);
  const deadline = Date.now() + 120000;
  while (true) {
    await sleep(1500);
    if (sha(exe) === manifest.exe.sha256 && !fs.existsSync(path.join(install, '.app-update-transaction'))) break;
    assert.ok(Date.now() < deadline, 'Small patch installation timeout');
  }
  assert.equal(requestedQuit, true);
  await sleep(3000);
  const restarted = ps(`@(Get-Process -Name changeFileName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${quote(exe)}' }).Count`).trim();
  assert.ok(Number(restarted) > 0, 'Real updater must restart the installed application');
  ps(`Get-Process -Name changeFileName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${quote(exe)}' } | Stop-Process -Force`);
  for (const [name, content] of Object.entries(markers)) assert.equal(fs.readFileSync(path.join(userData, name), 'utf8'), content);
  for (const [name, digest] of Object.entries(runtimeHashes)) assert.equal(sha(path.join(resources, name)), digest);
  execFileSync(path.join(resources, 'hongguo-player/runtime/bin/java.exe'), ['-version'], { stdio: 'pipe', timeout: 20000 });
  const probe = path.join(output, 'after-patch-startup.json');
  execFileSync(exe, ['--user-data-dir=' + path.join(output, 'probe-user-data')], { env: { ...process.env, AI_DRAMA_STARTUP_PROBE: probe }, windowsHide: true, timeout: 60000 });
  const startup = JSON.parse(fs.readFileSync(probe));
  assert.ok(Number.isFinite(startup.activationLoaded) && startup.pageLoaded == null, 'License gate must remain before the main window');
  assert.equal(sha(exe), manifest.exe.sha256); assert.equal(sha(archive), manifest.sha256['app.asar']);
  assert.equal(ps(`(Get-Item -LiteralPath '${quote(exe)}').VersionInfo.ProductVersion`).trim(), manifest.version + '.0');
  runApply(script); assert.equal(sha(exe), manifest.exe.sha256); // Repeat is safe.
  assert.ok(paths.bytes < 25 * 1024 * 1024 && servedBytes < 25 * 1024 * 1024);
  const evidence = { from: '1.2.51', to: manifest.version, type: 'application-patch', bytes: paths.bytes, servedBytes,
    downloadVerified: true, installed: true, chinesePath: true, busyBlocked: true, requestedQuit,
    preservedUserData: true, runtimesUnchanged: true, rollback: true, interruptedRecovery: true, checksumRejected: true,
    runtimeMismatchRejected: true, restarted: true, startup };
  fs.writeFileSync(path.join(output, 'automatic-update-acceptance.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS actual 1.2.51 updater → small patch:', evidence);
}
main().then(() => { server?.close(); app.exit(0); }).catch(error => { console.error(error); server?.close(); app.exit(1); });
