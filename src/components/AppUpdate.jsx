import React, { useEffect, useRef, useState } from 'react';
import './AppUpdate.css';

export default function AppUpdate() {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const operation = useRef(false);
  useEffect(() => {
    let alive = true;
    let events = 0;
    const off = window.electronAPI.onAppUpdate?.(value => { events++; if (alive) setState(value); });
    window.electronAPI.appUpdateStatus?.().then(value => { if (alive && !events) setState(value); }).catch(() => {});
    return () => { alive = false; off?.(); };
  }, []);
  if (!state || state.status === 'unsupported') return null;
  const running = working || ['checking', 'downloading', 'installing'].includes(state.status);
  const ready = state.status === 'ready';
  const available = !!state.version && ['available', 'error'].includes(state.status);
  const invoke = async () => {
    if (operation.current || running) return;
    operation.current = true;
    setWorking(true);
    setError('');
    try {
      const method = ready ? 'appUpdateInstall' : available ? 'appUpdateDownload' : 'appUpdateCheck';
      const result = await window.electronAPI[method]();
      if (result?.state) setState(result.state);
      if (!result?.success) setError(result?.error || '更新失败，请重试');
    } catch (e) { setError(e?.message || '更新失败，请重试'); }
    finally { operation.current = false; setWorking(false); }
  };
  const labels = { checking: '正在检查更新…', downloading: `正在下载 ${Math.round(state.percent || 0)}%`, ready: `v${state.version} 已就绪`, installing: '正在重启更新…', available: `发现 v${state.version}`, current: '已是最新版本', idle: '软件更新', error: state.version ? `v${state.version} 更新失败` : '更新检查失败' };
  return <section className="app-update" aria-label="软件更新">
    <div aria-live="polite">{labels[state.status] || '软件更新'}</div>
    {state.notes && <p className="app-update-notes">{state.notes}</p>}
    {state.status === 'downloading' && <progress value={state.percent || 0} max="100" aria-label="更新下载进度" />}
    {(error || state.error) && <p className="app-update-error" role="alert">{error || state.error}</p>}
    <button className="btn btn-sm btn-outline" onClick={invoke} disabled={running}>
      {running ? '请稍候…' : ready ? '重启并更新' : available ? '下载更新' : '检查更新'}
    </button>
  </section>;
}
