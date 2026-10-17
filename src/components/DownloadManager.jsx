import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import { downloadSeriesKey, groupDownloadSeries, formatSeriesUpdatedAt } from './downloadSeries.mjs';
import SeriesEpisodePanel from './SeriesEpisodePanel';
import './Browse.css';
import './DownloadManager.css';
import { Download, Trash2, RefreshCw, Film, Folder, Check, CheckSquare, ChevronRight, Search, Activity } from './icons';

const STATUS_TEXT = {
  pending: '等待中',
  downloading: '下载中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_ORDER = {
  downloading: 0,
  pending: 1,
  failed: 2,
  stopped: 3,
  completed: 4,
};

const DEDUP_STAGE_TEXT = {
  probing: '读取视频',
  encoding: '编码中',
  finalizing: '写入 MP4 索引',
  validating: '校验输出',
  saving: '保存文件',
};

const DEDUP_ACTIVE_STATES = new Set(['running', 'processing']);
const DEDUP_QUEUED_STATES = new Set(['pending', 'queued']);
const DEDUP_FINISHED_STATES = new Set(['completed']);
const DEDUP_MAX_CONCURRENCY = 8;
const VIDEO_PAGE_SIZE_OPTIONS = [20, 50, 100, 200];
const SERIES_PAGE_SIZE_OPTIONS = [10, 20, 30, 50];

