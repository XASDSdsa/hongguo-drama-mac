// 剧文件夹里的封面/简介保存规则，以及同名不同来源剧的文件夹命名，无需网络。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');
const info = require('../src/native/series-info');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'series-info-'));
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 2)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(2000, 3)]);
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
  await check('image type is detected from file header, not from URL', () => {
    assert.equal(info.sniffImageExtension(jpeg), '.jpg');
    assert.equal(info.sniffImageExtension(png), '.png');
    assert.equal(info.sniffImageExtension(webp), '.webp');
    assert.equal(info.sniffImageExtension(Buffer.from('<html>error page</html>')), '');
    assert.equal(info.sniffImageExtension(null), '');
  });

  await check('cover and synopsis are written into the series folder', async () => {
    const dir = path.join(tmp, 'a', '剧A');
    const result = await info.saveSeriesInfo({
      dir,
      cover: 'https://x.invalid/c.webp',
      synopsis: '<p>一个很长的故事简介，讲述主角的经历。</p>',
      fetchImage: async () => webp,
    });
    assert.deepEqual(result, { cover: 'saved', synopsis: 'saved' });
    assert.ok(fs.existsSync(path.join(dir, '封面.webp')));
    assert.equal(fs.readFileSync(path.join(dir, '简介.txt'), 'utf8'), '一个很长的故事简介，讲述主角的经历。\n');
    assert.equal(info.readSynopsis(dir), '一个很长的故事简介，讲述主角的经历。');
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['封面.webp', '简介.txt'],
      'no temporary files are left in the folder',
    );
  });

  await check('existing files are never overwritten', async () => {
    const dir = path.join(tmp, 'b');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '封面.png'), png);
    fs.writeFileSync(path.join(dir, '简介.txt'), '我自己改过的简介');
    let fetched = 0;
    const result = await info.saveSeriesInfo({
      dir,
      cover: 'https://x.invalid/c.jpg',
      synopsis: '平台上的简介内容比较长一些',
      fetchImage: async () => (fetched++, jpeg),
    });
    assert.deepEqual(result, { cover: 'exists', synopsis: 'exists' });
    assert.equal(fetched, 0, 'does not even download when a cover already exists');
    assert.equal(fs.readFileSync(path.join(dir, '简介.txt'), 'utf8'), '我自己改过的简介');
    assert.ok(!fs.existsSync(path.join(dir, '封面.jpg')));
  });

  await check('a cover the user adds during the download is kept', async () => {
    const dir = path.join(tmp, 'c');
    const result = await info.saveSeriesInfo({
      dir,
      cover: 'https://x.invalid/c.jpg',
      synopsis: '',
      fetchImage: async () => {
        fs.writeFileSync(path.join(dir, '封面.png'), png);
        return jpeg;
      },
    });
    assert.equal(result.cover, 'exists');
    assert.ok(!fs.existsSync(path.join(dir, '封面.jpg')));
  });

  await check('bad or missing data writes nothing and never throws', async () => {
    const dir = path.join(tmp, 'd');
    const html = await info.saveSeriesInfo({
      dir,
      cover: 'https://x.invalid/c.jpg',
      synopsis: '',
      fetchImage: async () => Buffer.from('<html>' + 'x'.repeat(2000)),
    });
    assert.deepEqual(html, { cover: 'failed', synopsis: 'none' });
    const broken = await info.saveSeriesInfo({
      dir,
      cover: 'https://x.invalid/c.jpg',
      synopsis: '短',
      fetchImage: async () => {
        throw new Error('network');
      },
    });
    assert.deepEqual(broken, { cover: 'failed', synopsis: 'none' });
    const noUrl = await info.saveSeriesInfo({ dir, cover: '', synopsis: '', fetchImage: async () => jpeg });
    assert.deepEqual(noUrl, { cover: 'none', synopsis: 'none' });
    const tiny = await info.saveSeriesInfo({
      dir,
      cover: 'https://x.invalid/c.jpg',
      synopsis: '',
      fetchImage: async () => jpeg.subarray(0, 100),
    });
    assert.equal(tiny.cover, 'failed');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  await check('same-title series from different sources get separate folders', () => {
    const owners = new Map([['同名剧', '123']]);
    assert.equal(info.pickFolderName({ title: '同名剧', seriesId: '123', owners }), '同名剧');
    assert.equal(info.pickFolderName({ title: '同名剧', seriesId: 'hema:9', owners }), '同名剧（河马）');
    assert.equal(info.pickFolderName({ title: '同名剧', seriesId: 'xifan:9', owners }), '同名剧（西饭）');
    owners.set('同名剧（河马）', 'hema:9');
    assert.equal(info.pickFolderName({ title: '同名剧', seriesId: 'hema:777777', owners }), '同名剧（河马-777777）');
    assert.equal(info.pickFolderName({ title: '新剧', seriesId: '5', owners: new Map() }), '新剧');
    const upper = new Map([['abc', '1']]);
    assert.equal(info.pickFolderName({ title: 'ABC', seriesId: '2', owners: upper }), 'ABC（红果）');
  });

  await check('main: folder is remembered per series and survives a title change', async () => {
    const root = path.join(tmp, 'dl');
    fs.mkdirSync(root, { recursive: true });
    const file = path.resolve(__dirname, '../main.js'),
      req = createRequire(file),
      app = new EventEmitter();
    Object.assign(app, {
      getVersion: () => 'test',
      getPath: () => tmp,
      commandLine: { appendSwitch() {} },
      whenReady: () => ({ then() {} }),
    });
    const electron = {
      app,
      ipcMain: { handle() {} },
      protocol: { registerSchemesAsPrivileged() {} },
    };
    const context = vm.createContext({
      require: (n) =>
        n === 'electron'
          ? electron
          : n === './src/store'
            ? { getSettings: () => ({ root }), saveTasks() {}, saveSeries() {} }
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
      console: { log() {}, warn() {}, error() {} },
    });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    vm.runInContext(
      `seriesRegistry=[{series_id:'1',series_title:'同名剧',episodes:[]},{series_id:'hema:2',series_title:'同名剧',episodes:[]}]`,
      context,
    );
    const first = context.seriesFolder('同名剧', '1');
    assert.equal(first, path.join(root, '同名剧'));
    context.rememberSeriesFolder('1', first);
    assert.equal(context.seriesFolder('同名剧', 'hema:2'), path.join(root, '同名剧（河马）'));
    context.rememberSeriesFolder('hema:2', context.seriesFolder('同名剧', 'hema:2'));
    assert.equal(context.seriesFolder('改名后的剧', '1'), first, 'a renamed series keeps its folder');
    assert.equal(context.seriesFolder('只有标题'), path.join(root, '只有标题'), 'no id: plain title folder');
    assert.equal(context.claimedSeriesFolder('999'), null);
  });

  if (failures) process.exitCode = 1;
})().finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
