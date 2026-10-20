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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-drama-quchong-queue-'));
const copy = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
let serial = 0;

function load(initialSettings = {}) {
  const dir = path.join(temp, String(++serial));
  fs.mkdirSync(dir);
  const handlers = {},
    events = [],
    marks = [],
    saved = [],
    jobs = new Map(),
    starts = [];
  let settings = { quchong_jobs: 2, ...initialSettings };
  const app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => dir,
    commandLine: { appendSwitch() {} },
    whenReady: () => ({ then() {} }),
  });
  const electron = {
    app,
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
    },
    protocol: { registerSchemesAsPrivileged() {} },
  };
  const quchong = {
    ...native,
    runJob(options) {
      starts.push(options.src);
      return new Promise((resolve, reject) => {
        const job = { ...options, resolve: () => resolve({ path: options.dst }), reject };
        jobs.set(options.src, job);
        options.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
      });
    },
  };
  const context = vm.createContext({
    require: (name) =>
      name === 'electron'
        ? electron
        : name === './src/native/quchong'
          ? quchong
          : name === './src/store'
            ? {
                getSettings: () => settings,
                saveSettings: (value) => {
                  settings = value;
                },
                saveQuchongTasks: (tasks) => saved.push(copy(tasks)),
              }
            : req(name),
    __dirname: path.dirname(sourcePath),
    process,
    Buffer,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(source, context, { filename: sourcePath });
  context.resolveFfmpeg = () => '/fixture/ffmpeg';
  context.sendToRenderer = (channel, payload) => events.push({ channel, ...copy(payload) });
  context.markPipelineDeduped = (src, dst) => marks.push({ src, dst });
  const snapshots = () => copy(handlers['get-quchong-tasks']());
  return {
    dir,
    context,
    handlers,
    events,
    jobs,
    marks,
    saved,
    starts,
    snapshots,
    get settings() {
      return settings;
    },
    async start(names, concurrency) {
      const sources = names.map((name) => path.join(dir, name + '.mp4'));
      sources.forEach((file) => fs.writeFileSync(file, 'fixture'));
      const result = await handlers['quchong-start'](
        {},
        { sources, outputDir: path.join(dir, 'out'), opts: concurrency === undefined ? {} : { jobs: concurrency } },
      );
      assert.equal(result.success, true, result.error);
      await tick();
      return { ...result, sources, snapshot: () => snapshots().find((batch) => batch.id === result.batchId) };
    },
  };
}

async function check(name, run) {
  await run();
  console.log('PASS ' + name);
}

(async () => {
  await check('output goes only to the chosen directory, never beside the sources', async () => {
    const h = load();
    const roots = [path.join(h.dir, 'a'), path.join(h.dir, 'b')];
    const sources = roots.map((root) => {
      fs.mkdirSync(root, { recursive: true });
      const source = path.join(root, '同名剧 001.mp4');
      fs.writeFileSync(source, 'original');
      return source;
    });
    const out = path.join(h.dir, 'chosen');
    const result = await h.handlers['quchong-start']({}, { sources, outputDir: out, opts: { jobs: 3 } });
    assert.equal(result.success, true, result.error);
    await tick();
    assert.equal(h.starts.length, 2);
    const names = sources.map((source) => path.basename(h.jobs.get(source).dst)).sort();
    assert.deepEqual(names, ['同名剧 001_去重.mp4', '同名剧 001_去重_1.mp4']);
    for (const source of sources) {
      assert.equal(path.dirname(h.jobs.get(source).dst), out);
      assert.equal(fs.readFileSync(source, 'utf8'), 'original');
      h.jobs.get(source).resolve();
    }
    await tick();
  });
  await check('without a chosen output directory the batch is refused; the setting is the only fallback', async () => {
    const h = load();
    const source = path.join(h.dir, 'Short 001.mp4');
    fs.writeFileSync(source, 'original');
    const refused = await h.handlers['quchong-start']({}, { sources: [source], outputDir: '' });
    assert.equal(refused.success, false);
    assert.match(refused.error, /请先选择去重输出目录/);
    assert.equal(h.starts.length, 0);
    const out = path.join(h.dir, 'configured');
    fs.mkdirSync(out);
    const existing = path.join(out, 'Short 001_去重.mp4');
    fs.writeFileSync(existing, 'existing');
    const configured = load({ dedup_output_dir: out });
    const file = path.join(configured.dir, 'Short 001.mp4');
    fs.writeFileSync(file, 'original');
    const result = await configured.handlers['quchong-start']({}, { sources: [file], outputDir: '' });
    assert.equal(result.success, true, result.error);
    await tick();
    assert.equal(configured.jobs.get(file).dst, path.join(out, 'Short 001_去重_1.mp4'), 'existing output is kept');
    assert.equal(fs.readFileSync(existing, 'utf8'), 'existing');
    configured.jobs.get(file).resolve();
    await tick();
  });
  await check('one batch starts the configured number of jobs and fills each freed slot', async () => {
    const h = load();
    const batch = await h.start(['episode-1', 'episode-2', 'episode-3', 'episode-4'], 2);
    const name = (source) => path.basename(source, '.mp4');
    assert.deepEqual(h.starts.map(name), ['episode-1', 'episode-2'], 'configured jobs must be started immediately');
    assert.equal(batch.snapshot().tasks.filter((task) => task.status === 'running').length, 2);

    h.jobs.get(batch.sources[0]).resolve();
    await tick();
    assert.deepEqual(
      h.starts.map(name),
      ['episode-1', 'episode-2', 'episode-3'],
      'the next queued job must start as soon as a slot is free',
    );
    assert.equal(batch.snapshot().tasks.filter((task) => task.status === 'running').length, 2);
  });

  await check('all batches together never run more FFmpeg jobs than the configured concurrency', async () => {
    // 设置里的「视频去重同时处理」是全应用的上限：几部剧一起处理也不会超过它；界面传来的旧 jobs 不起作用。
    const h = load({ quchong_jobs: 3 });
    const first = await h.start(['first-1', 'first-2', 'first-3', 'first-4'], 8);
    const second = await h.start(['second-1', 'second-2', 'second-3'], 8);
    const name = (source) => path.basename(source, '.mp4');
    assert.equal(h.starts.length, 3, 'two batches share the three configured slots');
    assert.deepEqual(h.starts.map(name), ['first-1', 'first-2', 'first-3']);
    assert.equal(second.snapshot().tasks.filter((task) => task.status === 'running').length, 0);

    h.jobs.get(first.sources[0]).resolve();
    await tick();
    assert.equal(h.starts.length, 4, 'a freed slot is refilled right away');
    assert.equal(
      first.snapshot().tasks.filter((task) => task.status === 'running').length +
        second.snapshot().tasks.filter((task) => task.status === 'running').length,
      3,
      'never more than the configured three at once',
    );
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
      assert.equal(
        (await h.handlers['quchong-defaults']()).jobs,
        4,
        'invalid values must not overwrite the saved setting',
      );
    }
    for (const source of batch.sources) h.jobs.get(source)?.resolve();
    await tick();
    const next = await h.start(['saved-1', 'saved-2', 'saved-3', 'saved-4', 'saved-5']);
    assert.equal(next.snapshot().concurrency, 4);
    assert.equal(
      next.snapshot().tasks.filter((task) => task.status === 'running').length,
      4,
      'submissions without jobs should use the saved concurrency',
    );
  });

  await check('lowering concurrency lets active work finish before starting the next queued job', async () => {
    const h = load({ quchong_jobs: 4 });
    const batch = await h.start(['lower-1', 'lower-2', 'lower-3', 'lower-4', 'lower-5', 'lower-6'], 4);
    const result = await h.handlers['quchong-set-concurrency']({}, 1);
    assert.equal(result.success, true);
    assert.equal(batch.snapshot().concurrency, 1);
    assert.equal(
      batch.snapshot().tasks.filter((task) => task.status === 'running').length,
      4,
      'lowering the limit must not cancel running work',
    );
    assert.ok([...h.jobs.values()].every((job) => !job.signal.aborted));
    for (const source of batch.sources.slice(0, 3)) {
      h.jobs.get(source).resolve();
      await tick();
      assert.equal(h.starts.length, 4, 'queued work must wait until active work falls below the new limit');
    }
    h.jobs.get(batch.sources[3]).resolve();
    await tick();
    assert.equal(h.starts.length, 5);
    assert.equal(batch.snapshot().tasks.filter((task) => task.status === 'running').length, 1);
    h.jobs.get(batch.sources[4]).resolve();
    await tick();
    assert.equal(h.starts.length, 6);
    assert.equal(batch.snapshot().tasks.filter((task) => task.status === 'running').length, 1);
  });

  await check(
    'active and queued source files cannot be submitted twice while unrelated batches keep running',
    async () => {
      // 全局并发 2：先占一个槽的无关批次在跑，这一批只能跑一集、另一集排队。
      const h = load({ quchong_jobs: 2 });
      const other = await h.start(['independent']);
      const first = await h.start(['reserved-active', 'reserved-queued']);
      for (const src of first.sources) {
        const result = await h.handlers['quchong-start'](
          {},
          { sources: [src], outputDir: path.dirname(src), opts: { jobs: 2 } },
        );
        assert.equal(result.success, false);
        assert.match(result.error, /已在去重队列中/);
      }
      await tick();
      assert.equal(h.starts.length, 2, 'duplicate submissions must not create another FFmpeg job');
      assert.equal(h.snapshots().length, 2, 'duplicate submissions must not create another batch');
      assert.equal(first.snapshot().tasks[0].status, 'running');
      assert.equal(first.snapshot().tasks[1].status, 'pending');
      assert.equal(other.snapshot().tasks[0].status, 'running');
      assert.ok([...h.jobs.values()].every((job) => !job.signal.aborted));
    },
  );

  await check('stages stay running and persist; only resolved output becomes deduped', async () => {
    const h = load(),
      batch = await h.start(['episode']);
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
      const event = h.events.filter((item) => item.channel === 'quchong-task').at(-1);
      assert.equal(event.batchId, batch.batchId);
      assert.equal(event.task.stage, stage);
      assert.equal(event.task.status, 'running');
      assert.equal(h.saved.at(-1).find((item) => item.id === batch.batchId).tasks[0].stage, stage);
      assert.ok(!h.events.some((item) => item.channel === 'quchong-complete'));
    }
    job.resolve();
    await tick();
    assert.equal(batch.snapshot().status, 'completed');
    assert.equal(batch.snapshot().tasks[0].progress, 100);
    assert.equal(batch.snapshot().tasks[0].stage, 'completed');
    assert.deepEqual(h.marks, [{ src: job.src, dst: job.dst }]);
    assert.equal(h.events.filter((item) => item.channel === 'quchong-complete').at(-1).success, true);
  });

  await check('a rejected job fails its batch without completing or stopping another batch', async () => {
    const h = load(),
      failed = await h.start(['bad']),
      healthy = await h.start(['healthy']);
    const bad = h.jobs.get(failed.sources[0]),
      good = h.jobs.get(healthy.sources[0]);
    assert.ok(bad && good, 'independent batches must run concurrently');
    bad.onStage('validating');
    bad.onProgress(98);
    const diagnostic = 'fixture invalid output\n[h264_nvenc] OpenEncodeSessionEx failed: unsupported device';
    bad.reject(new Error(diagnostic));
    await tick();
    assert.equal(failed.snapshot().status, 'failed');
    assert.equal(failed.snapshot().tasks[0].stage, 'failed');
    assert.match(failed.snapshot().tasks[0].error, /fixture invalid output/);
    assert.equal(failed.snapshot().tasks[0].progress, 0, 'failed output cannot count as batch completion progress');
    const failureEvent = h.events
      .filter((item) => item.channel === 'quchong-task' && item.task.id === failed.snapshot().tasks[0].id)
      .at(-1);
    assert.equal(failureEvent.task.error, diagnostic, 'renderer must receive the complete diagnostic');
    assert.ok(
      h.events.some(
        (item) =>
          item.channel === 'quchong-log' &&
          item.batchId === failed.batchId &&
          item.line.includes('[失败] ' + diagnostic),
      ),
      'terminal failure must flush stderr to the task log',
    );
    assert.equal(
      h.saved.at(-1).find((item) => item.id === failed.batchId).tasks[0].error,
      diagnostic,
      'failed snapshot must retain stderr after restarting the app',
    );
    assert.equal(h.marks.length, 0);
    assert.equal(healthy.snapshot().tasks[0].status, 'running');
    assert.equal(good.signal.aborted, false);
    good.onStage('saving');
    good.resolve();
    await tick();
    assert.equal(healthy.snapshot().status, 'completed');
    assert.deepEqual(h.marks, [{ src: good.src, dst: good.dst }]);
  });

  await check('confirmed disk full stops the rest of the batch; FFmpeg text alone does not', async () => {
    const full = load();
    const batch = await full.start(['f1', 'f2', 'f3', 'f4']);
    assert.equal(full.starts.length, 2);
    full.jobs
      .get(batch.sources[0])
      .reject(new Error('磁盘空间不足：输出位置所在的磁盘写满了\nNo space left on device'));
    await tick();
    const tasks = batch.snapshot().tasks;
    assert.equal(tasks[0].status, 'failed');
    assert.equal(tasks[1].status, 'running', '已经在跑的那一集照常收尾');
    assert.deepEqual(
      tasks.slice(2).map((task) => [task.status, task.error]),
      [
        ['stopped', '磁盘空间不足，已停止'],
        ['stopped', '磁盘空间不足，已停止'],
      ],
    );
    assert.equal(full.starts.length, 2, '磁盘满了不能再开新的一集');
    full.jobs.get(batch.sources[1]).resolve();
    await tick();

    const quirk = load();
    const other = await quirk.start(['q1', 'q2', 'q3']);
    quirk.jobs
      .get(other.sources[0])
      .reject(new Error('合并变速这一步失败\nError while filtering: No space left on device'));
    await tick();
    assert.equal(quirk.starts.length, 3, '没确认是磁盘满（只是 FFmpeg 的字样）时，后面的集照常开始');
    quirk.jobs.get(other.sources[1]).resolve();
    quirk.jobs.get(other.sources[2]).resolve();
    await tick();
  });

  await check(
    'a switch to the CPU encoder is told once per batch, with its reason; queue notes stay per episode',
    async () => {
      const h = load({ quchong_jobs: 3 });
      const lines = [];
      h.context.libLog = (dir, level, text) => lines.push({ dir, level, text });
      const batch = await h.start(['e1', 'e2', 'e3'], 3);
      vm.runInContext("for (const b of quchongBatches.values()) b.libraryDir = '/剧'", h.context);
      for (const source of batch.sources) {
        h.jobs
          .get(source)
          .onLog('[编码器] NVIDIA 显卡编码用不了：NVIDIA 显卡驱动太旧。这一批改用 CPU 编码（成品一样，只是慢一些）');
        h.jobs.get(source).onLog('[排队] 显卡编码通道都在用，排队等一路空出来');
      }
      const encoderLines = lines.filter((line) => /驱动太旧/.test(line.text));
      assert.equal(encoderLines.length, 1, 'said once for the whole batch');
      assert.equal(encoderLines[0].level, 'warn');
      assert.doesNotMatch(encoderLines[0].text, /^e\d/, 'a batch-wide note, not tied to one episode');
      assert.equal(
        lines.filter((line) => /排队等一路空出来/.test(line.text)).length,
        3,
        'queue notes stay per episode',
      );
      for (const source of batch.sources) h.jobs.get(source).resolve();
      await tick();
    },
  );

  await check('cancel stops active and queued jobs only in the requested batch', async () => {
    // 全局并发 2：无关批次先占一个槽，被取消的这一批一集在跑、一集排队。
    const h = load({ quchong_jobs: 2 }),
      other = await h.start(['other']),
      cancelled = await h.start(['active', 'queued']);
    const active = h.jobs.get(cancelled.sources[0]),
      good = h.jobs.get(other.sources[0]);
    active.onStage('finalizing');
    assert.equal((await h.handlers['quchong-cancel']({}, cancelled.batchId)).success, true);
    await tick();
    assert.equal(cancelled.snapshot().status, 'stopped');
    assert.ok(cancelled.snapshot().tasks.every((task) => task.status === 'stopped' && task.stage === 'stopped'));
    assert.equal(h.jobs.has(cancelled.sources[1]), false, 'cancelled queued work started');
    assert.equal(active.signal.aborted, true);
    assert.equal(good.signal.aborted, false);
    assert.equal(other.snapshot().tasks[0].status, 'running');
    assert.equal(h.marks.length, 0);
    const event = h.events.find((item) => item.channel === 'quchong-complete' && item.batchId === cancelled.batchId);
    assert.equal(event.cancelled, true);
    assert.equal(event.success, false);
    good.resolve();
    await tick();
    assert.equal(other.snapshot().status, 'completed');
    assert.deepEqual(h.marks, [{ src: good.src, dst: good.dst }]);
  });
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
