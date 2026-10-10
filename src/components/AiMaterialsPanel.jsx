import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Folder, RefreshCw, Sparkles, X } from './icons';
import { isSubmitKey, parseEpisodeRange } from './episodeRange';
import './AiMaterialsPanel.css';

const STAGE_TEXT = {
  queued: '排队中',
  running: '处理中',
  extracting: '提取音频',
  transcribing: '转写字幕',
  summarizing: 'AI 概括',
  generating: '生成封面',
  saving: '保存素材',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_TEXT = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', stopped: '已停止' };

const episodeNumber = item => Number(item?.episodeIndex || item?.vidIndex || item?.vid_index);
const taskKey = task => String(task?.id || `${task?.kind || 'copy'}:${task?.episodeIndex || ''}`);
const stageText = task => STAGE_TEXT[task?.stage] || STAGE_TEXT[task?.status] || STATUS_TEXT[task?.status] || '处理中';
const statusClass = task => ['completed', 'failed', 'stopped'].includes(task?.status) ? task.status : 'running';

function mergeTaskList(previous, incoming) {
  const next = new Map((previous || []).map(task => [taskKey(task), task]));
  for (const task of Array.isArray(incoming) ? incoming : []) next.set(taskKey(task), { ...next.get(taskKey(task)), ...task });
  return [...next.values()].sort((a, b) => Number(a?.startedAt || a?.createdAt || 0) - Number(b?.startedAt || b?.createdAt || 0));
}

export default function AiMaterialsPanel({ seriesId, title, cover, aiCover = null, episodes = [], active = true, revision = 0, onNotify }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [copyRange, setCopyRange] = useState('');
  const [copySelection, setCopySelection] = useState(new Set());
  const [rangeError, setRangeError] = useState('');
  const [error, setError] = useState('');
  const [coverBusy, setCoverBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [showAllCopyTasks, setShowAllCopyTasks] = useState(false);
  const coverBusyRef = useRef(false);
  const copyBusyRef = useRef(false);
  const autoSelectedSeries = useRef('');
  const mounted = useRef(true);
  const currentSeries = useRef(seriesId);

  useEffect(() => {
    mounted.current = true;
    currentSeries.current = seriesId;
    return () => { mounted.current = false; };
  }, [seriesId]);

  const downloadedEpisodes = useMemo(
    () => episodes.filter(ep => ep.status === 'completed' && !ep.locked && Number.isSafeInteger(Number(ep.vid_index)))
      .sort((a, b) => Number(a.vid_index) - Number(b.vid_index)),
    [episodes],
  );
  const maxEpisode = useMemo(() => episodes.reduce((max, ep) => Math.max(max, Number(ep.vid_index) || 0), 0), [episodes]);
  const selectedDownloaded = useMemo(
    () => downloadedEpisodes.filter(ep => copySelection.has(Number(ep.vid_index))),
    [copySelection, downloadedEpisodes],
  );
  useEffect(() => {
    if (!active || !downloadedEpisodes.length || autoSelectedSeries.current === String(seriesId)) return;
    autoSelectedSeries.current = String(seriesId);
    setCopySelection(new Set(downloadedEpisodes.map(ep => Number(ep.vid_index))));
  }, [active, downloadedEpisodes, seriesId]);
  const copyTasks = tasks.filter(task => task?.kind === 'episode-copy' || task?.kind === 'copy');
  const coverTasks = tasks.filter(task => task?.kind === 'cover');
  const activeCopyTasks = copyTasks.filter(task => !['completed', 'failed', 'stopped'].includes(task.status));
  const finishedCopyTasks = copyTasks.filter(task => task.status === 'completed').length;
  const coverTask = coverTasks[coverTasks.length - 1];
  const coverPreview = coverTask?.coverUrl || aiCover?.coverUrl || null;
  const copyTaskOrder = useMemo(() => [...copyTasks].sort((a, b) => {
    const aActive = !['completed', 'failed', 'stopped'].includes(a.status);
    const bActive = !['completed', 'failed', 'stopped'].includes(b.status);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return Number(a?.startedAt || a?.createdAt || 0) - Number(b?.startedAt || b?.createdAt || 0);
  }), [copyTasks]);
  const visibleCopyTasks = showAllCopyTasks ? copyTaskOrder : copyTaskOrder.slice(0, copyTaskOrder.filter(task => !['completed', 'failed', 'stopped'].includes(task.status)).length + 80);
  const hiddenCopyTaskCount = Math.max(0, copyTaskOrder.length - visibleCopyTasks.length);

  const loadTasks = useCallback(async () => {
    if (!active || typeof window.electronAPI?.getAiMaterialTasks !== 'function') return;
    setLoading(true);
    setError('');
    try {
      const result = await window.electronAPI.getAiMaterialTasks({ seriesId });
      if (!mounted.current || currentSeries.current !== seriesId) return;
      if (!result?.success) throw new Error(result?.error || '读取 AI 素材任务失败');
      setTasks(Array.isArray(result.tasks) ? result.tasks : []);
    } catch (err) {
      if (mounted.current && currentSeries.current === seriesId) setError(err.message || '读取 AI 素材任务失败');
    } finally {
      if (mounted.current && currentSeries.current === seriesId) setLoading(false);
    }
  }, [active, seriesId]);

  useEffect(() => { loadTasks(); }, [loadTasks, revision]);

  useEffect(() => {
    if (!active || typeof window.electronAPI?.onAiMaterialProgress !== 'function') return undefined;
    return window.electronAPI.onAiMaterialProgress((task = {}) => {
      if (!mounted.current || currentSeries.current !== seriesId || String(task.seriesId) !== String(seriesId)) return;
      setTasks(previous => mergeTaskList(previous, [task]));
    });
  }, [active, seriesId]);

  const applyCopyRange = expression => {
    try {
      const indexes = parseEpisodeRange(expression, maxEpisode);
      const selected = new Set(downloadedEpisodes.filter(ep => indexes.has(Number(ep.vid_index))).map(ep => Number(ep.vid_index)));
      setCopySelection(selected);
      setRangeError('');
    } catch (err) {
      setRangeError(err.message || '集数格式不正确');
    }
  };

  const startCover = async () => {
    if (!active || coverBusyRef.current || typeof window.electronAPI?.aiGenerateCover !== 'function') return;
    coverBusyRef.current = true;
    setCoverBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.aiGenerateCover({ seriesId, seriesTitle: title, title, cover });
      if (!result?.success) throw new Error(result?.error || '封面任务提交失败');
      if (result.task) setTasks(previous => mergeTaskList(previous, [result.task]));
      onNotify?.('封面重绘任务已加入素材队列');
    } catch (err) {
      if (mounted.current) setError(`封面重绘失败：${err.message || '请重试'}`);
    } finally {
      coverBusyRef.current = false;
      if (mounted.current) setCoverBusy(false);
    }
  };

  const startCopies = async () => {
    if (!active || copyBusyRef.current) return;
    const selected = selectedDownloaded.map(ep => Number(ep.vid_index));
    if (!selected.length) return;
    const handler = window.electronAPI?.aiStartCopies;
    if (typeof handler !== 'function') {
      setError('当前版本未提供批量 AI 文案任务接口，请更新应用。');
      return;
    }
    copyBusyRef.current = true;
    setCopyBusy(true);
    setError('');
    try {
      const result = await handler({ seriesId, episodeIndices: selected, force: false });
      if (!result?.success) throw new Error(result?.error || '文案任务提交失败');
      if (Array.isArray(result.tasks)) setTasks(previous => mergeTaskList(previous, result.tasks));
      const queued = Number(result.queued) || 0;
      const submitted = Array.isArray(result.tasks) ? result.tasks.length : queued;
      const cached = Array.isArray(result.cached) ? result.cached.length : 0;
      onNotify?.(cached ? `新增 ${submitted} 集文案任务，已跳过 ${cached} 集已有素材` : `已加入 ${submitted} 集文案任务`);
    } catch (err) {
      if (mounted.current) setError(`文案任务提交失败：${err.message || '请重试'}`);
    } finally {
      copyBusyRef.current = false;
      if (mounted.current) setCopyBusy(false);
    }
  };

  const cancelTask = async task => {
    if (!task?.id || typeof window.electronAPI?.cancelAiMaterial !== 'function') return;
    try {
      const result = await window.electronAPI.cancelAiMaterial(task.id);
      if (!result?.success) throw new Error(result?.error || '取消失败');
    } catch (err) {
      if (mounted.current) setError(`取消失败：${err.message || '请重试'}`);
    }
  };

  const retryTask = async task => {
    if (!task || ['failed', 'stopped'].includes(task.status) === false) return;
    if (task.kind === 'cover') return startCover();
    const index = episodeNumber(task);
    if (!index || typeof window.electronAPI?.aiStartCopies !== 'function') return;
    try {
      const result = await window.electronAPI.aiStartCopies({ seriesId, episodeIndices: [index], force: true });
      if (!result?.success) throw new Error(result?.error || '重试失败');
      if (Array.isArray(result.tasks)) setTasks(previous => mergeTaskList(previous, result.tasks));
    } catch (err) {
      if (mounted.current) setError(`重试失败：${err.message || '请重试'}`);
    }
  };

  const openOutput = async task => {
    const api = window.electronAPI || {};
    try {
      if (typeof api.openAiMaterial === 'function' && task.id) {
        const result = await api.openAiMaterial(task.id);
        if (result?.success) return;
        throw new Error(result?.error || '打开素材失败');
      }
      const filePath = task.textPath || task.transcriptPath || task.path || task.outputPath;
      if (filePath && typeof api.showInFolder === 'function') {
        const result = await api.showInFolder(filePath);
        if (result?.success) return;
      }
      throw new Error('输出文件尚未生成');
    } catch (err) {
      if (mounted.current) setError(`打开素材失败：${err.message || '请重试'}`);
    }
  };

  const renderTask = task => {
    const isDone = task.status === 'completed';
    const canStop = !['completed', 'failed', 'stopped'].includes(task.status);
    const index = episodeNumber(task);
    const label = task.kind === 'cover' ? '剧集封面' : `第 ${index || '?'} 集文案`;
    const progress = Number(task.progress);
    const elapsed = Number(task.elapsedSeconds);
    const runningMessage = Number.isFinite(elapsed) && elapsed >= 0
      ? `已运行 ${elapsed} 秒 · ${stageText(task)}${Number.isFinite(progress) && progress > 0 ? ` · 阶段进度 ${Math.round(progress)}%` : ''}`
      : '后台处理中，离开此页面不会中断';
    return <div className={`aim-task ${statusClass(task)}`} key={taskKey(task)}>
      <div className="aim-task-main">
        <div className="aim-task-title"><span>{label}</span><b>{stageText(task)}</b></div>
        <div className="aim-task-meta">{task.status === 'failed' ? (task.error || '处理失败') : task.status === 'stopped' ? '已取消，可重试' : task.status === 'completed' ? `完成于 ${new Date(task.completedAt || task.updatedAt || Date.now()).toLocaleTimeString()}` : runningMessage}</div>
        {Number.isFinite(progress) && progress > 0 && <div className="aim-progress" aria-label={`阶段进度 ${Math.round(Math.min(100, progress))}%`}><span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>}
      </div>
      <div className="aim-task-actions">
        {isDone && <button className="btn btn-ghost btn-sm" onClick={() => openOutput(task)}><Folder size={14} />打开输出</button>}
        {['failed', 'stopped'].includes(task.status) && <button className="btn btn-ghost btn-sm" onClick={() => retryTask(task)}><RefreshCw size={14} />重试</button>}
        {canStop && <button className="icon-btn" title="取消任务" onClick={() => cancelTask(task)}><X size={14} /></button>}
      </div>
    </div>;
  };

  if (!active && !tasks.length) return null;
  return <section className="ai-materials-panel" aria-label="AI 发布素材">
    <div className="aim-header">
      <div><div className="aim-title"><Sparkles size={17} />AI 发布素材</div><p>封面重绘与分集文案独立排队，下载和素材处理互不阻塞。</p></div>
      <button className="icon-btn" title="刷新 AI 任务" onClick={loadTasks} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
    </div>
    <div className="aim-sections">
      <div className="aim-section">
        <div className="aim-section-head"><div><b>剧集封面</b><span>重绘后保存到发布素材/封面</span></div><button className="btn btn-outline btn-sm" onClick={startCover} disabled={coverBusy || !active}><Sparkles size={14} className={coverBusy ? 'spin' : ''} />{coverBusy ? '提交中…' : '重绘封面'}</button></div>
        {coverPreview && <img className="aim-cover-preview" src={coverPreview} alt="AI 重绘封面预览" />}
        {coverTask && <div className="aim-task-list">{renderTask(coverTask)}</div>}
      </div>
      <div className="aim-section">
        <div className="aim-section-head"><div><b>分集发布文案</b><span>只处理已下载集，转写、概括、保存分阶段显示</span></div><b className="aim-count">{finishedCopyTasks}/{copyTasks.length || 0} 已完成</b></div>
        <div className="aim-range-row"><input className="input-field" aria-label="选择文案集数" placeholder="集数范围，如 1-20 或 1,3,5" value={copyRange} disabled={!active || !downloadedEpisodes.length} onChange={event => setCopyRange(event.target.value)} onKeyDown={event => { if (isSubmitKey(event)) applyCopyRange(copyRange); }} /><button className="btn btn-outline btn-sm" disabled={!active || !downloadedEpisodes.length} onClick={() => applyCopyRange(copyRange)}>应用</button></div>
        <div className="aim-presets"><button className="btn btn-ghost btn-sm" disabled={!downloadedEpisodes.length} onClick={() => setCopySelection(new Set(downloadedEpisodes.map(ep => Number(ep.vid_index))))}>全部已下载</button><button className="btn btn-ghost btn-sm" disabled={!downloadedEpisodes.length} onClick={() => applyCopyRange('1-10')}>前10集</button><button className="btn btn-ghost btn-sm" disabled={!copySelection.size} onClick={() => setCopySelection(new Set())}>清空</button><span>已选 {selectedDownloaded.length} 集</span></div>
        {rangeError && <div className="aim-error"><AlertCircle size={14} />{rangeError}</div>}
        <button className="btn btn-primary aim-start-copy" disabled={!active || copyBusy || !selectedDownloaded.length} onClick={startCopies}><Sparkles size={15} />{copyBusy ? '提交中…' : `生成选中文案 (${selectedDownloaded.length})`}</button>
        {activeCopyTasks.length > 0 && <p className="aim-live">当前处理中 {activeCopyTasks.length} 集，完成 {finishedCopyTasks} 集</p>}
        {!!copyTasks.length && <>
          <div className="aim-task-list">{visibleCopyTasks.map(renderTask)}</div>
          <div className="aim-task-history"><span>共 {copyTasks.length} 个文案任务</span>{hiddenCopyTaskCount > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setShowAllCopyTasks(true)}>显示全部（还有 {hiddenCopyTaskCount} 个）</button>}{showAllCopyTasks && hiddenCopyTaskCount === 0 && copyTasks.length > 80 && <button className="btn btn-ghost btn-sm" onClick={() => setShowAllCopyTasks(false)}>收起历史</button>}</div>
        </>}
      </div>
    </div>
    {error && <div className="aim-error" role="alert"><AlertCircle size={14} />{error}</div>}
  </section>;
}
