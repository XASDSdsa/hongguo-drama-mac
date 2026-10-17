'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { VERSION, MODULES, fingerprint, descendants, requireThat } = require('./contracts');
const { json, atomicJson, sha256 } = require('./io');
const runtimeTools = require('./runtime');
const mediaTools = require('./media');
const { shots } = require('./shots');
const { clips } = require('./clips');
const speech = require('./speech');
const { alignment, exportsModule } = require('./alignment');

// Shared implementation files affect every stage. Keep them in each cache
// identity so changes to contracts, atomic I/O, or runtime resolution cannot
// accidentally reuse an old result.
const SHARED_IMPLEMENTATIONS = ['contracts.js', 'io.js', 'runtime.js'];
const MODULE_IMPLEMENTATIONS = {
  media: ['media.js'],
  audio: ['media.js'],
  shots: ['shots.js'],
  clips: ['clips.js'],
  separation: ['speech.js'],
  transcript: ['speech.js'],
  alignment: ['alignment.js'],
  export: ['alignment.js'],
  jianying: ['jianying.js'],
};
function implementationFilesFor(moduleId) {
  const files = [...SHARED_IMPLEMENTATIONS, ...(MODULE_IMPLEMENTATIONS[moduleId] || [])];
  return [...new Set(files)].map((file) => path.join(__dirname, file));
}

