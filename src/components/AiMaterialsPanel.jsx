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

// AI 发布素材只能建立在“最终成品”上。这个归一化层同时兼容旧版后端
// （只返回 ready/products）和新版分阶段状态，避免 UI 因为字段小差异误放行。
export function normalizePipelineGate(payload, episodes = []) {
  const empty = {
    ready: false,
    blockedReason: '尚未完成下载、去重、分割并生成最终成品',
    stages: {
      download: { status: 'blocked', count: 0, total: episodes.length },
      dedup: { status: 'blocked', done: 0, total: episodes.length },
      split: { status: 'blocked', groups: 0, total: 0 },
      final: { status: 'blocked', products: [] },
    },
    products: [],
    readyEpisodeIndices: [],
  };
  if (!payload || payload.success === false) {
    return { ...empty, blockedReason: payload?.error || empty.blockedReason };
  }
  const stages = payload.stages || {};
  const rawProducts = Array.isArray(payload.products)
    ? payload.products
    : Array.isArray(stages.final?.products)
      ? stages.final.products
      : Array.isArray(payload.final?.products)
        ? payload.final.products
        : [];
  const products = rawProducts.map((product, index) => ({
    ...product,
    id: String(product?.id || product?.productId || `final-${index + 1}`),
    episodeIndices: [
      ...new Set(
        (Array.isArray(product?.episodeIndices)
          ? product.episodeIndices
          : Array.isArray(product?.episode_indices)
            ? product.episode_indices
            : Array.isArray(product?.episodes)
              ? product.episodes
              : []
        )
          .map(Number)
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      ),
    ],
  }));
  const readyEpisodeIndices = [
    ...new Set(
      (Array.isArray(payload.readyEpisodeIndices)
        ? payload.readyEpisodeIndices
        : products.flatMap((product) => (Array.isArray(product?.episodeIndices) ? product.episodeIndices : []))
      )
        .map(Number)
        .filter((index) => Number.isSafeInteger(index) && index > 0),
    ),
  ];
  const explicitReady = payload.ready === true;
  const finalReady = ['completed', 'ready', 'done'].includes(String(stages.final?.status || '').toLowerCase());
  const ready = explicitReady && products.length > 0 && (finalReady || !stages.final?.status);
  return {
    ...empty,
    ...payload,
    stages: { ...empty.stages, ...stages, final: { ...empty.stages.final, ...(stages.final || {}), products } },
    products,
    readyEpisodeIndices,
    ready,
    blockedReason: ready
      ? ''
      : payload.blockedReason || (products.length ? '最终成品尚未全部就绪' : empty.blockedReason),
  };
}

const episodeNumber = (item) => Number(item?.episodeIndex || item?.vidIndex || item?.vid_index);
const taskKey = (task) => String(task?.id || `${task?.kind || 'copy'}:${task?.episodeIndex || ''}`);
const stageText = (task) =>
  STAGE_TEXT[task?.stage] || STAGE_TEXT[task?.status] || STATUS_TEXT[task?.status] || '处理中';
const statusClass = (task) => (['completed', 'failed', 'stopped'].includes(task?.status) ? task.status : 'running');

function mergeTaskList(previous, incoming) {
  const next = new Map((previous || []).map((task) => [taskKey(task), task]));
  for (const task of Array.isArray(incoming) ? incoming : [])
    next.set(taskKey(task), { ...next.get(taskKey(task)), ...task });
  return [...next.values()].sort(
    (a, b) => Number(a?.startedAt || a?.createdAt || 0) - Number(b?.startedAt || b?.createdAt || 0),
  );
}

