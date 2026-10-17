'use strict';
// 管理剧集的「处理日志」和「总任务」：
//  - 日志按剧文件夹记录，保存在应用数据目录里，切换页面、重启应用后还在。
//  - 总任务把处理队列、下载任务、补下载任务按剧汇总成一张表。
// 这里只放不依赖 Electron 的逻辑，方便单独测试。
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = new Set(['info', 'ok', 'warn', 'error']);

function dirKey(dir) {
  const resolved = path.resolve(String(dir || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 每部剧最多保留 perDir 条日志，最多记 maxDirs 部剧；写盘做了合并，不会每条都写一次。 */
function createActivityLog({ file, perDir = 300, maxDirs = 100, now = Date.now, flushMs = 600 } = {}) {
  let data = null;
  let timer = null;

  const load = () => {
    if (data) return data;
    data = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, entry] of Object.entries(saved.dirs || {})) {
        if (Array.isArray(entry.lines)) data.set(key, { dir: entry.dir || key, lines: entry.lines.slice(-perDir) });
      }
    } catch (_) {
      /* 没有或损坏的日志文件当作没有日志。 */
    }
    return data;
  };

  const write = () => {
    timer = null;
    if (!file || !data) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ dirs: Object.fromEntries(data) }));
      fs.renameSync(tmp, file);
    } catch (_) {
      /* 日志存不下不影响处理本身。 */
    }
  };
  const schedule = () => {
    if (timer || !file) return;
    timer = setTimeout(write, flushMs);
    timer.unref?.();
  };

  return {
    add(dir, level, text) {
      if (!dir || !text) return null;
      const map = load();
      const key = dirKey(dir);
      const entry = map.get(key) || { dir: path.resolve(String(dir)), lines: [] };
      const line = { t: now(), level: LEVELS.has(level) ? level : 'info', text: String(text).slice(0, 600) };
      entry.lines.push(line);
      if (entry.lines.length > perDir) entry.lines.splice(0, entry.lines.length - perDir);
      map.delete(key);
      map.set(key, entry); // 最近写过的排在后面
      while (map.size > maxDirs) map.delete(map.keys().next().value);
      schedule();
      return line;
    },
    list(dir, limit = 200) {
      const entry = load().get(dirKey(dir));
      return entry ? entry.lines.slice(-Math.max(1, limit)) : [];
    },
    clear(dir) {
      load().delete(dirKey(dir));
      schedule();
    },
    flush() {
      if (timer) clearTimeout(timer);
      write();
    },
  };
}

const ACTIVE_BATCH = new Set(['running', 'queued']);

/** 一部剧的处理批次汇总：有在跑/排队的就汇总它们，否则看最近一批的结果。 */
function summarizeProcessing(batches) {
  const mine = [...batches].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!mine.length) return null;
  const active = mine.filter((batch) => ACTIVE_BATCH.has(batch.status));
  const used = active.length ? active : [mine[0]];
  const tasks = used.flatMap((batch) => batch.tasks || []);
  const count = (status) => tasks.filter((task) => task.status === status).length;
  const running = count('running');
  const queued = count('pending') + count('queued');
  const done = count('completed');
  const failed = count('failed');
  const stopped = count('stopped');
  const progress = tasks.length
    ? Math.floor(tasks.reduce((sum, task) => sum + Number(task.progress || 0), 0) / tasks.length)
    : 0;
  const state = active.length
    ? running > 0
      ? 'running'
      : 'queued'
    : failed > 0
      ? 'failed'
      : stopped > 0
        ? 'stopped'
        : 'completed';
  return {
    state,
    total: tasks.length,
    done,
    running,
    queued,
    failed,
    stopped,
    progress,
    batchId: used[0].id,
    endTime: active.length ? null : used[0].endTime || null,
    updatedAt: Math.max(...used.map((batch) => batch.endTime || batch.startedAt || batch.createdAt || 0)),
  };
}

/**
 * 总任务：每部有动静的剧一行。
 * folders: [{ name, path, seriesId }]；batches: 处理批次快照（带 libraryDir）；downloads: 下载任务；
 * jobs: 补下载后自动处理的任务；planning: Map(dir -> { done, total })。
 */
