// Offline behavioral checks. All files live in a disposable directory; no app data/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-safety-'));
let serial = 0, failures = 0;
function load(settings = {}, overrides = {}) {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const handlers = {}, app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} } };
  const store = { getSettings: () => ({ root: dir, ...settings }), saveTasks() {}, saveSeries() {}, saveSettings() {} };
  const context = vm.createContext({ require: name => overrides[name] || (name === 'electron' ? electron : name === './src/store' ? store : req(name)), __dirname: path.dirname(source), process: { ...process, env: { ...process.env } }, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  const pump = context.pumpQueue;
  context.pumpQueue = () => {}; // Inspect queued destinations without fetching media.
  return { context, handlers, dir, pump, run: code => vm.runInContext(code, context), set(name, value) { context.fixture = value; vm.runInContext(`${name} = fixture`, context); } };
}
function task(id, dir, status = 'completed', filename = `${id}.mp4`, index = 1) {
  return { id, type: 'hongguo', status, filename, savePath: path.join(dir, filename), customDir: dir, hongguoInfo: { vid: id, series_id: 'S', series_title: 'Short', vid_index: index } };
}
function series() { return [{ series_id: 'S', series_title: 'Short', episodes: [{ vid: 'one', vid_index: 1 }, { vid: 'two', vid_index: 2 }] }]; }
function file(p) { fs.writeFileSync(p, Buffer.alloc(120000)); }
async function check(name, run) { try { await run(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); } }
(async () => {
  await check('title-only preset keeps episode destinations unique', async () => {
    const h = load({ name_format: '剧名' });
    await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: series()[0].episodes });
    const paths = h.run('downloadTasks.map(task => task.savePath)');
    assert.equal(new Set(paths).size, 2, 'different episodes must not share a final or temporary path');
  });
  await check('episode status prefers a valid file over a newer failed retry', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const complete = task('one', h.dir, 'completed', 'complete.mp4'); complete.startTime = 1; file(complete.savePath);
    const failed = task('one', h.dir, 'failed', 'retry.mp4'); failed.id = 'retry'; failed.startTime = 2;
    h.set('downloadTasks', [complete, failed]);
    const detail = await h.handlers['get-series-episodes']({}, 'S');
    assert.equal(detail.data.episodes.length, 2);
    assert.equal(detail.data.episodes[0].status, 'completed');
    assert.equal(detail.data.completedCount, 1);
    const added = await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: [series()[0].episodes[0]] });
    assert.equal(added, 0, 'a valid existing file must not be requeued');
  });
  await check('task-only episode overview deduplicates repeated indices', async () => {
    const h = load();
    const first = task('one', h.dir, 'failed', 'one.mp4', 1);
    const retry = task('one', h.dir, 'failed', 'retry.mp4', 1); retry.id = 'retry'; retry.startTime = 2;
    h.set('downloadTasks', [first, retry]);
    const detail = await h.handlers['get-series-episodes']({}, 'S');
    assert.equal(detail.data.episodes.length, 1);
    assert.equal(detail.data.episodes[0].vid_index, 1);
  });
  await check('same-title series use independent directories', () => {
    const h = load();
    assert.notEqual(h.context.seriesDownloadDir(h.dir, 'S1', 'Short'), h.context.seriesDownloadDir(h.dir, 'S2', 'Short'));
  });
  await check('new episodes share a series root with an originals subdirectory', async () => {
    const h = load(); h.set('seriesRegistry', series());
    await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: series()[0].episodes });
    const seriesDir = h.context.seriesDownloadDir(h.dir, 'S', 'Short');
    const tasks = h.run('downloadTasks');
    for (const item of tasks) {
      assert.equal(item.customDir, path.join(seriesDir, '原视频'));
      assert.equal(path.dirname(item.savePath), item.customDir);
      file(item.savePath); item.status = 'completed';
    }
    const scanned = h.context.collectSeriesEpisodeFiles('S', 'Short');
    assert.equal(scanned.dir, seriesDir, 'series-level outputs must not be placed inside the originals directory');
    assert.equal(scanned.ordered.length, 2);
    const source = tasks.find(item => item.hongguoInfo.vid_index === 1);
    const output = path.join(seriesDir, '去重视频', 'Short 001_去重.mp4');
    fs.mkdirSync(path.dirname(output)); file(output);
    h.context.markPipelineDownloaded(source, source.savePath);
    h.context.markPipelineDeduped(source.savePath, output);
    const episode = h.context.getSeriesDedupedEpisodes('S')[0];
    assert.equal(episode.inputPath, output);
    assert.equal(episode.srtPath, path.join(seriesDir, 'transcripts', 'Short 001_去重.srt'));
  });
  await check('analysis accepts only a verified SRT for the current dedup video', async () => {
    const { inspectSubtitle } = require('../src/native/transcription-manager');
    const h = load(); h.set('seriesRegistry', series());
    await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: [series()[0].episodes[0]] });
    const source = h.run('downloadTasks[0]'); file(source.savePath); source.status = 'completed';
    const seriesDir = h.context.seriesDownloadDir(h.dir, 'S', 'Short');
    const output = path.join(seriesDir, '去重视频', 'Short 001_去重.mp4');
    fs.mkdirSync(path.dirname(output)); file(output);
    h.context.markPipelineDownloaded(source, source.savePath);
    h.context.markPipelineDeduped(source.savePath, output);
    const input = h.context.getSeriesDedupedEpisodes('S')[0];
    fs.mkdirSync(path.dirname(input.srtPath));
    const text = '1\n00:00:01,000 --> 00:00:02,000\n完整对白。\n\n';
    fs.writeFileSync(input.srtPath, text);
    h.context.saveSeriesTranscriptionState('S', { episodes: { '1': { ...input, status: 'completed', revision: 'r1', srtHash: inspectSubtitle(input.srtPath, 10).hash, validation: { duration: 10 } } } });
    assert.equal(h.context.getSeriesAnalysisEpisodes('S').length, 1);
    fs.writeFileSync(input.srtPath, '');
    assert.equal(h.context.getSeriesAnalysisEpisodes('S').length, 0, 'corrupt SRT must not reach AI');
    fs.writeFileSync(input.srtPath, text);
    assert.equal(h.context.getSeriesAnalysisEpisodes('S').length, 1);
    const replacement = path.join(path.dirname(output), 'Short 001_new.mp4'); file(replacement);
    h.context.markPipelineDeduped(source.savePath, replacement);
    assert.equal(h.context.getTranscriptionManager().status('S').episodes[0].status, 'stale');
    assert.equal(h.context.getSeriesAnalysisEpisodes('S').length, 0, 'previous dedup version must not reach AI');
  });
  await check('rescan registers only files inside the originals subdirectory', () => {
    const h = load(); h.set('seriesRegistry', series());
    const seriesDir = h.context.seriesDownloadDir(h.dir, 'S', 'Short');
    fs.mkdirSync(path.join(seriesDir, '原视频'), { recursive: true });
    fs.mkdirSync(path.join(seriesDir, '去重视频'));
    const current = path.join(seriesDir, '原视频', 'Short 002.mp4');
    file(path.join(seriesDir, 'Short 001.mp4')); file(current);
    file(path.join(seriesDir, '去重视频', 'Short 003.mp4'));
    file(path.join(seriesDir, 'Short 004_去重_1.mp4'));
    file(path.join(seriesDir, '.hongguo-quchong-0005.mp4'));
    const result = h.context.rescanDownloadsFromDisk();
    assert.equal(result.count, 1);
    const tasks = h.run('downloadTasks');
    assert.deepEqual(Array.from(tasks.map(item => item.savePath)), [current]);
    for (const item of tasks) assert.equal(item.customDir, path.dirname(item.savePath));
    assert.equal(h.context.rescanDownloadsFromDisk().count, 0, 'rescanning must be idempotent');
  });
  await check('downloads always use the ID-based series directory and never adopt a title-only directory', async () => {
    const h = load(); h.set('seriesRegistry', series());
    const seriesDir = path.join(h.dir, '红果短剧', 'Short'); fs.mkdirSync(seriesDir, { recursive: true });
    file(path.join(seriesDir, 'Short 001.mp4'));
    assert.equal(h.context.resolveSeriesDir('S', 'Short', []), null);
    await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: [series()[0].episodes[1]] });
    await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: [{ vid: 'three', vid_index: 3 }] });
    const tasks = h.run('downloadTasks');
    const expected = h.context.seriesDownloadDir(h.dir, 'S', 'Short');
    for (const item of tasks) assert.equal(item.customDir, path.join(expected, '原视频'));
    assert.equal(h.context.resolveSeriesDir('S', 'Short', tasks), expected);
  });
  await check('Windows stage paths retain their drive and series root', () => {
    const h = load({}, { path: path.win32 });
    const root = String.raw`D:\短剧\红果短剧\布衣成圣-123456abcdef`;
    assert.equal(h.context.seriesRootFromVideoDir(path.win32.join(root, '原视频')), root);
    assert.equal(h.context.seriesRootFromVideoDir(path.win32.join(root, '去重视频')), root);
  });
  await check('missing completed file is shown missing and can be downloaded again', async () => {
    const h = load(); h.set('seriesRegistry', series()); h.set('downloadTasks', [task('one', h.dir)]);
    const detail = await h.handlers['get-series-episodes']({}, 'S');
    assert.equal(detail.data.episodes[0].status, 'missing', 'a missing file cannot remain completed');
    const added = await h.context.enqueueEpisodes({ seriesId: 'S', seriesTitle: 'Short', episodes: [series()[0].episodes[0]] });
    assert.equal(added, 1); assert.equal(h.run('downloadTasks.length'), 1); assert.equal(h.run('downloadTasks[0].status'), 'pending');
  });
  await check('delete downloaded files preserves active and waiting downloads', async () => {
    const h = load(); const completed = task('one', h.dir), active = task('two', h.dir, 'downloading', 'two.mp4', 2), waiting = task('three', h.dir, 'pending', 'three.mp4', 3);
    file(completed.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [completed, active, waiting]); h.set('downloadQueue', [waiting]);
    const result = await h.handlers['delete-all-downloaded']({});
    assert.equal(result.success, true); assert.equal(fs.existsSync(completed.savePath), false);
    assert.equal(h.run('downloadTasks.some(task => task.id === "two")'), true, 'active task disappeared');
    assert.equal(h.run('downloadQueue.some(task => task.id === "three")'), true, 'waiting task disappeared');
  });
  await check('auto-delete uses task identity with title suffixes', async () => {
    const h = load(); const one = task('one', h.dir, 'completed', 'Short 001 Reunion.mp4');
    const two = task('two', h.dir, 'completed', 'Short 002 Story 001.mp4', 2);
    file(one.savePath); file(two.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [one, two]);
    const result = await h.handlers['delete-episode-file']({}, 'S', 1);
    assert.equal(result.count, 1); assert.equal(fs.existsSync(one.savePath), false, 'target episode remains');
    assert.equal(fs.existsSync(two.savePath), true, 'unrelated episode was deleted by title digits');
  });
  await check('explicit task deletion waits for an active lookup to finish cancelling', async () => {
    let finishLookup;
    const h = load({}, { './src/native/hongguo': { fetchPlayUrlSingle: () => new Promise(resolve => { finishLookup = resolve; }) } });
    const one = task('one', h.dir, 'pending'); h.set('downloadTasks', [one]); h.set('downloadQueue', [one]); h.pump();
    const deleting = h.handlers['delete-task']({}, 'one', { deleteFiles: true });
    assert.equal(h.run('downloadTasks.length'), 1, 'record removed before its active run settled');
    finishLookup({ url: null }); await deleting;
    assert.equal(h.run('downloadTasks.length'), 0); assert.equal(h.run('runningDownloads.size'), 0);
  });
  await check('scoped pause preserves another series active and queued downloads', async () => {
    const h = load(); const active = task('one', h.dir, 'downloading'), waiting = task('two', h.dir, 'pending');
    const otherActive = task('other-active', h.dir, 'downloading'), otherWaiting = task('other-waiting', h.dir, 'pending');
    otherActive.hongguoInfo.series_id = otherWaiting.hongguoInfo.series_id = 'Other';
    let cancelled = 0, destroyed = 0;
    active.cancelSource = { cancel() { cancelled++; } }; active.writer = { destroy() { destroyed++; } };
    otherActive.cancelSource = { cancel() { assert.fail('another series was cancelled'); } };
    const otherSource = otherActive.cancelSource;
    h.set('downloadTasks', [active, waiting, otherActive, otherWaiting]); h.set('downloadQueue', [waiting, otherWaiting]);
    const result = await h.handlers['pause-all']({}, ['one', 'two', 'one']);
    assert.equal(result.success, true); assert.equal(result.count, 2); assert.equal(cancelled, 1); assert.equal(destroyed, 1);
    assert.equal(active.status, 'stopped'); assert.equal(waiting.status, 'stopped');
    assert.equal(otherActive.status, 'downloading'); assert.equal(otherActive.cancelSource, otherSource); assert.equal(otherWaiting.status, 'pending');
    assert.equal(h.run('downloadQueue.length'), 1); assert.equal(h.run('downloadQueue[0].id'), 'other-waiting');
  });
  await check('scoped resume retries only selected tasks without resetting active work', async () => {
    const h = load(); const stopped = task('one', h.dir, 'stopped'), failed = task('two', h.dir, 'failed');
    const active = task('active', h.dir, 'downloading'), otherStopped = task('other-stopped', h.dir, 'stopped');
    const otherActive = task('other-active', h.dir, 'downloading'), otherWaiting = task('other-waiting', h.dir, 'pending');
    for (const t of [otherStopped, otherActive, otherWaiting]) t.hongguoInfo.series_id = 'Other';
    active.progress = 42; otherActive.progress = 73; otherWaiting.progress = 12;
    active.cancelSource = { cancel() {} }; otherActive.cancelSource = { cancel() {} };
    const activeSource = active.cancelSource, otherSource = otherActive.cancelSource;
    h.set('downloadTasks', [stopped, failed, active, otherStopped, otherActive, otherWaiting]); h.set('downloadQueue', [otherWaiting]);
    const result = await h.handlers['resume-all']({}, ['one', 'two', 'active', 'one']);
    assert.equal(result.success, true); assert.equal(result.count, 2); assert.equal(stopped.status, 'pending'); assert.equal(failed.status, 'pending');
    assert.equal(active.progress, 42); assert.equal(active.cancelSource, activeSource); assert.equal(otherActive.progress, 73); assert.equal(otherActive.cancelSource, otherSource);
    assert.equal(otherStopped.status, 'stopped'); assert.equal(otherWaiting.progress, 12);
    assert.deepEqual(Array.from(h.run('downloadQueue.map(task => task.id)')), ['other-waiting', 'one', 'two']);
  });
  await check('empty and invalid scopes never fall back to all downloads', async () => {
    for (const name of ['pause-all', 'resume-all']) {
      const h = load(); const waiting = task('one', h.dir, 'pending'), stopped = task('two', h.dir, 'stopped');
      h.set('downloadTasks', [waiting, stopped]); h.set('downloadQueue', [waiting]);
      const before = h.run('JSON.stringify({ tasks: downloadTasks, queue: downloadQueue })');
      const empty = await h.handlers[name]({}, []);
      assert.equal(empty.success, true); assert.equal(empty.count, 0);
      for (const invalid of [null, {}, 'one', 1, ['one', null], ['one', 2], [''], [' '], Array(1)]) {
        assert.equal((await h.handlers[name]({}, invalid)).success, false, `${name} accepted invalid scope`);
      }
      assert.equal(h.run('JSON.stringify({ tasks: downloadTasks, queue: downloadQueue })'), before);
    }
  });
  await check('omitting the scope still pauses and resumes all series', async () => {
    const h = load(); const one = task('one', h.dir, 'pending'), other = task('other', h.dir, 'pending');
    other.hongguoInfo.series_id = 'Other'; h.set('downloadTasks', [one, other]); h.set('downloadQueue', [one, other]);
    assert.equal((await h.handlers['pause-all']({})).count, 2); assert.equal(h.run('downloadQueue.length'), 0);
    assert.equal(one.status, 'stopped'); assert.equal(other.status, 'stopped');
    assert.equal((await h.handlers['resume-all']({})).count, 2); assert.equal(h.run('downloadQueue.length'), 2);
    assert.equal(one.status, 'pending'); assert.equal(other.status, 'pending');
  });
  await check('scoped resume waits for a cancelled run and never starts the same task twice', async () => {
    let finishLookup, lookups = 0;
    const h = load({}, { './src/native/hongguo': { fetchPlayUrlSingle: () => { lookups++; return new Promise(resolve => { finishLookup = resolve; }); } } });
    const one = task('one', h.dir, 'pending'); h.set('downloadTasks', [one]); h.set('downloadQueue', [one]); h.pump();
    const oldRun = h.run('downloadRuns.get("one")');
    assert.equal((await h.handlers['pause-all']({}, ['one'])).count, 1);
    assert.equal((await h.handlers['resume-all']({}, ['one'])).count, 1);
    h.pump(); assert.equal(lookups, 1, 'a second writer started before the cancelled run settled');
    finishLookup({ url: null }); await oldRun;
    assert.equal(one.status, 'pending', 'cancelled predecessor overwrote the queued retry');
    assert.equal(h.run('runningDownloads.size'), 0); assert.equal(h.run('downloadQueue.length'), 1);
    h.pump(); assert.equal(lookups, 2); const retriedRun = h.run('downloadRuns.get("one")');
    finishLookup({ url: null }); await retriedRun;
  });
  await check('failed file deletion keeps the task record', async () => {
    const denied = Object.create(fs); denied.unlinkSync = () => { throw new Error('permission denied'); };
    const h = load({}, { fs: denied }); const one = task('one', h.dir, 'completed', 'Short 001.mp4');
    file(one.savePath); h.set('seriesRegistry', series()); h.set('downloadTasks', [one]);
    const result = await h.handlers['delete-episode-file']({}, 'S', 1);
    assert.ok(result.success === false || result.failed > 0, 'deletion failure must reach caller');
    assert.equal(h.run('downloadTasks.length'), 1, 'failed deletion lost its recovery record');
  });
  await check('store save failure is reported and retains the durable snapshot', () => {
    const dir = path.join(root, 'store'); fs.mkdirSync(dir); const target = path.join(dir, 'data.json');
    let fail = false; const fakeFs = Object.create(fs); fakeFs.writeFileSync = (...args) => { if (fail) throw new Error('simulated disk full'); return fs.writeFileSync(...args); };
    const context = vm.createContext({ require: name => name === 'fs' ? fakeFs : req(name), module: { exports: {} }, console: { error() {} } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/store.js'), 'utf8'), context);
    const store = context.module.exports; store.init(target); store.saveTasks([{ id: 'saved' }]); const before = fs.readFileSync(target, 'utf8'); fail = true;
    assert.throws(() => store.saveTasks([{ id: 'unsaved' }]), /simulated disk full/);
    assert.equal(fs.readFileSync(target, 'utf8'), before); assert.equal(store.getTasks()[0].id, 'saved');
  });
  await check('proxy status and test result never expose credentials', async () => {
    const settings = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 7890, proxy_username: 'test-user', proxy_password: 'secret-fixture' };
    const h = load(settings, { axios: { get: async () => ({ status: 200 }) } });
    const result = [await h.handlers['get-proxy-status']({}), await h.handlers['test-proxy']({}, settings)];
    assert.ok(!JSON.stringify(result).includes('secret-fixture')); assert.ok(!JSON.stringify(result).includes('test-user'));
  });
  await check('failed queue persistence returns failure and leaves no ghost submission', async () => {
    const h = load({}, { './src/store': { getSettings: () => ({ root }), saveTasks() { throw new Error('simulated disk full'); } } });
    const result = await h.handlers['hongguo-download-batch']({}, { seriesId: 'S', seriesTitle: 'Short', episodes: series()[0].episodes });
    assert.equal(result.success, false); assert.equal(h.run('downloadTasks.length'), 0); assert.equal(h.run('downloadQueue.length'), 0);
  });
  await check('bulk series refresh updates downloaded cards, timestamps and preserves failures', async () => {
    const refreshed = { series_id: 'A', series_title: 'Short A', cover: '/a-new.jpg', episodes: [
      { vid: 'a1', vid_index: 1, title: '第一集' },
      { vid: 'a2', vid_index: 2, title: '第二集' },
      { vid: 'a3', vid_index: 3, title: '第三集' },
    ] };
    const h = load({}, { './src/native/hongguo': {
      fetchEpisodeListFromWeb: async sid => sid === 'A' ? refreshed : (() => { throw new Error('远端暂不可用'); })(),
      fetchEpisodeList: async sid => sid === 'A' ? refreshed : (() => { throw new Error('远端暂不可用'); })(),
    } });
    const oldTime = Date.now() - 5000;
    h.set('seriesRegistry', [
      { series_id: 'A', series_title: 'Short A', cover: '/a.jpg', total: 2, episodes: [{ vid: 'a1', vid_index: 1 }, { vid: 'a2', vid_index: 2 }], updatedAt: oldTime },
      { series_id: 'B', series_title: 'Short B', cover: '/b.jpg', total: 1, episodes: [{ vid: 'b1', vid_index: 1 }], episodesUpdatedAt: oldTime },
      { series_id: 'C', series_title: '只浏览未下载', total: 1, episodes: [{ vid: 'c1', vid_index: 1 }], episodesUpdatedAt: oldTime },
    ]);
    const a = task('a-task', h.dir, 'completed', 'a.mp4', 1); a.hongguoInfo.series_id = 'A';
    const b = task('b-task', h.dir, 'completed', 'b.mp4', 1); b.hongguoInfo.series_id = 'B';
    h.set('downloadTasks', [a, b]);
    const result = await h.handlers['refresh-all-series']({});
    assert.equal(result.success, false); assert.equal(result.total, 2); assert.equal(result.succeeded, 1); assert.equal(result.failed, 1);
    assert.equal(result.addedEpisodes, 1); assert.equal(result.results[0].addedCount, 1);
    const aStored = h.run('seriesRegistry.find(s => s.series_id === "A")');
    const bStored = h.run('seriesRegistry.find(s => s.series_id === "B")');
    const cStored = h.run('seriesRegistry.find(s => s.series_id === "C")');
    assert.equal(aStored.episodes.length, 3); assert.ok(aStored.episodesUpdatedAt > oldTime); assert.equal(aStored.cover, '/a-new.jpg');
    assert.equal(bStored.episodes.length, 1); assert.equal(bStored.episodesUpdatedAt, oldTime); assert.equal(cStored.episodesUpdatedAt, oldTime);
    assert.equal(h.run('downloadTasks.length'), 2, 'refresh must never enqueue downloads');
  });
  assert.equal(failures, 0, `${failures} download safety regressions`);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
