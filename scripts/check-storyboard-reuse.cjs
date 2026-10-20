// 先做了剪映草稿、之后再要 AI 分镜工程图：直接用草稿当时的分镜，不重新分析、不再多做一份草稿。
// 成品重新做过、草稿被删、分轨方式不一样时才按老办法重新分析。不需要 ffmpeg、模型和方舟。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');

function makeMain(root, userData, storeExtra) {
  fs.mkdirSync(userData, { recursive: true });
  const file = path.resolve(__dirname, '../main.js'),
    req = createRequire(file),
    app = new EventEmitter();
  Object.assign(app, {
    getVersion: () => 'test',
    getPath: () => userData,
    commandLine: { appendSwitch() {} },
    whenReady: () => ({ then() {} }),
  });
  const electron = {
    app,
    ipcMain: { handle() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  const logs = [];
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
  context.sendToRenderer = () => {};
  context.pumpAllQuchongBatches = () => {};
  context.resolveFfmpeg = (name) => name;
  context.libraryReleaseTitle = (dir) => path.basename(dir);
  context.libraryDraftReadiness = async () => '';
  context.libLog = (_dir, level, text) => logs.push(`${level} ${text}`);
  return { context, logs };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-reuse-'));
  const dir = path.join(tmp, '剧');
  const file = path.join(dir, '去重', '新剧_第001集.mp4');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(4096, 1));
  const alignment = {
    shots: [
      { shot_id: 's1', start: 0, end: 2.4 },
      { shot_id: 's2', start: 2.4, end: 4 },
      { shot_id: 's3', start: 4, end: 6 },
    ],
  };
  const transcript = { cues: [{ start: 0.2, end: 1.9, text: '你来了' }] };

  const records = {};
  const { context, logs } = makeMain(path.join(tmp, 'root'), path.join(tmp, 'ud'), {
    getStructureProjects: () => records,
    removeStructureProject: (id) => delete records[id],
  });
  let cleanup = true;
  context.getCurrentSettings = () => ({
    structure_threads: 4,
    structure_cleanup: cleanup,
    ark_api_key: 'k',
    ark_video_model: 'm',
  });
  const projectId = context.libraryDraftProjectId(file);
  let pipelineStarts = 0;
  let draftsMade = 0;
  // 假的拆解流水线：在工作目录里写出分镜/台词结果和一份三分轨草稿。
  context.getReconstructionPipeline = () => ({
    start: async (payload) => {
      pipelineStarts += 1;
      const projectDir = path.join(tmp, 'work', payload.projectId);
      fs.mkdirSync(path.join(projectDir, 'modules'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'modules', 'alignment.json'), JSON.stringify(alignment));
      fs.writeFileSync(path.join(projectDir, 'modules', 'transcript.json'), JSON.stringify(transcript));
      fs.writeFileSync(
        path.join(projectDir, 'project.json'),
        JSON.stringify({ kind: 'video_structure', project_id: payload.projectId, source_sha256: 'sha-abc' }),
      );
      records[payload.projectId] = { manifestPath: path.join(projectDir, 'project.json') };
    },
    wait: async (id) => {
      draftsMade += 1;
      const projectDir = path.join(tmp, 'work', id);
      const draftPath = path.join(tmp, 'drafts', `草稿-${draftsMade}`);
      fs.mkdirSync(draftPath, { recursive: true });
      fs.writeFileSync(
        path.join(draftPath, 'draft-manifest.json'),
        JSON.stringify({ schema: 'jianying-draft/simple-v2' }),
      );
      const modules = Object.fromEntries(
        ['media', 'audio', 'shots', 'clips', 'separation', 'transcript', 'alignment', 'export', 'jianying'].map((m) => [
          m,
          { status: 'succeeded', result_path: `modules/${m}.json`, summary: { draft_path: draftPath } },
        ]),
      );
      return { status: 'completed', modules, projectDir, manifestPath: path.join(projectDir, 'project.json') };
    },
    cancel() {},
    isActive: () => false,
  });
  const promptCalls = [];
  context.deriveLibraryPrompts = async (_job, _file, _item, data) => promptCalls.push(data);

  async function draft({ prompts, mode = 'simple' }) {
    const started = await context.startLibraryDrafts({ dir, files: [file], mode, scope: { numbers: [1] }, prompts });
    assert.equal(started.success, true, JSON.stringify(started));
    const jobs = vm.runInContext('libraryDraftJobs', context);
    const deadline = Date.now() + 10000;
    while (jobs.get(path.resolve(dir)).status === 'running' && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const job = jobs.get(path.resolve(dir));
    assert.equal(job.status, 'completed', JSON.stringify([job.status, logs.slice(-4)]));
    return job;
  }

  // 1. 先只做草稿：分析一次、出一份草稿，并把分镜/台词留底；分析中间文件照常清掉。
  await draft({ prompts: false });
  assert.equal(pipelineStarts, 1);
  assert.equal(draftsMade, 1);
  assert.equal(promptCalls.length, 0);
  const savedFile = path.join(tmp, 'ud', 'structure-results', `${projectId}.json`);
  assert.ok(fs.existsSync(savedFile), 'shot results are kept after the draft is made');
  assert.equal(records[projectId], undefined, 'the big analysis folder is still cleaned up');
  console.log('PASS draft only: analysed once, results kept, work folder cleaned');

  // 2. 之后补做分镜工程图：不重新分析、不再做草稿，用的就是草稿当时的分镜和台词。
  await draft({ prompts: true });
  assert.equal(pipelineStarts, 1, 'no new analysis');
  assert.equal(draftsMade, 1, 'no second draft');
  assert.equal(promptCalls.length, 1);
  assert.equal(JSON.stringify(promptCalls[0].alignment), JSON.stringify(alignment));
  assert.equal(JSON.stringify(promptCalls[0].transcript), JSON.stringify(transcript));
  assert.equal(promptCalls[0].sourceKey, 'sha-abc', 'the prompt cache key is the same as before');
  assert.ok(logs.some((line) => /沿用它的 3 个分镜，只补做分镜工程图/.test(line)));
  console.log('PASS storyboard later: reuses the draft shots, no re-analysis, no second draft');

  // 3. 成品重新做过（文件变了）：按老办法重新分析。
  fs.writeFileSync(file, Buffer.alloc(5000, 2));
  await draft({ prompts: true });
  assert.equal(pipelineStarts, 2, 'a changed episode is analysed again');
  console.log('PASS changed episode: analysed again');

  // 4. 草稿被删了：重新分析，重新出草稿。
  await draft({ prompts: true });
  assert.equal(pipelineStarts, 2, 'the fresh results are reused');
  fs.rmSync(path.join(tmp, 'drafts'), { recursive: true, force: true });
  await draft({ prompts: true });
  assert.equal(pipelineStarts, 3, 'a deleted draft means analysing again');
  console.log('PASS deleted draft: analysed again');

  // 5. 分轨方式不一样（要多分轨，留底的是三分轨）：不沿用。
  const before = pipelineStarts;
  await draft({ prompts: true, mode: 'multi' });
  assert.ok(pipelineStarts > before, 'a different track layout is not reused');
  console.log('PASS different track layout: not reused');

  // 6. 留底文件坏了：当作没有，按老办法做，不报错。
  fs.writeFileSync(savedFile, '{broken');
  const beforeBroken = pipelineStarts;
  await draft({ prompts: true });
  assert.ok(pipelineStarts > beforeBroken, 'broken saved results are ignored');
  console.log('PASS broken saved results: falls back quietly');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