function buildOverview({ folders, batches, downloads, jobs = [], planning = new Map() }) {
  const byDir = new Map();
  const itemFor = (folder) => {
    const key = dirKey(folder.path);
    if (!byDir.has(key)) {
      byDir.set(key, {
        dir: folder.path,
        name: folder.name,
        seriesId: folder.seriesId || '',
        processing: null,
        planning: null,
        job: null,
        downloads: { active: 0, pending: 0, failed: 0, stopped: 0 },
        updatedAt: 0,
      });
    }
    return byDir.get(key);
  };
  const folderByDir = new Map(folders.map((folder) => [dirKey(folder.path), folder]));
  const folderBySeries = new Map(folders.filter((folder) => folder.seriesId).map((f) => [String(f.seriesId), f]));

  const grouped = new Map();
  for (const batch of batches) {
    if (!batch.libraryDir) continue;
    const key = dirKey(batch.libraryDir);
    if (!folderByDir.has(key)) continue;
    (grouped.get(key) || grouped.set(key, []).get(key)).push(batch);
  }
  for (const [key, list] of grouped) {
    const item = itemFor(folderByDir.get(key));
    item.processing = summarizeProcessing(list);
    item.updatedAt = Math.max(item.updatedAt, item.processing?.updatedAt || 0);
  }
  for (const [key, progress] of planning) {
    const folder = folderByDir.get(dirKey(key));
    if (folder) itemFor(folder).planning = { done: progress.done || 0, total: progress.total || 0 };
  }
  for (const job of jobs) {
    const folder = folderByDir.get(dirKey(job.dir));
    if (!folder || !['waiting', 'starting', 'failed'].includes(job.status)) continue;
    const item = itemFor(folder);
    item.job = { id: job.id, status: job.status, message: job.message };
    item.updatedAt = Math.max(item.updatedAt, job.updatedAt || 0);
  }
  for (const task of downloads) {
    const folder = folderBySeries.get(String(task.hongguoInfo?.series_id ?? ''));
    if (!folder) continue;
    const bucket =
      task.status === 'downloading'
        ? 'active'
        : task.status === 'pending'
          ? 'pending'
          : task.status === 'failed'
            ? 'failed'
            : task.status === 'stopped'
              ? 'stopped'
              : null;
    if (!bucket) continue;
    const item = itemFor(folder);
    item.downloads[bucket] += 1;
    item.updatedAt = Math.max(item.updatedAt, Number(task.endTime || task.startTime || 0) || 0);
  }

  const rank = (item) => {
    const p = item.processing?.state;
    if (item.planning || p === 'running' || item.downloads.active || item.job?.status === 'starting') return 0;
    if (p === 'queued' || item.downloads.pending || item.job?.status === 'waiting') return 1;
    if (p === 'failed' || item.downloads.failed || item.job?.status === 'failed') return 2;
    if (p === 'stopped' || item.downloads.stopped) return 3;
    return 4;
  };
  const items = [...byDir.values()].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);

  const totals = {
    processingRunning: 0,
    processingQueued: 0,
    processingFailed: 0,
    downloadActive: 0,
    downloadFailed: 0,
  };
  for (const item of items) {
    totals.processingRunning += item.processing?.state === 'running' ? item.processing.running : 0;
    totals.processingQueued += ['running', 'queued'].includes(item.processing?.state) ? item.processing.queued : 0;
    totals.processingFailed += item.processing?.state === 'failed' ? item.processing.failed : 0;
    totals.downloadActive += item.downloads.active + item.downloads.pending;
    totals.downloadFailed += item.downloads.failed;
  }
  totals.busy = items.filter((item) => rank(item) <= 1).length;
  return { totals, items };
}

/** 从处理任务里认出这一集由哪些原集拼成：[3, 4]。 */
function sourceEpisodes(task, parseEpisodeIndex) {
  const files = task.segments ? task.segments.map((segment) => segment.src) : [task.src];
  const numbers = files
    .map((file) => parseEpisodeIndex(path.basename(String(file || ''))))
    .filter((value) => Number.isFinite(value));
  return [...new Set(numbers)];
}

module.exports = { createActivityLog, summarizeProcessing, buildOverview, sourceEpisodes, dirKey };
