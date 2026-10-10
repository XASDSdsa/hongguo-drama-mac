import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import { downloadSeriesKey, groupDownloadSeries, formatSeriesUpdatedAt } from './downloadSeries.mjs';
import { parseEpisodeRange } from './episodeRange';
import SeriesEpisodePanel from './SeriesEpisodePanel';
import './Browse.css';
import './DownloadManager.css';
import { Download, Trash2, RefreshCw, X, Film, Square, Folder, Zap, CheckSquare, Play, Pause, Layers, Check, ChevronRight, Search } from './icons';

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

function sortTasks(list) {
  const key = task => task.hongguoInfo?.series_id != null ? `series:${task.hongguoInfo.series_id}` : `task:${task.id}`;
  const groups = new Map();
  for (const task of list) {
    const group = groups.get(key(task)) || { rank: 99, time: 0 };
    group.rank = Math.min(group.rank, STATUS_ORDER[task.status] ?? 99);
    group.time = Math.max(group.time, task.startTime || 0);
    groups.set(key(task), group);
  }
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b), ga = groups.get(ka), gb = groups.get(kb);
    if (ka !== kb) return ga.rank - gb.rank || gb.time - ga.time || ka.localeCompare(kb, 'zh-CN', { numeric: true });
    return (Number(a.hongguoInfo?.vid_index) || 0) - (Number(b.hongguoInfo?.vid_index) || 0) || (a.startTime || 0) - (b.startTime || 0);
  });
}

