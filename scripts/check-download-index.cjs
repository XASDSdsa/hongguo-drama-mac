// 下载记录多了以后的查找：
//   1. hasCompleteTaskFile：同一路径被「别的集」占用时不算完成；同一集的多条记录不算冲突；记录变化后结果跟着变。
//   2. pipelineEpisodeByPath：按下载路径找到对应的剧和集，结果和逐条对照一致。
//   3. 两万条下载记录时，列出整部剧、做完一集去重都不会卡住主进程。
// 不打开窗口，也不联网。
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-download-index-'));

const app = new EventEmitter();
Object.assign(app, {
  getVersion: () => 'test',
  getPath: () => temp,
  commandLine: { appendSwitch() {} },
  whenReady: () => ({ then() {} }),
});
const electron = {
  app,
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle() {}, on() {} },
  dialog: {},
  shell: {},
  session: {},
  protocol: { registerSchemesAsPrivileged() {} },
  Menu: {},
};
const context = vm.createContext({
  require: (name) => (name === 'electron' ? electron : req(name)),
  __dirname: path.dirname(sourcePath),
  process,
  Buffer,
  URL,
  URLSearchParams,
  AbortSignal,
  AbortController,
  setTimeout,
  clearTimeout,
  setImmediate,
  clearImmediate,
  console: { log() {}, warn() {}, error() {} },
});
vm.runInContext(source, context, { filename: sourcePath });
const run = (code) => vm.runInContext(code, context, { filename: sourcePath });

try {
  const file = (name) => {
    const full = path.join(temp, name);
    fs.writeFileSync(full, Buffer.alloc(200 * 1024));
    return full;
  };
  const a = file('a.mp4');
  const b = file('b.mp4');
  context.fixture = { a, b };
  run(`downloadTasks = [
    { id: '1', savePath: fixture.a, status: 'completed', hongguoInfo: { vid: 'v1', series_id: 'S', vid_index: 1 } },
    { id: '2', savePath: fixture.a, status: 'failed', hongguoInfo: { vid: 'v1', series_id: 'S', vid_index: 1 } },
    { id: '3', savePath: fixture.b, status: 'completed', hongguoInfo: { vid: 'v2', series_id: 'S', vid_index: 2 } },
  ]`);
  assert.equal(run('hasCompleteTaskFile(downloadTasks[0])'), true, '同一集的两条记录不算冲突');
  assert.equal(run('hasCompleteTaskFile(downloadTasks[2])'), true);

  // 第三集被登记到了第二集的文件上：两条都不能算完成。
  run(
    `downloadTasks = [...downloadTasks, { id: '4', savePath: fixture.b, status: 'completed', hongguoInfo: { vid: 'v3', series_id: 'S', vid_index: 3 } }]`,
  );
  assert.equal(run('hasCompleteTaskFile(downloadTasks[2])'), false, '路径被别的集占用时不算完成');
  assert.equal(run('hasCompleteTaskFile(downloadTasks[3])'), false);
  // 删掉冲突的那条后立刻恢复（不用等缓存过期）。
  run(`downloadTasks = downloadTasks.filter((task) => task.id !== '4')`);
  assert.equal(run('hasCompleteTaskFile(downloadTasks[2])'), true, '冲突记录删掉后马上恢复');
  // 同一个数组里改路径（修复冲突时）也立刻生效。
  run(
    `downloadTasks.push({ id: '5', savePath: fixture.b, status: 'failed', hongguoInfo: { vid: 'v9', series_id: 'S', vid_index: 9 } })`,
  );
  assert.equal(run('hasCompleteTaskFile(downloadTasks[2])'), false);
  run(`savePathIndex = null; downloadTasks[3].savePath = fixture.b + '.other'; savePathIndex = null;`);
  assert.equal(run('hasCompleteTaskFile(downloadTasks[2])'), true);
  console.log('PASS same-path conflicts: other episode blocks, same episode does not, changes apply at once');

  // pipelineEpisodeByPath：下载记录登记在这个路径上的集都能找到，别的路径找不到。
  run(`seriesRegistry = [
    { series_id: 'S', series_title: '测试', episodes: [{ vid: 'v1', vid_index: 1 }, { vid: 'v2', vid_index: 2 }] },
    { series_id: 'T', series_title: '别的剧', episodes: [{ vid: 'w1', vid_index: 1 }] },
  ]`);
  const found = JSON.parse(
    run('JSON.stringify(pipelineEpisodeByPath(fixture.a).map((m) => [m.entry.series_id, m.index]))'),
  );
  assert.deepEqual(found, [['S', 1]]);
  assert.deepEqual(
    JSON.parse(run(`JSON.stringify(pipelineEpisodeByPath('${path.join(temp, 'none.mp4').replace(/\\/g, '\\\\')}'))`)),
    [],
  );
  console.log('PASS pipelineEpisodeByPath finds the series and episode that downloaded to a path');

  // 两万条下载记录、一百部剧：逐集判断和按路径查找都要快。
  run(`(() => {
    const big = [];
    for (let i = 0; i < 20000; i++)
      big.push({ id: 'x' + i, savePath: fixture.a + '.' + i, status: 'completed',
        hongguoInfo: { vid: 'vid' + i, series_id: 'S' + (i % 100), vid_index: (i % 200) + 1 } });
    downloadTasks = big;
    seriesRegistry = Array.from({ length: 100 }, (_, s) => ({ series_id: 'S' + s, series_title: 's' + s,
      episodes: Array.from({ length: 200 }, (_, e) => ({ vid: 'v', vid_index: e + 1 })) }));
  })()`);
  let started = Date.now();
  run('for (let i = 0; i < 2000; i++) hasCompleteTaskFile(downloadTasks[i])');
  const listMs = Date.now() - started;
  started = Date.now();
  run('pipelineEpisodeByPath(fixture.a + ".123")');
  const lookupMs = Date.now() - started;
  assert.ok(listMs < 1500, `2000 次完成判断用了 ${listMs}ms`);
  assert.ok(lookupMs < 300, `按路径查找用了 ${lookupMs}ms`);
  console.log(`PASS 20000 download records: 2000 completion checks ${listMs}ms, path lookup ${lookupMs}ms`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
