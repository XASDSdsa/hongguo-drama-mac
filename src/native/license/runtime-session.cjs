'use strict';

const HEARTBEAT_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const GRACE_MS = 15 * 60_000;
const FRESH_MS = 60_000;

// Runtime-only lease. Restarting always requires a new online verification.
function createRuntimeSession({ verify, now = Date.now, monotonic = () => performance.now(),
  schedule = setTimeout, unschedule = clearTimeout, onChange = () => {} }) {
  let expiresAt = 0, deadline = 0, lastVerified = -Infinity, retryAt = 0;
  let lastAttempt = -Infinity;
  let error = '请先完成联网授权。', revoked = true, pending = null, timer = null, disposed = false;
  function snapshot() {
    const allowed = !disposed && !revoked && now() < expiresAt && monotonic() < deadline;
    return { allowed, error: allowed ? '' : error || '授权验证已过期，请联网重新验证。',
      warning: allowed ? error : '', expiresAt };
  }
  function arm(delay) {
    if (timer) unschedule(timer);
    if (disposed) return;
    // Also check at the expiry boundary, including while the network request is pending.
    timer = schedule(() => { onChange(snapshot()); void refresh(); }, Math.max(1, delay));
    timer?.unref?.();
  }
  function refresh() {
    if (disposed) return Promise.resolve(snapshot());
    if (pending) return pending;
    lastAttempt = monotonic();
    pending = (async () => {
      let result;
      try { result = await verify(); }
      catch { result = { ok: false, retryable: true, error: '暂时连不上授权服务器，请检查网络后重试。' }; }
      if (disposed) return snapshot();
      if (result.ok && Number.isFinite(result.expiresAt) && result.expiresAt > now()) {
        expiresAt = result.expiresAt;
        lastVerified = monotonic();
        deadline = lastVerified + Math.min(GRACE_MS, expiresAt - now());
        revoked = false;
        error = '';
      } else {
        error = result.error || '授权签名无效，请重新验证。';
        if (!result.retryable) revoked = true;
      }
      retryAt = monotonic() + (error ? RETRY_MS : FRESH_MS);
      const state = snapshot();
      onChange(state);
      const remaining = Math.min(expiresAt - now(), deadline - monotonic());
      arm(state.allowed ? Math.min(error ? RETRY_MS : HEARTBEAT_MS, remaining) : RETRY_MS);
      return state;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function ensure({ force = false } = {}) {
    if ((force && monotonic() - lastAttempt >= 5000) ||
      (monotonic() >= retryAt && (monotonic() - lastVerified >= FRESH_MS || !snapshot().allowed))) await refresh();
    return snapshot();
  }
  function dispose() { disposed = true; if (timer) unschedule(timer); }
  return { refresh, ensure, snapshot, dispose };
}

module.exports = { createRuntimeSession, HEARTBEAT_MS, RETRY_MS, GRACE_MS, FRESH_MS };
