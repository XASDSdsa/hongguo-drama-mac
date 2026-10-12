// Regression checks for renderer event delivery during BrowserWindow teardown.
// No Electron window is opened and no media/network work is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const sourcePath = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const req = createRequire(sourcePath);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-renderer-lifecycle-'));

const app = new EventEmitter();
Object.assign(app, {
  getVersion: () => 'test',
  getPath: () => temp,
  commandLine: { appendSwitch() {} },
  whenReady: () => ({ then() {} }),
});
const electron = {
  app,
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle() {}, on() {} },
  dialog: {},
  shell: {},
  session: {},
  protocol: { registerSchemesAsPrivileged() {} },
  Menu: {},
};
const context = vm.createContext({
  require: name => name === 'electron' ? electron : req(name),
  __dirname: path.dirname(sourcePath),
  process,
  Buffer,
  URL,
  URLSearchParams,
  AbortSignal,
  setTimeout,
  clearTimeout,
  setImmediate,
  clearImmediate,
  console: { log() {}, warn() {}, error() {} },
});
vm.runInContext(source, context, { filename: sourcePath });
const run = code => vm.runInContext(code, context, { filename: sourcePath });

run('rendererClosing = false; mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } }; sent = [];');
assert.equal(run("sendToRenderer('healthy', { ok: true })"), true);
assert.deepEqual(JSON.parse(JSON.stringify(run('sent'))), [['healthy', { ok: true }]]);

run('mainWindow = { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: () => { throw new Error(\'should not send\'); } } };');
assert.equal(run("sendToRenderer('destroyed-window', {})"), false);

run('mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: () => { throw new Error(\'should not send\'); } } };');
assert.equal(run("sendToRenderer('destroyed-webcontents', {})"), false);

run('mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error(\'Object has been destroyed\'); } } };');
assert.equal(run("sendToRenderer('teardown-race', {})"), false);

run('mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error(\'fixture send failure\'); } } };');
assert.throws(() => run("sendToRenderer('unexpected-error', {})"), /fixture send failure/);

run('rendererClosing = true; mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error(\'should not send\'); } } };');
assert.equal(run("sendToRenderer('closing', {})"), false);

const closed = source.indexOf("mainWindow = null;", source.indexOf("createdWindow.on('closed'"));
const cancelled = source.indexOf('cancelAllQuchongBatches();', closed);
assert.ok(closed >= 0 && cancelled > closed, 'closed handler must detach the BrowserWindow before cancelling jobs');

console.log('PASS renderer lifecycle guards (6 cases)');
fs.rmSync(temp, { recursive: true, force: true });
