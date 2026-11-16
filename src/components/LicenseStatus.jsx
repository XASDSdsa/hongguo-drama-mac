import React, { useEffect, useState } from 'react';

export default function LicenseStatus() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    let received = false;
    const update = value => { received = true; if (alive) setState(value); };
    const off = window.electronAPI.onLicenseState?.(update);
    window.electronAPI.licenseStatus?.().then(value => { if (!received && alive) setState(value); }).catch(() => {});
    return () => { alive = false; off?.(); };
  }, []);
  if (!state || (state.allowed && !state.warning)) return null;
  const retry = async () => {
    setBusy(true);
    try { setState(await window.electronAPI.licenseRetry()); }
    catch { setState({ allowed: false, error: '无法验证授权，请稍后重试。' }); }
    finally { setBusy(false); }
  };
  return <div className="app-storage-error" role="alert">
    <span>{state.warning || state.error} {!state.allowed && '已暂停启动新任务，已有任务可继续完成。'}</span>
    <button className="btn btn-outline btn-sm" onClick={retry} disabled={busy}>{busy ? '正在验证…' : '重新验证'}</button>
  </div>;
}
