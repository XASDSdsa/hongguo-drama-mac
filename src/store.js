/**
 * store.js - 精简持久化模块
 * 用单个 JSON 文件保存设置、下载任务和视频处理快照，替代原项目里的 sql.js 数据库 + electron-store，
 * 减少依赖，方便独立打包。
 */
const fs = require('fs');
const path = require('path');

let dataFile = null;
let cache = null; // { settings, tasks }
let durable = '{}';
let errorHandler = null;

function loadCache() {
  if (!dataFile) throw new Error('store 未初始化');
  if (cache) return cache;
  try {
    if (fs.existsSync(dataFile)) {
      cache = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
  } catch (e) {
    console.error('[Store] 读取数据文件失败，使用空数据:', e.message);
  }
  if (!cache || typeof cache !== 'object') cache = {};
  if (!Array.isArray(cache.tasks)) cache.tasks = [];
  if (!Array.isArray(cache.quchongTasks)) cache.quchongTasks = [];
  if (!cache.settings || typeof cache.settings !== 'object') cache.settings = {};
  durable = JSON.stringify(cache);
  return cache;
}

// Windows 上杀毒软件/索引服务会在文件刚写完时短暂占用它，这时改名会报 EPERM/EBUSY/EACCES。
// 稍等一下再试几次，别让一次瞬间占用变成「保存失败」。
function renameWithRetry(from, to) {
  const waits = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= waits.length || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[attempt]);
    }
  }
}

let deferredTimer = null;
const DEFERRED_FLUSH_MS = 1500;

function flush() {
  if (!dataFile) return;
  if (deferredTimer) {
    clearTimeout(deferredTimer);
    deferredTimer = null;
  }
  const temporary = dataFile + '.tmp';
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    // 不缩进：文件小一半、序列化快一倍（这份数据只给程序读）。
    const serialized = JSON.stringify(cache || {});
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(temporary, dataFile);
    durable = serialized;
  } catch (e) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    cache = JSON.parse(durable);
    try {
      errorHandler?.({ error: '保存失败，请检查磁盘空间或目录权限；本次变更未能保存。' });
    } catch {}
    throw e;
  }
}

function init(filePath) {
  dataFile = filePath;
  cache = null;
  loadCache();
}

function getSettings() {
  return loadCache().settings;
}

function saveSettings(settings) {
  loadCache().settings = settings || {};
  flush();
}

function getTasks() {
  return loadCache().tasks;
}

function saveTasks(tasks) {
  loadCache().tasks = tasks || [];
  flush();
}

// ===== 视频处理任务快照 =====
// 与下载任务分开保存，避免处理进度覆盖下载状态；调用方只在阶段变化时保存。
function getQuchongTasks() {
  const c = loadCache();
  if (!Array.isArray(c.quchongTasks)) c.quchongTasks = [];
  return c.quchongTasks;
}

// 去重每一集要经过好几个阶段，每个阶段都整份重写数据文件会拖慢主进程、反复写盘；
// 合并成最多每 1.5 秒写一次。退出前 flushPending 会把没写的落盘；万一崩溃，重启时进行中的任务本来就按「中断」处理。
function saveQuchongTasks(tasks) {
  loadCache().quchongTasks = tasks || [];
  scheduleFlush();
}

// ===== 短剧档案（让播放页在没有下载任务时也能列出完整分集）=====
function getSeries() {
  const c = loadCache();
  if (!Array.isArray(c.series)) c.series = [];
  return c.series;
}

function saveSeries(list) {
  loadCache().series = list || [];
  flush();
}

// ===== 播放进度（断点续播）=====
function getPlayback() {
  const c = loadCache();
  if (!c.playback || typeof c.playback !== 'object') c.playback = {};
  return c.playback;
}

// 播放进度每几秒就会变化；整份数据同步序列化会阻塞主进程，所以合并写入。
// 其他保存、退出前的 flushPending 都会把待写内容一并落盘。
function savePlayback(map) {
  loadCache().playback = map || {};
  scheduleFlush();
}

function scheduleFlush() {
  if (deferredTimer) return;
  deferredTimer = setTimeout(() => {
    deferredTimer = null;
    try {
      flush();
    } catch (_) {
      /* flush 已通过 errorHandler 报告 */
    }
  }, DEFERRED_FLUSH_MS);
  deferredTimer.unref?.();
}

function flushPending() {
  if (deferredTimer) flush();
}

// ===== 合并任务记录 =====
function getMergeTasks() {
  const c = loadCache();
  if (!Array.isArray(c.mergeTasks)) c.mergeTasks = [];
  return c.mergeTasks;
}

function saveMergeTasks(list) {
  loadCache().mergeTasks = list || [];
  flush();
}

function getStructureProjects() {
  const c = loadCache();
  if (!c.structureProjects || typeof c.structureProjects !== 'object') c.structureProjects = {};
  return c.structureProjects;
}
function saveStructureProject(projectId, record) {
  getStructureProjects()[String(projectId)] = { ...record, updatedAt: Date.now() };
  flush();
}

function removeStructureProject(projectId) {
  delete getStructureProjects()[String(projectId)];
  flush();
}

module.exports = {
  renameWithRetry,
  setErrorHandler: (handler) => {
    errorHandler = handler;
  },
  init,
  getSettings,
  saveSettings,
  getTasks,
  saveTasks,
  getQuchongTasks,
  saveQuchongTasks,
  getSeries,
  saveSeries,
  getPlayback,
  savePlayback,
  flushPending,
  getMergeTasks,
  saveMergeTasks,
  getStructureProjects,
  saveStructureProject,
  removeStructureProject,
};
