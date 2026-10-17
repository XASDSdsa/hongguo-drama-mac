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

      const asked = await handlers['library-dedup']({}, { dir, files: pick(2, 5), split, opts });
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
        { dir, files: pick(2, 5), split, opts, gapPolicy: 'force' },
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
        { dir, files: pick(2, 5), split, opts, gapPolicy: 'download' },
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
      assert.ok(files.has('缺集剧_第002集.mp4') && files.has('缺集剧_第005集.mp4'));
    });

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
