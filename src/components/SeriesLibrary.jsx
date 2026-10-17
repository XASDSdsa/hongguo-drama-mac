import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './SeriesLibrary.css';
import { Check, Film, FolderPlus, RefreshCw, X } from './icons';
import DedupParams from './DedupParams';
import PublishPanel from './PublishPanel';
import useDialogKeyboard from './useDialogKeyboard';

const STORAGE_KEY = 'library-params';
const DEFAULT_SPLIT = { min_len: 30, max_len: 65, head_trim: 1.1, tail_trim: 1.2, start_number: 1 };
const DEFAULT_SPEED = { speed_min: 1.03, speed_max: 1.21 };

function readSaved() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}
function writeSaved(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (_) {
    /* 存储不可用时，只是不记住上次的参数。 */
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

export default function SeriesLibrary({ active = true, onNavigate }) {
  const [folders, setFolders] = useState([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const saved = useRef(readSaved()).current;
  const [opts, setOpts] = useState(null);
  const [split, setSplit] = useState({ ...DEFAULT_SPLIT, ...(saved.split || {}) });
  const [mode, setMode] = useState(saved.mode === 'episode' ? 'episode' : 'resplit');
  const [progress, setProgress] = useState(null);
  const [showParams, setShowParams] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState(false);
  const [decision, setDecision] = useState(null);
  const [remoteNote, setRemoteNote] = useState('');
  const [jobs, setJobs] = useState([]);
  const requestId = useRef(0);
  const paramsRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const result = await window.electronAPI.libraryList();
    if (result?.success) {
      setFolders(result.folders);
      setRoot(result.root);
    } else setError(result?.error || '读取失败');
    setLoading(false);
  }, []);

  // 每次回到这个页面都重新扫描磁盘：下载完新集、用户手动增删文件后列表要是最新的。
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  useEffect(() => {
    let alive = true;
    window.electronAPI.quchongDefaults?.().then((defaults) => {
      if (alive && defaults) setOpts({ ...defaults, ...DEFAULT_SPEED, ...(saved.opts || {}) });
    });
    const off = window.electronAPI.onLibraryPlanProgress?.((data) => alive && setProgress(data));
    window.electronAPI.libraryJobs?.().then((list) => alive && Array.isArray(list) && setJobs(list));
    const offJob = window.electronAPI.onLibraryJobUpdate?.((job) => {
      if (!alive) return;
      setJobs((list) =>
        list.some((item) => item.id === job.id)
          ? list.map((item) => (item.id === job.id ? job : item))
          : [...list, job],
      );
    });
    return () => {
      alive = false;
      off?.();
      offJob?.();
    };
  }, [saved]);

  useEffect(() => {
    if (opts) writeSaved({ opts, split, mode });
  }, [opts, split, mode]);

  useEffect(() => {
    if (showParams) paramsRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [showParams]);

  const resetParams = async () => {
    const defaults = await window.electronAPI.quchongDefaults?.();
    if (defaults) setOpts({ ...defaults, ...DEFAULT_SPEED });
    setSplit({ ...DEFAULT_SPLIT });
  };

  const closeDetail = () => {
    requestId.current++;
    setDetail(null);
    setDetailLoading(false);
    setSelected(new Set());
    setNotice('');
    setQueued(false);
    setDecision(null);
    setRemoteNote('');
  };

  const openFolder = async (folder) => {
    const id = ++requestId.current;
    setNotice('');
    setSelected(new Set());
    setDetail(null);
    setDetailLoading(true);
    const result = await window.electronAPI.libraryEpisodes(folder.path);
    if (id !== requestId.current) return;
    setDetailLoading(false);
    if (result?.success) {
      setDetail({ ...result, source: folder.source, totalEpisodes: folder.totalEpisodes });
      setSelected(new Set(result.episodes.map((episode) => episode.path)));
      setRemoteNote('');
      if (result.linked) {
        // 先用上次的记录显示，同时向来源平台核对最新集数，核对完再刷新缺集状态。
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
      }
    } else setError(result?.error || '打开失败');
  };

  const importFolder = async () => {
    const result = await window.electronAPI.libraryImport();
    if (!result?.success) return setError(result?.error || '导入失败');
    if (result.dir) load();
  };
  const removeImported = async (folder, event) => {
    event.stopPropagation();
    await window.electronAPI.libraryRemoveImport(folder.path);
    load();
  };

  const toggle = (file) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  const episodes = detail?.episodes || [];
  const allSelected = episodes.length > 0 && selected.size === episodes.length;
  const selectedCount = useMemo(() => episodes.filter((item) => selected.has(item.path)).length, [episodes, selected]);

  const submit = async (gapPolicy) => {
    setSubmitting(true);
    setNotice('');
    setQueued(false);
    setProgress(null);
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
    setProgress(null);
    if (result?.needsDecision) return setDecision(result);
    if (result?.success && result.waitingForDownload) {
      setQueued(false);
      setNotice(`${result.job.message}。进度见页面上方，可以先关掉这个窗口。`);
    } else if (result?.success) {
      setQueued(true);
      const summary = result.summary;
      const lines = [
        mode === 'resplit' && summary
          ? `已加入去重队列：将生成 ${summary.count} 集，成品约 ${Math.round(summary.minSeconds)}–${Math.round(summary.maxSeconds)} 秒，放进「去重」文件夹。`
          : `已加入去重队列（${result.tasks?.length ?? selectedCount} 集），成品会放进「去重」文件夹。`,
        ...(result.notes || []).map((item) =>
          item.forced
            ? `第 ${item.index} 集${item.text}，已按你的选择强制拼接`
            : `第 ${item.index} 集${item.text}，已直接拼接`,
        ),
        ...(result.warnings || []),
      ];
      setNotice(lines.join('\n'));
    } else setNotice(result?.error || '提交失败');
  };
  const startDedup = () => submit(undefined);

  const cancelJob = async (job) => {
    await window.electronAPI.libraryJobCancel(job.id);
  };
  const dismissJob = async (job) => {
    await window.electronAPI.libraryJobDismiss(job.id);
    setJobs((list) => list.filter((item) => item.id !== job.id));
  };

  // 强提示窗打开时，键盘焦点和 Esc 都归它；关掉后回到选集弹窗。
  useDialogKeyboard(
    active && (!!detail || detailLoading),
    decision ? () => setDecision(null) : closeDetail,
    decision ? '.lib-confirm' : '.lib-dialog',
  );

  // 磁盘上的集和缺集占位按集号排在一起；缺集的占位不能选。
  const cards = useMemo(() => {
    const list = episodes.map((episode) => ({ kind: 'episode', key: episode.path, index: episode.index, episode }));
    for (const item of detail?.missing || [])
      list.push({ kind: 'missing', key: `missing-${item.index}`, index: item.index, item });
    return list.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  }, [episodes, detail]);

  return (
    <div className="lib-container" data-active={active}>
      <header className="lib-header">
        <div>
          <h2>
            <Film size={22} /> 管理剧集
          </h2>
          <p>
            每部剧是一个文件夹：下载目录下的剧文件夹，加上你导入的文件夹。点开一部剧，选要处理的集，结果会放回这部剧的文件夹里。
          </p>
          {root && <span className="lib-root">下载目录：{root}</span>}
        </div>
        <div className="lib-header-actions">
          <button className="btn" onClick={importFolder}>
            <FolderPlus size={14} /> 导入已有剧
          </button>
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新
          </button>
        </div>
      </header>

      {error && <p className="lib-error">{error}</p>}

      {jobs.length > 0 && (
        <div className="lib-jobs">
          {jobs.map((job) => (
            <div key={job.id} className={`lib-job is-${job.status}`}>
              <div>
                <strong>《{job.name}》</strong>
                {job.message}
              </div>
              <div className="lib-job-actions">
                {job.status === 'waiting' ? (
                  <button className="btn btn-sm" onClick={() => cancelJob(job)}>
                    取消自动处理
                  </button>
                ) : job.status === 'started' ? (
                  <>
                    {onNavigate && (
                      <button className="btn btn-sm" onClick={() => onNavigate('quchong')}>
                        查看进度
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={() => dismissJob(job)}>
                      知道了
                    </button>
                  </>
                ) : job.status !== 'starting' ? (
                  <button className="btn btn-sm" onClick={() => dismissJob(job)}>
                    知道了
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !folders.length && !error && (
        <div className="lib-empty">
          还没有剧。在「发现短剧」里下载一部，或者点右上角「导入已有剧」选一个放着视频的文件夹。
        </div>
      )}

      <div className="lib-grid">
        {folders.map((folder) => (
          <div
            key={folder.path}
            className="lib-card"
            role="button"
            tabIndex={0}
            onClick={() => openFolder(folder)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openFolder(folder))}
            title={folder.path}
          >
            <div className="lib-cover">
              {folder.coverUrl ? (
                <img src={folder.coverUrl} alt={folder.name} loading="lazy" />
              ) : (
                <div className="lib-cover-empty">
                  <Film size={22} />
                </div>
              )}
              <span className="lib-badge">{folder.videoCount} 集</span>
              {folder.imported && (
                <button
                  className="lib-remove"
                  title="从列表移除（不会删除文件夹里的任何文件）"
                  onClick={(e) => removeImported(folder, e)}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="lib-title">{folder.name}</div>
            <div className="lib-sub">
              {folder.imported ? '导入的文件夹' : folder.source || '下载目录'}
              {folder.totalEpisodes > 0 && ` · 已下 ${folder.videoCount}/${folder.totalEpisodes}`}
              {folder.hasSynopsis && ' · 有简介'}
            </div>
          </div>
        ))}
      </div>

      {(detail || detailLoading) && (
        <div className="lib-mask" onClick={closeDetail}>
          <div
            className="lib-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="选择要处理的集"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="lib-dialog-head">
              <div className="lib-dialog-title">
                <Film size={18} />
                <span>{detail ? `《${detail.name}》` : '加载中…'}</span>
              </div>
              <button className="icon-btn" onClick={closeDetail} title="关闭">
                <X size={16} />
              </button>
            </div>

            {detailLoading && (
              <div className="lib-loading">
                <RefreshCw size={18} className="spin" /> 正在读取文件夹…
              </div>
            )}

            {detail && (
              <>
                <div className="lib-dialog-body">
                  {detail.synopsis && <p className="lib-synopsis">{detail.synopsis}</p>}
                  <PublishPanel dir={detail.dir} />
                  <div className="lib-toolbar">
                    <span>
                      已选 {selectedCount} / {episodes.length} 集
                    </span>
                    <button
                      className="btn btn-sm"
                      onClick={() => setSelected(allSelected ? new Set() : new Set(episodes.map((e) => e.path)))}
                    >
                      {allSelected ? '全不选' : '全选'}
                    </button>
                  </div>
                  {remoteNote && <div className="lib-remote-note">{remoteNote}</div>}
                  {!episodes.length && <div className="lib-empty">这个文件夹里没有视频。</div>}
                  <div className="lib-episodes">
                    {cards.map((card) => {
                      if (card.kind === 'missing') {
                        return (
                          <div
                            key={card.key}
                            className={`lib-episode is-missing is-${card.item.state}`}
                            title={`第${card.item.index}集：${card.item.text}`}
                          >
                            <div className="lib-episode-cover lib-ghost">
                              <span className="lib-ghost-no">第{card.item.index}集</span>
                              <span className="lib-ghost-state">{card.item.text}</span>
                            </div>
                          </div>
                        );
                      }
                      const episode = card.episode;
                      const on = selected.has(episode.path);
                      return (
                        <button
                          type="button"
                          key={episode.path}
                          className={`lib-episode ${on ? 'is-selected' : ''}`}
                          aria-pressed={on}
                          onClick={() => toggle(episode.path)}
                          title={episode.name}
                        >
                          <div className="lib-episode-cover">
                            {episode.cover || detail.coverUrl ? (
                              <img src={episode.cover || detail.coverUrl} alt="" loading="lazy" />
                            ) : (
                              <div className="lib-cover-empty">
                                <Film size={18} />
                              </div>
                            )}
                            <span className="lib-episode-no">
                              {episode.index != null ? `第${episode.index}集` : '未识别集号'}
                            </span>
                            {on && (
                              <span className="lib-check">
                                <Check size={12} />
                              </span>
                            )}
                          </div>
                          <div className="lib-episode-name">{episode.name}</div>
                          <div className="lib-episode-size">{formatSize(episode.size)}</div>
                        </button>
                      );
                    })}
                  </div>
                  {showParams && opts && (
                    <div ref={paramsRef}>
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
                </div>

                <div className="lib-dialog-foot">
                  <div className="lib-foot-info">
                    <div className="lib-modes" role="radiogroup" aria-label="处理方式">
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
                    </div>
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
                    <div className="lib-path" title={detail.outputDir}>
                      输入：{detail.dir}　→　输出：{detail.outputDir}
                    </div>
                    {submitting && (
                      <div className="lib-notice">
                        {progress?.stage === 'analyze'
                          ? `正在分析切点：${progress.done}/${progress.total}`
                          : '正在准备…'}
                      </div>
                    )}
                    {notice && <div className="lib-notice lib-notice-lines">{notice}</div>}
                  </div>
                  <div className="lib-foot-actions">
                    <button className="btn btn-sm" onClick={() => setShowParams((value) => !value)}>
                      去重参数…
                    </button>
                    {queued && onNavigate && (
                      <button className="btn" onClick={() => onNavigate('quchong')}>
                        查看进度
                      </button>
                    )}
                    <button
                      className="btn btn-primary"
                      onClick={startDedup}
                      disabled={submitting || !selectedCount || !opts}
                    >
                      开始处理（{selectedCount} 集）
                    </button>
                  </div>
                </div>
              </>
            )}
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
                  第 {item.index} 集：{item.text}
                </li>
              ))}
            </ul>
            {decision.kind === 'download' ? (
              <p>
                拼接时会直接跳过它们，前后两集接在一起，剧情会有跳跃。可以先补下载，下完自动继续处理；也可以不管，强制拼接。
              </p>
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
                <>
                  <button className="btn btn-primary" onClick={() => submit('download')}>
                    先补下载，下完自动继续
                  </button>
                  <button className="btn" onClick={() => submit('force')}>
                    不管，强制拼接
                  </button>
                </>
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
