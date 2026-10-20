// AI 发布素材在主进程里的接入：IPC 状态、后台生成、取消、换标题、错误里不带 Key。
// 用假的 OpenAI 兼容中转站和假的隐藏窗口，不需要网络、Chromium 或字体。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm'),
  zlib = require('node:zlib');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-ipc-'));
process.env.HONGGUO_TITLE_FONTS_DIR = path.join(tmp, 'fonts');
fs.mkdirSync(process.env.HONGGUO_TITLE_FONTS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.HONGGUO_TITLE_FONTS_DIR, 'fonts.css'), '/* stub */');

function png(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 3), 90);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0;
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class FakeWindow {
  constructor() {
    this.destroyed = false;
    this.webContents = {
      executeJavaScript: async (code) => {
        if (code.includes('loadFontCss')) return true;
        const spec = JSON.parse(code.slice(code.indexOf('(') + 1, code.lastIndexOf(')')));
        FakeWindow.rendered.push({ title: spec.title, style: spec.style.id, layout: spec.layout });
        return { dataUrl: spec.image, meta: { layout: 'bottom' } };
      },
    };
  }
  async loadURL() {}
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}
FakeWindow.rendered = [];

function makeMain(root, userData, settings) {
  fs.mkdirSync(userData, { recursive: true });
  const file = path.resolve(__dirname, '../main.js'),
    req = createRequire(file),
    app = new EventEmitter(),
    handlers = {},
    events = [];
  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => userData,
    commandLine: { appendSwitch() {} },
    whenReady: () => ({ then() {} }),
  });
  const electron = {
    app,
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  const context = vm.createContext({
    require: (n) =>
      n === 'electron'
        ? electron
        : n === './src/store'
          ? { getSettings: () => ({ root, ...settings }), saveTasks() {}, saveSeries() {}, saveSettings() {} }
          : req(n),
    __dirname: path.dirname(file),
    process,
    Buffer,
    URL,
    Response,
    Request,
    Headers,
    AbortController,
    AbortSignal,
    fetch,
    FormData,
    Blob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  vm.runInContext('seriesRegistry=[]', context);
  context.sendToRenderer = (channel, data) => events.push([channel, data]);
  return { context, handlers, events };
}

function relay(handler) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const entry = { url: req.url, auth: req.headers.authorization, raw, json: null };
      try {
        entry.json = JSON.parse(raw.toString());
      } catch (_) {}
      log.push(entry);
      const out = await handler(entry);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, log, base: `http://127.0.0.1:${server.address().port}` })),
  );
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL ' + name + ': ' + (e.stack || e.message));
  }
}
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timeout');
};

const COPY = {
  synopsis:
    '林晚重生回到被退婚的那一天，这一次她不再忍让。前未婚夫的家族步步紧逼，她却在暗中布下一盘大棋，等着对方自己踩进陷阱。可当真相慢慢浮出水面，她才惊觉那场婚约的背后，还藏着一个惊天秘密。',
  titles: ['重生后我撕了婚书', '退婚后我嫁给了他叔叔', '她撕了婚书转身就走'],
  genre: '重生逆袭',
  style: 'fire',
  tagline: '开局即反转',
  scene: '年轻女子，红色礼服，宴会厅',
};