function fmtElapsed(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value < 60 ? `${value} 秒` : value < 3600 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${Math.floor(value / 3600)} 小时 ${Math.floor(value % 3600 / 60)} 分`;
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

const PAGE_SIZE = 100;
const SERIES_PAGE_SIZE = 30;

function DownloadManager({ onNavigate, active = true, target = null }) {
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [queue, setQueue] = useState({ active: 0, queued: 0, maxConcurrent: 3 });
  const [seriesList, setSeriesList] = useState([]);
  const [seriesRefresh, setSeriesRefresh] = useState({ active: false, done: 0, total: 0 });
  const [selectedSeries, setSelectedSeries] = useState(null);
  const [seriesPage, setSeriesPage] = useState(1);
  const [seriesQuery, setSeriesQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeTasks, setMergeTasks] = useState([]);
  const [confirmAsk, setConfirmAsk] = useState(null); // 删除确认（可勾选删除本地文件）
  const [mergeAsk, setMergeAsk] = useState(false);    // 合并格式选择
  const [mergeScope, setMergeScope] = useState('all');
  const [mergeRange, setMergeRange] = useState('');
  const [mergeGroupSize, setMergeGroupSize] = useState('0');
  const [mergeRangeError, setMergeRangeError] = useState('');
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const [page, setPage] = useState(1);
  const [orderVersion, setOrderVersion] = useState(0);
  const [loadError, setLoadError] = useState('');
  const containerRef = useRef(null);
  const overviewScroll = useRef(0);
  const toastTimerRef = useRef(null);
  const refreshSeriesBusy = useRef(false);
  const handledTarget = useRef('');
  const activeRef = useRef(active);
  activeRef.current = active;
  const requests = useRef({ tasks: 0, queue: 0, series: 0, merges: 0 });
  const taskIndex = useRef(new Map());
  const seriesCards = useMemo(() => groupDownloadSeries(tasks, seriesList), [tasks, seriesList]);
  const currentSeries = selectedSeries && (seriesCards.find(series => series.key === selectedSeries.key) || selectedSeries);
  const scopedTasks = useMemo(() => selectedSeries
    ? tasks.filter(task => downloadSeriesKey(task) === selectedSeries.key)
    : tasks, [tasks, selectedSeries]);
  const mergeSeriesId = currentSeries?.seriesId || '';
  // Clearing download records must not hide an active merge or its exported file.
  const visibleMerges = selectedSeries
    ? mergeTasks.filter(task => String(task.seriesId) === mergeSeriesId)
    : mergeTasks.filter(task => !seriesCards.some(series => series.seriesId === String(task.seriesId)));
  const filteredSeries = seriesCards.filter(series => series.title.toLocaleLowerCase().includes(seriesQuery.trim().toLocaleLowerCase()));
  const seriesPageCount = Math.max(1, Math.ceil(filteredSeries.length / SERIES_PAGE_SIZE));
  const currentSeriesPage = Math.min(seriesPage, seriesPageCount);
  const visibleSeries = filteredSeries.slice((currentSeriesPage - 1) * SERIES_PAGE_SIZE, currentSeriesPage * SERIES_PAGE_SIZE);

  useEffect(() => {
    if (!active || !target?.seriesId || !seriesCards.length) return;
    const found = seriesCards.find(item => String(item.seriesId) === String(target.seriesId));
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
    setMergeAsk(false);
    setMergeScope('all');
    setMergeRange('');
    setMergeGroupSize('0');
    setMergeRangeError('');
    setPipelineStatus(null);
  };

  useEffect(() => {
    if (!active || !selectedSeries?.seriesId || typeof window.electronAPI.getSeriesPipelineStatus !== 'function') return undefined;
    let alive = true;
    window.electronAPI.getSeriesPipelineStatus(selectedSeries.seriesId).then(result => {
      if (alive && result?.success !== false && Array.isArray(result?.episodes)) setPipelineStatus(result);
    }).catch(() => {});
    return () => { alive = false; };
  }, [active, selectedSeries?.seriesId, orderVersion]);

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
      setOrderVersion(value => value + 1);
      const ids = new Set(list.map(task => task.id));
      setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
      setLoadError('');
      setLoaded(true);
    } catch (error) {
      if (activeRef.current && request === requests.current.tasks) setLoadError(error.message || '下载任务读取失败，请重试');
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

  const loadMergeTasks = useCallback(async () => {
    const request = ++requests.current.merges;
    try {
      const list = (await window.electronAPI.getMergeTasks()) || [];
      if (activeRef.current && request === requests.current.merges) setMergeTasks(list);
    } catch (_) {}
  }, []);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

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
        const summary = failed > 0 ? `已检查 ${total} 部，成功 ${succeeded} 部，失败 ${failed} 部` : added > 0 ? `已更新 ${total} 部，新增 ${added} 集` : `已检查 ${total} 部，暂无新增剧集`;
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
    loadMergeTasks();
    const patches = new Map();
    let batchTimer = null, fullRefresh = false, reorder = false, seriesDirty = false, queueDirty = false;
    const schedule = () => {
      if (batchTimer !== null) return;
      batchTimer = setTimeout(() => {
        batchTimer = null;
        if (fullRefresh) refresh();
        else if (patches.size) {
          const updates = new Map(patches);
          setTasks(previous => previous.map(task => updates.has(task.id) ? { ...task, ...updates.get(task.id) } : task));
          if (reorder) setOrderVersion(value => value + 1);
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
      window.electronAPI.onDownloadTaskAdded(() => { fullRefresh = seriesDirty = true; schedule(); }),
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
      window.electronAPI.onMergeTaskAdded(() => loadMergeTasks()),
      window.electronAPI.onMergeProgress((data) => {
        setMergeTasks((prev) =>
          prev.map((t) => (t.id === data.id ? { ...t, ...data } : t))
        );
      }),
      window.electronAPI.onMergeCompleted((data) => {
        loadMergeTasks();
        showToast(data.storageWarning || ('合并完成：' + (data.path ? data.path.split(/[\\/]/).pop() : '')), data.storageWarning ? 'error' : 'success');
      }),
      window.electronAPI.onMergeFailed((data) => {
        loadMergeTasks();
        showToast('合并失败：' + (data.error || '未知错误'), 'error');
      }),
    ];
    if (typeof window.electronAPI.onSeriesRefreshProgress === 'function') {
      cleanups.push(window.electronAPI.onSeriesRefreshProgress((data) => {
        if (!activeRef.current || !data) return;
        setSeriesRefresh(previous => ({
          active: true,
          total: Number(data.total) || previous.total || seriesCards.length,
          done: Math.min(Number(data.total) || previous.total || seriesCards.length, Number(data.done) || 0),
        }));
      }));
    }
    const timer = setInterval(() => {
      loadQueue();
      refresh();
      loadMergeTasks();
    }, 15000);
    return () => {
      cleanups.forEach(cleanup => cleanup());
      clearInterval(timer);
      clearTimeout(batchTimer);
      for (const key of Object.keys(requests.current)) requests.current[key]++;
    };
  }, [active, refresh, loadQueue, loadSeriesList, loadMergeTasks, showToast]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSelection = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(scopedTasks.map((task) => task.id)));
  const allSelected = scopedTasks.length > 0 && scopedTasks.every((task) => selected.has(task.id));
  const selectPage = ids => setSelected(previous => new Set([...previous, ...ids]));
  const clearPage = ids => setSelected(previous => new Set([...previous].filter(id => !ids.includes(id))));

  const fmtSize = (b) => {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
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
          showToast(deleteFiles
            ? `已删除 ${res.count} 个任务，释放 ${fmtSize(res.freed)}`
            : `已删除 ${res.count} 个任务记录（本地文件已保留）`);
        } catch (error) { showToast(error.message || '删除失败，请重试', 'error'); }
      },
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    askDelete(scopedTasks.filter((t) => selected.has(t.id)), '删除选中任务');
  };
  const retrySelected = async () => {
    if (selected.size === 0) return;
    const res = await window.electronAPI.retryTasks(Array.from(selected));
    setSelected(new Set());
    await refresh();
    if (res && res.success) {
      showToast(res.count > 0 ? `已重新加入队列：${res.count} 项` : '选中项中没有可重试的任务');
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  const mergeCandidates = useMemo(() => {
    if (selectedSeries?.seriesId && pipelineStatus === null) return [];
    const byIndex = new Map();
    const pipelineEpisodes = new Map((pipelineStatus?.episodes || []).map(item => [Number(item.episodeIndex), item]));
    for (const task of scopedTasks) {
      const index = Number(task.hongguoInfo?.vid_index);
      if (task.status !== 'completed' || !Number.isSafeInteger(index) || index < 1) continue;
      if (pipelineStatus?.episodes && !['deduped', 'segmented'].includes(String(pipelineEpisodes.get(index)?.status || ''))) continue;
      const previous = byIndex.get(index);
      if (!previous || (task.startTime || 0) > (previous.startTime || 0)) byIndex.set(index, task);
    }
    return [...byIndex.values()].sort((a, b) => Number(a.hongguoInfo.vid_index) - Number(b.hongguoInfo.vid_index));
  }, [scopedTasks, pipelineStatus]);

  const waitForMergeTask = async (id) => {
    for (let attempt = 0; attempt < 720; attempt++) {
      const list = await window.electronAPI.getMergeTasks();
      const task = Array.isArray(list) ? list.find(item => item.id === id) : null;
      if (task && task.status !== 'running') return task;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
  };

  // 一键合并：支持当前选中、区间和每 N 集分组。
  const doMerge = async (compatible) => {
    if (!mergeSeriesId) {
      showToast('请先选择要合并的短剧', 'error');
      return;
    }
    const candidates = mergeCandidates.filter(task => mergeScope === 'selected' ? selected.has(task.id) : true);
    if (!candidates.length) {
      showToast(mergeScope === 'selected' ? '请先在视频列表中选择已下载集数' : '没有可合并的已下载分集', 'error');
      return;
    }
    let filtered = candidates;
    if (mergeRange.trim()) {
      try {
        const total = Math.max(Number(currentSeries?.total) || 0, ...candidates.map(task => Number(task.hongguoInfo.vid_index)));
        const indexes = parseEpisodeRange(mergeRange, total);
        filtered = candidates.filter(task => indexes.has(Number(task.hongguoInfo.vid_index)));
      } catch (error) {
        setMergeRangeError(error.message);
        return;
      }
      if (!filtered.length) { setMergeRangeError('指定范围内没有已下载完成的分集。'); return; }
    }
    const size = Math.max(0, Number.parseInt(mergeGroupSize, 10) || 0);
    const groups = [];
    if (size > 0) {
      for (let offset = 0; offset + size <= filtered.length; offset += size) groups.push(filtered.slice(offset, offset + size));
      const skipped = filtered.length % size;
      if (!groups.length) { setMergeRangeError(`已下载 ${filtered.length} 集，不足每组 ${size} 集，未创建合并任务。`); return; }
      if (skipped) showToast(`最后 ${skipped} 集不足 ${size} 集，已按要求跳过`, 'success');
    } else groups.push(filtered);
    setMergeRangeError('');
    setMergeAsk(false);
    setMerging(true);
    try {
      let submitted = 0;
      for (const group of groups) {
        const indexes = group.map(task => Number(task.hongguoInfo.vid_index));
        const isSubset = indexes.length !== mergeCandidates.length || mergeScope === 'selected' || mergeRange.trim() || groups.length > 1;
        const first = indexes[0], last = indexes[indexes.length - 1];
        const outputName = isSubset ? `${currentSeries?.title || '短剧'}_第${first}-${last}集` : '';
        const res = await window.electronAPI.mergeSeries(mergeSeriesId, outputName, { compatible, episodeIndices: indexes });
        if (!res || !res.success) {
          showToast((res && res.error) || `第 ${first}-${last} 集合并失败`, 'error');
          break;
        }
        submitted++;
        await loadMergeTasks();
        if (groups.length > 1) {
          const finished = await waitForMergeTask(res.id);
          if (!finished) {
            showToast(`第 ${first}-${last} 集合并等待超时，后续分组未继续`, 'error');
            break;
          }
          if (finished.status !== 'completed') {
            showToast(`第 ${first}-${last} 集合并未完成：${finished.error || '任务已停止'}`, 'error');
            break;
          }
        }
      }
      if (submitted > 0) showToast(groups.length > 1 ? `已提交 ${submitted} 组分集合并任务` : `已提交 ${filtered.length} 集合并任务`);
    } catch (e) {
      showToast('合并异常: ' + e.message, 'error');
    } finally {
      setMerging(false);
    }
  };

  const cancelMerge = async (id) => {
    try {
      const result = await window.electronAPI.cancelMerge(id);
      if (!result?.success) throw new Error(result?.error || '取消请求失败，请重试');
      showToast('取消请求已发送，正在等待合并停止。');
      await loadMergeTasks();
    } catch (error) { showToast(error.message || '取消请求失败，请重试', 'error'); }
  };

  const openMergedFile = async (path) => {
    if (!path) return;
    await window.electronAPI.showInFolder(path);
  };

  // 一键暂停：取消进行中的 + 清空等待队列
  const pauseAll = async () => {
    const res = await window.electronAPI.pauseAll(selectedSeries ? scopedTasks.map(task => task.id) : undefined);
    await refresh();
    await loadQueue();
    showToast(res && res.success ? `已暂停 ${res.count} 个任务` : '暂停失败', res && res.success ? 'success' : 'error');
  };

  // 一键启动：把所有已停止/失败/等待中的任务重新排队开跑
  const resumeAll = async () => {
    const res = await window.electronAPI.resumeAll(selectedSeries ? scopedTasks.map(task => task.id) : undefined);
    await refresh();
    await loadQueue();
    showToast(res && res.success ? `已启动 ${res.count} 个任务` : '启动失败', res && res.success ? 'success' : 'error');
  };

  // 重试失败/已停止的任务
  const retryAllFailed = async () => {
    const ids = scopedTasks.filter((t) => t.status === 'failed' || t.status === 'stopped').map((t) => t.id);
    if (ids.length === 0) return;
    const res = await window.electronAPI.retryTasks(ids);
    await refresh();
    if (res && res.success) {
      showToast(`已重新加入队列：${res.count} 项`);
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  // 一键选中全部失败/已停止的任务（选中后可再点「重试选中」）
  const selectAllFailed = () => {
    const ids = scopedTasks.filter((t) => t.status === 'failed' || t.status === 'stopped').map((t) => t.id);
    if (ids.length === 0) {
      showToast('没有失败或已停止的任务');
      return;
    }
    setSelected(new Set(ids));
    showToast(`已选中 ${ids.length} 项，可点「重试选中」重新下载`);
  };

  const clearCompleted = async () => {
    const done = scopedTasks.filter((t) => t.status === 'completed');
    if (done.length === 0) return;
    askDelete(done, selectedSeries ? '清空本剧已完成任务' : '清空已完成任务');
  };

  // Progress updates change row values, not the established series/episode order.
  const sortedIds = useMemo(() => selectedSeries ? sortTasks(scopedTasks).map(task => task.id) : [], [orderVersion, selectedSeries]);
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  taskIndex.current = taskById;
  const pageCount = Math.max(1, Math.ceil(sortedIds.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleTasks = sortedIds.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(id => taskById.get(id)).filter(Boolean);
  const visibleTaskIds = visibleTasks.map(task => task.id);
  const allPageSelected = visibleTaskIds.length > 0 && visibleTaskIds.every(id => selected.has(id));

  const activeCount = scopedTasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
  const completedCount = scopedTasks.filter((t) => t.status === 'completed').length;
  const failedTasks = useMemo(
    () => scopedTasks.filter((t) => t.status === 'failed' || t.status === 'stopped'),
    [scopedTasks]
  );
  const failedCount = failedTasks.length;

  // 开始和暂停分别只针对可恢复与正在排队的任务。
  const pausableCount = useMemo(
    () => scopedTasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length,
    [scopedTasks]
  );

  const resumableCount = scopedTasks.filter(task => ['pending', 'failed', 'stopped'].includes(task.status)).length;

  // 已选中项里真正可重试的数量
  const retryableSelectedCount = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const t = taskById.get(id);
        return t && (t.status === 'failed' || t.status === 'stopped');
      }).length,
    [selected, taskById]
  );

  useDialogKeyboard(active && !!(confirmAsk || mergeAsk), () => { setConfirmAsk(null); setMergeAsk(false); }, '.dm-container .player-confirm');

  return (
    <div className="dm-container" ref={containerRef}>
      {selectedSeries && <button className="btn btn-outline dm-back" onClick={() => openSeries(null)}><ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />返回短剧列表</button>}
      <div className="dm-header">
        <div className="dm-title">
          <div><h2>{currentSeries?.title || '下载管理'}</h2><p className="page-description">{selectedSeries ? '查看全部分集和下载状态，下方管理本剧视频。' : `共 ${seriesCards.length} 部短剧，点击封面查看分集和视频列表。`}</p></div>
        </div>
        <div className="dm-stats">
          <span className="stat stat-active">进行中 {activeCount}</span>
          <span className="stat stat-done">已完成 {completedCount}</span>
          <span className="stat stat-fail">失败/停止 {failedCount}</span>
        </div>
      </div>

      {selectedSeries && mergeSeriesId && <SeriesEpisodePanel
        key={mergeSeriesId}
        seriesId={mergeSeriesId}
        title={currentSeries.title}
        cover={currentSeries.cover}
        lastUpdatedAt={currentSeries.lastUpdatedAt}
        active={active}
        revision={orderVersion}
        onDownloadsChanged={handleEpisodesChanged}
        onNotify={showToast}
        onNavigate={onNavigate}
      />}

      {selectedSeries && <h3 className="dm-video-heading">视频列表 <span>{scopedTasks.length} 个任务</span></h3>}
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
        <button
          className="btn btn-primary"
          onClick={resumeAll}
          disabled={resumableCount === 0}
          title={selectedSeries ? '开始本剧等待中、已停止和失败的任务' : '开始所有短剧的未完成任务'}
        >
          <Play size={15} />
          {selectedSeries ? '开始本剧' : '全部开始'}
        </button>
        <button
          className="btn btn-outline"
          onClick={pauseAll}
          disabled={pausableCount === 0}
          title={selectedSeries ? '仅暂停本剧正在下载和等待中的任务' : '暂停所有短剧的下载任务'}
        >
          <Pause size={15} />
          {selectedSeries ? '暂停本剧' : '全部暂停'}
        </button>
        <button
          className="btn btn-outline"
          onClick={retryAllFailed}
          disabled={failedCount === 0}
          title={selectedSeries ? '重试本剧失败或已停止的任务' : '重试所有短剧失败或已停止的任务'}
        >
          <Zap size={15} />
          {failedCount > 0 ? `重试失败 (${failedCount})` : '重试失败'}
        </button>
        <details className="dm-more-actions"><summary>更多操作</summary><div className="dm-more-menu">
        {selectedSeries && <>
        <button
          className="btn btn-outline"
          onClick={selectAllFailed}
          disabled={failedCount === 0}
          title="一键勾选所有失败/已停止的任务"
        >
          <CheckSquare size={15} />
          {failedCount > 0 ? `选中失败项 (${failedCount})` : '选中失败项'}
        </button>
        <button className="btn btn-outline" onClick={retrySelected} disabled={retryableSelectedCount === 0}>
          <RefreshCw size={15} />
          重试选中 ({retryableSelectedCount})
        </button>
        <button className="btn btn-outline" onClick={deleteSelected} disabled={selected.size === 0}>
          <Trash2 size={15} />
          删除选中
        </button>
        <button className="btn btn-outline" onClick={clearSelection} disabled={selected.size === 0}>取消选择</button>
        </>}
        <button className="btn btn-outline" onClick={clearCompleted} disabled={completedCount === 0}>
          <X size={15} />
          清空已完成
        </button>
        <button
          className="btn btn-outline"
          onClick={async () => {
            const r = await window.electronAPI.rescanDownloads();
            await refresh();
            showToast(r && r.success
              ? (r.count > 0 ? `已从磁盘补回 ${r.count} 条下载记录` : '没有发现未登记的文件')
              : '扫描失败');
          }}
          title="扫描下载目录，把磁盘上已有但列表里没有的文件补登记回来"
        >
          <RefreshCw size={15} />
          扫描下载目录
        </button>
        </div></details>
        {selectedSeries && mergeSeriesId && (
          <div className="merge-inline" id="dm-merge-action">
            <button className="btn btn-outline" onClick={() => setMergeAsk(true)} disabled={merging || mergeCandidates.length === 0} title="把已完成去重的分集按范围和每组集数生成最终成品">
              <Layers size={15} />
              {merging ? '生成中...' : '分组并生成成品'}
            </button>
          </div>
        )}
        {onNavigate && !selectedSeries && (
          <button className="btn btn-primary dm-toolbar-end" onClick={() => onNavigate('download')}>
            <Film size={15} />
            添加下载
          </button>
        )}
      </div>

      {selectedSeries && mergeSeriesId && <p className="settings-hint dm-merge-hint">这里只使用已完成去重的分集；先完成去重后，这里才会出现可生成的数量。</p>}

      {/* 合并任务 */}
      {visibleMerges.length > 0 && (
        <div className="merge-list">
          {visibleMerges.map((m) => (
            <div key={m.id} className={`merge-card merge-${m.status}`}>
              <Layers size={16} />
              <div className="merge-body">
                <div className="merge-title">
                  合并《{m.seriesTitle}》· {m.done || 0}/{m.total} 集
                </div>
                <div className="merge-sub">
                  {m.status === 'running' && <>{m.stageText || '正在合并'}{m.method && m.method !== m.stageText ? ` · ${m.method}` : ''}</>}
                  {m.status === 'completed' && (
                    <>
                      已完成 · {m.outputName}
                      {m.outputBytes ? ` · ${fmtBytes(m.outputBytes)}` : ''}
                    </>
                  )}
                  {m.status === 'failed' && <>失败：{m.error}</>}
                  {m.status === 'stopped' && <>{m.error || '已取消'}</>}
                </div>
                <div className="merge-metrics">
                  <span>{m.stage === 'checking' ? `已检查 ${m.checked || 0}` : `已处理 ${m.done || 0}`} / {m.total} 集</span>
                  <span>用时 {fmtElapsed(m.status === 'running' ? (Date.now() - m.startTime) / 1000 : m.elapsedSeconds || ((m.endTime || m.startTime) - m.startTime) / 1000)}</span>
                  {m.status === 'running' && m.speed > 0 && <span>{m.speed.toFixed(1)} 倍速</span>}
                  {m.status === 'running' && Number.isFinite(m.etaSeconds) && <span>本阶段约剩 {fmtElapsed(m.etaSeconds)}</span>}
                </div>
                {(m.codecWarning || m.storageWarning || m.cleanupWarning) && <div className="merge-note">{m.storageWarning || m.cleanupWarning || m.codecWarning}</div>}
                {(m.status === 'running') && (
                  <div className="dm-progress">
                    <div className="dm-progress-bar" role="progressbar" aria-label="合并进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.progress || 0}>
                      <div className="dm-progress-fill" style={{ width: `${m.progress || 0}%` }} />
                    </div>
                    <span className="dm-pct">{m.progress || 0}%</span>
                  </div>
                )}
              </div>
              <div className="merge-actions">
                {m.status === 'running' && (
                  <button className="icon-btn" title="取消合并" onClick={() => cancelMerge(m.id)}>
                    <X size={16} />
                  </button>
                )}
                {m.status === 'completed' && (
                  <button className="icon-btn" title="打开所在文件夹" onClick={() => openMergedFile(m.output)}>
                    <Folder size={16} />
                  </button>
                )}
                {m.status !== 'running' && (
                  <button
                    className="icon-btn icon-btn-danger"
                    title="移除记录"
                    onClick={async () => {
                      try {
                        const result = await window.electronAPI.deleteMergeTask(m.id);
                        if (!result?.success) throw new Error(result?.error || '移除记录失败');
                        await loadMergeTasks();
                      } catch (error) { showToast(error.message || '移除记录失败，请重试', 'error'); }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {queue.active > 0 && (
        <div className="dm-queue-bar">
          <span className="dm-queue-running">
            <span className="dm-queue-pulse" />
            全局并发下载 <b>{queue.active}</b> / {queue.maxConcurrent}
            {queue.queued > 0 ? <> · 队列等待 <b>{queue.queued}</b></> : null}
          </span>
          <span className="dm-queue-hint">
            并发数可在「设置 → 最大并发下载数」调整
          </span>
        </div>
      )}

      {retryableSelectedCount > 0 && (
        <div className="dm-hint">
          已选中 <b>{retryableSelectedCount}</b> 个失败项，点
          <b>「重试选中」</b> 即会重新下载（无需重新解析）。
        </div>
      )}

      {loadError && <div className="alert alert-error" role="alert">{loadError}<button className="btn btn-outline btn-sm" onClick={refresh}>重新加载</button></div>}
      {selectedSeries && scopedTasks.length > 0 && <div className="dm-pagination">
        <div className="dm-selection-summary">
          <button className="btn btn-outline btn-sm" onClick={allSelected ? clearSelection : selectAll}
            title={allSelected ? '取消本剧所有分页中的选择' : `选中本剧全部 ${scopedTasks.length} 项，包含其他分页`}>
            <CheckSquare size={15} />{allSelected ? '取消全选本剧' : '全选本剧'}
          </button>
          <button className="btn btn-outline btn-sm" onClick={allPageSelected ? () => clearPage(visibleTaskIds) : () => selectPage(visibleTaskIds)}
            title={allPageSelected ? '取消当前页选择' : `选中当前页 ${visibleTaskIds.length} 项`}>
            <CheckSquare size={15} />{allPageSelected ? '取消本页' : '全选本页'}
          </button>
          {selected.size > 0 && <button className="btn btn-outline btn-sm" onClick={clearSelection}>取消选择</button>}
          {selected.size > 0 && <button className="btn btn-outline btn-sm" onClick={retrySelected} disabled={retryableSelectedCount === 0}>
            <RefreshCw size={14} />重试选中 ({retryableSelectedCount})
          </button>}
          {selected.size > 0 && <button className="btn btn-outline btn-sm" onClick={deleteSelected}>
            <Trash2 size={14} />删除选中
          </button>}
        <span>共 {scopedTasks.length} 项 · 当前 {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, scopedTasks.length)} 项{selected.size > 0 ? ` · 已选 ${selected.size} 项（跨页保留）` : ''}</span>
        </div>
        <nav aria-label="下载任务分页">
          <button className="btn btn-outline btn-sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <span>第 {currentPage} / {pageCount} 页</span>
          <button className="btn btn-outline btn-sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </nav>
      </div>}

      {!selectedSeries ? (
        <>
          <div className="dm-series-toolbar">
            <label className="dm-series-search"><Search size={16} /><input aria-label="搜索已添加的短剧" placeholder="搜索剧名" value={seriesQuery} onChange={event => { setSeriesQuery(event.target.value); setSeriesPage(1); }} /></label>
            <span>{filteredSeries.length} 部短剧</span>
          </div>
          {!loaded && !loadError ? <div className="browse-loading" role="status">正在读取下载记录…</div> : filteredSeries.length === 0 ? (
            <div className="dm-empty">
              <Download size={40} />
              <p>{seriesQuery.trim() ? '没有找到匹配的短剧' : '暂无下载任务'}</p>
              <p className="dm-empty-sub">{seriesQuery.trim() ? '换个剧名试试。' : '搜索剧名或粘贴分享链接，选择想保存的集数。'}</p>
              {!seriesQuery.trim() && onNavigate && <button className="btn btn-primary" onClick={() => onNavigate('download')}>添加第一部短剧</button>}
            </div>
          ) : (
            <div className="browse-grid">
              {visibleSeries.map(series => (
                <button type="button" key={series.key} className="browse-card" data-series-key={series.key} onClick={() => openSeries(series)} title={series.title} aria-label={`查看《${series.title}》的视频，已下载 ${series.completed} 集`}>
                  <div className="browse-cover">
                    {series.cover ? <img src={series.cover} alt="" loading="lazy" /> : <div className="cover-placeholder"><Film size={22} /></div>}
                    {series.total > 0 && <span className="browse-ep-badge">全{series.total}集</span>}
                    <span className="browse-dl-badge"><Check size={11} />{series.completed}{series.total > 0 ? `/${series.total}` : ' 集'}</span>
                    <div className="browse-hover"><span className="browse-hover-play"><Film size={16} />查看视频</span></div>
                  </div>
                  <div className="browse-card-title">{series.title}</div>
                  <div className="dm-card-count">已下载 {series.completed}{series.total > 0 ? ` / ${series.total}` : ''} 集</div>
                  <div className="dm-card-updated">上次更新：{formatSeriesUpdatedAt(series.lastUpdatedAt)}</div>
                  <div className="browse-card-tags">
                    <span className="browse-tag">{series.seriesId?.startsWith('xifan:') ? '西饭短剧' : series.seriesId?.startsWith('hema:') ? '河马短剧' : series.seriesId ? '红果短剧' : '本地任务'}</span>
                    {series.downloading + series.pending > 0 && <span className="browse-tag">进行中 {series.downloading + series.pending}</span>}
                    {series.failed + series.stopped > 0 && <span className="browse-tag">失败/停止 {series.failed + series.stopped}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
          {seriesPageCount > 1 && <nav className="browse-pager" aria-label="短剧分页">
            <button className="btn btn-outline btn-sm" disabled={currentSeriesPage <= 1} onClick={() => setSeriesPage(currentSeriesPage - 1)}>上一页</button>
            <span>第 {currentSeriesPage} / {seriesPageCount} 页</span>
            <button className="btn btn-outline btn-sm" disabled={currentSeriesPage >= seriesPageCount} onClick={() => setSeriesPage(currentSeriesPage + 1)}>下一页</button>
          </nav>}
        </>
      ) : scopedTasks.length === 0 ? (
        <div className="dm-empty">
          <Download size={40} />
          <p>本剧暂无下载任务</p>
          <button className="btn btn-outline" onClick={() => openSeries(null)}>返回短剧列表</button>
        </div>
      ) : (
        <div className="dm-list">
          {visibleTasks.map((task) => {

            const isSel = selected.has(task.id);
            const canStop = task.status === 'downloading';
            const canRetry = task.status === 'failed' || task.status === 'stopped';
            const pct = task.progress || 0;
            return (
              <div key={task.id} className={`dm-task ${isSel ? 'selected' : ''}`} onClick={() => toggleSelect(task.id)}>
                <input className="dm-task-select" type="checkbox" aria-label={`选择 ${task.title || task.filename}`} checked={isSel} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelect(task.id)} />
                <div className="dm-task-cover">
                  {task.videoInfo && task.videoInfo.cover ? (
                    <img src={task.videoInfo.cover} alt="" />
                  ) : (
                    <div className="cover-placeholder"><Film size={18} /></div>
                  )}
                </div>
                <div className="dm-task-body">
                  <div className="dm-task-title">{task.title || task.filename}</div>
                  <div className="dm-task-meta">
                    <span className={`status-tag status-${task.status}`}>{STATUS_TEXT[task.status] || task.status}</span>
                    {task.status === 'downloading' && task.totalBytes > 0 && (
                      <span className="dm-size">{fmtBytes(task.receivedBytes)} / {fmtBytes(task.totalBytes)}</span>
                    )}
                    {task.status === 'failed' && task.error && <span className="dm-error">{task.error}</span>}
                  </div>
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
                  {canStop && (
                    <button className="icon-btn" title="停止" onClick={() => { window.electronAPI.stopDownload(task.id); refresh(); }}>
                      <Square size={16} />
                    </button>
                  )}
                  {canRetry && (
                    <button className="icon-btn" title="重试" onClick={() => { window.electronAPI.retryTask(task.id); }}>
                      <RefreshCw size={16} />
                    </button>
                  )}
                  <button className="icon-btn" title="打开文件夹" onClick={() => window.electronAPI.openFolder(task.id)}>
                    <Folder size={16} />
                  </button>
                  <button
                    className="icon-btn icon-btn-danger"
                    title="删除任务（可选是否同时删除本地文件）"
                    onClick={() => {
                      askDelete([task], `删除《${task.hongguoInfo && task.hongguoInfo.series_title ? task.hongguoInfo.series_title : ''}》第 ${task.hongguoInfo ? task.hongguoInfo.vid_index : ''} 集任务`);
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

      {selectedSeries && scopedTasks.length > 0 && <div className="dm-pagination dm-pagination-bottom">
        <span>当前第 {currentPage} / {pageCount} 页 · 共 {scopedTasks.length} 项</span>
        <nav aria-label="下载任务底部分页">
          <button className="btn btn-outline btn-sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <button className="btn btn-outline btn-sm" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </nav>
      </div>}

      {toast && (
        <div className={`dm-toast dm-toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {/* 合并格式与范围选择 */}
      {mergeAsk && (
        <div className="player-confirm-mask" onClick={() => setMergeAsk(false)}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={confirmAsk ? confirmAsk.title : '合并导出'} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title" style={{ color: 'var(--accent)' }}>
              <Layers size={17} />
              合并已下载分集
            </div>
            <div className="player-confirm-msg">
              <div className="merge-options">
                <label className="merge-option-row">
                  <span>合并范围</span>
                  <select value={mergeScope} onChange={event => { setMergeScope(event.target.value); setMergeRangeError(''); }}>
                    <option value="all">全部已下载集（{mergeCandidates.length}）</option>
                    <option value="selected" disabled={!selected.size}>视频列表中已选集（{mergeCandidates.filter(task => selected.has(task.id)).length}）</option>
                  </select>
                </label>
                <label className="merge-option-row">
                  <span>指定集数</span>
                  <input value={mergeRange} placeholder="留空表示全部，例如 1-50,61" onChange={event => { setMergeRange(event.target.value); setMergeRangeError(''); }} />
                </label>
                <label className="merge-option-row">
                  <span>每组集数</span>
                  <span className="merge-group-input"><input type="number" min="0" step="1" value={mergeGroupSize} onChange={event => { setMergeGroupSize(event.target.value); setMergeRangeError(''); }} /><small>0 表示不分组；最后不足一组会跳过</small></span>
                </label>
              </div>
              {mergeRangeError && <p className="alert alert-error merge-range-error" role="alert">{mergeRangeError}</p>}
              <p>《{currentSeries?.title || '所选短剧'}》当前可合并 <b>{mergeCandidates.length}</b> 集。未下载的分集不会自动补齐；指定范围只会从已下载完成的分集中筛选。</p>
              <p><b>智能快速合并</b>：格式一致时无损合并；不一致时只处理必要的音视频，耗时取决于总时长。</p>
              <p><b>兼容合并</b>：导出 H.264/AAC，已经兼容的分集无需重复转换。两种方式都保留原文件。</p>
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setMergeAsk(false)}>取消</button>
              <button className="btn btn-outline" onClick={() => doMerge(true)} disabled={merging}>
                兼容合并（H.264）
              </button>
              <button className="btn btn-primary" onClick={() => doMerge(false)} disabled={merging}>
                智能快速合并
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认（可选是否连本地文件一起删） */}
      {confirmAsk && (
        <div className="player-confirm-mask" onClick={() => setConfirmAsk(null)}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={confirmAsk ? confirmAsk.title : '合并导出'} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {confirmAsk.title}
            </div>
            <div className="player-confirm-msg">
              <p>共 {confirmAsk.count} 个任务，其中 {confirmAsk.withFile} 个已下载完成
                {confirmAsk.estBytes > 0 ? `（约 ${fmtSize(confirmAsk.estBytes)}）` : ''}。</p>
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
              <button className="btn btn-outline" onClick={() => setConfirmAsk(null)}>取消</button>
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
