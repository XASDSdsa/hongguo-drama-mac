import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './Browse.css';
import { Film, RefreshCw, ExternalLink, Download, Play, Check, X, Search } from './icons';
import { isSubmitKey, parseEpisodeRange } from './episodeRange';

const pageCache = new Map();
const PAGE_CACHE_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 25_000;

/**
 * Browse —— 分类淘剧
 *
 * 数据链路：
 *   独立来源目录 -> 卡片(series_id/剧名/封面/集数/标签)
 *   点卡片 -> 复用 search-resolve 拉全集并写入短剧档案
 *         -> 复用 get-series-episodes 拿到每集「已下载/下载中/未下载」状态
 *         -> 跳播放器 或 走既有批量下载
 */
function Browse({ onNavigate, active = true }) {
  const [source, setSource] = useState('hongguo');
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('real-drama');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);

  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0, genres: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');

  // 详情抽屉
  const [detail, setDetail] = useState(null); // { series_id, series_title, cover, episodes: [...] }
  const [detailLoading, setDetailLoading] = useState(false);
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const listTimer = useRef(null);
  const toastTimer = useRef(null);

  const invalidateList = useCallback(() => {
    listRequest.current++;
    clearTimeout(listTimer.current);
  }, []);

  const cancelList = () => {
    invalidateList();
    setLoading(false);
    setError('已取消加载，可重新加载或切换分类。');
  };

  const closeDetail = useCallback(() => {
    detailRequest.current++;
    setDetail(null);
    setDetailLoading(false);
  }, []);

  useEffect(
    () => () => {
      detailRequest.current++;
      invalidateList();
      clearTimeout(toastTimer.current);
    },
    [invalidateList],
  );

  // 已下载统计（按 series_id -> 已下载集数）
  const [downloadedMap, setDownloadedMap] = useState({});
  const [toast, setToast] = useState(null);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const loadDownloadedMap = useCallback(async () => {
    try {
      const list = (await window.electronAPI.getSeriesList()) || [];
      const map = {};
      for (const s of list) {
        const res = await window.electronAPI.getSeriesEpisodes(s.series_id);
        if (res && res.success) {
          map[String(s.series_id)] = {
            completed: res.data.completedCount,
            total: res.data.total,
          };
        }
      }
      setDownloadedMap(map);
    } catch (_) {}
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const list = await window.electronAPI.browseCategories();
      if (Array.isArray(list) && list.length) {
        setCategories(list);
      }
    } catch (_) {}
  }, []);

  const loadList = useCallback(
    async (cat, gen, pg, forceRefresh = false) => {
      invalidateList();
      const request = listRequest.current;
      const key = JSON.stringify([source, cat, gen, pg]);
      const cached = pageCache.get(key);
      setUnsupported(false);
      setError('');
      setResults(cached?.results || []);
      setMeta(cached?.meta || { total: 0, totalPages: 0, genres: [] });
      setSourceUrl(cached?.sourceUrl || '');
      if (!forceRefresh && cached && Date.now() - cached.savedAt < PAGE_CACHE_TTL_MS) {
        setLoading(false);
        return;
      }
      setLoading(true);
      listTimer.current = setTimeout(() => {
        if (request !== listRequest.current) return;
        invalidateList();
        setLoading(false);
        setError(cached ? '刷新超时，仍显示上次片单；可重试或切换分类。' : '加载超时，请重试或切换分类。');
      }, LIST_TIMEOUT_MS);
      try {
        const res = await window.electronAPI.browseList({ source, category: cat, genre: gen, page: pg, forceRefresh });
        if (request !== listRequest.current) return;
        if (!res?.success) throw new Error(res?.error || '来源暂时不可用');
        const next = {
          results: Array.isArray(res.results) ? res.results : [],
          meta: {
            total: res.total || 0,
            totalPages: res.totalPages || 0,
            genres: res.genres || [],
            hasMore: res.hasMore === true,
          },
          sourceUrl: res.sourceUrl || '',
          savedAt: Date.now(),
        };
        setResults(next.results);
        setMeta(next.meta);
        setSourceUrl(next.sourceUrl);
        if (next.results.length) {
          pageCache.delete(key);
          pageCache.set(key, next);
          if (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value);
        } else {
          pageCache.delete(key);
          setUnsupported(res.unsupported === true);
          setError(res.emptyMessage || '这一页没有取到内容，可重新加载或换分类。');
        }
      } catch (e) {
        if (request !== listRequest.current) return;
        setError(`${cached ? '刷新失败，仍显示上次片单' : '加载失败'}：${e.message || '请重试'}`);
      } finally {
        if (request === listRequest.current) {
          clearTimeout(listTimer.current);
          setLoading(false);
        }
      }
    },
    [invalidateList, source],
  );

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    if (active) loadDownloadedMap();
  }, [active, loadDownloadedMap]);

  useEffect(() => {
    loadList(category, genre, page);
  }, [category, genre, page, loadList]);

  const switchSource = (next) => {
    if (next === source) return;
    invalidateList();
    closeDetail();
    setSource(next);
    setCategory('real-drama');
    setGenre('');
    setPage(1);
    setResults([]);
    setMeta({ total: 0, totalPages: 0, genres: [] });
    setSourceUrl('');
    setError('');
  };

  const switchCategory = (slug) => {
    if (slug === category) return;
    invalidateList();
    setError('');
    setMeta({ total: 0, totalPages: 0, genres: [] });
    setCategory(slug);
    setGenre('');
    setPage(1);
    setResults([]);
  };

  const switchGenre = (slug) => {
    if (slug === genre) return;
    invalidateList();
    setError('');
    setGenre(slug);
    setPage(1);
    setResults([]);
  };

  const gotoPage = (p) => {
    const max = source === 'xifan' ? page + (meta.hasMore ? 1 : 0) : meta.totalPages || 1;
    const next = Math.min(Math.max(1, p), max);
    if (next === page) return;
    invalidateList();
    setError('');
    setPage(next);
    document.querySelector('.main-content:not([hidden])')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ===== 打开某部剧 =====
  const openSeries = async (item) => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setDetail(null);
    setSelectedIdx(new Set());
    setRangeInput('');
    setRangeError('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (request !== detailRequest.current) return;
      if (!res || !res.success) {
        showToast((res && res.error) || '拉取分集失败', 'error');
        return;
      }
      const data = res.data;
      // 合并下载状态
      const epRes = await window.electronAPI.getSeriesEpisodes(item.series_id);
      if (request !== detailRequest.current) return;
      const statusMap = {};
      if (epRes && epRes.success) {
        for (const e of epRes.data.episodes) statusMap[e.vid_index] = e;
      }
      const episodes = data.episodes.map((ep) => ({
        ...ep,
        status: statusMap[ep.vid_index] ? statusMap[ep.vid_index].status : 'missing',
        progress: statusMap[ep.vid_index] ? statusMap[ep.vid_index].progress : 0,
        fileUrl: statusMap[ep.vid_index] ? statusMap[ep.vid_index].fileUrl : null,
      }));
      setDetail({ ...data, episodes, completedCount: episodes.filter((e) => e.status === 'completed').length });
      // 默认全选未下载的
      setSelectedIdx(new Set(episodes.filter((e) => !e.locked && e.status !== 'completed').map((e) => e.vid_index)));
    } catch (e) {
      if (request === detailRequest.current) showToast('打开失败: ' + e.message, 'error');
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  };

  const toggleIdx = (idx) => {
    if (!detail?.episodes.some((ep) => ep.vid_index === idx && !ep.locked)) return;
    const next = new Set(selectedIdx);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelectedIdx(next);
  };

  // 区间快选：1-50 / 前10 / 后30 / 全选 / 清空
  const applyRange = (expr) => {
    if (!detail) return;
    try {
      const nums = parseEpisodeRange(expr, detail.episodes.length);
      setSelectedIdx(
        new Set(detail.episodes.filter((e) => !e.locked && nums.has(e.vid_index)).map((e) => e.vid_index)),
      );
      setRangeError('');
    } catch (error) {
      setRangeError(error.message);
    }
  };

  const downloadSelected = async () => {
    if (!detail || selectedIdx.size === 0) return;
    setSubmitting(true);
    try {
      const eps = detail.episodes.filter((e) => !e.locked && selectedIdx.has(e.vid_index));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: detail.series_id,
        seriesTitle: detail.series_title,
        episodes: eps,
      });
      if (res && res.success) {
        showToast(`已加入下载队列：${res.count} 集`);
        setDetail(null);
        if (onNavigate) onNavigate('library');
      } else {
        showToast((res && res.error) || '提交下载失败', 'error');
      }
    } catch (e) {
      showToast('提交异常: ' + e.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 从第一集开始；播放器按实际状态选择本地或在线片源。
  const playNow = async () => {
    if (!detail) return;
    const first = detail.episodes.find((e) => !e.locked);
    if (!first) return;
    try {
      const res = await window.electronAPI.playSeries({ seriesId: detail.series_id, vidIndex: first.vid_index });
      if (res?.success) closeDetail();
      else showToast(res?.error || '打开播放器失败，请重试', 'error');
    } catch (e) {
      showToast('打开播放器失败: ' + e.message, 'error');
    }
  };

  const showBrowser = async () => {
    if (source !== 'hongguo' || !sourceUrl) return;
    try {
      const res = await window.electronAPI.searchWindowShow(true, sourceUrl);
      if (res?.success === false) throw new Error(res.error || '来源页面打开失败');
      showToast('已打开当前来源页面');
    } catch (e) {
      showToast(e.message || '来源页面打开失败', 'error');
    }
  };

  useDialogKeyboard(active && (!!detail || detailLoading), closeDetail, '.browse-drawer');

  const totalPages = meta.totalPages || 0;
  const pageNumbers = useMemo(() => {
    if (!totalPages) return [];
    const out = [];
    const cur = page;
    const push = (n) => {
      if (n >= 1 && n <= totalPages && !out.includes(n)) out.push(n);
    };
    out.push(1);
    for (let i = cur - 1; i <= cur + 1; i++) push(i);
    out.push(totalPages);
    return out.sort((a, b) => a - b);
  }, [totalPages, page]);

  return (
    <div className="browse-container">
      <div className="browse-header">
        <div className="browse-title">
          <div>
            <h2>发现短剧</h2>
            <p className="page-description">挑一部喜欢的，让故事继续。</p>
          </div>
        </div>
        <div className="browse-header-right">
          <label className="source-control">
            来源
            <select
              className="input-field"
              aria-label="短剧来源"
              value={source}
              onChange={(e) => switchSource(e.target.value)}
            >
              <option value="hongguo">红果短剧</option>
              <option value="xifan">西饭短剧</option>
            </select>
          </label>
          <button className="btn btn-primary" onClick={() => onNavigate('download')}>
            <Search size={15} />
            搜索短剧
          </button>
          <button className="btn btn-outline" disabled={loading} onClick={() => loadList(category, genre, page, true)}>
            <RefreshCw size={15} />
            刷新片单
          </button>
          {meta.total > 0 && <span className="browse-stat">共 {meta.total} 部</span>}
          {source === 'hongguo' && sourceUrl && (
            <button className="btn btn-outline" onClick={showBrowser}>
              <ExternalLink size={15} />
              打开来源页面
            </button>
          )}
        </div>
      </div>

      {/* 分类 tab */}
      {source === 'hongguo' && (
        <div className="browse-cats">
          {(categories.length ? categories : [{ slug: 'real-drama', label: '真人剧' }]).map((c) => (
            <button
              key={c.slug}
              className={`browse-cat ${category === c.slug ? 'active' : ''}`}
              onClick={() => switchCategory(c.slug)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* 题材 chips */}
      {meta.genres.length > 0 && (
        <div className="browse-genres">
          <button className={`genre-chip ${genre === '' ? 'active' : ''}`} onClick={() => switchGenre('')}>
            {source === 'xifan' ? '默认分类' : '全部'}
          </button>
          {meta.genres.map((g) => (
            <button
              key={g.slug}
              className={`genre-chip ${genre === g.slug ? 'active' : ''}`}
              onClick={() => switchGenre(g.slug)}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="browse-error-state" role={unsupported ? 'status' : 'alert'}>
          <Film size={36} />
          <h3>{unsupported ? '这里是图文漫画' : '暂时没能加载剧集'}</h3>
          <p>{error}</p>
          <div className="search-empty-actions">
            {unsupported ? (
              <button className="btn btn-primary" onClick={() => switchCategory('comic-drama')}>
                查看漫剧
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => loadList(category, genre, page, true)}>
                <RefreshCw size={15} />
                重新加载
              </button>
            )}
            <button className="btn btn-outline" onClick={() => onNavigate('download')}>
              按剧名搜索
            </button>
          </div>
        </div>
      )}

      {loading && results.length > 0 && (
        <div className="browse-loading" role="status">
          <RefreshCw size={18} className="spin" />
          <span>正在更新片单，仍可浏览上次结果…</span>
          <button className="btn btn-outline btn-sm" onClick={cancelList}>
            取消加载
          </button>
        </div>
      )}

      {loading && results.length === 0 ? (
        <div className="browse-loading-state" role="status">
          <div className="browse-loading">
            <RefreshCw size={18} className="spin" />
            <span>正在加载{categories.find((item) => item.slug === category)?.label || '短剧'}…</span>
            <button className="btn btn-outline btn-sm" onClick={cancelList}>
              取消加载
            </button>
          </div>
          <div className="poster-skeletons" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => (
              <div className="poster-skeleton" key={i}>
                <div />
                <span />
                <span />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="browse-grid">
          {results.map((item) => {
            const dl = downloadedMap[String(item.series_id)];
            return (
              <button
                type="button"
                key={item.series_id}
                className="browse-card"
                onClick={() => openSeries(item)}
                title={item.series_title}
              >
                <div className="browse-cover">
                  {item.cover ? (
                    <img src={item.cover} alt={item.series_title} loading="lazy" />
                  ) : (
                    <div className="cover-placeholder">
                      <Film size={22} />
                    </div>
                  )}
                  {item.episode_count > 0 && <span className="browse-ep-badge">全{item.episode_count}集</span>}
                  {dl && dl.completed > 0 && (
                    <span className="browse-dl-badge">
                      <Check size={11} /> {dl.completed}/{dl.total}
                    </span>
                  )}
                  <div className="browse-hover">
                    <span className="browse-hover-play">
                      <Play size={16} /> {dl && dl.completed > 0 ? '播放' : '查看'}
                    </span>
                  </div>
                </div>
                <div className="browse-card-title">{item.series_title}</div>
                {item.tags && item.tags.length > 0 && (
                  <div className="browse-card-tags">
                    {item.tags.slice(0, 2).map((t) => (
                      <span key={t} className="browse-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="browse-pager">
          <button className="pager-item" aria-label="上一页" disabled={page <= 1} onClick={() => gotoPage(page - 1)}>
            ‹
          </button>
          {pageNumbers.map((n, i) => (
            <React.Fragment key={n}>
              {i > 0 && n - pageNumbers[i - 1] > 1 && <span className="pager-gap">…</span>}
              <button className={`pager-item ${n === page ? 'active' : ''}`} onClick={() => gotoPage(n)}>
                {n}
              </button>
            </React.Fragment>
          ))}
          <button
            className="pager-item"
            aria-label="下一页"
            disabled={page >= totalPages}
            onClick={() => gotoPage(page + 1)}
          >
            ›
          </button>
        </div>
      )}

      {source === 'xifan' && (page > 1 || meta.hasMore) && (
        <div className="browse-pager">
          <button className="pager-item" disabled={page <= 1 || loading} onClick={() => gotoPage(page - 1)}>
            上一页
          </button>
          <span>第 {page} 页</span>
          <button className="pager-item" disabled={!meta.hasMore || loading} onClick={() => gotoPage(page + 1)}>
            下一页
          </button>
        </div>
      )}

      {/* ===== 剧集详情抽屉 ===== */}
      {(detail || detailLoading) && (
        <div className="browse-drawer-mask" onClick={closeDetail}>
          <div
            className="browse-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="剧集详情"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="browse-drawer-head">
              <div className="browse-drawer-title">
                <Film size={18} />
                <span>{detail ? `《${detail.series_title}》` : '加载中…'}</span>
              </div>
              <button className="icon-btn" onClick={closeDetail} title="关闭">
                <X size={16} />
              </button>
            </div>

            {detailLoading && (
              <div className="browse-loading">
                <RefreshCw size={18} className="spin" />
                <span>正在拉取全集…</span>
              </div>
            )}

            {detail && (
              <>
                <div className="browse-drawer-body">
                  <div className="browse-drawer-info">
                    {detail.cover && <img src={detail.cover} alt="" className="browse-drawer-cover" />}
                    <div className="browse-drawer-meta">
                      <div className="browse-drawer-count">
                        {String(detail.series_id).startsWith('hema:')
                          ? '河马短剧'
                          : String(detail.series_id).startsWith('xifan:')
                            ? '西饭短剧'
                            : '红果短剧'}{' '}
                        · 共 {detail.total} 集 · 已下载 <b>{detail.completedCount}</b> 集
                      </div>
                      {detail.web_accessible_episodes != null && detail.web_accessible_episodes < detail.total && (
                        <div className="browse-drawer-sub">
                          网页源提供前 {detail.web_accessible_episodes} 集，后续集数自动尝试 App 片源。
                        </div>
                      )}
                      {detail.episodes.some((ep) => ep.locked) && (
                        <div className="browse-drawer-sub">标记“锁定”的集数需在来源平台解锁，本应用不提供解锁。</div>
                      )}
                      <div className="browse-drawer-sub">选中 {selectedIdx.size} 集待下载</div>
                      <div className="browse-range-row">
                        <input
                          type="text"
                          className="input-field"
                          aria-label="选择集数范围"
                          placeholder="区间，如 1-50 或 1,3,5"
                          value={rangeInput}
                          onChange={(e) => {
                            setRangeInput(e.target.value);
                            setRangeError('');
                          }}
                          onKeyDown={(e) => isSubmitKey(e) && applyRange(rangeInput)}
                        />
                        <button className="btn btn-outline btn-sm" onClick={() => applyRange(rangeInput)}>
                          应用
                        </button>
                      </div>
                      {rangeError && (
                        <p className="alert alert-error" role="alert">
                          {rangeError}
                        </p>
                      )}
                      <div className="preset-row mt8">
                        <button className="btn-chip" onClick={() => applyRange(`1-${Math.min(10, detail.total)}`)}>
                          前10集
                        </button>
                        <button className="btn-chip" onClick={() => applyRange(`1-${Math.min(30, detail.total)}`)}>
                          前30集
                        </button>
                        <button
                          className="btn-chip"
                          onClick={() => applyRange(`${Math.max(1, detail.total - 29)}-${detail.total}`)}
                        >
                          后30集
                        </button>
                        <button
                          className="btn-chip"
                          onClick={() =>
                            setSelectedIdx(new Set(detail.episodes.filter((e) => !e.locked).map((e) => e.vid_index)))
                          }
                        >
                          全选
                        </button>
                        <button className="btn-chip" onClick={() => setSelectedIdx(new Set())}>
                          清空
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="browse-eps">
                    {detail.episodes.map((ep) => (
                      <button
                        disabled={ep.locked === true}
                        aria-pressed={selectedIdx.has(ep.vid_index)}
                        key={ep.vid_index}
                        className={`ep-chip ep-${ep.status} ${selectedIdx.has(ep.vid_index) ? 'ep-picked' : ''}`}
                        onClick={() => toggleIdx(ep.vid_index)}
                        title={ep.locked ? '需在来源平台解锁' : ep.title || `第 ${ep.vid_index} 集`}
                      >
                        <span className="ep-num">{ep.vid_index}</span>
                        {ep.locked && <span className="ep-lock-label">锁定</span>}
                        {ep.status === 'completed' && <Check size={11} className="ep-badge" />}
                        {selectedIdx.has(ep.vid_index) && <span className="ep-pick-dot" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="browse-drawer-foot">
                  <button
                    className="btn btn-outline"
                    disabled={!detail.episodes.some((ep) => !ep.locked)}
                    onClick={playNow}
                  >
                    <Play size={15} />
                    立即播放
                  </button>
                  <div className="browse-foot-right">
                    <button
                      className="btn btn-primary"
                      disabled={submitting || selectedIdx.size === 0}
                      onClick={downloadSelected}
                    >
                      <Download size={15} />
                      下载选中 ({selectedIdx.size})
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`dm-toast dm-toast-${toast.type}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default Browse;
