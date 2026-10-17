import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './SeriesLibrary.css';
import { Check, Film, FolderPlus, RefreshCw, X } from './icons';
import DedupParams from './DedupParams';
import useDialogKeyboard from './useDialogKeyboard';

const formatSize = (bytes) => {
  const mb = Number(bytes) / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
};

export default function SeriesLibrary({ active = true, onNavigate }) {
  const [folders, setFolders] = useState([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [opts, setOpts] = useState(null);
  const [showParams, setShowParams] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState(false);
  const requestId = useRef(0);

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
      if (alive && defaults) setOpts(defaults);
    });
    return () => {
      alive = false;
    };
  }, []);

  const closeDetail = () => {
    requestId.current++;
    setDetail(null);
    setDetailLoading(false);
    setSelected(new Set());
    setNotice('');
    setQueued(false);
  };
  useDialogKeyboard(active && (!!detail || detailLoading), closeDetail, '.lib-dialog');

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

  const startDedup = async () => {
    setSubmitting(true);
    setNotice('');
    setQueued(false);
    const result = await window.electronAPI.libraryDedup({
      dir: detail.dir,
      files: episodes.filter((item) => selected.has(item.path)).map((item) => item.path),
      opts,
    });
    setSubmitting(false);
    if (result?.success) {
      setQueued(true);
      setNotice(`已加入去重队列（${result.tasks?.length ?? selectedCount} 集），成品会放进「去重」文件夹。`);
    } else setNotice(result?.error || '提交失败');
  };

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
                  {!episodes.length && <div className="lib-empty">这个文件夹里没有视频。</div>}
                  <div className="lib-episodes">
                    {episodes.map((episode) => {
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
                </div>

                <div className="lib-dialog-foot">
                  <div className="lib-foot-info">
                    <div>处理：去重（按原集，一集出一集）</div>
                    <div className="lib-path" title={detail.outputDir}>
                      输入：{detail.dir}　→　输出：{detail.outputDir}
                    </div>
                    {showParams && opts && (
                      <DedupParams opts={opts} onChange={(k, v) => setOpts({ ...opts, [k]: v })} />
                    )}
                    {notice && <div className="lib-notice">{notice}</div>}
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
                      开始去重（{selectedCount} 集）
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