export default function AiMaterialsPanel({
  seriesId,
  title,
  cover,
  aiCover = null,
  episodes = [],
  active = true,
  revision = 0,
  onNotify,
  onNavigate,
}) {
  const [tasks, setTasks] = useState([]);
  const [pipeline, setPipeline] = useState(() => normalizePipelineGate(null, episodes));
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copyRange, setCopyRange] = useState('');
  const [productSelection, setProductSelection] = useState(new Set());
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
    return () => {
      mounted.current = false;
    };
  }, [seriesId]);

  const loadPipeline = useCallback(async () => {
    if (!active) return;
    const handler = window.electronAPI?.getSeriesPipelineStatus;
    if (typeof handler !== 'function') {
      setPipeline(normalizePipelineGate({ success: false, error: '当前版本未提供流程状态，请更新应用' }, episodes));
      return;
    }
    setPipelineLoading(true);
    try {
      const result = await handler(seriesId);
      if (mounted.current && currentSeries.current === seriesId) setPipeline(normalizePipelineGate(result, episodes));
    } catch (err) {
      if (mounted.current && currentSeries.current === seriesId)
        setPipeline(normalizePipelineGate({ success: false, error: err.message || '读取流程状态失败' }, episodes));
    } finally {
      if (mounted.current && currentSeries.current === seriesId) setPipelineLoading(false);
    }
  }, [active, episodes, seriesId]);

  const downloadedEpisodes = useMemo(
    () =>
      episodes
        .filter(
          (ep) =>
            pipeline.readyEpisodeIndices.includes(Number(ep.vid_index)) &&
            !ep.locked &&
            Number.isSafeInteger(Number(ep.vid_index)),
        )
        .sort((a, b) => Number(a.vid_index) - Number(b.vid_index)),
    [episodes, pipeline.readyEpisodeIndices],
  );
  const maxEpisode = useMemo(
    () => downloadedEpisodes.reduce((max, ep) => Math.max(max, Number(ep.vid_index) || 0), 0),
    [downloadedEpisodes],
  );
  const products = pipeline.products;
  const selectedProducts = useMemo(
    () => products.filter((product) => productSelection.has(product.id)),
    [productSelection, products],
  );
  const selectedEpisodeIndices = useMemo(
    () =>
      [...new Set(selectedProducts.flatMap((product) => product.episodeIndices || []))]
        .filter((index) => pipeline.readyEpisodeIndices.includes(Number(index)))
        .sort((a, b) => a - b),
    [pipeline.readyEpisodeIndices, selectedProducts],
  );
  const selectedDownloaded = useMemo(
    () => downloadedEpisodes.filter((ep) => selectedEpisodeIndices.includes(Number(ep.vid_index))),
    [downloadedEpisodes, selectedEpisodeIndices],
  );
  useEffect(() => {
    if (!active || !products.length || autoSelectedSeries.current === String(seriesId)) return;
    autoSelectedSeries.current = String(seriesId);
    setProductSelection(new Set(products.map((product) => product.id)));
  }, [active, products, seriesId]);
  const copyTasks = tasks.filter((task) => task?.kind === 'episode-copy' || task?.kind === 'copy');
  const coverTasks = tasks.filter((task) => task?.kind === 'cover');
  const activeCopyTasks = copyTasks.filter((task) => !['completed', 'failed', 'stopped'].includes(task.status));
  const finishedCopyTasks = copyTasks.filter((task) => task.status === 'completed').length;
  const coverTask = coverTasks[coverTasks.length - 1];
  const coverPreview = coverTask?.coverUrl || aiCover?.coverUrl || null;
  const copyTaskOrder = useMemo(
    () =>
      [...copyTasks].sort((a, b) => {
        const aActive = !['completed', 'failed', 'stopped'].includes(a.status);
        const bActive = !['completed', 'failed', 'stopped'].includes(b.status);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return Number(a?.startedAt || a?.createdAt || 0) - Number(b?.startedAt || b?.createdAt || 0);
      }),
    [copyTasks],
  );
  const visibleCopyTasks = showAllCopyTasks
    ? copyTaskOrder
    : copyTaskOrder.slice(
        0,
        copyTaskOrder.filter((task) => !['completed', 'failed', 'stopped'].includes(task.status)).length + 80,
      );
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

  useEffect(() => {
    loadTasks();
    loadPipeline();
  }, [loadTasks, loadPipeline, revision]);

  useEffect(() => {
    if (!active || typeof window.electronAPI?.onAiMaterialProgress !== 'function') return undefined;
    return window.electronAPI.onAiMaterialProgress((task = {}) => {
      if (!mounted.current || currentSeries.current !== seriesId || String(task.seriesId) !== String(seriesId)) return;
      setTasks((previous) => mergeTaskList(previous, [task]));
    });
  }, [active, seriesId]);

  const applyCopyRange = (expression) => {
    try {
      const indexes = parseEpisodeRange(expression, maxEpisode);
      const selected = new Set(
        products
          .filter((product) => product.episodeIndices.some((index) => indexes.has(Number(index))))
          .map((product) => product.id),
      );
      setProductSelection(selected);
      setRangeError('');
    } catch (err) {
      setRangeError(err.message || '集数格式不正确');
    }
  };

  const startCover = async () => {
    if (
      !active ||
      !pipeline.ready ||
      !pipeline.products.length ||
      coverBusyRef.current ||
      typeof window.electronAPI?.aiGenerateCover !== 'function'
    )
      return;
    coverBusyRef.current = true;
    setCoverBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.aiGenerateCover({
        seriesId,
        seriesTitle: title,
        title,
        cover,
        productIds: pipeline.products.map((product) => product.id).filter(Boolean),
      });
      if (!result?.success) throw new Error(result?.error || '封面任务提交失败');
      if (result.task) setTasks((previous) => mergeTaskList(previous, [result.task]));
      onNotify?.('封面重绘任务已加入素材队列');
    } catch (err) {
      if (mounted.current) setError(`封面重绘失败：${err.message || '请重试'}`);
    } finally {
      coverBusyRef.current = false;
      if (mounted.current) setCoverBusy(false);
    }
  };

  const startCopies = async () => {
    if (!active || !pipeline.ready || copyBusyRef.current) return;
    const selected = selectedProducts
      .flatMap((product) => product.episodeIndices || [])
      .map(Number)
      .filter(Number.isSafeInteger);
    const productIds = selectedProducts.map((product) => product.id).filter(Boolean);
    if (!productIds.length) return;
    const handler = window.electronAPI?.aiStartCopies;
    if (typeof handler !== 'function') {
      setError('当前版本未提供批量 AI 文案任务接口，请更新应用。');
      return;
    }
    copyBusyRef.current = true;
    setCopyBusy(true);
    setError('');
    try {
      const result = await handler({ seriesId, episodeIndices: selected, productIds, force: false });
      if (!result?.success) throw new Error(result?.error || '文案任务提交失败');
      if (Array.isArray(result.tasks)) setTasks((previous) => mergeTaskList(previous, result.tasks));
      const queued = Number(result.queued) || 0;
      const submitted = Array.isArray(result.tasks) ? result.tasks.length : queued;
      const cached = Array.isArray(result.cached) ? result.cached.length : 0;
      onNotify?.(
        cached ? `新增 ${submitted} 个作品文案任务，已跳过 ${cached} 个已有素材` : `已加入 ${submitted} 个作品文案任务`,
      );
    } catch (err) {
      if (mounted.current) setError(`文案任务提交失败：${err.message || '请重试'}`);
    } finally {
      copyBusyRef.current = false;
      if (mounted.current) setCopyBusy(false);
    }
  };

  const cancelTask = async (task) => {
    if (!task?.id || typeof window.electronAPI?.cancelAiMaterial !== 'function') return;
    try {
      const result = await window.electronAPI.cancelAiMaterial(task.id);
      if (!result?.success) throw new Error(result?.error || '取消失败');
    } catch (err) {
      if (mounted.current) setError(`取消失败：${err.message || '请重试'}`);
    }
  };

  const retryTask = async (task) => {
    if (!task || ['failed', 'stopped'].includes(task.status) === false) return;
    if (task.kind === 'cover') return startCover();
    const index = episodeNumber(task);
    if (!index || typeof window.electronAPI?.aiStartCopies !== 'function') return;
    try {
      const productId = task.productId || products.find((product) => product.episodeIndices.includes(index))?.id;
      const result = await window.electronAPI.aiStartCopies({
        seriesId,
        episodeIndices: [index],
        productIds: productId ? [productId] : [],
        force: true,
      });
      if (!result?.success) throw new Error(result?.error || '重试失败');
      if (Array.isArray(result.tasks)) setTasks((previous) => mergeTaskList(previous, result.tasks));
    } catch (err) {
      if (mounted.current) setError(`重试失败：${err.message || '请重试'}`);
    }
  };

  const openOutput = async (task) => {
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

  const renderTask = (task) => {
    const isDone = task.status === 'completed';
    const canStop = !['completed', 'failed', 'stopped'].includes(task.status);
    const index = episodeNumber(task);
    const product = task.productId ? products.find((item) => String(item.id) === String(task.productId)) : null;
    const productRange = product?.episodeIndices?.length
      ? `第 ${product.episodeIndices[0]}${product.episodeIndices.length > 1 ? `-${product.episodeIndices[product.episodeIndices.length - 1]}` : ''} 集`
      : `第 ${index || '?'} 集`;
    const label = task.kind === 'cover' ? '剧集封面' : `${product?.title || task.productTitle || productRange}文案`;
    const progress = Number(task.progress);
    const elapsed = Number(task.elapsedSeconds);
    const runningMessage =
      Number.isFinite(elapsed) && elapsed >= 0
        ? `已运行 ${elapsed} 秒 · ${stageText(task)}${Number.isFinite(progress) && progress > 0 ? ` · 阶段进度 ${Math.round(progress)}%` : ''}`
        : '后台处理中，离开此页面不会中断';
    return (
      <div className={`aim-task ${statusClass(task)}`} key={taskKey(task)}>
        <div className="aim-task-main">
          <div className="aim-task-title">
            <span>{label}</span>
            <b>{stageText(task)}</b>
          </div>
          <div className="aim-task-meta">
            {task.status === 'failed'
              ? task.error || '处理失败'
              : task.status === 'stopped'
                ? '已取消，可重试'
                : task.status === 'completed'
                  ? `完成于 ${new Date(task.completedAt || task.updatedAt || Date.now()).toLocaleTimeString()}`
                  : runningMessage}
          </div>
          {Number.isFinite(progress) && progress > 0 && (
            <div className="aim-progress" aria-label={`阶段进度 ${Math.round(Math.min(100, progress))}%`}>
              <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
            </div>
          )}
        </div>
        <div className="aim-task-actions">
          {isDone && (
            <button className="btn btn-ghost btn-sm" onClick={() => openOutput(task)}>
              <Folder size={14} />
              打开输出
            </button>
          )}
          {['failed', 'stopped'].includes(task.status) && (
            <button className="btn btn-ghost btn-sm" onClick={() => retryTask(task)}>
              <RefreshCw size={14} />
              重试
            </button>
          )}
          {canStop && (
            <button className="icon-btn" title="取消任务" onClick={() => cancelTask(task)}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!active && !tasks.length) return null;
  const gateLabel = pipelineLoading
    ? '正在核验流程状态…'
    : pipeline.ready
      ? `已生成 ${pipeline.products.length} 个最终成品，可处理发布素材`
      : `暂不可操作：${pipeline.blockedReason}`;
  const nextAction = () => {
    const downloadDone = Number(pipeline.stages?.download?.done || 0);
    const dedupDone = Number(pipeline.stages?.dedup?.done || 0);
    if (!downloadDone) document.querySelector('.sep-grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (dedupDone < downloadDone) onNavigate?.('quchong', { seriesId, title });
    else document.getElementById('dm-merge-action')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const nextActionLabel = !Number(pipeline.stages?.download?.done || 0)
    ? '先下载视频'
    : Number(pipeline.stages?.dedup?.done || 0) < Number(pipeline.stages?.download?.done || 0)
      ? '去视频处理'
      : '去分组并生成成品';
  return (
    <section className="ai-materials-panel" aria-label="AI 发布素材">
      <div className="aim-header">
        <div>
          <div className="aim-title">
            <Sparkles size={17} />
            AI 发布素材
          </div>
          <p>仅对已完成下载、去重、分割并生成的最终成品处理，任务独立排队。</p>
        </div>
        <button
          className="icon-btn"
          title="刷新流程和 AI 任务"
          onClick={() => {
            loadTasks();
            loadPipeline();
          }}
          disabled={loading || pipelineLoading}
        >
          <RefreshCw size={15} className={loading || pipelineLoading ? 'spin' : ''} />
        </button>
      </div>
      <div className={`aim-gate ${pipeline.ready ? 'aim-gate-ready' : 'aim-gate-blocked'}`} role="status">
        <div className="aim-gate-title">
          <span className="aim-gate-dot" />
          流程门禁：{pipeline.ready ? '已就绪' : '未就绪'}
        </div>
        <div className="aim-gate-message">{gateLabel}</div>
        <div className="aim-gate-stages">
          {['download', 'dedup', 'split', 'final'].map((stage) => {
            const value = pipeline.stages?.[stage] || {};
            const label = { download: '下载', dedup: '去重', split: '分割/拼接', final: '最终成品' }[stage];
            const doneStatus = ['completed', 'ready', 'done'].includes(String(value.status || '').toLowerCase());
            const doneCount = Number(value.done);
            const totalCount = Number(value.total);
            const done =
              doneStatus ||
              (Number.isFinite(doneCount) && Number.isFinite(totalCount) && totalCount > 0 && doneCount >= totalCount);
            return (
              <span className={done ? 'done' : ''} key={stage}>
                {done ? '✓' : '○'} {label}
              </span>
            );
          })}
        </div>
      </div>
      {!pipeline.ready && (
        <div className="aim-next-step">
          <span>完成当前步骤后，这里会自动开放封面和文案。</span>
          <button className="btn btn-outline btn-sm" onClick={nextAction} disabled={pipelineLoading}>
            {nextActionLabel}
          </button>
        </div>
      )}
      {pipeline.ready && (
        <div className="aim-sections">
          <div className="aim-section">
            <div className="aim-section-head">
              <div>
                <b>剧集封面</b>
                <span>最终成品就绪后重绘，保存到发布素材/封面</span>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={startCover}
                disabled={coverBusy || !active || !pipeline.ready || !pipeline.products.length}
              >
                <Sparkles size={14} className={coverBusy ? 'spin' : ''} />
                {coverBusy ? '提交中…' : pipeline.ready ? '重绘封面' : '完成成品后可用'}
              </button>
            </div>
            {coverPreview && <img className="aim-cover-preview" src={coverPreview} alt="AI 重绘封面预览" />}
            {coverTask && <div className="aim-task-list">{renderTask(coverTask)}</div>}
          </div>
          <div className="aim-section">
            <div className="aim-section-head">
              <div>
                <b>成品发布文案</b>
                <span>只处理已完成去重、分组和导出的最终作品，转写、概括、保存分阶段显示</span>
              </div>
              <b className="aim-count">
                {finishedCopyTasks}/{copyTasks.length || 0} 已完成
              </b>
            </div>
            <div className="aim-range-row">
              <input
                className="input-field"
                aria-label="选择文案集数"
                placeholder="集数范围，如 1-20 或 1,3,5"
                value={copyRange}
                disabled={!active || !pipeline.ready || !downloadedEpisodes.length}
                onChange={(event) => setCopyRange(event.target.value)}
                onKeyDown={(event) => {
                  if (isSubmitKey(event)) applyCopyRange(copyRange);
                }}
              />
              <button
                className="btn btn-outline btn-sm"
                disabled={!active || !pipeline.ready || !downloadedEpisodes.length}
                onClick={() => applyCopyRange(copyRange)}
              >
                应用
              </button>
            </div>
            <div className="aim-presets">
              <button
                className="btn btn-ghost btn-sm"
                disabled={!pipeline.ready || !products.length}
                onClick={() => setProductSelection(new Set(products.map((product) => product.id)))}
              >
                全部成品
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={!pipeline.ready || !downloadedEpisodes.length}
                onClick={() => applyCopyRange('1-10')}
              >
                前10集
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={!productSelection.size}
                onClick={() => setProductSelection(new Set())}
              >
                清空
              </button>
              <span>
                已选 {selectedProducts.length} 个作品 · {selectedDownloaded.length} 集
              </span>
            </div>
            {!!products.length && (
              <div className="aim-products" aria-label="最终成品列表">
                {products.map((product) => {
                  const checked = productSelection.has(product.id);
                  const rangeText = product.episodeIndices.length
                    ? `第 ${product.episodeIndices[0]}${product.episodeIndices.length > 1 ? `-${product.episodeIndices[product.episodeIndices.length - 1]}` : ''} 集`
                    : '集数待定';
                  return (
                    <button
                      type="button"
                      key={product.id}
                      className={`aim-product ${checked ? 'selected' : ''}`}
                      aria-pressed={checked}
                      onClick={() =>
                        setProductSelection((previous) => {
                          const next = new Set(previous);
                          if (next.has(product.id)) next.delete(product.id);
                          else next.add(product.id);
                          return next;
                        })
                      }
                    >
                      <span className="aim-product-check">{checked ? '✓' : '○'}</span>
                      <span className="aim-product-copy">
                        <b>{product.title || `最终成品 ${product.id}`}</b>
                        <small>
                          {rangeText}
                          {product.path ? ` · ${product.path.split(/[\\/]/).pop()}` : ''}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {rangeError && (
              <div className="aim-error">
                <AlertCircle size={14} />
                {rangeError}
              </div>
            )}
            <button
              className="btn btn-primary aim-start-copy"
              disabled={!active || !pipeline.ready || copyBusy || !selectedProducts.length}
              onClick={startCopies}
            >
              <Sparkles size={15} />
              {copyBusy
                ? '提交中…'
                : pipeline.ready
                  ? `生成选中文案 (${selectedProducts.length} 个作品)`
                  : '完成最终成品后可用'}
            </button>
            {activeCopyTasks.length > 0 && (
              <p className="aim-live">
                当前处理中 {activeCopyTasks.length} 个作品，完成 {finishedCopyTasks} 个作品
              </p>
            )}
            {!!copyTasks.length && (
              <>
                <div className="aim-task-list">{visibleCopyTasks.map(renderTask)}</div>
                <div className="aim-task-history">
                  <span>共 {copyTasks.length} 个文案任务</span>
                  {hiddenCopyTaskCount > 0 && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowAllCopyTasks(true)}>
                      显示全部（还有 {hiddenCopyTaskCount} 个）
                    </button>
                  )}
                  {showAllCopyTasks && hiddenCopyTaskCount === 0 && copyTasks.length > 80 && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowAllCopyTasks(false)}>
                      收起历史
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="aim-error" role="alert">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
    </section>
  );
}
