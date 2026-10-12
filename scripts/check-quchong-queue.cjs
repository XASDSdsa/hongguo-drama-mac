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
  const handlers = {}, events = [], marks = [], saved = [], jobs = new Map(), starts = [];
  let settings = { quchong_jobs: 2 };
  const app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir,
    commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    protocol: { registerSchemesAsPrivileged() {} } };
  const quchong = { ...native, runJob(options) {
    starts.push(options.src);
    return new Promise((resolve, reject) => {
      const job = { ...options, resolve: () => resolve({ path: options.dst }), reject };
      jobs.set(options.src, job);
      options.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
    });
  } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './src/native/quchong' ? quchong
      : name === './src/store' ? { getSettings: () => settings, saveSettings: value => { settings = value; }, saveQuchongTasks: tasks => saved.push(copy(tasks)) } : req(name),
    __dirname: path.dirname(sourcePath), process, Buffer, URL, URLSearchParams, AbortController,
    AbortSignal, setTimeout, clearTimeout, setImmediate, clearImmediate,
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  context.resolveFfmpeg = () => '/fixture/ffmpeg';
  context.sendToRenderer = (channel, payload) => events.push({ channel, ...copy(payload) });
  context.markPipelineDeduped = (src, dst) => marks.push({ src, dst });
  const snapshots = () => copy(handlers['get-quchong-tasks']());
  return { handlers, events, jobs, marks, saved, starts, snapshots, get settings() { return settings; },
    async start(names, concurrency) {
      const sources = names.map(name => path.join(dir, name + '.mp4'));
      sources.forEach(file => fs.writeFileSync(file, 'fixture'));
      const result = await handlers['quchong-start']({}, { sources, outputDir: path.join(dir, 'out'), opts: concurrency === undefined ? {} : { jobs: concurrency } });
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
  await check('one batch starts the configured number of jobs and fills each freed slot', async () => {
    const h = load();
    const batch = await h.start(['episode-1', 'episode-2', 'episode-3', 'episode-4'], 2);
    const name = source => path.basename(source, '.mp4');
    assert.deepEqual(h.starts.map(name), ['episode-1', 'episode-2'], 'configured jobs must be started immediately');
    assert.equal(batch.snapshot().tasks.filter(task => task.status === 'running').length, 2);

    h.jobs.get(batch.sources[0]).resolve();
    await tick();
    assert.deepEqual(h.starts.map(name), ['episode-1', 'episode-2', 'episode-3'], 'the next queued job must start as soon as a slot is free');
    assert.equal(batch.snapshot().tasks.filter(task => task.status === 'running').length, 2);
  });

  await check('global eight-process cap still lets independent batches overlap', async () => {
    const h = load();
    const first = await h.start(['first-1', 'first-2', 'first-3', 'first-4', 'first-5', 'first-6'], 8);
    const second = await h.start(['second-1', 'second-2', 'second-3', 'second-4'], 8);
    const name = source => path.basename(source, '.mp4');
    assert.equal(h.starts.length, 8, 'two batches should share eight global slots');
    assert.deepEqual(h.starts.map(name), [
      'first-1', 'first-2', 'first-3', 'first-4', 'first-5', 'first-6', 'second-1', 'second-2',
    ]);
    assert.equal(first.snapshot().tasks.filter(task => task.status === 'running').length, 6);
    assert.equal(second.snapshot().tasks.filter(task => task.status === 'running').length, 2);

    h.jobs.get(first.sources[0]).resolve();
    await tick();
    assert.equal(name(h.starts.at(-1)), 'second-3', 'a freed global slot must be assigned to another batch');
    assert.equal(second.snapshot().tasks.filter(task => task.status === 'running').length, 3);
  });

  await check('dedup concurrency is persisted, validated, and applies to queued work', async () => {
    const h = load();
    const defaults = await h.handlers['quchong-defaults']();
    assert.equal(defaults.jobs, 2, 'saved concurrency should be returned as the default');
    const batch = await h.start(['setting-1', 'setting-2', 'setting-3', 'setting-4'], 2);
    assert.equal(h.starts.length, 2);
    const changed = await h.handlers['quchong-set-concurrency']({}, 4);
    assert.deepEqual(copy(changed), { success: true, jobs: 4 });
    assert.equal(h.settings.quchong_jobs, 4);
    assert.equal((await h.handlers['quchong-defaults']()).jobs, 4);
    await tick();
    assert.equal(h.starts.length, 4, 'raising the limit should fill newly available slots');
    for (const value of [0, -1, 9, 1.5, '4', null, NaN]) {
      const invalid = await h.handlers['quchong-set-concurrency']({}, value);
      assert.equal(invalid.success, false, `invalid concurrency accepted: ${String(value)}`);
      assert.equal((await h.handlers['quchong-defaults']()).jobs, 4, 'invalid values must not overwrite the saved setting');
    }
    for (const source of batch.sources) h.jobs.get(source)?.resolve();
    await tick();
    const next = await h.start(['saved-1', 'saved-2', 'saved-3', 'saved-4', 'saved-5']);
    assert.equal(next.snapshot().concurrency, 4);
    assert.equal(next.snapshot().tasks.filter(task => task.status === 'running').length, 4, 'submissions without jobs should use the saved concurrency');
  });

  await check('lowering concurrency lets active work finish before starting the next queued job', async () => {
    const h = load();
    const batch = await h.start(['lower-1', 'lower-2', 'lower-3', 'lower-4', 'lower-5', 'lower-6'], 4);
    const result = await h.handlers['quchong-set-concurrency']({}, 1);
    assert.equal(result.success, true);
    assert.equal(batch.snapshot().concurrency, 1);
    assert.equal(batch.snapshot().tasks.filter(task => task.status === 'running').length, 4, 'lowering the limit must not cancel running work');
    assert.ok([...h.jobs.values()].every(job => !job.signal.aborted));
    for (const source of batch.sources.slice(0, 3)) {
      h.jobs.get(source).resolve();
      await tick();
      assert.equal(h.starts.length, 4, 'queued work must wait until active work falls below the new limit');
    }
    h.jobs.get(batch.sources[3]).resolve();
    await tick();
    assert.equal(h.starts.length, 5);
    assert.equal(batch.snapshot().tasks.filter(task => task.status === 'running').length, 1);
    h.jobs.get(batch.sources[4]).resolve();
    await tick();
    assert.equal(h.starts.length, 6);
    assert.equal(batch.snapshot().tasks.filter(task => task.status === 'running').length, 1);
  });

  await check('active and queued source files cannot be submitted twice while unrelated batches keep running', async () => {
    const h = load();
    const first = await h.start(['reserved-active', 'reserved-queued'], 1);
    const other = await h.start(['independent']);
    for (const src of first.sources) {
      const result = await h.handlers['quchong-start']({}, { sources: [src], outputDir: path.dirname(src), opts: { jobs: 2 } });
      assert.equal(result.success, false);
      assert.match(result.error, /已在去重队列中/);
    }
    await tick();
    assert.equal(h.starts.length, 2, 'duplicate submissions must not create another FFmpeg job');
    assert.equal(h.snapshots().length, 2, 'duplicate submissions must not create another batch');
    assert.equal(first.snapshot().tasks[0].status, 'running');
    assert.equal(first.snapshot().tasks[1].status, 'pending');
    assert.equal(other.snapshot().tasks[0].status, 'running');
    assert.ok([...h.jobs.values()].every(job => !job.signal.aborted));
  });

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
