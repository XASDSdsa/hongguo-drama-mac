'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const { randomUUID } = require('node:crypto');
const openai = require('./openai');
const { refineAnalysisCutPoints } = require('./cut-candidates');

function fingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch (_) { return null; }
}

function concurrency(settings = {}) {
  const value = Number(settings.ai_concurrency);
  return Number.isInteger(value) ? Math.max(1, Math.min(4, value)) : 2;
}

function outputValid(record, item) {
  return record?.status === 'completed'
    && record.srtFingerprint === item.srtFingerprint
    && record.srtRevision === item.srtRevision
    && record.inputFingerprint === item.inputFingerprint
    && !!record.analysisPath
    && fs.existsSync(record.analysisPath);
}

async function writeJsonAtomic(filePath, value, beforeCommit) {
  await fsp.mkdir(require('node:path').dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    beforeCommit();
    fs.renameSync(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

function createAnalysisManager({ getSettings, getEpisodes, getState, saveState, sendProgress, getFfmpegPath }) {
  const batches = new Map();
  const runningBySeries = new Map();

  function emit(payload) { try { sendProgress?.(payload); } catch (_) {} }

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
      const stale = saved.status === 'completed' && !outputValid(saved, item);
      const effective = stale ? { ...saved, status: 'stale', stage: 'stale', error: 'SRT 已变化，请重新生成剧情分析' } : saved;
      return {
        episodeIndex: Number(item.episodeIndex),
        status: stale ? 'stale' : 'pending',
        stage: stale ? 'stale' : 'pending',
        progress: 0,
        ...effective,
        title: item.title || '',
        srtPath: item.srtPath,
        srtFingerprint: item.srtFingerprint,
        analysisPath: item.analysisPath,
      };
    }).sort((a, b) => Number(a.episodeIndex) - Number(b.episodeIndex));
    const counts = episodes.reduce((result, item) => {
      const key = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : item.status === 'running' ? 'running' : item.status === 'queued' ? 'queued' : item.status === 'stopped' ? 'stopped' : 'pending';
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});
    return {
      success: true,
      seriesId: String(seriesId),
      status: batch && ['queued', 'running'].includes(batch.status) ? batch.status : counts.failed ? 'failed' : counts.running || counts.queued ? 'running' : counts.completed ? 'completed' : 'idle',
      batchId: batch?.id || null,
      counts: { total: episodes.length, ...counts },
      episodes,
      error: episodes.find(item => item.status === 'failed' && item.error)?.error || '',
      updatedAt: state.updatedAt || 0,
    };
  }

  async function processEpisode(batch, job) {
    const controller = new AbortController();
    batch.controllers.set(job.episodeIndex, controller);
    updateEpisode(batch.seriesId, job.episodeIndex, { status: 'running', stage: 'analyzing', progress: 0, error: '', batchId: batch.id, srtPath: job.srtPath, srtFingerprint: job.srtFingerprint, analysisPath: job.analysisPath });
    emit({ type: 'episode', seriesId: batch.seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status: 'running', stage: 'analyzing', progress: 0 });
    const assertCurrent = () => {
      if (batch.cancelled || controller.signal.aborted) throw new Error('任务已取消');
      const current = (getEpisodes(batch.seriesId) || []).find(item => Number(item.episodeIndex) === Number(job.episodeIndex));
      if (!current || current.srtPath !== job.srtPath || current.srtFingerprint !== job.srtFingerprint
          || current.srtRevision !== job.srtRevision || current.inputFingerprint !== job.inputFingerprint) {
        throw new Error('去重视频或字幕在分析期间已变化，结果未保存，请重新分析');
      }
    };
    try {
      assertCurrent();
      const srt = await fsp.readFile(job.srtPath, 'utf8');
      const result = await openai.analyzeEpisode(srt, { seriesTitle: job.seriesTitle, episodeIndex: job.episodeIndex, episodeTitle: job.title, model: batch.settings.ai_text_model, signal: controller.signal }, batch.settings);
      const refined = await refineAnalysisCutPoints(result, {
        ffmpegPath: getFfmpegPath?.(),
        inputPath: job.inputPath,
        signal: controller.signal,
        sceneChangeThreshold: 0.4,
      });
      await writeJsonAtomic(job.analysisPath, refined, assertCurrent);
      assertCurrent();
      updateEpisode(batch.seriesId, job.episodeIndex, { status: 'completed', stage: 'completed', progress: 100, error: '', batchId: batch.id, srtPath: job.srtPath, srtFingerprint: job.srtFingerprint, srtRevision: job.srtRevision, inputFingerprint: job.inputFingerprint, analysisPath: job.analysisPath, analysisFingerprint: fingerprint(job.analysisPath), completedAt: Date.now() });
      emit({ type: 'episode', seriesId: batch.seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status: 'completed', stage: 'completed', progress: 100, analysisPath: job.analysisPath });
    } catch (error) {
      const cancelled = batch.cancelled || controller.signal.aborted || /任务已取消|aborted/i.test(String(error?.message || ''));
      const status = cancelled ? 'stopped' : 'failed';
      updateEpisode(batch.seriesId, job.episodeIndex, { status, stage: status, progress: 0, error: cancelled ? '任务已取消' : String(error?.message || error), batchId: batch.id, srtPath: job.srtPath, srtFingerprint: job.srtFingerprint, analysisPath: job.analysisPath });
      emit({ type: 'episode', seriesId: batch.seriesId, batchId: batch.id, episodeIndex: job.episodeIndex, status, stage: status, progress: 0, error: cancelled ? '任务已取消' : String(error?.message || error) });
    } finally {
      batch.controllers.delete(job.episodeIndex);
    }
  }

  async function runBatch(batch) {
    batch.status = 'running';
    emit({ type: 'batch', seriesId: batch.seriesId, batchId: batch.id, status: 'running' });
    try {
      const workers = Math.min(concurrency(batch.settings), batch.jobs.length || 1);
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
      batches.set(batch.id, batch);
      emit({ type: 'batch', seriesId: batch.seriesId, batchId: batch.id, status: batch.status, error: batch.error || '' });
    }
  }

  async function start(payload = {}) {
    const seriesId = String(payload.seriesId || '');
    if (!seriesId) return { success: false, error: '缺少短剧 ID' };
    const current = runningBySeries.get(seriesId);
    if (current && ['queued', 'running'].includes(current.status)) return { success: false, error: '该短剧正在生成分析，请等待当前任务完成', batch: snapshot(seriesId, current) };
    const settings = getSettings() || {};
    try { openai.requireApiConfig(settings); } catch (error) { return { success: false, error: error.message }; }
    const source = (getEpisodes(seriesId) || []).filter(item => item.srtPath && item.analysisPath && item.srtFingerprint && fs.existsSync(item.srtPath));
    if (!source.length) return { success: false, error: '没有已完成的 SRT，请先完成完整字幕识别' };
    const requested = Array.isArray(payload.episodeIndices) && payload.episodeIndices.length ? new Set(payload.episodeIndices.map(Number).filter(Number.isSafeInteger)) : null;
    const selected = source.filter(item => !requested || requested.has(Number(item.episodeIndex)));
    if (!selected.length) return { success: false, error: '选择的集数没有已完成的 SRT' };
    const state = getState(seriesId) || { version: 1, episodes: {} };
    const jobs = [];
    for (const item of selected) {
      const old = state.episodes?.[String(item.episodeIndex)];
      if (outputValid(old, item) && payload.force !== true) continue;
      updateEpisode(seriesId, item.episodeIndex, { status: 'queued', stage: 'queued', progress: 0, error: '', batchId: null, srtPath: item.srtPath, srtFingerprint: item.srtFingerprint, analysisPath: item.analysisPath, completedAt: null });
      jobs.push(item);
    }
    if (!jobs.length) return { success: true, skipped: selected.length, batch: snapshot(seriesId) };
    const batch = { id: randomUUID(), seriesId, jobs, settings: { ...settings }, status: 'queued', controllers: new Map(), progress: new Map(), cancelled: false, createdAt: Date.now(), error: '' };
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

module.exports = { createAnalysisManager, fingerprint };