(async () => {
  const art = png(256, 384).toString('base64');
  let delay = 0;
  let reject = false;
  const server = await relay(async (entry) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (reject) return { status: 401, body: { error: { message: 'Incorrect API key provided: secret-key-123' } } };
    if (entry.url.includes('/images/')) return { body: { data: [{ b64_json: art }] } };
    const text = JSON.stringify(entry.json?.messages || []);
    if (text.includes('image_url'))
      return { body: { choices: [{ message: { content: '{"has_text":false,"faces":[]}' } }] } };
    if (text.includes('只回复 OK')) return { body: { choices: [{ message: { content: 'OK' } }] } };
    return { body: { choices: [{ message: { content: JSON.stringify(COPY) } }] } };
  });
  const root = path.join(tmp, 'downloads');
  const dir = path.join(root, '退婚之后');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '退婚之后_第001集.mp4'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(dir, '封面.png'), Buffer.from(png(256, 384)));
  const settings = { ai_base_url: `${server.base}/v1`, ai_api_key: 'secret-key-123', ai_text_model: 'gpt-6.1-sol' };
  const { handlers, events } = makeMain(root, path.join(tmp, 'userData'), settings);
  const updates = () => events.filter(([name]) => name === 'publish-update').map(([, data]) => data);

  try {
    await check('state of a fresh series: no result yet, eight styles, cover noticed', async () => {
      const state = await handlers['publish-state']({}, dir);
      assert.equal(state.success, true);
      assert.equal(state.result, null);
      assert.equal(state.hasCover, true);
      assert.equal(state.styles.length, 8);
      assert.deepEqual(Object.keys(state.styles[0]).sort(), ['id', 'name']);
    });

    await check('a folder that is not a series is refused', async () => {
      const bad = await handlers['publish-state']({}, path.join(tmp, 'elsewhere'));
      assert.equal(bad.success, false);
      const gen = await handlers['publish-generate']({}, { dir: path.join(tmp, 'elsewhere'), task: 'titles' });
      assert.equal(gen.success, false);
    });

    await check('a task has to be named, and a poster needs a chosen name first', async () => {
      const none = await handlers['publish-generate']({}, { dir });
      assert.equal(none.success, false);
      assert.match(none.error, /改写剧名、改写简介或生成海报/);
      const calls = server.log.length;
      await handlers['publish-generate']({}, { dir, task: 'poster' });
      const failed = await waitFor(() => updates().find((u) => u.status === 'failed' && u.task === 'poster'));
      assert.match(failed.error, /先选定剧名/);
      assert.equal(server.log.length, calls, 'no model call before a name is chosen');
      events.length = 0;
    });

    const runTask = async (task) => {
      events.length = 0;
      const started = await handlers['publish-generate']({}, { dir, task });
      assert.equal(started.success, true, started.error);
      return waitFor(() => updates().find((u) => u.status === 'done' && u.task === task));
    };

    await check('each task runs on its own in the background and writes only its own result', async () => {
      delay = 150;
      const started = await handlers['publish-generate']({}, { dir, task: 'titles' });
      assert.equal(started.success, true);
      const again = await handlers['publish-generate']({}, { dir, task: 'synopsis' });
      assert.equal(again.success, false);
      assert.match(again.error, /正在生成中/);
      const mid = await handlers['publish-state']({}, dir);
      assert.equal(mid.job.status, 'running');
      assert.equal(mid.job.task, 'titles');
      await waitFor(() => updates().some((u) => u.status === 'done'));
      delay = 0;
      assert.deepEqual(
        fs.readdirSync(dir).sort(),
        ['原剧'],
        'rewriting only offers candidates: nothing is written until you save',
      );
      // 原集和原封面在「原剧」里，外层只放成品。
      assert.deepEqual(fs.readdirSync(path.join(dir, '原剧')).sort(), ['封面.png', '退婚之后_第001集.mp4'].sort());
      const drafts = await handlers['publish-state']({}, dir);
      assert.equal(drafts.result.title, '', 'no name chosen yet');
      assert.equal(drafts.original.title, '退婚之后', 'the original name is shown apart from the saved one');
      // 选一个候选并保存剧名
      const saveTitle = await handlers['publish-retitle']({}, { dir, title: drafts.result.candidates[0] });
      assert.equal(saveTitle.success, true, saveTitle.error);
      assert.ok(fs.existsSync(path.join(dir, '发布剧名.txt')));
      await runTask('synopsis');
      assert.ok(!fs.existsSync(path.join(dir, '发布简介.txt')), 'a rewritten synopsis is a draft until saved');
      const pending = await handlers['publish-state']({}, dir);
      assert.equal(pending.result.synopsis, '');
      assert.match(pending.result.proposedSynopsis, /重生回到被退婚/);
      const tooShort = await handlers['publish-save-synopsis']({}, { dir, synopsis: '短' });
      assert.equal(tooShort.success, false);
      const savedSyn = await handlers['publish-save-synopsis']({}, { dir, synopsis: pending.result.proposedSynopsis });
      assert.equal(savedSyn.success, true, savedSyn.error);
      assert.ok(fs.existsSync(path.join(dir, '发布简介.txt')));
      assert.equal(savedSyn.result.proposedSynopsis, '');
      assert.ok(!fs.existsSync(path.join(dir, '发布海报.jpg')));
      await runTask('poster');
      assert.deepEqual(
        fs.readdirSync(dir).sort(),
        ['原剧', '发布剧名.txt', '发布海报.jpg', '发布简介.txt'].sort(),
        'only results land in the series folder',
      );
      const stages = new Set(
        updates()
          .filter((u) => u.status === 'running')
          .map((u) => u.stage),
      );
      assert.ok(stages.has('scene') && stages.has('art') && stages.has('poster'), [...stages].join());
      const state = await handlers['publish-state']({}, dir);
      assert.equal(state.result.title, '重生后我撕了婚书');
      assert.equal(state.result.styleId, 'fire');
      assert.equal(state.result.hasPoster, true);
      assert.match(state.result.posterUrl, /^[a-z-]+:\/\/f\/[\w-]+\?v=\d+$/);
      assert.equal(state.result.paths, undefined, 'internal paths are not sent to the page');
      assert.deepEqual(FakeWindow.rendered.at(-1), { title: '重生后我撕了婚书', style: 'fire', layout: 'auto' });
    });

    await check('changing the title or style only re-lays the poster', async () => {
      const calls = server.log.length;
      const res = await handlers['publish-retitle']({}, { dir, title: '她撕了婚书转身就走', styleId: 'ink' });
      assert.equal(res.success, true);
      assert.equal(res.result.title, '她撕了婚书转身就走');
      assert.equal(res.result.styleId, 'ink');
      assert.equal(server.log.length, calls);
      assert.equal(fs.readFileSync(path.join(dir, '发布剧名.txt'), 'utf8').trim(), '她撕了婚书转身就走');
      assert.deepEqual(FakeWindow.rendered.at(-1), { title: '她撕了婚书转身就走', style: 'ink', layout: 'auto' });
      const bad = await handlers['publish-retitle']({}, { dir, styleId: 'nope' });
      assert.equal(bad.success, false);
    });

    await check('cancel stops a running job', async () => {
      delay = 400;
      updates().length = 0;
      events.length = 0;
      await handlers['publish-generate']({}, { dir, task: 'synopsis' });
      await handlers['publish-cancel']({}, dir);
      await waitFor(() => updates().some((u) => u.status === 'cancelled'));
      delay = 0;
      const state = await handlers['publish-state']({}, dir);
      assert.equal(state.job.status, 'cancelled');
    });

    await check('a failure is reported to the page, and neither key appears in the message', async () => {
      reject = true;
      events.length = 0;
      await handlers['publish-generate']({}, { dir, task: 'titles' });
      const failed = await waitFor(() => updates().find((u) => u.status === 'failed'));
      reject = false;
      assert.match(failed.error, /401/);
      assert.ok(!failed.error.includes('secret-key-123'));
    });

    await check('the text connection test uses the values typed in the form, not only the saved ones', async () => {
      const second = await relay(async () => ({ body: { choices: [{ message: { content: 'OK' } }] } }));
      try {
        const ok = await handlers['test-ai-text']({}, { ai_base_url: `${second.base}/v1`, ai_api_key: 'typed-key' });
        assert.equal(ok.success, true);
        assert.equal(ok.model, 'gpt-6.1-sol');
        assert.equal(second.log[0].auth, 'Bearer typed-key');
        const missing = await handlers['test-ai-text']({}, { ai_base_url: `${second.base}/v1`, ai_api_key: '' });
        assert.equal(missing.success, false);
        assert.match(missing.error, /API Key/);
      } finally {
        second.server.close();
      }
    });
  } finally {
    try {
      server.server.close();
    } catch (_) {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
})();
