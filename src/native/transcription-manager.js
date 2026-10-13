'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fasterWhisper = require('./faster-whisper');

function fingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch (_) { return null; }
}

function concurrency(settings = {}) {
  const value = Number(settings.faster_whisper_concurrency);
  return Number.isInteger(value) ? Math.max(1, Math.min(4, value)) : 2;
}

function isCompleted(record, item) {
  return record?.status === 'completed'
    && record.inputFingerprint === item.inputFingerprint
    && !!record.srtPath
    && fs.existsSync(record.srtPath);
}

function createTranscriptionManager({ getSettings, getEpisodes, getState, saveState, sendProgress }) {
  const batches = new Map();
  const runningBySeries = new Map();

  function emit(payload) {
    try { sendProgress?.(payload); } catch (_) {}
  }

  function updateEpisode(seriesId, episodeIndex, patch, persist = true) {
    const state = getState(seriesId) || { version: 1, episodes: {} };
    const episodes = { ...(state.episodes || {}) };
    const previous = episodes[String(episodeIndex)] || { episodeIndex: Number(episodeIndex) };
    episodes[String(episodeIndex)] = { ...previous, ...patch, episodeIndex: Number(episodeIndex), updatedAt: Date.now() };
    const next = { ...state, version: 1, episodes, updatedAt: Date.now() };
    if (persist) saveState(seriesId, next);
    return episodes[String(episodeIndex)];
  }

  function snapshot(seriesId, batch = null) {
    const state = getState(seriesId) || { version: 1, episodes: {} };
    const source = getEpisodes(seriesId) || [];
    const episodes = source.map(item => {
      const saved = state.episodes?.[String(item.episodeIndex)] || {};
      const stale = saved.status === 'completed' && !isCompleted(saved, item);
      const effective = stale ? { ...saved, status: 'stale', stage: 'stale', error: '去重输出已变化，请重新生成 SRT' } : saved;
      const liveProgress = batch?.progress?.get(Number(item.episodeIndex));
      return {
        episodeIndex: Number(item.episodeIndex),
        status: stale ? 'stale' : 'pending',
        stage: stale ? 'stale' : 'pending',
        ...effective,
        inputPath: item.inputPath,
        inputFingerprint: item.inputFingerprint,
        srtPath: item.srtPath,
        progress: liveProgress == null ? Number(effective.progress) || 0 : liveProgress,
      };
    }).sort((a, b) => Number(a.episodeIndex) - Number(b.episodeIndex));
    const active = batch && !['completed', 'failed', 'stopped'].includes(batch.status);
    const counts = episodes.reduce((result, item) => {
      const key = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : item.status === 'running' ? 'running' : item.status === 'queued' ? 'queued' : item.status === 'stopped' ? 'stopped' : 'pending';
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});
    return {
      success: true,
      seriesId: String(seriesId),
      status: active ? batch.status : counts.failed ? 'failed' : counts.running || counts.queued ? 'running' : counts.completed ? 'completed' : 'idle',
      batchId: batch?.id || null,
      runtime: batch?.runtime ? { device: batch.runtime.device, computeType: batch.runtime.computeType, model: batch.runtime.model } : null,
      counts: { total: episodes.length, ...counts },
      episodes,
      error: episodes.find(item => item.status === 'failed' && item.error)?.error || '',
      updatedAt: state.updatedAt || 0,
    };
  }

  async function processEpisode(batch, job) {
    const { seriesId } = batch;
    if (batch.cancelled) {
      updateEpisode(seriesId, job.episodeIndex, { status: 'stopped', stage: 'stopped', error: '任务已取消', batchId: batch.id });
      return;
    }
    const controller = new AbortController();
    batch.controllers.set(job.episodeIndex, controller);
    updateEpisode(seriesId, job.episodeIndex, { status: 'running', stage: 'transcribing', progress: 0, error: '', batchId: batch.id, inputPath: job.inputPath, inputFingerprint: job.inputFingerprint, srtPath: job.srtPath });
    batch.progress.set(job.episodeIndex, 0);
    emit({ type: 'episode', seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status: 'running', stage: 'transcribing', progress: 0 });
    try {
      const result = await fasterWhisper.transcribeToSrt(job.inputPath, job.srtPath, batch.runtime, {
        signal: controller.signal,
        language: getSettings()?.whisper_language || 'zh',
        onProgress: info => {
          const progress = Math.max(0, Math.min(100, Number(info?.progress) || 0));
          batch.progress.set(job.episodeIndex, progress);
          emit({ type: 'episode', seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status: 'running', stage: 'transcribing', progress, message: info?.message || '' });
        },
      });
      const outputFingerprint = fingerprint(result.outputPath);
      if (!outputFingerprint) throw new Error('SRT 输出为空，未保存完成');
      updateEpisode(seriesId, job.episodeIndex, { status: 'completed', stage: 'completed', progress: 100, error: '', batchId: batch.id, inputPath: job.inputPath, inputFingerprint: job.inputFingerprint, srtPath: result.outputPath, srtFingerprint: outputFingerprint, backend: { engine: 'faster-whisper', device: batch.runtime.device, computeType: batch.runtime.computeType, model: batch.runtime.model }, completedAt: Date.now() });
      emit({ type: 'episode', seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status: 'completed', stage: 'completed', progress: 100, srtPath: result.outputPath });
    } catch (error) {
      const cancelled = batch.cancelled || controller.signal.aborted || /任务已取消/.test(String(error?.message || ''));
      const status = cancelled ? 'stopped' : 'failed';
      updateEpisode(seriesId, job.episodeIndex, { status, stage: status, progress: cancelled ? 0 : 0, error: cancelled ? '任务已取消' : String(error?.message || error), batchId: batch.id, inputPath: job.inputPath, inputFingerprint: job.inputFingerprint, srtPath: job.srtPath });
      emit({ type: 'episode', seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status, stage: status, progress: 0, error: cancelled ? '任务已取消' : String(error?.message || error) });
    } finally {
      batch.controllers.delete(job.episodeIndex);
    }
  }

  async function runBatch(batch) {
    batch.status = 'running';
    emit({ type: 'batch', seriesId: batch.seriesId, batchId: batch.id, status: 'running' });
    try {
      batch.runtime = await fasterWhisper.prepareRuntime(getSettings());
      const workers = Math.min(concurrency(getSettings()), batch.jobs.length || 1);
      let cursor = 0;
      const worker = async () => {
        while (!batch.cancelled) {
          const job = batch.jobs[cursor++];
          if (!job) return;
          await processEpisode(batch, job);
        }
      };
      await Promise.all(Array.from({ length: workers }, worker));
      if (batch.cancelled) {
        for (const job of batch.jobs) {
          const state = getState(batch.seriesId)?.episodes?.[String(job.episodeIndex)];
          if (state?.status === 'queued') updateEpisode(batch.seriesId, job.episodeIndex, { status: 'stopped', stage: 'stopped', error: '任务已取消', batchId: batch.id });
        }
      }
    } catch (error) {
      batch.error = String(error?.message || error);
      for (const job of batch.jobs) {
        const state = getState(batch.seriesId)?.episodes?.[String(job.episodeIndex)];
        if (state?.status === 'queued' || state?.status === 'running') updateEpisode(batch.seriesId, job.episodeIndex, { status: batch.cancelled ? 'stopped' : 'failed', stage: batch.cancelled ? 'stopped' : 'failed', error: batch.cancelled ? '任务已取消' : batch.error, batchId: batch.id });
      }
    } finally {
      const selectedStates = batch.jobs.map(job => getState(batch.seriesId)?.episodes?.[String(job.episodeIndex)]).filter(Boolean);
      batch.status = batch.cancelled ? 'stopped' : batch.error ? 'failed' : selectedStates.some(item => item.status === 'failed') ? 'failed' : 'completed';
      runningBySeries.delete(batch.seriesId);
      emit({ type: 'batch', seriesId: batch.seriesId, batchId: batch.id, status: batch.status, error: batch.error || '' });
      batches.set(batch.id, batch);
    }
  }

  async function start(payload = {}) {
    const seriesId = String(payload.seriesId || '');
    if (!seriesId) return { success: false, error: '缺少短剧 ID' };
    const current = runningBySeries.get(seriesId);
    if (current && ['queued', 'running'].includes(current.status)) return { success: false, error: '该短剧正在转写，请等待当前任务完成', batch: snapshot(seriesId, current) };
    const sourceEpisodes = (getEpisodes(seriesId) || []).filter(item => item && item.inputPath && item.srtPath && item.inputFingerprint);
    if (!sourceEpisodes.length) return { success: false, error: '没有已完成去重的输入视频，请先完成去重' };
    const requested = Array.isArray(payload.episodeIndices) && payload.episodeIndices.length
      ? new Set(payload.episodeIndices.map(Number).filter(Number.isSafeInteger)) : null;
    const selected = sourceEpisodes.filter(item => !requested || requested.has(Number(item.episodeIndex)));
    if (!selected.length) return { success: false, error: '选择的集数没有已完成去重的视频' };
    const state = getState(seriesId) || { version: 1, episodes: {} };
    const jobs = [];
    for (const item of selected) {
      const old = state.episodes?.[String(item.episodeIndex)];
      if (isCompleted(old, item) && payload.force !== true) continue;
      updateEpisode(seriesId, item.episodeIndex, { status: 'queued', stage: 'queued', progress: 0, error: '', batchId: null, inputPath: item.inputPath, inputFingerprint: item.inputFingerprint, srtPath: item.srtPath, completedAt: null });
      jobs.push(item);
    }
    if (!jobs.length) return { success: true, skipped: selected.length, batch: snapshot(seriesId) };
    const batch = { id: randomUUID(), seriesId, jobs, status: 'queued', runtime: null, controllers: new Map(), progress: new Map(), cancelled: false, createdAt: Date.now(), error: '' };
    batches.set(batch.id, batch);
    runningBySeries.set(seriesId, batch);
    emit({ type: 'batch', seriesId, batchId: batch.id, status: 'queued', total: jobs.length });
    setImmediate(() => runBatch(batch));
    return { success: true, batchId: batch.id, skipped: selected.length - jobs.length, batch: snapshot(seriesId, batch) };
  }

  function cancel(batchId) {
    const batch = batches.get(String(batchId));
    if (!batch || !['queued', 'running'].includes(batch.status)) return { success: false, error: '任务不存在或已经结束' };
    batch.cancelled = true;
    for (const controller of batch.controllers.values()) controller.abort();
    return { success: true };
  }

  function status(seriesId) {
    const id = String(seriesId || '');
    return snapshot(id, runningBySeries.get(id) || null);
  }

  return { start, cancel, status };
}

module.exports = { createTranscriptionManager, fingerprint };
