// Exercise the real main-process IPC/queue with controlled FFmpeg promises.
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
const native = req('./src/native/quchong');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-quchong-queue-'));
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
let serial = 0;

function load() {
  const dir = path.join(temp, String(++serial));
  fs.mkdirSync(dir);
  const handlers = {}, events = [], marks = [], saved = [], jobs = new Map();
  const app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir,
    commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    protocol: { registerSchemesAsPrivileged() {} } };
  const quchong = { ...native, runJob(options) {
    return new Promise((resolve, reject) => {
      const job = { ...options, resolve: () => resolve({ path: options.dst }), reject };
      jobs.set(options.src, job);
      options.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
    });
  } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './src/native/quchong' ? quchong
      : name === './src/store' ? { saveQuchongTasks: tasks => saved.push(copy(tasks)) } : req(name),
    __dirname: path.dirname(sourcePath), process, Buffer, URL, URLSearchParams, AbortController,
    AbortSignal, setTimeout, clearTimeout, setImmediate, clearImmediate,
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  context.resolveFfmpeg = () => '/fixture/ffmpeg';
  context.sendToRenderer = (channel, payload) => events.push({ channel, ...copy(payload) });
  context.markPipelineDeduped = (src, dst) => marks.push({ src, dst });
  const snapshots = () => copy(handlers['get-quchong-tasks']());
  return { handlers, events, jobs, marks, saved, snapshots,
    async start(names, concurrency = 2) {
      const sources = names.map(name => path.join(dir, name + '.mp4'));
      sources.forEach(file => fs.writeFileSync(file, 'fixture'));
      const result = await handlers['quchong-start']({}, { sources, outputDir: path.join(dir, 'out'), opts: { jobs: concurrency } });
      assert.equal(result.success, true, result.error);
      await tick();
      return { ...result, sources, snapshot: () => snapshots().find(batch => batch.id === result.batchId) };
    },
  };
}

async function check(name, run) {
  await run();
  console.log('PASS ' + name);
}

(async () => {
  await check('stages stay running and persist; only resolved output becomes deduped', async () => {
    const h = load(), batch = await h.start(['episode']);
    const job = h.jobs.get(batch.sources[0]);
    assert.ok(job, 'queue did not start its FFmpeg job');
    for (const stage of ['probing', 'encoding', 'finalizing', 'validating', 'saving']) {
      job.onStage(stage);
      job.onProgress(stage === 'saving' ? 99 : 50);
      const snapshot = batch.snapshot();
      assert.equal(snapshot.status, 'running');
      assert.equal(snapshot.done, 0);
      assert.equal(snapshot.tasks[0].status, 'running');
      assert.equal(snapshot.tasks[0].stage, stage);
      assert.equal(snapshot.tasks[0].path, undefined);
      assert.equal(h.marks.length, 0, stage + ' prematurely marked pipeline deduped');
      const event = h.events.filter(item => item.channel === 'quchong-task').at(-1);
      assert.equal(event.batchId, batch.batchId);
      assert.equal(event.task.stage, stage);
      assert.equal(event.task.status, 'running');
      assert.equal(h.saved.at(-1).find(item => item.id === batch.batchId).tasks[0].stage, stage);
      assert.ok(!h.events.some(item => item.channel === 'quchong-complete'));
    }
    job.resolve(); await tick();
    assert.equal(batch.snapshot().status, 'completed');
    assert.equal(batch.snapshot().tasks[0].progress, 100);
    assert.equal(batch.snapshot().tasks[0].stage, 'completed');
    assert.deepEqual(h.marks, [{ src: job.src, dst: job.dst }]);
    assert.equal(h.events.filter(item => item.channel === 'quchong-complete').at(-1).success, true);
  });

  await check('a rejected job fails its batch without completing or stopping another batch', async () => {
    const h = load(), failed = await h.start(['bad']), healthy = await h.start(['healthy']);
    const bad = h.jobs.get(failed.sources[0]), good = h.jobs.get(healthy.sources[0]);
    assert.ok(bad && good, 'independent batches must run concurrently');
    bad.onStage('validating'); bad.reject(new Error('fixture invalid output')); await tick();
    assert.equal(failed.snapshot().status, 'failed');
    assert.equal(failed.snapshot().tasks[0].stage, 'failed');
    assert.match(failed.snapshot().tasks[0].error, /fixture invalid output/);
    assert.equal(h.marks.length, 0);
    assert.equal(healthy.snapshot().tasks[0].status, 'running');
    assert.equal(good.signal.aborted, false);
    good.onStage('saving'); good.resolve(); await tick();
    assert.equal(healthy.snapshot().status, 'completed');
    assert.deepEqual(h.marks, [{ src: good.src, dst: good.dst }]);
  });

  await check('cancel stops active and queued jobs only in the requested batch', async () => {
    const h = load(), cancelled = await h.start(['active', 'queued'], 1), other = await h.start(['other']);
    const active = h.jobs.get(cancelled.sources[0]), good = h.jobs.get(other.sources[0]);
    active.onStage('finalizing');
    assert.equal((await h.handlers['quchong-cancel']({}, cancelled.batchId)).success, true);
    await tick();
    assert.equal(cancelled.snapshot().status, 'stopped');
    assert.ok(cancelled.snapshot().tasks.every(task => task.status === 'stopped' && task.stage === 'stopped'));
    assert.equal(h.jobs.has(cancelled.sources[1]), false, 'cancelled queued work started');
    assert.equal(active.signal.aborted, true);
    assert.equal(good.signal.aborted, false);
    assert.equal(other.snapshot().tasks[0].status, 'running');
    assert.equal(h.marks.length, 0);
    const event = h.events.find(item => item.channel === 'quchong-complete' && item.batchId === cancelled.batchId);
    assert.equal(event.cancelled, true); assert.equal(event.success, false);
    good.resolve(); await tick();
    assert.equal(other.snapshot().status, 'completed');
    assert.deepEqual(h.marks, [{ src: good.src, dst: good.dst }]);
  });
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
