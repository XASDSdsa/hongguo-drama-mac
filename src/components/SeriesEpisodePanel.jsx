import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Film, Play, RefreshCw } from './icons';
import { isSubmitKey, parseEpisodeRange } from './episodeRange';
import './SeriesEpisodePanel.css';

const STATUS_TEXT = { completed: '已下载', downloading: '下载中', pending: '排队中', queued: '排队中', missing: '未下载', failed: '失败', stopped: '已停止', cancelled: '已停止' };
const canDownload = ep => !ep.locked && Boolean(ep.vid) && Number.isSafeInteger(Number(ep.vid_index)) && Number(ep.vid_index) > 0 && ['missing', 'failed', 'stopped', 'cancelled'].includes(ep.status);
const statusText = ep => ep.status === 'completed' ? '已下载' : ep.locked ? '已锁定' : STATUS_TEXT[ep.status] || '待更新';
const formatUpdatedAt = value => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '未更新';
  const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  if (Number.isNaN(date.getTime())) return '未更新';
  const pad = part => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export default function SeriesEpisodePanel({ seriesId, title, cover, lastUpdatedAt = 0, active = true, revision = 0, onDownloadsChanged, onNotify }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [range, setRange] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [coverFailed, setCoverFailed] = useState(false);
  const lifecycle = useRef(0);
  const readRequest = useRef(0);
  const busy = useRef(false);
  const playBusy = useRef(false);
  const current = useRef({ seriesId, active });
  current.current = { seriesId, active };

  const isCurrent = useCallback(token => token === lifecycle.current && current.current.active && current.current.seriesId === seriesId, [seriesId]);
  const loadLocal = useCallback(async () => {
    if (!current.current.active) return false;
    const token = lifecycle.current;
    const request = ++readRequest.current;
    setLoading(true);
    try {
      const result = await window.electronAPI.getSeriesEpisodes(seriesId);
      if (!isCurrent(token) || request !== readRequest.current) return false;
      if (!result?.success || !Array.isArray(result.data?.episodes)) throw new Error(result?.error || '读取剧集失败');
      const episodes = result.data.episodes.map(ep => ({ ...ep, vid_index: Number(ep.vid_index) }));
      setDetail({ ...result.data, episodes });
      const available = new Set(episodes.filter(canDownload).map(ep => ep.vid_index));
      setSelected(previous => new Set([...previous].filter(index => available.has(index))));
      setError('');
      return true;
    } catch (err) {
      if (isCurrent(token) && request === readRequest.current) setError(`读取失败：${err.message || '请重试'}`);
      return false;
    } finally {
      if (isCurrent(token) && request === readRequest.current) setLoading(false);
    }
  }, [seriesId, isCurrent]);

  useEffect(() => {
    busy.current = false;
    playBusy.current = false;
    setSubmitting(false);
    setUpdating(false);
    setPlaying(false);
    return () => { lifecycle.current++; readRequest.current++; };
  }, [seriesId, active]);
  useEffect(() => { if (active) loadLocal(); }, [active, revision, loadLocal]);

  const episodes = detail?.episodes || [];
  const poster = detail?.cover || cover;
  const updatedAt = detail?.episodesUpdatedAt || detail?.updatedAt || lastUpdatedAt;
  useEffect(() => setCoverFailed(false), [poster]);
  const available = useMemo(() => episodes.filter(canDownload), [episodes]);
  const completed = episodes.filter(ep => ep.status === 'completed').length;
  const source = String(seriesId).startsWith('xifan:') ? '西饭短剧' : String(seriesId).startsWith('hema:') ? '河马短剧' : '红果短剧';
  const disabled = !active || submitting || updating;

  const updateEpisodes = async () => {
    if (!active || busy.current) return;
    const token = lifecycle.current;
    busy.current = true;
    setUpdating(true);
    setError('');
    try {
      const result = await window.electronAPI.searchResolve(seriesId);
      if (!isCurrent(token)) return;
      if (!result?.success) throw new Error(result?.error || '来源暂时不可用');
      if (await loadLocal()) {
        if (!isCurrent(token)) return;
        onNotify?.('剧集信息已更新');
        onDownloadsChanged?.();
      }
    } catch (err) {
      if (isCurrent(token)) setError(`更新失败：${err.message || '请重试'}。仍保留已加载的剧集。`);
    } finally {
      if (isCurrent(token)) { busy.current = false; setUpdating(false); }
    }
  };

  const applyRange = expression => {
    if (disabled) return;
    try {
      const maximum = episodes.reduce((max, ep) => Math.max(max, ep.vid_index || 0), 0);
      const indexes = parseEpisodeRange(expression, maximum);
      setSelected(new Set(available.filter(ep => indexes.has(ep.vid_index)).map(ep => ep.vid_index)));
      setRangeError('');
    } catch (err) { setRangeError(err.message); }
  };
  const selectAvailable = list => { if (!disabled) { setSelected(new Set(list.map(ep => ep.vid_index))); setRangeError(''); } };
  const toggleEpisode = ep => {
    if (disabled || !canDownload(ep)) return;
    setSelected(previous => { const next = new Set(previous); if (next.has(ep.vid_index)) next.delete(ep.vid_index); else next.add(ep.vid_index); return next; });
  };

  const downloadSelected = async () => {
    if (!active || busy.current) return;
    const chosen = available.filter(ep => selected.has(ep.vid_index));
    if (!chosen.length) return;
    const token = lifecycle.current;
    busy.current = true;
    setSubmitting(true);
    try {
      const result = await window.electronAPI.hongguoDownloadBatch({
        seriesId, seriesTitle: detail?.series_title || title,
        episodes: chosen.map(ep => ({ ...ep, cover: poster || '' })),
      });
      if (!isCurrent(token)) return;
      if (!result?.success) throw new Error(result?.error || '提交下载失败');
      setSelected(new Set());
      onNotify?.(`已加入下载队列：${result.count ?? chosen.length} 集`);
      await loadLocal();
      if (isCurrent(token)) onDownloadsChanged?.();
    } catch (err) {
      if (isCurrent(token)) onNotify?.(`提交下载失败：${err.message || '请重试'}`, 'error');
    } finally {
      if (isCurrent(token)) { busy.current = false; setSubmitting(false); }
    }
  };

  const play = async () => {
    if (!active || playBusy.current) return;
    const first = episodes.find(ep => ep.status === 'completed' && !ep.locked) || episodes.find(ep => !ep.locked && ep.vid);
    if (!first) return;
    const token = lifecycle.current;
    playBusy.current = true;
    setPlaying(true);
    try {
      const result = await window.electronAPI.playSeries({ seriesId, vidIndex: first.vid_index });
      if (isCurrent(token) && !result?.success) onNotify?.(result?.error || '打开播放器失败', 'error');
    } catch (err) {
      if (isCurrent(token)) onNotify?.(`打开播放器失败：${err.message}`, 'error');
    } finally {
      if (isCurrent(token)) { playBusy.current = false; setPlaying(false); }
    }
  };

  return <section className="series-episode-panel" aria-label="剧集详情">
    <div className="sep-header">
      <div className="sep-cover">{poster && !coverFailed ? <img src={poster} alt={detail?.series_title || title} onError={() => setCoverFailed(true)} /> : <Film size={34} />}</div>
      <div className="sep-meta">
        <div className="sep-title-row"><h3>{detail?.series_title || title}</h3><button className="btn btn-outline btn-sm" onClick={updateEpisodes} disabled={disabled}><RefreshCw size={14} className={updating ? 'spin' : ''} />{updating ? '正在更新…' : '更新剧集'}</button></div>
        <p className="sep-count">{source} · 共 {episodes.length} 集 · 已下载 <b>{completed}</b> 集</p>
        <p className="sep-updated">上次更新：{formatUpdatedAt(updatedAt)}</p>
        <p className="sep-hint">绿色为已下载，勾选未下载集数可继续下载。</p>
        <div className="sep-range-row"><input className="input-field" aria-label="选择下载集数" placeholder="区间，如 1-50 或 1,3,5" value={range} disabled={disabled || !episodes.length} onChange={event => setRange(event.target.value)} onKeyDown={event => { if (isSubmitKey(event)) applyRange(range); }} /><button className="btn btn-outline" disabled={disabled || !episodes.length} onClick={() => applyRange(range)}>应用</button></div>
        <div className="sep-presets"><button className="btn btn-ghost btn-sm" disabled={disabled || !episodes.length} onClick={() => applyRange('1-10')}>前10集</button><button className="btn btn-ghost btn-sm" disabled={disabled || !episodes.length} onClick={() => applyRange('1-30')}>前30集</button><button className="btn btn-ghost btn-sm" disabled={disabled || !available.length} onClick={() => selectAvailable(available)}>选择未下载</button><button className="btn btn-ghost btn-sm" disabled={disabled || !selected.size} onClick={() => selectAvailable([])}>清空选择</button></div>
        {rangeError && <p className="sep-error" role="alert">{rangeError}</p>}
      </div>
    </div>
    {error && <div className="sep-error" role="alert">{error}<button className="btn btn-outline btn-sm" disabled={loading || disabled} onClick={loadLocal}>重试读取</button></div>}
    {loading && !detail && <p className="sep-hint" role="status">正在读取剧集和下载状态…</p>}
    {!loading && detail && !episodes.length && <p className="sep-hint">尚未保存分集信息，点击「更新剧集」获取完整列表。</p>}
    {!!episodes.length && <>
      <div className="sep-legend" aria-label="集数状态说明"><span className="completed">已下载</span><span className="downloading">下载中 / 排队中</span><span className="missing">未下载</span><span className="failed">失败 / 已停止</span><span className="locked">已锁定</span><span className="sep-selected-count">已选 {selected.size} 集</span></div>
      <div className="sep-grid" aria-label="全部剧集">
        {episodes.map(ep => {
          const state = ep.status === 'completed' ? 'completed' : ep.locked ? 'locked' : ep.status;
          const checked = selected.has(ep.vid_index);
          return <button type="button" key={ep.vid_index} className={`sep-episode ${state}${checked ? ' selected' : ''}`} data-episode-index={ep.vid_index} data-episode-status={state} title={`第 ${ep.vid_index} 集 · ${statusText(ep)}${ep.title ? ` · ${ep.title}` : ''}`} aria-label={`第 ${ep.vid_index} 集，${statusText(ep)}`} aria-pressed={checked} disabled={disabled || !canDownload(ep)} onClick={() => toggleEpisode(ep)}><span className="sep-episode-number">{ep.status === 'completed' && <Check size={12} />}{ep.vid_index}</span><span className="sep-episode-status">{statusText(ep)}</span>{checked && <span className="sep-pick-dot" />}</button>;
        })}
      </div>
      <div className="sep-actions"><button className="btn btn-outline" disabled={!active || playing || !episodes.some(ep => !ep.locked && ep.vid)} onClick={play}><Play size={15} />{playing ? '正在打开…' : '立即播放'}</button><span>已下载及队列中的集数自动跳过</span><button className="btn btn-primary" disabled={disabled || !selected.size} onClick={downloadSelected}><Download size={15} />{submitting ? '正在加入队列…' : `下载选中 (${selected.size})`}</button></div>
    </>}
  </section>;
}
