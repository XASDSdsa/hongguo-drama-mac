import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './Player.css';
import { Play, Film, Download, Check, RefreshCw, Layers, X, Trash2, ChevronDown, Zap } from './icons';

/**
 * Player —— 内置播放器
 *
 * 设计要点：
 *  - 直接播本地 file:// 文件（实测支持 seek），无需流服务器
 *  - 「边下边看」：下一集若还在下载，显示等待态并轮询，下完自动接上
 *  - 断点续播：按 series_id 记住看到第几集、第几秒
 */
function Player({ target, onNavigate, active = true }) {
  const [seriesList, setSeriesList] = useState([]);
  const [activeSeriesId, setActiveSeriesId] = useState('');
  const [detail, setDetail] = useState(null); // { series_title, episodes: [...], total, completedCount }
  const [currentIndex, setCurrentIndex] = useState(1);
  const [autoNext, setAutoNext] = useState(true);
  const [waitingFor, setWaitingFor] = useState(null); // 正在等待下载的集号
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false); // 剧集选择面板
  const [pickerQuery, setPickerQuery] = useState('');
  const [dismissedCount, setDismissedCount] = useState(0);

  // 在线播放（按需流式或临时准备后缓存）
  const [onlineVid, setOnlineVid] = useState(null);
  const [onlineUrl, setOnlineUrl] = useState('');
  const [mediaBuffering, setMediaBuffering] = useState(false);
  const [onlineProgress, setOnlineProgress] = useState(null); // {percent, phase}
  const [cacheInfo, setCacheInfo] = useState({ count: 0, bytes: 0 });
  const [downloadedMap, setDownloadedMap] = useState({}); // series_id -> {completed,total}
  const [storageMap, setStorageMap] = useState({}); // series_id -> {files,bytes}
  const [storageTotal, setStorageTotal] = useState({ files: 0, bytes: 0 });
  const [autoDelete, setAutoDelete] = useState(false); // 看完自动删本地文件
  const [confirmAsk, setConfirmAsk] = useState(null); // {title, message, danger, onOk}

  // 兼容模式：本机解不了 HEVC 时转码为 H.264
  const [autoCompat, setAutoCompat] = useState(true);
  const [compatMap, setCompatMap] = useState({}); // vidIndex -> 转码后 url
  const [compatProgress, setCompatProgress] = useState(null); // {vidIndex, percent}
  const [decodeFailed, setDecodeFailed] = useState(false); // 当前集解不出画面
  const [playbackError, setPlaybackError] = useState('');
  const [playbackVersion, setPlaybackVersion] = useState(0);
  const [compatCache, setCompatCache] = useState({ files: 0, bytes: 0 });
  const [mergeAsk, setMergeAsk] = useState(false); // 合并格式选择

  const videoRef = useRef(null);
  const toastTimer = useRef(null);
  const pendingSeekRef = useRef(0); // 切集后要跳转的秒数
  const lastSavedRef = useRef(0);
  const stateRef = useRef({ currentIndex, autoNext, activeSeriesId });
  stateRef.current = { currentIndex, autoNext, activeSeriesId, waitingFor };
  const selectedSeriesRef = useRef('');
  const selectionVersion = useRef(0);
  const onlineRequestRef = useRef(null);
  const mediaVersion = useRef(0);
  const compatRequestRef = useRef(null);
  const decodeTimer = useRef(null);
  const pendingTargetRef = useRef(null);
  const loadedMediaRef = useRef(null);
  const autoCompatAttemptRef = useRef(null);
  const lastVideoSrcRef = useRef('');
  const lastLoadRef = useRef(null);

  // 只有收到当前片源的 metadata 后才保存，避免旧元素的 pause 覆盖新集断点。
  const persistPosition = useCallback((force = false) => {
    const media = loadedMediaRef.current;
    if (!media || media.version !== mediaVersion.current) return;
    const seconds = media.element.currentTime;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (!force && Math.abs(seconds - lastSavedRef.current) < 3) return;
    lastSavedRef.current = seconds;
    window.electronAPI.savePlaybackPosition(media.seriesId, media.vidIndex, seconds).catch(() => {});
  }, []);

  const currentPosition = useCallback(() => {
    const media = loadedMediaRef.current;
    return media?.version === mediaVersion.current && Number.isFinite(media.element.currentTime)
      ? media.element.currentTime
      : pendingSeekRef.current;
  }, []);

  const releaseOnline = useCallback(() => {
    const request = onlineRequestRef.current;
    onlineRequestRef.current = null;
    if (request) window.electronAPI.releaseOnlinePlay(request).catch(() => {});
  }, []);

  const cancelCompat = useCallback(() => {
    const request = compatRequestRef.current;
    compatRequestRef.current = null;
    if (request && window.electronAPI.cancelTranscodeForPlayback) {
      window.electronAPI.cancelTranscodeForPlayback({ ...request }).catch(() => {});
    }
  }, []);

  const resetPlayback = useCallback(() => {
    persistPosition(true);
    const previous = loadedMediaRef.current;
    loadedMediaRef.current = null;
    previous?.element.pause();
    mediaVersion.current++;
    setPlaybackVersion(mediaVersion.current);
    autoCompatAttemptRef.current = null;
    clearTimeout(decodeTimer.current);
    cancelCompat();
    releaseOnline();
    setOnlineVid(null);
    setOnlineUrl('');
    setOnlineProgress(null);
    setMediaBuffering(false);
    setCompatProgress(null);
    setDecodeFailed(false);
    setPlaybackError('');
    lastSavedRef.current = 0;
  }, [persistPosition, releaseOnline, cancelCompat]);

  const stopPlayback = (message = '播放已停止，可重试本集继续观看') => {
    const seekTo = currentPosition();
    resetPlayback();
    pendingSeekRef.current = seekTo;
    setWaitingFor(null);
    setPlaybackError(message);
  };

  useEffect(
    () => () => {
      persistPosition(true);
      selectionVersion.current++;
      mediaVersion.current++;
      selectedSeriesRef.current = '';
      cancelCompat();
      releaseOnline();
      clearTimeout(decodeTimer.current);
      clearTimeout(toastTimer.current);
    },
    [persistPosition, releaseOnline, cancelCompat],
  );

  const showToast = useCallback((text) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // 合并在后台进行，没有单独的进度页，完成或失败时在这里提示。
  useEffect(() => {
    const offDone = window.electronAPI.onMergeCompleted?.((data) => showToast(`合并完成：${data?.path || ''}`));
    const offFail = window.electronAPI.onMergeFailed?.((data) => showToast(`合并失败：${data?.error || '未知原因'}`));
    return () => {
      offDone?.();
      offFail?.();
    };
  }, [showToast]);

  // 载入已登记的剧集列表
  const loadSeriesList = useCallback(async () => {
    const list = (await window.electronAPI.getSeriesList()) || [];
    setSeriesList(list);
    return list;
  }, []);

  // 载入某剧的分集状态
  const loadDetail = useCallback(async (seriesId) => {
    if (!seriesId) return null;
    const version = selectionVersion.current;
    const res = await window.electronAPI.getSeriesEpisodes(seriesId);
    if (version !== selectionVersion.current || String(seriesId) !== selectedSeriesRef.current) return null;
    if (!res || !res.success) return null;
    setDetail(res.data);
    return res.data;
  }, []);

  const refreshCacheInfo = useCallback(async () => {
    try {
      const res = await window.electronAPI.onlineCacheStatus();
      if (res && res.success) setCacheInfo({ count: res.count, bytes: res.bytes });
      const dc = await window.electronAPI.dismissedCount();
      setDismissedCount(dc || 0);
      const st = await window.electronAPI.getStorageUsage();
      if (st && st.success) {
        const map = {};
        for (const s of st.series) map[String(s.series_id)] = { files: s.files, bytes: s.bytes, merged: s.merged };
        setStorageMap(map);
        setStorageTotal({ files: st.totalFiles, bytes: st.totalBytes });
      }
    } catch (_) {}
  }, []);

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

  useEffect(() => {
    refreshCacheInfo();
    window.electronAPI.getSettings().then((s) => {
      if (s) {
        setAutoDelete(s.auto_delete_watched === true);
        setAutoCompat(s.compat_mode !== false); // 默认开启
      }
    });
    window.electronAPI.compatCacheStatus().then((r) => {
      if (r && r.success) setCompatCache({ files: r.files, bytes: r.bytes });
    });
  }, [refreshCacheInfo]);

  useEffect(() => {
    if (!window.electronAPI.onTranscodeProgress) return undefined;
    return window.electronAPI.onTranscodeProgress((d) => {
      const request = compatRequestRef.current;
      if (
        !request ||
        d.requestId !== request.requestId ||
        request.version !== mediaVersion.current ||
        String(d.seriesId) !== request.seriesId ||
        d.vidIndex !== request.vidIndex ||
        d.done
      )
        return;
      setCompatProgress({ vidIndex: d.vidIndex, percent: d.percent || 0 });
    });
  }, []);

  /**
   * 注意：以下三个用到 episodes 的函数必须定义在 episodes 之后。
   * useCallback 的依赖数组在「定义时」就会求值，若提前引用后声明的 const
   * 会触发 TDZ（Cannot access 'X' before initialization）导致整页白屏。
   */
  const toggleAutoCompat = async () => {
    const next = !autoCompat;
    setAutoCompat(next);
    try {
      const s = await window.electronAPI.getSettings();
      await window.electronAPI.saveSettings({ ...s, compat_mode: next });
      showToast(next ? '兼容模式已开启：无法解码时自动转码' : '兼容模式已关闭');
    } catch (_) {}
  };

  const toggleAutoDelete = async () => {
    const next = !autoDelete;
    setAutoDelete(next);
    try {
      const s = await window.electronAPI.getSettings();
      await window.electronAPI.saveSettings({ ...s, auto_delete_watched: next });
      showToast(next ? '已开启：看完一集自动删除本地文件' : '已关闭自动删除');
    } catch (_) {}
  };

  // 打开剧集面板时，补全各剧的下载进度（只拉一次）
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      const map = {};
      for (const s of seriesList) {
        try {
          const res = await window.electronAPI.getSeriesEpisodes(s.series_id);
          if (res && res.success)
            map[String(s.series_id)] = { completed: res.data.completedCount, total: res.data.total };
        } catch (_) {}
        if (cancelled) return;
      }
      if (!cancelled) setDownloadedMap(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, seriesList]);

  useEffect(() => {
    if (!window.electronAPI.onOnlinePlayProgress) return undefined;
    return window.electronAPI.onOnlinePlayProgress((d) => {
      const request = onlineRequestRef.current;
      if (!request || request.prepared || d.requestId !== request.requestId) return;
      setOnlineProgress({
        vid: d.vid,
        percent: d.percent || 0,
        phase: d.phase || 'downloading',
        received: d.received,
        total: d.total,
      });
    });
  }, []);

  // 轮询：让「正在下载」的集实时更新，并在等待时自动接上
  useEffect(() => {
    if (!activeSeriesId || (!active && waitingFor == null)) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      let d;
      try {
        d = await loadDetail(activeSeriesId);
      } catch (_) {
      } finally {
        busy = false;
      }
      if (!d) return;
      const { waitingFor: wf } = stateRef.current;
      if (wf != null) {
        const ep = d.episodes.find((e) => e.vid_index === wf);
        if (ep && !ep.locked && ep.status === 'completed') {
          // 等待中的下一集下好了 -> 自动切过去
          setWaitingFor(null);
          const seekTo = wf === stateRef.current.currentIndex ? currentPosition() : 0;
          resetPlayback();
          pendingSeekRef.current = seekTo;
          setCurrentIndex(wf);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeSeriesId, waitingFor, loadDetail, resetPlayback, currentPosition]);

  const episodes = detail ? detail.episodes : [];
  const current = useMemo(() => episodes.find((e) => e.vid_index === currentIndex) || null, [episodes, currentIndex]);

  const compatUrl = current ? compatMap[current.vid_index] : null;
  const isOnlinePlaying = onlineVid && current && current.vid === onlineVid && onlineUrl;
  const canPlay = !!(
    !playbackError &&
    !onlineProgress &&
    current &&
    !current.locked &&
    (compatUrl || (current.status === 'completed' && current.fileUrl) || isOnlinePlaying)
  );
  const playableSource = compatUrl || (isOnlinePlaying ? onlineUrl : current?.fileUrl) || '';
  // 原生全屏依附于 video 节点。准备下一集时保留结束帧，换源不换节点。
  if (canPlay) lastVideoSrcRef.current = playableSource;
  const videoSrc = lastVideoSrcRef.current;

  useEffect(() => {
    const v = videoRef.current;
    if (loading || !canPlay || !v) return;
    const previous = lastLoadRef.current;
    lastLoadRef.current = { source: videoSrc, version: playbackVersion };
    // 相同地址的显式重试不会触发 src 变更，用原生 load 重置媒体即可。
    if (previous?.source === videoSrc && previous.version !== playbackVersion) v.load();
  }, [loading, canPlay, videoSrc, playbackVersion]);

  const playableCount = episodes.filter((e) => e.status === 'completed').length;

  /** 转码当前集为 H.264 后播放（解决本机无法解码 HEVC 的黑屏问题） */
  const startCompatPlay = useCallback(
    async (vidIndex) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (!ep || ep.locked) return;
      const request = {
        requestId: crypto.randomUUID(),
        seriesId: String(activeSeriesId),
        vidIndex,
        version: mediaVersion.current,
      };
      if (compatRequestRef.current?.version === request.version && compatRequestRef.current?.vidIndex === vidIndex)
        return;
      autoCompatAttemptRef.current = request.version;
      pendingSeekRef.current = currentPosition();
      persistPosition(true);
      videoRef.current?.pause();
      compatRequestRef.current = request;
      setCompatProgress({ vidIndex, percent: 0 });
      try {
        const res = await window.electronAPI.transcodeForPlayback({
          requestId: request.requestId,
          seriesId: activeSeriesId,
          vidIndex,
          vid: ep.vid,
          filePath: ep.savePath || null,
        });
        if (compatRequestRef.current !== request || request.version !== mediaVersion.current) return;
        compatRequestRef.current = null;
        if (res && res.success) {
          loadedMediaRef.current = null;
          setCompatMap((prev) => ({ ...prev, [vidIndex]: res.url }));
          setDecodeFailed(false);
          setCompatProgress(null);
          showToast(res.cached ? '已切换为兼容格式播放' : `已转码为兼容格式（用时 ${res.elapsed}s），开始播放`);
          window.electronAPI.compatCacheStatus().then((r) => {
            if (r && r.success) setCompatCache({ files: r.files, bytes: r.bytes });
          });
        } else {
          setCompatProgress(null);
          showToast((res && res.error) || '转码失败');
        }
      } catch (e) {
        if (compatRequestRef.current !== request || request.version !== mediaVersion.current) return;
        compatRequestRef.current = null;
        setCompatProgress(null);
        showToast('转码异常: ' + e.message);
      }
    },
    [episodes, activeSeriesId, showToast, currentPosition, persistPosition],
  );

  const clearCompatCache = async () => {
    const affected = !!compatMap[currentIndex] || !!compatRequestRef.current;
    if (affected) stopPlayback('兼容播放已停止，可重试本集继续观看');
    try {
      const r = await window.electronAPI.clearCompatCache();
      if (!r?.success) {
        showToast(r?.error || '清理转码缓存失败');
        return;
      }
      setCompatMap({});
      setCompatCache({ files: 0, bytes: 0 });
      showToast(r.count > 0 ? `已清理转码缓存，释放 ${fmtSize(r.freed)}` : '转码缓存已是空的');
    } catch (e) {
      showToast('清理转码缓存失败: ' + e.message);
    }
  };

  // 播放中若始终解不出画面（videoWidth 一直为 0），判定为解码不兼容。
  // 必须定义在早返回之前 —— hooks 不能出现在条件分支之后。
  const handlePlaying = useCallback(() => {
    if (
      playbackVersion !== mediaVersion.current ||
      !canPlay ||
      loadedMediaRef.current?.version !== mediaVersion.current
    )
      return;
    setDecodeFailed(false);
    setMediaBuffering(false);
    const idx = currentIndex;
    const version = mediaVersion.current;
    clearTimeout(decodeTimer.current);
    decodeTimer.current = setTimeout(() => {
      if (version !== mediaVersion.current) return;
      const v = videoRef.current;
      if (!v) return;
      if (v.videoWidth === 0 && !v.paused && v.currentTime > 0.3) {
        setDecodeFailed(true);
        if (autoCompat && !compatMap[idx] && autoCompatAttemptRef.current !== version) {
          showToast('当前视频未显示画面，正在尝试兼容转码…');
          startCompatPlay(idx);
        }
      }
    }, 2600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCompat, compatMap, currentIndex, startCompatPlay, showToast, playbackVersion, canPlay]);

  /**
   * 在线播放：明文片源按需加载，加密片源准备后返回播放地址。
   * 不占用下载目录；加密片源的准备文件会自动清理。
   */
  const startOnlinePlay = useCallback(
    async (vidIndex, resumeAt) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (ep?.locked) {
        showToast('这一集需在来源平台解锁');
        return;
      }
      if (!ep || !ep.vid) {
        showToast('这一集暂时无法播放，请重新获取剧集后重试');
        return;
      }
      const seekTo = resumeAt ?? (vidIndex === stateRef.current.currentIndex ? currentPosition() : 0);
      resetPlayback();
      setCompatMap((prev) => {
        const next = { ...prev };
        delete next[vidIndex];
        return next;
      });
      const request = { requestId: crypto.randomUUID(), vid: ep.vid };
      onlineRequestRef.current = request;
      pendingSeekRef.current = seekTo;
      window.electronAPI.savePlaybackPosition(activeSeriesId, vidIndex, seekTo).catch(() => {});
      setCurrentIndex(vidIndex);
      setWaitingFor(null);
      setOnlineProgress({ vid: ep.vid, percent: 0, phase: 'preparing' });
      setOnlineVid(ep.vid);
      setOnlineUrl('');
      try {
        const res = await window.electronAPI.prepareOnlinePlay({
          requestId: request.requestId,
          vid: ep.vid,
          seriesId: activeSeriesId,
          vidIndex,
        });
        if (onlineRequestRef.current !== request) {
          window.electronAPI
            .releaseOnlinePlay({ requestId: request.requestId, streamId: res?.streamId })
            .catch(() => {});
          return;
        }
        if (!res || !res.success) {
          releaseOnline();
          showToast((res && res.error) || '在线播放准备失败');
          setOnlineVid(null);
          setOnlineProgress(null);
          setPlaybackError((res && res.error) || '在线播放准备失败');
          return;
        }
        request.streamId = res.streamId;
        request.prepared = true;
        setMediaBuffering(true);
        setOnlineUrl(res.url);
        setOnlineProgress(null);
        refreshCacheInfo();
      } catch (e) {
        if (onlineRequestRef.current !== request) return;
        releaseOnline();
        showToast('在线播放失败: ' + e.message);
        setOnlineVid(null);
        setOnlineProgress(null);
        setPlaybackError('在线播放失败: ' + e.message);
      }
    },
    [episodes, activeSeriesId, showToast, refreshCacheInfo, resetPlayback, releaseOnline, currentPosition],
  );

  // 切集
  const goToEpisode = useCallback(
    (vidIndex, resumeAt) => {
      const ep = episodes.find((e) => e.vid_index === vidIndex);
      if (!ep || ep.locked) return;
      if (ep.status !== 'completed' || !ep.fileUrl) {
        startOnlinePlay(vidIndex, resumeAt);
        return;
      }
      const seekTo = resumeAt ?? (vidIndex === stateRef.current.currentIndex ? currentPosition() : 0);
      resetPlayback();
      setCurrentIndex(vidIndex);
      setWaitingFor(null);
      pendingSeekRef.current = seekTo;
      window.electronAPI.savePlaybackPosition(activeSeriesId, vidIndex, seekTo).catch(() => {});
    },
    [episodes, activeSeriesId, resetPlayback, startOnlinePlay, currentPosition],
  );

  const retryPlayback = () => {
    setCompatMap((prev) => {
      const next = { ...prev };
      delete next[currentIndex];
      return next;
    });
    goToEpisode(currentIndex, currentPosition());
  };

  // 找下一集（按集号顺序）
  const findNext = useCallback(
    (fromIndex) => {
      const idx = episodes.findIndex((e) => e.vid_index === fromIndex);
      if (idx === -1 || idx + 1 >= episodes.length) return null;
      return episodes.slice(idx + 1).find((ep) => !ep.locked) || null;
    },
    [episodes],
  );
  const findPrev = useCallback(
    (fromIndex) => {
      const idx = episodes.findIndex((e) => e.vid_index === fromIndex);
      if (idx <= 0) return null;
      return (
        episodes
          .slice(0, idx)
          .reverse()
          .find((ep) => !ep.locked) || null
      );
    },
    [episodes],
  );

  // 播放结束 -> 连播（未下载的集自动转在线播放，做到「不下载也能连着看」）
  const handleEnded = useCallback(() => {
    const { currentIndex: ci, autoNext: an, activeSeriesId: sid } = stateRef.current;
    const finished = episodes.find((e) => e.vid_index === ci);

    // 看完自动删：先把刚看完这集的本地文件清掉，再决定下一集怎么播
    if (autoDelete && finished && finished.status === 'completed' && sid) {
      window.electronAPI.deleteEpisodeFile(sid, ci).then((r) => {
        if (r && r.success && r.count > 0) {
          showToast(`第 ${ci} 集已看完，自动删除本地文件（释放 ${fmtSize(r.freed)}）`);
          refreshCacheInfo();
          loadDetail(sid);
        }
      });
    }

    if (!an) return;
    const next = findNext(ci);
    if (!next) {
      showToast(episodes.some((ep) => ep.locked) ? '已播完可播放集数，其余集数需在来源平台解锁' : '已经是最后一集');
      return;
    }
    goToEpisode(next.vid_index, 0);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findNext, goToEpisode, showToast, startOnlinePlay, autoDelete, episodes, refreshCacheInfo, loadDetail]);

  // 后台继续播放也保存进度；离开页面、暂停和关闭窗口强制保存最后一秒。
  useEffect(() => {
    const timer = setInterval(persistPosition, 5000);
    const save = () => persistPosition(true);
    window.addEventListener('beforeunload', save);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', save);
      save();
    };
  }, [persistPosition]);

  useEffect(() => {
    if (!active) persistPosition(true);
  }, [active, persistPosition]);

  const handleMetadata = (event) => {
    const v = event.currentTarget;
    if (!canPlay || playbackVersion !== mediaVersion.current || v !== videoRef.current || !current || current.locked)
      return;
    if (v.currentSrc && v.currentSrc !== videoSrc) return;
    loadedMediaRef.current = {
      element: v,
      seriesId: activeSeriesId,
      vidIndex: currentIndex,
      version: mediaVersion.current,
    };
    const seekTo = Math.max(0, Number(pendingSeekRef.current) || 0);
    if (seekTo > 0 && (!Number.isFinite(v.duration) || seekTo < v.duration - 3)) {
      v.currentTime = seekTo;
      showToast(`从 ${Math.floor(seekTo / 60)}:${String(Math.floor(seekTo % 60)).padStart(2, '0')} 继续播放`);
    }
    pendingSeekRef.current = 0;
    if (compatMap[currentIndex]) releaseOnline();
    v.play().catch(() => {});
  };

  // 快捷键
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => {
      const v = videoRef.current;
      if (!v || e.target.closest('input, button, select, textarea, [contenteditable=true]')) return;
      const { currentIndex: ci, autoNext: an } = stateRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        v.paused ? v.play().catch(() => {}) : v.pause();
      } else if (e.key === 'ArrowRight') {
        v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        v.currentTime = Math.max(0, v.currentTime - 5);
      } else if (e.key === 'ArrowUp') {
        const p = findPrev(ci);
        if (p) {
          goToEpisode(p.vid_index);
        }
      } else if (e.key === 'ArrowDown') {
        const n = findNext(ci);
        if (n) goToEpisode(n.vid_index);
      } else if (e.key.toLowerCase() === 'a') {
        setAutoNext(!an);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, findNext, findPrev, goToEpisode]);

  const switchSeries = useCallback(
    async (sid, requestedIndex = 0) => {
      persistPosition(true);
      const version = ++selectionVersion.current;
      selectedSeriesRef.current = String(sid);
      pendingTargetRef.current = null;
      resetPlayback();
      setCompatMap({});
      setActiveSeriesId(String(sid));
      setDetail(null);
      setWaitingFor(null);
      setLoading(true);
      try {
        const d = await loadDetail(sid);
        if (!d || version !== selectionVersion.current) return;
        const saved = requestedIndex ? null : await window.electronAPI.getPlaybackPosition(sid);
        if (version !== selectionVersion.current) return;
        const wantedIndex = requestedIndex || saved?.vid_index;
        const selected =
          d.episodes.find((e) => e.vid_index === wantedIndex && !e.locked) || d.episodes.find((e) => !e.locked);
        setCurrentIndex(selected?.vid_index || 1);
        pendingSeekRef.current = selected?.vid_index === saved?.vid_index ? saved.currentTime || 0 : 0;
        if ((requestedIndex || saved) && selected && (selected.status !== 'completed' || !selected.fileUrl)) {
          pendingTargetRef.current = {
            seriesId: String(sid),
            vidIndex: selected.vid_index,
            seekTo: pendingSeekRef.current,
          };
        }
      } catch (e) {
        if (version === selectionVersion.current) showToast('加载剧集失败: ' + e.message);
      } finally {
        if (version === selectionVersion.current) setLoading(false);
      }
    },
    [persistPosition, resetPlayback, loadDetail, showToast],
  );

  // 初次进入与浏览点播共用一次载入，避免两个初始化请求互相覆盖。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await loadSeriesList();
        if (cancelled) return;
        const wanted = target?.seriesId && list.find((s) => String(s.series_id) === String(target.seriesId));
        const selected = wanted || [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
        if (selected) await switchSeries(selected.series_id, wanted ? target.vidIndex : 0);
        else setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          showToast('加载剧库失败: ' + e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target?.ts, loadSeriesList, switchSeries, showToast]);

  useEffect(() => {
    const pending = pendingTargetRef.current;
    if (
      loading ||
      !pending ||
      pending.seriesId !== String(activeSeriesId) ||
      String(detail?.series_id) !== pending.seriesId
    )
      return;
    pendingTargetRef.current = null;
    startOnlinePlay(pending.vidIndex, pending.seekTo);
  }, [loading, detail, activeSeriesId, startOnlinePlay]);

  // 从列表移除一部短剧（只取消登记，不删本地文件）
  const removeSeries = async (sid, title) => {
    const res = await window.electronAPI.removeSeries(sid);
    if (!res || !res.success) {
      showToast((res && res.error) || '移除失败');
      return;
    }
    showToast(`已从列表移除《${title}》（本地文件保留）`);
    const list = await loadSeriesList();
    refreshCacheInfo();
    if (String(sid) === String(activeSeriesId)) {
      const next = list[0];
      if (next) await switchSeries(next.series_id);
      else {
        selectionVersion.current++;
        selectedSeriesRef.current = '';
        resetPlayback();
        setActiveSeriesId('');
        setDetail(null);
      }
    }
  };

  const purgeEmpty = async () => {
    const res = await window.electronAPI.purgeEmptySeries();
    if (res && res.success) {
      showToast(res.count > 0 ? `已清理 ${res.count} 部未下载的剧` : '没有可清理的剧');
      const list = await loadSeriesList();
      refreshCacheInfo();
      if (!list.some((s) => String(s.series_id) === String(activeSeriesId))) {
        if (list[0]) await switchSeries(list[0].series_id);
        else {
          selectionVersion.current++;
          selectedSeriesRef.current = '';
          resetPlayback();
          setActiveSeriesId('');
          setDetail(null);
        }
      }
    }
  };

  const restoreDismissed = async () => {
    const res = await window.electronAPI.restoreDismissedSeries();
    if (res && res.success) {
      showToast(res.count > 0 ? `已恢复 ${res.count} 部被移除的剧` : '没有被移除的剧');
      await loadSeriesList();
      refreshCacheInfo();
    }
  };

  const clearCache = async () => {
    if (onlineRequestRef.current && !compatMap[currentIndex]) {
      stopPlayback('在线播放已停止，可重试本集继续观看');
    }
    try {
      const r = await window.electronAPI.clearOnlineCache();
      if (!r?.success) {
        showToast(r?.error || '清理播放缓存失败');
        return;
      }
      refreshCacheInfo();
      showToast('已清空在线播放缓存');
    } catch (e) {
      showToast('清理播放缓存失败: ' + e.message);
    }
  };

  const downloadEpisode = async (vidIndex) => {
    if (!episodes.some((ep) => ep.vid_index === vidIndex && !ep.locked)) return;
    const res = await window.electronAPI.downloadSingleEpisode(activeSeriesId, vidIndex);
    if (res && res.success) {
      showToast(res.count > 0 ? `第 ${vidIndex} 集已加入下载队列` : `第 ${vidIndex} 集已在队列中`);
      if (currentIndex === vidIndex) setWaitingFor(vidIndex);
    } else {
      showToast((res && res.error) || '加入下载失败');
    }
  };

  const downloadMissing = async () => {
    const missing = episodes.filter((e) => !e.locked && e.status !== 'completed');
    if (!missing.length) {
      showToast('可下载的集数已全部下载');
      return;
    }
    let ok = 0;
    for (const ep of missing) {
      const r = await window.electronAPI.downloadSingleEpisode(activeSeriesId, ep.vid_index);
      if (r && r.success) ok++;
    }
    showToast(`已把 ${ok} 集加入下载队列`);
  };

  // 一键合并当前这部剧（弹出格式选择）
  const mergeThisSeries = async (compatible) => {
    setMerging(true);
    setMergeAsk(false);
    try {
      const res = await window.electronAPI.mergeSeries(activeSeriesId, '', { compatible });
      if (!res || !res.success) {
        showToast((res && res.error) || '合并失败');
        return;
      }
      const tip = compatible
        ? `开始兼容格式合并 ${res.count} 集（H.264，耗时较长）`
        : `开始合并 ${res.count} 集，约 ${(res.totalBytes / 1073741824).toFixed(2)} GB`;
      showToast(`${tip}，在后台进行，完成后会提示`);
      if (res.codecWarning) showToast(res.codecWarning);
    } catch (e) {
      showToast('合并异常: ' + e.message);
    } finally {
      setMerging(false);
    }
  };

  useDialogKeyboard(
    active && !!(confirmAsk || mergeAsk),
    () => {
      setConfirmAsk(null);
      setMergeAsk(false);
    },
    '.player-confirm',
  );

  // ===== 渲染 =====
  if (loading) {
    return (
      <div className="player-container">
        <div className="player-empty">加载中…</div>
      </div>
    );
  }

  if (!seriesList.length) {
    return (
      <div className="player-container">
        <div className="player-header">
          <div className="player-title">
            <Play size={22} />
            <h2>我的剧库</h2>
          </div>
        </div>
        <div className="player-empty">
          <Film size={40} />
          <p>还没有可播放的短剧</p>
          <p className="player-empty-sub">先发现或搜索一部短剧，在这里选择集数、观看和管理。</p>
          <div className="player-empty-actions">
            {onNavigate && (
              <button className="btn btn-primary" onClick={() => onNavigate('browse')}>
                发现短剧
              </button>
            )}
            {onNavigate && (
              <button className="btn btn-outline" onClick={() => onNavigate('download')}>
                搜索剧集
              </button>
            )}
          </div>
          {dismissedCount > 0 && (
            <button className="btn btn-outline btn-sm" onClick={restoreDismissed}>
              恢复已移除的 {dismissedCount} 部
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="player-container">
      <div className="player-header">
        <div className="player-title">
          <Play size={22} />
          <h2>我的剧库</h2>
        </div>
        <div className="player-header-right">
          <span className="player-stat">
            已下载 {playableCount} / {episodes.length || 0} 集
          </span>
          <button
            aria-pressed={autoNext}
            className={`btn btn-outline ${autoNext ? 'btn-autonext-on' : ''}`}
            onClick={() => setAutoNext(!autoNext)}
            title="播完自动播放下一集（快捷键 A）"
          >
            <Layers size={15} />
            连播 {autoNext ? '开' : '关'}
          </button>
          <button
            aria-pressed={autoCompat}
            className={`btn btn-outline ${autoCompat ? 'btn-autonext-on' : ''}`}
            onClick={toggleAutoCompat}
            title="本机无法解码 HEVC 时自动转码为 H.264 播放（解决黑屏有声）"
          >
            <Zap size={15} />
            兼容模式 {autoCompat ? '开' : '关'}
          </button>
          <button
            aria-pressed={autoDelete}
            className={`btn btn-outline ${autoDelete ? 'btn-autonext-on' : ''}`}
            onClick={toggleAutoDelete}
            title="看完一集后自动删除该集的本地文件（边看边清，不占磁盘）"
          >
            <Trash2 size={15} />
            看完自动删 {autoDelete ? '开' : '关'}
          </button>
          <button className="btn btn-outline" onClick={downloadMissing}>
            <Download size={15} />
            下载未完成集
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setMergeAsk(true)}
            disabled={merging || playableCount === 0}
            title="把已下载的分集合并成单个 mp4，方便一次性看完"
          >
            <Layers size={15} />
            {merging ? '提交中...' : '合并导出全集'}
          </button>
        </div>
      </div>

      {/* 剧集选择：当前剧 + 下拉管理面板（替代原来会越堆越长的横条） */}
      <div className="player-series-row">
        <div className="player-series-current">
          <span className="player-series-label">正在播放</span>
          <span className="player-series-name" title={detail ? detail.series_title : ''}>
            {detail ? detail.series_title : '—'}
          </span>
        </div>
        <button
          aria-expanded={pickerOpen}
          className={`btn btn-outline series-picker-btn ${pickerOpen ? 'open' : ''}`}
          onClick={() => setPickerOpen((v) => !v)}
        >
          切换剧集
          <span className="series-count">{seriesList.length}</span>
          <ChevronDown size={15} />
        </button>
      </div>

      {pickerOpen && (
        <div className="series-picker">
          <div className="series-picker-head">
            <input
              type="text"
              className="input-field"
              aria-label="在我的剧库搜索"
              placeholder="搜索剧名…"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
            <button className="icon-btn" title="关闭" onClick={() => setPickerOpen(false)}>
              <X size={16} />
            </button>
          </div>

          <div className="series-picker-list">
            {seriesList.length === 0 && <div className="series-picker-empty">还没有剧集</div>}
            {seriesList
              .filter((s) => !pickerQuery.trim() || (s.series_title || '').includes(pickerQuery.trim()))
              .map((s) => {
                const isActive = String(s.series_id) === String(activeSeriesId);
                const dl = downloadedMap[String(s.series_id)];
                return (
                  <div
                    key={s.series_id}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择剧集 ${s.series_title}`}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || !['Enter', ' '].includes(e.key)) return;
                      e.preventDefault();
                      if (!isActive) switchSeries(s.series_id);
                      setPickerOpen(false);
                    }}
                    className={`series-row ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      if (!isActive) switchSeries(s.series_id);
                      setPickerOpen(false);
                    }}
                  >
                    <div className="series-row-cover">
                      {s.cover ? <img src={s.cover} alt="" loading="lazy" /> : <Film size={14} />}
                    </div>
                    <div className="series-row-body">
                      <div className="series-row-title">{s.series_title}</div>
                      <div className="series-row-sub">
                        {dl && dl.completed > 0
                          ? `已下载 ${dl.completed}/${dl.total} 集`
                          : `共 ${(s.episodes || []).length} 集 · 未下载`}
                      </div>
                    </div>
                    {isActive && <span className="series-row-cur">播放中</span>}
                    {(() => {
                      const st = storageMap[String(s.series_id)];
                      const hasFiles = st && st.files > 0;
                      return (
                        <>
                          {hasFiles && (
                            <button
                              className="icon-btn icon-btn-danger series-row-del"
                              title={`删除本地文件（${st.files} 个 · ${fmtSize(st.bytes)}）`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmAsk({
                                  title: '删除本地文件',
                                  message: `将删除《${s.series_title}》已下载的 ${st.files} 个文件，释放 ${fmtSize(st.bytes)}。\n剧集仍保留在列表中，之后可以随时在线播放或重新下载。`,
                                  okText: '删除文件',
                                  danger: true,
                                  onOk: async () => {
                                    if (
                                      String(s.series_id) === selectedSeriesRef.current &&
                                      !onlineUrl &&
                                      !compatMap[currentIndex]
                                    )
                                      stopPlayback('本地播放已停止，可重新连接片源观看');
                                    const r = await window.electronAPI.deleteSeriesFiles(s.series_id);
                                    if (r && r.success) {
                                      showToast(`已删除 ${r.count} 个文件，释放 ${fmtSize(r.freed)}`);
                                      await loadDetail(activeSeriesId);
                                      refreshCacheInfo();
                                    } else {
                                      showToast((r && r.error) || '删除失败');
                                    }
                                  },
                                });
                              }}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                          <button
                            className="icon-btn series-row-del"
                            title="从列表移除（不删除本地文件）"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSeries(s.series_id, s.series_title);
                            }}
                          >
                            <X size={15} />
                          </button>
                        </>
                      );
                    })()}
                  </div>
                );
              })}
          </div>

          <div className="series-picker-foot">
            {storageTotal.files > 0 && (
              <span className="series-picker-usage">
                本地已占用 <b>{fmtSize(storageTotal.bytes)}</b> / {storageTotal.files} 个文件
              </span>
            )}
            <button
              className="btn btn-outline btn-sm"
              onClick={purgeEmpty}
              title="把没有下载过任何一集的剧从列表中移除"
            >
              <Trash2 size={14} />
              清理未下载的剧
            </button>
            {dismissedCount > 0 && (
              <button className="btn btn-outline btn-sm" onClick={restoreDismissed}>
                恢复已移除 ({dismissedCount})
              </button>
            )}
            {storageTotal.files > 0 && (
              <button
                className="btn btn-outline btn-sm btn-danger-text"
                title="删除所有已下载的本地文件"
                onClick={() => {
                  setConfirmAsk({
                    title: '删除全部本地文件',
                    message: `将删除所有已下载的剧集文件，共 ${storageTotal.files} 个文件、${fmtSize(storageTotal.bytes)}。\n剧集列表与分集信息会保留，之后仍可在线播放或重新下载。`,
                    okText: '全部删除',
                    danger: true,
                    onOk: async () => {
                      if (current?.fileUrl && !onlineUrl && !compatMap[currentIndex])
                        stopPlayback('本地播放已停止，可重新连接片源观看');
                      const r = await window.electronAPI.deleteAllDownloaded();
                      if (r && r.success) {
                        showToast(`已删除 ${r.count} 个文件，释放 ${fmtSize(r.freed)}`);
                        await loadDetail(activeSeriesId);
                        refreshCacheInfo();
                      } else {
                        showToast((r && r.error) || '删除失败');
                      }
                    },
                  });
                }}
              >
                删除全部已下载
              </button>
            )}
            <button className="btn btn-outline btn-sm" onClick={clearCache} title="释放在线播放占用的内存">
              <Zap size={14} />
              清空播放缓存{cacheInfo.count > 0 ? ` (${cacheInfo.count})` : ''}
            </button>
            {compatCache.files > 0 && (
              <button className="btn btn-outline btn-sm" onClick={clearCompatCache} title="删除转码产生的兼容格式文件">
                <Trash2 size={14} />
                清空转码缓存 ({fmtSize(compatCache.bytes)})
              </button>
            )}
          </div>
        </div>
      )}

      {/* 播放区 */}
      <div className="player-stage">
        <video
          ref={videoRef}
          src={videoSrc || undefined}
          className="player-video"
          aria-busy={!canPlay || mediaBuffering}
          controls
          onLoadedMetadata={handleMetadata}
          onPlay={(event) => {
            if (!canPlay || playbackVersion !== mediaVersion.current) event.currentTarget.pause();
          }}
          onEnded={() => {
            if (
              canPlay &&
              playbackVersion === mediaVersion.current &&
              (!videoRef.current || loadedMediaRef.current?.version === mediaVersion.current)
            )
              handleEnded();
          }}
          onPause={() => persistPosition(true)}
          onPlaying={handlePlaying}
          onWaiting={() => {
            if (canPlay && playbackVersion === mediaVersion.current) setMediaBuffering(true);
          }}
          onCanPlay={() => {
            if (canPlay && playbackVersion === mediaVersion.current) setMediaBuffering(false);
          }}
          onError={(event) => {
            if (!canPlay || playbackVersion !== mediaVersion.current) return;
            if (videoRef.current && event.currentTarget !== videoRef.current) return;
            if (event.currentTarget.currentSrc && event.currentTarget.currentSrc !== videoSrc) return;
            const failedDecode = [3, 4].includes(event.currentTarget.error?.code);
            if (!failedDecode) {
              const seekTo = currentPosition();
              resetPlayback();
              pendingSeekRef.current = seekTo;
              setPlaybackError('视频加载失败，请重试本集或检查网络');
            }
            setMediaBuffering(false);
            setDecodeFailed(failedDecode);
            showToast(failedDecode ? '视频解码失败，可选择兼容播放' : '视频加载失败，请重试本集或检查网络');
            if (failedDecode && autoCompat && !compatUrl && autoCompatAttemptRef.current !== mediaVersion.current)
              startCompatPlay(currentIndex);
          }}
        />
        {!canPlay && (
          <div className="player-placeholder" style={{ position: 'absolute', inset: 0 }}>
            {playbackError ? (
              <>
                <Film size={34} />
                <p role="alert">{playbackError}</p>
                <div className="player-placeholder-actions">
                  <button className="btn btn-primary" onClick={retryPlayback}>
                    {current?.status === 'completed' ? '重试本集' : '重试本集（在线播放）'}
                  </button>
                  {current?.status === 'completed' && (
                    <button className="btn btn-outline" onClick={() => startOnlinePlay(currentIndex)}>
                      重新连接片源
                    </button>
                  )}
                </div>
              </>
            ) : onlineProgress && onlineProgress.vid && (!current || current.vid === onlineProgress.vid) ? (
              <>
                <RefreshCw size={30} className="spin" />
                <p>
                  {onlineProgress.phase === 'preparing'
                    ? '正在连接片源…'
                    : onlineProgress.phase === 'decrypting'
                      ? '正在准备播放…'
                      : '正在缓冲在线播放…'}
                </p>
                {onlineProgress.phase !== 'preparing' && (
                  <div className="player-wait-bar">
                    <div className="player-wait-fill" style={{ width: `${onlineProgress.percent || 0}%` }} />
                  </div>
                )}
                <span className="player-placeholder-sub">
                  {onlineProgress.phase === 'preparing' ? '获取可播放地址' : `${onlineProgress.percent || 0}%`}
                  {onlineProgress.total
                    ? ` · ${(onlineProgress.received / 1048576).toFixed(1)} / ${(onlineProgress.total / 1048576).toFixed(1)} MB`
                    : ''}
                  {' · 不写入下载目录'}
                </span>
                <button className="btn btn-outline" onClick={() => stopPlayback()}>
                  取消播放
                </button>
              </>
            ) : waitingFor != null ? (
              <>
                <RefreshCw size={30} className="spin" />
                <p>第 {waitingFor} 集正在下载，完成后自动播放…</p>
                {(() => {
                  const ep = episodes.find((e) => e.vid_index === waitingFor);
                  return ep && ep.status === 'downloading' ? (
                    <div className="player-wait-bar">
                      <div className="player-wait-fill" style={{ width: `${ep.progress || 0}%` }} />
                    </div>
                  ) : null;
                })()}
                <span className="player-placeholder-sub">也可以直接在线播放这一集</span>
              </>
            ) : current?.locked || (episodes.length > 0 && episodes.every((ep) => ep.locked)) ? (
              <>
                <Film size={34} />
                <p>需在来源平台解锁后观看</p>
                <span className="player-placeholder-sub">本应用不提供解锁</span>
              </>
            ) : current ? (
              <>
                <Film size={34} />
                <p>
                  第 {current.vid_index} 集
                  {current.status === 'downloading' ? '正在下载' : current.status === 'pending' ? '排队中' : '尚未下载'}
                </p>
                {current.status === 'downloading' && (
                  <div className="player-wait-bar">
                    <div className="player-wait-fill" style={{ width: `${current.progress || 0}%` }} />
                  </div>
                )}
                <div className="player-placeholder-actions">
                  <button className="btn btn-primary" onClick={() => startOnlinePlay(current.vid_index)}>
                    <Play size={15} />
                    在线播放（不下载）
                  </button>
                  <button className="btn btn-outline" onClick={() => downloadEpisode(current.vid_index)}>
                    <Download size={15} />
                    下载本集
                  </button>
                </div>
                <span className="player-placeholder-sub">在线播放不保存到下载目录，准备产生的临时文件会自动清理</span>
              </>
            ) : (
              <>
                <Film size={34} />
                <p>请选择一集开始播放</p>
              </>
            )}
          </div>
        )}

        {canPlay && mediaBuffering && !compatProgress && (
          <div className="compat-overlay" role="status">
            <RefreshCw size={26} className="spin" />
            <p>正在加载视频…</p>
            <button className="btn btn-outline" onClick={() => stopPlayback()}>
              取消播放
            </button>
          </div>
        )}

        {/* 兼容模式浮层：解码失败提示 / 转码进度 */}
        {compatProgress && compatProgress.vidIndex === currentIndex && (
          <div className="compat-overlay">
            <RefreshCw size={26} className="spin" />
            <p>正在转码为兼容格式（H.264）…</p>
            <div className="player-wait-bar">
              <div className="player-wait-fill" style={{ width: `${compatProgress.percent || 0}%` }} />
            </div>
            <span className="compat-overlay-sub">
              {compatProgress.percent || 0}% · 正在处理当前视频，完成后切换到兼容片源
            </span>
            <button className="btn btn-outline" onClick={() => stopPlayback('转码已取消，可重试本集继续观看')}>
              取消转码
            </button>
          </div>
        )}

        {!compatProgress && decodeFailed && canPlay && (
          <div className="compat-overlay">
            <Film size={30} />
            <p>当前片源无法正常解码</p>
            <span className="compat-overlay-sub">可以重新连接片源，或尝试转码为 H.264 兼容格式。</span>
            <div className="player-placeholder-actions">
              <button className="btn btn-primary" onClick={retryPlayback}>
                重试本集
              </button>
              <button className="btn btn-outline" onClick={() => startOnlinePlay(currentIndex)}>
                重新连接片源
              </button>
              {!compatUrl && (
                <button className="btn btn-outline" onClick={() => startCompatPlay(currentIndex)}>
                  <Zap size={15} />
                  转码后播放
                </button>
              )}
              <button className="btn btn-outline" onClick={toggleAutoCompat}>
                {autoCompat ? '关闭自动转码' : '开启自动转码'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 播放中的集信息 */}
      {current && (
        <div className="player-now">
          <span className="player-now-title">
            《{detail ? detail.series_title : ''}》第 {current.vid_index} 集
          </span>
          {current.title && <span className="player-now-sub">{current.title}</span>}
          <span className={`player-now-status status-${current.status}`}>
            {current.locked
              ? '锁定'
              : current.status === 'completed'
                ? '可播放'
                : current.status === 'downloading'
                  ? `下载中 ${current.progress || 0}%`
                  : current.status === 'pending'
                    ? '排队中'
                    : '未下载'}
          </span>
        </div>
      )}

      {detail?.web_accessible_episodes != null && detail.web_accessible_episodes < detail.total && (
        <p className="player-tips">网页源提供前 {detail.web_accessible_episodes} 集，后续集数自动尝试 App 片源。</p>
      )}

      {episodes.some((ep) => ep.locked) && (
        <p className="player-tips">锁定集需在来源平台解锁，本应用不提供解锁；连播会跳过锁定集。</p>
      )}

      {/* 分集列表 */}
      <div className="player-episodes">
        {episodes.map((ep) => {
          const isCurrent = ep.vid_index === currentIndex;
          return (
            <button
              key={ep.vid_index}
              disabled={ep.locked === true}
              aria-label={`第 ${ep.vid_index} 集`}
              aria-pressed={isCurrent}
              className={`ep-chip ep-${ep.status} ${isCurrent ? 'ep-current' : ''}`}
              onClick={() => goToEpisode(ep.vid_index)}
              title={
                ep.locked
                  ? '需在来源平台解锁'
                  : ep.status === 'completed'
                    ? '点击播放（本地）'
                    : ep.status === 'downloading' || ep.status === 'pending'
                      ? '下载继续，点击在线播放'
                      : '点击在线播放（不下载）· 双击加入下载'
              }
              onDoubleClick={() => ep.status !== 'completed' && downloadEpisode(ep.vid_index)}
            >
              <span className="ep-num">{ep.vid_index}</span>
              {ep.locked && <span className="ep-lock-label">锁定</span>}
              {ep.status === 'completed' && <Check size={11} className="ep-badge" />}
              {ep.status === 'downloading' && (
                <span className="ep-progress" style={{ width: `${ep.progress || 0}%` }} />
              )}
              {onlineVid === ep.vid && <span className="ep-online-dot" />}
            </button>
          );
        })}
      </div>

      <div className="player-tips">
        快捷键：空格 播放/暂停 · ← → 快退/快进 5 秒 · ↑ ↓ 上一集/下一集 · A 切换连播。
        <br />
        <b>未锁定的灰色分集点一下即可在线播放</b>（不保存到下载目录）；双击才加入下载队列。
        连播时遇到未下载的集会自动转在线播放。
      </div>

      {toast && (
        <div className="dm-toast dm-toast-success" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}

      {/* 合并格式选择 */}
      {mergeAsk && (
        <div className="player-confirm-mask" onClick={() => setMergeAsk(false)}>
          <div
            className="player-confirm"
            role="dialog"
            aria-modal="true"
            aria-label={confirmAsk ? confirmAsk.title : '合并导出'}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="player-confirm-title" style={{ color: 'var(--accent)' }}>
              <Layers size={17} />
              合并导出全集
            </div>
            <div className="player-confirm-msg">
              <p>
                把《{detail ? detail.series_title : ''}》已下载的 {playableCount} 集合并为一个 mp4。
              </p>
              <p>
                <b>快速合并</b>：保留原画质与编码，处理较快；部分设备可能不支持播放。
              </p>
              <p>
                <b>兼容合并</b>：转换为兼容性更好的 H.264 格式，处理时间较长。
              </p>
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setMergeAsk(false)}>
                取消
              </button>
              <button className="btn btn-outline" onClick={() => mergeThisSeries(true)} disabled={merging}>
                兼容合并（H.264）
              </button>
              <button className="btn btn-primary" onClick={() => mergeThisSeries(false)} disabled={merging}>
                快速合并
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {confirmAsk && (
        <div className="player-confirm-mask" onClick={() => setConfirmAsk(null)}>
          <div
            className="player-confirm"
            role="dialog"
            aria-modal="true"
            aria-label={confirmAsk ? confirmAsk.title : '合并导出'}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {confirmAsk.title}
            </div>
            <div className="player-confirm-msg">
              {String(confirmAsk.message)
                .split('\n')
                .map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setConfirmAsk(null)}>
                取消
              </button>
              <button
                className={`btn ${confirmAsk.danger ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={async () => {
                  const fn = confirmAsk.onOk;
                  setConfirmAsk(null);
                  await fn();
                }}
              >
                {confirmAsk.okText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Player;
