// 先做了剪映草稿、之后再要 AI 分镜工程图：直接用草稿当时的分镜，不重新分析、不再多做一份草稿。
// 成品重新做过、草稿被删、分轨方式不一样时才按老办法重新分析。不需要 ffmpeg、模型和方舟。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { createRequire } = require('node:module');

function makeMain(root, userData, storeExtra, modules = {}) {
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
          : modules[n] || req(n),
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
  // 只把真正去调方舟的那一步换成假的；软件里组织这一步的代码（deriveLibraryPrompts）照常跑，
  // 以前这里整个换掉了，结果它里面调用了一个不存在的函数也没测出来。
  const promptCalls = [];
  let promptGate = null;
  let promptFatal = '';
  const { context, logs } = makeMain(
    path.join(tmp, 'root'),
    path.join(tmp, 'ud'),
    {
      getStructureProjects: () => records,
      removeStructureProject: (id) => delete records[id],
    },
    {
      './src/native/video-prompt/derive': {
        deriveEpisodePrompts: async (args) => {
          promptCalls.push(args);
          if (promptFatal) throw Object.assign(new Error(promptFatal), { fatal: true });
          if (promptGate) await promptGate.promise;
          return { segments: 3, failed: 0, file: path.join(args.outDir, 'x.json') };
        },
      },
    },
  );
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
  assert.equal(promptCalls[0].ffmpeg, 'ffmpeg', 'the bundled ffmpeg is passed in');
  assert.equal(promptCalls[0].inputPath, file);
  assert.equal(promptCalls[0].model, 'm');
  assert.ok(promptCalls[0].client, 'an Ark client is made');
  assert.ok(!logs.some((line) => /视频提示词.*没有生成/.test(line)), logs.filter((l) => /视频提示词/.test(l)).join('\n'));
  assert.ok(logs.some((line) => /视频提示词：.*已生成/.test(line)), 'the storyboard step reports success');
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

  // 7. 分镜工程图在后台等方舟时，同一路马上接着做下一集的草稿；整个任务等分镜工程图做完才结束。
  const dir2 = path.join(tmp, '剧二');
  const files2 = [1, 2].map((n) => path.join(dir2, '去重', `剧二_第00${n}集.mp4`));
  for (const f of files2) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(3000 + files2.indexOf(f), 3));
  }
  context.draftLanesAllowed = () => 1; // 一次只做一集，看第二集会不会被第一集的分镜工程图挡住
  let release;
  promptGate = { promise: new Promise((resolve) => (release = resolve)) };
  const callsBefore = promptCalls.length;
  const startsBefore = pipelineStarts;
  const started2 = await context.startLibraryDrafts({ dir: dir2, files: files2, mode: 'simple', scope: { numbers: [1, 2] }, prompts: true });
  assert.equal(started2.success, true, JSON.stringify(started2));
  const job2 = vm.runInContext('libraryDraftJobs', context).get(path.resolve(dir2));
  const until = async (check, what) => {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check(), what);
  };
  // done 先加一，清理完分析中间文件才从「正在做」里移走：两样都到位再看界面文字。
  await until(() => job2.done === 2 && job2.active.size === 0, 'both drafts are made while the storyboards still wait for Ark');
  assert.equal(pipelineStarts - startsBefore, 2);
  assert.equal(job2.status, 'running', 'the job is not finished while storyboards are still being made');
  assert.match(context.libraryDraftSnapshot(job2).message, /分镜工程图还剩 \d 集/);
  assert.ok(promptCalls.length - callsBefore >= 1);
  release();
  promptGate = null;
  await until(() => job2.status !== 'running', 'the job ends after the storyboards');
  assert.equal(job2.status, 'completed');
  assert.equal(promptCalls.length - callsBefore, 2, 'both episodes got a storyboard');
  console.log('PASS storyboards run in the background: the next draft does not wait for Ark, the job waits for them');

  // 8. 方舟账号额度用完（安全体验模式）：这一集写明原因，排着的其他集不再去问方舟，一条日志说清楚。
  const dir3 = path.join(tmp, '剧三');
  const files3 = [1, 2, 3].map((n) => path.join(dir3, '去重', `剧三_第00${n}集.mp4`));
  files3.forEach((f, i) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(4000 + i, 4));
  });
  promptFatal = '方舟账号这个模型的用量到了设定上限（「安全体验模式」）';
  const callsBefore3 = promptCalls.length;
  const started3 = await context.startLibraryDrafts({ dir: dir3, files: files3, mode: 'simple', scope: { numbers: [1, 2, 3] }, prompts: true });
  assert.equal(started3.success, true, JSON.stringify(started3));
  const job3 = vm.runInContext('libraryDraftJobs', context).get(path.resolve(dir3));
  await until(() => job3.status !== 'running', 'the job ends');
  assert.equal(job3.status, 'completed', 'the drafts themselves are fine');
  assert.equal(job3.done, 3);
  assert.equal(promptCalls.length - callsBefore3, 1, 'only the first episode asked Ark');
  assert.ok(logs.some((line) => /视频提示词：.*没有生成：方舟账号这个模型的用量到了设定上限/.test(line)));
  assert.ok(
    logs.some((line) => /视频提示词：剩下 2 集（剧三_第002集、剧三_第003集）没有做：方舟账号这个模型的用量到了设定上限/.test(line)),
    logs.filter((line) => /视频提示词/.test(line)).slice(-4).join('\n'),
  );
  promptFatal = '';
  console.log('PASS account problem (usage limit): the other episodes skip Ark with one clear log line');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
