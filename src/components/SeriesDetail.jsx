import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './SeriesDetail.css';
import { Check, ChevronRight, Film, RefreshCw } from './icons';
import DedupParams from './DedupParams';
import PublishPanel from './PublishPanel';
import Pager from './Pager';
import SeriesProgress, { isActiveBatch } from './SeriesProgress';
import useLiveData from './useLiveData';
import useDialogKeyboard from './useDialogKeyboard';
import { clampPage, slicePage } from './pagination';

const STORAGE_KEY = 'library-params';
const VIEW_KEY = 'library-view';
const DEFAULT_SPLIT = { min_len: 30, max_len: 65, head_trim: 1.1, tail_trim: 1.2, start_number: 1 };
const DEFAULT_SPEED = { speed_min: 1.03, speed_max: 1.21 };
const EPISODE_PAGE_SIZES = [30, 60, 100, 200];
const ISSUE_PREVIEW = 5;

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

/** 剧的子页面：剧名在页头，下面是这部剧的集（分页）、下载问题、AI 发布素材和去重处理。 */
export default function SeriesDetail({ folder, active = true, onBack }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [remoteNote, setRemoteNote] = useState('');
  const [selected, setSelected] = useState(new Set());
  const saved = useRef(readJson(STORAGE_KEY)).current;
  const view = useRef(readJson(VIEW_KEY)).current;
  const [opts, setOpts] = useState(null);
  const [split, setSplit] = useState({ ...DEFAULT_SPLIT, ...(saved.split || {}) });
  const [mode, setMode] = useState(saved.mode === 'episode' ? 'episode' : 'resplit');
  const [showParams, setShowParams] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [decision, setDecision] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(
    EPISODE_PAGE_SIZES.includes(view.episodePageSize) ? view.episodePageSize : 60,
  );
  const [showAllIssues, setShowAllIssues] = useState(false);
  const [actionError, setActionError] = useState('');
  const [publish, setPublish] = useState(null); // AI 发布素材的最新结果（新海报、新剧名）
  const requestId = useRef(0);
  const paramsRef = useRef(null);
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
    const result = await window.electronAPI.libraryEpisodes(folder.path);
    if (id !== requestId.current) return;
    setLoading(false);
    if (!result?.success) return setError(result?.error || '打开失败');
    setDetail({ ...result, source: folder.source, totalEpisodes: folder.totalEpisodes });
    setSelected(new Set(result.episodes.map((episode) => episode.path)));
    setRemoteNote('');
    if (!result.linked) return;
    setRemoteNote('正在向来源平台核对最新集数…');
    const fresh = await window.electronAPI.libraryRefreshRemote(folder.path);
    if (id !== requestId.current) return;
    if (fresh?.success) {
      setDetail((previous) =>
        previous ? { ...previous, missing: fresh.missing, remoteUpdatedAt: fresh.remoteUpdatedAt } : previous,
      );
      setRemoteNote(
        fresh.refreshed
          ? '缺集状态已和来源平台核对。'
          : `没连上来源平台，缺集状态按上次记录（${formatTime(fresh.remoteUpdatedAt)}）判断。`,
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
    const result = await window.electronAPI.libraryEpisodes(folder.path);
    if (!result?.success) return;
    setDetail((previous) =>
      previous
        ? { ...previous, episodes: result.episodes, missing: result.missing, coverUrl: result.coverUrl }
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
    window.electronAPI.quchongDefaults?.().then((defaults) => {
      if (alive && defaults) setOpts({ ...defaults, ...DEFAULT_SPEED, ...(saved.opts || {}) });
    });
    return () => {
      alive = false;
    };
  }, [saved]);

  useEffect(() => {
    if (opts) writeJson(STORAGE_KEY, { opts, split, mode });
  }, [opts, split, mode]);
  useEffect(() => {
    writeJson(VIEW_KEY, { ...readJson(VIEW_KEY), episodePageSize: pageSize });
  }, [pageSize]);
  useEffect(() => {
    if (showParams) paramsRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [showParams]);

  const resetParams = async () => {
    const defaults = await window.electronAPI.quchongDefaults?.();
    if (defaults) setOpts({ ...defaults, ...DEFAULT_SPEED });
    setSplit({ ...DEFAULT_SPLIT });
  };

  const episodes = detail?.episodes || [];
  const allSelected = episodes.length > 0 && selected.size === episodes.length;
  const selectedCount = useMemo(() => episodes.filter((item) => selected.has(item.path)).length, [episodes, selected]);

  const toggle = (file) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

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

  // ---- 下载问题：失败（带原因）、没下载、下载中、平台没有 ----
  const missing = detail?.missing || [];
  const failed = missing.filter((item) => item.state === 'failed' && item.task);
  const notDownloaded = missing.filter((item) => item.state === 'notDownloaded');
  const downloading = missing.filter((item) => item.state === 'downloading');
  const platformGaps = missing.filter((item) => item.state === 'absent' || item.state === 'locked');
  const issueRows = [...failed, ...downloading, ...notDownloaded].sort((a, b) => a.index - b.index);

  const runAction = async (action) => {
    setActionError('');
    try {
      const result = await action();
      if (result && result.success === false) setActionError(result.error || '操作失败');
    } catch (e) {
      setActionError(e?.message || '操作失败');
    }
    reload();
  };
  const retryOne = (item) => runAction(() => window.electronAPI.retryTask(item.task.id));
  const stopOne = (item) => runAction(() => window.electronAPI.stopDownload(item.task.id));
  const downloadOne = (item) => runAction(() => window.electronAPI.downloadSingleEpisode(detail.seriesId, item.index));
  const retryAll = () => runAction(() => window.electronAPI.retryTasks(failed.map((item) => item.task.id)));
  const downloadAll = () =>
    runAction(async () => {
      for (const item of notDownloaded) await window.electronAPI.downloadSingleEpisode(detail.seriesId, item.index);
      return { success: true };
    });

  const submit = async (gapPolicy) => {
    setSubmitting(true);
    setNotice('');
    setDecision(null);
    const result = await window.electronAPI.libraryDedup({
      dir: detail.dir,
      mode,
      files: episodes.filter((item) => selected.has(item.path)).map((item) => item.path),
      opts,
      split,
      gapPolicy,
    });
    setSubmitting(false);
    if (result?.needsDecision) return setDecision(result);
    // 成功后的进度、提示和日志都在「处理进度」里（来自主进程），这里只在失败时提示。
    if (!result?.success) setNotice(result?.error || '提交失败');
    await refreshActivity();
    if (result?.success) progressRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  // 强提示窗打开时，键盘焦点和 Esc 都归它。
  useDialogKeyboard(active && !!decision, () => setDecision(null), '.lib-confirm');

  const activeBatches = (activity?.batches || []).filter(isActiveBatch);
  const busyText = activity?.planning
    ? `正在分析切点${activity.planning.total ? `：${activity.planning.done}/${activity.planning.total}` : '…'}`
    : submitting
      ? '正在准备…'
      : activeBatches.length
        ? `正在处理：已完成 ${activeBatches.reduce((n, b) => n + b.done, 0)}/${activeBatches.reduce((n, b) => n + b.total, 0)} 集`
        : '';

  const hopeless = (decision?.blocking || [])
    .filter((item) => item.reason && item.reason.retryHelps === false)
    .map((item) => item.index);
  const unretryable =
    decision?.kind === 'download' && decision.blocking.length > 0 && hopeless.length === decision.blocking.length;

  const title = detail?.name || folder.name;
  const shownIssues = showAllIssues ? issueRows : issueRows.slice(0, ISSUE_PREVIEW);
  const downloaded = episodes.length;
  const total = folder.totalEpisodes || 0;

  return (
    <div className="lib-container lib-detail" data-active={active}>
      <div className="lib-crumb">
        <button className="btn btn-sm" onClick={onBack}>
          <ChevronRight size={14} className="lib-back-icon" /> 返回剧集列表
        </button>
        <button className="btn btn-sm" onClick={open} disabled={loading} title="重新读取文件夹并向来源平台核对">
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新
        </button>
      </div>

      <header className="lib-detail-head">
        <div className="lib-detail-text">
          <h2>
            <Film size={22} /> {title}
          </h2>
          <div className="lib-detail-meta">
            {folder.imported ? '导入的文件夹' : folder.source || '下载目录'}
            {` · 已有 ${downloaded} 集`}
            {total > 0 && ` / 共 ${total} 集`}
            <span className="lib-detail-path" title={folder.path}>
              {folder.path}
            </span>
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
          <PublishPanel dir={detail.dir} onResult={setPublish} showPoster={false} />

          <section className="lib-section" aria-label="剧集">
            <div className="lib-toolbar">
              <span>
                已选 {selectedCount} / {episodes.length} 集
              </span>
              <span className="lib-toolbar-btns">
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      for (const card of visible) if (card.kind === 'episode') next.add(card.episode.path);
                      return next;
                    })
                  }
                >
                  选本页
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setSelected(allSelected ? new Set() : new Set(episodes.map((e) => e.path)))}
                >
                  {allSelected ? '全不选' : '全选'}
                </button>
              </span>
            </div>
            {remoteNote && <div className="lib-remote-note">{remoteNote}</div>}
            {!episodes.length && !loading && <div className="lib-empty">这个文件夹里没有视频。</div>}

            <div className="lib-eps">
              {visible.map((card) => {
                if (card.kind === 'missing') {
                  const item = card.item;
                  return (
                    <div
                      key={card.key}
                      className={`lib-ep is-missing is-${item.state}`}
                      title={`第${item.index}集：${item.task?.reason?.text || item.text}`}
                    >
                      <span className="lib-ep-no">第{item.index}集</span>
                      <span className="lib-ep-state">{ghostLabel(item)}</span>
                    </div>
                  );
                }
                const episode = card.episode;
                const on = selected.has(episode.path);
                return (
                  <button
                    type="button"
                    key={episode.path}
                    className={`lib-ep ${on ? 'is-selected' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggle(episode.path)}
                    title={`${episode.name}（${formatSize(episode.size)}）`}
                  >
                    <span className="lib-ep-no">
                      {episode.index != null ? `第${episode.index}集` : episode.name.replace(/\.[^.]+$/, '')}
                    </span>
                    {on && (
                      <span className="lib-ep-check">
                        <Check size={11} />
                      </span>
                    )}
                  </button>
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

          {(issueRows.length > 0 || platformGaps.length > 0) && (
            <section className="lib-issues" aria-label="下载状态">
              <div className="lib-issues-head">
                <strong>
                  {failed.length > 0 && `${failed.length} 集下载失败`}
                  {failed.length > 0 && (downloading.length > 0 || notDownloaded.length > 0) && '，'}
                  {downloading.length > 0 && `${downloading.length} 集下载中`}
                  {downloading.length > 0 && notDownloaded.length > 0 && '，'}
                  {notDownloaded.length > 0 && `${notDownloaded.length} 集没下载`}
                  {issueRows.length === 0 && '缺集情况'}
                </strong>
                <span className="lib-issues-actions">
                  {failed.length > 1 && (
                    <button className="btn btn-sm" onClick={retryAll}>
                      全部重试（{failed.length}）
                    </button>
                  )}
                  {notDownloaded.length > 0 && detail.linked && (
                    <button className="btn btn-sm" onClick={downloadAll}>
                      下载没下的（{notDownloaded.length}）
                    </button>
                  )}
                </span>
              </div>
              {shownIssues.map((item) => (
                <div key={item.index} className={`lib-issue is-${item.state}`}>
                  <span className="lib-issue-no">第 {item.index} 集</span>
                  <span className="lib-issue-text">
                    {item.state === 'failed' && item.task?.status === 'failed' && (
                      <>
                        <b>{item.task.reason?.label || '下载失败'}</b>：{item.task.reason?.text}
                        {item.task.reason?.detail && (
                          <em title={item.task.reason.detail}>（{item.task.reason.detail}）</em>
                        )}
                      </>
                    )}
                    {item.state === 'failed' && item.task?.status === 'stopped' && <b>已暂停，点继续接着下</b>}
                    {item.state === 'downloading' && (
                      <b>{item.task?.status === 'pending' ? '排队中' : `下载中 ${item.task?.progress ?? 0}%`}</b>
                    )}
                    {item.state === 'notDownloaded' && <b>平台有这一集，还没下载</b>}
                  </span>
                  <span className="lib-issue-btns">
                    {item.state === 'failed' && (
                      <button className="btn btn-sm" onClick={() => retryOne(item)}>
                        {item.task?.status === 'stopped'
                          ? '继续'
                          : item.task?.reason?.retryHelps === false
                            ? '仍然重试'
                            : '重试'}
                      </button>
                    )}
                    {item.state === 'downloading' && item.task && (
                      <button className="btn btn-sm" onClick={() => stopOne(item)}>
                        停止
                      </button>
                    )}
                    {item.state === 'notDownloaded' && detail.linked && (
                      <button className="btn btn-sm" onClick={() => downloadOne(item)}>
                        下载
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {issueRows.length > ISSUE_PREVIEW && (
                <button className="lib-link" onClick={() => setShowAllIssues((value) => !value)}>
                  {showAllIssues ? '收起' : `展开全部 ${issueRows.length} 条`}
                </button>
              )}
              {platformGaps.length > 0 && (
                <p className="lib-platform-gaps">
                  平台本来就没有：{platformGaps.map((item) => `第 ${item.index} 集（${item.text}）`).join('、')}
                  。拼接时直接跳过。
                </p>
              )}
              {actionError && <p className="lib-error">{actionError}</p>}
            </section>
          )}

          {showParams && opts && (
            <div ref={paramsRef} className="lib-params-card">
              <DedupParams
                opts={opts}
                onChange={(k, v) => setOpts({ ...opts, [k]: v })}
                split={mode === 'resplit' ? split : null}
                onSplitChange={(k, v) => setSplit({ ...split, [k]: v })}
                onReset={resetParams}
                disabled={submitting}
              />
            </div>
          )}

          <div ref={progressRef}>
            <SeriesProgress dir={detail.dir} activity={activity} onChanged={refreshActivity} />
          </div>

          <div className="lib-bar">
            <div className="lib-foot-info">
              <div
                className="lib-modes"
                role="radiogroup"
                aria-label="处理方式"
                title={`成品放进：${detail.outputDir}`}
              >
                {[
                  ['resplit', '重新拆分', '选中的集接起来，按成品时长重新切成新的集，再去重'],
                  ['episode', '按原集去重', '一集出一集，不改变集数'],
                ].map(([id, label, hint]) => (
                  <label key={id} className={`lib-mode ${mode === id ? 'is-active' : ''}`} title={hint}>
                    <input
                      type="radio"
                      name="lib-mode"
                      checked={mode === id}
                      onChange={() => setMode(id)}
                      disabled={submitting}
                    />
                    {label}
                    <span>{hint}</span>
                  </label>
                ))}
                {mode === 'resplit' && (
                  <label className="lib-number">
                    新集从第
                    <input
                      className="input-field"
                      type="number"
                      min="1"
                      max="9999"
                      value={split.start_number}
                      onChange={(e) =>
                        setSplit({ ...split, start_number: Math.max(1, Math.floor(Number(e.target.value)) || 1) })
                      }
                      disabled={submitting}
                    />
                    集开始编号
                  </label>
                )}
              </div>
              {busyText && <div className="lib-status">{busyText}</div>}
              {notice && <div className="lib-notice lib-notice-lines">{notice}</div>}
            </div>
            <div className="lib-foot-actions">
              <button className="btn btn-sm" onClick={() => setShowParams((value) => !value)}>
                去重参数…
              </button>
              {busyText && (
                <button
                  className="btn"
                  onClick={() => progressRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })}
                >
                  查看进度
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => submit(undefined)}
                disabled={submitting || !!activity?.planning || !selectedCount || !opts}
              >
                开始处理（{selectedCount} 集）
              </button>
            </div>
          </div>
        </>
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
