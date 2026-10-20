// 软件改名为「AI短剧助手」：界面、窗口、安装包、用户能看到的文件名里不再出现「红果短剧」；
// 旧名字的数据目录（设置、下载记录）第一次启动时挪到新目录，已经有新数据时不覆盖。来源标签「红果」保留。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// 1. 名字
const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.build.productName, 'AI短剧助手');
assert.equal(pkg.build.nsis.shortcutName, 'AI短剧助手');
assert.equal(pkg.name, 'ai-drama-assistant', 'release files are named ai-drama-assistant-<version>-…');
assert.match(read('index.html'), /<title>AI短剧助手<\/title>/);
assert.match(read('main.js'), /const APP_TITLE = 'AI短剧助手';/);
const app = read('src/App.jsx');
assert.ok(!app.includes('红果短剧'), 'the sidebar and toolbar show the new name');
assert.equal((app.match(/AI短剧助手/g) || []).length, 3);
for (const file of ['NOTICE', 'THIRD-PARTY-NOTICES.md']) assert.match(read(file), /本软件（AI短剧助手）/);
// 用户能看到的文件 / 进程名：草稿说明文件、处理中的临时文件、剪映运行时进程。
for (const file of [
  'main.js',
  'src/native/quchong.js',
  'scripts/create-jianying-draft.py',
  'scripts/create-jianying-simple-draft.py',
  'scripts/jianying-runtime.spec',
  'scripts/build-jianying-runtime.py',
]) {
  const text = read(file);
  assert.ok(!/hongguo-draft-manifest|\.hongguo-quchong|hongguo-jianying\b/.test(text), `${file} has no old file names`);
}
// 打包和发布脚本里不再有旧的产物名。
for (const file of [
  '.github/workflows/mac-release.yml',
  '.github/workflows/windows-release.yml',
  'scripts/prepare-release-assets.js',
]) {
  const text = read(file);
  assert.ok(!/红果短剧|hongguo-downloader/.test(text), `${file} has no old product or asset names`);
}
// 「我的剧库」播放模块已经去掉。
assert.ok(!app.includes('我的剧库') && !app.includes('Player'), 'the playback page is gone');
assert.ok(!fs.existsSync(path.join(root, 'src/components/Player.jsx')));
assert.ok(!/playSeries|prepareOnlinePlay|transcodeForPlayback/.test(read('preload.js')));
console.log('PASS the new name is used everywhere a user can see it; the player page is gone');

// 2. 数据目录迁移
function boot(appData, userData) {
  const file = path.join(root, 'main.js'),
    req = createRequire(file),
    electronApp = new EventEmitter();
  Object.assign(electronApp, {
    getVersion: () => 'test',
    getPath: (name) => (name === 'appData' ? appData : name === 'userData' ? userData : os.tmpdir()),
    commandLine: { appendSwitch() {} },
    whenReady: () => ({ then() {} }),
  });
  const electron = {
    app: electronApp,
    ipcMain: { handle() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: {},
  };
  const context = vm.createContext({
    require: (n) =>
      n === 'electron'
        ? electron
        : n === './src/store'
          ? { getSettings: () => ({}), saveTasks() {}, saveSeries() {}, saveSettings() {} }
          : req(n),
    __dirname: path.dirname(file),
    process,
    Buffer,
    URL,
    Response,
    Request,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-rename-'));
const appData = path.join(tmp, 'AppData');
const oldDir = path.join(appData, '红果短剧');
const newDir = path.join(appData, 'AI短剧助手');
fs.mkdirSync(path.join(oldDir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(oldDir, 'data.json'), '{"settings":{"ai_api_key":"k"}}');
fs.writeFileSync(path.join(oldDir, 'library-folders.json'), '[]');
fs.writeFileSync(path.join(oldDir, 'logs', 'main.log'), 'old log');
fs.mkdirSync(newDir, { recursive: true }); // Chromium 可能已经先建好了空的新目录
fs.writeFileSync(path.join(newDir, 'Local State'), '{}');
boot(appData, newDir);
assert.equal(fs.readFileSync(path.join(newDir, 'data.json'), 'utf8'), '{"settings":{"ai_api_key":"k"}}');
assert.ok(fs.existsSync(path.join(newDir, 'library-folders.json')));
assert.equal(fs.readFileSync(path.join(newDir, 'logs', 'main.log'), 'utf8'), 'old log');
assert.equal(fs.readFileSync(path.join(newDir, 'Local State'), 'utf8'), '{}', 'existing files are not replaced');
assert.ok(!fs.existsSync(oldDir), 'the emptied old folder is removed');
console.log('PASS settings and history move from the old data folder on first start');

// 新目录已经有数据：不再动旧目录。
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'data.json'), '{"settings":{"ai_api_key":"older"}}');
boot(appData, newDir);
assert.equal(fs.readFileSync(path.join(newDir, 'data.json'), 'utf8'), '{"settings":{"ai_api_key":"k"}}');
assert.ok(fs.existsSync(path.join(oldDir, 'data.json')), 'an old folder is left alone once the new one has data');
console.log('PASS an existing new data folder is never overwritten');
