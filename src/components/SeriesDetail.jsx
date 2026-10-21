import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './SeriesDetail.css';
import { Check, Folder, RefreshCw } from './icons';
import DedupParams, { rangeProblems } from './DedupParams';
import PublishPanel from './PublishPanel';
import Pager from './Pager';
import SeriesProgress, { isActiveBatch } from './SeriesProgress';
import useLiveData from './useLiveData';
import useDialogKeyboard from './useDialogKeyboard';
import { clampPage, slicePage } from './pagination';

// 画面参数的项目和默认值换过一版：换个键，旧的保存值不再覆盖新默认值。
const STORAGE_KEY = 'library-params-v2';
// 旧成品挪去哪里：Mac 叫废纸篓，Windows 叫回收站。
const TRASH = /Mac/.test((typeof navigator !== 'undefined' && navigator.platform) || '') ? '废纸篓' : '回收站';
const VIEW_KEY = 'library-view';
/** 草稿默认做新剧的前 4 集：从「新集编号」起连续 4 个。 */
const defaultDraftNums = (start) => [0, 1, 2, 3].map((n) => String((Math.floor(Number(start)) || 1) + n));
const DEFAULT_SPLIT = { min_len: 30, max_len: 65, head_trim: 1.1, tail_trim: 1.2, start_number: 1 };
const DEFAULT_SPEED = { speed_min: 1.03, speed_max: 1.21 };
const EPISODE_PAGE_SIZES = [30, 60, 100, 200];
const DRAFT_MODES = [
  ['simple', '3 分轨', '文案、视频、音频各一条轨道，直接用分镜解析结果切原视频'],
  [
    'multi',
    '多分轨',
    '走完整的视频结构化拆解（分镜、人声/背景分离、台词识别、分镜导出），生成视频片段、文案、字幕、配音、背景声、特效声等多条轨道',
  ],
];

function readJson(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || '{}') || {};
  } catch (_) {
    return {};
  }
}
function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* 存储不可用时，只是不记住上次的设置。 */
  }
}

const formatSize = (bytes) => {
  const mb = Number(bytes) / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
};

const formatTime = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '时间未知';
  const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 一个缺集的占位标签：失败时写出具体原因，暂停和下载中也说清楚。 */
function ghostLabel(item) {
  const task = item.task;
  if (item.state === 'failed' && task) {
    if (task.status === 'stopped') return '已暂停';
    return task.reason?.label || '下载失败';
  }
  if (item.state === 'downloading' && task) {
    return task.status === 'pending' ? '排队中' : `下载中 ${task.progress}%`;
  }
  return item.text;
}

/** 所选几集的整个分镜工程图：按集切换，原样显示分镜头脚本页面（三栏分镜卡片）。 */
function StoryboardResults({ dir, numbers, enabled, refreshKey }) {
  const [items, setItems] = useState([]);
  const [current, setCurrent] = useState(null);
  const [page, setPage] = useState({ html: '', error: '', loading: false });
  const [openError, setOpenError] = useState('');
  const numbersKey = numbers.join(',');

  useEffect(() => {
    let alive = true;
    window.electronAPI
      .libraryStoryboards?.({ dir, numbers })
      .then((result) => alive && setItems(result?.success ? result.items : []))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, numbersKey, refreshKey]);

  const ready = items.filter((item) => item.state === 'ready');
  const selected = ready.find((item) => item.number === current) || ready[0] || null;
  const selectedNumber = selected?.number;
  const selectedStamp = selected?.updatedAt;
  useEffect(() => {
    if (selectedNumber == null) return undefined;
    let alive = true;
    setPage((previous) => ({ ...previous, loading: true, error: '' }));
    window.electronAPI
      .libraryStoryboardHtml({ dir, number: selectedNumber })
      .then((result) => {
        if (!alive) return;
        setPage(
          result?.success
            ? { html: result.html, error: '', loading: false }
            : { html: '', error: result?.error || '打不开', loading: false },
        );
      })
      .catch(() => alive && setPage({ html: '', error: '打不开', loading: false }));
    return () => {
      alive = false;
    };
  }, [dir, selectedNumber, selectedStamp]);

  if (!selected) {
    return enabled ? <p className="sb-hint">分镜处理完、提示词写好后，所选集的整个分镜工程图会出现在这里。</p> : null;
  }
  const open = async () => {
    setOpenError('');
    const result = await window.electronAPI.libraryStoryboardOpen({ dir, number: selected.number });
    if (!result?.success) setOpenError(result?.error || '打开失败');
  };
  return (
    <div className="sb-results">
      <div className="sb-tabs" role="tablist" aria-label="分镜工程图">
        {items.map((item) => (
          <button
            key={item.number}
            role="tab"
            aria-selected={item.number === selected.number}
            className={`sb-tab ${item.number === selected.number ? 'is-active' : ''}`}
            disabled={item.state !== 'ready'}
            title={
              item.state === 'no-episode' ? '去重成品里还没有这一集' : item.state === 'none' ? '这一集还没有生成' : ''
            }
            onClick={() => setCurrent(item.number)}
          >
            第 {item.number} 集{item.state === 'none' && <em>未生成</em>}
            {item.state === 'no-episode' && <em>无成品</em>}
          </button>
        ))}
        <button className="btn btn-sm sb-open" onClick={open}>
          在浏览器中打开
        </button>
      </div>
      {page.error ? (
        <p className="sb-hint is-error">{page.error}</p>
      ) : (
        <iframe
          key={`${selected.number}-${selected.updatedAt}`}
          className="sb-frame"
          title={`第 ${selected.number} 集分镜工程图`}
          sandbox="allow-scripts"
          allowFullScreen
          srcDoc={page.html}
        />
      )}
      {openError && <p className="sb-hint is-error">{openError}</p>}
    </div>
  );
}

