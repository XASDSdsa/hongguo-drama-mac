import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './SeriesLibrary.css';
import { Film, FolderPlus, RefreshCw, X } from './icons';
import Pager from './Pager';
import SeriesDetail from './SeriesDetail';
import TaskOverview, { overviewBusy } from './TaskOverview';
import useLiveData from './useLiveData';
import { clampPage, slicePage } from './pagination';
import { processedText } from './processed-time.mjs';

const VIEW_KEY = 'library-view';
const LIST_PAGE_SIZES = [12, 24, 48, 96];

function readView() {
  try {
    return JSON.parse(window.localStorage.getItem(VIEW_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}
function saveView(patch) {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify({ ...readView(), ...patch }));
  } catch (_) {
    /* 存储不可用时，只是不记住每页条数。 */
  }
}

/** 卡片右上角的状态角标：处理中、下载中、有失败。 */
function cardStatus(item) {
  if (!item) return null;
  if (item.planning || item.processing?.state === 'running') return { kind: 'running', text: '处理中' };
  if (item.draft) return { kind: 'running', text: '做草稿中' };
  if (item.downloads.active || item.downloads.pending) return { kind: 'running', text: '下载中' };
  if (item.processing?.state === 'queued') return { kind: 'queued', text: '排队中' };
  if (item.processing?.state === 'failed' || item.downloads.failed) return { kind: 'failed', text: '有失败' };
  return null;
}

/** 管理剧集：剧列表（搜索、分页）。点一部剧进入它的子页面，不是弹窗。 */
export default function SeriesLibrary({ active = true, onNavigate, target = null, onBackChange }) {
  const [folders, setFolders] = useState([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(null); // 正在看的剧（文件夹记录）
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() =>
    LIST_PAGE_SIZES.includes(readView().listPageSize) ? readView().listPageSize : 24,
  );

  // quiet：后台自动刷新时不转圈、不清掉错误提示，免得列表一闪一闪。
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    try {
      const result = await window.electronAPI.libraryList();
      if (result?.success) {
        setFolders(result.folders);
        setRoot(result.root);
      } else if (!quiet) setError(result?.error || '读取失败');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  // 每次回到这个页面都重新扫描磁盘：下载完新集、用户手动增删文件后列表要是最新的。
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // 停在列表页时：新加了下载、下完一集、下载失败或暂停，都马上重读一次（合并 1 秒内的多次事件），
  // 刚点了下载的剧不用退出再进来才出现，卡片上的集数也跟着涨。
  const reloadTimer = useRef(null);
  useEffect(() => {
    if (!active || current) return undefined;
    const api = window.electronAPI || {};
    const soon = () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => load({ quiet: true }), 1000);
    };
    const offs = [
      api.onDownloadTaskAdded?.(soon),
      api.onDownloadCompleted?.(soon),
      api.onDownloadFailed?.(soon),
      api.onDownloadStopped?.(soon),
      api.onDownloadQueueChanged?.(soon),
    ];
    return () => {
      offs.forEach((off) => off?.());
      clearTimeout(reloadTimer.current);
    };
  }, [active, current, load]);

  // 打开了某部剧：窗口顶栏左边显示「返回剧集列表」。
  const closeDetail = useCallback(() => setCurrent(null), []);
  useEffect(() => {
    onBackChange?.(current ? closeDetail : null);
  }, [current, closeDetail, onBackChange]);
  useEffect(() => () => onBackChange?.(null), [onBackChange]);

  // 从别的页面带着剧编号跳过来：直接打开那部剧。
  useEffect(() => {
    if (!target?.seriesId || !folders.length) return;
    const found = folders.find((item) => item.seriesId && String(item.seriesId) === String(target.seriesId));
    if (found) setCurrent(found);
  }, [target, folders]);

  // 总任务（所有剧的处理、下载、补下载）：数据在主进程，切页面再回来、重启应用后都还在。
  const [overview, refreshOverview] = useLiveData({
    load: async () => {
      const result = await window.electronAPI.libraryOverview();
      return result?.success ? result : null;
    },
    isBusy: overviewBusy,
    // 打开了某一部剧时总览不在屏幕上，不用每隔几秒扫一遍所有剧的文件夹；回到列表时会马上重读。
    active: active && !current,
  });
  const itemByDir = useMemo(() => new Map((overview?.items || []).map((item) => [item.dir, item])), [overview]);
  const openByDir = (item) => {
    const found = folders.find((folder) => folder.path === item.dir);
    if (found) setCurrent(found);
  };
  const dismissJob = async (job) => {
    await window.electronAPI.libraryJobDismiss(job.id);
    refreshOverview();
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
  const shown = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? folders.filter((folder) => folder.name.toLowerCase().includes(keyword)) : folders;
  }, [folders, query]);
  const currentPage = clampPage(page, shown.length, pageSize);
  const visible = slicePage(shown, currentPage, pageSize);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  if (current) {
    return <SeriesDetail key={current.path} folder={current} active={active} />;
  }

  return (
    <div className="lib-container" data-active={active}>
      <header className="lib-header">
        <div>
          <h2>管理剧集</h2>
          <p className="page-description">
            每部剧是一个文件夹：下载目录下的剧文件夹，加上你导入的文件夹。点开一部剧，选要处理的集，勾选要做的事，结果都放回这部剧的文件夹里。
          </p>
          {root && <span className="lib-root">下载目录：{root}</span>}
        </div>
        <div className="lib-header-actions">
          <button className="btn" onClick={importFolder}>
            <FolderPlus size={14} /> 导入已有剧
          </button>
          <button className="btn" onClick={() => load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新
          </button>
        </div>
      </header>

      {error && <p className="lib-error">{error}</p>}

      <TaskOverview data={overview} onOpen={openByDir} onDismissJob={dismissJob} />

      {folders.length > 0 && (
        <div className="lib-search">
          <input
            className="input-field"
            type="search"
            placeholder="按剧名搜索"
            aria-label="按剧名搜索"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
          {query.trim() && <span>找到 {shown.length} 部</span>}
        </div>
      )}

      {!loading && !folders.length && !error && (
        <div className="lib-empty">
          还没有剧。在「发现短剧」里下载一部，或者点右上角「导入已有剧」选一个放着视频的文件夹。
        </div>
      )}
      {folders.length > 0 && !shown.length && <div className="lib-empty">没有名字里带「{query.trim()}」的剧。</div>}

      <div className="lib-grid">
        {visible.map((folder) => (
          <div
            key={folder.path}
            className="lib-card"
            role="button"
            tabIndex={0}
            onClick={() => setCurrent(folder)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setCurrent(folder))}
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
              {cardStatus(itemByDir.get(folder.path)) && (
                <span className={`lib-state is-${cardStatus(itemByDir.get(folder.path)).kind}`}>
                  {cardStatus(itemByDir.get(folder.path)).text}
                </span>
              )}
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
            <div
              className={`lib-processed ${folder.processedAt ? '' : 'is-none'}`}
              title={folder.processedAt ? new Date(folder.processedAt).toLocaleString('zh-CN') : undefined}
            >
              {folder.processedAt ? `最后处理 ${processedText(folder.processedAt)}` : '还没处理'}
            </div>
          </div>
        ))}
      </div>

      <Pager
        total={shown.length}
        page={currentPage}
        pageSize={pageSize}
        onPage={setPage}
        onPageSize={(size) => {
          setPageSize(size);
          saveView({ listPageSize: size });
          setPage(1);
        }}
        sizes={LIST_PAGE_SIZES}
        unit="部"
      />
    </div>
  );
}
