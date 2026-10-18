// Offline regression: real HTTP streams, isolated main process, no GUI/user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-stream-'));
const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function load(fetchPlayUrlSingle, overrides = {}) {
  const handlers = {},
    protocols = {},
    app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => root,
    commandLine: { appendSwitch() {} },
    whenReady: () => ({ then() {} }),
  });
  const electron = {
    app,
    ipcMain: { handle: (n, f) => (handlers[n] = f) },
    protocol: { registerSchemesAsPrivileged() {}, handle: (n, f) => (protocols[n] = f) },
  };
  const native = {
    fetchPlayUrlSingle,
    UA: 'test',
    VIDEO_REFERER: 'https://example.com/',
    deriveKey: () => Buffer.alloc(16),
    decryptMp4Buffer: (b) => b,
  };
  const context = vm.createContext({
    require: (n) =>
      overrides[n] ||
      (n === 'electron'
        ? electron
        : n === './src/native/hongguo'
          ? native
          : n === './src/store'
            ? { saveTasks() {}, getSettings: () => ({ root }) }
            : req(n)),
    __dirname: path.dirname(source),
    console: { log() {}, warn() {}, error() {} },
    process,
    Buffer,
    URL,
    Response,
    Request,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  context.registerStreamProtocol();
  return { context, handlers, protocols, run: (s) => vm.runInContext(s, context) };
}
(async () => {
  let hits = 0,
    streamClosed = false;
  const server = http.createServer((r, s) => {
    hits++;
    if (r.url === '/slow') {
      s.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '99999' });
      s.write('hello');
      r.on('close', () => (streamClosed = true));
      return;
    }
    if (r.url === '/gone') {
      s.writeHead(404);
      s.end();
      return;
    }
    if (r.url === '/broken') {
      s.writeHead(200, { 'content-length': '99999' });
      s.write('hello');
      setTimeout(() => s.destroy(), 20);
      return;
    }
    const body = Buffer.from('0123456789');
    if (r.headers.range === 'bytes=2-4') {
      s.writeHead(206, { 'content-type': 'video/mp4', 'content-length': '3', 'content-range': 'bytes 2-4/10' });
      s.end(body.subarray(2, 5));
    } else {
      s.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
      s.end(body);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failures = 0;
  async function check(name, f) {
    if (process.argv.includes('--extras') && !name.startsWith('extra:')) return;
    try {
      await f();
      console.log('PASS ' + name);
    } catch (e) {
      failures++;
      console.error('FAIL ' + name + ': ' + e.message);
    }
  }
  const harnesses = [];
  const hload = (fn, overrides) => {
    const h = load(fn, overrides);
    harnesses.push(h);
    return h;
  };
  await check('plain source returns before downloading a single byte', async () => {
    const h = hload(async () => ({ url: base + '/slow', spadeA: '' }));
    const before = hits;
    const result = await Promise.race([
      h.handlers['prepare-online-play']({}, { vid: 'plain', requestId: 'one' }),
      sleep(150).then(() => ({ timedOut: true })),
    ]);
    assert.equal(result.success, true, 'prepare must not wait for complete media');
    assert.equal(hits, before, 'media must be requested by video, not prepare');
    assert.ok(result.streamId);
  });
  await check('Range is forwarded; opaque sessions are released', async () => {
    const h = hload(async () => ({ url: base + '/range' }));
    const p = await h.handlers['prepare-online-play']({}, { vid: 'range', requestId: 'range-request' });
    const response = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=2-4' } }));
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '234');
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
    assert.ok(h.handlers['release-online-play'], 'release IPC must exist');
    await h.handlers['release-online-play']({}, { streamId: p.streamId });
    assert.equal((await h.protocols['hongguo-stream'](new Request(p.url))).status, 404);
  });
  await check('release aborts active upstream body', async () => {
    const h = hload(async () => ({ url: base + '/slow' }));
    const p = await Promise.race([
      h.handlers['prepare-online-play']({}, { vid: 'abort' }),
      sleep(150).then(() => ({})),
    ]);
    assert.ok(p.url, 'prepare must return a stream URL');
    streamClosed = false;
    const response = await h.protocols['hongguo-stream'](new Request(p.url));
    const reader = response.body.getReader();
    await reader.read();
    await h.handlers['release-online-play']({}, { streamId: p.streamId });
    await sleep(30);
    assert.equal(streamClosed, true);
    await reader.cancel().catch(() => {});
  });
  await check('cancel during address lookup prevents stale ready state', async () => {
    let resolve;
    const h = hload(() => new Promise((r) => (resolve = r)));
    const pending = h.handlers['prepare-online-play']({}, { vid: 'pending', requestId: 'cancel-me' });
    assert.ok(h.handlers['release-online-play']);
    await h.handlers['release-online-play']({}, { requestId: 'cancel-me' });
    resolve({ url: base + '/range' });
    assert.equal((await pending).success, false);
  });
  await check('encrypted fallback retains bytes and correct suffix/invalid Range', async () => {
    // 解密在 worker 线程中使用真实原生模块；夹具用恒等解密桩，只验证缓冲与 Range 逻辑。
    const h = hload(async () => ({ url: base + '/range', spadeA: 'encrypted' }), {
      './src/native/decrypt-worker.cjs': { decryptInWorker: async ({ buffer }) => buffer },
    });
    const p = await h.handlers['prepare-online-play']({}, { vid: 'encrypted' });
    let r = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=-3' } }));
    assert.equal(await r.text(), '789');
    r = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=12-20' } }));
    assert.equal(r.status, 416);
  });
  await check('broken upstream settles failed download and removes partial file', async () => {
    const h = hload(async () => ({ url: base + '/broken' }));
    h.run('downloadRetryDelays = []'); // 这一条只看“失败就收尾”，自动重试单独测
    const task = {
      id: 'broken',
      type: 'hongguo',
      filename: 'broken.mp4',
      customDir: root,
      hongguoInfo: { vid: 'broken' },
    };
    const settled = await Promise.race([
      h.context.executeHongguoDownload(task).then(() => true),
      sleep(250).then(() => false),
    ]);
    assert.equal(settled, true, 'upstream failure must not leave queue hanging');
    assert.equal(task.status, 'failed');
    assert.equal(fs.existsSync(path.join(root, 'broken.mp4.enc.tmp')), false);
  });
  await check('draft diagnostics line says how many breaths were found and how many shot cuts were kept', async () => {
    const h = hload(async () => ({ url: base + '/range' }));
    const line = h.run(
      `describeStructure(${JSON.stringify({
        modules: {
          transcript: { summary: { acoustic_pauses: 14, pause_cuts: 12 } },
          alignment: {
            summary: { raw_shot_count: 9, shot_count: 9 },
          },
        },
      })})`,
    );
    assert.match(line, /14 处气口/);
    assert.match(line, /拆开 12 次/);
    assert.match(line, /画面切点 8 个，全部作为分镜边界/);
    assert.match(line, /共 9 个分镜/);
    assert.equal(h.run('describeStructure({})'), '分析完成');
  });
  await check('a 404 on the download link is retried with a fresh link, not given up as missing', async () => {
    let lookups = 0;
    const h = hload(async () => {
      lookups++;
      return { url: base + (lookups === 1 ? '/gone' : '/range') };
    });
    let invalidated = 0;
    h.run('hongguo').invalidatePlayUrl = () => invalidated++;
    h.run('downloadRetryDelays = [5, 5]');
    const task = { id: 'gone', type: 'hongguo', filename: 'gone.mp4', customDir: root, hongguoInfo: { vid: 'gone' } };
    await h.context.executeHongguoDownload(task);
    assert.equal(task.status, 'completed', task.error);
    assert.equal(lookups, 2, 'second attempt asked for a new link');
    assert.equal(invalidated, 1, 'the stale cached link was dropped');
    assert.equal(fs.readFileSync(path.join(root, 'gone.mp4'), 'utf8'), '0123456789');
  });
  await check('a link that keeps failing ends as failed with the retry count, not as missing', async () => {
    let lookups = 0;
    const h = hload(async () => {
      lookups++;
      return { url: base + '/gone' };
    });
    h.run('downloadRetryDelays = [5, 5]');
    const task = {
      id: 'gone2',
      type: 'hongguo',
      filename: 'gone2.mp4',
      customDir: root,
      hongguoInfo: { vid: 'gone2' },
    };
    await h.context.executeHongguoDownload(task);
    assert.equal(task.status, 'failed');
    assert.equal(lookups, 3, 'one try plus two automatic retries');
    assert.equal(task.errorStatus, 404);
    assert.match(task.error, /已自动换新链接重试 2 次/);
  });
  await check('the platform saying the episode is not open is not retried', async () => {
    let lookups = 0;
    const h = hload(async () => {
      lookups++;
      return { url: null, error: '第 8 集未开放' };
    });
    h.run('downloadRetryDelays = [5, 5]');
    const task = {
      id: 'closed',
      type: 'hongguo',
      filename: 'closed.mp4',
      customDir: root,
      hongguoInfo: { vid: 'closed' },
    };
    await h.context.executeHongguoDownload(task);
    assert.equal(task.status, 'failed');
    assert.equal(lookups, 1);
  });
  await check('stop during lookup stays stopped and retry cannot overlap old run', async () => {
    let resolve;
    const h = hload(() => new Promise((r) => (resolve = r)));
    h.run(
      "downloadTasks = [{id:'stop',status:'pending',type:'hongguo',filename:'stop.mp4',customDir:" +
        JSON.stringify(root) +
        ",hongguoInfo:{vid:'stop'}}]; downloadQueue = downloadTasks.slice(); pumpQueue();",
    );
    await h.handlers['stop-download']({}, 'stop');
    resolve({ url: base + '/range' });
    await sleep(50);
    assert.equal(h.run('downloadTasks[0].status'), 'stopped');
    assert.equal(fs.existsSync(path.join(root, 'stop.mp4')), false);
  });
  await check('immediate retry waits for cancelled run and then completes once', async () => {
    let resolve,
      lookups = 0;
    const h = hload(() => {
      lookups++;
      return lookups === 1 ? new Promise((r) => (resolve = r)) : Promise.resolve({ url: base + '/range' });
    });
    h.run(
      "downloadTasks = [{id:'retry',status:'pending',type:'hongguo',filename:'retry.mp4',customDir:" +
        JSON.stringify(root) +
        ",hongguoInfo:{vid:'retry'}}]; downloadQueue = downloadTasks.slice(); pumpQueue();",
    );
    await h.handlers['stop-download']({}, 'retry');
    await h.handlers['retry-task']({}, 'retry');
    assert.equal(lookups, 1, 'retry cannot start before previous run settles');
    resolve({ url: base + '/range' });
    await sleep(80);
    assert.equal(lookups, 2);
    assert.equal(h.run('downloadTasks[0].status'), 'completed');
    assert.equal(fs.readFileSync(path.join(root, 'retry.mp4'), 'utf8'), '0123456789');
  });
  await check('extra: enqueue reuses failed task instead of competing destination writers', async () => {
    const h = hload(() => new Promise(() => {}));
    h.run(
      "downloadTasks = [{id:'old-failed',status:'failed',type:'hongguo',filename:'again.mp4',customDir:" +
        JSON.stringify(root) +
        ",hongguoInfo:{vid:'same',series_id:'S'}}];",
    );
    h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Retry', episodes: [{ vid: 'same', vid_index: 1 }] });
    assert.equal(h.run('downloadTasks.length'), 1, 'one episode must retain one task');
    assert.equal(h.run('downloadTasks[0].id'), 'old-failed');
  });
  await check('extra: concurrent compatibility requests share one encoder and result', async () => {
    let spawned = 0;
    const h = hload(async () => ({ url: base + '/range' }), {
      child_process: {
        spawn: (_file, args) => {
          spawned++;
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          setTimeout(() => {
            fs.writeFileSync(args.at(-1), Buffer.alloc(120000));
            child.emit('close', 0);
          }, 20);
          return child;
        },
      },
    });
    h.context.resolveFfmpeg = () => '/fake/ffmpeg';
    h.context.probeDuration = async () => 1;
    h.context.pickH264Encoder = async () => 'libx264';
    const input = path.join(root, 'compat-input.mp4');
    fs.writeFileSync(input, 'fixture');
    const payload = { seriesId: 'same-series', vidIndex: 1, filePath: input, force: true };
    const results = await Promise.all([
      h.handlers['transcode-for-playback']({}, payload),
      h.handlers['transcode-for-playback']({}, payload),
    ]);
    assert.equal(spawned, 1, 'same episode cannot run two encoders against one output');
    assert.ok(results.every((r) => r.success));
    assert.equal(results[0].url, results[1].url);
  });
  for (const h of harnesses) h.context.clearOnlineCache();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  assert.equal(failures, 0, `${failures} streaming regressions`);
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