/** 「去重处理后」：最近一次去重用了原剧第几集到第几集、多少集参与去重、生成了多少集。 */
function DedupResult({ record, outputCount, running }) {
  const done = running.reduce((n, batch) => n + (batch.done || 0), 0);
  const planned = running.reduce((n, batch) => n + (batch.total || 0), 0);
  if (!record && !outputCount)
    return (
      <p className="dedup-result-empty">还没有去重。勾选上面的「视频去重」开始处理后，这里显示去重的范围和结果。</p>
    );
  const range = (from, to) =>
    from != null && to != null ? (from === to ? `第 ${from} 集` : `第 ${from}–${to} 集`) : '—';
  const tiles = record
    ? [
        ['原剧范围', range(record.sourceFrom, record.sourceTo)],
        ['已去重', `${record.sourceCount} 集`, '原剧参与去重的集数'],
        [
          '结果',
          `${record.resultCount} 集`,
          `${range(record.resultFrom, record.resultTo)} · 每集 ${Math.round(record.minSeconds)}–${Math.round(record.maxSeconds)} 秒`,
        ],
        [
          '「去重」文件夹',
          planned ? `${done}/${planned} 集` : `${outputCount} 集`,
          planned
            ? '正在去重'
            : outputCount < record.resultCount
              ? `比结果少 ${record.resultCount - outputCount} 集（没做完或被删了）`
              : '都已生成',
        ],
      ]
    : [['「去重」文件夹', `${outputCount} 集`, '以前的版本做的，没有记录范围和参数']];
  return (
    <div className="dedup-result">
      {tiles.map(([label, value, hint]) => (
        <div key={label} className="dedup-result-tile">
          <span>{label}</span>
          <b>{value}</b>
          {hint && <em>{hint}</em>}
        </div>
      ))}
    </div>
  );
}

