'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createAppUpdates } = require('../src/native/app-updates');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'in-app-update-'));
const file = path.join(temp, 'setup.exe'); fs.writeFileSync(file, 'MZ-test-installer');
const sha512 = createHash('sha512').update(fs.readFileSync(file)).digest('base64');
class FakeUpdater extends EventEmitter {
  constructor() { super(); this.checks = 0; this.downloads = 0; this.installs = 0; this.version = '1.2.51'; this.installerPath = file; }
  async checkForUpdates() {
    this.checks++; this.emit('checking-for-update'); await new Promise(resolve => setTimeout(resolve, 5));
    if (this.checkError) throw new Error('network offline');
    this.onCheck?.();
    const info = { version: this.version, releaseNotes: '更新说明', files: [{ url: 'setup.exe', sha512 }] };
    this.emit(this.version === '1.2.51' ? 'update-available' : 'update-not-available', info);
    return { updateInfo: info };
  }
  async downloadUpdate() {
    this.downloads++; await new Promise(resolve => setTimeout(resolve, 5));
    if (this.downloadError) throw new Error('download interrupted');
    this.emit('download-progress', { percent: 80 });
    this.emit('update-downloaded', { version: this.version });
  }
  quitAndInstall(silent, restart) { assert.equal(silent, true); assert.equal(restart, true); this.installs++; }
}
(async () => {
  const updater = new FakeUpdater(); let busy = false;
  const service = createAppUpdates({ app: { isPackaged: true, getVersion: () => '1.2.50' }, updater, platform: 'win32', busy: () => busy });
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.allowDowngrade, false);
  await Promise.all([service.check(), service.check()]); assert.equal(updater.checks, 1);
  updater.downloadError = true; assert.equal((await service.download()).success, false);
  updater.downloadError = false;
  await Promise.all([service.download(), service.download()]); assert.equal(updater.downloads, 2);
  assert.equal(service.snapshot().status, 'ready');
  await service.check(); assert.equal(updater.checks, 1, 'periodic checks preserve the downloaded update');
  busy = true; assert.equal((await service.install()).success, false); assert.equal(updater.installs, 0);
  busy = false; updater.onCheck = () => { busy = true; };
  assert.equal((await service.install()).success, false); assert.equal(updater.installs, 0, 'a task started while rechecking blocks install');
  busy = false; updater.onCheck = null; updater.checkError = true;
  assert.equal((await service.install()).success, false); assert.equal(service.snapshot().status, 'ready');
  updater.checkError = false; updater.version = '0.0.0';
  assert.equal((await service.install()).success, false); assert.equal(updater.installs, 0, 'withdrawn releases cannot install');
  updater.version = '1.2.51'; await service.check(); await service.download();
  fs.appendFileSync(file, 'tampering'); assert.equal((await service.install()).success, false); assert.equal(updater.installs, 0);
  fs.writeFileSync(file, 'MZ-test-installer'); await service.download();
  await Promise.all([service.install(), service.install()]); assert.equal(updater.installs, 1);
  assert.equal(service.snapshot().status, 'installing');
  const unsupported = createAppUpdates({ app: { isPackaged: true, getVersion: () => '1.2.51' }, platform: 'darwin' });
  assert.equal(unsupported.snapshot().status, 'unsupported');
  console.log('PASS in-app updates: single check/download/install, interruption retry, busy-task protection, withdrawal, offline recheck and installer checksum');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
