// 「管理剧集」：按文件夹里实际存在的视频认集、导入已有剧、把选中的集交给去重队列，无需网络和 ffmpeg。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');
const lib = require('../src/native/series-library');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'series-lib-'));
const touch = (file, size = 2048) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
};
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
        files: [path.join(series.path, '同名剧_第002集.mp4')],
      },
    );
    assert.equal(started.success, true, started.error);
    const [task] = vm.runInContext('[...quchongBatches.values()].flatMap((b) => b.tasks)', context);
    assert.equal(task.dst, path.join(series.path, '去重', '同名剧_第002集_去重.mp4'));
    assert.ok(fs.existsSync(path.join(series.path, '去重')) || true);

    await handlers['library-remove-import']({}, path.join(tmp, 'imported', '外来剧'));
    assert.equal(
      (await handlers['library-list']({})).folders.some((item) => item.name === '外来剧'),
      false,
    );
    assert.ok(fs.existsSync(path.join(tmp, 'imported', '外来剧', '外来剧_第001集.mp4')));
  });

  if (failures) process.exitCode = 1;
})().finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
