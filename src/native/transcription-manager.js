'use strict';

const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const fasterWhisper = require('./faster-whisper');
const { validateSrt } = require('./srt');

function fingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch (_) { return null; }
}

const subtitleCache = new Map();
function inspectSubtitle(filePath, duration) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024 * 1024) throw new Error('SRT 文件为空或大小异常');
  const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${duration}`;
  const cached = subtitleCache.get(filePath);
  if (cached?.key === key) return cached.result;
  const content = fs.readFileSync(filePath, 'utf8');
  const checked = validateSrt(content, { duration });
  const result = { hash: createHash('sha256').update(content).digest('hex'), entries: checked.entries.length };
  if (subtitleCache.size >= 256) subtitleCache.delete(subtitleCache.keys().next().value);
  subtitleCache.set(filePath, { key, result });
  return result;
}

function isCompleted(record, item) {
  if (record?.status !== 'completed' || record.inputPath !== item.inputPath
      || record.inputFingerprint !== item.inputFingerprint || fingerprint(item.inputPath) !== item.inputFingerprint
      || record.srtPath !== item.srtPath || !(record.validation?.duration > 0)) return false;
  try { return inspectSubtitle(record.srtPath, record.validation.duration).hash === record.srtHash; }
  catch (_) { return false; }
}

function concurrency(settings = {}) {
  const value = Number(settings.faster_whisper_concurrency);
  return Number.isInteger(value) ? Math.max(1, Math.min(4, value)) : 2;
}

function createTranscriptionManager({ getSettings, getEpisodes, getState, saveState, sendProgress }) {
  // One shared quota for the entire app, with batches served round-robin.
  const batches = new Map();
  const runningBySeries = new Map();
  const ready = [];
  let active = 0;

  function emit(payload) { try { sendProgress?.(payload); } catch (_) {} }

  function updateEpisodes(seriesId, changes) {
    const state = getState(seriesId) || { version: 1, episodes: {} };
    const episodes = { ...(state.episodes || {}) };
    for (const { episodeIndex, ...patch } of changes) episodes[String(episodeIndex)] = { ...episodes[String(episodeIndex)], ...patch, episodeIndex: Number(episodeIndex), updatedAt: Date.now() };
    saveState(seriesId, { ...state, version: 1, episodes, updatedAt: Date.now() });
  }

  function updateEpisode(seriesId, episodeIndex, patch) { updateEpisodes(seriesId, [{ ...patch, episodeIndex }]); }

  function snapshot(seriesId, batch = null) {
    const state = getState(seriesId) || { episodes: {} };
    const episodes = (getEpisodes(seriesId) || []).map(item => {
      const saved = state.episodes?.[String(item.episodeIndex)] || { status: 'pending', stage: 'pending' };
      const stale = saved.status === 'completed' && !isCompleted(saved, item);
      return {
        ...saved,
        ...batch?.progress.get(Number(item.episodeIndex)),
        ...item,
        ...(stale ? { status: 'stale', stage: 'stale', progress: 0, error: '去重视频或 SRT 已变化/损坏，请重新识别并校验' } : {}),
      };
    }).sort((a, b) => Number(a.episodeIndex) - Number(b.episodeIndex));
    const counts = { total: episodes.length, completed: 0, failed: 0, running: 0, queued: 0, stopped: 0, pending: 0 };
    for (const item of episodes) counts[Object.hasOwn(counts, item.status) ? item.status : 'pending']++;
    return {
      success: true, seriesId: String(seriesId),
      status: batch?.status || (counts.failed ? 'failed' : counts.total && counts.completed === counts.total ? 'completed' : counts.stopped ? 'stopped' : counts.completed ? 'partial' : 'idle'),
      batchId: batch?.id || null,
      runtime: batch?.runtime ? { device: batch.runtime.device, computeType: batch.runtime.computeType, model: batch.runtime.model } : null,
      counts, episodes, error: episodes.find(item => item.status === 'failed' && item.error)?.error || '', updatedAt: state.updatedAt || 0,
    };
  }

  function assertCurrent(batch, job) {
    if (batch.cancelled) throw new Error('任务已取消');
    const current = (getEpisodes(batch.seriesId) || []).find(item => Number(item.episodeIndex) === Number(job.episodeIndex));
    if (!current || current.inputPath !== job.inputPath || current.inputFingerprint !== job.inputFingerprint
        || current.srtPath !== job.srtPath || fingerprint(job.inputPath) !== job.inputFingerprint) {
      throw new Error('去重视频在识别期间发生变化，结果未保存，请重新识别');
    }
  }

  async function processEpisode(batch, job) {
    const controller = new AbortController();
    batch.controllers.set(job.episodeIndex, controller);
    const progress = info => {
      if (batch.cancelled) return;
      const live = { stage: info.stage || 'aligning', progress: Math.max(0, Math.min(99, Number(info.progress) || 0)), message: info.message || '' };
      batch.progress.set(Number(job.episodeIndex), live);
      emit({ type: 'episode', seriesId: batch.seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status: 'running', ...live });
    };
    try {
      assertCurrent(batch, job);
      updateEpisode(batch.seriesId, job.episodeIndex, { status: 'running', stage: 'extracting', progress: 0, error: '', batchId: batch.id });
      progress({ stage: 'extracting', progress: 0 });
      const result = await fasterWhisper.transcribeToSrt(job.inputPath, job.srtPath, batch.runtime, {
        signal: controller.signal, language: batch.settings.whisper_language || 'zh', onProgress: progress,
        beforeCommit: () => assertCurrent(batch, job),
      });
      assertCurrent(batch, job);
      const checked = inspectSubtitle(result.outputPath, result.timing.duration);
      updateEpisode(batch.seriesId, job.episodeIndex, {
        status: 'completed', stage: 'completed', progress: 100, error: '', batchId: batch.id,
        inputPath: job.inputPath, inputFingerprint: job.inputFingerprint, srtPath: result.outputPath,
        srtFingerprint: fingerprint(result.outputPath), srtHash: checked.hash, revision: randomUUID(),
        validation: { status: 'passed', ...result.timing, entries: checked.entries, wordAligned: result.alignment.word_aligned === true },
        backend: { engine: 'faster-whisper', device: batch.runtime.device, computeType: batch.runtime.computeType, model: batch.runtime.model }, completedAt: Date.now(),
      });
      emit({ type: 'episode', seriesId: batch.seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status: 'completed', progress: 100 });
    } catch (error) {
      const stopped = batch.cancelled || controller.signal.aborted;
      const status = stopped ? 'stopped' : 'failed';
      const message = stopped ? '任务已取消' : String(error?.message || error);
      updateEpisode(batch.seriesId, job.episodeIndex, { status, stage: status, progress: 0, error: message, batchId: batch.id });
      emit({ type: 'episode', seriesId: batch.seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status, error: message });
    } finally {
      batch.progress.delete(Number(job.episodeIndex));
      batch.controllers.delete(job.episodeIndex);
    }
  }

  function finish(batch) {
    if (!batches.has(batch.id) || batch.preparing || batch.active || batch.cursor < batch.jobs.length) return;
    const states = batch.jobs.map(job => getState(batch.seriesId)?.episodes?.[String(job.episodeIndex)]);
    batch.status = batch.cancelled ? 'stopped' : batch.error || states.some(item => item?.status === 'failed') ? 'failed' : 'completed';
    runningBySeries.delete(batch.seriesId);
    batches.delete(batch.id);
    emit({ type: 'batch', seriesId: batch.seriesId, batchId: batch.id, status: batch.status, error: batch.error || '' });
    batch.resolveDone();
  }

  function pump() {
    while (active < concurrency(getSettings()) && ready.length) {
      const batch = ready.shift();
      if (batch.cancelled || batch.cursor >= batch.jobs.length) { finish(batch); continue; }
      if (!batch.runtime) {
        active++;
        batch.preparing = true;
        prepareBatch(batch).catch(error => { batch.error = String(error?.message || error); }).finally(() => { active--; pump(); });
        continue;
      }
      const job = batch.jobs[batch.cursor++];
      if (batch.cursor < batch.jobs.length) ready.push(batch);
      active++;
      batch.active++;
      processEpisode(batch, job).catch(error => { batch.error = String(error?.message || error); }).finally(() => {
        active--;
        batch.active--;
        finish(batch);
        pump();
      });
    }
  }

  async function prepareBatch(batch) {
    try {
      batch.runtime = await fasterWhisper.prepareRuntime(batch.settings, { signal: batch.preparation.signal });
      if (!batch.cancelled) {
        batch.status = 'running';
        ready.push(batch);
        emit({ type: 'batch', seriesId: batch.seriesId, batchId: batch.id, status: 'running' });
      }
    } catch (error) {
      batch.error = String(error?.message || error);
      batch.cursor = batch.jobs.length;
      updateEpisodes(batch.seriesId, batch.jobs.map(job => ({ episodeIndex: job.episodeIndex, status: batch.cancelled ? 'stopped' : 'failed', stage: batch.cancelled ? 'stopped' : 'failed', error: batch.cancelled ? '任务已取消' : batch.error })));
    } finally {
      batch.preparing = false;
      finish(batch);
    }
  }

  async function start(payload = {}) {
    const seriesId = String(payload.seriesId || '');
    if (!seriesId) return { success: false, error: '缺少短剧 ID' };
    const current = runningBySeries.get(seriesId);
    if (current) return { success: false, error: current.cancelled ? '正在等待字幕进程退出，请稍后重试' : '该短剧正在转写，请等待当前任务完成', batch: snapshot(seriesId, current) };
    const source = (getEpisodes(seriesId) || []).filter(item => item?.inputPath && item.srtPath && item.inputFingerprint);
    if (!source.length) return { success: false, error: '没有已完成去重的输入视频，请先完成去重' };
    const requested = Array.isArray(payload.episodeIndices) ? new Set(payload.episodeIndices.map(Number).filter(Number.isSafeInteger)) : null;
    const selected = source.filter(item => !requested || requested.has(Number(item.episodeIndex)));
    if (!selected.length) return { success: false, error: '选择的集数没有已完成去重的视频' };
    const state = getState(seriesId) || { episodes: {} };
    const jobs = selected.filter(item => payload.force === true || !isCompleted(state.episodes?.[String(item.episodeIndex)], item)).map(item => ({ ...item }));
    if (!jobs.length) return { success: true, skipped: selected.length, batch: snapshot(seriesId) };
    const batch = { id: randomUUID(), seriesId, jobs, cursor: 0, active: 0, preparing: false, preparation: new AbortController(), settings: { ...getSettings() }, status: 'queued', runtime: null, controllers: new Map(), progress: new Map(), cancelled: false, error: '' };
    batch.done = new Promise(resolve => { batch.resolveDone = resolve; });
    updateEpisodes(seriesId, jobs.map(item => ({ ...item, status: 'queued', stage: 'queued', progress: 0, error: '', batchId: batch.id, completedAt: null, validation: null })));
    batches.set(batch.id, batch);
    runningBySeries.set(seriesId, batch);
    emit({ type: 'batch', seriesId, batchId: batch.id, status: 'queued', total: jobs.length });
    setImmediate(() => { if (batches.has(batch.id)) { ready.push(batch); pump(); } });
    return { success: true, batchId: batch.id, skipped: selected.length - jobs.length, batch: snapshot(seriesId, batch) };
  }

  function cancel(batchId) {
    const batch = batches.get(String(batchId));
    if (!batch) return { success: false, error: '任务不存在或已经结束' };
    batch.cancelled = true;
    batch.status = 'stopping';
    batch.preparation.abort();
    for (const controller of batch.controllers.values()) controller.abort();
    const queued = batch.jobs.slice(batch.cursor);
    try {
      if (queued.length) updateEpisodes(batch.seriesId, queued.map(job => ({ episodeIndex: job.episodeIndex, status: 'stopped', stage: 'stopped', error: '任务已取消' })));
    } catch (error) { batch.error = String(error?.message || error); }
    batch.cursor = batch.jobs.length;
    const index = ready.indexOf(batch);
    if (index >= 0) ready.splice(index, 1);
    emit({ type: 'batch', seriesId: batch.seriesId, batchId: batch.id, status: 'stopping' });
    finish(batch);
    return { success: true };
  }

  async function cancelAll() {
    const current = [...batches.values()];
    for (const batch of current) cancel(batch.id);
    await Promise.all(current.map(batch => batch.done));
  }

  function status(seriesId) {
    const id = String(seriesId || '');
    return snapshot(id, runningBySeries.get(id));
  }

  return { start, cancel, cancelAll, status, hasActive: () => batches.size > 0 };
}

module.exports = { createTranscriptionManager, fingerprint, isCompleted, inspectSubtitle };
