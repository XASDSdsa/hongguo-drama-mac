// 剪映草稿同时做几集：并行数、线程分配、电脑忙时少开一路，不需要 ffmpeg 和模型。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');

function makeMain(root, userData, registry) {
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
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  const context = vm.createContext({
    require: (n) =>
      n === 'electron'
        ? electron
        : n === './src/store'
          ? { getSettings: () => ({ root }), saveTasks() {}, saveSeries() {}, saveSettings() {} }
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
  vm.runInContext(`seriesRegistry=${JSON.stringify(registry)}`, context);
  context.sendToRenderer = (channel, data) => events.push([channel, data]);
  context.pumpAllQuchongBatches = () => {};
  context.resolveFfmpeg = (name) => name;
  // 成品用「AI 发布素材」里选定的新剧名命名；测试里直接当作已选定（剧名 = 文件夹名）。
  context.libraryReleaseTitle = (dir) => path.basename(dir);
  return { context, handlers, events };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-lanes-'));
  const dir = path.join(tmp, '剧');
  const files = [1, 2, 3, 4].map((n) => {
    const file = path.join(dir, '去重', `新剧_第${String(n).padStart(3, '0')}集.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
    return file;
  });

  async function run({ lanes, allowedAfter, expectPeak }) {
    const { context } = makeMain(path.join(tmp, 'root'), path.join(tmp, 'ud'), []);
    let live = 0,
      peak = 0;
    const threads = [];
    context.getCurrentSettings = () => ({ structure_threads: 8 });
    context.libraryDraftReadiness = async () => '';
    let allowed = lanes;
    context.draftLanesAllowed = () => allowed;
    const slow = () => new Promise((resolve) => setTimeout(resolve, 120));
    context.getReconstructionPipeline = () => ({
      start: async (payload) => {
        if (payload.threads) threads.push(payload.threads);
        live += 1;
        peak = Math.max(peak, live);
        if (allowedAfter != null && live >= 2) allowed = allowedAfter;
      },
      wait: async (projectId) => {
        await slow();
        live -= 1;
        const done = Object.fromEntries(
          ['media', 'audio', 'shots', 'clips', 'separation', 'transcript', 'alignment', 'export', 'jianying'].map(
            (id) => [id, { status: 'succeeded', summary: { draft_path: path.join(tmp, 'draft', projectId) } }],
          ),
        );
        return { status: 'completed', modules: done };
      },
      cancel() {},
    });
    const started = await context.startLibraryDrafts({
      dir,
      files,
      mode: 'simple',
      scope: { numbers: [1, 2, 3, 4] },
    });
    assert.equal(started.success, true, JSON.stringify(started));
    const deadline = Date.now() + 15000;
    while (
      vm.runInContext('libraryDraftJobs', context).get(path.resolve(dir)).status === 'running' &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const job = vm.runInContext('libraryDraftJobs', context).get(path.resolve(dir));
    assert.equal(job.status, 'completed', JSON.stringify([job.status, job.done, job.failed]));
    assert.equal(job.done, 4);
    return { peak, threads, job };
  }

  const one = await run({ lanes: 1 });
  assert.equal(one.peak, 1, 'one episode at a time by default');
  console.log('PASS one lane');

  const three = await run({ lanes: 3 });
  assert.ok(three.peak >= 2 && three.peak <= 3, `up to three at once, saw ${three.peak}`);
  assert.ok(
    three.threads.every((n) => n === 2),
    'the 8-thread budget is shared: 2 each for 3 lanes',
  );
  console.log('PASS three lanes share the thread budget');

  const busy = await run({ lanes: 3, allowedAfter: 1 });
  assert.equal(busy.job.done, 4, 'every episode is still made when the extra lanes step aside');
  console.log('PASS extra lanes step aside when the computer is busy');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