/** 剧的子页面：剧名在页头，下面是这部剧的集（分页）、AI 发布素材、要做的处理（去重、剪映草稿）和进度日志。 */
export default function SeriesDetail({ folder, active = true }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [remoteNote, setRemoteNote] = useState('');
  const [selected, setSelected] = useState(new Set());
  const saved = useRef(readJson(STORAGE_KEY)).current;
  const view = useRef(readJson(VIEW_KEY)).current;
  const [opts, setOpts] = useState(null);
  const [split, setSplit] = useState({ ...DEFAULT_SPLIT, ...(saved.split || {}) });
  const [dedupOn, setDedupOn] = useState(saved.dedupOn !== false);
  const [draftOn, setDraftOn] = useState(saved.draftOn === true);
  const [draftMode, setDraftMode] = useState(saved.draftMode === 'multi' ? 'multi' : 'simple');
  // 做草稿的同时，从视频里反推 Seedance 2.5 提示词（要在设置里填火山方舟）。
  const [draftPrompts, setDraftPrompts] = useState(saved.draftPrompts === true);
  // 草稿最多做 4 集，每格自由填成品集号（默认 1–4）。
  const [draftNums, setDraftNums] = useState(
    Array.isArray(saved.draftNums) && saved.draftNums.length === 4
      ? saved.draftNums.map(String)
      : defaultDraftNums(saved.split?.start_number),
  );
  const [showParams, setShowParams] = useState(false); // 去重参数弹窗
  const [showSaved, setShowSaved] = useState(false); // 上次处理参数弹窗（只看）
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [decision, setDecision] = useState(null);
  const [preview, setPreview] = useState(false); // 开始处理前的预览确认
  const [outputCount, setOutputCount] = useState(0); // 「去重」里已有的成品集数（再次去重会全部换掉）
  const [estimate, setEstimate] = useState({ loading: false, data: null, error: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(
    EPISODE_PAGE_SIZES.includes(view.episodePageSize) ? view.episodePageSize : 60,
  );
  const [publish, setPublish] = useState(null); // AI 发布素材的最新结果（新海报、新剧名）
  const requestId = useRef(0);
  const progressRef = useRef(null);
  const reloadTimer = useRef(null);
  const detailRef = useRef(null);
  detailRef.current = detail;

  // 处理进度、补下载任务和日志都存在主进程里：切到别的页面再回来、重启应用后读到的还是同一份。
  const [activity, refreshActivity] = useLiveData({
    load: async () => {
      const result = await window.electronAPI.libraryActivity(folder.path);
      return result?.success ? result : null;
    },
    isBusy: (data) =>
      !!data.planning ||
      data.draft?.status === 'running' ||
      data.batches.some(isActiveBatch) ||
      data.jobs.some((job) => ['waiting', 'starting'].includes(job.status)),
    active,
    watch: folder.path,
  });

  // 读取这部剧：先用本地记录显示，再向来源平台核对最新集数。
  const open = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    setNotice('');
    let result = null;
    try {
      result = await window.electronAPI.libraryEpisodes(folder.path);
    } catch (_) {
      result = { success: false, error: '读取这部剧失败，请稍后重试' };
    }
    if (id !== requestId.current) return;
    setLoading(false);
    if (!result?.success) return setError(result?.error || '打开失败');
    setDetail({ ...result, source: folder.source, totalEpisodes: folder.totalEpisodes });
    setSelected(new Set(result.episodes.map((episode) => episode.path)));
    setRemoteNote('');
    if (!result.linked) return;
    setRemoteNote('正在向来源平台核对最新集数…');
    const fresh = await window.electronAPI.libraryRefreshRemote(folder.path).catch(() => null);
    if (id !== requestId.current) return;
    if (fresh?.success) {
      setDetail((previous) =>
        previous ? { ...previous, missing: fresh.missing, remoteUpdatedAt: fresh.remoteUpdatedAt } : previous,
      );
      // 核对成功不用说；没连上才提醒一句。
      setRemoteNote(
        fresh.refreshed ? '' : `没连上来源平台，缺集状态按上次记录（${formatTime(fresh.remoteUpdatedAt)}）判断。`,
      );
    } else setRemoteNote('');
  }, [folder.path, folder.source, folder.totalEpisodes]);

  useEffect(() => {
    open();
    return () => {
      requestId.current++;
    };
  }, [open]);

  // 只刷新集和缺集状态（不重新联网核对、不动选择）。下载有变化时调用。
  const reload = useCallback(async () => {
    const result = await window.electronAPI.libraryEpisodes(folder.path).catch(() => null);
    if (!result?.success) return;
    setDetail((previous) =>
      previous
        ? {
            ...previous,
            episodes: result.episodes,
            missing: result.missing,
            coverUrl: result.coverUrl,
            outputCount: result.outputCount,
            lastDedup: result.lastDedup,
          }
        : previous,
    );
  }, [folder.path]);

  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(reload, 400);
  }, [reload]);

  // 下载完成/失败/暂停/加入队列时刷新；有下载在跑时每 2 秒刷新一次进度。
  useEffect(() => {
    const api = window.electronAPI;
    const offs = [
      api.onDownloadCompleted?.(scheduleReload),
      api.onDownloadFailed?.(scheduleReload),
      api.onDownloadStopped?.(scheduleReload),
      api.onDownloadTaskAdded?.(scheduleReload),
      api.onDownloadQueueChanged?.(scheduleReload),
    ];
    const timer = setInterval(() => {
      const missing = detailRef.current?.missing || [];
      if (missing.some((item) => item.state === 'downloading')) reload();
    }, 2000);
    return () => {
      offs.forEach((off) => off?.());
      clearInterval(timer);
      clearTimeout(reloadTimer.current);
    };
  }, [reload, scheduleReload]);

  useEffect(() => {
    let alive = true;
    // 并发数和编码方式只认「设置」，保存的旧参数里的 jobs/encoder 不再盖回去。
    const { jobs: _jobs, encoder: _encoder, ...savedOpts } = saved.opts || {};
    window.electronAPI
      .quchongDefaults?.()
      .then((defaults) => {
        if (alive && defaults) setOpts({ ...defaults, ...DEFAULT_SPEED, ...savedOpts });
      })
      .catch(() => {
        if (alive) setNotice('读取去重参数失败，请重新打开这部剧');
      });
    return () => {
      alive = false;
    };
  }, [saved]);

  useEffect(() => {
    if (opts) {
      const { jobs: _jobs, encoder: _encoder, ...keep } = opts;
      writeJson(STORAGE_KEY, { opts: keep, split, dedupOn, draftOn, draftMode, draftPrompts, draftNums });
    }
  }, [opts, split, dedupOn, draftOn, draftMode, draftPrompts, draftNums]);
  useEffect(() => {
    writeJson(VIEW_KEY, { ...readJson(VIEW_KEY), episodePageSize: pageSize });
  }, [pageSize]);

  const resetParams = async () => {
    const defaults = await window.electronAPI.quchongDefaults?.().catch(() => null);
    if (defaults) setOpts({ ...defaults, ...DEFAULT_SPEED });
    setSplit({ ...DEFAULT_SPLIT });
  };

  const episodes = detail?.episodes || [];
  const selectedCount = useMemo(() => episodes.filter((item) => selected.has(item.path)).length, [episodes, selected]);

  // 重新拆分按时间线处理：整部，或从第一集起的前 N 集，不能跳着选。
  const isPrefix = selectedCount > 0 && episodes.slice(0, selectedCount).every((item) => selected.has(item.path));
  const setPrefix = (count) => {
    const size = Math.max(0, Math.min(episodes.length, Math.floor(Number(count)) || 0));
    setSelected(new Set(episodes.slice(0, size).map((item) => item.path)));
  };
  const clickEpisode = (episode, position) => {
    // 点第 N 集 = 处理到这一集为止；再点最后选中的那一集 = 往回缩一集。
    setPrefix(selected.has(episode.path) && position === selectedCount - 1 ? position : position + 1);
  };
  useEffect(() => {
    // 切到「重新拆分」时，如果现在的选择不是从第一集起的连续前缀，就改成整部。
    if (episodes.length && selectedCount > 0 && !isPrefix) setPrefix(episodes.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes.length, selectedCount, isPrefix]);

  // 预览：按选中的集和当前参数估算会得到多少集（改参数、改范围后稍等一下自动更新）。
  const selectedKey = episodes
    .filter((item) => selected.has(item.path))
    .map((item) => item.path)
    .join('|');
  const estimateKey = JSON.stringify([selectedKey, split, opts?.speed_min, opts?.speed_max]);
  useEffect(() => {
    if (!detail?.dir || !selectedKey || !opts || !isPrefix) {
      setEstimate({ loading: false, data: null, error: '' });
      return undefined;
    }
    let alive = true;
    setEstimate((previous) => ({ ...previous, loading: true, error: '' }));
    const timer = setTimeout(async () => {
      const result = await window.electronAPI
        .libraryEstimate?.({
          dir: detail.dir,
          files: selectedKey.split('|'),
          opts,
          split,
        })
        .catch(() => ({ success: false, error: '估算失败，请稍后重试' }));
      if (!alive) return;
      if (result?.success) setEstimate({ loading: false, data: result, error: '' });
      else setEstimate({ loading: false, data: null, error: result?.error || '估算失败' });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey, detail?.dir]);

  // 磁盘上的集和缺集占位按集号排在一起；缺集的占位不能选。
  const cards = useMemo(() => {
    const list = episodes.map((episode) => ({ kind: 'episode', key: episode.path, index: episode.index, episode }));
    for (const item of detail?.missing || [])
      list.push({ kind: 'missing', key: `missing-${item.index}`, index: item.index, item });
    return list.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  }, [episodes, detail]);

  const currentPage = clampPage(page, cards.length, pageSize);
  const visible = slicePage(cards, currentPage, pageSize);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  // 缺集的原因就写在集的标签上；失败的点一下重试，没下载的点一下下载。
  const tileAction = (item) => {
    if (item.state === 'failed' && item.task) return () => window.electronAPI.retryTask(item.task.id);
    if (item.state === 'notDownloaded' && detail?.linked)
      return () => window.electronAPI.downloadSingleEpisode(detail.seriesId, item.index);
    return null;
  };
  const runTile = async (action) => {
    setNotice('');
    try {
      const result = await action();
      if (result && result.success === false) setNotice(result.error || '操作失败');
    } catch (e) {
      setNotice(e?.message || '操作失败');
    }
    reload();
  };

  // 点「开始处理」：要去重时先重新读一次「去重」里已有多少成品，已经去重过就在确认窗里强提醒。
  const requestStart = async () => {
    if (!dedupOn) return submit(undefined);
    const fresh = await window.electronAPI.libraryEpisodes(detail.dir).catch(() => null);
    setOutputCount(fresh?.success ? fresh.outputCount || 0 : detail?.outputCount || 0);
    return setPreview(true);
  };

  const submit = async (gapPolicy) => {
    setSubmitting(true);
    setNotice('');
    setDecision(null);
    setPreview(false);
    let result;
    try {
      result = await window.electronAPI.libraryDedup({
        dir: detail.dir,
        dedup: dedupOn,
        mode: 'resplit',
        files: episodes.filter((item) => selected.has(item.path)).map((item) => item.path),
        opts,
        split,
        gapPolicy,
        sideTasks: {
          jianyingDraft: { enabled: draftOn, mode: draftMode, scope: draftScopeValue, prompts: draftPrompts },
        },
      });
    } catch (_) {
      result = { success: false, error: '提交没有成功，请稍后再试' };
    } finally {
      setSubmitting(false);
    }
    if (result?.needsDecision) return setDecision(result);
    // 成功后的进度、提示和日志都在「处理进度」里（来自主进程），这里只在失败时提示。
    if (!result?.success) setNotice(result?.error || '提交失败');
    await refreshActivity().catch(() => {});
    if (result?.success) progressRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  // 参数弹窗：Esc 关闭，焦点留在弹窗里。
  useDialogKeyboard(
    active && (showParams || showSaved),
    () => {
      setShowParams(false);
      setShowSaved(false);
    },
    '.lib-params-dialog',
  );

  // 强提示窗打开时，键盘焦点和 Esc 都归它。
  useDialogKeyboard(
    active && (!!decision || preview),
    () => {
      setDecision(null);
      setPreview(false);
    },
    '.lib-confirm',
  );

  const activeBatches = (activity?.batches || []).filter(isActiveBatch);
  const busyText = activity?.planning
    ? `正在分析切点${activity.planning.total ? `：${activity.planning.done}/${activity.planning.total}` : '…'}`
    : submitting
      ? '正在准备…'
      : activeBatches.length
        ? `正在处理：已完成 ${activeBatches.reduce((n, b) => n + b.done, 0)}/${activeBatches.reduce((n, b) => n + b.total, 0)} 集`
        : activity?.draft?.status === 'running'
          ? `正在生成剪映草稿：${activity.draft.done}/${activity.draft.total} 集`
          : '';
  // 去重或草稿跑完后，刷新一次「去重」里的成品数。
  const activitySignal = `${activeBatches.length}-${activity?.draft?.status || ''}`;
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activitySignal]);
  // 这部剧正在下载/排队、已暂停的集：可以在这里暂停或继续（下载管理页已经去掉了）。
  const downloadingIds = (detail?.missing || [])
    .filter((item) => item.state === 'downloading' && item.task?.id)
    .map((item) => item.task.id);
  const pausedIds = (detail?.missing || [])
    .filter((item) => item.state === 'failed' && item.task?.status === 'stopped')
    .map((item) => item.task.id);
  const draftNumbers = [...new Set(draftNums.map((n) => Math.floor(Number(n))).filter((n) => n >= 1 && n < 10000))];
  const draftScopeValue = { numbers: draftNumbers };
  const nothingToDo = dedupOn ? !selectedCount : !draftOn;
  // 成品用「AI 发布素材」里选定的新剧名命名：没选定不能开始去重。
  const releaseTitle = (publish?.title || '').trim();
  const needTitle = dedupOn && !releaseTitle;
  // 同一部剧同一时间只跑一批（分析切点、处理中、等补下载都算）。
  const seriesBusy =
    !!activity?.planning ||
    activity?.draft?.status === 'running' ||
    activeBatches.length > 0 ||
    (activity?.jobs || []).some((job) => ['waiting', 'starting'].includes(job.status));
  const draftBlocked = draftOn && draftNumbers.length === 0;
  // 参数写反（最小大于最大）时先不让开始，面板里已经标出要改哪一项。
  const paramsInvalid = dedupOn && !!opts && rangeProblems(opts, split).length > 0;

  const hopeless = (decision?.blocking || [])
    .filter((item) => item.reason && item.reason.retryHelps === false)
    .map((item) => item.index);
  const unretryable =
    decision?.kind === 'download' && decision.blocking.length > 0 && hopeless.length === decision.blocking.length;

  const est = estimate.data;
  const estimateText =
    estimate.loading && !est
      ? '正在估算…'
      : est && est.count > 0
        ? `每集 ${est.finalMin}–${est.finalMax} 秒，预计约 ${est.count} 集`
        : '';
  const startLabel = seriesBusy || submitting ? '处理中…' : dedupOn ? `开始处理（${selectedCount} 集）` : '开始处理';

  const title = detail?.name || folder.name;
  const downloaded = episodes.length;
  const openSeriesFolder = async () => {
    try {
      const res = await window.electronAPI.libraryOpenFolder(detail?.dir || folder.path);
      if (!res?.success) setError(res?.error || '打不开这个文件夹');
    } catch (err) {
      setError(err?.message || '打不开这个文件夹');
    }
  };
  const total = folder.totalEpisodes || 0;

  return (
    <div className="lib-container lib-detail" data-active={active}>
      {/* 「返回剧集列表」在窗口顶栏左边（App 里），这里只放这部剧的操作。 */}
      <div className="lib-crumb">
        <div className="lib-crumb-actions">
          <button className="btn btn-sm" onClick={open} disabled={loading} title="重新读取文件夹并向来源平台核对">
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新
          </button>
          <button
            className="btn btn-sm"
            onClick={openSeriesFolder}
            title="在访达 / 资源管理器里打开这部剧的文件夹（原剧、去重成品、发布素材都在里面）"
          >
            <Folder size={14} /> 打开剧集文件夹
          </button>
        </div>
      </div>

      <header className="lib-detail-head">
        <div className="lib-detail-text">
          <h2>{title}</h2>
          <div className="lib-detail-meta">
            {folder.imported ? '导入的文件夹' : folder.source || '下载目录'}
            {` · 已有 ${downloaded} 集`}
            {total > 0 && ` / 共 ${total} 集`}
          </div>
          {detail?.synopsis && <p className="lib-synopsis">{detail.synopsis}</p>}
        </div>
        <div className="lib-heads">
          <figure className="lib-head-pic">
            <div className="lib-head-frame">
              {detail?.coverUrl ? <img src={detail.coverUrl} alt={`《${title}》原封面`} /> : <span>没有封面</span>}
            </div>
            <figcaption>原封面</figcaption>
          </figure>
          <figure className="lib-head-pic">
            <div className={`lib-head-frame ${publish?.posterUrl ? 'is-new' : ''}`}>
              {publish?.posterUrl ? (
                <img src={publish.posterUrl} alt={`《${publish.title}》新海报`} />
              ) : (
                <span>还没生成</span>
              )}
            </div>
            <figcaption>{publish?.posterUrl ? `新海报 · ${publish.title}` : 'AI 新海报'}</figcaption>
          </figure>
        </div>
      </header>

      {loading && (
        <div className="lib-loading">
          <RefreshCw size={18} className="spin" /> 正在读取文件夹…
        </div>
      )}
      {error && <p className="lib-error">{error}</p>}

      {detail && (
        <>
          <PublishPanel dir={detail.dir} onResult={setPublish} />

          <section className="lib-section" aria-label="剧集">
            <div className="lib-toolbar">
              <span>
                {selectedCount === episodes.length
                  ? `处理整部（${episodes.length} 集）`
                  : `处理前 ${selectedCount} 集（共 ${episodes.length} 集）`}
              </span>
              <span className="lib-toolbar-btns">
                {downloadingIds.length > 0 && (
                  <button
                    className="btn btn-sm"
                    onClick={() => runTile(() => window.electronAPI.pauseAll(downloadingIds))}
                    title="暂停这部剧正在下载和排队的集，之后可以继续"
                  >
                    暂停下载（{downloadingIds.length} 集）
                  </button>
                )}
                {!downloadingIds.length && pausedIds.length > 0 && (
                  <button className="btn btn-sm" onClick={() => runTile(() => window.electronAPI.resumeAll(pausedIds))}>
                    继续下载（{pausedIds.length} 集）
                  </button>
                )}
                <label className="lib-number">
                  只处理前
                  <input
                    className="input-field"
                    type="number"
                    min="1"
                    max={episodes.length || 1}
                    value={selectedCount || ''}
                    onChange={(e) => setPrefix(e.target.value)}
                    disabled={submitting || !episodes.length}
                    aria-label="只处理前几集"
                  />
                  集
                </label>
                <button
                  className="btn btn-sm"
                  onClick={() => setPrefix(episodes.length)}
                  disabled={selectedCount === episodes.length}
                >
                  整部
                </button>
              </span>
            </div>
            {remoteNote && <div className="lib-remote-note">{remoteNote}</div>}
            {!episodes.length && !loading && <div className="lib-empty">这个文件夹里没有视频。</div>}

            <div className="lib-eps">
              {visible.map((card) => {
                if (card.kind === 'missing') {
                  const item = card.item;
                  const action = tileAction(item);
                  const reason = item.task?.reason?.text || item.text;
                  const inner = (
                    <>
                      <span className="lib-ep-no">第{item.index}集</span>
                      <span className="lib-ep-state">{ghostLabel(item)}</span>
                    </>
                  );
                  return action ? (
                    <button
                      type="button"
                      key={card.key}
                      className={`lib-ep is-missing is-${item.state}`}
                      onClick={() => runTile(action)}
                      title={`第${item.index}集：${reason}。点一下${item.state === 'failed' ? '重试' : '下载'}`}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div
                      key={card.key}
                      className={`lib-ep is-missing is-${item.state}`}
                      title={`第${item.index}集：${reason}`}
                    >
                      {inner}
                    </div>
                  );
                }
                const episode = card.episode;
                const on = selected.has(episode.path);
                return (
                  <div key={episode.path} className="lib-ep-cell">
                    <button
                      type="button"
                      className={`lib-ep ${on ? 'is-selected' : ''}`}
                      aria-pressed={on}
                      onClick={() => clickEpisode(episode, episodes.indexOf(episode))}
                      title={`${episode.name}（${formatSize(episode.size)}）`}
                    >
                      <span className="lib-ep-no">
                        {episode.index != null ? `第${episode.index}集` : episode.name.replace(/\.[^.]+$/, '')}
                      </span>
                    </button>
                    {on && (
                      <span className="lib-ep-check">
                        <Check size={11} />
                      </span>
                    )}
                    <button
                      type="button"
                      className="lib-ep-reveal"
                      aria-label={`定位${episode.name}`}
                      title="在文件管理器里定位这个视频"
                      onClick={() => window.electronAPI.showInFolder(episode.path)}
                    >
                      <Folder size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
            <Pager
              total={cards.length}
              page={currentPage}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              sizes={EPISODE_PAGE_SIZES}
              unit="集"
            />
          </section>

          <section className="proc-panel" aria-label="处理整部">
            <h3>处理整部</h3>

            <div className="proc-item">
              <div className="proc-line">
                <label className="proc-check">
                  <input
                    type="checkbox"
                    checked={dedupOn}
                    onChange={(e) => setDedupOn(e.target.checked)}
                    disabled={submitting}
                  />
                  <b>视频去重</b>
                </label>
                <span className="proc-summary">
                  {dedupOn
                    ? `${selectedCount === episodes.length ? `整部 ${selectedCount} 集` : `前 ${selectedCount} 集`} · ${
                        estimateText || `每集 ${split.min_len}–${split.max_len} 秒`
                      }`
                    : '不去重：直接用「去重」里已有的成品做下面的剪映草稿 / 分镜工程图'}
                </span>
                <button className="btn btn-sm proc-more" onClick={() => setShowParams(true)} disabled={!opts}>
                  去重参数
                </button>
              </div>
              {dedupOn && (detail?.outputCount || 0) > 0 && (
                <p className="proc-name is-missing">
                  已经去重过：「去重」里有 {detail.outputCount}{' '}
                  集成品。再次去重会把它们全部换掉；只想做剪映草稿或分镜工程图，请取消勾选「视频去重」。
                </p>
              )}
              {dedupOn && (
                <p className={`proc-name ${releaseTitle ? '' : 'is-missing'}`}>
                  {releaseTitle
                    ? `成品命名：${releaseTitle} - 第1集.mp4 …`
                    : '先在上面「AI 发布素材」里选定新剧名，成品会用新剧名命名'}
                </p>
              )}
              {paramsInvalid && (
                <p className="proc-name is-missing">
                  去重参数需要调整：{rangeProblems(opts, split).join('；')}（点「去重参数」修改）
                </p>
              )}
            </div>
          </section>

          <section className="proc-panel proc-after" aria-label="去重处理后">
            <div className="proc-head">
              <h3>去重处理后</h3>
              {detail.lastDedup && (
                <button className="btn btn-sm" onClick={() => setShowSaved(true)}>
                  查看处理参数
                </button>
              )}
            </div>
            <DedupResult record={detail.lastDedup} outputCount={detail.outputCount || 0} running={activeBatches} />

            <div className="proc-item">
              <div className="proc-line">
                <label className="proc-check">
                  <input
                    type="checkbox"
                    checked={draftOn}
                    onChange={(e) => setDraftOn(e.target.checked)}
                    disabled={submitting}
                  />
                  <b>生成剪映草稿</b>
                </label>
                {!draftOn && <span className="proc-summary">用去重后的成品生成</span>}
              </div>
              {draftOn && (
                <div className="proc-options">
                  <div className="seg" role="radiogroup" aria-label="分轨方式">
                    {DRAFT_MODES.map(([id, label, hint]) => (
                      <label key={id} className={`seg-item ${draftMode === id ? 'is-active' : ''}`} title={hint}>
                        <input
                          type="radio"
                          name="lib-draft-mode"
                          checked={draftMode === id}
                          onChange={() => setDraftMode(id)}
                          disabled={submitting}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div className="lib-number proc-nums" role="group" aria-label="要做草稿的成品集号">
                    做成品第
                    {draftNums.map((value, slot) => (
                      <input
                        key={slot}
                        className="input-field"
                        type="number"
                        min="1"
                        max="9999"
                        value={value}
                        placeholder="—"
                        onChange={(e) => setDraftNums(draftNums.map((old, i) => (i === slot ? e.target.value : old)))}
                        disabled={submitting}
                        aria-label={`第 ${slot + 1} 个集号`}
                      />
                    ))}
                    集
                  </div>
                </div>
              )}
            </div>

            <div className="proc-item">
              <div className="proc-line">
                <label
                  className="proc-check"
                  title="分镜处理完后，用火山方舟看视频，按 Seedance 2.5 写好每个分镜的提示词，做成分镜头脚本页面。需要先在设置里填方舟的 Key 和视频理解模型名。"
                >
                  <input
                    type="checkbox"
                    checked={draftOn && draftPrompts}
                    onChange={(e) => setDraftPrompts(e.target.checked)}
                    disabled={submitting || !draftOn}
                  />
                  <b>生产 AI 分镜工程图</b>
                </label>
                <span className="proc-summary">
                  {draftOn
                    ? `用上面选的 ${draftNumbers.length || 0} 集：分镜处理完后，写出每个分镜的提示词，生成分镜工程图`
                    : '要先勾选「生成剪映草稿」：分镜处理完才能生产'}
                </span>
              </div>
              <StoryboardResults
                dir={detail.dir}
                numbers={draftNumbers}
                enabled={draftOn && draftPrompts}
                refreshKey={`${activity?.draft?.status || ''}-${activity?.draft?.done || 0}-${activity?.draft?.failed || 0}`}
              />
            </div>

            <div className="proc-foot">
              <div className="proc-foot-info">
                {busyText && <div className="lib-status">{busyText}</div>}
                {notice && <div className="lib-notice lib-notice-lines">{notice}</div>}
              </div>
              <button
                className="btn btn-primary proc-start"
                onClick={requestStart}
                disabled={
                  submitting ||
                  seriesBusy ||
                  nothingToDo ||
                  needTitle ||
                  draftBlocked ||
                  paramsInvalid ||
                  (dedupOn && !opts)
                }
              >
                {startLabel}
              </button>
            </div>
          </section>

          <div ref={progressRef}>
            <SeriesProgress dir={detail.dir} activity={activity} onChanged={refreshActivity} />
          </div>
        </>
      )}

      {showParams && opts && (
        <div className="lib-mask lib-mask-top" onClick={() => setShowParams(false)}>
          <div
            className="lib-confirm lib-params-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="去重参数"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lib-params-dialog-head">
              <h3>去重参数</h3>
              <span>{estimateText || `每集 ${split.min_len}–${split.max_len} 秒`}</span>
            </div>
            <DedupParams
              opts={opts}
              onChange={(k, v) => setOpts({ ...opts, [k]: v })}
              split={split}
              onSplitChange={(k, v) => {
                const next = k === 'start_number' ? Math.max(1, Math.floor(v) || 1) : v;
                // 草稿集号还是默认的连续 4 集时，跟着新集编号走；自己改过的不动。
                if (k === 'start_number' && draftNums.join() === defaultDraftNums(split.start_number).join())
                  setDraftNums(defaultDraftNums(next));
                setSplit({ ...split, [k]: next });
              }}
              onReset={resetParams}
              disabled={submitting}
            />
            <div className="lib-confirm-actions">
              <button className="btn btn-primary" onClick={() => setShowParams(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {showSaved && detail?.lastDedup && (
        <div className="lib-mask lib-mask-top" onClick={() => setShowSaved(false)}>
          <div
            className="lib-confirm lib-params-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="上次处理参数"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lib-params-dialog-head">
              <h3>上次处理参数</h3>
              <span>{formatTime(detail.lastDedup.at)} 开始的那次去重（只读）</span>
            </div>
            <DedupParams
              opts={{ ...(opts || {}), ...(detail.lastDedup.opts || {}) }}
              onChange={() => {}}
              split={{ ...DEFAULT_SPLIT, ...(detail.lastDedup.split || {}) }}
              onSplitChange={() => {}}
              disabled
            />
            <div className="lib-confirm-actions">
              <button
                className="btn"
                disabled={submitting || !opts}
                title="把这组参数填进这次的「去重参数」"
                onClick={() => {
                  const { jobs: _jobs, encoder: _encoder, ...keep } = detail.lastDedup.opts || {};
                  setOpts({ ...opts, ...keep });
                  setSplit({ ...DEFAULT_SPLIT, ...(detail.lastDedup.split || {}) });
                  setShowSaved(false);
                }}
              >
                用这组参数
              </button>
              <button className="btn btn-primary" onClick={() => setShowSaved(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="lib-mask lib-mask-top" onClick={() => setPreview(false)}>
          <div
            className="lib-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="处理预览"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>开始处理前，先看一下</h3>
            {outputCount > 0 && (
              <p className="lib-confirm-warn">
                这部剧已经去重过：「去重」里现在有 <b>{outputCount} 集</b>成品。继续会把它们
                <b>全部移到{TRASH}</b>（U 盘等没有{TRASH}的盘，放进这部剧文件夹里的「去重-旧成品」），
                {selectedCount < episodes.length
                  ? `然后只按前 ${selectedCount} 集重新生成——后面集数的旧成品也会一起移走，`
                  : '再整部重新生成，'}
                要花很长时间。只想做剪映草稿或分镜工程图的话，不用重新去重。
              </p>
            )}
            <ul className="lib-confirm-list lib-preview-list">
              <li>
                处理范围：
                <b>{selectedCount === episodes.length ? `整部，共 ${selectedCount} 集` : `前 ${selectedCount} 集`}</b>
                {est?.firstEpisode != null &&
                  est?.lastEpisode != null &&
                  `（第 ${est.firstEpisode}–${est.lastEpisode} 集）`}
                ，按时间线连续接起来
              </li>
              {est && est.count > 0 ? (
                <>
                  <li>
                    预计生成：<b>约 {est.count} 集</b>（大致 {est.minCount}–{est.maxCount} 集），新集编号从第{' '}
                    {est.startNumber} 集起
                  </li>
                  <li>
                    每集成品 {est.finalMin}–{est.finalMax} 秒，参与处理的素材共约 {Math.round(est.totalSeconds / 60)}{' '}
                    分钟
                  </li>
                  <li>
                    结尾如果只剩不到 {Math.max(1, Math.round(est.tailSlack))} 秒的零头，会直接并进最后一集，不单独成集
                  </li>
                </>
              ) : (
                <li>{estimate.loading ? '正在估算…' : estimate.error || '暂时没有算出预计集数'}</li>
              )}
              {est?.unreadable > 0 && <li>有 {est.unreadable} 个视频读不出时长，没有计入估算</li>}
            </ul>
            <p>这只是按时长的估算，真正的切法要先分析镜头切换和说话停顿才定，最终集数可能有几集出入。</p>
            <div className="lib-confirm-actions">
              {outputCount > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setDedupOn(false);
                    setPreview(false);
                  }}
                >
                  不重新去重，只做后面的
                </button>
              )}
              <button
                className={`btn ${outputCount > 0 ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => submit(undefined)}
              >
                {outputCount > 0 ? `仍然重新去重（旧成品移到${TRASH}）` : '开始处理'}
              </button>
              <button className="btn" onClick={() => setPreview(false)}>
                再调整一下
              </button>
            </div>
          </div>
        </div>
      )}

      {decision && (
        <div className="lib-mask lib-mask-top" onClick={() => setDecision(null)}>
          <div
            className="lib-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="有集还没下载"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{decision.kind === 'download' ? '有几集还没下载' : '这几集不在文件夹里'}</h3>
            <ul className="lib-confirm-list">
              {decision.blocking.map((item) => (
                <li key={item.index}>
                  第 {item.index} 集：
                  {item.reason ? (
                    <>
                      <b>{item.reason.label}</b>，{item.reason.text}
                      {item.reason.detail && <em>（{item.reason.detail}）</em>}
                    </>
                  ) : (
                    item.text
                  )}
                </li>
              ))}
            </ul>
            {decision.kind === 'download' ? (
              unretryable ? (
                <p>这几集平台提供不了，补下载也不会成功。建议直接强制拼接：前后两集会接在一起，剧情会有跳跃。</p>
              ) : (
                <p>
                  拼接时会直接跳过它们，前后两集接在一起，剧情会有跳跃。可以先补下载，下完自动继续处理；也可以不管，强制拼接。
                  {hopeless.length > 0 && `其中第 ${hopeless.join('、')} 集是资源缺失，补下载大概率还是会失败。`}
                </p>
              )
            ) : (
              <p>
                这是导入的文件夹，软件不知道这几集是平台本来就没有，还是你还没下。如果本来就缺，直接拼接就行（下次不会再问）；如果只是没下，先去补上再处理。
              </p>
            )}
            {decision.notes?.length > 0 && (
              <p className="lib-confirm-notes">
                另外：
                {decision.notes.map((item) => `第 ${item.index} 集${item.text}`).join('、')}，会直接拼接。
              </p>
            )}
            <div className="lib-confirm-actions">
              {decision.kind === 'download' ? (
                unretryable ? (
                  <>
                    <button className="btn btn-primary" onClick={() => submit('force')}>
                      强制拼接（跳过这几集）
                    </button>
                    <button className="btn" onClick={() => submit('download')}>
                      仍然试试补下载
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-primary" onClick={() => submit('download')}>
                      先补下载，下完自动继续
                    </button>
                    <button className="btn" onClick={() => submit('force')}>
                      不管，强制拼接
                    </button>
                  </>
                )
              ) : (
                <button className="btn btn-primary" onClick={() => submit('confirm')}>
                  本来就缺，直接拼
                </button>
              )}
              <button className="btn" onClick={() => setDecision(null)}>
                {decision.kind === 'download' ? '取消' : '我去补，先不处理'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
