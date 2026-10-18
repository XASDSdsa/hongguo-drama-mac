// 剪映草稿同时做几集：并行数、线程分配、电脑忙时少开一路，不需要 ffmpeg 和模型。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');

function makeMain(root, userData, registry, storeExtra = {}) {
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
          ? { getSettings: () => ({ root }), saveTasks() {}, saveSeries() {}, saveSettings() {}, ...storeExtra }
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
  // 成品用「AI 发布素材」里选定的新剧名命名；测试里直接当作已选定（剧名 = 文件夹名）。
  context.libraryReleaseTitle = (dir) => path.basename(dir);
  return { context, handlers, events };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-lanes-'));
  const dir = path.join(tmp, '剧');
  const files = [1, 2, 3, 4].map((n) => {
    const file = path.join(dir, '去重', `新剧_第${String(n).padStart(3, '0')}集.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
    return file;
  });

  async function run({ lanes, allowedAfter, expectPeak, cleanup = true, failOn = null }) {
    const records = {};
    const { context } = makeMain(path.join(tmp, 'root'), path.join(tmp, 'ud'), [], {
      getStructureProjects: () => records,
      removeStructureProject: (id) => delete records[id],
    });
    const workDirs = files.map((file) => {
      const id = context.libraryDraftProjectId(file);
      const projectDir = path.join(tmp, 'work-' + lanes + '-' + String(cleanup) + '-' + id);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'project.json'),
        JSON.stringify({ kind: 'video_structure', project_id: id }),
      );
      records[id] = { manifestPath: path.join(projectDir, 'project.json') };
      return projectDir;
    });
    let live = 0,
      peak = 0;
    const threads = [];
    context.getCurrentSettings = () => ({ structure_threads: 8, structure_cleanup: cleanup });
    context.libraryDraftReadiness = async () => '';
    let allowed = lanes;
    context.draftLanesAllowed = () => allowed;
    const slow = () => new Promise((resolve) => setTimeout(resolve, 120));
    context.getReconstructionPipeline = () => ({
      start: async (payload) => {
        if (payload.threads) threads.push(payload.threads);
        live += 1;
        peak = Math.max(peak, live);
        if (allowedAfter != null && live >= 2) allowed = allowedAfter;
      },
      wait: async (projectId) => {
        await slow();
        live -= 1;
        const done = Object.fromEntries(
          ['media', 'audio', 'shots', 'clips', 'separation', 'transcript', 'alignment', 'export', 'jianying'].map(
            (id) => [id, { status: 'succeeded', summary: { draft_path: path.join(tmp, 'draft', projectId) } }],
          ),
        );
        return { status: 'completed', modules: done };
      },
      cancel() {},
      isActive: () => false,
    });
    const started = await context.startLibraryDrafts({
      dir,
      files,
      mode: 'simple',
      scope: { numbers: [1, 2, 3, 4] },
    });
    assert.equal(started.success, true, JSON.stringify(started));
    const deadline = Date.now() + 15000;
    while (
      vm.runInContext('libraryDraftJobs', context).get(path.resolve(dir)).status === 'running' &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const job = vm.runInContext('libraryDraftJobs', context).get(path.resolve(dir));
    assert.equal(job.status, 'completed', JSON.stringify([job.status, job.done, job.failed]));
    assert.equal(job.done, 4);
    return { peak, threads, job, workDirs };
  }

  const one = await run({ lanes: 1 });
  assert.equal(one.peak, 1, 'one episode at a time by default');
  console.log('PASS one lane');

  const three = await run({ lanes: 3 });
  assert.ok(three.peak >= 2 && three.peak <= 3, `up to three at once, saw ${three.peak}`);
  assert.ok(
    three.threads.every((n) => n === 2),
    'the 8-thread budget is shared: 2 each for 3 lanes',
  );
  console.log('PASS three lanes share the thread budget');

  // ---- 清理分析中间文件：只删确认是拆解项目的文件夹，成品和草稿不动 ----
  {
    const records = {};
    const { context } = makeMain(path.join(tmp, 'root'), path.join(tmp, 'ud2'), [], {
      getStructureProjects: () => records,
      removeStructureProject: (id) => delete records[id],
    });
    context.getReconstructionPipeline = () => ({ isActive: (id) => id === context.__active });
    const work = path.join(tmp, 'work');
    const make = (file, manifest) => {
      const id = context.libraryDraftProjectId(file);
      const projectDir = path.join(work, id);
      fs.mkdirSync(path.join(projectDir, 'clips'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'clips', 'a.mp4'), Buffer.alloc(4096, 2));
      if (manifest !== null)
        fs.writeFileSync(
          path.join(projectDir, 'project.json'),
          JSON.stringify(manifest || { kind: 'video_structure', project_id: id }),
        );
      records[id] = { manifestPath: path.join(projectDir, 'project.json') };
      return { id, projectDir };
    };
    const ok = make(files[0]);
    const foreign = make(files[1], { kind: 'something_else', project_id: 'x' });
    const wrongId = make(files[2], { kind: 'video_structure', project_id: 'other' });
    const active = make(files[3]);
    context.__active = active.id;
    const gone = path.join(tmp, 'gone', '新剧_第009集.mp4');
    const goneId = context.libraryDraftProjectId(gone);
    records[goneId] = { manifestPath: path.join(tmp, 'gone-dir', 'project.json') };
    const draft = path.join(dir, '剪映草稿', 'x', 'draft_content.json');
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, '{}');

    const result = await context.cleanupStructureProjects([...files, gone]);
    assert.equal(result.count, 1, 'only the confirmed, idle project is removed');
    assert.ok(result.freed >= 4096);
    assert.equal(fs.existsSync(ok.projectDir), false, 'finished project work is removed');
    assert.equal(records[ok.id], undefined);
    assert.equal(fs.existsSync(foreign.projectDir), true, 'a folder that is not a structure project is kept');
    assert.equal(fs.existsSync(wrongId.projectDir), true, 'a mismatched project id is kept');
    assert.equal(fs.existsSync(active.projectDir), true, 'a running project is kept');
    assert.equal(records[goneId], undefined, 'a record whose folder is already gone is dropped');
    for (const file of files) assert.equal(fs.existsSync(file), true, 'finished videos are never touched');
    assert.equal(fs.existsSync(draft), true, 'drafts are never touched');
    console.log('PASS cleanup removes only idle structure work');
  }

  const kept = await run({ lanes: 1, cleanup: false });
  assert.ok(
    kept.workDirs.every((d) => fs.existsSync(d)),
    'cleanup off keeps the work folders',
  );
  const cleaned = await run({ lanes: 1, cleanup: true });
  assert.ok(
    cleaned.workDirs.every((d) => !fs.existsSync(d)),
    'cleanup on removes each finished episode work folder',
  );
  for (const file of files) assert.equal(fs.existsSync(file), true);
  console.log('PASS cleanup follows the setting after each finished draft');

  const busy = await run({ lanes: 3, allowedAfter: 1 });
  assert.equal(busy.job.done, 4, 'every episode is still made when the extra lanes step aside');
  console.log('PASS extra lanes step aside when the computer is busy');
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
