// 原剧放进「原剧」子文件夹：新下载直接下进去；已经下好的剧打开「管理剧集」时自动挪进去，下载记录跟着改。
// 正在下的集、正在处理的剧、用户导入的文件夹都不动。不需要网络和 ffmpeg。
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
    handlers = {};
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
  context.sendToRenderer = () => {};
  context.pumpQueue = () => {};
  context.pumpAllQuchongBatches = () => {};
  return { context, handlers };
}

const touch = (file, size = 2048) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-'));
  const root = path.join(tmp, '下载');
  const old = path.join(root, '老剧');
  const ep = (n, base = old) => path.join(base, `老剧_第00${n}集.mp4`);
  touch(ep(1));
  touch(`${ep(2)}.enc.tmp`); // 第 2 集正在下载，临时文件在外层
  touch(path.join(old, '封面.jpg'));
  fs.writeFileSync(path.join(old, '简介.txt'), '老剧简介');
  touch(path.join(old, '去重', '新名_第001集.mp4'));
  const busy = path.join(root, '忙剧');
  touch(path.join(busy, '忙剧_第001集.mp4'));
  const imported = path.join(tmp, '我的素材', '导入剧');
  touch(path.join(imported, '导入剧_第001集.mp4'));

  const registry = [
    { series_id: '7', series_title: '老剧', folder: '老剧', total: 3, episodes: [] },
    { series_id: '8', series_title: '忙剧', folder: '忙剧', total: 1, episodes: [] },
    { series_id: '9', series_title: '新剧', folder: '', total: 1, synopsis: '新剧的平台简介', episodes: [] },
  ];
  const { context, handlers } = makeMain(root, path.join(tmp, 'ud'), registry);
  const task = (id, n, status, savePath) =>
    vm.runInContext(
      `downloadTasks.push(${JSON.stringify({
        id,
        status,
        savePath,
        customDir: old,
        filename: path.basename(savePath),
        hongguoInfo: { vid: `v${n}`, series_id: '7', vid_index: n },
      })})`,
      context,
    );
  task('t1', 1, 'completed', ep(1));
  task('t2', 2, 'downloading', ep(2));
  task('t3', 3, 'pending', ep(3));
  vm.runInContext(`runningDownloads.add('t2'); runningDownloadPaths.add(${JSON.stringify(ep(2))})`, context);
  vm.runInContext(`libraryFolders().add(${JSON.stringify(imported)})`, context);
  vm.runInContext(`libraryPlanning.set(${JSON.stringify(path.resolve(busy))}, { done: 0, total: 1 })`, context);
  const savePath = (id) => vm.runInContext(`downloadTasks.find((t) => t.id === '${id}').savePath`, context);

  // 1. 打开「管理剧集」：老剧外层的原集、封面、简介挪进「原剧」，成品不动。
  const listed = await handlers['library-list']({});
  assert.equal(listed.success, true);
  const originals = path.join(old, '原剧');
  for (const name of ['老剧_第001集.mp4', '封面.jpg', '简介.txt']) {
    assert.ok(fs.existsSync(path.join(originals, name)), `${name} moved into 原剧`);
    assert.ok(!fs.existsSync(path.join(old, name)), `${name} gone from the outside`);
  }
  assert.ok(fs.existsSync(path.join(old, '去重', '新名_第001集.mp4')), 'outputs stay where they are');
  assert.equal(savePath('t1'), ep(1, originals), 'the finished download record follows the file');
  assert.equal(savePath('t3'), ep(3, originals), 'a queued download now lands in 原剧');
  assert.equal(savePath('t2'), ep(2), 'a running download is left alone');
  assert.ok(fs.existsSync(`${ep(2)}.enc.tmp`), "the running download's temp file is not touched");
  const card = listed.folders.find((item) => item.name === '老剧');
  assert.equal(card.videoCount, 1);
  assert.equal(card.hasSynopsis, true);
  assert.ok(card.coverUrl, 'the cover is still found inside 原剧');
  console.log('PASS existing series: originals, cover and synopsis move into 原剧; records follow');

  // 2. 第 2 集下完后，下次打开这部剧就挪进去。
  vm.runInContext(
    `runningDownloads.delete('t2'); runningDownloadPaths.clear(); downloadTasks.find((t) => t.id === 't2').status = 'completed'`,
    context,
  );
  fs.rmSync(`${ep(2)}.enc.tmp`);
  touch(ep(2));
  const detail = await handlers['library-episodes']({}, old);
  assert.equal(detail.success, true);
  assert.deepEqual(
    detail.episodes.map((item) => item.path),
    [ep(1, originals), ep(2, originals)],
  );
  assert.equal(savePath('t2'), ep(2, originals));
  assert.equal(detail.synopsis, '老剧简介');
  console.log('PASS a download that finishes later is moved the next time the series is opened');

  // 3. 正在处理（分析切点）的剧先不挪；用户导入的文件夹从不挪。
  assert.ok(fs.existsSync(path.join(busy, '忙剧_第001集.mp4')), 'a busy series is not touched');
  assert.ok(!fs.existsSync(path.join(busy, '原剧')));
  assert.ok(fs.existsSync(path.join(imported, '导入剧_第001集.mp4')), 'imported folders are never moved');
  assert.ok(!fs.existsSync(path.join(imported, '原剧')));
  const importedDetail = await handlers['library-episodes']({}, imported);
  assert.equal(importedDetail.episodes.length, 1, 'imported folders still list their top-level videos');
  vm.runInContext('libraryPlanning.clear()', context);
  await handlers['library-list']({});
  assert.ok(fs.existsSync(path.join(busy, '原剧', '忙剧_第001集.mp4')), 'moved once the series is free');
  console.log('PASS busy series wait; imported folders are never moved');

  // 4. 新下载直接下进「原剧」，平台简介也写在「原剧」里。
  await context.enqueueEpisodes({
    seriesId: '9',
    seriesTitle: '新剧',
    episodes: [{ vid: 'n1', vid_index: 1 }],
    cover: '',
  });
  const fresh = vm.runInContext(`downloadTasks.find((t) => t.hongguoInfo.vid === 'n1')`, context);
  assert.equal(path.dirname(fresh.savePath), path.join(root, '新剧', '原剧'), 'new episodes download into 原剧');
  assert.equal(fresh.customDir, path.join(root, '新剧'), 'the series folder itself is still the series');
  for (let i = 0; i < 50 && !fs.existsSync(path.join(root, '新剧', '原剧', '简介.txt')); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(path.join(root, '新剧', '原剧', '简介.txt'), 'utf8').trim(), '新剧的平台简介');
  assert.ok(!fs.existsSync(path.join(root, '新剧', '简介.txt')));
  console.log('PASS new downloads and their cover/synopsis go straight into 原剧');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
