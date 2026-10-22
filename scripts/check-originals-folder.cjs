// 原集视频放进「原剧」子文件夹：新下载直接下进去；已经下好的剧打开「管理剧集」时自动挪进去，下载记录跟着改。
// 正在下的集、正在处理的剧、用户导入的文件夹都不动。
// 原剧海报、原剧集信息.txt、新剧集信息.txt 放在剧文件夹根目录；以前的结构（封面、简介.txt、发布剧名 / 简介 / 海报、
// 「视频提示词」）打开管理剧集时自动整理成新结构，视频不动。不需要网络和 ffmpeg。
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

  // 1. 打开「管理剧集」：老剧外层的原集挪进「原剧」；封面变成根目录的 原剧集海报.jpg，简介写进 原剧集信息.txt；成品不动。
  const listed = await handlers['library-list']({});
  assert.equal(listed.success, true);
  const originals = path.join(old, '原剧');
  assert.ok(fs.existsSync(path.join(originals, '老剧_第001集.mp4')), 'the episode moved into 原剧');
  assert.ok(!fs.existsSync(path.join(old, '老剧_第001集.mp4')));
  assert.deepEqual(fs.readdirSync(originals), ['老剧_第001集.mp4'], '「原剧」里只有原集视频');
  assert.ok(fs.existsSync(path.join(old, '原剧集海报.jpg')) && !fs.existsSync(path.join(old, '封面.jpg')), '封面 → 原剧集海报.jpg');
  assert.ok(!fs.existsSync(path.join(old, '简介.txt')), '简介.txt 合进原剧集信息.txt 后删掉');
  assert.equal(
    fs.readFileSync(path.join(old, '原剧集信息.txt'), 'utf8'),
    '剧名：老剧\n来源：红果\n总集数：3 集\n已下载：1 集\n已处理：「去重」里有 1 集成品\n\n简介：\n老剧简介\n',
  );
  assert.match(fs.readFileSync(path.join(old, '新剧集信息.txt'), 'utf8'), /^剧名：（还没定.*）\n已处理：1 集（「去重」文件夹里的成品）\n/);
  assert.ok(fs.existsSync(path.join(old, '去重', '新名_第001集.mp4')), 'outputs stay where they are');
  assert.equal(savePath('t1'), ep(1, originals), 'the finished download record follows the file');
  assert.equal(savePath('t3'), ep(3, originals), 'a queued download now lands in 原剧');
  assert.equal(savePath('t2'), ep(2), 'a running download is left alone');
  assert.ok(fs.existsSync(`${ep(2)}.enc.tmp`), "the running download's temp file is not touched");
  const card = listed.folders.find((item) => item.name === '老剧');
  assert.equal(card.videoCount, 1);
  assert.equal(card.hasSynopsis, true);
  assert.ok(card.coverUrl, 'the poster is found at the root');
  console.log('PASS existing series: originals move into 原剧, poster and info files at the root; records follow');

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
  assert.match(fs.readFileSync(path.join(old, '原剧集信息.txt'), 'utf8'), /\n已下载：2 集\n/, '下完一集，打开时数字跟着更新');
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

  // 4. 新下载直接下进「原剧」，平台简介写进根目录的 原剧集信息.txt。
  await context.enqueueEpisodes({
    seriesId: '9',
    seriesTitle: '新剧',
    episodes: [{ vid: 'n1', vid_index: 1 }],
    cover: '',
  });
  const fresh = vm.runInContext(`downloadTasks.find((t) => t.hongguoInfo.vid === 'n1')`, context);
  assert.equal(path.dirname(fresh.savePath), path.join(root, '新剧', '原剧'), 'new episodes download into 原剧');
  assert.equal(fresh.customDir, path.join(root, '新剧'), 'the series folder itself is still the series');
  const freshInfo = path.join(root, '新剧', '原剧集信息.txt');
  for (let i = 0; i < 50 && !/新剧的平台简介/.test(fs.existsSync(freshInfo) ? fs.readFileSync(freshInfo, 'utf8') : ''); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(fs.readFileSync(freshInfo, 'utf8'), /^剧名：新剧\n来源：红果\n总集数：1 集\n已下载：0 集\n已处理：0 集\n\n简介：\n新剧的平台简介\n$/);
  assert.ok(!fs.existsSync(path.join(root, '新剧', '简介.txt')) && !fs.existsSync(path.join(root, '新剧', '原剧', '简介.txt')));
  console.log('PASS new downloads go into 原剧; the platform synopsis goes into 原剧集信息.txt at the root');

  // 5. 上一版的结构：「原剧」里的封面和简介、外层的发布剧名 / 简介 / 海报、「视频提示词」文件夹 → 新结构
  const prev = path.join(root, '旧版剧');
  touch(path.join(prev, '原剧', '旧版剧 - 第1集.mp4'));
  touch(path.join(prev, '原剧', '封面.png'));
  fs.writeFileSync(path.join(prev, '原剧', '简介.txt'), '旧版剧的简介\n');
  touch(path.join(prev, '去重', '新名字 - 第1集.mp4'));
  touch(path.join(prev, '去重', '新名字 - 第2集.mp4'));
  fs.writeFileSync(path.join(prev, '发布剧名.txt'), '新名字\n');
  fs.writeFileSync(path.join(prev, '发布简介.txt'), '这是改写过的新简介。\n');
  touch(path.join(prev, '发布海报.jpg'));
  const pages = path.join(prev, '视频提示词');
  touch(path.join(pages, '新名字 - 第1集.html'));
  touch(path.join(pages, '新名字 - 第1集.txt'));
  touch(path.join(pages, '新名字 - 第1集.jpg'));
  touch(path.join(pages, '新名字 - 第1集-参考图', 'C1-林夏.jpg'));
  const mp4Before = fs.statSync(path.join(prev, '去重', '新名字 - 第1集.mp4')).mtimeMs;
  const relisted = await handlers['library-list']({});
  assert.ok(relisted.folders.find((item) => item.name === '旧版剧').coverUrl, '挪过的海报照样显示');
  const tree = (dir, prefix = '') =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? [`${prefix}${entry.name}/`, ...tree(path.join(dir, entry.name), `${prefix}${entry.name}/`)] : [`${prefix}${entry.name}`]))
      .sort();
  assert.deepEqual(tree(prev), [
    '分镜工程图/',
    '分镜工程图/新名字 - 第1集.jpg',
    '分镜工程图/网页和提示词/',
    '分镜工程图/网页和提示词/新名字 - 第1集-参考图/',
    '分镜工程图/网页和提示词/新名字 - 第1集-参考图/C1-林夏.jpg',
    '分镜工程图/网页和提示词/新名字 - 第1集.html',
    '分镜工程图/网页和提示词/新名字 - 第1集.txt',
    '去重/',
    '去重/新名字 - 第1集.mp4',
    '去重/新名字 - 第2集.mp4',
    '原剧/',
    '原剧/旧版剧 - 第1集.mp4',
    '原剧集信息.txt',
    '原剧集海报.png',
    '新剧集信息.txt',
    '新剧集海报.jpg',
  ].sort());
  assert.equal(fs.readFileSync(path.join(prev, '原剧集信息.txt'), 'utf8'), '剧名：旧版剧\n已下载：1 集\n已处理：「去重」里有 2 集成品\n\n简介：\n旧版剧的简介\n');
  assert.equal(fs.readFileSync(path.join(prev, '新剧集信息.txt'), 'utf8'), '剧名：新名字\n已处理：2 集（「去重」文件夹里的成品）\n\n简介：\n这是改写过的新简介。\n');
  assert.equal(fs.statSync(path.join(prev, '去重', '新名字 - 第1集.mp4')).mtimeMs, mp4Before, '视频不动');
  // 再打开一次：什么都不变（不重复挪、信息文件内容一样就不重写）
  const infoTime = fs.statSync(path.join(prev, '原剧集信息.txt')).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 30));
  await handlers['library-list']({});
  assert.equal(fs.statSync(path.join(prev, '原剧集信息.txt')).mtimeMs, infoTime);
  // 用户手改的简介保留，数字照样更新
  fs.writeFileSync(path.join(prev, '原剧集信息.txt'), fs.readFileSync(path.join(prev, '原剧集信息.txt'), 'utf8').replace('旧版剧的简介', '我自己改的简介'));
  touch(path.join(prev, '原剧', '旧版剧 - 第2集.mp4'));
  const reopened = await handlers['library-episodes']({}, prev);
  assert.equal(reopened.synopsis, '我自己改的简介');
  assert.match(fs.readFileSync(path.join(prev, '原剧集信息.txt'), 'utf8'), /已下载：2 集[\s\S]*简介：\n我自己改的简介\n$/);
  console.log('PASS the previous layout moves into the new one; videos untouched; edits kept; nothing rewritten when unchanged');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
