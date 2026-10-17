import { useCallback, useEffect, useRef, useState } from 'react';

// 这些事件一来就重新读一次后台状态；处理进度的数字变化太密，改用定时读取。
const EVENTS = [
  'onLibraryActivity',
  'onQuchongTask',
  'onQuchongComplete',
  'onLibraryJobUpdate',
  'onLibraryPlanProgress',
  'onDownloadTaskAdded',
  'onDownloadCompleted',
  'onDownloadFailed',
  'onDownloadStopped',
  'onDownloadQueueChanged',
];

function subscribeAll(callback) {
  const api = window.electronAPI || {};
  return EVENTS.map((name) => api[name]?.(callback)).filter(Boolean);
}

/**
 * 读取主进程里保存的状态（处理进度、日志、总任务）。状态都在主进程，
 * 所以页面切走再回来、关掉重开应用，读到的都是同一份。
 * 有任务在跑时每秒刷新一次，事件到来时马上刷新。
 */
export default function useLiveData({ load, isBusy, active = true, watch = '' }) {
  const [data, setData] = useState(null);
  const loadRef = useRef(load);
  const busyRef = useRef(isBusy);
  const isBusyNow = useRef(false);
  const timer = useRef(null);
  const alive = useRef(true);
  loadRef.current = load;
  busyRef.current = isBusy;

  const refresh = useCallback(async () => {
    const result = await loadRef.current();
    if (!alive.current || !result) return;
    isBusyNow.current = !!busyRef.current?.(result);
    setData(result);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!active) return undefined;
    refresh();
    const soon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 250);
    };
    const offs = subscribeAll(soon);
    const poll = setInterval(() => {
      if (isBusyNow.current) refresh();
    }, 1000);
    return () => {
      alive.current = false;
      offs.forEach((off) => off?.());
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [active, refresh, watch]);

  return [data, refresh];
}
