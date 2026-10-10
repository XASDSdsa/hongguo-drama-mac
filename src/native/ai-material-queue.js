const { randomUUID } = require('node:crypto');

const ACTIVE = new Set(['queued', 'running']);
const keyOf = task => `${task.kind}:${task.seriesId}:${task.episodeIndex || 0}`;
const abortError = () => new Error('任务已取消');

/** Only scheduling lives here. Persistence always resolves the latest series object. */
function createAiMaterialQueue({ list, save, execute, notify, concurrency, redact = error => error?.message || String(error) }) {
  const active = new Map();
  const admitted = new Set();
  let scheduled = false;
  const emit = task => { try { notify({ ...task }); } catch (_) {} };
  const persist = task => { save({ ...task }); emit(task); };
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  }
  function enqueue(input, existing = null) {
    const duplicate = list().find(task => keyOf(task) === keyOf(input) && ACTIVE.has(task.status));
    if (duplicate) return { task: { ...duplicate }, duplicate: true };
    const now = Date.now();
    const task = { ...(existing || {}), ...input, id: existing?.id || randomUUID(), status: 'queued', stage: input.stage || 'queued', progress: 0, createdAt: existing?.createdAt || now, updatedAt: now, completedAt: null, error: '' };
    persist(task); // A failed save never admits a paid task.
    admitted.add(task.id);
    schedule();
    return { task, duplicate: false };
  }
  async function run(task, controller) {
    let heartbeat;
    try {
      task.status = 'running'; task.startedAt = Date.now(); task.updatedAt = task.startedAt;
      persist(task);
      heartbeat = setInterval(() => emit({ ...task, elapsedSeconds: Math.floor((Date.now() - task.startedAt) / 1000) }), 1000);
      const update = patch => {
        if (controller.signal.aborted) throw abortError();
        Object.assign(task, patch, { updatedAt: Date.now() });
        persist(task);
      };
      const result = await execute(task, { signal: controller.signal, update });
      if (controller.signal.aborted) throw abortError();
      Object.assign(task, result, { status: 'completed', stage: 'completed', progress: 100, completedAt: Date.now(), updatedAt: Date.now(), error: '' });
      persist(task);
    } catch (error) {
      task.status = controller.signal.aborted ? 'stopped' : 'failed';
      task.error = controller.signal.aborted ? '任务已取消' : redact(error);
      task.updatedAt = Date.now(); task.completedAt = null;
      try { persist(task); } catch (_) { emit({ ...task, storageWarning: '任务状态保存失败，请检查磁盘空间或目录权限' }); }
    } finally {
      clearInterval(heartbeat);
      admitted.delete(task.id);
      active.delete(task.id);
      schedule();
    }
  }
  function pump() {
    const limit = Math.max(1, Math.min(4, Number(concurrency()) || 2));
    for (const task of list()) {
      if (active.size >= limit) break;
      if (!admitted.has(task.id) || task.status !== 'queued' || active.has(task.id)) continue;
      const controller = new AbortController();
      active.set(task.id, { task, controller });
      void run({ ...task }, controller);
    }
  }
  function cancel(id) {
    const task = list().find(item => item.id === id);
    if (!task) return { success: false, error: '任务不存在' };
    if (!ACTIVE.has(task.status)) return { success: false, error: '任务已结束' };
    const running = active.get(id);
    if (running) {
      running.controller.abort();
      emit({ ...task, cancelling: true, updatedAt: Date.now() });
    } else {
      persist({ ...task, status: 'stopped', error: '任务已取消', updatedAt: Date.now() });
      admitted.delete(id);
    }
    return { success: true };
  }
  return { enqueue, cancel, pump: schedule, active, stopAll() { for (const id of [...admitted]) cancel(id); } };
}

module.exports = { createAiMaterialQueue, keyOf };
