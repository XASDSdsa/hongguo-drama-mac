'use strict';
// Electron harness: use the actual packaged updater and a real NSIS installer, not an install mock.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const psQuote = value => value.replace(/'/g, "''");
const versionOf = file => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${psQuote(file)}').VersionInfo.ProductVersion`], { encoding: 'utf8', windowsHide: true }).trim();
let server;
let source;
function probe(exe, name, base) {
  const file = path.join(base, name + '-startup.json');
  execFileSync(exe, ['--user-data-dir=' + path.join(base, name + '-userdata')], {
    env: { ...process.env, AI_DRAMA_STARTUP_PROBE: file }, timeout: 60000, windowsHide: true,
  });
  const data = JSON.parse(fs.readFileSync(file));
  assert.ok(Number.isFinite(data.activationLoaded) && data.pageLoaded == null, 'License gate must remain before the main window');
  return data;
}
async function main() {
  await app.whenReady();
  const output = path.resolve(process.argv[2]);
  const paths = JSON.parse(fs.readFileSync(path.join(output, 'acceptance-paths.json')));
  const exe = path.join(paths.testInstall, 'changeFileName.exe');
  assert.equal(versionOf(exe), paths.previous + '.0');
  const oldProbe = probe(exe, 'before-update', output);
  const metadata = JSON.parse(fs.readFileSync(path.join(output, `release-${require('../package.json').version}.json`)));
  const archive = path.join(paths.unpacked, 'resources/app.asar');
  const { createAppUpdates } = require(archive + '/src/native/app-updates.js');
  const { NsisUpdater } = require(archive + '/node_modules/electron-updater');
  server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
    if (name === 'latest.yml') { res.end(JSON.stringify(metadata)); return; }
    if (path.basename(name) !== name) { res.writeHead(404); res.end(); return; }
    const file = path.join(output, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) { start = Number(range[1]); end = range[2] ? Math.min(end, Number(range[2])) : end; res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
    res.setHeader('Content-Length', end - start + 1); res.setHeader('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const updater = new NsisUpdater({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}/`, useMultipleRangeRequest: false });
  updater.currentVersion = require('semver').parse(paths.previous);
  updater.forceDevUpdateConfig = true;
  updater.updateConfigPath = path.join(paths.unpacked, 'resources/app-update.yml');
  // Keep only this test harness alive to observe the detached real installer completing.
  let requestedQuit = false;
  updater.app.quit = () => { requestedQuit = true; };
  const persistent = path.join(output, 'preserved-user-data');
  fs.mkdirSync(persistent, { recursive: true });
  const markers = { 'data.json': '{"setting":"keep"}', 'online-license.json': '{"license":"keep"}', 'cost-report-template.docx': 'keep template' };
  for (const [name, data] of Object.entries(markers)) fs.writeFileSync(path.join(persistent, name), data);
  let busy = false;
  source = createAppUpdates({ app: { isPackaged: true, getVersion: () => paths.previous }, updater,
    platform: 'win32', installDir: paths.testInstall, busy: () => busy });
  assert.equal((await source.check()).success, true); assert.equal(source.snapshot().status, 'available');
  assert.equal((await source.download()).success, true); assert.equal(source.snapshot().status, 'ready');
  busy = true; assert.equal((await source.install()).success, false); assert.equal(requestedQuit, false);
  busy = false; assert.equal((await source.install()).success, true);
  await sleep(500); assert.equal(requestedQuit, true);
  const started = Date.now();
  while (true) {
    await sleep(10000);
    let version = '';
    try { version = versionOf(exe); } catch (_) {}
    const running = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-Process | Where-Object { $_.Path -eq '${psQuote(updater.installerPath)}' }).Count`], { encoding: 'utf8', windowsHide: true }).trim();
    if (version === metadata.version + '.0' && running === '0') break;
    console.log('Automatic installation:', Math.round((Date.now() - started) / 1000), 'seconds; version=', version, 'installerProcesses=', running);
    assert.ok(Date.now() - started < 15 * 60 * 1000, 'Automatic installer timeout');
  }
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process | Where-Object { $_.Path -eq '${psQuote(exe)}' } | Stop-Process -Force`], { windowsHide: true });
  for (const [name, data] of Object.entries(markers)) assert.equal(fs.readFileSync(path.join(persistent, name), 'utf8'), data);
  for (const file of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'hongguo-player/runtime/bin/java.exe', 'LibreOffice/program/soffice.com']) assert.ok(fs.existsSync(path.join(paths.testInstall, 'resources', file)), file);
  const startup = probe(exe, 'after-update', output);
  const evidence = { from: paths.previous, to: metadata.version, downloadVerified: true, installed: true, chinesePath: true, busyBlocked: true, requestedQuit, preservedUserData: true, oldProbe, startup };
  fs.writeFileSync(path.join(output, 'automatic-update-acceptance.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS real packaged electron-updater download, checksum, busy guard, silent NSIS replacement, Chinese path and retained activation gate');
}
main().then(() => { server?.close(); app.exit(0); }).catch(error => { console.error(error); server?.close(); app.exit(1); });
