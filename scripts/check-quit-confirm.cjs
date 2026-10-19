// 退出确认：有任务在跑时关窗口/⌘Q 先问一次；选「继续处理」不退出，选「停止并退出」才退出；
// Windows 关机/注销（query-session-end / session-end）不弹框，免得系统提示「此应用正在阻止关机」。
// 不打开真实窗口，也不启动任何下载或处理。
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-quit-confirm-'));

// 任意方法都能调用、返回自己的假对象：createWindow 里用到的 webContents / session 等 API 都能走通。
function stub(record) {
  const target = function () {};
  const handler = {
    get(_t, key) {
      if (key === 'on' || key === 'once')
        return (event, fn) => {
          record?.push([event, fn]);
          return proxy;
        };
      if (key === 'isDestroyed') return () => false;
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      return proxy;
    },
    apply() {
      return proxy;
    },
  };
  const proxy = new Proxy(target, handler);
  return proxy;
}

const windowEvents = [];
const app = new EventEmitter();
let quitCalls = 0;
Object.assign(app, {
  getVersion: () => 'test',
  getPath: () => temp,
  isReady: () => true,
  quit: () => {
    quitCalls += 1;
  },
  commandLine: { appendSwitch() {} },
  whenReady: () => ({ then() {} }),
});
const dialogCalls = [];
let nextResponse = 0;
const dialog = {
  showMessageBox: (...args) => {
    dialogCalls.push(args);
    return Promise.resolve({ response: nextResponse });
  },
};
const electron = {
  app,
  BrowserWindow: class BrowserWindow {
    constructor() {
      return stub(windowEvents);
    }
  },
  ipcMain: { handle() {}, on() {} },
  dialog,
  shell: {},
  session: {},
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  Menu: {},
};
const context = vm.createContext({
  require: (name) => (name === 'electron' ? electron : req(name)),
  __dirname: path.dirname(sourcePath),
  process,
  Buffer,
  URL,
  URLSearchParams,
  AbortSignal,
  AbortController,
  setTimeout,
  clearTimeout,
  setImmediate,
  clearImmediate,
  console: { log() {}, warn() {}, error() {} },
});
vm.runInContext(source, context, { filename: sourcePath });
const run = (code) => vm.runInContext(code, context, { filename: sourcePath });
const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  // 让 appBusy() 为真：有一个下载在跑。
  run('activeDownloads = 1');
  const quitEvent = () => {
    let prevented = 0;
    app.emit('before-quit', { preventDefault: () => (prevented += 1) });
    return prevented;
  };

  // 1. 忙时 ⌘Q：拦下并问一次；选「继续处理」不退出。
  nextResponse = 0;
  assert.equal(quitEvent(), 1, 'busy quit must be held for confirmation');
  assert.equal(dialogCalls.length, 1);
  await tick();
  await tick();
  assert.equal(quitCalls, 0, '「继续处理」 must not quit');
  assert.equal(run('quitConfirmed'), false);

  // 2. 选「停止并退出」：确认后才真正退出，之后的 before-quit 不再拦。
  nextResponse = 1;
  assert.equal(quitEvent(), 1);
  await tick();
  await tick();
  assert.equal(quitCalls, 1, '「停止并退出」 must quit');
  assert.equal(run('quitConfirmed'), true);
  assert.equal(quitEvent(), 0, 'confirmed quit must go through');

  // 3. Windows 关机 / 注销：窗口收到 query-session-end 后，关窗口不再弹确认框。
  run('quitConfirmed = false');
  dialogCalls.length = 0;
  run('createWindow()');
  const handlers = (name) => windowEvents.filter(([event]) => event === name).map(([, fn]) => fn);
  assert.ok(handlers('query-session-end').length, 'window must listen for query-session-end');
  assert.ok(handlers('session-end').length, 'window must listen for session-end');
  const close = handlers('close');
  assert.ok(close.length, 'window must have a close handler');
  let closePrevented = 0;
  close.forEach((fn) => fn({ preventDefault: () => (closePrevented += 1) }));
  assert.equal(closePrevented, 1, 'busy close (no shutdown) must ask first');
  await tick();
  dialogCalls.length = 0;
  closePrevented = 0;
  run('quitDialogOpen = false');
  handlers('query-session-end').forEach((fn) => fn({ preventDefault() {} }));
  close.forEach((fn) => fn({ preventDefault: () => (closePrevented += 1) }));
  assert.equal(closePrevented, 0, 'shutdown must not be blocked by the confirm dialog');
  assert.equal(dialogCalls.length, 0);
  console.log('PASS quit confirmation (ask when busy, keep running, confirmed quit, shutdown passes through)');
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
