// 「管理剧集」：按文件夹里实际存在的视频认集、导入已有剧、把选中的集交给去重队列，无需网络和 ffmpeg。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');
const lib = require('../src/native/series-library');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'series-lib-'));
const touch = (file, size = 2048) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
};

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
  return { context, handlers, events };
}
const realEpisode = (file) =>
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x284:rate=25:duration=12',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=12',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ]);

// 在 vm 里创建的数组原型不同，先转成普通 JSON 再比较。
const deq = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL ' + name + ': ' + e.message);
  }
}

(async () => {
  await check('episode numbers come from the file name', () => {
    const cases = [
      ['剧名_第003集.mp4', 3],
      ['剧名 第 12 集.mp4', 12],
      ['Drama.EP07.mp4', 7],
      ['drama_E5.mkv', 5],
      ['12.mp4', 12],
      ['我的2024年大戏 08.mp4', 8],
      ['我的2024年大戏.mp4', null],
      ['没有数字.mp4', null],
    ];
    for (const [name, expected] of cases) assert.equal(lib.parseEpisodeIndex(name), expected, name);
  });

  await check('episodes are listed by episode number; outputs, hidden files and non-video files are skipped', () => {
    const dir = path.join(tmp, 'a');
    for (const name of [
      '剧_第010集.mp4',
      '剧_第002集.mp4',
      '剧_第001集.mp4',
      '无编号.mp4',
      '剧_第001集_去重.mp4',
      '.hidden.mp4',
    ])
      touch(path.join(dir, name));
    touch(path.join(dir, '封面.jpg'));
    touch(path.join(dir, '简介.txt'));
    touch(path.join(dir, '去重', '剧_第001集_去重.mp4'));
    const list = lib.scanEpisodes(dir);
    assert.deepEqual(
      list.map((item) => [item.name, item.index]),
      [
        ['剧_第001集.mp4', 1],
        ['剧_第002集.mp4', 2],
        ['剧_第010集.mp4', 10],
        ['无编号.mp4', null],
      ],
    );
    assert.ok(list.every((item) => item.size === 2048));
  });

  await check('library lists download sub-folders and imported folders; empty folders are not series', () => {
    const root = path.join(tmp, 'root');
    touch(path.join(root, '剧甲', '剧甲_第001集.mp4'));
    touch(path.join(root, '剧甲', '封面.png'));
    fs.mkdirSync(path.join(root, '空文件夹'), { recursive: true });
    touch(path.join(root, '.隐藏', 'x_第001集.mp4'));
    touch(path.join(tmp, 'elsewhere', '剧乙', '剧乙_01.mp4'));
    const folders = lib.scanLibrary(root, [path.join(tmp, 'elsewhere', '剧乙'), path.join(tmp, '已不存在')]);
    assert.deepEqual(
      folders.map((item) => [item.name, item.imported, item.videoCount]).sort(),
      [
        ['剧乙', true, 1],
        ['剧甲', false, 1],
      ].sort(),
    );
    const first = folders.find((item) => item.name === '剧甲');
    assert.ok(first.coverPath.endsWith('封面.png'));
    assert.equal(first.hasSynopsis, false);
  });

  await check('imported folder list is remembered and removing it never touches the folder', () => {
    const file = path.join(tmp, 'state', 'library-folders.json');
    const list = lib.createFolderList(file);
    assert.deepEqual(list.list(), []);
    const dir = path.join(tmp, 'imp');
    touch(path.join(dir, 'a_第001集.mp4'));
    list.add(dir);
    list.add(dir);
    assert.deepEqual(list.list(), [path.resolve(dir)]);
    list.remove(dir);
    assert.deepEqual(list.list(), []);
    assert.ok(fs.existsSync(path.join(dir, 'a_第001集.mp4')));
    fs.writeFileSync(file, '坏掉的内容');
    assert.deepEqual(list.list(), []);
  });

  await check('only library folders may be read or written', () => {
    const root = path.join(tmp, 'root');
    const imported = [path.join(tmp, 'elsewhere', '剧乙')];
    assert.equal(lib.isLibraryFolder(path.join(root, '剧甲'), root, imported), true);
    assert.equal(lib.isLibraryFolder(imported[0], root, imported), true);
    assert.equal(lib.isLibraryFolder(root, root, imported), false);
    assert.equal(lib.isLibraryFolder(path.join(root, '剧甲', '去重'), root, imported), false);
    assert.equal(lib.isLibraryFolder(path.join(tmp, 'elsewhere'), root, imported), false);
    assert.equal(lib.isLibraryFolder('', root, imported), false);
  });

  await check('main: list, episodes and dedup go through the real IPC handlers', async () => {
    const root = path.join(tmp, 'dl'),
      userData = path.join(tmp, 'userData');
    touch(path.join(root, '同名剧', '同名剧_第001集.mp4'));
    touch(path.join(root, '同名剧', '同名剧_第002集.mp4'));
    touch(path.join(root, '同名剧', '封面.jpg'));
    fs.writeFileSync(path.join(root, '同名剧', '简介.txt'), '这是简介');
    touch(path.join(tmp, 'imported', '外来剧', '外来剧_第001集.mp4'));
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
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(tmp, 'imported', '外来剧')] }),
      },
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
      setImmediate,
      console: { log() {}, warn() {}, error() {} },
    });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    vm.runInContext(
      `seriesRegistry=[{series_id:'7',series_title:'同名剧',cover:'https://x.invalid/c.jpg',total:5,folder:'同名剧',synopsis:'平台简介',episodes:[{vid:'a',vid_index:2,cover:'https://x.invalid/e2.jpg'}]}]`,
      context,
    );

    const listed = await handlers['library-list']({});
    assert.equal(listed.success, true);
    const series = listed.folders.find((item) => item.name === '同名剧');
    assert.equal(series.videoCount, 2);
    assert.equal(series.totalEpisodes, 5);
    assert.equal(series.linked, true);
    assert.equal(series.source, '红果');
    assert.match(series.coverUrl, /^hongguo-local:\/\//, 'the cover file in the folder is preferred');
    assert.equal(series.hasSynopsis, true);

    const imported = await handlers['library-import']({});
    assert.equal(imported.success, true);
    const afterImport = (await handlers['library-list']({})).folders;
    assert.equal(afterImport.find((item) => item.name === '外来剧').imported, true);

    const detail = await handlers['library-episodes']({}, series.path);
    assert.equal(detail.success, true);
    assert.equal(detail.synopsis, '这是简介', 'folder file wins over registry text');
    assert.deepEqual(
      detail.episodes.map((item) => [item.index, item.cover]),
      [
        [1, ''],
        [2, 'https://x.invalid/e2.jpg'],
      ],
    );
    assert.equal(detail.outputDir, path.join(series.path, '去重'));
    assert.equal((await handlers['library-episodes']({}, path.join(tmp, 'elsewhere'))).success, false);

    const missingInput = await handlers['library-dedup']({}, { dir: series.path, files: [] });
    assert.match(missingInput.error, /选择/);
    const outside = await handlers['library-dedup'](
      {},
      {
        dir: series.path,
        files: [path.join(tmp, 'imported', '外来剧', '外来剧_第001集.mp4')],
      },
    );
    assert.match(outside.error, /不在这部剧/);
    const notLibrary = await handlers['library-dedup']({}, { dir: path.join(tmp, 'elsewhere'), files: ['x.mp4'] });
    assert.match(notLibrary.error, /不是剧文件夹/);

    context.resolveFfmpeg = () => '/bin/true';
    context.pumpAllQuchongBatches = () => {};
    const started = await handlers['library-dedup'](
      {},
      {
        dir: series.path,
        mode: 'episode',
        files: [path.join(series.path, '同名剧_第002集.mp4')],
      },
    );
    assert.equal(started.success, true, started.error);
    const [task] = vm.runInContext('[...quchongBatches.values()].flatMap((b) => b.tasks)', context);
    assert.equal(task.dst, path.join(series.path, '去重', '同名剧_第002集_去重.mp4'));
    // 支线任务：没勾去重也没勾草稿 → 拒绝；只做草稿但还没有去重成品 → 说清楚
    const nothing = await handlers['library-dedup']({}, { dir: series.path, dedup: false, sideTasks: {} });
    assert.match(nothing.error, /至少勾选/);
    const noOutputs = await handlers['library-dedup'](
      {},
      { dir: series.path, dedup: false, sideTasks: { jianyingDraft: { enabled: true, mode: 'simple' } } },
    );
    assert.equal(noOutputs.success, false);
    assert.match(noOutputs.error, /还没有去重成品/);
    assert.equal(
      vm.runInContext(
        "normalizeSideTasks({ jianyingDraft: { enabled: true, mode: 'x' } }).jianyingDraft.mode",
        context,
      ),
      'simple',
    );
    assert.equal(
      vm.runInContext(
        "normalizeSideTasks({ jianyingDraft: { enabled: true, mode: 'multi' } }).jianyingDraft.mode",
        context,
      ),
      'multi',
    );
    assert.equal(vm.runInContext('normalizeSideTasks({ jianyingDraft: { enabled: false } })', context), null);
    // 草稿只做几集：默认前 4 集，或按成品集号指定
    const pickFiles = (scope) =>
      JSON.parse(
        vm.runInContext(
          `JSON.stringify((() => { const r = selectDraftFiles(${JSON.stringify(
            [6, 1, 2, 10, 3, 4, 5].map((n) => `/s/去重/剧_第${String(n).padStart(3, '0')}集.mp4`),
          )}, ${JSON.stringify(scope ?? null)}); return { files: r.files.map((f) => f.split('/').pop()), missing: r.missing, numbers: r.numbers }; })())`,
          context,
        ),
      );
    const names = (r) => r.files;
    assert.deepEqual(names(pickFiles(undefined)), [
      '剧_第001集.mp4',
      '剧_第002集.mp4',
      '剧_第003集.mp4',
      '剧_第004集.mp4',
    ]);
    assert.deepEqual(names(pickFiles({ numbers: [10, 3] })), ['剧_第003集.mp4', '剧_第010集.mp4']);
    assert.deepEqual(pickFiles({ numbers: [3, 99] }).missing, [99]);
    assert.deepEqual(
      names(pickFiles({ numbers: [1, 2, 3, 4, 5, 6] })),
      ['剧_第001集.mp4', '剧_第002集.mp4', '剧_第003集.mp4', '剧_第004集.mp4'],
      'at most four',
    );
    assert.deepEqual(pickFiles({ numbers: [] }).numbers, []);
    assert.equal(
      vm.runInContext("JSON.stringify(normalizeDraftScope({ numbers: ['x', 2, 2, 0, -1] }))", context),
      JSON.stringify({ numbers: [2] }),
    );
    const noneMatched = await handlers['library-draft'](
      {},
      { dir: series.path, mode: 'simple', scope: { numbers: [7] } },
    );
    assert.equal(noneMatched.success, false);
    // 这批处理属于这部剧：处理进度、日志、总任务都按剧归到「管理剧集」里，切页面回来还能读到。
    const [batch] = vm.runInContext('[...quchongBatches.values()]', context);
    assert.equal(batch.libraryDir, series.path);
    assert.deepEqual(Array.from(task.episodes), [2]);
    const activity = await handlers['library-activity']({}, series.path);
    assert.equal(activity.success, true);
    assert.equal(activity.batches.length, 1);
    assert.equal(activity.batches[0].libraryDir, series.path);
    assert.equal(activity.batches[0].total, 1);
    assert.equal(activity.batches[0].modeText, '按原集去重');
    assert.ok(
      activity.logs.some((line) => /已加入去重队列：1 集（按原集去重）/.test(line.text)),
      'queueing is logged',
    );
    assert.equal((await handlers['library-activity']({}, path.join(tmp, 'elsewhere'))).success, false);
    const overview = await handlers['library-overview']({});
    const mine = overview.items.find((item) => item.dir === series.path);
    assert.ok(mine && mine.processing, 'the series shows up in the overall task list');
    assert.equal(mine.processing.total, 1);
    assert.equal((await handlers['library-activity']({}, root)).success, false, 'the download root is not a series');
    assert.equal((await handlers['library-activity-clear']({}, series.path)).success, true);
    assert.deepEqual(Array.from((await handlers['library-activity']({}, series.path)).logs), []);

    // 默认模式是重新拆分：用真实的小视频走完 探测 -> 切点分析 -> 规划 -> 入队。
    let haveFfmpeg = true;
    try {
      require('node:child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch (_) {
      haveFfmpeg = false;
    }
    if (haveFfmpeg) {
      const real = path.join(root, '真剧');
      fs.mkdirSync(real, { recursive: true });
      for (const n of [1, 2]) {
        require('node:child_process').execFileSync('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=160x284:rate=25:duration=12',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=12',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          path.join(real, `真剧_第00${n}集.mp4`),
        ]);
      }
      context.resolveFfmpeg = (name) => name;
      const split = await handlers['library-dedup'](
        {},
        {
          dir: real,
          files: [path.join(real, '真剧_第002集.mp4'), path.join(real, '真剧_第001集.mp4')],
          split: { min_len: 5, max_len: 12, head_trim: 0.5, tail_trim: 0.5, start_number: 3 },
          opts: { speed_min: 1.03, speed_max: 1.2, black_intro: false },
        },
      );
      assert.equal(split.success, true, split.error);
      assert.ok(split.summary.count >= 2);
      assert.ok(split.summary.minSeconds >= 5 && split.summary.maxSeconds <= 12, JSON.stringify(split.summary));
      // 开始处理前的预览：按时长和当前参数估一下会得到几集。
      const estimate = await handlers['library-estimate'](
        {},
        {
          dir: real,
          files: [path.join(real, '真剧_第001集.mp4'), path.join(real, '真剧_第002集.mp4')],
          split: { min_len: 5, max_len: 12, head_trim: 0.5, tail_trim: 0.5, start_number: 3 },
          opts: { speed_min: 1.03, speed_max: 1.2, black_intro: false },
        },
      );
      assert.equal(estimate.success, true, estimate.error);
      assert.equal(estimate.selectedCount, 2);
      assert.equal(estimate.firstEpisode, 1);
      assert.equal(estimate.lastEpisode, 2);
      assert.equal(estimate.startNumber, 3);
      assert.ok(estimate.totalSeconds > 0 && estimate.count >= 1 && estimate.minCount <= estimate.count);
      assert.ok(estimate.maxCount >= estimate.count);
      assert.equal((await handlers['library-estimate']({}, { dir: real, files: [] })).success, false);
      const tasks = vm
        .runInContext('[...quchongBatches.values()].flatMap((b) => b.tasks)', context)
        .filter((item) => item.segments);
      assert.equal(tasks.length, split.summary.count);
      assert.deepEqual(
        tasks.map((item) => path.basename(item.dst)),
        tasks.map((_, i) => `真剧_第${String(i + 3).padStart(3, '0')}集.mp4`),
      );
      assert.ok(tasks.every((item) => path.dirname(item.dst) === path.join(real, '去重')));
      assert.ok(tasks.every((item) => item.speed >= 1.03 && item.speed <= 1.2));
      const used = tasks.flatMap((item) => item.segments);
      assert.equal(path.basename(used[0].src), '真剧_第001集.mp4', 'episodes are joined in episode order');
      const kept = used.reduce((sum, segment) => sum + segment.duration, 0);
      assert.ok(Math.abs(kept - 22) < 0.1, `kept ${kept}`);
    }

    await handlers['library-remove-import']({}, path.join(tmp, 'imported', '外来剧'));
    assert.equal(
      (await handlers['library-list']({})).folders.some((item) => item.name === '外来剧'),
      false,
    );
    assert.ok(fs.existsSync(path.join(tmp, 'imported', '外来剧', '外来剧_第001集.mp4')));
  });

  let ffmpegOk = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch (_) {
    ffmpegOk = false;
  }
  await check('main: failed downloads carry a reason (missing resource vs network) and the task to retry', async () => {
    const root = path.join(tmp, 'fail-dl');
    const dir = path.join(root, '失败剧');
    for (const n of [1, 2]) touch(path.join(dir, `失败剧_第00${n}集.mp4`));
    const registry = [
      {
        series_id: '77',
        series_title: '失败剧',
        folder: '失败剧',
        total: 7,
        episodes: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ vid: `v${n}`, vid_index: n })),
      },
    ];
    const { context, handlers } = makeMain(root, path.join(tmp, 'ud-fail'), registry);
    const task = (id, index, fields) =>
      `downloadTasks.push(Object.assign({ id: '${id}', progress: 0, hongguoInfo: { vid: 'v${index}', series_id: '77', vid_index: ${index} } }, ${JSON.stringify(fields)}))`;
    for (const code of [
      task('t3', 3, { status: 'failed', error: '未获取到有效播放地址' }),
      task('t4', 4, { status: 'failed', error: 'socket hang up', errorCode: 'ECONNRESET' }),
      task('t5', 5, { status: 'stopped' }),
      task('t6', 6, { status: 'downloading', progress: 40 }),
    ])
      vm.runInContext(code, context);

    const list = await handlers['library-list']({});
    assert.equal(list.folders.find((item) => item.name === '失败剧').seriesId, '77');

    const detail = await handlers['library-episodes']({}, dir);
    const byIndex = new Map(detail.missing.map((item) => [item.index, item]));
    assert.equal(detail.seriesId, '77');
    assert.equal(byIndex.get(3).state, 'failed');
    assert.equal(byIndex.get(3).task.id, 't3');
    assert.equal(byIndex.get(3).task.reason.kind, 'missing');
    assert.equal(byIndex.get(3).task.reason.label, '资源缺失');
    assert.equal(byIndex.get(3).task.reason.retryHelps, false);
    assert.equal(byIndex.get(4).task.reason.kind, 'network');
    assert.equal(byIndex.get(4).task.reason.label, '网络失败');
    assert.equal(byIndex.get(4).task.reason.retryHelps, true);
    assert.equal(byIndex.get(5).task.status, 'stopped');
    assert.equal(byIndex.get(5).task.reason, null, 'a paused task is not a failure');
    assert.equal(byIndex.get(6).state, 'downloading');
    assert.equal(byIndex.get(6).task.progress, 40);
    // 第 7 集排在最后一个任务之后、也没有任务：平台有、没下载。
    assert.ok(!byIndex.has(7) || byIndex.get(7).state === 'notDownloaded');

    // 「开始处理」的提醒直接写下载失败的原因，而不是只说“下载失败”。
    touch(path.join(dir, '失败剧_第004集.mp4'));
    touch(path.join(dir, '失败剧_第005集.mp4'));
    const asked = await handlers['library-dedup'](
      {},
      { dir, files: [1, 2, 4].map((n) => path.join(dir, `失败剧_第00${n}集.mp4`)), split: {}, opts: {} },
    );
    assert.equal(asked.needsDecision, true);
    assert.equal(asked.kind, 'download');
    const reason = asked.blocking.find((item) => item.index === 3).reason;
    assert.equal(reason.label, '资源缺失');
    assert.equal(reason.retryHelps, false);
    assert.match(reason.detail, /未获取到有效播放地址/);
    const askedNetwork = await handlers['library-dedup'](
      {},
      { dir, files: [4, 5].map((n) => path.join(dir, `失败剧_第00${n}集.mp4`)), split: {}, opts: {} },
    );
    assert.equal(askedNetwork.success, false);
    assert.ok(!askedNetwork.needsDecision);
    assert.match(askedNetwork.error, /从第一集开始连续处理/, '重新拆分不能跳着选：只能整部或前 N 集');
    const skipFirst = await handlers['library-dedup'](
      {},
      { dir, files: [2, 4].map((n) => path.join(dir, `失败剧_第00${n}集.mp4`)), split: {}, opts: {} },
    );
    assert.match(skipFirst.error, /从第一集开始连续处理/, 'a selection that skips the first episode is rejected');
  });

  if (ffmpegOk) {
    await check('main: missing episodes — platform gaps splice, undownloaded gaps need a decision', async () => {
      const root = path.join(tmp, 'gap-dl');
      const dir = path.join(root, '缺集剧');
      fs.mkdirSync(dir, { recursive: true });
      for (const n of [1, 2, 5]) realEpisode(path.join(dir, `缺集剧_第00${n}集.mp4`));
      const registry = [
        {
          series_id: '9',
          series_title: '缺集剧',
          folder: '缺集剧',
          total: 5,
          episodes: [
            { vid: 'v1', vid_index: 1 },
            { vid: 'v2', vid_index: 2 },
            { vid: 'v3', vid_index: 3 },
            { vid: 'v5', vid_index: 5 },
          ],
        },
      ];
      const { context, handlers, events } = makeMain(root, path.join(tmp, 'ud-gap'), registry);
      const split = { min_len: 5, max_len: 12, head_trim: 0.5, tail_trim: 0.5 };
      const opts = { speed_min: 1.03, speed_max: 1.2, black_intro: false };
      const pick = (...numbers) => numbers.map((n) => path.join(dir, `缺集剧_第00${n}集.mp4`));

      const detail = await handlers['library-episodes']({}, dir);
      deq(
        detail.missing.map((item) => [item.index, item.state, item.text]),
        [
          [3, 'notDownloaded', '没下载'],
          [4, 'absent', '平台无此集'],
        ],
      );

      const asked = await handlers['library-dedup']({}, { dir, files: pick(1, 2, 5), split, opts });
      assert.equal(asked.success, false);
      assert.equal(asked.needsDecision, true);
      assert.equal(asked.kind, 'download');
      deq(
        asked.blocking.map((item) => [item.index, item.state]),
        [[3, 'notDownloaded']],
      );
      deq(
        asked.notes.map((item) => [item.index, item.state]),
        [[4, 'absent']],
      );
      assert.equal(vm.runInContext('quchongBatches.size', context), 0, 'nothing is queued before the user decides');

      const spliced = await handlers['library-dedup']({}, { dir, files: pick(1, 2), split, opts });
      assert.equal(spliced.success, true, spliced.error);
      assert.ok(!spliced.needsDecision, 'contiguous episodes need no decision');

      const platformOnly = await handlers['library-dedup'](
        {},
        { dir, files: pick(1, 2, 5), split, opts, gapPolicy: 'force' },
      );
      assert.equal(platformOnly.success, true, platformOnly.error);
      deq(
        platformOnly.notes.map((item) => [item.index, item.state, !!item.forced]),
        [
          [4, 'absent', false],
          [3, 'notDownloaded', true],
        ],
      );

      // 先补下载：下载完成后自动用完整的选择开始处理。
      vm.runInContext('LIBRARY_POLL_MS = 30', context);
      const downloaded = [];
      context.enqueueEpisodes = async ({ episodes }) => {
        downloaded.push(...episodes.map((episode) => episode.vid_index));
        const file = path.join(dir, '缺集剧_第003集.mp4');
        realEpisode(file);
        vm.runInContext(
          `downloadTasks.push({ status: 'completed', savePath: ${JSON.stringify(file)}, hongguoInfo: { vid: 'v3', series_id: '9', vid_index: 3 } })`,
          context,
        );
        return episodes.length;
      };
      context.hasCompleteTaskFile = (task) => task.status === 'completed';
      const waiting = await handlers['library-dedup'](
        {},
        { dir, files: pick(1, 2, 5), split, opts, gapPolicy: 'download' },
      );
      assert.equal(waiting.success, true, waiting.error);
      assert.equal(waiting.waitingForDownload, true);
      deq(downloaded, [3]);
      const deadline = Date.now() + 15000;
      while (
        Date.now() < deadline &&
        !events.some(([name, data]) => name === 'library-job-update' && data.status === 'started')
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      const last = events.filter(([name]) => name === 'library-job-update').pop()[1];
      assert.equal(last.status, 'started', last.message);
      const tasks = vm
        .runInContext('[...quchongBatches.values()].flatMap((b) => b.tasks)', context)
        .filter((item) => item.segments);
      const files = new Set(tasks.flatMap((item) => item.segments.map((segment) => path.basename(segment.src))));
      assert.ok(files.has('缺集剧_第003集.mp4'), 'the newly downloaded episode is part of the plan');
      const act = await handlers['library-activity']({}, dir);
      const text = act.logs.map((line) => line.text).join('\n');
      assert.match(text, /正在补下载/, 'waiting for the download is logged');
      assert.match(text, /开始规划重新拆分/);
      assert.match(text, /切点分析完成：将生成 \d+ 集/);
      assert.match(text, /已加入去重队列/);
      assert.equal(act.planning, null, 'planning is over once the batch is queued');
      assert.ok(files.has('缺集剧_第002集.mp4') && files.has('缺集剧_第005集.mp4'));
    });

    await check(
      'main: a running batch writes its progress and log to the series, and they survive re-reading',
      async () => {
        const root = path.join(tmp, 'run-log');
        const dir = path.join(root, '跑批剧');
        fs.mkdirSync(dir, { recursive: true });
        for (const n of [1, 2]) realEpisode(path.join(dir, `跑批剧_第00${n}集.mp4`));
        const { context, handlers, events } = makeMain(root, path.join(tmp, 'ud-run'), []);
        // 这个测试要真的跑：把测试夹具里停掉的队列泵换回真实的。
        context.pumpAllQuchongBatches = vm.runInContext(
          '(function () { for (const b of quchongBatches.values()) pumpQuchongBatch(b); })',
          context,
        );
        const started = await handlers['library-dedup'](
          {},
          {
            dir,
            mode: 'episode',
            files: [1, 2].map((n) => path.join(dir, `跑批剧_第00${n}集.mp4`)),
            opts: { speed_min: 1.03, speed_max: 1.2, black_intro: false, jobs: 2 },
          },
        );
        assert.equal(started.success, true, started.error);
        let act;
        const deadline = Date.now() + 60000;
        do {
          await new Promise((resolve) => setTimeout(resolve, 150));
          act = await handlers['library-activity']({}, dir);
        } while (Date.now() < deadline && act.batches[0].status !== 'completed' && act.batches[0].status !== 'failed');
        assert.equal(act.batches[0].status, 'completed', JSON.stringify(act.batches[0].tasks.map((t) => t.error)));
        assert.equal(act.batches[0].done, 2);
        const lines = act.logs.map((line) => line.text);
        assert.ok(lines.some((text) => /已加入去重队列：2 集/.test(text)));
        assert.ok(
          lines.some((text) => /跑批剧_第001集.mp4：开始处理/.test(text)),
          lines.join('\n'),
        );
        assert.ok(lines.some((text) => /开始编码/.test(text)));
        assert.ok(lines.filter((text) => /：完成，用时/.test(text)).length === 2);
        assert.ok(lines.some((text) => /这一批处理全部完成：成功 2 集/.test(text)));
        assert.ok(
          act.logs.every((line) => typeof line.t === 'number' && line.level),
          'every line has a time and level',
        );
        assert.ok(
          events.some(([name]) => name === 'library-activity'),
          'the page is told to refresh',
        );
        const ov = await handlers['library-overview']({});
        assert.equal(ov.items.find((item) => item.dir === dir).processing.state, 'completed');
        // 日志写盘后，换一个新的日志仓库（相当于重启应用）读到的还是同一份。
        vm.runInContext('libraryLog().flush()', context);
        const fresh = require('../src/native/library-activity').createActivityLog({
          file: path.join(tmp, 'ud-run', 'library-activity.json'),
        });
        assert.equal(fresh.list(dir).length, act.logs.length);
      },
    );

    await check('main: an imported folder asks once, then remembers episodes that were always missing', async () => {
      const root = path.join(tmp, 'gap2-dl');
      fs.mkdirSync(root, { recursive: true });
      const dir = path.join(tmp, 'gap2-imported', '外来缺集');
      fs.mkdirSync(dir, { recursive: true });
      for (const n of [1, 3]) realEpisode(path.join(dir, `外来缺集_第00${n}集.mp4`));
      const { handlers, context } = makeMain(root, path.join(tmp, 'ud-gap2'), []);
      context.libraryFolders().add(dir);
      const files = [1, 3].map((n) => path.join(dir, `外来缺集_第00${n}集.mp4`));
      const split = { min_len: 5, max_len: 12, head_trim: 0.5, tail_trim: 0.5 };
      const opts = { speed_min: 1.03, speed_max: 1.2, black_intro: false };
      const asked = await handlers['library-dedup']({}, { dir, files, split, opts });
      assert.equal(asked.needsDecision, true);
      assert.equal(asked.kind, 'unknown');
      deq(
        asked.blocking.map((item) => item.index),
        [2],
      );
      const noDownload = await handlers['library-dedup']({}, { dir, files, split, opts, gapPolicy: 'download' });
      assert.equal(noDownload.success, false);
      const confirmed = await handlers['library-dedup']({}, { dir, files, split, opts, gapPolicy: 'confirm' });
      assert.equal(confirmed.success, true, confirmed.error);
      const again = await handlers['library-dedup']({}, { dir, files, split, opts });
      assert.equal(again.success, true, 'remembered: no second question');
      deq(
        again.notes.map((item) => [item.index, item.state]),
        [[2, 'confirmed']],
      );
      const detail = await handlers['library-episodes']({}, dir);
      deq(
        detail.missing.map((item) => item.state),
        ['confirmed'],
      );
    });
  }

  if (failures) process.exitCode = 1;
})().finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