function PaginationControls({ ariaLabel, page, pageCount, pageSize, pageSizeOptions, onPageChange, onPageSizeChange }) {
  const [jump, setJump] = useState('');
  const currentPage = Math.min(Math.max(Number(page) || 1, 1), pageCount);
  const submitJump = () => {
    const value = Number.parseInt(jump, 10);
    if (!Number.isFinite(value)) return;
    onPageChange(Math.min(Math.max(value, 1), pageCount));
    setJump('');
  };
  return (
    <nav className="dm-pagination-controls" aria-label={ariaLabel}>
      <label className="dm-page-size">
        每页
        <select
          aria-label="每页条数"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {pageSizeOptions.map((value) => (
            <option key={value} value={value}>
              {value} 条
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn btn-outline btn-sm"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        上一页
      </button>
      <span>
        第 {currentPage} / {pageCount} 页
      </span>
      <label className="dm-page-jump">
        跳至
        <input
          aria-label="跳转页码"
          type="number"
          min="1"
          max={pageCount}
          value={jump}
          placeholder={String(currentPage)}
          onChange={(event) => setJump(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitJump();
          }}
        />
      </label>
      <button className="btn btn-outline btn-sm" onClick={submitJump} disabled={!jump.trim()}>
        跳转
      </button>
      <button
        className="btn btn-outline btn-sm"
        disabled={currentPage >= pageCount}
        onClick={() => onPageChange(currentPage + 1)}
      >
        下一页
      </button>
    </nav>
  );
}

function normalizeDedupJobs(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(DEDUP_MAX_CONCURRENCY, Math.round(number)));
}

function dedupRuntimeState(task) {
  return String(task?.status || task?.stage || '').toLowerCase();
}

function dedupPathKey(value) {
  const text = String(value || '')
    .replace(/\\/g, '/')
    .trim();
  return text ? text.replace(/^([a-zA-Z]):/, (_, letter) => `${letter.toUpperCase()}:`).toLowerCase() : '';
}

function sortTasks(list) {
  const key = (task) =>
    task.hongguoInfo?.series_id != null ? `series:${task.hongguoInfo.series_id}` : `task:${task.id}`;
  const groups = new Map();
  for (const task of list) {
    const group = groups.get(key(task)) || { rank: 99, time: 0 };
    group.rank = Math.min(group.rank, STATUS_ORDER[task.status] ?? 99);
    group.time = Math.max(group.time, task.startTime || 0);
    groups.set(key(task), group);
  }
  return [...list].sort((a, b) => {
    const ka = key(a),
      kb = key(b),
      ga = groups.get(ka),
      gb = groups.get(kb);
    if (ka !== kb) return ga.rank - gb.rank || gb.time - ga.time || ka.localeCompare(kb, 'zh-CN', { numeric: true });
    return (
      (Number(a.hongguoInfo?.vid_index) || 0) - (Number(b.hongguoInfo?.vid_index) || 0) ||
      (a.startTime || 0) - (b.startTime || 0)
    );
  });
}

function fmtElapsed(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value < 60
    ? `${value} 秒`
    : value < 3600
      ? `${Math.floor(value / 60)} 分 ${value % 60} 秒`
      : `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分`;
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function TranscriptionPanel({
  seriesId,
  active,
  status,
  analysis,
  runtime,
  onStart,
  onCancel,
  onAnalyze,
  onCancelAnalysis,
}) {
  const counts = status?.counts || {};
  const total = Number(counts.total) || 0;
  const completed = Number(counts.completed) || 0;
  const running = Number(counts.running) || 0;
  const queued = Number(counts.queued) || 0;
  const stopping = status?.status === 'stopping';
  const busy = ['queued', 'running', 'stopping'].includes(String(status?.status || ''));
  const analysisCounts = analysis?.counts || {};
  const analysisTotal = Number(analysisCounts.total) || 0;
  const analysisCompleted = Number(analysisCounts.completed) || 0;
  const analysisBusy = ['queued', 'running'].includes(String(analysis?.status || ''));
  const runtimeText = runtime?.available
    ? `${runtime.device === 'cuda' ? 'CUDA' : 'CPU'} · ${runtime.computeType} · ${runtime.model}`
    : runtime?.message || '未检查 faster-whisper 环境';
  return (
    <section className="dm-transcription-card" aria-label="完整字幕识别">
      <div className="dm-transcription-head">
        <div className="dm-transcription-title">
          <Activity size={17} />
          <div>
            <b>完整字幕识别</b>
            <span>识别去重视频的完整对白，逐词对齐并校验时间轴后保存 SRT。</span>
          </div>
        </div>
        <span
          className={`dm-transcription-state ${busy ? 'is-running' : completed === total && total > 0 ? 'is-done' : ''}`}
        >
          {stopping ? '停止中' : busy ? '处理中' : completed === total && total > 0 ? '已完成' : '待开始'}
        </span>
      </div>
      <div className="dm-transcription-meta">
        <span>
          已识别 <b>{completed}</b> / {total} 集
        </span>
        {running > 0 && <span>正在处理 {running} 集</span>}
        {queued > 0 && <span>排队 {queued} 集</span>}
        <span className={runtime?.available ? '' : 'is-warning'}>运行环境：{runtimeText}</span>
      </div>
      <div className="dm-transcription-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={onStart}
          disabled={!active || busy || analysisBusy || total === 0}
        >
          {busy ? '识别中…' : completed === total && total > 0 ? '重新识别' : '开始识别完整字幕'}
        </button>
        {busy && (
          <button className="btn btn-outline btn-sm" onClick={onCancel} disabled={stopping}>
            {stopping ? '等待进程退出…' : '停止'}
          </button>
        )}
        {status?.error && <span className="dm-transcription-error">{status.error}</span>}
      </div>
      <div className="dm-analysis-divider" />
      <div className="dm-analysis-line">
        <span>
          <b>剧情分析</b>：已生成 {analysisCompleted} / {analysisTotal} 集
        </span>
        <button
          className="btn btn-outline btn-sm"
          onClick={onAnalyze}
          disabled={!active || busy || analysisBusy || analysisTotal === 0 || completed < total}
        >
          {analysisBusy
            ? '分析中…'
            : analysisCompleted === analysisTotal && analysisTotal > 0
              ? '重新生成分析'
              : '生成剧情分析'}
        </button>
        {analysisBusy && (
          <button className="btn btn-outline btn-sm" onClick={onCancelAnalysis}>
            停止
          </button>
        )}
        {analysis?.error && <span className="dm-transcription-error">{analysis.error}</span>}
      </div>
    </section>
  );
}

function DownloadManager({ onNavigate, active = true, target = null }) {
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [queue, setQueue] = useState({ active: 0, queued: 0, maxConcurrent: 3 });
  const [seriesList, setSeriesList] = useState([]);
  const [seriesRefresh, setSeriesRefresh] = useState({ active: false, done: 0, total: 0 });
  const [selectedSeries, setSelectedSeries] = useState(null);
  const [seriesPage, setSeriesPage] = useState(1);
  const [seriesPageSize, setSeriesPageSize] = useState(30);
  const [seriesQuery, setSeriesQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [confirmAsk, setConfirmAsk] = useState(null); // 删除确认（可勾选删除本地文件）
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState(null);
  const [transcriptionRuntime, setTranscriptionRuntime] = useState(null);
  const [dedupRuntime, setDedupRuntime] = useState({});
  const [dedupStarting, setDedupStarting] = useState(false);
  const [dedupJobs, setDedupJobs] = useState(null);
  const [dedupJobsSaving, setDedupJobsSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [orderVersion, setOrderVersion] = useState(0);
  const [loadError, setLoadError] = useState('');
  const containerRef = useRef(null);
  const overviewScroll = useRef(0);
  const toastTimerRef = useRef(null);
  const refreshSeriesBusy = useRef(false);
  const handledTarget = useRef('');
  const activeRef = useRef(active);
  activeRef.current = active;
  const requests = useRef({ tasks: 0, queue: 0, series: 0 });
  const subtitleRequests = useRef({ transcription: 0, runtime: 0 });
  const taskIndex = useRef(new Map());
  const dedupBatchRef = useRef(new Map());
  const dedupJobsRef = useRef(null);
  const dedupJobsRevision = useRef(0);
  const dedupSubmittingRef = useRef(false);
  const transcriptionRefreshRef = useRef(null);
  const selectedSeriesIdRef = useRef(null);
  selectedSeriesIdRef.current = selectedSeries?.seriesId;
  const seriesCards = useMemo(() => groupDownloadSeries(tasks, seriesList), [tasks, seriesList]);
  const currentSeries =
    selectedSeries && (seriesCards.find((series) => series.key === selectedSeries.key) || selectedSeries);
  const scopedTasks = useMemo(
    () => (selectedSeries ? tasks.filter((task) => downloadSeriesKey(task) === selectedSeries.key) : tasks),
    [tasks, selectedSeries],
  );
  const filteredSeries = seriesCards.filter((series) =>
    series.title.toLocaleLowerCase().includes(seriesQuery.trim().toLocaleLowerCase()),
  );
  const seriesPageCount = Math.max(1, Math.ceil(filteredSeries.length / seriesPageSize));
  const currentSeriesPage = Math.min(seriesPage, seriesPageCount);
  const visibleSeries = filteredSeries.slice(
    (currentSeriesPage - 1) * seriesPageSize,
    currentSeriesPage * seriesPageSize,
  );
  useEffect(() => {
    setSeriesPage((previous) => Math.min(Math.max(1, previous), seriesPageCount));
  }, [seriesPageCount]);

  useEffect(() => {
    if (!active || !target?.seriesId || !seriesCards.length) return;
    const found = seriesCards.find((item) => String(item.seriesId) === String(target.seriesId));
    const marker = `${target.ts || ''}:${target.seriesId}`;
    if (found && handledTarget.current !== marker) {
      handledTarget.current = marker;
      openSeries(found);
    }
    // target.ts makes a return from 视频处理 reopen the same card exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, target?.seriesId, target?.ts, seriesCards]);

  const openSeries = (series) => {
    if (!selectedSeries) overviewScroll.current = containerRef.current?.closest('.main-content')?.scrollTop || 0;
    setSelectedSeries(series);
    setSelected(new Set());
    setPage(1);
    setConfirmAsk(null);
    setDedupRuntime({});
    setPipelineStatus(null);
    setTranscriptionStatus(null);
    setAnalysisStatus(null);
    setTranscriptionRuntime(null);
  };

  useEffect(() => {
    if (!active || !selectedSeries?.seriesId || typeof window.electronAPI.getSeriesPipelineStatus !== 'function')
      return undefined;
    let alive = true;
    window.electronAPI
      .getSeriesPipelineStatus(selectedSeries.seriesId)
      .then((result) => {
        if (alive && result?.success !== false && Array.isArray(result?.episodes)) setPipelineStatus(result);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active, selectedSeries?.seriesId, orderVersion]);

  const loadTranscription = useCallback(
    async (checkRuntime = false) => {
      const seriesId = selectedSeries?.seriesId;
      const sameSeries = () => activeRef.current && String(selectedSeriesIdRef.current) === String(seriesId);
      if (!seriesId || !sameSeries() || typeof window.electronAPI.getSeriesTranscription !== 'function') return;
      const request = ++subtitleRequests.current.transcription;
      const runtimeRequest = checkRuntime ? ++subtitleRequests.current.runtime : null;
      const [status, analysis] = await Promise.all([
        window.electronAPI.getSeriesTranscription(seriesId).catch(() => null),
        typeof window.electronAPI.getSeriesAnalysis === 'function'
          ? window.electronAPI.getSeriesAnalysis(seriesId).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (sameSeries() && request === subtitleRequests.current.transcription) {
        if (status && status.success !== false && (!status.seriesId || String(status.seriesId) === String(seriesId)))
          setTranscriptionStatus({ ...status, seriesId });
        if (
          analysis &&
          analysis.success !== false &&
          (!analysis.seriesId || String(analysis.seriesId) === String(seriesId))
        )
          setAnalysisStatus({ ...analysis, seriesId });
      }
      if (!checkRuntime || !sameSeries() || runtimeRequest !== subtitleRequests.current.runtime) return;
      const runtime =
        status?.counts?.total > 0 && typeof window.electronAPI.getFasterWhisperStatus === 'function'
          ? await window.electronAPI.getFasterWhisperStatus().catch(() => null)
          : null;
      if (sameSeries() && runtimeRequest === subtitleRequests.current.runtime && runtime)
        setTranscriptionRuntime(runtime);
    },
    [selectedSeries?.seriesId],
  );

  useEffect(() => {
    if (!active || !selectedSeries?.seriesId || typeof window.electronAPI.getSeriesTranscription !== 'function')
      return undefined;
    let alive = true;
    const refresh = () => {
      if (transcriptionRefreshRef.current != null) return;
      transcriptionRefreshRef.current = setTimeout(() => {
        transcriptionRefreshRef.current = null;
        if (!alive) return;
        loadTranscription();
      }, 180);
    };
    loadTranscription(true);
    const off = window.electronAPI.onSeriesTranscriptionProgress?.((data) => {
      if (String(data?.seriesId) === String(selectedSeries.seriesId)) refresh();
    });
    const offAnalysis = window.electronAPI.onSeriesAnalysisProgress?.((data) => {
      if (String(data?.seriesId) === String(selectedSeries.seriesId)) refresh();
    });
    return () => {
      alive = false;
      off?.();
      offAnalysis?.();
      clearTimeout(transcriptionRefreshRef.current);
      transcriptionRefreshRef.current = null;
      subtitleRequests.current.transcription++;
      subtitleRequests.current.runtime++;
    };
  }, [active, selectedSeries?.seriesId, loadTranscription]);

  // 去重状态只按“本剧 + 原视频路径”匹配，避免不同短剧或同名文件串状态。
  useEffect(() => {
    if (!active || !selectedSeries?.seriesId || typeof window.electronAPI.getQuchongTasks !== 'function') {
      setDedupRuntime({});
      return undefined;
    }
    let alive = true;
    const load = async () => {
      try {
        const snapshots = await window.electronAPI.getQuchongTasks();
        if (!alive || !Array.isArray(snapshots)) return;
        const paths = new Set(scopedTasks.map((task) => dedupPathKey(task.savePath || task.path)).filter(Boolean));
        const next = {};
        // 后端已按批次创建时间倒序返回，同一源保留最新批次。
        snapshots.forEach((batch) =>
          (batch.tasks || []).forEach((task) => {
            const key = dedupPathKey(task.src);
            if (key && paths.has(key) && !next[key]) next[key] = { ...task, batchId: batch.id };
          }),
        );
        setDedupRuntime((previous) => {
          for (const [src, task] of Object.entries(previous)) {
            const key = dedupPathKey(src);
            if (paths.has(key) && (!next[key] || (Number(task.updatedAt) || 0) > (Number(next[key].updatedAt) || 0)))
              next[key] = task;
          }
          return next;
        });
      } catch (_) {
        /* 去重历史不可用时仍显示未去重 */
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, [active, selectedSeries?.seriesId, scopedTasks, orderVersion]);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setDedupJobs(null);
    dedupJobsRef.current = null;
    const applyJobs = (value) => {
      if (!alive) return;
      const jobs = normalizeDedupJobs(value, dedupJobsRef.current);
      dedupJobsRef.current = jobs;
      setDedupJobs(jobs);
    };
    const revision = dedupJobsRevision.current;
    Promise.resolve(window.electronAPI.quchongDefaults?.())
      .then((defaults) => {
        if (revision === dedupJobsRevision.current) applyJobs(defaults?.jobs);
      })
      .catch(() => {
        if (revision === dedupJobsRevision.current && dedupJobsRef.current == null) applyJobs(2);
      });
    const off =
      typeof window.electronAPI.onQuchongConcurrencyChanged === 'function'
        ? window.electronAPI.onQuchongConcurrencyChanged((data) => {
            dedupJobsRevision.current++;
            applyJobs(data?.jobs);
          })
        : undefined;
    return () => {
      alive = false;
      off?.();
    };
  }, [active]);

  useEffect(() => {
    const content = containerRef.current?.closest('.main-content');
    if (content) content.scrollTop = selectedSeries ? 0 : overviewScroll.current;
  }, [selectedSeries]);

  const refresh = useCallback(async () => {
    const request = ++requests.current.tasks;
    try {
      const list = await window.electronAPI.getDownloadTasks();
      if (!activeRef.current || request !== requests.current.tasks) return;
      if (!Array.isArray(list)) throw new Error('下载任务读取失败，请重试');
      setTasks(list);
      setOrderVersion((value) => value + 1);
      const ids = new Set(list.map((task) => task.id));
      setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
      setLoadError('');
      setLoaded(true);
    } catch (error) {
      if (activeRef.current && request === requests.current.tasks)
        setLoadError(error.message || '下载任务读取失败，请重试');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    const request = ++requests.current.queue;
    try {
      const q = await window.electronAPI.getQueueStatus();
      if (q && activeRef.current && request === requests.current.queue) setQueue(q);
    } catch (_) {}
  }, []);

  const loadSeriesList = useCallback(async () => {
    const request = ++requests.current.series;
    try {
      const list = (await window.electronAPI.getSeriesList()) || [];
      if (!activeRef.current || request !== requests.current.series) return;
      setSeriesList(list);
    } catch (_) {}
  }, []);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const handleEpisodesChanged = useCallback(async () => {
    await Promise.all([refresh(), loadSeriesList(), loadQueue()]);
  }, [refresh, loadSeriesList, loadQueue]);

  const refreshAllSeries = useCallback(async () => {
    if (!activeRef.current || refreshSeriesBusy.current || seriesCards.length === 0) return;
    refreshSeriesBusy.current = true;
    setSeriesRefresh({ active: true, done: 0, total: seriesCards.length });
    try {
      const result = await window.electronAPI.refreshAllSeries();
      if (!result?.success && !Array.isArray(result?.results)) throw new Error(result?.error || '更新剧集失败');
      const total = Number(result.total) || seriesCards.length;
      const succeeded = Number(result.succeeded ?? result.successful) || 0;
      const failed = Number(result.failed) || Math.max(0, total - succeeded);
      const added = Number(result.addedEpisodes ?? result.addedCount) || 0;
      await Promise.all([refresh(), loadSeriesList()]);
      if (activeRef.current) {
        const summary =
          failed > 0
            ? `已检查 ${total} 部，成功 ${succeeded} 部，失败 ${failed} 部`
            : added > 0
              ? `已更新 ${total} 部，新增 ${added} 集`
              : `已检查 ${total} 部，暂无新增剧集`;
        showToast(summary, failed > 0 ? 'error' : 'success');
      }
    } catch (error) {
      if (activeRef.current) showToast(error.message || '更新剧集失败，请重试', 'error');
    } finally {
      refreshSeriesBusy.current = false;
      setSeriesRefresh({ active: false, done: 0, total: 0 });
    }
  }, [loadSeriesList, refresh, seriesCards, showToast]);

  useEffect(() => {
    if (!active) return;
    refresh();
    loadQueue();
    loadSeriesList();
    const patches = new Map();
    let batchTimer = null,
      fullRefresh = false,
      reorder = false,
      seriesDirty = false,
      queueDirty = false;
    const schedule = () => {
      if (batchTimer !== null) return;
      batchTimer = setTimeout(() => {
        batchTimer = null;
        if (fullRefresh) refresh();
        else if (patches.size) {
          const updates = new Map(patches);
          setTasks((previous) =>
            previous.map((task) => (updates.has(task.id) ? { ...task, ...updates.get(task.id) } : task)),
          );
          if (reorder) setOrderVersion((value) => value + 1);
        }
        if (seriesDirty) loadSeriesList();
        if (queueDirty) loadQueue();
        patches.clear();
        fullRefresh = reorder = seriesDirty = queueDirty = false;
      }, 200);
    };
    const patchTask = (data, status, affectsOrder = false) => {
      if (!data?.id) return;
      patches.set(data.id, { ...patches.get(data.id), ...data, status });
      reorder ||= affectsOrder || taskIndex.current.get(data.id)?.status !== status;
      schedule();
    };
    const cleanups = [
      window.electronAPI.onDownloadProgress((data) => {
        patchTask(data, 'downloading');
      }),
      window.electronAPI.onDownloadTaskAdded(() => {
        fullRefresh = seriesDirty = true;
        schedule();
      }),
      window.electronAPI.onDownloadCompleted((data) => {
        patchTask({ ...data, progress: 100 }, 'completed', true);
      }),
      window.electronAPI.onDownloadFailed((data) => {
        patchTask(data, 'failed', true);
      }),
      window.electronAPI.onDownloadStopped((data) => {
        patchTask(data, 'stopped', true);
      }),
      window.electronAPI.onDownloadQueueChanged(() => {
        fullRefresh = queueDirty = true;
        schedule();
      }),
      ...(typeof window.electronAPI.onQuchongTask === 'function'
        ? [
            window.electronAPI.onQuchongTask((data) => {
              const key = dedupPathKey(data?.task?.src);
              if (!key) return;
              setDedupRuntime((previous) => ({
                ...previous,
                [key]: { ...data.task, updatedAt: data.task.updatedAt || Date.now(), batchId: data.batchId },
              }));
            }),
          ]
        : []),
      ...(typeof window.electronAPI.onQuchongProgress === 'function'
        ? [
            window.electronAPI.onQuchongProgress((data) => {
              if (!data?.taskId) return;
              setDedupRuntime((previous) => {
                const entry = Object.entries(previous).find(([, task]) => task.id === data.taskId);
                if (!entry) return previous;
                const [src, task] = entry;
                return {
                  ...previous,
                  [src]: {
                    ...task,
                    progress: data.progress,
                    stage: data.stage || task.stage,
                    updatedAt: data.updatedAt || Date.now(),
                    status: 'running',
                  },
                };
              });
            }),
          ]
        : []),
      ...(typeof window.electronAPI.onQuchongComplete === 'function'
        ? [
            window.electronAPI.onQuchongComplete(async (data) => {
              const batchId = data?.batchId == null ? '' : String(data.batchId);
              if (batchId && dedupBatchRef.current.has(batchId)) {
                const seriesId = dedupBatchRef.current.get(batchId);
                dedupBatchRef.current.delete(batchId);
                if (
                  seriesId &&
                  selectedSeriesIdRef.current === seriesId &&
                  typeof window.electronAPI.getSeriesPipelineStatus === 'function'
                ) {
                  const status = await window.electronAPI.getSeriesPipelineStatus(seriesId).catch(() => null);
                  if (selectedSeriesIdRef.current !== seriesId) return;
                  if (status?.success !== false) setPipelineStatus(status);
                }
                if (selectedSeriesIdRef.current === seriesId)
                  showToast(
                    data?.success ? '本批视频去重完成' : '本批去重结束，部分视频失败',
                    data?.success ? 'success' : 'error',
                  );
              }
            }),
          ]
        : []),
    ];
    if (typeof window.electronAPI.onSeriesRefreshProgress === 'function') {
      cleanups.push(
        window.electronAPI.onSeriesRefreshProgress((data) => {
          if (!activeRef.current || !data) return;
          setSeriesRefresh((previous) => ({
            active: true,
            total: Number(data.total) || previous.total || seriesCards.length,
            done: Math.min(Number(data.total) || previous.total || seriesCards.length, Number(data.done) || 0),
          }));
        }),
      );
    }
    const timer = setInterval(() => {
      loadQueue();
      refresh();
    }, 15000);
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      clearInterval(timer);
      clearTimeout(batchTimer);
      for (const key of Object.keys(requests.current)) requests.current[key]++;
    };
  }, [active, refresh, loadQueue, loadSeriesList, showToast, selectedSeries?.seriesId]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSelection = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(scopedTasks.map((task) => task.id)));
  const allSelected = scopedTasks.length > 0 && scopedTasks.every((task) => selected.has(task.id));
  const selectPage = (ids) => setSelected((previous) => new Set([...previous, ...ids]));
  const clearPage = (ids) => setSelected((previous) => new Set([...previous].filter((id) => !ids.includes(id))));

  const fmtSize = (b) => {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  };

  /** 弹删除确认：默认只删记录，可勾选同时删除本地文件 */
  const askDelete = (list, label) => {
    const items = (list || []).filter(Boolean);
    if (!items.length) return;
    // 用已下载字节数估算可释放空间（完成任务才有意义）
    const estBytes = items.reduce((s, t) => s + (t.totalBytes || t.receivedBytes || 0), 0);
    const withFile = items.filter((t) => t.status === 'completed').length;
    setConfirmAsk({
      title: label,
      count: items.length,
      withFile,
      estBytes,
      onOk: async (deleteFiles) => {
        try {
          const ids = items.map((t) => t.id);
          const res = await window.electronAPI.deleteTasksWithFiles(ids, deleteFiles);
          if (!res?.success) throw new Error(res?.error || '删除失败，请重试');
          await refresh();
          showToast(
            deleteFiles
              ? `已删除 ${res.count} 个任务，释放 ${fmtSize(res.freed)}`
              : `已删除 ${res.count} 个任务记录（本地文件已保留）`,
          );
        } catch (error) {
          showToast(error.message || '删除失败，请重试', 'error');
        }
      },
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    askDelete(
      scopedTasks.filter((t) => selected.has(t.id)),
      '删除选中任务',
    );
  };
  const pipelineEpisodeMap = useMemo(
    () => new Map((pipelineStatus?.episodes || []).map((item) => [Number(item.episodeIndex), item])),
    [pipelineStatus],
  );
  const dedupCandidates = useMemo(() => {
    const seen = new Set();
    return scopedTasks.filter((task) => {
      const sourcePath = task.savePath || task.path;
      const key = dedupPathKey(sourcePath);
      if (task.status !== 'completed' || !key) return false;
      const index = Number(task.hongguoInfo?.vid_index);
      const record = pipelineEpisodeMap.get(index);
      if (record?.deduped || ['deduped', 'segmented', 'ready'].includes(String(record?.status || ''))) return false;
      const runtime = dedupRuntime[key];
      const state = dedupRuntimeState(runtime);
      if (
        seen.has(key) ||
        (runtime &&
          (DEDUP_ACTIVE_STATES.has(state) || DEDUP_QUEUED_STATES.has(state) || DEDUP_FINISHED_STATES.has(state)))
      )
        return false;
      seen.add(key);
      return true;
    });
  }, [scopedTasks, pipelineEpisodeMap, dedupRuntime]);
  const dedupSourcePaths = useMemo(
    () => new Set(scopedTasks.map((task) => dedupPathKey(task.savePath || task.path)).filter(Boolean)),
    [scopedTasks],
  );
  const dedupRunningCount = useMemo(
    () =>
      Object.entries(dedupRuntime).filter(
        ([src, task]) => dedupSourcePaths.has(src) && DEDUP_ACTIVE_STATES.has(dedupRuntimeState(task)),
      ).length,
    [dedupSourcePaths, dedupRuntime],
  );
  const dedupQueuedCount = useMemo(
    () =>
      Object.entries(dedupRuntime).filter(
        ([src, task]) => dedupSourcePaths.has(src) && DEDUP_QUEUED_STATES.has(dedupRuntimeState(task)),
      ).length,
    [dedupSourcePaths, dedupRuntime],
  );

  const changeDedupJobs = useCallback(
    async (value) => {
      const jobs = normalizeDedupJobs(value, dedupJobsRef.current);
      if (dedupJobsSaving || jobs == null) return;
      dedupJobsRevision.current++;
      setDedupJobsSaving(true);
      try {
        const result = await window.electronAPI.quchongSetConcurrency(jobs);
        if (!result?.success) throw new Error(result?.error || '保存去重并发数失败');
        const savedJobs = normalizeDedupJobs(result.jobs, jobs);
        dedupJobsRef.current = savedJobs;
        setDedupJobs(savedJobs);
      } catch (error) {
        showToast(error?.message || '保存去重并发数失败', 'error');
      } finally {
        setDedupJobsSaving(false);
      }
    },
    [dedupJobsSaving, showToast],
  );

  const startDedup = useCallback(async () => {
    if (!selectedSeries?.seriesId || dedupSubmittingRef.current || dedupJobs == null || dedupJobsSaving) return;
    if (!dedupCandidates.length) {
      showToast('当前没有待去重的视频', 'success');
      return;
    }
    dedupSubmittingRef.current = true;
    setDedupStarting(true);
    try {
      const defaults = await window.electronAPI.quchongDefaults?.();
      const result = await window.electronAPI.quchongStart({
        sources: dedupCandidates.map((task) => task.savePath || task.path),
        bgm: null,
        opts: { ...(defaults || {}), jobs: dedupJobsRef.current },
      });
      if (!result?.success) throw new Error(result?.error || '提交去重任务失败');
      if (result.batchId != null) dedupBatchRef.current.set(String(result.batchId), String(selectedSeries.seriesId));
      if (selectedSeriesIdRef.current !== selectedSeries.seriesId) return;
      setDedupRuntime((previous) => {
        const next = { ...previous };
        for (const task of result.tasks || []) {
          const key = dedupPathKey(task.src);
          if (!key) continue;
          const live = previous[key];
          next[key] =
            live?.id === task.id && !DEDUP_QUEUED_STATES.has(dedupRuntimeState(live))
              ? live
              : { ...task, batchId: result.batchId };
        }
        return next;
      });
      showToast(`已提交 ${dedupCandidates.length} 个视频去重`);
    } catch (error) {
      showToast(error?.message || '提交去重任务失败', 'error');
    } finally {
      // 提交锁只保护 IPC 请求，批次运行期间仍允许追加新下载的视频。
      dedupSubmittingRef.current = false;
      setDedupStarting(false);
    }
  }, [currentSeries, dedupCandidates, dedupJobs, dedupJobsSaving, selectedSeries, showToast]);

  const startTranscription = useCallback(async () => {
    if (!selectedSeries?.seriesId || typeof window.electronAPI.startSeriesTranscription !== 'function') return;
    try {
      const counts = transcriptionStatus?.counts || {};
      const force = Number(counts.total) > 0 && Number(counts.completed) === Number(counts.total);
      const result = await window.electronAPI.startSeriesTranscription({ seriesId: selectedSeries.seriesId, force });
      if (!result?.success) throw new Error(result?.error || '提交字幕识别失败');
      await loadTranscription();
      showToast(result.skipped ? `已跳过 ${result.skipped} 集，开始处理其余去重视频` : '已开始识别完整字幕');
    } catch (error) {
      showToast(error?.message || '提交字幕识别失败', 'error');
    }
  }, [loadTranscription, selectedSeries, showToast, transcriptionStatus?.counts]);

  const cancelTranscription = useCallback(async () => {
    const batchId = transcriptionStatus?.batchId;
    if (
      !batchId ||
      String(transcriptionStatus.seriesId) !== String(selectedSeriesIdRef.current) ||
      typeof window.electronAPI.cancelSeriesTranscription !== 'function'
    )
      return;
    const result = await window.electronAPI
      .cancelSeriesTranscription(batchId)
      .catch((error) => ({ success: false, error: error.message }));
    if (!result?.success) showToast(result?.error || '停止字幕识别失败', 'error');
    else await loadTranscription();
  }, [loadTranscription, showToast, transcriptionStatus?.batchId, transcriptionStatus?.seriesId]);

  const startAnalysis = useCallback(async () => {
    if (!selectedSeries?.seriesId || typeof window.electronAPI.startSeriesAnalysis !== 'function') return;
    try {
      const counts = analysisStatus?.counts || {};
      const force = Number(counts.total) > 0 && Number(counts.completed) === Number(counts.total);
      const result = await window.electronAPI.startSeriesAnalysis({ seriesId: selectedSeries.seriesId, force });
      if (!result?.success) throw new Error(result?.error || '提交剧情分析失败');
      await loadTranscription();
      showToast(result.skipped ? `已跳过 ${result.skipped} 集，开始处理其余分析` : '已开始生成剧情分析');
    } catch (error) {
      showToast(error?.message || '提交剧情分析失败', 'error');
    }
  }, [analysisStatus?.counts, loadTranscription, selectedSeries, showToast]);

  const cancelAnalysis = useCallback(async () => {
    const batchId = analysisStatus?.batchId;
    if (
      !batchId ||
      String(analysisStatus.seriesId) !== String(selectedSeriesIdRef.current) ||
      typeof window.electronAPI.cancelSeriesAnalysis !== 'function'
    )
      return;
    const result = await window.electronAPI
      .cancelSeriesAnalysis(batchId)
      .catch((error) => ({ success: false, error: error.message }));
    if (!result?.success) showToast(result?.error || '停止剧情分析失败', 'error');
    else await loadTranscription();
  }, [analysisStatus?.batchId, analysisStatus?.seriesId, loadTranscription, showToast]);

  // Progress updates change row values, not the established series/episode order.
  // Keep the page index list in sync with task updates. Progress/status events
  // replace task objects without necessarily changing orderVersion; omitting
  // scopedTasks here left new downloads invisible until another navigation.
  const sortedIds = useMemo(
    () => (selectedSeries ? sortTasks(scopedTasks).map((task) => task.id) : []),
    [scopedTasks, selectedSeries, orderVersion],
  );
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  taskIndex.current = taskById;
  const pageCount = Math.max(1, Math.ceil(sortedIds.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  useEffect(() => {
    setPage((previous) => Math.min(Math.max(1, previous), pageCount));
  }, [pageCount]);
  const visibleTasks = sortedIds
    .slice((currentPage - 1) * pageSize, currentPage * pageSize)
    .map((id) => taskById.get(id))
    .filter(Boolean);
  const visibleTaskIds = visibleTasks.map((task) => task.id);
  const allPageSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((id) => selected.has(id));

  const activeCount = scopedTasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
  const completedCount = scopedTasks.filter((t) => t.status === 'completed').length;
  const failedTasks = useMemo(
    () => scopedTasks.filter((t) => t.status === 'failed' || t.status === 'stopped'),
    [scopedTasks],
  );
  const failedCount = failedTasks.length;

  useDialogKeyboard(active && !!confirmAsk, () => setConfirmAsk(null), '.dm-container .player-confirm');

  return (
    <div className="dm-container" ref={containerRef}>
      {selectedSeries && (
        <button className="btn btn-outline dm-back" onClick={() => openSeries(null)}>
          <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />
          返回短剧列表
        </button>
      )}
      <div className="dm-header">
        <div className="dm-title">
          <div>
            <h2>{currentSeries?.title || '下载管理'}</h2>
            <p className="page-description">
              {selectedSeries
                ? '查看全部分集和下载状态，下方管理本剧视频。'
                : `共 ${seriesCards.length} 部短剧，点击封面查看分集和视频列表。`}
            </p>
          </div>
        </div>
        <div className="dm-stats">
          <span className="stat stat-active">进行中 {activeCount}</span>
          <span className="stat stat-done">已完成 {completedCount}</span>
          <span className="stat stat-fail">失败/停止 {failedCount}</span>
        </div>
      </div>

      {selectedSeries && selectedSeries.seriesId && (
        <SeriesEpisodePanel
          key={selectedSeries.seriesId}
          seriesId={selectedSeries.seriesId}
          title={currentSeries.title}
          cover={currentSeries.cover}
          lastUpdatedAt={currentSeries.lastUpdatedAt}
          active={active}
          revision={orderVersion}
          onDownloadsChanged={handleEpisodesChanged}
          onNotify={showToast}
        />
      )}

      {selectedSeries && selectedSeries.seriesId && (
        <TranscriptionPanel
          seriesId={selectedSeries.seriesId}
          active={active}
          status={transcriptionStatus}
          analysis={analysisStatus}
          runtime={transcriptionRuntime}
          onStart={startTranscription}
          onCancel={cancelTranscription}
          onAnalyze={startAnalysis}
          onCancelAnalysis={cancelAnalysis}
        />
      )}

      {selectedSeries && (
        <div className="dm-video-heading">
          <div>
            视频列表 <span>{scopedTasks.length} 个任务</span>
          </div>
          <div className="dm-dedup-toolbar">
            <span className="dm-dedup-count">
              处理中 <b>{dedupRunningCount}</b> · 等待 <b>{dedupQueuedCount}</b>
            </span>
            <label className="dm-dedup-concurrency">
              去重并发
              <select
                aria-label="去重并发数"
                value={dedupJobs ?? ''}
                disabled={dedupJobs == null || dedupJobsSaving}
                onChange={(event) => changeDedupJobs(event.target.value)}
              >
                {dedupJobs == null && <option value="">读取中…</option>}
                {Array.from({ length: DEDUP_MAX_CONCURRENCY }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-primary btn-sm"
              onClick={startDedup}
              disabled={dedupStarting || dedupJobs == null || dedupJobsSaving || dedupCandidates.length === 0}
              title={
                dedupJobs == null
                  ? '正在读取去重设置，请稍候'
                  : dedupCandidates.length === 0
                    ? '当前没有待去重的视频'
                    : '处理本剧所有已下载但尚未去重的视频'
              }
            >
              {dedupStarting ? '提交中…' : '一键去重'}
            </button>
          </div>
        </div>
      )}
      {!selectedSeries && (
        <div className="dm-toolbar">
          {!selectedSeries && (
            <button
              className="btn btn-outline dm-refresh-series"
              onClick={refreshAllSeries}
              disabled={seriesRefresh.active || seriesCards.length === 0}
              title="重新读取所有已登记短剧的总集数和分集信息，不会自动下载"
            >
              <RefreshCw size={15} className={seriesRefresh.active ? 'spin' : ''} />
              {seriesRefresh.active ? `更新剧集 ${seriesRefresh.done}/${seriesRefresh.total}` : '更新全部剧集'}
            </button>
          )}
          {onNavigate && !selectedSeries && (
            <button className="btn btn-primary dm-toolbar-end" onClick={() => onNavigate('download')}>
              <Film size={15} />
              添加下载
            </button>
          )}
        </div>
      )}

      {queue.active > 0 && (
        <div className="dm-queue-bar">
          <span className="dm-queue-running">
            <span className="dm-queue-pulse" />
            全局并发下载 <b>{queue.active}</b> / {queue.maxConcurrent}
            {queue.queued > 0 ? (
              <>
                {' '}
                · 队列等待 <b>{queue.queued}</b>
              </>
            ) : null}
          </span>
          <span className="dm-queue-hint">并发数可在「设置 → 最大并发下载数」调整</span>
        </div>
      )}

      {loadError && (
        <div className="alert alert-error" role="alert">
          {loadError}
          <button className="btn btn-outline btn-sm" onClick={refresh}>
            重新加载
          </button>
        </div>
      )}
      {selectedSeries && scopedTasks.length > 0 && (
        <div className="dm-pagination">
          <div className="dm-selection-summary">
            <button
              className="btn btn-outline btn-sm"
              onClick={allSelected ? clearSelection : selectAll}
              title={allSelected ? '取消本剧所有分页中的选择' : `选中本剧全部 ${scopedTasks.length} 项，包含其他分页`}
            >
              <CheckSquare size={15} />
              {allSelected ? '取消全选本剧' : '全选本剧'}
            </button>
            <button
              className="btn btn-outline btn-sm"
              onClick={allPageSelected ? () => clearPage(visibleTaskIds) : () => selectPage(visibleTaskIds)}
              title={allPageSelected ? '取消当前页选择' : `选中当前页 ${visibleTaskIds.length} 项`}
            >
              <CheckSquare size={15} />
              {allPageSelected ? '取消本页' : '全选本页'}
            </button>
            {selected.size > 0 && (
              <button className="btn btn-outline btn-sm" onClick={clearSelection}>
                取消选择
              </button>
            )}
            {selected.size > 0 && (
              <button className="btn btn-outline btn-sm" onClick={deleteSelected}>
                <Trash2 size={14} />
                删除选中
              </button>
            )}
            <span>
              共 {scopedTasks.length} 项 · 当前 {(currentPage - 1) * pageSize + 1}-
              {Math.min(currentPage * pageSize, scopedTasks.length)} 项
              {selected.size > 0 ? ` · 已选 ${selected.size} 项（跨页保留）` : ''}
            </span>
          </div>
          <PaginationControls
            ariaLabel="下载任务分页"
            page={currentPage}
            pageCount={pageCount}
            pageSize={pageSize}
            pageSizeOptions={VIDEO_PAGE_SIZE_OPTIONS}
            onPageChange={setPage}
            onPageSizeChange={(value) => {
              setPageSize(value);
              setPage(1);
            }}
          />
        </div>
      )}

      {!selectedSeries ? (
        <>
          <div className="dm-series-toolbar">
            <label className="dm-series-search">
              <Search size={16} />
              <input
                aria-label="搜索已添加的短剧"
                placeholder="搜索剧名"
                value={seriesQuery}
                onChange={(event) => {
                  setSeriesQuery(event.target.value);
                  setSeriesPage(1);
                }}
              />
            </label>
            <span>{filteredSeries.length} 部短剧</span>
          </div>
          {!loaded && !loadError ? (
            <div className="browse-loading" role="status">
              正在读取下载记录…
            </div>
          ) : filteredSeries.length === 0 ? (
            <div className="dm-empty">
              <Download size={40} />
              <p>{seriesQuery.trim() ? '没有找到匹配的短剧' : '暂无下载任务'}</p>
              <p className="dm-empty-sub">
                {seriesQuery.trim() ? '换个剧名试试。' : '搜索剧名或粘贴分享链接，选择想保存的集数。'}
              </p>
              {!seriesQuery.trim() && onNavigate && (
                <button className="btn btn-primary" onClick={() => onNavigate('download')}>
                  添加第一部短剧
                </button>
              )}
            </div>
          ) : (
            <div className="browse-grid">
              {visibleSeries.map((series) => (
                <button
                  type="button"
                  key={series.key}
                  className="browse-card"
                  data-series-key={series.key}
                  onClick={() => openSeries(series)}
                  title={series.title}
                  aria-label={`查看《${series.title}》的视频，已下载 ${series.completed} 集`}
                >
                  <div className="browse-cover">
                    {series.cover ? (
                      <img src={series.cover} alt="" loading="lazy" />
                    ) : (
                      <div className="cover-placeholder">
                        <Film size={22} />
                      </div>
                    )}
                    {series.total > 0 && <span className="browse-ep-badge">全{series.total}集</span>}
                    <span className="browse-dl-badge">
                      <Check size={11} />
                      {series.completed}
                      {series.total > 0 ? `/${series.total}` : ' 集'}
                    </span>
                    <div className="browse-hover">
                      <span className="browse-hover-play">
                        <Film size={16} />
                        查看视频
                      </span>
                    </div>
                  </div>
                  <div className="browse-card-title">{series.title}</div>
                  <div className="dm-card-count">
                    已下载 {series.completed}
                    {series.total > 0 ? ` / ${series.total}` : ''} 集
                  </div>
                  <div className="dm-card-updated">上次更新：{formatSeriesUpdatedAt(series.lastUpdatedAt)}</div>
                  <div className="browse-card-tags">
                    <span className="browse-tag">
                      {series.seriesId?.startsWith('xifan:')
                        ? '西饭短剧'
                        : series.seriesId?.startsWith('hema:')
                          ? '河马短剧'
                          : series.seriesId
                            ? '红果短剧'
                            : '本地任务'}
                    </span>
                    {series.downloading + series.pending > 0 && (
                      <span className="browse-tag">进行中 {series.downloading + series.pending}</span>
                    )}
                    {series.failed + series.stopped > 0 && (
                      <span className="browse-tag">失败/停止 {series.failed + series.stopped}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
          {filteredSeries.length > 0 && (
            <div className="dm-pagination dm-series-pagination">
              <span>共 {filteredSeries.length} 部短剧</span>
              <PaginationControls
                ariaLabel="短剧分页"
                page={currentSeriesPage}
                pageCount={seriesPageCount}
                pageSize={seriesPageSize}
                pageSizeOptions={SERIES_PAGE_SIZE_OPTIONS}
                onPageChange={setSeriesPage}
                onPageSizeChange={(value) => {
                  setSeriesPageSize(value);
                  setSeriesPage(1);
                }}
              />
            </div>
          )}
        </>
      ) : scopedTasks.length === 0 ? (
        <div className="dm-empty">
          <Download size={40} />
          <p>本剧暂无下载任务</p>
          <button className="btn btn-outline" onClick={() => openSeries(null)}>
            返回短剧列表
          </button>
        </div>
      ) : (
        <div className="dm-list">
          {visibleTasks.map((task) => {
            const isSel = selected.has(task.id);
            const pct = task.progress || 0;
            const sourcePath = task.savePath || task.path;
            const episodeRecord = pipelineEpisodeMap.get(Number(task.hongguoInfo?.vid_index));
            const runtime = sourcePath ? dedupRuntime[dedupPathKey(sourcePath)] : null;
            const isDeduped =
              episodeRecord?.deduped ||
              ['deduped', 'segmented', 'ready'].includes(String(episodeRecord?.status || '')) ||
              runtime?.status === 'completed' ||
              runtime?.stage === 'completed';
            const runtimeStage = String(runtime?.status || runtime?.stage || '');
            const dedupInProgress = !isDeduped && ['pending', 'queued', 'running', 'processing'].includes(runtimeStage);
            const dedupFailed = !isDeduped && ['failed', 'stopped', 'cancelled'].includes(runtimeStage);
            const dedupLabel =
              task.status !== 'completed'
                ? '等待下载'
                : isDeduped
                  ? '已去重'
                  : dedupInProgress
                    ? runtimeStage === 'pending' || runtimeStage === 'queued'
                      ? '等待去重'
                      : DEDUP_STAGE_TEXT[runtime?.stage] || '去重中'
                    : dedupFailed
                      ? '去重失败'
                      : '未去重';
            const showDedupPercent =
              dedupInProgress && ['encoding', 'processing', 'running'].includes(runtime?.stage || runtimeStage);
            const dedupPct = Math.max(0, Math.min(100, Number(runtime?.progress || 0)));
            const transcription = (transcriptionStatus?.episodes || []).find(
              (item) => Number(item.episodeIndex) === Number(task.hongguoInfo?.vid_index),
            );
            const transcriptionStage = String(transcription?.status || 'pending');
            const subtitleStep =
              { extracting: '校正音频时间轴', aligning: '识别并对齐', validating: '校验字幕时间轴' }[
                transcription?.stage
              ] || '识别中';
            const transcriptionLabel =
              transcriptionStage === 'completed'
                ? '已生成 SRT · 时间轴已校验'
                : transcriptionStage === 'running'
                  ? `${subtitleStep}${transcription?.stage === 'aligning' ? ` ${Math.round(Number(transcription.progress) || 0)}%` : ''}`
                  : transcriptionStage === 'queued'
                    ? '等待识别'
                    : transcriptionStage === 'failed'
                      ? '识别失败'
                      : transcriptionStage === 'stopped'
                        ? '已停止'
                        : transcriptionStage === 'stale'
                          ? '字幕已失效，请重新识别'
                          : '未识别';
            return (
              <div key={task.id} className={`dm-task ${isSel ? 'selected' : ''}`} onClick={() => toggleSelect(task.id)}>
                <input
                  className="dm-task-select"
                  type="checkbox"
                  aria-label={`选择 ${task.title || task.filename}`}
                  checked={isSel}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelect(task.id)}
                />
                <div className="dm-task-cover">
                  {task.videoInfo && task.videoInfo.cover ? (
                    <img src={task.videoInfo.cover} alt="" />
                  ) : (
                    <div className="cover-placeholder">
                      <Film size={18} />
                    </div>
                  )}
                </div>
                <div className="dm-task-body">
                  <div className="dm-task-title">{task.title || task.filename}</div>
                  <div className="dm-task-meta">
                    <span className={`status-tag status-${task.status}`}>
                      {STATUS_TEXT[task.status] || task.status}
                    </span>
                    {task.status === 'downloading' && task.totalBytes > 0 && (
                      <span className="dm-size">
                        {fmtBytes(task.receivedBytes)} / {fmtBytes(task.totalBytes)}
                      </span>
                    )}
                    {task.status === 'failed' && task.error && <span className="dm-error">{task.error}</span>}
                  </div>
                  <div
                    className={`dm-dedup-status ${isDeduped ? 'is-deduped' : dedupInProgress ? 'is-deduping' : dedupFailed ? 'is-dedup-failed' : 'is-dedup-pending'}`}
                  >
                    <span>去重：{dedupLabel}</span>
                  </div>
                  {isDeduped && (
                    <div
                      className={`dm-transcription-row-status ${transcriptionStage === 'completed' ? 'is-done' : transcriptionStage === 'running' ? 'is-running' : transcriptionStage === 'failed' ? 'is-failed' : ''}`}
                    >
                      字幕：{transcriptionLabel}
                    </div>
                  )}
                  {isDeduped && transcription?.error && <div className="dm-error">{transcription.error}</div>}
                  {isDeduped && transcriptionStage === 'running' && (
                    <div
                      className="dm-progress"
                      role="progressbar"
                      aria-label={`第 ${task.hongguoInfo?.vid_index || ''} 集字幕识别进度`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Number(transcription.progress) || 0}
                      aria-valuetext={transcriptionLabel}
                    >
                      <div className="dm-progress-bar">
                        <div
                          className="dm-progress-fill"
                          style={{ width: `${Number(transcription.progress) || 0}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {dedupInProgress && (
                    <div
                      className="dm-progress dm-dedup-progress"
                      aria-label={`第 ${task.hongguoInfo?.vid_index || ''} 集去重进度`}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={showDedupPercent ? dedupPct : undefined}
                      aria-valuetext={showDedupPercent ? `编码约 ${dedupPct}%` : dedupLabel}
                    >
                      <div className="dm-progress-bar">
                        <div className="dm-progress-fill" style={{ width: `${dedupPct}%` }} />
                      </div>
                      {showDedupPercent && <span className="dm-pct">约 {dedupPct}%</span>}
                    </div>
                  )}
                  {(task.status === 'downloading' || task.status === 'pending') && (
                    <div className="dm-progress">
                      <div className="dm-progress-bar">
                        <div className="dm-progress-fill" style={{ width: pct + '%' }}></div>
                      </div>
                      <span className="dm-pct">{pct}%</span>
                    </div>
                  )}
                </div>
                <div className="dm-task-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-btn"
                    title="打开文件夹"
                    onClick={() => window.electronAPI.openFolder(task.id)}
                  >
                    <Folder size={16} />
                  </button>
                  <button
                    className="icon-btn icon-btn-danger"
                    title="删除任务（可选是否同时删除本地文件）"
                    onClick={() => {
                      askDelete(
                        [task],
                        `删除《${task.hongguoInfo && task.hongguoInfo.series_title ? task.hongguoInfo.series_title : ''}》第 ${task.hongguoInfo ? task.hongguoInfo.vid_index : ''} 集任务`,
                      );
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedSeries && scopedTasks.length > 0 && (
        <div className="dm-pagination dm-pagination-bottom">
          <span>
            当前第 {currentPage} / {pageCount} 页 · 共 {scopedTasks.length} 项
          </span>
          <PaginationControls
            ariaLabel="下载任务底部分页"
            page={currentPage}
            pageCount={pageCount}
            pageSize={pageSize}
            pageSizeOptions={VIDEO_PAGE_SIZE_OPTIONS}
            onPageChange={setPage}
            onPageSizeChange={(value) => {
              setPageSize(value);
              setPage(1);
            }}
          />
        </div>
      )}

      {toast && (
        <div
          className={`dm-toast dm-toast-${toast.type}`}
          role={toast.type === 'error' ? 'alert' : 'status'}
          onClick={() => setToast(null)}
        >
          {toast.text}
        </div>
      )}

      {/* 删除确认（可选是否连本地文件一起删） */}
      {confirmAsk && (
        <div className="player-confirm-mask" onClick={() => setConfirmAsk(null)}>
          <div
            className="player-confirm"
            role="dialog"
            aria-modal="true"
            aria-label={confirmAsk ? confirmAsk.title : '删除任务'}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {confirmAsk.title}
            </div>
            <div className="player-confirm-msg">
              <p>
                共 {confirmAsk.count} 个任务，其中 {confirmAsk.withFile} 个已下载完成
                {confirmAsk.estBytes > 0 ? `（约 ${fmtSize(confirmAsk.estBytes)}）` : ''}。
              </p>
              <label className="dm-confirm-check">
                <input
                  type="checkbox"
                  checked={!!confirmAsk._del}
                  onChange={(e) => setConfirmAsk({ ...confirmAsk, _del: e.target.checked })}
                />
                <span>
                  同时删除本地文件
                  {confirmAsk.estBytes > 0 ? `（释放约 ${fmtSize(confirmAsk.estBytes)}）` : ''}
                </span>
              </label>
              <p className="dm-confirm-hint">
                不勾选则只移除任务记录，磁盘上的视频文件会保留（可在文件管理器里自行管理）。
              </p>
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setConfirmAsk(null)}>
                取消
              </button>
              <button
                className={`btn ${confirmAsk._del ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={async () => {
                  const fn = confirmAsk.onOk;
                  const del = !!confirmAsk._del;
                  setConfirmAsk(null);
                  await fn(del);
                }}
              >
                {confirmAsk._del ? '删除任务和文件' : '仅删除记录'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DownloadManager;