const HANDLERS = {
  media: (ctx) => mediaTools.media(ctx),
  audio: (ctx, deps) => mediaTools.audio(ctx, deps.media.data),
  shots: (ctx, deps) => shots(ctx, deps.media.data),
  clips: (ctx, deps) => clips(ctx, deps.media.data, deps.alignment.data),
  separation: (ctx, deps) => speech.separation(ctx, deps.audio.data, deps.audio.dir),
  transcript: (ctx, deps) => speech.transcript(ctx, deps.separation.data, deps.media.data, deps.separation.dir),
  alignment: (ctx, deps) => alignment(ctx, deps.shots.data, deps.transcript.data),
  export: (ctx, deps) =>
    exportsModule(ctx, deps.alignment.data, deps.clips.data, deps.transcript.data, deps.clips.dir, deps.transcript.dir),
};
function safeName(text) {
  return (
    String(text)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 70) || 'episode'
  );
}
function brief(data) {
  const reviewItems = Array.isArray(data.review_items) ? data.review_items : [];
  const warnings = data.warnings ?? data.unmatched_utterance_ids;
  return {
    duration: data.duration,
    frame_count: data.frame_count,
    frame_rate_type: data.frame_rate_type,
    has_audio: data.has_audio,
    shot_count: data.shots?.length ?? data.clips?.length ?? data.shot_count,
    utterance_count: data.utterances?.length ?? data.utterance_count,
    association_count: data.associations?.length,
    raw_shot_count: data.raw_shot_count,
    merged_boundary_count: data.merged_boundary_count,
    longest_shot_seconds: data.statistics?.longest_shot_seconds,
    relaxed_cut_count: data.statistics?.relaxed_cut_count,
    over_limit_shot_count: data.statistics?.over_limit_shot_ids?.length,
    warning_count: Math.max(warnings?.length ?? 0, reviewItems.length),
    needs_review: data.needs_review === true || reviewItems.length > 0,
    review_items: reviewItems,
  };
}
async function filesIn(dir) {
  const output = [];
  for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) output.push(...(await filesIn(file)));
    else if (item.isFile()) output.push(file);
  }
  return output;
}
function createVideoStructurePipeline({
  getSettings,
  getFfmpegPath,
  getFfprobePath,
  getProjectRecord,
  saveProjectRecord,
  sendProgress,
  createDraft,
  handlers = HANDLERS,
}) {
  const modules = createDraft
    ? [...MODULES, { id: 'jianying', label: '生成剪映草稿', deps: MODULES.map((m) => m.id), file: 'jianying.json' }]
    : MODULES;
  const moduleHandlers = { ...handlers, ...(createDraft ? { jianying: createDraft } : {}) };
  const jobs = new Map();
  const starting = new Set();
  let queue = Promise.resolve();
  function snapshot(job) {
    return {
      success: true,
      projectId: job.projectId,
      status: job.state.status,
      stage: job.state.active_module,
      error: job.state.error || null,
      manifestPath: job.manifestPath,
      projectDir: job.dir,
      inputPath: job.input,
      modules: job.state.modules,
      updatedAt: job.state.updated_at,
    };
  }
  function emit(job) {
    try {
      sendProgress?.(snapshot(job));
    } catch {}
  }
  async function save(job) {
    job.state.updated_at = new Date().toISOString();
    await atomicJson(job.manifestPath, job.state);
    emit(job);
  }
  async function status(projectId) {
    const id = String(projectId || '');
    if (jobs.has(id)) return snapshot(jobs.get(id));
    const record = getProjectRecord?.(id);
    if (record?.manifestPath) {
      const state = await json(record.manifestPath);
      requireThat(
        state.schema_version === VERSION && state.kind === 'video_structure',
        '项目格式不是当前结构化拆解格式',
      );
      if (['queued', 'running', 'stopping'].includes(state.status)) {
        state.status = 'interrupted';
        for (const stage of Object.values(state.modules))
          if (stage.status === 'running') {
            stage.status = 'interrupted';
            stage.message = '应用上次退出时任务未完成';
          }
      }
      const job = {
        projectId: id,
        state,
        manifestPath: record.manifestPath,
        dir: path.dirname(record.manifestPath),
        input: state.input_path,
      };
      return snapshot(job);
    }
    return { success: true, projectId: id, status: 'idle', modules: {} };
  }
  function invalidate(job, id, reason) {
    for (const key of [
      ...new Set([id, ...descendants(id), ...(createDraft || job.state.modules.jianying ? ['jianying'] : [])]),
    ]) {
      const current = job.state.modules[key];
      job.state.modules[key] = {
        ...current,
        status: current?.run_id ? 'stale' : 'idle',
        message: current?.run_id ? reason : '',
        error: null,
        reused: false,
        progress: null,
        output_dir: null,
        result_path: null,
        summary: null,
        needs_review: false,
        review_status: null,
        review_items: [],
        output_files: [],
        result_fingerprint: null,
      };
    }
  }
  async function inputKey(job, spec) {
    const params = runtimeTools.params(spec.id, job.settings, job.runtime);
    const model = await runtimeTools.identity(spec.id, params, job.runtime, job.controller.signal);
    const deps = Object.fromEntries(spec.deps.map((id) => [id, job.state.modules[id]?.result_fingerprint || null]));
    const implementation = {};
    for (const file of implementationFilesFor(spec.id))
      implementation[path.basename(file)] = await sha256(file, job.controller.signal);
    const identity = {
      module: spec.id,
      version: VERSION,
      implementation,
      source: job.sourceHash,
      source_path: job.input,
      params,
      model,
      deps,
      tools: ['media', 'audio', 'shots', 'clips', 'separation', 'transcript'].includes(spec.id) ? job.toolHashes : null,
    };
    return { params, model, implementation, identity, key: fingerprint(identity) };
  }
  async function validOutputs(job, stage) {
    if (!stage.output_files?.length) return false;
    if (stage.module_id === 'jianying') {
      try {
        const draft = await json(path.join(job.dir, stage.result_path));
        for (const file of draft.control_files || [])
          if ((await sha256(file.path, job.controller.signal)) !== file.sha256) return false;
        if (!draft.control_files?.length) return false;
      } catch (error) {
        if (job.controller.signal.aborted) throw error;
        return false;
      }
    }
    for (const file of stage.output_files) {
      try {
        if ((await sha256(path.join(job.dir, file.path), job.controller.signal)) !== file.sha256) return false;
      } catch (error) {
        if (job.controller.signal.aborted) throw error;
        return false;
      }
    }
    return true;
  }
  async function reconcile(job) {
    for (const spec of modules) {
      const stage = job.state.modules[spec.id];
      if (stage?.status !== 'succeeded') continue;
      const current = await inputKey(job, spec);
      if (stage.input_fingerprint !== current.key || !(await validOutputs(job, stage)))
        invalidate(job, spec.id, '输入、参数、模型或输出内容已变化，需要重新运行');
      else {
        stage.input_fingerprint = current.key;
        stage.implementation = current.implementation;
        stage.model_identity = current.model;
      }
    }
    await save(job);
  }
  async function verifySource(job) {
    job.controller.signal.throwIfAborted();
    const sameStat = (a, b) => ['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino'].every((key) => a[key] === b[key]);
    let current = await fsp.stat(job.input);
    if (sameStat(current, job.sourceStat)) return;
    // ctime also changes for permissions and extended attributes. Metadata
    // only triggers a content check; it is not evidence that video changed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const contentHash = await sha256(job.input, job.controller.signal);
      requireThat(
        contentHash === job.sourceHash,
        '处理中原视频内容已变化（SHA-256 不一致），结果未交接。请等待视频写入完成后重新运行。',
      );
      const after = await fsp.stat(job.input);
      if (sameStat(current, after)) {
        job.sourceStat = after;
        return;
      }
      current = after;
    }
    throw new Error('原视频在内容校验期间持续变化，结果未交接。请等待文件稳定后重新运行。');
  }
  async function runModule(job, spec, force) {
    const id = spec.id;
    job.controller.signal.throwIfAborted();
    await verifySource(job);
    if (!force && job.state.modules[id]?.status === 'succeeded') {
      job.state.modules[id].reused = true;
      emit(job);
      return;
    }
    const missing = spec.deps.filter((dep) => job.state.modules[dep]?.status !== 'succeeded');
    if (missing.length) {
      const error = Object.assign(
        new Error(
          `请先完成：${missing.map((dep) => modules.find((m) => m.id === dep).label).join('、')}。单独运行不会自动启动前置模块。`,
        ),
        { code: 'DEPENDENCY_MISSING' },
      );
      job.state.modules[id] = { ...job.state.modules[id], status: 'blocked', error: error.message };
      throw error;
    }
    invalidate(job, id, '上游模块已重新运行');
    const runId = randomUUID();
    const outputRel = path.join('modules', id, runId);
    const finalDir = path.join(job.dir, outputRel);
    const dir = `${finalDir}.partial`;
    const started = Date.now();
    const config = await inputKey(job, spec);
    const record = {
      module_id: id,
      module_version: VERSION,
      run_id: runId,
      task_id: job.projectId,
      status: 'running',
      started_at: new Date(started).toISOString(),
      params: config.params,
      model_identity: config.model,
      implementation: config.implementation,
      input_fingerprint: config.key,
      progress: null,
      message: '处理中',
      output_files: [],
      error: null,
      reused: false,
    };
    job.state.modules[id] = record;
    job.state.active_module = id;
    await save(job);
    let lastProgress = 0;
    try {
      await fsp.mkdir(dir, { recursive: true });
      runtimeTools.requireRuntime(id, config.params, job.runtime);
      const deps = {};
      for (const dep of spec.deps) {
        const previous = job.state.modules[dep];
        deps[dep] = {
          dir: path.join(job.dir, previous.output_dir),
          data: await json(path.join(job.dir, previous.result_path)),
        };
      }
      const data = await moduleHandlers[id](
        {
          taskId: job.projectId,
          projectDir: job.dir,
          input: job.input,
          sourceHash: job.sourceHash,
          dir,
          ffmpeg: job.ffmpeg,
          ffprobe: job.ffprobe,
          runtime: job.runtime,
          params: config.params,
          signal: job.controller.signal,
          onProgress: (value) => {
            if (Number.isFinite(value.progress)) record.progress = Math.max(0, Math.min(99, value.progress));
            for (const key of ['progress_unit', 'progress_completed', 'progress_total'])
              if (value[key] != null) record[key] = value[key];
            if (value.message) record.message = value.message;
            if (Date.now() - lastProgress > 150) {
              lastProgress = Date.now();
              emit(job);
            }
          },
        },
        deps,
      );
      job.controller.signal.throwIfAborted();
      await verifySource(job);
      requireThat(data?.schema_version === VERSION && data.task_id === job.projectId, '模块输出版本或任务 ID 不一致');
      await json(path.join(dir, spec.file));
      const outputs = [];
      for (const file of await filesIn(dir))
        outputs.push({
          path: path.join(outputRel, path.relative(dir, file)),
          sha256: await sha256(file, job.controller.signal),
        });
      await fsp.rename(dir, finalDir);
      const summary = brief(data);
      if (id === 'jianying') Object.assign(summary, { draft_path: data.draft_path, validated: data.validated });
      Object.assign(record, {
        status: 'succeeded',
        progress: 100,
        message: summary.needs_review ? '完成，存在待复核项' : '完成',
        output_dir: outputRel,
        result_path: path.join(outputRel, spec.file),
        output_files: outputs,
        result_fingerprint: fingerprint(outputs),
        summary,
        needs_review: summary.needs_review,
        review_status: summary.needs_review ? 'needs_review' : null,
        review_items: summary.review_items,
        finished_at: new Date().toISOString(),
        elapsed_seconds: (Date.now() - started) / 1000,
      });
      await save(job);
      for (const item of await fsp.readdir(path.dirname(finalDir), { withFileTypes: true })) {
        if (item.isDirectory() && item.name !== runId)
          await fsp.rm(path.join(path.dirname(finalDir), item.name), { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      Object.assign(record, {
        status: job.controller.signal.aborted ? 'stopped' : error.code === 'DEPENDENCY_MISSING' ? 'blocked' : 'failed',
        error: String(error.message || error),
        progress: null,
        message: '',
        elapsed_seconds: (Date.now() - started) / 1000,
        finished_at: new Date().toISOString(),
      });
      await save(job);
      throw error;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
  async function execute(job, module, force) {
    try {
      job.controller.signal.throwIfAborted();
      job.state.status = 'running';
      job.state.error = null;
      await save(job);
      job.sourceStat = await fsp.stat(job.input);
      job.sourceHash = await sha256(job.input, job.controller.signal);
      await verifySource(job);
      job.toolHashes = {};
      for (const tool of [job.ffmpeg, job.ffprobe]) {
        requireThat(tool && fs.existsSync(tool), '未找到内置 FFmpeg / ffprobe');
        job.toolHashes[tool] = await sha256(tool, job.controller.signal);
      }
      const sourceChanged = job.state.source_sha256 && job.state.source_sha256 !== job.sourceHash;
      if (sourceChanged) invalidate(job, 'media', '视频内容已变化');
      job.state.source_sha256 = job.sourceHash;
      if (module === 'jianying') {
        requireThat(!sourceChanged, '原视频已变化，请先重新拆解');
        // An explicit draft-only run uses existing, hash-checked media. UI or
        // progress-code changes must not restart minutes of audio separation.
        for (const spec of MODULES) {
          const stage = job.state.modules[spec.id];
          requireThat(
            stage?.status === 'succeeded' && (await validOutputs(job, stage)),
            `${spec.label}结果缺失或已修改，请先重新运行该步骤`,
          );
        }
      } else await reconcile(job);
      for (const spec of module ? modules.filter((m) => m.id === module) : modules)
        await runModule(job, spec, !!module && force);
      job.state.status = modules.every((spec) => job.state.modules[spec.id]?.status === 'succeeded')
        ? 'completed'
        : 'partial';
    } catch (error) {
      job.state.status = job.controller.signal.aborted
        ? 'stopped'
        : error.code === 'DEPENDENCY_MISSING'
          ? 'blocked'
          : 'failed';
      job.state.error = String(error.message || error);
    } finally {
      job.state.active_module = null;
      await save(job);
    }
  }
  async function start(payload = {}) {
    const input = path.resolve(String(payload.inputPath || ''));
    requireThat(payload.inputPath && (await fsp.stat(input)).isFile(), '请选择存在的视频文件');
    const projectId = String(payload.projectId || `${path.parse(input).name}-${fingerprint(input).slice(0, 8)}`).trim();
    requireThat(projectId, '缺少项目 ID');
    requireThat(!payload.module || modules.some((m) => m.id === payload.module), '未知模块');
    requireThat(!['queued', 'running', 'stopping'].includes(jobs.get(projectId)?.state.status), '这个项目已在处理');
    requireThat(!starting.has(projectId), '这个项目正在准备');
    starting.add(projectId);
    try {
      const old = getProjectRecord?.(projectId);
      let dir;
      if (old?.manifestPath) dir = path.dirname(old.manifestPath);
      else {
        requireThat(String(payload.outputRoot || '').trim(), '请先选择拆解输出目录');
        dir = path.join(
          path.resolve(String(payload.outputRoot).trim()),
          `${safeName(projectId)}-${fingerprint(projectId).slice(0, 8)}`,
        );
      }
      const manifestPath = path.join(dir, 'project.json');
      let state;
      try {
        state = await json(manifestPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (state)
        requireThat(
          state.kind === 'video_structure' && state.project_id === projectId && state.schema_version === VERSION,
          '输出目录已有不兼容项目，请使用不同项目 ID',
        );
      state ||= { kind: 'video_structure', schema_version: VERSION, project_id: projectId, modules: {} };
      state.input_path = input;
      state.status = 'queued';
      state.active_module = null;
      state.error = null;
      const settings = { ...(getSettings?.() || {}) };
      const job = {
        projectId,
        input,
        dir,
        manifestPath,
        state,
        settings,
        controller: new AbortController(),
        runtime: runtimeTools.runtime(settings),
        ffmpeg: getFfmpegPath(),
        ffprobe: getFfprobePath(),
      };
      jobs.set(projectId, job);
      try {
        await save(job);
        saveProjectRecord?.(projectId, { manifestPath, inputPath: input });
      } catch (e) {
        jobs.delete(projectId);
        throw e;
      }
      // One episode at a time in this first version; native tools use configured threads.
      job.done = queue.then(() => execute(job, payload.module, payload.force === true));
      queue = job.done.catch((error) => {
        job.state.status = 'failed';
        job.state.error = error.message;
        emit(job);
      });
      return snapshot(job);
    } finally {
      starting.delete(projectId);
    }
  }
  function cancel(id) {
    const job = jobs.get(String(id));
    if (!job || !['queued', 'running', 'stopping'].includes(job.state.status))
      return { success: false, error: '任务未在运行' };
    job.state.status = 'stopping';
    job.controller.abort();
    emit(job);
    return { success: true };
  }
  async function wait(id) {
    await jobs.get(String(id))?.done;
    return status(id);
  }
  async function cancelAll() {
    for (const id of jobs.keys()) cancel(id);
    await queue;
  }
  function hasActive() {
    return [...jobs.values()].some((job) => ['queued', 'running', 'stopping'].includes(job.state.status));
  }
  return {
    start,
    status,
    cancel,
    wait,
    cancelAll,
    hasActive,
    availability: () => runtimeTools.availability(getSettings?.() || {}),
  };
}
module.exports = { createVideoStructurePipeline, implementationFilesFor, brief };
