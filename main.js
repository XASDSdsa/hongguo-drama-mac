/**
 * main.js - 红果短剧下载器（独立版）主进程
 *
 * 功能：
 *   1. 红果短剧解析（分享链接 / series_id -> 全剧集列表）
 *   2. 批量提交下载任务到下载队列
 *   3. 并发下载：流式下载播放直链 -> spade_a 派生 AES Key -> CENC-AES-CTR 解密 -> 输出 mp4
 *   4. 下载管理：进度推送、暂停/取消、重试、删除、打开所在文件夹
 *   5. 设置：下载目录、命名规则、并发数（JSON 文件持久化）
 */
const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, Menu } = require('electron');
const path = require('path');
const os = require('node:os');
const fs = require('fs');
const fsp = require('fs/promises');
const axios = require('axios');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID, createHash } = require('node:crypto');

const hongguo = require('./src/native/hongguo');
const { decryptInWorker } = require('./src/native/decrypt-worker.cjs');
const quchong = require('./src/native/quchong');
const openai = require('./src/native/openai');
const seriesInfo = require('./src/native/series-info');
const seriesLibrary = require('./src/native/series-library');
const resplit = require('./src/native/resplit');
const seriesGaps = require('./src/native/series-gaps');
const downloadErrors = require('./src/native/download-errors');
const libraryActivity = require('./src/native/library-activity');
const publishMaterials = require('./src/native/publish-materials');
const posterTitle = require('./src/native/poster-title');
const posterStyles = require('./src/native/poster-styles');
const whisper = require('./src/native/whisper');
const fasterWhisper = require('./src/native/faster-whisper');
const { createTranscriptionManager, isCompleted: isSubtitleCompleted } = require('./src/native/transcription-manager');
const { createAnalysisManager } = require('./src/native/analysis-manager');
const { createAiMaterialQueue } = require('./src/native/ai-material-queue');
const { createVideoStructurePipeline } = require('./src/native/video-structure/pipeline');
const { createJianyingDraft } = require('./src/native/video-structure/jianying');
const store = require('./src/store');
const APP_VERSION = app.getVersion() || '1.0.0';

const APP_TITLE = '红果短剧';

let mainWindow = null;
// Window teardown can race with long-running download/transcode tasks.  Once
// close starts, renderer events are no longer useful and must not be sent.
let rendererClosing = false;
let storageError = null;
store.setErrorHandler?.((payload) => {
  storageError = payload;
  sendToRenderer('storage-error', payload);
});

// ===== 视频解码兼容性 =====
// 平台视频是 HEVC(bytevc1)，Chromium 在 Windows 上只能靠硬件解码 HEVC。
// 若显卡不支持、或被 Chromium 的 GPU 黑名单挡掉，就会出现「黑屏但有声音」。
// 这里主动开启平台 HEVC 解码并放宽黑名单，能救回相当一部分机器；
// 仍然不行的，由「兼容模式转码」兜底（见 transcodeForPlayback）。
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 允许在无硬件解码时也尽量使用平台解码器
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');

// ===== 在线播放：自定义流协议（内存缓存 + Range 支持）=====
// 明文片源按播放器 Range 请求直接流式供给；加密片源仍先下载解密。
// CDN 地址只在主进程保存，渲染器使用随机会话地址。
const STREAM_SCHEME = 'hongguo-stream';
// 本地已下载文件的播放协议。
// 不能在开发模式下直接用 file:// —— 渲染页面来自 http://localhost:5173，
// Chromium 会以「Not allowed to load local resource」拒绝（表现为播放器黑屏、0:00）。
// 因此改由主进程用 Node 读文件并通过自定义协议供给，带 Range 支持以便拖动进度。
//
// 注意：这两个 scheme 刻意不开 bypassCSP —— 视频能否加载由 index.html 的 CSP 白名单
// 决定（media-src / connect-src 必须显式列出 hongguo-stream: 与 hongguo-local:）。
// 用 bypassCSP 绕开自家 CSP 会白白丢掉一层防护，属于掩盖配置疏漏，不要再加回来。
const LOCAL_SCHEME = 'hongguo-local';
protocol.registerSchemesAsPrivileged([
  {
    scheme: STREAM_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: LOCAL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** vid -> { buffer, size, lastUsed, seriesId, vidIndex } */
const onlineCache = new Map();
const ONLINE_MAX_BYTES = 300 * 1024 * 1024; // 内存缓存上限
const onlinePreparing = new Map(); // vid -> shared preparation + abort controller
const onlineSessions = new Map(); // opaque stream ID -> playback lifetime

function onlineCacheTotal() {
  let t = 0;
  for (const e of onlineCache.values()) t += e.size;
  return t;
}

function trimOnlineCache() {
  let total = onlineCacheTotal();
  while (total > ONLINE_MAX_BYTES && onlineCache.size > 1) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, e] of onlineCache) {
      if (e.lastUsed < oldest) {
        oldest = e.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    total -= onlineCache.get(oldestKey).size;
    onlineCache.delete(oldestKey);
  }
}

function releaseOnlineSession(id) {
  const session = onlineSessions.get(id);
  if (!session) return;
  onlineSessions.delete(id);
  for (const controller of session.requests) controller.abort();
  if (![...onlineSessions.values()].some((s) => s.vid === session.vid)) {
    const pending = onlinePreparing.get(session.vid);
    if (pending) {
      pending.controller.abort();
      onlinePreparing.delete(session.vid);
    }
  }
}

function clearOnlineCache() {
  for (const id of [...onlineSessions.keys()]) releaseOnlineSession(id);
  onlineCache.clear();
}

// ===== 下载任务管理 =====
let downloadTasks = [];
let downloadQueue = [];
let activeDownloads = 0;
const runningDownloads = new Set();
const runningDownloadPaths = new Set();
const downloadRuns = new Map();
let MAX_CONCURRENT_DOWNLOADS = 3;

// ===== 设置 =====
function getDefaultSettings() {
  return {
    root: app.getPath('downloads'),
    // 各功能的输出目录由用户自己指定；留空时该功能会提示先选择，不会自动建目录。
    dedup_output_dir: '',
    structure_output_dir: '',
    merge_output_dir: '',
    ai_output_dir: '',
    // 文件命名模板：可用变量 剧名(series_title) 集数(vid_index) 标题(ep_title)
    name_format: '剧名 集数',
    max_concurrent: 3,
    // 视频去重同时运行的 FFmpeg 数量（1~8），下载管理和视频处理共用。
    quchong_jobs: quchong.DEFAULTS.jobs,
    // 看完一集后自动删除本地文件（边看边清，避免占用磁盘）
    auto_delete_watched: false,
    // 兼容模式：本机无法解码 HEVC 时自动转码为 H.264（解决「黑屏有声」）
    compat_mode: true,
    // ===== 网络代理 =====
    // proxy_enabled: 是否启用代理（关闭时忽略系统代理，直连）
    // proxy_mode:    system=跟随系统/环境变量 · custom=手动指定 · direct=强制直连
    proxy_enabled: false,
    proxy_mode: 'system',
    proxy_host: '127.0.0.1',
    proxy_port: 7890,
    proxy_username: '',
    proxy_password: '',
    // ===== AI 素材处理（可填写 OpenAI 兼容中转） =====
    ai_base_url: 'https://api.openai.com/v1',
    ai_api_key: '',
    // 作图可以单独走另一个中转地址 / Key；留空就和文本共用上面的。
    ai_image_base_url: '',
    ai_image_api_key: '',
    ai_image_model: openai.DEFAULT_IMAGE_MODEL,
    ai_text_model: openai.DEFAULT_TEXT_MODEL,
    // 本地 whisper.cpp 是默认转写引擎。OpenAI 只有在用户明确选择
    // openai 或 whisper.cpp+openai-fallback 时才会调用。
    ai_transcription_engine: 'whisper.cpp',
    ai_transcription_model: 'gpt-4o-mini-transcribe',
    whisper_binary_path: '',
    whisper_model_path: '',
    whisper_language: 'zh',
    whisper_threads: 0,
    // 精品剪辑链路：faster-whisper 在批次开始时固定一次设备，不在任务中途切换。
    faster_whisper_python_path: '',
    faster_whisper_script_path: '',
    faster_whisper_model: 'tiny',
    faster_whisper_device: 'auto',
    faster_whisper_compute_type: 'auto',
    faster_whisper_concurrency: 2,
    ai_image_size: '1024x1536',
    ai_image_quality: 'high',
    ai_concurrency: 2,
    // 本地视频结构化拆解。
    // 0 = 自动（按本机核心数选择）。
    structure_threads: 0,
    structure_threshold: 0.5,
    structure_device: 'cpu',
    structure_sherpa_provider: 'cpu',
    structure_clip_audio: 'original',
    structure_punctuation_model: '',
    // 剪映草稿创建器。为空时使用应用目录的本地运行时或系统 Python。
    jianying_python_path: '',
    jianying_user_data_path: '',
    workflow_require_dedup: true,
    workflow_validate_draft: true,
  };
}

/**
 * 计算当前生效的代理 URL。
 * 返回 { mode, url }：
 *   mode='direct'  直连
 *   mode='system'  跟随系统/环境变量（url 可能是环境变量里的代理，用于展示）
 *   mode='custom'  手动指定
 */
function resolveProxyConfig(settings) {
  const s = settings || {};
  if (s.proxy_enabled !== true) {
    return { mode: 'direct', url: null };
  }
  const mode = s.proxy_mode || 'system';
  if (mode === 'direct') {
    return { mode: 'direct', url: null };
  }
  if (mode === 'custom') {
    let host = String(s.proxy_host || '').trim();
    const port = String(s.proxy_port || '').trim();
    if (!host) return { mode: 'custom', url: null };
    // 容错：用户可能直接粘贴了 http://host:port 甚至带账号密码
    let protocol = 'http';
    const scheme = host.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    if (scheme) {
      protocol = scheme[1].toLowerCase();
      host = host.slice(scheme[0].length);
    }
    host = host.replace(/\/+$/, '');
    if (!port && !/:\d+$/.test(host)) return { mode: 'custom', url: null };

    const username = String(s.proxy_username || '').trim();
    const password = String(s.proxy_password || '');
    let auth = '';
    if (username) {
      auth = encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@';
    }
    return { mode: 'custom', url: `${protocol}://${auth}${host}${port ? ':' + port : ''}` };
  }
  // system：以环境变量为准
  const envUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
  return { mode: 'system', url: envUrl };
}

function publicProxyUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch (_) {
    return '(代理地址已隐藏)';
  }
}

function publicProxyError(message, settings, resolved) {
  let text = String(message || '代理连接失败').replace(/([a-z]+:\/\/)[^\s/]*@/gi, '$1[认证已隐藏]@');
  for (const secret of [settings.proxy_username, settings.proxy_password, resolved.url]) {
    if (secret)
      for (const value of new Set([String(secret), encodeURIComponent(String(secret))]))
        text = text.split(value).join('[已隐藏]');
  }
  return text;
}

/**
 * 把代理写进环境变量，axios 会自动读取（proxy-from-env），
 * 因此红果 API 解析与视频下载都会走代理，无需改动业务代码。
 */
function applyProxyToEnv(resolved) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  for (const k of keys) {
    if (resolved.url) process.env[k] = resolved.url;
    else delete process.env[k];
  }
}

/** 让 Electron 窗口自身的请求（如封面图）也走代理 */
async function applyProxyToSession(resolved) {
  try {
    const ses = session.defaultSession;
    if (!ses) return;
    if (resolved.mode === 'direct') {
      await ses.setProxy({ mode: 'direct' });
    } else if (resolved.mode === 'custom' && resolved.url) {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: resolved.url });
    } else {
      await ses.setProxy({ mode: 'system' });
    }
  } catch (e) {
    console.error('[Proxy] 设置窗口代理失败');
  }
}

/** 统一入口：设置变化或启动时调用 */
async function applyProxySettings(settings) {
  const resolved = resolveProxyConfig(settings);
  applyProxyToEnv(resolved);
  await applyProxyToSession(resolved);
  console.log(`[Proxy] mode=${resolved.mode}`);
  return resolved;
}

function getCurrentSettings() {
  const saved = store.getSettings() || {};
  const merged = { ...getDefaultSettings(), ...saved };
  // 保证并发数合法
  const mc = parseInt(merged.max_concurrent, 10);
  MAX_CONCURRENT_DOWNLOADS = Number.isInteger(mc) && mc >= 1 && mc <= 10 ? mc : 3;
  const jobs = merged.quchong_jobs;
  // 旧版本把文本模型默认存成了 gpt-5.6；没有改过的统一升到现在的默认值。
  if (merged.ai_text_model === 'gpt-5.6') merged.ai_text_model = openai.DEFAULT_TEXT_MODEL;
  return {
    ...merged,
    max_concurrent: MAX_CONCURRENT_DOWNLOADS,
    quchong_jobs: Number.isInteger(jobs) && jobs >= 1 && jobs <= 8 ? jobs : quchong.DEFAULTS.jobs,
  };
}

// 净化文件夹/文件名称（移除非法字符、结尾的点和空格）
function sanitizeFolderName(name) {
  return (
    String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 80) || ''
  );
}

// 按命名模板渲染文件名，返回 名称(不含扩展名) 或 null
function renderName(format, seriesTitle, vidIndex, epTitle) {
  const fmt = String(format || '').trim();
  if (!fmt) return null;
  const vars = {
    series_title: String(seriesTitle || '').trim(),
    vid_index: String(vidIndex).padStart(3, '0'),
    ep_title: String(epTitle || '').trim(),
  };
  const zhMap = {
    剧名: 'series_title',
    集数: 'vid_index',
    标题: 'ep_title',
  };
  const zhRe = /剧名|集数|标题/g;
  let name = fmt
    .replace(zhRe, (w) => zhMap[w] || w)
    .replace(/([A-Za-z]+(?:_[A-Za-z]+)*)/g, (tok) => (vars[tok] !== undefined ? vars[tok] || '' : tok));
  name = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return name || null;
}

// ===== 加载/保存下载任务 =====
function loadDownloadTasks() {
  const saved = store.getTasks() || [];
  saved.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  downloadTasks = saved.map((task) => {
    const inProgress = task.status === 'downloading' || task.status === 'pending';
    return {
      ...task,
      status: inProgress ? 'failed' : task.status,
      error: inProgress ? '应用关闭时任务中断' : task.error,
    };
  });
}

/**
 * 从已有下载任务回填短剧档案。
 * 用户可能在这功能上线前就已经下载了不少剧集，没有档案播放页就看不到它们。
 */
function rebuildSeriesRegistryFromTasks() {
  const groups = new Map();
  for (const t of downloadTasks) {
    const info = t.hongguoInfo;
    if (!info || !info.series_id) continue;
    const sid = String(info.series_id);
    if (!groups.has(sid)) {
      groups.set(sid, {
        series_id: sid,
        series_title: info.series_title || '未命名短剧',
        cover: (t.videoInfo && t.videoInfo.cover) || '',
        episodes: new Map(),
      });
    }
    const g = groups.get(sid);
    const idx = Number(info.vid_index) || 0;
    if (!g.episodes.has(idx)) {
      g.episodes.set(idx, {
        vid: String(info.vid),
        vid_index: idx,
        title: info.ep_title || '',
        cover: (t.videoInfo && t.videoInfo.cover) || '',
      });
    }
  }

  let added = 0;
  for (const g of groups.values()) {
    const existing = seriesRegistry.find((s) => String(s.series_id) === g.series_id);
    const list = Array.from(g.episodes.values()).sort((a, b) => a.vid_index - b.vid_index);
    if (!existing) {
      seriesRegistry.push({
        series_id: g.series_id,
        series_title: g.series_title,
        cover: g.cover,
        total: list.length,
        episodes: list,
        updatedAt: 0, // 回填的排在搜索/解析得到的后面
        dismissed: false,
      });
      added++;
    } else if (!existing.dismissed && (!existing.episodes || existing.episodes.length < list.length)) {
      // 档案里的分集不完整时，用任务里能凑出的补上
      existing.episodes = list;
      existing.total = list.length;
      added++;
    }
  }
  if (added > 0) {
    saveSeriesRegistry();
    console.log(`[Series] 从下载任务回填 ${added} 部短剧档案`);
  }
}

function saveDownloadTasks() {
  const serializable = downloadTasks.map((task) => {
    const { cancelSource, writer, ...rest } = task;
    return rest;
  });
  store.saveTasks(serializable);
}

// ===== 短剧档案（播放页据此列出完整分集）=====
let seriesRegistry = [];

// 视频发布流水线的唯一状态源。
// downloaded -> deduped -> segmented -> ready，只有 ready 的最终成品才能进入 AI 素材队列。
// 这些标记与文件指纹一起持久化；文件移动、删除或内容/时间戳变化后会自动失效。
function pipelineFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 100 * 1024) return null;
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch (_) {
    return null;
  }
}

function pipelineForEntry(entry) {
  if (!entry.pipeline || typeof entry.pipeline !== 'object') entry.pipeline = {};
  if (!entry.pipeline.episodes || typeof entry.pipeline.episodes !== 'object') entry.pipeline.episodes = {};
  if (!entry.pipeline.groups || typeof entry.pipeline.groups !== 'object') entry.pipeline.groups = {};
  return entry.pipeline;
}

function pipelineEpisode(entry, index, create = true) {
  const pipeline = pipelineForEntry(entry);
  const key = String(Number(index));
  if (!create) return pipeline.episodes[key] || null;
  if (!pipeline.episodes[key] || typeof pipeline.episodes[key] !== 'object') {
    pipeline.episodes[key] = { episodeIndex: Number(index), status: 'missing', updatedAt: Date.now() };
  }
  return pipeline.episodes[key];
}

function pipelineFileValid(filePath, fingerprint) {
  const current = pipelineFingerprint(filePath);
  return !!current && (!fingerprint || current === fingerprint);
}

function markPipelineDownloaded(task, filePath) {
  const info = task?.hongguoInfo;
  if (!info?.series_id || !info?.vid_index || !pipelineFileValid(filePath)) return false;
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(info.series_id));
  if (!entry) return false;
  const record = pipelineEpisode(entry, info.vid_index);
  const nextFingerprint = pipelineFingerprint(filePath);
  const sourceChanged =
    (record.downloadPath && quchongPathKey(record.downloadPath) !== quchongPathKey(filePath)) ||
    (record.downloadFingerprint && record.downloadFingerprint !== nextFingerprint);
  record.downloadPath = filePath;
  record.downloadFingerprint = nextFingerprint;
  if (sourceChanged) {
    const pipeline = pipelineForEntry(entry);
    for (const group of Object.values(pipeline.groups)) {
      if (Array.isArray(group.episodeIndices) && group.episodeIndices.includes(Number(info.vid_index))) {
        group.status = 'stale';
        group.error = '源视频已变化，请重新去重并生成成品';
        group.updatedAt = Date.now();
      }
    }
    delete record.dedupPath;
    delete record.dedupFingerprint;
    delete record.finalPath;
    delete record.finalFingerprint;
    delete record.groupId;
    record.status = 'downloaded';
    record.error = '源视频已变化，请重新完成去重和成品处理';
  } else if (!record.status || record.status === 'missing' || record.status === 'stale') record.status = 'downloaded';
  record.updatedAt = Date.now();
  try {
    saveSeriesRegistry();
    return true;
  } catch (_) {
    return false;
  }
}

function pipelineEpisodeByPath(filePath) {
  const key = quchongPathKey(filePath);
  if (!key) return [];
  const matches = [];
  for (const entry of seriesRegistry) {
    const pipeline = pipelineForEntry(entry);
    for (const [idx, record] of Object.entries(pipeline.episodes)) {
      const paths = [record.downloadPath, record.dedupPath, record.finalPath, record.outputPath].filter(Boolean);
      if (paths.some((candidate) => quchongPathKey(candidate) === key)) {
        matches.push({ entry, index: Number(idx), record });
      }
    }
    for (const episode of entry.episodes || []) {
      const task = downloadTasks.find(
        (item) =>
          String(item.hongguoInfo?.series_id) === String(entry.series_id) &&
          Number(item.hongguoInfo?.vid_index) === Number(episode.vid_index) &&
          quchongPathKey(item.savePath) === key,
      );
      if (task && !matches.some((item) => item.entry === entry && item.index === Number(episode.vid_index))) {
        matches.push({ entry, index: Number(episode.vid_index), record: pipelineEpisode(entry, episode.vid_index) });
      }
    }
  }
  return matches;
}

function markPipelineDeduped(sourcePath, outputPath) {
  const matches = pipelineEpisodeByPath(sourcePath);
  if (!matches.length || !pipelineFileValid(outputPath)) return 0;
  const now = Date.now();
  const outputFingerprint = pipelineFingerprint(outputPath);
  for (const { entry, index, record } of matches) {
    const changed =
      record.dedupFingerprint &&
      (record.dedupFingerprint !== outputFingerprint ||
        quchongPathKey(record.dedupPath) !== quchongPathKey(outputPath));
    if (changed) {
      const pipeline = pipelineForEntry(entry);
      for (const group of Object.values(pipeline.groups)) {
        if (Array.isArray(group.episodeIndices) && group.episodeIndices.includes(Number(index))) {
          group.status = 'stale';
          group.error = '去重输出已变化，请重新生成成品';
          group.updatedAt = now;
        }
      }
      delete record.finalPath;
      delete record.finalFingerprint;
      delete record.groupId;
    }
    record.dedupPath = outputPath;
    record.dedupFingerprint = outputFingerprint;
    record.status = 'deduped';
    record.updatedAt = now;
    record.error = '';
  }
  try {
    saveSeriesRegistry();
  } catch (_) {}
  return matches.length;
}

function markPipelineSegmented(task) {
  const sid = String(task?.seriesId || '');
  const entry = seriesRegistry.find((item) => String(item.series_id) === sid);
  if (!entry) return 0;
  const indices = Array.isArray(task.episodeIndices) ? task.episodeIndices : [];
  const groupId = String(task.id || randomUUID());
  const pipeline = pipelineForEntry(entry);
  pipeline.groups[groupId] = {
    id: groupId,
    status: 'processing',
    outputPath: task.output || task.path || '',
    episodeIndices: indices.map(Number).filter(Number.isSafeInteger),
    updatedAt: Date.now(),
  };
  // A running or failed merge is not a completed stage. Episode records stay
  // `deduped` until the output is verified and markPipelineReady runs.
  try {
    saveSeriesRegistry();
  } catch (_) {}
  return indices.length;
}

function markPipelineReady(task) {
  const sid = String(task?.seriesId || '');
  const entry = seriesRegistry.find((item) => String(item.series_id) === sid);
  const output = task?.output || task?.path;
  if (!entry || !pipelineFileValid(output)) return 0;
  const indices = Array.isArray(task.episodeIndices) ? task.episodeIndices : [];
  const pipeline = pipelineForEntry(entry);
  const groupId = String(task.id || randomUUID());
  const outputFingerprint = pipelineFingerprint(output);
  pipeline.groups[groupId] = {
    id: groupId,
    status: 'ready',
    outputPath: output,
    outputFingerprint,
    episodeIndices: indices.map(Number).filter(Number.isSafeInteger),
    title: task.outputName || task.seriesTitle || entry.series_title,
    updatedAt: Date.now(),
  };
  for (const index of pipeline.groups[groupId].episodeIndices) {
    const record = pipelineEpisode(entry, index);
    record.status = 'ready';
    record.groupId = groupId;
    record.finalPath = output;
    record.finalFingerprint = outputFingerprint;
    record.updatedAt = Date.now();
    record.error = '';
  }
  try {
    saveSeriesRegistry();
  } catch (_) {}
  return indices.length;
}

function markPipelineMergeFailed(task) {
  const sid = String(task?.seriesId || '');
  const entry = seriesRegistry.find((item) => String(item.series_id) === sid);
  if (!entry || !task?.id) return 0;
  const pipeline = pipelineForEntry(entry);
  const group = pipeline.groups[String(task.id)];
  if (!group || group.status !== 'processing') return 0;
  group.status = task.cancelled ? 'stopped' : 'failed';
  group.error = task.error || (task.cancelled ? '合并已取消' : '合并失败');
  group.updatedAt = Date.now();
  try {
    saveSeriesRegistry();
  } catch (_) {}
  return 1;
}

function invalidatePipelineRecord(entry, index, record, reason) {
  if (!record) return false;
  if (!record.status || record.status === 'missing') return false;
  const valid =
    record.status === 'ready'
      ? pipelineFileValid(record.finalPath, record.finalFingerprint)
      : record.status === 'deduped' || record.status === 'segmented'
        ? pipelineFileValid(record.dedupPath, record.dedupFingerprint)
        : pipelineFileValid(record.downloadPath, record.downloadFingerprint);
  if (valid) return false;
  record.status = 'stale';
  record.error = reason || '流水线文件已移动、删除或发生变化，请重新处理';
  record.updatedAt = Date.now();
  return true;
}

function pipelineReadyProducts(entry) {
  const pipeline = pipelineForEntry(entry);
  const products = [];
  for (const [id, group] of Object.entries(pipeline.groups)) {
    if (group.status !== 'ready' || !pipelineFileValid(group.outputPath, group.outputFingerprint)) {
      if (group.status === 'ready') {
        group.status = 'stale';
        group.error = '成品文件已移动、删除或发生变化';
        group.updatedAt = Date.now();
      }
      continue;
    }
    products.push({
      id,
      path: group.outputPath,
      title: group.title || entry.series_title,
      episodeIndices: Array.isArray(group.episodeIndices) ? group.episodeIndices.map(Number) : [],
      status: 'ready',
      updatedAt: group.updatedAt || 0,
    });
  }
  return products;
}

function getPipelineStatus(seriesId) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) return { success: false, error: '未找到该剧档案' };
  const pipeline = pipelineForEntry(entry);
  let changed = false;
  // 应用在合并过程中被强制退出时没有机会执行 finally；启动后第一次读取状态时
  // 将没有对应运行任务的 processing 组收敛为 stopped，避免流程永远卡在“处理中”。
  for (const group of Object.values(pipeline.groups)) {
    if (group.status !== 'processing') continue;
    const task = mergeTasks.find((item) => String(item.id) === String(group.id));
    if (task?.status === 'running') continue;
    group.status = task?.status === 'failed' ? 'failed' : 'stopped';
    group.error = task?.error || '应用关闭时中断，可重新生成成品';
    group.updatedAt = Date.now();
    changed = true;
  }
  for (const [idx, record] of Object.entries(pipeline.episodes))
    changed = invalidatePipelineRecord(entry, idx, record) || changed;
  const groupsBefore = JSON.stringify(pipeline.groups);
  const products = pipelineReadyProducts(entry);
  changed = changed || groupsBefore !== JSON.stringify(pipeline.groups);
  const episodes = (entry.episodes || []).map((ep) => {
    const record = pipelineEpisode(entry, ep.vid_index);
    const downloadPath =
      record.downloadPath ||
      downloadTasks.find(
        (task) =>
          String(task.hongguoInfo?.series_id) === String(seriesId) &&
          Number(task.hongguoInfo?.vid_index) === Number(ep.vid_index) &&
          hasCompleteTaskFile(task),
      )?.savePath ||
      null;
    if (downloadPath && record.status === 'missing' && pipelineFileValid(downloadPath, record.downloadFingerprint)) {
      record.downloadPath = downloadPath;
      record.downloadFingerprint = pipelineFingerprint(downloadPath);
      record.status = 'downloaded';
      record.updatedAt = Date.now();
      changed = true;
    }
    const product = products.find((item) => item.episodeIndices.includes(Number(ep.vid_index)));
    return {
      episodeIndex: Number(ep.vid_index),
      status: product ? 'ready' : record.status || 'missing',
      downloaded: !!downloadPath && pipelineFileValid(downloadPath, record.downloadFingerprint),
      deduped: ['deduped', 'segmented', 'ready'].includes(record.status),
      segmented: ['segmented', 'ready'].includes(record.status),
      ready: !!product,
      path: product?.path || (record.status === 'deduped' ? record.dedupPath : null),
      groupId: product?.id || record.groupId || null,
      error: record.error || '',
    };
  });
  if (changed) {
    try {
      saveSeriesRegistry();
    } catch (_) {}
  }
  const readyEpisodeIndices = episodes.filter((ep) => ep.ready).map((ep) => ep.episodeIndex);
  const blockedReason = products.length ? '' : '请先下载视频、完成去重，再按分组完成分割/拼接成品';
  return {
    success: true,
    seriesId: String(seriesId),
    ready: products.length > 0,
    readyEpisodeIndices,
    blockedReason,
    stages: {
      download: { done: episodes.filter((ep) => ep.downloaded).length, total: episodes.length },
      dedup: { done: episodes.filter((ep) => ep.deduped).length, total: episodes.length },
      split: { done: episodes.filter((ep) => ep.segmented).length, total: episodes.length },
      final: { done: readyEpisodeIndices.length, total: episodes.length },
    },
    episodes,
    final: { products },
  };
}

function loadSeriesRegistry() {
  const saved = store.getSeries() || [];
  // 旧版本只保存 updatedAt；保留兼容回退，后续写入统一使用
  // episodesUpdatedAt 记录最近一次成功拉取分集的时间。
  let changed = false;
  seriesRegistry = saved.map((entry) => {
    const next = {
      ...entry,
      episodesUpdatedAt: Number(entry.episodesUpdatedAt || entry.updatedAt) || 0,
      ai_material_tasks: Array.isArray(entry.ai_material_tasks)
        ? entry.ai_material_tasks.map((task) => {
            const copy = { ...task };
            // A process killed during a paid stage must never resume by itself.
            if (copy.status === 'running' || copy.status === 'queued') {
              copy.status = 'stopped';
              copy.stage = 'stopped';
              copy.error = '应用关闭时中断';
              copy.updatedAt = Date.now();
              copy.completedAt = null;
              changed = true;
            }
            if (copy.status === 'completed') {
              const output = copy.kind === 'cover' ? copy.path : copy.outputPath;
              if (!aiOutputIsUsableOnLoad(output)) {
                copy.status = 'failed';
                copy.stage = 'failed';
                copy.error = '输出文件不存在，可重试';
                copy.updatedAt = Date.now();
                copy.completedAt = null;
                changed = true;
              }
            }
            return copy;
          })
        : [],
      ai_episode_copies:
        entry.ai_episode_copies && typeof entry.ai_episode_copies === 'object' ? { ...entry.ai_episode_copies } : {},
      ai_cover: entry.ai_cover && typeof entry.ai_cover === 'object' ? { ...entry.ai_cover } : null,
    };
    // 流水线状态与 AI 标记一样，恢复时先做结构化校验；文件是否仍可用由
    // get-series-pipeline-status 在实际读取时按指纹再次核验。
    next.pipeline =
      entry.pipeline && typeof entry.pipeline === 'object'
        ? {
            ...entry.pipeline,
            episodes:
              entry.pipeline.episodes && typeof entry.pipeline.episodes === 'object'
                ? { ...entry.pipeline.episodes }
                : {},
            groups:
              entry.pipeline.groups && typeof entry.pipeline.groups === 'object' ? { ...entry.pipeline.groups } : {},
          }
        : { episodes: {}, groups: {} };
    // 完整 SRT 转写状态与视频流水线分开保存。应用意外退出后，运行中的
    // 转写只能恢复为 stopped，下一次由用户明确重新开始，避免偷偷占用模型。
    next.transcription =
      entry.transcription && typeof entry.transcription === 'object'
        ? {
            version: 1,
            updatedAt: Number(entry.transcription.updatedAt) || 0,
            episodes:
              entry.transcription.episodes && typeof entry.transcription.episodes === 'object'
                ? Object.fromEntries(
                    Object.entries(entry.transcription.episodes).map(([key, record]) => {
                      const copy = record && typeof record === 'object' ? { ...record } : { episodeIndex: Number(key) };
                      if (copy.status === 'running' || copy.status === 'queued') {
                        copy.status = 'stopped';
                        copy.stage = 'stopped';
                        copy.error = '应用关闭时中断，请重新开始转写';
                        copy.updatedAt = Date.now();
                        changed = true;
                      }
                      return [key, copy];
                    }),
                  )
                : {},
          }
        : { version: 1, updatedAt: 0, episodes: {} };
    next.analysis =
      entry.analysis && typeof entry.analysis === 'object'
        ? {
            version: 1,
            updatedAt: Number(entry.analysis.updatedAt) || 0,
            episodes:
              entry.analysis.episodes && typeof entry.analysis.episodes === 'object'
                ? Object.fromEntries(
                    Object.entries(entry.analysis.episodes).map(([key, record]) => {
                      const copy = record && typeof record === 'object' ? { ...record } : { episodeIndex: Number(key) };
                      if (copy.status === 'running' || copy.status === 'queued') {
                        copy.status = 'stopped';
                        copy.stage = 'stopped';
                        copy.error = '应用关闭时中断，请重新生成分析';
                        copy.updatedAt = Date.now();
                        changed = true;
                      }
                      return [key, copy];
                    }),
                  )
                : {},
          }
        : { version: 1, updatedAt: 0, episodes: {} };
    // 整集工作流运行中退出时不自动续跑；下次由用户明确点击重新开始。
    next.workflow =
      entry.workflow && typeof entry.workflow === 'object'
        ? {
            version: 1,
            updatedAt: Number(entry.workflow.updatedAt) || 0,
            episodes:
              entry.workflow.episodes && typeof entry.workflow.episodes === 'object'
                ? Object.fromEntries(
                    Object.entries(entry.workflow.episodes).map(([key, record]) => {
                      const copy = record && typeof record === 'object' ? { ...record } : { episodeIndex: Number(key) };
                      if (copy.status === 'running' || copy.status === 'queued' || copy.status === 'stopping') {
                        copy.status = 'stopped';
                        copy.stage = 'stopped';
                        copy.error = '应用关闭时中断，请重新开始工作流';
                        copy.updatedAt = Date.now();
                        changed = true;
                      }
                      return [key, copy];
                    }),
                  )
                : {},
          }
        : { version: 1, updatedAt: 0, episodes: {} };
    if (next.ai_cover?.status === 'processing') {
      next.ai_cover = { ...next.ai_cover, status: 'stopped', error: '应用关闭时中断', updatedAt: Date.now() };
      changed = true;
    }
    // A marker is complete only when its output still exists; moved/deleted files become stale.
    if (next.ai_cover?.status === 'completed' && (!next.ai_cover.path || !fs.existsSync(next.ai_cover.path))) {
      next.ai_cover = null;
      changed = true;
    }
    for (const [key, record] of Object.entries(next.ai_episode_copies)) {
      if (record?.status === 'completed' && (!record.outputPath || !fs.existsSync(record.outputPath))) {
        delete next.ai_episode_copies[key];
        changed = true;
      }
    }
    return next;
  });
  if (changed) {
    try {
      store.saveSeries(seriesRegistry);
    } catch (_) {
      /* storage-error is reported by the store */
    }
  }
}

function aiOutputIsUsableOnLoad(filePath) {
  try {
    return !!filePath && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch (_) {
    return false;
  }
}

function saveSeriesRegistry() {
  store.saveSeries(seriesRegistry);
}

// ===== 精品剪辑：已去重视频 -> 完整 SRT =====
// 这是独立于旧 AI 发布素材队列的核心链路。输入只能来自 pipeline 的
// dedupPath，字幕输出只按原视频 stem 配对，转写原文不再复制成 TXT/JSON。
function transcriptionState(entry) {
  if (!entry.transcription || typeof entry.transcription !== 'object')
    entry.transcription = { version: 1, updatedAt: 0, episodes: {} };
  if (!entry.transcription.episodes || typeof entry.transcription.episodes !== 'object')
    entry.transcription.episodes = {};
  return entry.transcription;
}

function getSeriesTranscriptionState(seriesId) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) return { version: 1, updatedAt: 0, episodes: {} };
  return transcriptionState(entry);
}

function saveSeriesTranscriptionState(seriesId, nextState) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) throw new Error('短剧档案已不存在，无法保存转写状态');
  entry.transcription = {
    version: 1,
    updatedAt: Date.now(),
    episodes: nextState?.episodes && typeof nextState.episodes === 'object' ? nextState.episodes : {},
  };
  saveSeriesRegistry();
}

function getSeriesDedupedEpisodes(seriesId) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) return [];
  const workDir = seriesWorkDir(seriesId);
  return (entry.episodes || [])
    .map((episode) => {
      const episodeIndex = Number(episode.vid_index);
      const record = pipelineEpisode(entry, episodeIndex, false);
      if (!record?.dedupPath || !pipelineFileValid(record.dedupPath, record.dedupFingerprint)) return null;
      const inputPath = record.dedupPath;
      return {
        episodeIndex,
        title: episode.title || '',
        inputPath,
        inputFingerprint: pipelineFingerprint(inputPath),
        srtPath: path.join(workDir, 'transcripts', `${path.parse(inputPath).name}.srt`),
      };
    })
    .filter(
      (item) => item && Number.isSafeInteger(item.episodeIndex) && item.episodeIndex > 0 && item.inputFingerprint,
    );
}

let transcriptionManager = null;
function getTranscriptionSettings() {
  return {
    ...getCurrentSettings(),
    isPackaged: !!app.isPackaged,
    resourcesPath: process.resourcesPath,
    ffmpegPath: resolveFfmpeg('ffmpeg'),
    ffprobePath: resolveFfmpeg('ffprobe'),
  };
}
function getTranscriptionManager() {
  if (!transcriptionManager) {
    transcriptionManager = createTranscriptionManager({
      getSettings: getTranscriptionSettings,
      getEpisodes: (seriesId) => getSeriesDedupedEpisodes(seriesId),
      getState: (seriesId) => getSeriesTranscriptionState(seriesId),
      saveState: saveSeriesTranscriptionState,
      sendProgress: (payload) => sendToRenderer('series-transcription-progress', payload),
    });
  }
  return transcriptionManager;
}

function analysisState(entry) {
  if (!entry.analysis || typeof entry.analysis !== 'object')
    entry.analysis = { version: 1, updatedAt: 0, episodes: {} };
  if (!entry.analysis.episodes || typeof entry.analysis.episodes !== 'object') entry.analysis.episodes = {};
  return entry.analysis;
}

function getSeriesAnalysisState(seriesId) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) return { version: 1, updatedAt: 0, episodes: {} };
  return analysisState(entry);
}

function saveSeriesAnalysisState(seriesId, nextState) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) throw new Error('短剧档案已不存在，无法保存分析状态');
  entry.analysis = {
    version: 1,
    updatedAt: Date.now(),
    episodes: nextState?.episodes && typeof nextState.episodes === 'object' ? nextState.episodes : {},
  };
  saveSeriesRegistry();
}

function getSeriesAnalysisEpisodes(seriesId) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) return [];
  const workDir = seriesWorkDir(seriesId);
  const transcript = transcriptionState(entry);
  const deduped = new Map(getSeriesDedupedEpisodes(seriesId).map((item) => [item.episodeIndex, item]));
  return (entry.episodes || [])
    .map((episode) => {
      const episodeIndex = Number(episode.vid_index);
      const record = transcript.episodes[String(episodeIndex)];
      const current = deduped.get(episodeIndex);
      if (!current || !isSubtitleCompleted(record, current)) return null;
      const srtFingerprint = record.srtHash;
      return {
        episodeIndex,
        title: episode.title || '',
        seriesTitle: entry.series_title || '',
        inputPath: record.inputPath || '',
        srtPath: record.srtPath,
        srtFingerprint,
        srtRevision: record.revision,
        inputFingerprint: current.inputFingerprint,
        analysisPath: path.join(workDir, 'analysis', `ep${String(episodeIndex).padStart(3, '0')}.json`),
      };
    })
    .filter((item) => item && Number.isSafeInteger(item.episodeIndex) && item.episodeIndex > 0);
}

let analysisManager = null;
function getAnalysisManager() {
  if (!analysisManager) {
    analysisManager = createAnalysisManager({
      getSettings: () => getCurrentSettings(),
      getEpisodes: (seriesId) => getSeriesAnalysisEpisodes(seriesId),
      getState: (seriesId) => getSeriesAnalysisState(seriesId),
      saveState: saveSeriesAnalysisState,
      getFfmpegPath: () => resolveFfmpeg('ffmpeg'),
      sendProgress: (payload) => sendToRenderer('series-analysis-progress', payload),
    });
  }
  return analysisManager;
}

const libraryDraftPlans = new Map(); // projectId -> { mode, fallbackRoot }
let reconstructionPipeline = null;
function getReconstructionPipeline() {
  if (!reconstructionPipeline) {
    reconstructionPipeline = createVideoStructurePipeline({
      getSettings: () => ({
        ...getCurrentSettings(),
        isPackaged: !!app.isPackaged,
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        arch: process.arch,
      }),
      getFfmpegPath: () => resolveFfmpeg('ffmpeg'),
      getFfprobePath: () => resolveFfmpeg('ffprobe'),
      getConcurrency: libraryDraftSlots,
      getProjectRecord: (projectId) => store.getStructureProjects()[String(projectId)] || null,
      saveProjectRecord: (projectId, record) => store.saveStructureProject(projectId, record),
      createDraft: (ctx) => {
        // 管理剧集里发起的草稿会登记模式（多分轨 / 三分轨）和没装剪映时的存放位置。
        const plan = libraryDraftPlans.get(ctx.taskId) || {};
        const simple = plan.mode === 'simple';
        const userData = resolveJianyingUserData();
        const stamp = new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, '')
          .slice(0, 14);
        const name = `${sanitizeFolderName(path.parse(ctx.input).name)}-剪映草稿-${stamp}-${randomUUID().slice(0, 4)}`;
        return createJianyingDraft(ctx, {
          executable: resolveJianyingRuntime()?.executable,
          createScript: resolveJianyingScript(simple ? 'create-jianying-simple-draft.py' : 'create-jianying-draft.py'),
          checkScript: resolveJianyingScript('check-jianying-draft.py'),
          outputRoot: userData
            ? path.join(userData, 'Projects', 'com.lveditor.draft')
            : plan.fallbackRoot || path.join(ctx.projectDir, '剪映草稿'),
          name,
          userData,
          // 三分轨草稿结构简单，由脚本自己核对；多分轨照旧走完整校验。
          validate: simple ? false : workflowGates().validateDraft,
        });
      },
      sendProgress: (payload) => {
        sendToRenderer('reconstruction-progress', payload);
        libraryDraftProgress(payload);
        const run = [...episodeWorkflowRuns.values()].find((item) => item.projectId === payload?.projectId);
        if (!run) return;
        const entry = seriesRegistry.find((item) => String(item.series_id) === String(run.seriesId));
        if (!entry) return;
        const record = workflowEpisode(entry, run.episodeIndex);
        record.stage = payload?.stage === 'jianying' ? 'jianying' : 'structure';
        const stages = Object.values(payload?.modules || {});
        const finished = stages.filter((stage) => stage.status === 'succeeded').length;
        const currentProgress = payload?.modules?.[payload?.stage]?.progress;
        record.progress = Math.min(
          99,
          ((finished + (Number.isFinite(currentProgress) ? currentProgress / 100 : 0)) / 9) * 100,
        );
        record.message = payload?.modules?.[payload?.stage]?.message || payload?.stage || record.message;
        record.updatedAt = Date.now();
        workflowEmit(run.seriesId, run.episodeIndex, record);
      },
    });
  }
  return reconstructionPipeline;
}

// ===== 单集工作流：去重输出 -> 结构化拆解 -> 剪映草稿 =====
// 这是下载管理里的“一键处理”唯一入口。每集单独保存状态，任何一步失败只
// 影响这一集；下一集不会拿到上一集的路径或中间结果。
const episodeWorkflowRuns = new Map();
const episodeWorkflowBatches = new Map();

function workflowForEntry(entry) {
  if (!entry.workflow || typeof entry.workflow !== 'object')
    entry.workflow = { version: 1, updatedAt: 0, episodes: {} };
  if (!entry.workflow.episodes || typeof entry.workflow.episodes !== 'object') entry.workflow.episodes = {};
  return entry.workflow;
}

function workflowEpisode(entry, episodeIndex) {
  const workflow = workflowForEntry(entry);
  const key = String(Number(episodeIndex));
  if (!workflow.episodes[key] || typeof workflow.episodes[key] !== 'object') {
    workflow.episodes[key] = {
      episodeIndex: Number(episodeIndex),
      status: 'idle',
      stage: 'waiting_dedup',
      progress: 0,
      updatedAt: Date.now(),
    };
  }
  return workflow.episodes[key];
}

function workflowKey(seriesId, episodeIndex) {
  return `${String(seriesId)}:${Number(episodeIndex)}`;
}

function workflowProjectId(seriesId, episodeIndex) {
  return `workflow:${String(seriesId)}:${Number(episodeIndex)}`;
}

function workflowEmit(seriesId, episodeIndex, record, extra = {}) {
  sendToRenderer('episode-workflow-progress', {
    seriesId: String(seriesId),
    episodeIndex: Number(episodeIndex),
    ...record,
    ...extra,
  });
}

function updateWorkflowRecord(entry, episodeIndex, patch, persist = true) {
  const record = workflowEpisode(entry, episodeIndex);
  Object.assign(record, patch, { episodeIndex: Number(episodeIndex), updatedAt: Date.now() });
  const workflow = workflowForEntry(entry);
  workflow.updatedAt = Date.now();
  if (persist) {
    try {
      saveSeriesRegistry();
    } catch (_) {}
  }
  workflowEmit(entry.series_id, episodeIndex, record);
  return record;
}

function workflowDraftExists(record) {
  try {
    if (!record?.draftPath || !fs.statSync(record.draftPath).isDirectory()) return false;
    const manifestPath = path.join(record.draftPath, 'hongguo-draft-manifest.json');
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return (
      manifest.boundary_policy === 'shot_cut_requires_acoustic_pause' &&
      manifest.alignment_algorithm === 'visual-shot-on-acoustic-pause-v1'
    );
  } catch (_) {
    return false;
  }
}

function workflowGates() {
  const settings = getCurrentSettings();
  return {
    requireDedup: settings.workflow_require_dedup !== false,
    validateDraft: settings.workflow_validate_draft !== false,
  };
}

function workflowInput(entry, episodeIndex) {
  const pipelineRecord = pipelineEpisode(entry, episodeIndex, false);
  const dedupValid =
    !!pipelineRecord?.dedupPath && pipelineFileValid(pipelineRecord.dedupPath, pipelineRecord.dedupFingerprint);
  if (dedupValid) return { path: pipelineRecord.dedupPath, stage: 'deduped' };
  const gates = workflowGates();
  if (gates.requireDedup) return null;
  const downloadedValid =
    !!pipelineRecord?.downloadPath &&
    pipelineFileValid(pipelineRecord.downloadPath, pipelineRecord.downloadFingerprint);
  return downloadedValid ? { path: pipelineRecord.downloadPath, stage: 'downloaded' } : null;
}

function getSeriesWorkflowStatus(seriesId) {
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(seriesId));
  if (!entry) return { success: false, error: '未找到该剧档案' };
  // 先让下载/去重状态按当前磁盘文件完成一次指纹回填，避免刚启动应用时
  // 工作流页面比流水线页面更早读取而暂时看不到可用输入。
  try {
    getPipelineStatus(seriesId);
  } catch (_) {}
  const workflow = workflowForEntry(entry);
  const episodes = (entry.episodes || []).map((item) => {
    const episodeIndex = Number(item.vid_index);
    const record = workflowEpisode(entry, episodeIndex);
    const currentInput = workflowInput(entry, episodeIndex);
    const inputChanged =
      record.inputFingerprint && (!currentInput || record.inputFingerprint !== pipelineFingerprint(currentInput.path));
    if (record.status === 'completed' && (!workflowDraftExists(record) || inputChanged)) {
      record.status = 'stale';
      record.stage = 'jianying';
      record.error = inputChanged
        ? '输入视频已变化，请重新生成工作流'
        : '剪映草稿缺失或仍按画面切点直接切断，请继续完整流程按气口重切';
      record.updatedAt = Date.now();
    }
    return { ...record, episodeIndex };
  });
  const activeBatch = [...episodeWorkflowBatches.values()].find(
    (batch) => String(batch.seriesId) === String(seriesId) && ['queued', 'running', 'stopping'].includes(batch.status),
  );
  const counts = {
    total: episodes.length,
    completed: episodes.filter((item) => item.status === 'completed').length,
    running: episodes.filter((item) => ['queued', 'running', 'stopping'].includes(item.status)).length,
    failed: episodes.filter((item) => ['failed', 'stale'].includes(item.status)).length,
  };
  return {
    success: true,
    seriesId: String(seriesId),
    status:
      activeBatch?.status ||
      (counts.running ? 'running' : counts.completed === counts.total && counts.total ? 'completed' : 'idle'),
    batchId: activeBatch?.id || null,
    counts,
    gates: workflowGates(),
    episodes,
  };
}

function findExecutableInPath(names) {
  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const name of names) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {}
    }
  }
  return null;
}

function resolveJianyingPython() {
  const settings = getCurrentSettings();
  const configured = String(settings.jianying_python_path || process.env.JIANYING_PYTHON || '').trim();
  const candidates = [];
  if (configured) candidates.push(configured);
  candidates.push(
    path.join(__dirname, '.cache', 'jianying-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    path.join(
      process.cwd(),
      '.cache',
      'jianying-venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    ),
  );
  const found = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  });
  if (found) return found;
  return findExecutableInPath(
    process.platform === 'win32' ? ['python.exe', 'python', 'py.exe'] : ['python3', 'python'],
  );
}

function resolveBundledJianyingRuntime() {
  const executableName = process.platform === 'win32' ? 'hongguo-jianying.exe' : 'hongguo-jianying';
  const roots = [];
  if (app.isPackaged) roots.push(path.join(process.resourcesPath, 'jianying', executableName));
  roots.push(path.join(__dirname, 'build', 'jianying', `${process.platform}-${process.arch}`, executableName));
  return (
    roots.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch (_) {
        return false;
      }
    }) || null
  );
}

function resolveJianyingRuntime() {
  const bundled = resolveBundledJianyingRuntime();
  if (bundled) return { executable: bundled, bundled: true };
  const python = resolveJianyingPython();
  return python ? { executable: python, bundled: false } : null;
}

function resolveJianyingScript(name) {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'workflow', name), path.join(__dirname, 'scripts', name)]
    : [path.join(__dirname, 'scripts', name)];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveJianyingUserData() {
  const configured = String(getCurrentSettings().jianying_user_data_path || '').trim();
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.platform === 'darwin')
    candidates.push(path.join(app.getPath('home'), 'Movies', 'JianyingPro', 'User Data'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'JianyingPro', 'User Data'));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function workflowError(message, code = 'WORKFLOW_FAILED') {
  return Object.assign(new Error(message), { code });
}

async function runEpisodeWorkflow(seriesId, episodeIndex, options = {}) {
  const sid = String(seriesId);
  const index = Number(episodeIndex);
  const key = workflowKey(sid, index);
  if (episodeWorkflowRuns.has(key)) return { success: false, error: '该集工作流正在运行' };
  const entry = seriesRegistry.find((item) => String(item.series_id) === sid);
  if (!entry) return { success: false, error: '未找到该剧档案' };
  const run = {
    key,
    seriesId: sid,
    episodeIndex: index,
    child: null,
    projectId: workflowProjectId(sid, index),
    cancelled: false,
  };
  episodeWorkflowRuns.set(key, run);
  const record = workflowEpisode(entry, index);
  try {
    if (record.status === 'completed' && workflowDraftExists(record) && options.force !== true)
      return { success: true, ...record };
    const input = workflowInput(entry, index);
    if (!input) throw workflowError('当前集没有可用的工作流输入，请先确认视频文件状态', 'WORKFLOW_INPUT_REQUIRED');
    const inputPath = input.path;
    const episode = (entry.episodes || []).find((item) => Number(item.vid_index) === index);
    const structureRoot = configuredDir(null, 'structure_output_dir', '拆解输出目录');
    updateWorkflowRecord(entry, index, {
      status: 'running',
      stage: 'structure',
      progress: 0,
      message: '开始结构化拆解',
      error: null,
      inputPath,
      inputFingerprint: pipelineFingerprint(inputPath),
      projectId: run.projectId,
      draftPath: record.draftPath || null,
    });
    if (run.cancelled) throw workflowError('工作流已停止', 'WORKFLOW_STOPPED');
    await getReconstructionPipeline().start({
      inputPath,
      projectId: run.projectId,
      outputRoot: structureRoot,
      force: options.force === true,
    });
    // 停止请求若发生在 start() 的异步准备阶段，流水线里还没有任务可取消；任务入队后补发一次。
    if (run.cancelled) getReconstructionPipeline().cancel(run.projectId);
    const structure = await getReconstructionPipeline().wait(run.projectId);
    if (run.cancelled || structure?.status === 'stopped') throw workflowError('工作流已停止', 'WORKFLOW_STOPPED');
    const moduleIds = [
      'media',
      'audio',
      'shots',
      'clips',
      'separation',
      'transcript',
      'alignment',
      'export',
      'jianying',
    ];
    const incomplete = moduleIds.filter((id) => structure?.modules?.[id]?.status !== 'succeeded');
    if (incomplete.length)
      throw workflowError(structure.error || `工作流未完成：${incomplete.join('、')}`, 'STRUCTURE_FAILED');
    const draft = structure.modules.jianying.summary;
    if (!workflowDraftExists({ draftPath: draft?.draft_path }))
      throw workflowError('剪映草稿目录不存在', 'JIAN_YING_OUTPUT_MISSING');
    return updateWorkflowRecord(entry, index, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      message: draft.validated ? '完成：结构化与剪映草稿已校验' : '完成：剪映草稿已生成',
      error: null,
      draftPath: draft.draft_path,
      projectDir: structure.projectDir,
      finishedAt: Date.now(),
    });
  } catch (error) {
    const stopped = error?.code === 'WORKFLOW_STOPPED' || run.cancelled;
    return updateWorkflowRecord(entry, index, {
      status: stopped ? 'stopped' : 'failed',
      stage: stopped ? 'stopped' : record.stage || 'structure',
      progress: stopped ? null : record.progress,
      message: '',
      error: error.message || String(error),
    });
  } finally {
    episodeWorkflowRuns.delete(key);
  }
}

async function runSeriesWorkflow(batch) {
  batch.status = 'running';
  const entry = seriesRegistry.find((item) => String(item.series_id) === String(batch.seriesId));
  if (!entry) {
    batch.status = 'failed';
    batch.error = '未找到该剧档案';
    return;
  }
  for (const index of batch.episodeIndices) {
    if (batch.cancelled) break;
    batch.currentEpisode = index;
    await runEpisodeWorkflow(batch.seriesId, index, { force: batch.force });
  }
  batch.status = batch.cancelled ? 'stopped' : 'completed';
  batch.currentEpisode = null;
  sendToRenderer('episode-workflow-progress', {
    seriesId: String(batch.seriesId),
    batchId: batch.id,
    batchStatus: batch.status,
  });
}

function startSeriesWorkflow(payload = {}) {
  const sid = String(payload.seriesId || '');
  const entry = seriesRegistry.find((item) => String(item.series_id) === sid);
  if (!entry) return { success: false, error: '未找到该剧档案' };
  const existing = [...episodeWorkflowBatches.values()].find(
    (batch) => String(batch.seriesId) === sid && ['queued', 'running', 'stopping'].includes(batch.status),
  );
  if (existing) return { success: false, error: '该剧工作流正在运行', batchId: existing.id };
  const requested =
    Array.isArray(payload.episodeIndices) && payload.episodeIndices.length
      ? payload.episodeIndices.map(Number).filter(Number.isSafeInteger)
      : (entry.episodes || []).map((item) => Number(item.vid_index)).filter(Number.isSafeInteger);
  const episodeIndices = [...new Set(requested)]
    .sort((a, b) => a - b)
    .filter((index) => {
      return !!workflowInput(entry, index);
    });
  if (!episodeIndices.length) return { success: false, error: '没有已完成去重的集数可处理，请先完成去重' };
  const batch = {
    id: randomUUID(),
    seriesId: sid,
    episodeIndices,
    force: payload.force === true,
    status: 'queued',
    currentEpisode: null,
    cancelled: false,
    createdAt: Date.now(),
  };
  episodeWorkflowBatches.set(batch.id, batch);
  Promise.resolve()
    .then(() => runSeriesWorkflow(batch))
    .catch((error) => {
      batch.status = 'failed';
      batch.error = error.message;
    })
    .finally(() => {
      setTimeout(() => episodeWorkflowBatches.delete(batch.id), 10 * 60 * 1000);
    });
  return { success: true, batchId: batch.id, seriesId: sid, episodeIndices };
}

function cancelSeriesWorkflow(batchId) {
  const batch = episodeWorkflowBatches.get(String(batchId));
  if (!batch || !['queued', 'running'].includes(batch.status)) return { success: false, error: '工作流未在运行' };
  batch.cancelled = true;
  batch.status = 'stopping';
  const run =
    batch.currentEpisode == null ? null : episodeWorkflowRuns.get(workflowKey(batch.seriesId, batch.currentEpisode));
  if (run) {
    run.cancelled = true;
    if (run.projectId) getReconstructionPipeline().cancel(run.projectId);
    try {
      run.child?.kill('SIGTERM');
    } catch (_) {}
  }
  return { success: true };
}

function cancelAllEpisodeWorkflows() {
  for (const batch of episodeWorkflowBatches.values()) batch.cancelled = true;
  for (const run of episodeWorkflowRuns.values()) {
    run.cancelled = true;
    try {
      if (run.projectId) getReconstructionPipeline().cancel(run.projectId);
    } catch (_) {}
    try {
      run.child?.kill('SIGTERM');
    } catch (_) {}
  }
}

/**
 * 登记/更新一部短剧。data 需含 series_id 与 episodes。
 * 已有的不覆盖 episodes（避免接口异常时把好数据冲掉），仅补全标题与封面。
 */
function upsertSeriesRegistry(data) {
  if (!data || !data.series_id || !Array.isArray(data.episodes) || data.episodes.length === 0) return;
  const sid = String(data.series_id);
  const idx = seriesRegistry.findIndex((s) => String(s.series_id) === sid);
  const previous = idx === -1 ? null : seriesRegistry[idx];
  const now = Date.now();
  const beforeSave = seriesRegistry.slice();
  const entry = {
    series_id: sid,
    // 远端偶发返回空标题/封面时，继续使用本地已知值，避免一次失败响应冲掉展示信息。
    series_title: data.series_title || previous?.series_title || '未命名短剧',
    cover: data.cover || previous?.cover || '',
    // 来源平台的原始简介；这次没读到时沿用之前存的，避免一次异常响应把它清空。
    synopsis: data.synopsis || previous?.synopsis || '',
    total: data.episodes.length,
    web_accessible_episodes: data.web_accessible_episodes ?? previous?.web_accessible_episodes ?? null,
    episodes: data.episodes.map((e) => ({
      vid: String(e.vid),
      vid_index: e.vid_index || 0,
      title: e.title || '',
      cover: e.cover || '',
      web_available: e.web_available ?? null,
      locked: e.locked === true,
    })),
    // updatedAt 继续保留给旧版本使用；新界面读取 episodesUpdatedAt。
    updatedAt: now,
    episodesUpdatedAt: now,
    dismissed: false, // 用户主动移除过；再次登记时自动恢复显示
  };
  if (idx === -1) seriesRegistry.unshift(entry);
  else seriesRegistry[idx] = { ...seriesRegistry[idx], ...entry, dismissed: false };
  try {
    saveSeriesRegistry();
  } catch (error) {
    // 磁盘写入失败时回滚内存，避免界面看到一份下次启动会消失的假档案。
    seriesRegistry = beforeSave;
    throw error;
  }
  return seriesRegistry.find((s) => String(s.series_id) === sid) || entry;
}

/** 播放页/合并选择器可见的短剧（过滤掉被用户移除的） */
function visibleSeries() {
  return seriesRegistry.filter((s) => !s.dismissed);
}

// 批量刷新共享锁：更新剧集只读取远端目录，不会创建下载任务。
let refreshAllSeriesInProgress = false;

function seriesEpisodeIndices(list) {
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((episode) => Number(episode?.vid_index))
      .filter((index) => Number.isFinite(index) && index > 0),
  );
}

/**
 * 逐剧刷新远端分集目录。每一部剧独立捕获错误，失败时不写入本地档案，
 * 这样临时网络故障不会把已有总集数/分集列表清空。
 */
async function refreshOneSeries(entry) {
  const seriesId = String(entry.series_id);
  const previousEpisodes = Array.isArray(entry.episodes) ? entry.episodes : [];
  const previousIndices = seriesEpisodeIndices(previousEpisodes);
  const previousTotal = Number(entry.total) || previousEpisodes.length;
  try {
    let data;
    // 官网网页版可绕过 60 秒目录缓存，作为普通红果剧的强制刷新入口；
    // 备用接口仍由 fetchEpisodeList 负责，HEMA/西饭来源则直接走各自适配器。
    if (!/^((hema|xifan):)/.test(seriesId) && typeof hongguo.fetchEpisodeListFromWeb === 'function') {
      try {
        data = await hongguo.fetchEpisodeListFromWeb(seriesId);
      } catch (webError) {
        data = await hongguo.fetchEpisodeList(seriesId, { forceRefresh: true });
      }
    } else {
      data = await hongguo.fetchEpisodeList(seriesId, { forceRefresh: true });
    }
    if (!data || !Array.isArray(data.episodes) || data.episodes.length === 0) {
      throw new Error('远端没有返回有效分集列表');
    }

    // 只有拿到完整且非空列表才写入；upsert 内部还会保留空标题/封面时的旧值。
    upsertSeriesRegistry(data);
    const latest = seriesRegistry.find((item) => String(item.series_id) === seriesId) || entry;
    // 更新剧集时，给已经下载过的剧补上缺的封面/简介（没下载过的剧不建文件夹）。
    const claimed = claimedSeriesFolder(seriesId);
    if (claimed && fs.existsSync(path.join(downloadRoot(), claimed))) {
      void writeSeriesInfoFiles(seriesId, path.join(downloadRoot(), claimed));
    }
    const latestEpisodes = Array.isArray(latest.episodes) ? latest.episodes : [];
    const latestIndices = seriesEpisodeIndices(latestEpisodes);
    let addedCount = 0;
    for (const index of latestIndices) if (!previousIndices.has(index)) addedCount++;
    let removedCount = 0;
    for (const index of previousIndices) if (!latestIndices.has(index)) removedCount++;
    return {
      seriesId,
      seriesTitle: latest.series_title || entry.series_title || '未命名短剧',
      success: true,
      previousTotal,
      total: latestEpisodes.length,
      addedCount,
      removedCount,
      episodesUpdatedAt: Number(latest.episodesUpdatedAt || latest.updatedAt) || Date.now(),
    };
  } catch (error) {
    return {
      seriesId,
      seriesTitle: entry.series_title || '未命名短剧',
      success: false,
      previousTotal,
      total: previousEpisodes.length,
      addedCount: 0,
      removedCount: 0,
      episodesUpdatedAt: Number(entry.episodesUpdatedAt || entry.updatedAt) || 0,
      error: error?.message || String(error),
    };
  }
}

async function refreshAllSeries() {
  if (refreshAllSeriesInProgress) return { success: false, error: '正在更新剧集，请稍候' };
  refreshAllSeriesInProgress = true;
  // 下载管理只展示有下载记录的短剧；批量更新与该页面保持一致，
  // 不把用户仅浏览过但从未下载的档案也纳入请求。
  const downloadedIds = new Set(
    downloadTasks
      .map((task) => task.hongguoInfo?.series_id)
      .filter((seriesId) => seriesId !== undefined && seriesId !== null)
      .map((seriesId) => String(seriesId)),
  );
  const targets = visibleSeries().filter((entry) => downloadedIds.has(String(entry.series_id)));
  const results = [];
  let addedEpisodes = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      // 顺序请求，避免同时击穿来源站点；每一部结束后立即通知界面进度。
      const result = await refreshOneSeries(targets[i]);
      results.push(result);
      if (result.success) addedEpisodes += result.addedCount;
      sendToRenderer('series-refresh-progress', { done: i + 1, total: targets.length, result });
    }
    const succeeded = results.filter((result) => result.success).length;
    const failed = results.length - succeeded;
    return {
      success: failed === 0,
      total: results.length,
      succeeded,
      failed,
      addedEpisodes,
      results,
    };
  } finally {
    refreshAllSeriesInProgress = false;
  }
}

// ===== 下载队列调度 =====
// 说明：这里必须「立即返回」。早期实现写成 `await executeDownload(task)`，
// 会让一次调用只启动一个任务、并一直阻塞到该任务结束，
// 导致并发数恒为 1（无论 max_concurrent 设为多少）。
// 现在由 runTask 自行在结束时回调 pumpQueue，调度器只负责按并发上限派发。
function pumpQueue() {
  downloadQueue = downloadQueue.filter((task) => task.status === 'pending');
  for (const task of downloadQueue) repairTaskDestination(task);
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    const index = downloadQueue.findIndex(
      (task) => !runningDownloads.has(task.id) && !runningDownloadPaths.has(task.savePath),
    );
    if (index < 0) break;
    const [task] = downloadQueue.splice(index, 1);
    runningDownloads.add(task.id);
    runningDownloadPaths.add(task.savePath);
    activeDownloads++;
    downloadRuns.set(task.id, runTask(task));
  }
  // 让下载管理器立即看到队列和并发槽位变化，不必等下一次轮询。
  sendToRenderer('download-queue-changed', {
    active: activeDownloads,
    queued: downloadQueue.length,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  });
}

async function runTask(task) {
  const destination = task.savePath;
  try {
    await executeDownload(task);
  } catch (error) {
    console.error('[Download Queue] 下载失败:', error);
  } finally {
    activeDownloads--;
    runningDownloads.delete(task.id);
    runningDownloadPaths.delete(destination);
    downloadRuns.delete(task.id);
    sendToRenderer('download-queue-changed', {
      active: activeDownloads,
      queued: downloadQueue.length,
      maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    });
    pumpQueue();
  }
}

// 保留旧名，内部逻辑保持不变（多处调用点仍在用）
function processDownloadQueue() {
  pumpQueue();
}

/** 把等待中的任务重新排进队列（用于启动时自动续跑 / 一键启动） */
function enqueuePendingTasks() {
  const pending = downloadTasks.filter((t) => t.status === 'pending' && !downloadQueue.some((q) => q.id === t.id));
  for (const t of pending) downloadQueue.push(t);
  return pending.length;
}

/**
 * 一键暂停：取消范围内进行中的任务、移出等待队列、把等待中的标记为已停止。
 * 返回被暂停的任务数。
 */
function pauseAllTasks(taskIds) {
  if (taskIds?.size === 0) return 0;
  let stopped = 0;
  for (const task of downloadTasks) {
    if (taskIds && !taskIds.has(task.id)) continue;
    if (task.status === 'pending') {
      task.status = 'stopped';
      task.error = '已手动暂停';
      task.endTime = Date.now();
      stopped++;
    } else if (task.status === 'downloading') {
      task.cancelled = true;
      if (task.cancelSource) {
        try {
          task.cancelSource.cancel('用户一键暂停');
        } catch (_) {}
      }
      if (task.writer) {
        try {
          task.writer.destroy();
        } catch (_) {}
      }
      task.status = 'stopped';
      delete task.cancelSource;
      delete task.writer;
      stopped++;
    }
  }
  downloadQueue = taskIds ? downloadQueue.filter((task) => !taskIds.has(task.id)) : [];
  saveDownloadTasks();
  sendToRenderer('download-queue-changed', {});
  return stopped;
}

/**
 * 一键启动：把范围内未完成（已停止 / 失败 / 等待中）的任务重新排队开跑。
 * 返回重新排队任务数。
 */
function resumeAllTasks(taskIds) {
  if (taskIds?.size === 0) return 0;
  let count = 0;
  for (const task of downloadTasks) {
    if (taskIds && !taskIds.has(task.id)) continue;
    if (
      task.status !== 'stopped' &&
      task.status !== 'failed' &&
      task.status !== 'pending' &&
      !(task.status === 'completed' && !hasCompleteTaskFile(task))
    )
      continue;

    repairTaskDestination(task);
    task.status = 'pending';
    task.progress = 0;
    task.receivedBytes = 0;
    task.totalBytes = 0;
    task.cancelled = false;
    delete task.error;
    delete task.cancelSource;
    delete task.writer;

    if (!downloadQueue.some((t) => t.id === task.id)) downloadQueue.push(task);
    count++;
  }
  if (count > 0) {
    saveDownloadTasks();
    pumpQueue();
  }
  sendToRenderer('download-queue-changed', {});
  return count;
}

// ===== 下载分发 =====
async function executeDownload(task) {
  if (task.type === 'hongguo') {
    await executeHongguoDownload(task);
    return;
  }
  throw new Error('未知任务类型: ' + task.type);
}

// ===== 红果短剧下载 =====
async function executeHongguoDownload(task) {
  const { id, hongguoInfo, filename } = task;
  const { vid, series_title } = hongguoInfo || {};
  const source = axios.CancelToken.source();
  task.cancelSource = source;
  let tmpPath, writer;
  try {
    task.status = 'downloading';
    task.cancelled = false;
    task.progress = 0;
    sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0 });
    const downloadDir = task.customDir || seriesFolder(series_title, hongguoInfo?.series_id);
    fs.mkdirSync(downloadDir, { recursive: true });
    const finalPath = task.savePath || path.join(downloadDir, filename);
    task.savePath = finalPath;
    // Recheck source access before reusing an existing third-party file or URL.
    const checkedPlayInfo = /^(xifan|hema):/.test(String(vid))
      ? await hongguo.fetchPlayUrlSingle(vid, hongguoInfo?.series_id)
      : null;
    if (checkedPlayInfo && !checkedPlayInfo.url) throw new Error(checkedPlayInfo.error || '来源未开放该集');
    // Existing complete files need no additional media transfer.
    source.token.throwIfRequested();
    if (hasCompleteTaskFile(task)) {
      task.status = 'completed';
      task.progress = 100;
      task.endTime = Date.now();
      markPipelineDownloaded(task, finalPath);
      saveDownloadTasks();
      sendToRenderer('download-completed', { id, path: finalPath });
      return;
    }
    const playInfo = checkedPlayInfo || (await hongguo.fetchPlayUrlSingle(vid, hongguoInfo?.series_id));
    source.token.throwIfRequested();
    if (!playInfo?.url) throw new Error(playInfo?.error || '未获取到有效播放地址');
    tmpPath = finalPath + '.enc.tmp';
    const response = await requestMedia(playInfo, { cancelToken: source.token });
    source.token.throwIfRequested();
    const totalLength = Number(response.headers['content-length']) || 0;
    task.totalBytes = totalLength;
    writer = fs.createWriteStream(tmpPath);
    task.writer = writer;
    let received = 0,
      lastProgress = 0;
    response.data.on('data', (chunk) => {
      received += chunk.length;
      task.receivedBytes = received;
      task.progress = totalLength ? Math.min(99, Math.floor((received / totalLength) * 100)) : 0;
      if (Date.now() - lastProgress >= 150 || received === totalLength) {
        sendToRenderer('download-progress', {
          id,
          progress: task.progress,
          receivedBytes: received,
          totalBytes: totalLength,
        });
        lastProgress = Date.now();
      }
    });
    // pipeline rejects on either side and destroys both streams (including abrupt CDN close).
    await pipeline(response.data, writer);
    source.token.throwIfRequested();
    if (totalLength && received !== totalLength) throw new Error('视频下载不完整，请重试');
    if (playInfo.contentKey) {
      const decodedPath = tmpPath + '.decoded';
      try {
        await decryptContentKeyFile(tmpPath, decodedPath, playInfo.contentKey, { cancelToken: source.token });
        source.token.throwIfRequested();
        fs.renameSync(decodedPath, finalPath);
      } finally {
        try {
          fs.unlinkSync(decodedPath);
        } catch (_) {}
      }
      fs.unlinkSync(tmpPath);
    } else if (playInfo.spadeA) {
      const key = hongguo.deriveKey(playInfo.spadeA);
      if (!key) throw new Error('Key 派生失败');
      // Decrypt to another temporary file; never expose partial data as a completed MP4.
      const decodedPath = tmpPath + '.decoded';
      try {
        await decryptInWorker({ srcPath: tmpPath, dstPath: decodedPath, key }, { cancelToken: source.token });
        source.token.throwIfRequested();
        fs.renameSync(decodedPath, finalPath);
      } finally {
        try {
          fs.unlinkSync(decodedPath);
        } catch (_) {}
      }
      fs.unlinkSync(tmpPath);
    } else fs.renameSync(tmpPath, finalPath);
    task.status = 'completed';
    task.progress = 100;
    task.endTime = Date.now();
    markPipelineDownloaded(task, finalPath);
    saveDownloadTasks();
    sendToRenderer('download-completed', { id, path: finalPath });
  } catch (error) {
    if (writer && !writer.destroyed) writer.destroy();
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
    // A retry may already be queued; the cancelled old run must not overwrite it.
    if (source.token.reason || axios.isCancel(error) || task.cancelled) {
      if (task.status !== 'pending') {
        task.status = 'stopped';
        task.error = '';
        task.endTime = Date.now();
        sendToRenderer('download-stopped', { id });
      }
    } else {
      task.status = 'failed';
      task.error = error.message;
      // 保留错误码和 HTTP 状态，管理剧集里据此分辨是资源缺失还是网络失败。
      task.errorCode = error.code || '';
      task.errorStatus = error.response?.status || 0;
      task.endTime = Date.now();
      sendToRenderer('download-failed', { id, error: error.message });
    }
    saveDownloadTasks();
  } finally {
    if (task.cancelSource === source) delete task.cancelSource;
    if (task.writer === writer) delete task.writer;
  }
}

// 向渲染进程发送事件
function sendToRenderer(channel, payload) {
  const window = mainWindow;
  if (rendererClosing || !window) return false;
  try {
    if (typeof window.isDestroyed === 'function' && window.isDestroyed()) return false;
    const contents = window.webContents;
    if (!contents) return false;
    if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false;
    contents.send(channel, payload);
    return true;
  } catch (error) {
    // Electron throws when a close/destroy race wins between the checks above
    // and webContents.send().  Ignore only that lifecycle error; unexpected
    // send failures still surface so they are diagnosable.
    const message = String(error?.message || error || '');
    if (/object has been destroyed|webcontents.*destroy|render.?frame.*destroy|disposed/i.test(message)) return false;
    throw error;
  }
}

// ===== IPC：红果解析与批量下载 =====
ipcMain.handle('hongguo-resolve', async (event, input) => {
  try {
    const seriesId = await hongguo.resolveSeriesId(input);
    const data = await hongguo.fetchEpisodeList(seriesId);
    upsertSeriesRegistry(data);
    return { success: true, data };
  } catch (error) {
    console.error('[Hongguo] 解析失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== 搜索：内嵌浏览器嗅探 hongguoduanju.com =====
const SEARCH_SITE = 'https://hongguoduanju.com';
const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SEARCH_TIMEOUT_MS = 15000;

function sourcePageUrl(value) {
  const url = new URL(value);
  if (url.origin !== SEARCH_SITE || url.username || url.password) throw new Error('仅允许打开红果来源页面');
  return url.href;
}

let searchWindow = null;
let searchWindowReady = null;

function getSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) return searchWindow;
  searchWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: '搜索 - 红果短剧',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // 站内跳转保持在同一个窗口内，避免弹出新窗口
  searchWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      searchWindow.loadURL(sourcePageUrl(url)).catch(() => {});
    } catch (_) {}
    return { action: 'deny' };
  });
  searchWindow.on('closed', () => {
    searchWindow = null;
    searchWindowReady = null;
  });
  return searchWindow;
}

/**
 * 通用卡片提取脚本（分类页 / 搜索页共用）。
 * 只依赖链接里的 series_id（不依赖 hash 类名），剧名优先取 img[alt]，
 * 这样站点改版时更不容易失效。
 */
const SNIFFER_JS = `(() => {
  const out = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a')).filter((a) =>
    /series_id=\\d{6,}/.test(a.getAttribute('href') || '')
  );
  for (const a of links) {
    const m = (a.getAttribute('href') || '').match(/series_id=(\\d{6,})/);
    if (!m) continue;
    const sid = m[1];
    if (seen.has(sid)) continue;
    seen.add(sid);

    const img = a.querySelector('img');
    let title = (img && img.getAttribute('alt')) || '';
    if (!title) {
      const t = a.querySelector('[class*="title"]');
      title = (t ? t.textContent : a.textContent || '').trim();
    }

    // 封面：优先 picture>source[srcset]（分类页用 picture），兜底 img[src]
    let cover = '';
    const pic = a.querySelector('picture');
    if (pic) {
      const src = pic.querySelector('source[srcset]');
      if (src) cover = (src.getAttribute('srcset') || '').split(' ')[0];
    }
    if (!cover && img) cover = img.getAttribute('src') || img.getAttribute('data-src') || '';

    // 总集数：「全86集」
    let episode_count = 0;
    const epEl = a.querySelector('[class*="episode"]');
    if (epEl) {
      const em = (epEl.textContent || '').match(/(\\d+)\\s*集/);
      if (em) episode_count = parseInt(em[1], 10);
    }

    // 标签
    const tags = Array.from(a.querySelectorAll('[class*="tag-text"]'))
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 4);

    out.push({
      series_id: sid,
      series_title: title.trim(),
      cover: cover,
      episode_count: episode_count,
      tags: tags,
    });
  }
  return JSON.stringify(out);
})()`;

/**
 * 分类页附加信息：分页元数据 + 可用的题材筛选项。
 * 题材从页面里的 /category/<cat>/<genre> 链接提取，避免硬编码。
 */
const BROWSE_META_JS = `(() => {
  const out = { page: 1, totalPages: 0, total: 0, genres: [] };

  // 1) 优先读页面内嵌的分页数据
  try {
    const html = document.documentElement.innerHTML;
    const m = html.match(/"pagination":\\s*\\{[^}]*"total":(\\d+)[^}]*"pageNum":(\\d+)[^}]*"pageSize":(\\d+)[^}]*"totalPages":(\\d+)/);
    if (m) {
      out.total = parseInt(m[1], 10);
      out.page = parseInt(m[2], 10);
      out.totalPages = parseInt(m[4], 10);
    }
  } catch (e) {}

  // 2) 兜底：从分页链接推算总页数
  if (!out.totalPages) {
    let maxPage = 0;
    document.querySelectorAll('a[href*="page="]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    out.totalPages = maxPage;
  }

  // 3) 题材筛选项：/category/<cat>/<genre>
  const seen = new Set();
  document.querySelectorAll('a[href*="/category/"]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/category\\/[a-z0-9\\-]+\\/([a-z0-9\\-]+)/);
    if (!m) return;
    const slug = m[1];
    const label = (a.textContent || '').trim();
    if (!label || label.length > 8 || seen.has(slug)) return;
    seen.add(slug);
    out.genres.push({ slug: slug, label: label });
  });

  return JSON.stringify(out);
})()`;

/** 页面结构与搜索页一致，分类页复用同一个嗅探 + 串行队列 */
async function runSniffOnUrl(url, label) {
  const win = getSearchWindow();

  // 同一窗口串行执行，避免并发导航互相打断
  const task = async () => {
    console.log(`[${label}] 打开:`, url);
    try {
      await win.loadURL(url, { userAgent: SEARCH_UA });
    } catch (e) {
      // loadURL 在页面内有重定向/中断时也可能 reject，这里继续尝试读取 DOM
      console.warn(`[${label}] loadURL 返回异常（继续尝试读取）:`, e.message);
    }

    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    let last = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const raw = await win.webContents.executeJavaScript(SNIFFER_JS, true);
        last = JSON.parse(raw || '[]');
      } catch (e) {
        last = [];
      }
      if (last.length > 0) break;
    }

    let meta = { page: 1, totalPages: 0, total: 0, genres: [] };
    try {
      meta = JSON.parse((await win.webContents.executeJavaScript(BROWSE_META_JS, true)) || '{}');
    } catch (_) {}

    if (!last.length) {
      // 兜底：把页面标题带回去，便于用户判断是「无结果」还是「被拦」
      let pageTitle = '';
      try {
        pageTitle = await win.webContents.executeJavaScript('document.title', true);
      } catch (_) {}
      return { success: true, results: [], pageTitle, meta };
    }

    const results = last
      .filter((r) => r.series_id && r.series_title)
      .map((r) => ({
        ...r,
        url: `${SEARCH_SITE}/detail?series_id=${r.series_id}`,
      }));

    console.log(`[${label}] 命中 ${results.length} 部`);
    return { success: true, results, meta };
  };

  // 串行化
  const prev = searchWindowReady || Promise.resolve();
  const next = prev.then(task, task);
  searchWindowReady = next.catch(() => {});
  return next;
}

async function runSearchSniff(keyword) {
  return runSniffOnUrl(`${SEARCH_SITE}/search/${encodeURIComponent(keyword)}`, 'Search');
}

// ===== 浏览：分类页（含题材筛选与分页）=====
const BROWSE_CATEGORIES = [
  { slug: 'real-drama', label: '真人剧' },
  { slug: 'comic-drama', label: '漫剧' },
  { slug: 'ai-drama', label: 'AI剧' },
  { slug: 'comic', label: '漫画' },
];

ipcMain.handle('browse-categories', async () => BROWSE_CATEGORIES);

ipcMain.handle('browse-list', (_event, options) =>
  require(options?.source === 'xifan' ? './src/native/xifan' : './src/native/catalog').browseList(options),
);

ipcMain.handle('search-series', async (event, keyword, options = {}) => {
  const kw = String(keyword || '').trim();
  if (!kw) return { success: false, error: '请输入搜索关键词' };
  try {
    if (options?.source === 'hema') return await require('./src/native/hema').search(kw);
    if (options?.source === 'xifan') return await require('./src/native/xifan').search(kw);
    return await runSearchSniff(kw);
  } catch (error) {
    console.error('[Search] 失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 搜索选中某部剧后，拉取完整分集并登记档案
ipcMain.handle('search-resolve', async (event, seriesId) => {
  try {
    if (!seriesId) return { success: false, error: '缺少 series_id' };
    const data = await hongguo.fetchEpisodeList(String(seriesId));
    upsertSeriesRegistry(data);
    return { success: true, data };
  } catch (error) {
    console.error('[Search] 拉取分集失败:', error.message);
    return { success: false, error: error.message };
  }
});

/** 批量检查所有已登记短剧的最新总集数（只更新档案，不自动下载）。 */
ipcMain.handle('refresh-all-series', async () => {
  try {
    return await refreshAllSeries();
  } catch (error) {
    console.error('[Series] 批量更新失败:', error.message);
    return { success: false, error: error.message, total: 0, succeeded: 0, failed: 0, addedEpisodes: 0, results: [] };
  }
});

// 搜索窗口可见性（超时兜底：让用户自己操作）
ipcMain.handle('search-window-show', async (event, visible, sourceUrl) => {
  let target;
  try {
    if (sourceUrl) target = sourcePageUrl(sourceUrl);
  } catch (error) {
    return { success: false, error: error.message };
  }
  const win = getSearchWindow();
  if (target) {
    try {
      await win.loadURL(target, { userAgent: SEARCH_UA });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  if (visible) {
    win.show();
    win.focus();
  } else {
    win.hide();
  }
  return { success: true };
});

// 已登记的短剧档案（不含被用户移除的）
ipcMain.handle('get-series-list', async () => visibleSeries());

/** 从列表移除一部短剧（只取消登记，不删本地文件） */
ipcMain.handle('remove-series', async (event, seriesId) => {
  const sid = String(seriesId);
  const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
  if (!entry) return { success: false, error: '未找到该剧' };
  entry.dismissed = true;
  saveSeriesRegistry();
  return { success: true };
});

/** 批量移除没有下载过任何一集的短剧（清理浏览时留下的空档案） */
ipcMain.handle('purge-empty-series', async () => {
  let removed = 0;
  for (const s of seriesRegistry) {
    if (s.dismissed) continue;
    // 注意：必须同时检查「任务记录」和「磁盘上真实存在的文件」。
    // 只看任务记录会误判——任务记录可能被清空或跨会话缺失，而文件还在。
    const sid = String(s.series_id);
    const hasTaskFile = downloadTasks.some(
      (t) =>
        t.hongguoInfo &&
        String(t.hongguoInfo.series_id) === sid &&
        t.savePath &&
        fs.existsSync(t.savePath) &&
        fs.statSync(t.savePath).size > 1024 * 100,
    );
    let hasDiskFile = false;
    if (!hasTaskFile) {
      try {
        hasDiskFile = seriesFilePaths(sid).some((p) => fs.existsSync(p) && fs.statSync(p).size > 1024 * 100);
      } catch (_) {}
    }
    if (!hasTaskFile && !hasDiskFile) {
      s.dismissed = true;
      removed++;
    }
  }
  if (removed > 0) saveSeriesRegistry();
  return { success: true, count: removed };
});

/** 恢复显示被移除的短剧 */
ipcMain.handle('restore-dismissed-series', async () => {
  let n = 0;
  for (const s of seriesRegistry) {
    if (s.dismissed) {
      s.dismissed = false;
      n++;
    }
  }
  if (n > 0) saveSeriesRegistry();
  return { success: true, count: n };
});

ipcMain.handle('dismissed-count', async () => seriesRegistry.filter((s) => s.dismissed).length);

// ===== 一键合并（ffmpeg concat 流复制，无损且快）=====
let mergeTasks = []; // { id, seriesId, seriesTitle, status, progress, output, total, done, error }
const MAX_CONCURRENT_MERGES = 2;

function resolveFfmpeg(name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    // 可执行资源必须位于 asar 外；Finder 启动不依赖终端的 PATH。
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', executable) : null,
    path.join(__dirname, 'build', 'ffmpeg', `${process.platform}-${process.arch}`, executable),
    path.join(__dirname, 'build', 'ffmpeg', executable),
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, executable)),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch (_) {}
  }
  // 兜底：扫 winget 安装目录
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (base && fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (!/ffmpeg/i.test(d)) continue;
        const exe = path.join(base, d);
        const found = findFileRecursive(exe, `${name}.exe`, 6);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

function findFileRecursive(dir, fileName, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const r = findFileRecursive(path.join(dir, e.name), fileName, depth - 1);
    if (r) return r;
  }
  return null;
}

// ===== 管理剧集的处理日志：按剧文件夹记录，存在应用数据目录，切页面、重启后还在 =====
let activityLogStore = null;
function libraryLog() {
  if (!activityLogStore) {
    activityLogStore = libraryActivity.createActivityLog({
      file: path.join(app.getPath('userData'), 'library-activity.json'),
    });
  }
  return activityLogStore;
}
function libLog(dir, level, text, channel = 'main') {
  if (!dir) return;
  try {
    libraryLog().add(dir, level, text, channel);
  } catch (_) {
    /* 日志写不进去不影响处理本身。 */
  }
  sendToRenderer('library-activity', { dir: path.resolve(String(dir)) });
}
/** 正在分析切点的剧：dir -> { done, total }。分析发生在任务入队之前，单独记一份。 */
const libraryPlanning = new Map();

// ===== 视频处理（quchong_app 逻辑的 Node/FFmpeg 实现） =====
// 处理任务独立于下载任务，避免把长时间转码误显示成下载进度。
const quchongBatches = new Map();
// 多个处理批次可以同时运行；预留输出路径，避免两个批次在文件尚未落盘时选到同名目标。
const quchongOutputReservations = new Set();
const quchongInputRuns = new Map();
const QUCHONG_MAX_ACTIVE = 8;
let quchongActive = 0;
let quchongHistory = [];

function quchongPathKey(file) {
  if (!file) return '';
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function markQuchongInput(file) {
  const key = quchongPathKey(file);
  if (!key) return;
  quchongInputRuns.set(key, (quchongInputRuns.get(key) || 0) + 1);
}

function unmarkQuchongInput(file) {
  const key = quchongPathKey(file);
  if (!key) return;
  const count = (quchongInputRuns.get(key) || 0) - 1;
  if (count > 0) quchongInputRuns.set(key, count);
  else quchongInputRuns.delete(key);
}

/** 一个任务用到的所有源文件（重新拆分的一集可能由几个原集拼成）。 */
function quchongTaskInputs(task) {
  return task.segments ? [...new Set(task.segments.map((segment) => segment.src))] : [task.src];
}

function quchongOutputIsValid(file) {
  try {
    return !!file && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch (_) {
    return false;
  }
}

function allocateQuchongDestinations(sources, outputDirs, names = null) {
  const reserved = new Set(sources.map(quchongPathKey));
  return sources.map((source, sourceIndex) => {
    const parsed = path.parse(source);
    const base = names?.[sourceIndex] || `${parsed.name}_去重`;
    let index = 0;
    let candidate;
    do {
      candidate = path.join(outputDirs[sourceIndex], `${base}${index ? `_${index}` : ''}.mp4`);
      index += 1;
    } while (
      reserved.has(quchongPathKey(candidate)) ||
      quchongOutputReservations.has(quchongPathKey(candidate)) ||
      fs.existsSync(candidate)
    );
    const key = quchongPathKey(candidate);
    reserved.add(key);
    quchongOutputReservations.add(key);
    return candidate;
  });
}

function releaseQuchongDestinations(batch) {
  for (const task of batch.tasks || []) {
    if (task.dst) quchongOutputReservations.delete(quchongPathKey(task.dst));
  }
}

function quchongTaskPayload(task) {
  return {
    id: task.id,
    src: task.src,
    dst: task.dst,
    name: task.label || path.basename(task.src),
    status: task.status,
    // 阶段与时间戳用于区分排队、处理和收尾，避免只看百分比误判任务状态。
    stage: task.stage || (task.status === 'completed' ? 'completed' : task.status),
    // 这一集由哪些原集拼成（重新拆分时可能是几集）。
    episodes: task.episodes || [],
    progress: task.progress || 0,
    error: task.error || '',
    startedAt: task.startedAt || null,
    endTime: task.endTime || null,
    updatedAt: task.updatedAt || null,
    path: task.status === 'completed' ? task.dst : undefined,
  };
}

function serializeQuchongBatch(batch) {
  const tasks = (batch.tasks || []).map((task) => quchongTaskPayload(task));
  const done = tasks.filter((task) => task.status === 'completed').length;
  return {
    id: batch.id,
    status: batch.status || (batch.finished ? (batch.cancelled ? 'stopped' : 'completed') : 'queued'),
    createdAt: batch.createdAt || Date.now(),
    startedAt: batch.startedAt || null,
    endTime: batch.endTime || null,
    outputDir: batch.outputDir || '',
    libraryDir: batch.libraryDir || '',
    modeText: batch.modeText || '',
    concurrency: batch.concurrency,
    total: tasks.length,
    done,
    progress: tasks.length
      ? Math.floor(tasks.reduce((sum, task) => sum + Number(task.progress || 0), 0) / tasks.length)
      : 0,
    tasks,
  };
}

function getQuchongSnapshots() {
  const snapshots = new Map(quchongHistory.map((batch) => [batch.id, batch]));
  for (const batch of quchongBatches.values()) snapshots.set(batch.id, serializeQuchongBatch(batch));
  return [...snapshots.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 50);
}

function saveQuchongHistory() {
  try {
    store.saveQuchongTasks(quchongHistory.slice(0, 50));
    return true;
  } catch (error) {
    console.error('[Quchong] 保存任务快照失败:', error.message);
    return false;
  }
}

function persistQuchongBatch(batch) {
  const snapshot = serializeQuchongBatch(batch);
  const index = quchongHistory.findIndex((item) => String(item.id) === String(batch.id));
  if (index < 0) quchongHistory.unshift(snapshot);
  else quchongHistory[index] = snapshot;
  saveQuchongHistory();
  sendToRenderer('quchong-history-changed', { tasks: getQuchongSnapshots() });
}

function loadQuchongTasks() {
  try {
    const saved = store.getQuchongTasks() || [];
    let changed = false;
    quchongHistory = saved
      .filter((item) => item && item.id)
      .slice(0, 50)
      .map((item) => {
        const snapshot = { ...item, tasks: Array.isArray(item.tasks) ? item.tasks.map((task) => ({ ...task })) : [] };
        if (['running', 'queued'].includes(snapshot.status)) {
          snapshot.status = 'stopped';
          snapshot.endTime = Date.now();
          changed = true;
        }
        snapshot.tasks = snapshot.tasks.map((task) => {
          if (
            ['running', 'processing', 'pending', 'queued'].includes(task.status) ||
            ['processing', 'queued'].includes(task.stage)
          ) {
            changed = true;
            return {
              ...task,
              status: 'stopped',
              stage: 'stopped',
              error: '应用关闭时任务中断',
              endTime: snapshot.endTime || Date.now(),
              updatedAt: Date.now(),
            };
          }
          if (task.status === 'completed' && !quchongOutputIsValid(task.dst)) {
            changed = true;
            return {
              ...task,
              status: 'failed',
              stage: 'failed',
              progress: 0,
              error: '输出文件不存在或已损坏，请重新处理',
              updatedAt: Date.now(),
            };
          }
          return task;
        });
        snapshot.done = snapshot.tasks.filter((task) => task.status === 'completed').length;
        snapshot.total = snapshot.tasks.length;
        snapshot.progress = snapshot.total
          ? Math.floor(snapshot.tasks.reduce((sum, task) => sum + Number(task.progress || 0), 0) / snapshot.total)
          : 0;
        if (snapshot.tasks.some((task) => task.status === 'failed')) snapshot.status = 'failed';
        else if (snapshot.tasks.some((task) => task.status === 'stopped')) snapshot.status = 'stopped';
        return snapshot;
      });
    if (changed) saveQuchongHistory();
  } catch (error) {
    quchongHistory = [];
    console.error('[Quchong] 读取任务快照失败:', error.message);
  }
}

function pumpAllQuchongBatches() {
  for (const batch of quchongBatches.values()) pumpQuchongBatch(batch);
}

function logQuchongTask(batch, task, level, text) {
  libLog(batch.libraryDir, level, `${task.label || path.basename(String(task.src || ''))}：${text}`);
}

function emitQuchongTask(batch, task) {
  sendToRenderer('quchong-task', { batchId: batch.id, task: quchongTaskPayload(task) });
}

function emitQuchongLog(batch, task, force = false) {
  if (!task.logBuffer?.length) return;
  const now = Date.now();
  if (!force && now - (task.lastLogEmitAt || 0) < 200) return;
  const line = task.logBuffer.splice(0).join('\n');
  task.lastLogEmitAt = now;
  sendToRenderer('quchong-log', { batchId: batch.id, taskId: task.id, line });
}

function finishQuchongBatch(batch) {
  if (batch.finished || batch.active > 0 || batch.queue.length > 0) return;
  batch.finished = true;
  batch.status = batch.cancelled
    ? 'stopped'
    : batch.tasks.every((task) => task.status === 'completed')
      ? 'completed'
      : 'failed';
  batch.endTime = Date.now();
  persistQuchongBatch(batch);
  const tasks = batch.tasks.map(quchongTaskPayload);
  {
    const count = (status) => tasks.filter((task) => task.status === status).length;
    const failed = count('failed');
    const stopped = count('stopped');
    libLog(
      batch.libraryDir,
      failed ? 'error' : stopped ? 'warn' : 'ok',
      `这一批处理${batch.status === 'completed' ? '全部完成' : '结束'}：成功 ${count('completed')} 集${failed ? `，失败 ${failed} 集` : ''}${stopped ? `，停止 ${stopped} 集` : ''}`,
    );
  }
  // 勾选了「生成剪映草稿」：去重完成的成品接着生成草稿。
  const draftTask = batch.sideTasks?.jianyingDraft;
  if (draftTask?.enabled && batch.libraryDir && !batch.cancelled) {
    const outputs = batch.tasks.filter((task) => task.status === 'completed' && task.dst).map((task) => task.dst);
    if (outputs.length) {
      startLibraryDrafts({ dir: batch.libraryDir, files: outputs, mode: draftTask.mode, scope: draftTask.scope }).then(
        (started) => {
          if (!started.success) {
            libLog(batch.libraryDir, 'error', `剪映草稿：这一批没有自动生成：${started.error}`, 'side');
          }
        },
      );
    } else libLog(batch.libraryDir, 'warn', '剪映草稿：这一批没有成功的去重成品，没有生成草稿', 'side');
  }
  sendToRenderer('quchong-complete', {
    batchId: batch.id,
    cancelled: batch.cancelled,
    success: !batch.cancelled && tasks.every((task) => task.status === 'completed'),
    tasks,
  });
  releaseQuchongDestinations(batch);
  quchongBatches.delete(batch.id);
}

function pumpQuchongBatch(batch) {
  if (batch.finished) return;
  while (!batch.cancelled && batch.active < batch.concurrency && batch.queue.length) {
    if (quchongActive >= QUCHONG_MAX_ACTIVE) break;
    const task = batch.queue.shift();
    task.status = 'running';
    task.stage = 'processing';
    task.startedAt = task.startedAt || Date.now();
    task.updatedAt = Date.now();
    task.progress = 0;
    batch.active += 1;
    quchongActive += 1;
    batch.status = 'running';
    batch.startedAt = batch.startedAt || Date.now();
    persistQuchongBatch(batch);
    for (const file of quchongTaskInputs(task)) markQuchongInput(file);
    const controller = new AbortController();
    batch.controllers.set(task.id, controller);
    emitQuchongTask(batch, task);
    logQuchongTask(
      batch,
      task,
      'info',
      task.episodes?.length ? `开始处理（原第 ${task.episodes.join('、')} 集）` : '开始处理',
    );
    quchong
      .runJob({
        ffmpegPath: batch.ffmpegPath,
        ffprobePath: batch.ffprobePath,
        src: task.src,
        dst: task.dst,
        segments: task.segments || null,
        speed: task.speed ?? null,
        bgm: batch.bgm,
        opts: batch.opts,
        signal: controller.signal,
        onStage: (stage) => {
          if (stage === 'encoding' && task.stage !== 'encoding') logQuchongTask(batch, task, 'info', '开始编码');
          task.stage = stage;
          task.updatedAt = Date.now();
          emitQuchongTask(batch, task);
          persistQuchongBatch(batch);
        },
        onProgress: (progress) => {
          task.progress = progress;
          task.updatedAt = Date.now();
          if (task.lastProgressEmitAt && task.updatedAt - task.lastProgressEmitAt < 200 && progress < 100) return;
          task.lastProgressEmitAt = task.updatedAt;
          sendToRenderer('quchong-progress', {
            batchId: batch.id,
            taskId: task.id,
            progress,
            stage: task.stage,
            updatedAt: task.updatedAt,
          });
        },
        onLog: (line) => {
          task.logBuffer = task.logBuffer || [];
          task.logBuffer.push(String(line));
          if (task.logBuffer.length > 40) task.logBuffer.splice(0, task.logBuffer.length - 40);
          emitQuchongLog(batch, task);
        },
      })
      .then((result) => {
        task.status = 'completed';
        task.stage = 'completed';
        task.progress = 100;
        task.path = result.path;
        logQuchongTask(
          batch,
          task,
          'ok',
          `完成，用时 ${Math.max(1, Math.round((Date.now() - (task.startedAt || Date.now())) / 1000))} 秒 → 去重/${path.basename(task.dst)}`,
        );
        if (!task.segments) markPipelineDeduped(task.src, task.dst);
      })
      .catch((error) => {
        task.status = batch.cancelled || controller.signal.aborted ? 'stopped' : 'failed';
        task.stage = task.status;
        task.progress = 0;
        task.error = error?.message || String(error);
        task.logBuffer = task.logBuffer || [];
        task.logBuffer.push(`[${task.status === 'failed' ? '失败' : '停止'}] ${task.error}`);
        if (task.status === 'failed') logQuchongTask(batch, task, 'error', `失败：${task.error}`);
        else logQuchongTask(batch, task, 'warn', '已停止');
      })
      .finally(() => {
        task.endTime = Date.now();
        task.updatedAt = task.endTime;
        emitQuchongLog(batch, task, true);
        batch.controllers.delete(task.id);
        batch.active -= 1;
        quchongActive = Math.max(0, quchongActive - 1);
        for (const file of quchongTaskInputs(task)) unmarkQuchongInput(file);
        emitQuchongTask(batch, task);
        persistQuchongBatch(batch);
        pumpAllQuchongBatches();
        finishQuchongBatch(batch);
      });
  }
  if (batch.cancelled) {
    while (batch.queue.length) {
      const task = batch.queue.shift();
      task.status = 'stopped';
      task.stage = 'stopped';
      task.error = '已取消';
      task.endTime = Date.now();
      task.updatedAt = task.endTime;
      emitQuchongTask(batch, task);
    }
  }
  if (batch.cancelled) persistQuchongBatch(batch);
  finishQuchongBatch(batch);
}

function cancelAllQuchongBatches() {
  for (const batch of quchongBatches.values()) {
    batch.cancelled = true;
    for (const controller of batch.controllers.values()) controller.abort();
    pumpQuchongBatch(batch);
  }
}

ipcMain.handle('quchong-defaults', () => ({
  ...quchong.DEFAULTS,
  jobs: getCurrentSettings().quchong_jobs,
  // 编码器在应用启动时已经从 Chromium 的显卡信息里选定，这里只读缓存。
  encoder: quchong.resolveEncoder(quchong.DEFAULTS.encoder),
}));

// 下载管理与视频处理页使用同一个去重并发设置；修改后立即填充空闲槽位。
ipcMain.handle('quchong-set-concurrency', async (_event, value) => {
  const jobs = value;
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > QUCHONG_MAX_ACTIVE) {
    return { success: false, error: `去重并发数必须是 1-${QUCHONG_MAX_ACTIVE} 的整数` };
  }
  try {
    store.saveSettings({ ...getCurrentSettings(), quchong_jobs: jobs });
    for (const batch of quchongBatches.values()) {
      if (!batch.finished) {
        batch.concurrency = jobs;
        persistQuchongBatch(batch);
      }
    }
    pumpAllQuchongBatches();
    sendToRenderer('quchong-concurrency-changed', { jobs });
    return { success: true, jobs };
  } catch (error) {
    return { success: false, error: error?.message || '去重并发设置保存失败' };
  }
});

ipcMain.handle('get-quchong-tasks', () => getQuchongSnapshots());

ipcMain.handle('quchong-select-videos', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('reconstruction-select-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('quchong-select-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '音频文件', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ===== 一键处理：独立菜单，自带任务状态，不读写其他页面的队列和记录 =====
const { createOneclick } = require('./src/native/oneclick');
const oneclick = createOneclick({
  quchong,
  openai,
  resolveFfmpeg: (name) => resolveFfmpeg(name),
  getSettings: () => getCurrentSettings(),
  send: (channel, payload) => sendToRenderer(channel, payload),
});
ipcMain.handle('oneclick-scan', (_event, dir) => oneclick.scan(dir));
ipcMain.handle('oneclick-start', (_event, payload) => oneclick.start(payload || {}));
ipcMain.handle('oneclick-stop', () => oneclick.stop());
ipcMain.handle('oneclick-status', () => oneclick.status());
ipcMain.handle('oneclick-clear-logs', () => oneclick.clearLogs());
ipcMain.handle('oneclick-select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

/** 建一个去重批次并放进队列。tasks 里每项至少有 src、dst，重新拆分的还有 segments、speed、label。 */
function registerQuchongBatch({
  opts,
  bgm = null,
  outputDir,
  ffmpegPath,
  ffprobePath,
  tasks,
  libraryDir = '',
  modeText = '',
  sideTasks = null,
}) {
  const id = randomUUID();
  const batch = {
    id,
    opts,
    bgm,
    outputDir,
    libraryDir,
    modeText,
    sideTasks,
    ffmpegPath,
    ffprobePath,
    concurrency: Math.min(opts.jobs, QUCHONG_MAX_ACTIVE),
    createdAt: Date.now(),
    startedAt: null,
    endTime: null,
    status: 'queued',
    queue: [],
    active: 0,
    controllers: new Map(),
    cancelled: false,
    finished: false,
    tasks: tasks.map((task) => ({
      id: randomUUID(),
      status: 'pending',
      stage: 'queued',
      progress: 0,
      error: '',
      startedAt: null,
      endTime: null,
      updatedAt: Date.now(),
      episodes: libraryActivity.sourceEpisodes(task, seriesLibrary.parseEpisodeIndex),
      ...task,
    })),
  };
  batch.queue = [...batch.tasks];
  quchongBatches.set(id, batch);
  persistQuchongBatch(batch);
  libLog(
    libraryDir,
    'info',
    `已加入去重队列：${batch.tasks.length} 集${modeText ? `（${modeText}）` : ''}，成品放进「去重」文件夹`,
  );
  batch.tasks.forEach((task) => emitQuchongTask(batch, task));
  // 先把 batchId 返回给渲染进程，再开始跑第一条任务，避免极短视频的完成事件抢在响应之前。
  setImmediate(() => pumpAllQuchongBatches());
  return {
    success: true,
    batchId: id,
    status: quchongActive >= QUCHONG_MAX_ACTIVE ? 'queued' : 'running',
    tasks: batch.tasks.map(quchongTaskPayload),
  };
}

/**
 * 重新拆分：把选中的集接成连续时间线，按成品时长范围切成新的集，每一集交给去重队列处理。
 * 规划阶段会先分析切点（镜头切换、说话停顿），分析结果缓存在应用私有目录。
 */
async function startResplitBatch(args) {
  const dir = args.dir;
  libraryPlanning.set(dir, { done: 0, total: args.files.length });
  libLog(dir, 'info', `开始规划重新拆分：${args.files.length} 集，先分析切点`);
  try {
    const result = await planAndQueueResplit(args);
    if (result.success) {
      const summary = result.summary;
      libLog(
        dir,
        'ok',
        `切点分析完成：将生成 ${summary.count} 集，成品约 ${Math.round(summary.minSeconds)}–${Math.round(summary.maxSeconds)} 秒`,
      );
      for (const warning of result.warnings || []) libLog(dir, 'warn', warning);
    } else libLog(dir, 'error', `没有开始处理：${result.error || '规划失败'}`);
    return result;
  } catch (error) {
    libLog(dir, 'error', `没有开始处理：${error?.message || error}`);
    throw error;
  } finally {
    libraryPlanning.delete(dir);
    sendToRenderer('library-activity', { dir });
  }
}

async function planAndQueueResplit({ dir, files, split, opts, outputDir, sideTasks = null, title = '' }) {
  const options = quchong.validateOptions({ jobs: getCurrentSettings().quchong_jobs, ...opts });
  const splitOptions = resplit.validateSplit(split);
  const ffmpegPath = resolveFfmpeg('ffmpeg');
  const ffprobePath = resolveFfmpeg('ffprobe');
  if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到 FFmpeg/ffprobe，请先配置内置 FFmpeg' };
  if (files.length > 400) return { success: false, error: '单次最多处理 400 集' };

  // 按集号顺序接起来；认不出集号的排在最后。
  const ordered = files
    .map((file) => ({ file, index: seriesLibrary.parseEpisodeIndex(path.basename(file)) }))
    .sort((a, b) => {
      if ((a.index === null) !== (b.index === null)) return a.index === null ? 1 : -1;
      return a.index !== b.index ? a.index - b.index : a.file.localeCompare(b.file, 'zh-CN', { numeric: true });
    });

  const progress = (done, total) => {
    libraryPlanning.set(dir, { done, total });
    sendToRenderer('library-plan-progress', { stage: 'analyze', dir, done, total });
  };
  progress(0, ordered.length);
  const durations = new Map();
  for (const item of ordered) {
    const media = await quchong.probeMedia(ffprobePath, item.file);
    if (!media.has_video) return { success: false, error: `这个文件没有视频轨：${path.basename(item.file)}` };
    durations.set(item.file, media.video_duration > 0 ? media.video_duration : media.duration);
  }
  const analysis = await resplit.analyzeSources({
    ffmpegPath,
    files: ordered.map((item) => item.file),
    cacheDir: path.join(app.getPath('userData'), 'resplit-cache'),
    onProgress: progress,
  });

  const sources = ordered.map((item, position) => {
    const duration = durations.get(item.file);
    const previous = ordered[position - 1];
    return {
      file: item.file,
      duration,
      candidates: resplit.cutCandidates(
        analysis.get(item.file) || {},
        splitOptions.head_trim,
        duration - splitOptions.tail_trim,
      ),
      // 集号不连续的地方（缺集）标出来，切点会优先落在这里。
      gapBefore: !!previous && item.index !== null && previous.index !== null && item.index !== previous.index + 1,
    };
  });
  const plan = resplit.planPieces({
    sources,
    split: splitOptions,
    speedMin: options.speed_min,
    speedMax: options.speed_max,
    intro: options.black_intro ? 0.3 : 0,
  });
  if (!plan.pieces.length) return { success: false, error: plan.warnings.join('；') || '没有可处理的内容' };

  // 新的一版开始前，旧成品挪进废纸篓：成品文件夹里只留最新一版。
  const retired = await retireLibraryOutputs(dir);
  if (retired) libLog(dir, 'info', `「去重」里的旧成品 ${retired} 个已挪进废纸篓，这一版重新生成`);
  await fsp.mkdir(outputDir, { recursive: true });
  const seriesName =
    sanitizeFolderName(title) || libraryReleaseTitle(dir) || sanitizeFolderName(path.basename(dir)) || '短剧';
  const names = plan.pieces.map((piece) => `${seriesName}_第${String(piece.number).padStart(3, '0')}集`);
  const destinations = allocateQuchongDestinations(
    plan.pieces.map((piece) => piece.segments[0].file),
    plan.pieces.map(() => outputDir),
    names,
  );
  const result = registerQuchongBatch({
    opts: options,
    outputDir,
    libraryDir: dir,
    modeText: '重新拆分',
    sideTasks,
    ffmpegPath,
    ffprobePath,
    tasks: plan.pieces.map((piece, index) => ({
      src: piece.segments[0].file,
      segments: piece.segments.map((segment) => ({
        src: segment.file,
        start: segment.start,
        duration: segment.duration,
      })),
      speed: piece.speed,
      label: path.basename(destinations[index], '.mp4'),
      dst: destinations[index],
    })),
  });
  const finals = plan.pieces.map((piece) => piece.finalDuration);
  return {
    ...result,
    warnings: plan.warnings,
    summary: { count: plan.pieces.length, minSeconds: Math.min(...finals), maxSeconds: Math.max(...finals) },
  };
}

async function startQuchongBatch(payload = {}) {
  try {
    const sources = [...new Set(Array.isArray(payload.sources) ? payload.sources : [])].map((file) =>
      path.resolve(String(file)),
    );
    if (!sources.length) return { success: false, error: '请先选择视频文件' };
    if (sources.length > 200) return { success: false, error: '单次最多处理 200 个视频' };
    for (const file of sources) {
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile()) return { success: false, error: `找不到输入文件：${file}` };
    }
    if (payload.outputDir != null && typeof payload.outputDir !== 'string') {
      return { success: false, error: '请选择有效的输出目录' };
    }
    const outputDir = configuredDir(payload.outputDir, 'dedup_output_dir', '去重输出目录');
    const outputDirs = sources.map(() => outputDir);
    await fsp.mkdir(outputDir, { recursive: true });
    const opts = quchong.validateOptions({ jobs: getCurrentSettings().quchong_jobs, ...payload.opts });
    const bgm = payload.bgm ? path.resolve(String(payload.bgm)) : null;
    if (bgm) {
      const stat = await fsp.stat(bgm).catch(() => null);
      if (!stat?.isFile()) return { success: false, error: `找不到 BGM 文件：${bgm}` };
    }
    const ffmpegPath = resolveFfmpeg('ffmpeg');
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到 FFmpeg/ffprobe，请先配置内置 FFmpeg' };

    const pendingSources = new Set(
      [...quchongBatches.values()].flatMap((batch) =>
        batch.tasks
          .filter((task) => ['pending', 'running'].includes(task.status))
          .map((task) => quchongPathKey(task.src)),
      ),
    );
    const duplicate = sources.find((file) => pendingSources.has(quchongPathKey(file)));
    if (duplicate) return { success: false, error: `视频已在去重队列中：${path.basename(duplicate)}` };

    const destinations = allocateQuchongDestinations(sources, outputDirs);
    const libraryDir =
      typeof payload.libraryDir === 'string' &&
      seriesLibrary.isLibraryFolder(payload.libraryDir, downloadRoot(), libraryFolders().list())
        ? path.resolve(payload.libraryDir)
        : '';
    return registerQuchongBatch({
      opts,
      bgm,
      outputDir,
      libraryDir,
      modeText: libraryDir ? '按原集去重' : '',
      sideTasks: libraryDir ? normalizeSideTasks(payload.sideTasks) : null,
      ffmpegPath,
      ffprobePath,
      tasks: sources.map((src, index) => ({ src, dst: destinations[index] })),
    });
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}
ipcMain.handle('quchong-start', (_event, payload) => startQuchongBatch(payload));

// ===== 管理剧集：一个文件夹就是一部剧，集以文件夹里实际存在的视频为准 =====
let libraryFolderList = null;
function libraryFolders() {
  if (!libraryFolderList) {
    libraryFolderList = seriesLibrary.createFolderList(path.join(app.getPath('userData'), 'library-folders.json'));
  }
  return libraryFolderList;
}

/** 剧文件夹对应的剧档案（只有软件下载过的剧才有）。 */
function linkedSeriesEntries() {
  const byId = new Map(seriesRegistry.map((entry) => [String(entry.series_id), entry]));
  const result = new Map();
  for (const [name, id] of seriesFolderOwners()) {
    const entry = byId.get(String(id));
    if (entry) result.set(name, entry);
  }
  return result;
}

function libraryFolderRecords() {
  const linked = linkedSeriesEntries();
  return seriesLibrary.scanLibrary(downloadRoot(), libraryFolders().list()).map((folder) => {
    const entry = !folder.imported ? linked.get(folder.name.toLowerCase()) : null;
    const { coverPath, ...rest } = folder;
    return {
      ...rest,
      coverUrl: coverPath ? localAssetUrl(coverPath) : entry?.cover || '',
      source: entry ? seriesInfo.sourceLabel(entry.series_id) : '',
      seriesId: entry ? String(entry.series_id) : '',
      totalEpisodes: entry ? Number(entry.total) || 0 : 0,
      linked: !!entry,
    };
  });
}

ipcMain.handle('library-list', () => {
  try {
    return { success: true, root: downloadRoot(), folders: libraryFolderRecords() };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 一部剧的处理进度、补下载任务和日志：全部由主进程保存，页面切走再回来、重启应用后都还在。 */
ipcMain.handle('library-activity', (_event, dir) => {
  try {
    const folder = path.resolve(String(dir || ''));
    if (!seriesLibrary.isLibraryFolder(folder, downloadRoot(), libraryFolders().list())) {
      return { success: false, error: '这不是剧文件夹' };
    }
    const same = (other) => !!other && libraryActivity.dirKey(other) === libraryActivity.dirKey(folder);
    const planning = [...libraryPlanning].find(([key]) => same(key));
    return {
      success: true,
      dir: folder,
      planning: planning ? planning[1] : null,
      batches: getQuchongSnapshots()
        .filter((batch) => same(batch.libraryDir))
        .slice(0, 10),
      jobs: [...libraryJobs.values()].filter((job) => same(job.dir)).map(libraryJobSnapshot),
      draft: libraryDraftSnapshot(libraryDraftJobs.get(folder)),
      logs: libraryLog().list(folder, 300),
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 打开剧文件夹，或它里面的「去重」成品文件夹。 */
ipcMain.handle('library-open-folder', async (_event, dir, which) => {
  try {
    const folder = path.resolve(String(dir || ''));
    if (!seriesLibrary.isLibraryFolder(folder, downloadRoot(), libraryFolders().list())) {
      return { success: false, error: '这不是剧文件夹' };
    }
    const target = which === 'output' ? path.join(folder, '去重') : folder;
    if (!fs.existsSync(target)) return { success: false, error: '这个文件夹还不存在' };
    const error = await shell.openPath(target);
    return error ? { success: false, error } : { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('library-activity-clear', (_event, dir) => {
  try {
    libraryLog().clear(path.resolve(String(dir || '')));
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 总任务：所有剧的处理、下载、补下载一张表。 */
ipcMain.handle('library-overview', () => {
  try {
    return {
      success: true,
      ...libraryActivity.buildOverview({
        folders: libraryFolderRecords(),
        batches: getQuchongSnapshots(),
        downloads: downloadTasks,
        jobs: [...libraryJobs.values()],
        planning: libraryPlanning,
      }),
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 这部剧每一集的下载任务：集号 -> { state: 'active' | 'failed', task 摘要 }。 */
function libraryTaskInfo(seriesId) {
  const info = new Map();
  for (const task of downloadTasks) {
    if (String(task.hongguoInfo?.series_id ?? '') !== String(seriesId)) continue;
    const index = Number(task.hongguoInfo?.vid_index);
    if (!(index > 0)) continue;
    const state = ['downloading', 'pending'].includes(task.status)
      ? 'active'
      : ['failed', 'stopped'].includes(task.status)
        ? 'failed'
        : null;
    if (!state || info.get(index)?.state === 'active') continue;
    const reason =
      task.status === 'failed'
        ? downloadErrors.classifyDownloadError({
            message: task.error,
            code: task.errorCode,
            status: task.errorStatus,
          })
        : null;
    info.set(index, {
      state,
      task: {
        id: task.id,
        status: task.status,
        progress: Number(task.progress) || 0,
        reason,
      },
    });
  }
  return info;
}

let gapNoteStore = null;
function libraryGapNotes() {
  if (!gapNoteStore) {
    gapNoteStore = seriesLibrary.createGapNotes(path.join(app.getPath('userData'), 'library-gaps.json'));
  }
  return gapNoteStore;
}

/** 一个剧文件夹的详情：磁盘上的集，以及集与集之间缺的是哪几集、为什么缺。 */
function libraryEpisodeDetail(dir) {
  const root = downloadRoot();
  const imported = libraryFolders().list();
  if (!seriesLibrary.isLibraryFolder(dir, root, imported)) return { success: false, error: '这不是剧文件夹' };
  const folder = path.resolve(String(dir));
  const isImported = imported.some((item) => path.resolve(item) === folder);
  const entry = isImported ? null : linkedSeriesEntries().get(path.basename(folder).toLowerCase());
  const remote = new Map((entry?.episodes || []).map((episode) => [Number(episode.vid_index), episode]));
  const cover = seriesInfo.findCover(folder);
  const episodes = seriesLibrary.scanEpisodes(folder).map((episode) => ({
    name: episode.name,
    path: episode.path,
    size: episode.size,
    index: episode.index,
    cover: remote.get(episode.index)?.cover || '',
  }));
  const onDisk = new Set(episodes.map((episode) => episode.index).filter((index) => index !== null));
  const taskInfo = entry ? libraryTaskInfo(entry.series_id) : new Map();
  const missing = seriesGaps.classifyMissing({
    onDisk,
    remote: entry ? entry.episodes || [] : null,
    tasks: new Map([...taskInfo].map(([index, item]) => [index, item.state])),
    // 排队中、下载中、失败的集即使排在已下载的最后一集之后，也要在列表里看得到。
    upTo: Math.max(0, ...onDisk, ...taskInfo.keys()),
  });
  const confirmed = libraryGapNotes().get(folder);
  return {
    success: true,
    dir: folder,
    name: path.basename(folder),
    imported: isImported,
    linked: !!entry,
    seriesId: entry ? String(entry.series_id) : '',
    remoteUpdatedAt: entry ? Number(entry.episodesUpdatedAt || entry.updatedAt) || 0 : 0,
    coverUrl: cover ? localAssetUrl(cover) : entry?.cover || '',
    synopsis: seriesInfo.readSynopsis(folder) || entry?.synopsis || '',
    outputDir: path.join(folder, '去重'),
    episodes,
    missing: missing.map((item) => ({
      ...item,
      task: taskInfo.get(item.index)?.task || null,
      state: item.state === 'unknown' && confirmed.has(item.index) ? 'confirmed' : item.state,
      text: seriesGaps.STATE_TEXT[item.state === 'unknown' && confirmed.has(item.index) ? 'confirmed' : item.state],
    })),
  };
}

ipcMain.handle('library-episodes', (_event, dir) => {
  try {
    return libraryEpisodeDetail(dir);
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 向来源平台核对最新的集列表（只读，不下载），再返回最新的详情；连不上就按上次记录。 */
ipcMain.handle('library-refresh-remote', async (_event, dir) => {
  try {
    const first = libraryEpisodeDetail(dir);
    if (!first.success || !first.linked) return first;
    const entry = seriesRegistry.find((item) => String(item.series_id) === first.seriesId);
    const refreshed = entry ? await refreshOneSeries(entry) : { success: false, error: '没有这部剧的档案' };
    return { ...libraryEpisodeDetail(dir), refreshed: !!refreshed.success, refreshError: refreshed.error || '' };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('library-import', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { success: true, dir: null };
    return { success: true, dir: libraryFolders().add(result.filePaths[0]) };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

// 只是不再显示这个文件夹，不会删除或改动里面的任何文件。
ipcMain.handle('library-remove-import', (_event, dir) => {
  try {
    libraryFolders().remove(dir);
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

// 「先补下载，下完自动继续」：补下载的集全部下完后，自动用完整的选择开始重新拆分。
const libraryJobs = new Map();
let LIBRARY_POLL_MS = 2000;
const LIBRARY_JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function libraryJobSnapshot(job) {
  const { timer, request, ...rest } = job;
  return rest;
}
function emitLibraryJob(job) {
  job.updatedAt = Date.now();
  sendToRenderer('library-job-update', libraryJobSnapshot(job));
}

function startLibraryDownloadJob({ dir, request, entry, indices, files }) {
  const byIndex = new Map(entry.episodes.map((episode) => [Number(episode.vid_index), episode]));
  const wanted = indices.map((index) => byIndex.get(index)).filter(Boolean);
  const job = {
    id: randomUUID(),
    dir,
    name: path.basename(dir),
    indices,
    status: 'waiting',
    message: `正在补下载${seriesGaps.describeIndices(indices)}，下完会自动开始处理`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  libraryJobs.set(job.id, job);
  libLog(dir, 'info', job.message);
  const finish = (status, message) => {
    clearInterval(job.timer);
    job.status = status;
    job.message = message;
    libLog(dir, status === 'failed' ? 'error' : 'ok', message);
    emitLibraryJob(job);
  };
  const tick = async () => {
    if (job.status !== 'waiting') return;
    if (Date.now() - job.createdAt > LIBRARY_JOB_TIMEOUT_MS)
      return finish('failed', '补下载等了太久，已放弃，请重新处理');
    const states = wanted.map((episode) => {
      const tasks = downloadTasks.filter((task) => String(task.hongguoInfo?.vid) === String(episode.vid));
      const done = tasks.find((task) => hasCompleteTaskFile(task));
      if (done) return { index: Number(episode.vid_index), state: 'done', file: done.savePath };
      if (tasks.some((task) => ['downloading', 'pending'].includes(task.status)))
        return { index: Number(episode.vid_index), state: 'waiting' };
      return { index: Number(episode.vid_index), state: 'failed' };
    });
    const finished = states.filter((item) => item.state === 'done').length;
    if (states.some((item) => item.state === 'waiting')) {
      const message = `正在补下载${seriesGaps.describeIndices(indices)}（${finished}/${states.length}），下完会自动开始处理`;
      if (message !== job.message) {
        job.message = message;
        emitLibraryJob(job);
      }
      return;
    }
    const failed = states.filter((item) => item.state === 'failed').map((item) => item.index);
    if (failed.length)
      return finish(
        'failed',
        `${seriesGaps.describeIndices(failed)}下载失败，没有开始处理。可以重试下载，或选择强制拼接。`,
      );
    job.status = 'starting';
    clearInterval(job.timer);
    emitLibraryJob(job);
    try {
      const all = [...new Set([...files, ...states.map((item) => item.file)])];
      const result = await startResplitBatch({ ...request, dir, files: all });
      if (result.success) {
        const s = result.summary;
        finish('started', `补下载完成，已开始处理：将生成 ${s.count} 集`);
      } else finish('failed', result.error || '补下载完成，但启动处理失败');
    } catch (error) {
      finish('failed', error?.message || String(error));
    }
  };
  job.timer = setInterval(() => void tick(), LIBRARY_POLL_MS);
  job.timer.unref?.();
  emitLibraryJob(job);
  return { job, wanted };
}

ipcMain.handle('library-jobs', () => [...libraryJobs.values()].slice(-20).map(libraryJobSnapshot));
ipcMain.handle('library-job-cancel', (_event, id) => {
  const job = libraryJobs.get(String(id));
  if (!job) return { success: false, error: '任务不存在' };
  if (job.status === 'waiting') {
    clearInterval(job.timer);
    job.status = 'cancelled';
    job.message = '已取消；补下载的集仍会继续下载，但不会自动开始处理';
    libLog(job.dir, 'warn', job.message);
    emitLibraryJob(job);
  }
  return { success: true };
});
ipcMain.handle('library-job-dismiss', (_event, id) => {
  const job = libraryJobs.get(String(id));
  if (job && job.status !== 'waiting' && job.status !== 'starting') libraryJobs.delete(job.id);
  return { success: true };
});

// ===== AI 发布素材：改写简介 / 改写剧名 / 重新生成海报 =====
// 结果直接放在剧文件夹里（发布剧名.txt / 发布简介.txt / 发布海报.jpg），无字底图和状态放在应用私有目录。
const publishJobs = new Map();

function publishWorkDir(dir) {
  const id = createHash('sha256')
    .update(path.resolve(String(dir)))
    .digest('hex')
    .slice(0, 12);
  return path.join(app.getPath('userData'), 'publish-data', id);
}

function publishContext(dir) {
  const detail = libraryEpisodeDetail(dir);
  if (!detail.success) throw new Error(detail.error || '这不是剧文件夹');
  const entry = detail.seriesId ? seriesRegistry.find((item) => String(item.series_id) === detail.seriesId) : null;
  return {
    dir: detail.dir,
    title: String(entry?.series_title || detail.name),
    synopsis: detail.synopsis || '',
    source: detail.seriesId ? seriesInfo.sourceLabel(detail.seriesId) : '',
    coverPath: seriesInfo.findCover(detail.dir),
    workDir: publishWorkDir(detail.dir),
  };
}

async function withTitleRenderer(run) {
  const renderer = posterTitle.createTitleRenderer({
    fontsDir: posterTitle.titleFontsDir({ resourcesPath: process.resourcesPath, projectRoot: __dirname }),
    driver: posterTitle.electronDriver(BrowserWindow),
  });
  try {
    return await run(renderer);
  } finally {
    await renderer.close().catch(() => {});
  }
}

function publishResultView(context) {
  const result = publishMaterials.readResult({ outputDir: context.dir, workDir: context.workDir });
  if (!result) return null;
  let posterUrl = '';
  if (result.hasPoster) {
    try {
      posterUrl = `${localAssetUrl(result.paths.poster)}?v=${Math.round(fs.statSync(result.paths.poster).mtimeMs)}`;
    } catch (_) {}
  }
  const { paths, ...rest } = result;
  return { ...rest, posterUrl, folder: context.dir };
}

function publishSnapshot(dir) {
  const job = publishJobs.get(dir);
  if (!job) return null;
  return { dir, status: job.status, task: job.task, stage: job.stage, message: job.message, error: job.error || '' };
}

function publishNotify(dir) {
  sendToRenderer('publish-update', publishSnapshot(dir));
}

/** 用表单里当前填的值试一次文本接口（没保存也能测），错误里不会带出 Key。 */
ipcMain.handle('test-ai-text', async (_event, draft = {}) => {
  const settings = { ...getCurrentSettings(), ...draft };
  const started = Date.now();
  try {
    const config = openai.requireApiConfig(settings);
    await openai.chat([{ role: 'user', content: '只回复 OK' }], { timeout: 30000 }, settings);
    return { success: true, model: config.textModel, elapsed: Date.now() - started };
  } catch (error) {
    return {
      success: false,
      error: openai.redactError(error, settings.ai_api_key),
    };
  }
});

ipcMain.handle('publish-state', (_event, dir) => {
  try {
    const context = publishContext(dir);
    return {
      success: true,
      job: publishSnapshot(context.dir),
      result: publishResultView(context),
      hasCover: !!context.coverPath,
      styles: posterStyles.STYLES.map((style) => ({ id: style.id, name: style.name })),
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

const PUBLISH_TASK_TEXT = { titles: '改写剧名', synopsis: '改写简介', poster: '生成海报' };

ipcMain.handle('publish-generate', (_event, payload = {}) => {
  try {
    const context = publishContext(payload.dir);
    const task = String(payload.task || '');
    if (!PUBLISH_TASK_TEXT[task]) return { success: false, error: '请选择要做的事：改写剧名、改写简介或生成海报' };
    if (publishJobs.get(context.dir)?.status === 'running') return { success: false, error: '这部剧正在生成中' };
    const controller = new AbortController();
    const job = { status: 'running', task, stage: task, message: '准备中', controller };
    publishJobs.set(context.dir, job);
    libLog(context.dir, 'info', `发布素材：开始${PUBLISH_TASK_TEXT[task]}`, 'side');
    publishNotify(context.dir);
    const settings = getCurrentSettings();
    (async () => {
      try {
        await withTitleRenderer((renderer) =>
          publishMaterials.generate({
            task,
            title: context.title,
            synopsis: context.synopsis,
            source: context.source,
            coverPath: context.coverPath,
            outputDir: context.dir,
            workDir: context.workDir,
            config: settings,
            openai,
            renderer,
            signal: controller.signal,
            onProgress: ({ stage, message }) => {
              if (message && message !== job.message) libLog(context.dir, 'info', `发布素材：${message}`, 'side');
              job.stage = stage;
              job.message = message;
              publishNotify(context.dir);
            },
          }),
        );
        job.status = 'done';
        job.message = '已完成';
        libLog(context.dir, 'ok', `发布素材：${PUBLISH_TASK_TEXT[task]}完成`, 'side');
        if (task === 'titles') renameLibraryOutputs(context.dir);
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = controller.signal.aborted ? '' : aiRedact(error);
        job.message = controller.signal.aborted ? '已取消' : '生成失败';
        if (controller.signal.aborted)
          libLog(context.dir, 'warn', `发布素材：${PUBLISH_TASK_TEXT[task]}已取消`, 'side');
        else libLog(context.dir, 'error', `发布素材：${PUBLISH_TASK_TEXT[task]}失败：${job.error}`, 'side');
      } finally {
        publishNotify(context.dir);
      }
    })();
    return { success: true };
  } catch (error) {
    return { success: false, error: aiRedact(error) };
  }
});

ipcMain.handle('publish-cancel', (_event, dir) => {
  try {
    const job = publishJobs.get(publishContext(dir).dir);
    if (job?.status === 'running') job.controller.abort();
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 换标题 / 样式 / 版式 / 角标：只重新排版，不再调用模型，几乎是即时的。 */
ipcMain.handle('publish-retitle', async (_event, payload = {}) => {
  try {
    const context = publishContext(payload.dir);
    if (publishJobs.get(context.dir)?.status === 'running') return { success: false, error: '这部剧正在生成中' };
    await withTitleRenderer((renderer) =>
      publishMaterials.retitle({
        outputDir: context.dir,
        workDir: context.workDir,
        renderer,
        title: payload.title,
        styleId: payload.styleId,
        tagline: payload.tagline,
        layout: payload.layout,
      }),
    );
    libLog(context.dir, 'ok', '发布素材：已记下剧名/样式，海报有的话已重新排版', 'side');
    renameLibraryOutputs(context.dir);
    return { success: true, result: publishResultView(context) };
  } catch (error) {
    return { success: false, error: aiRedact(error) };
  }
});

// ===== 成品命名：用 AI 发布素材里选定的新剧名 =====
const LIBRARY_OUTPUT_NAME = /^(.+)_第(\d+)集(?:_\d+)?\.mp4$/i;

/** 这部剧选定的新剧名（「AI 发布素材」里选的或填的）；还没选返回空字符串。 */
function libraryReleaseTitle(dir) {
  try {
    const result = publishMaterials.readResult({ outputDir: dir, workDir: publishWorkDir(dir) });
    return sanitizeFolderName(result?.title || '');
  } catch (_) {
    return '';
  }
}

/** 这部剧还有没有在分析、处理、排队或等补下载的任务；有就返回原因。 */
function libraryBusyReason(dir) {
  const key = path.resolve(dir);
  if (libraryPlanning.has(key) || libraryPlanning.has(dir)) return '这部剧正在分析切点，等它开始处理或先停止';
  for (const batch of quchongBatches.values()) {
    if (!batch.finished && batch.libraryDir && path.resolve(batch.libraryDir) === key) {
      return '这部剧正在处理，等这一批做完，或先点「停止」';
    }
  }
  for (const job of libraryJobs.values()) {
    if (path.resolve(job.dir) === key && ['waiting', 'starting'].includes(job.status)) {
      return '这部剧在等补下载，下完会自动处理；要重来请先取消';
    }
  }
  return '';
}

/**
 * 重新拆分前，把「去重」里的旧成品挪进废纸篓：成品文件夹里永远只有最新一版，
 * 不会出现「_1」这种重复的集，剪映草稿也不会挑到旧的。挪不进废纸篓时放到应用私有目录。
 */
async function retireLibraryOutputs(dir) {
  const output = path.join(dir, '去重');
  if (!fs.existsSync(output)) return 0;
  const files = fs
    .readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => path.join(output, entry.name));
  let moved = 0;
  for (const file of files) {
    try {
      if (typeof shell?.trashItem === 'function') await shell.trashItem(file);
      else throw new Error('no trash');
      moved += 1;
    } catch (_) {
      const keep = path.join(publishWorkDir(dir), 'replaced-outputs', String(Date.now()));
      fs.mkdirSync(keep, { recursive: true });
      fs.renameSync(file, path.join(keep, path.basename(file)));
      moved += 1;
    }
  }
  return moved;
}

/** 剧名改了：把「去重」里已有成品改成新剧名（集号不变）。有任务在跑时先不动。 */
function renameLibraryOutputs(dir) {
  const title = libraryReleaseTitle(dir);
  const output = path.join(dir, '去重');
  if (!title || !fs.existsSync(output)) return;
  const busy =
    libraryBusyReason(dir) || (libraryDraftJobs.get(path.resolve(dir))?.status === 'running' ? '剪映草稿正在生成' : '');
  const stale = fs
    .readdirSync(output)
    .map((name) => ({ name, match: LIBRARY_OUTPUT_NAME.exec(name) }))
    .filter((row) => row.match && row.match[1] !== title);
  if (!stale.length) return;
  if (busy) {
    libLog(dir, 'warn', `剧名已改成「${title}」，但${busy}，成品文件名先不改；做完后再改一次剧名即可同步`, 'side');
    return;
  }
  let renamed = 0;
  for (const row of stale) {
    const target = path.join(output, `${title}_第${row.match[2]}集.mp4`);
    if (fs.existsSync(target)) continue;
    fs.renameSync(path.join(output, row.name), target);
    renamed += 1;
  }
  if (renamed) libLog(dir, 'ok', `成品已按新剧名「${title}」改名：${renamed} 个文件`, 'side');
}

// ===== 管理剧集的支线任务：生成剪映草稿 =====
// 对「去重」成品逐集做结构化拆解（分镜 + 文案），再生成剪映草稿。多分轨沿用完整草稿；
// 三分轨（文案 / 视频 / 音频）直接用现成的分镜和字幕切原视频，不另外渲染分镜文件。两种方式前面的结构化分析步骤相同。
const libraryDraftJobs = new Map(); // 剧文件夹 -> 当前/最近一次草稿任务
const DRAFT_MODE_TEXT = { simple: '三分轨（文案·视频·音频）', multi: '多分轨（完整结构化拆解）' };
const DRAFT_STAGE_TEXT = {
  media: '读取视频信息',
  audio: '提取音频',
  shots: '检测分镜',
  separation: '人声 / 背景分离',
  transcript: '识别台词',
  alignment: '关联台词与分镜',
  clips: '导出分镜',
  export: '导出字幕',
  jianying: '生成剪映草稿',
};
const DRAFT_MODULES = [
  'media',
  'audio',
  'shots',
  'clips',
  'separation',
  'transcript',
  'alignment',
  'export',
  'jianying',
];

/** 支线任务：目前只有剪映草稿；没勾选就当没有。 */
function normalizeSideTasks(value) {
  const draft = value?.jianyingDraft;
  if (!draft?.enabled) return null;
  return {
    jianyingDraft: { enabled: true, mode: normalizeDraftMode(draft.mode), scope: normalizeDraftScope(draft.scope) },
  };
}

const DRAFT_SLOTS = 4;

/** 草稿只做指定的几集（最多 4 集，填的是成品集号）；没填就默认第 1–4 集。 */
function normalizeDraftScope(value) {
  const numbers = [...new Set((Array.isArray(value?.numbers) ? value.numbers : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n < 10000)
    .sort((a, b) => a - b)
    .slice(0, DRAFT_SLOTS);
  return { numbers: numbers.length || Array.isArray(value?.numbers) ? numbers : [1, 2, 3, 4] };
}

/**
 * 从去重成品里挑出要做草稿的集，按成品文件名里的集号（重新拆分后的新集号）判断；
 * 名单里成品里没有的集号放进 missing。
 */
function selectDraftFiles(files, scope) {
  const { numbers } = normalizeDraftScope(scope);
  const rows = files
    .map((file) => ({ file, index: seriesLibrary.parseEpisodeIndex(path.basename(file)) }))
    .filter((row) => numbers.includes(row.index))
    .sort((a, b) => a.index - b.index || a.file.localeCompare(b.file, 'zh-CN', { numeric: true }));
  const have = new Set(rows.map((row) => row.index));
  return { files: rows.map((row) => row.file), missing: numbers.filter((n) => !have.has(n)), numbers };
}

function normalizeDraftMode(value) {
  return value === 'multi' ? 'multi' : 'simple';
}

function draftCurrentText(job) {
  return [...job.active.values()].map((item) => item.label).join('、');
}
/** 正在做的各集进度之和（每集 0–100），界面用「已完成集数 + 这个和 / 100」算总进度条。 */
function draftProgressPercent(job) {
  return Math.floor([...job.active.values()].reduce((sum, item) => sum + item.progress, 0));
}
function draftMessage(job) {
  const items = [...job.active.values()];
  if (items.length === 1) return items[0].message;
  return items.length ? `同时做 ${items.length} 集` : '';
}

function libraryDraftSnapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    mode: job.mode,
    modeText: DRAFT_MODE_TEXT[job.mode],
    status: job.status,
    total: job.total,
    done: job.done,
    failed: job.failed,
    current: draftCurrentText(job),
    progress: draftProgressPercent(job),
    message: draftMessage(job),
    detail: job.active.size === 1 ? [...job.active.values()][0].detail : '',
    stageStartedAt: job.active.size === 1 ? [...job.active.values()][0].stageStartedAt : null,
    lanes: job.lanes || 1,
    startedAt: job.startedAt,
    endTime: job.endTime,
  };
}

function libraryDraftEmit(job) {
  sendToRenderer('library-activity', { dir: job.dir });
}

/** 去重文件夹里已有的成品视频（按集号/名称自然排序）。 */
function libraryDedupOutputs(dir) {
  const output = path.join(dir, '去重');
  if (!fs.existsSync(output)) return [];
  return fs
    .readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.mp4$/i.test(entry.name))
    .map((entry) => path.join(output, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN', { numeric: true }));
}

// ===== 剪映草稿同时做几集 =====
// 不是越多越好：每集的分析（检测分镜、人声分离）都吃 CPU 和内存，同时开太多反而全卡住。
const DRAFT_MAX_LANES = 4;
const DRAFT_LANE_MEMORY = 2.5 * 1024 ** 3; // 一集分析大约要用的内存
const DRAFT_LANE_MIN_THREADS = 2;

function draftThreadBudget() {
  const configured = Number(getCurrentSettings().structure_threads || 0);
  const cores = os.availableParallelism?.() || os.cpus().length || 1;
  return configured > 0 ? configured : Math.max(2, Math.min(8, cores - 2));
}

/** 现在这台电脑适合同时做几集：看线程预算、内存，有去重在跑或系统已经很忙就退回一集一集做。 */
function draftLanesAllowed() {
  const byThreads = Math.floor(draftThreadBudget() / DRAFT_LANE_MIN_THREADS);
  const byMemory = Math.floor((os.totalmem() * 0.5) / DRAFT_LANE_MEMORY);
  let lanes = Math.min(DRAFT_MAX_LANES, byThreads, byMemory);
  const cores = os.availableParallelism?.() || os.cpus().length || 1;
  const dedupRunning = [...quchongBatches.values()].some((batch) => !batch.finished);
  if (dedupRunning || os.loadavg()[0] > cores * 0.85) lanes = Math.min(lanes, 1);
  return Math.max(1, lanes);
}

/** 流水线同一时间最多放行几集：所有正在做草稿的剧各自的并行数之和，没有就是 1。 */
function libraryDraftSlots() {
  let slots = 0;
  for (const job of libraryDraftJobs.values()) if (job.status === 'running') slots += job.lanes || 1;
  return Math.max(1, slots);
}

/** 开始前先确认运行环境够用，免得拆解跑了很久才发现缺东西。 */
async function libraryDraftReadiness(mode) {
  if (!resolveJianyingRuntime()?.executable) return '缺少内置剪映运行时，请使用包含剪映运行时的完整安装包';
  const script = mode === 'simple' ? 'create-jianying-simple-draft.py' : 'create-jianying-draft.py';
  if (!resolveJianyingScript(script)) return `缺少草稿脚本 ${script}，请使用完整安装包`;
  try {
    const availability = await getReconstructionPipeline().availability();
    const bad = Object.values(availability.modules || {}).find((module) => !module.ready);
    if (bad) return bad.error || '内置结构化拆解运行时没准备好';
  } catch (error) {
    return error?.message || '内置结构化拆解运行时没准备好';
  }
  return '';
}

async function generateLibraryDraft(job, file, item) {
  const pipeline = getReconstructionPipeline();
  const label = path.basename(file, path.extname(file));
  const workRoot =
    String(getCurrentSettings().structure_output_dir || '').trim() ||
    path.join(app.getPath('userData'), 'structure-work');
  const projectId = `${label}-${createHash('sha256').update(file).digest('hex').slice(0, 8)}`;
  item.projectId = projectId;
  libraryDraftPlans.set(projectId, { mode: item.mode, fallbackRoot: path.join(job.dir, '剪映草稿') });
  try {
    await pipeline.start({ inputPath: file, projectId, outputRoot: workRoot, threads: job.threadsEach });
    let structure = await pipeline.wait(projectId);
    if (job.cancelled || structure?.status === 'stopped') throw Object.assign(new Error('已停止'), { stopped: true });
    const incomplete = DRAFT_MODULES.filter((id) => structure?.modules?.[id]?.status !== 'succeeded');
    if (incomplete.length) {
      throw new Error(structure?.error || `拆解没有完成：${incomplete.map((id) => DRAFT_STAGE_TEXT[id]).join('、')}`);
    }
    // 拆解结果是缓存复用的：以前生成的草稿和这次要的分轨方式不一样时，只重做最后一步。
    const manifestOf = (draftPath) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(draftPath, 'hongguo-draft-manifest.json'), 'utf8'));
      } catch (_) {
        return null;
      }
    };
    const current = manifestOf(structure.modules.jianying.summary?.draft_path || '');
    const isSimple = String(current?.schema || '').includes('simple');
    if (!current || isSimple !== (item.mode === 'simple')) {
      await pipeline.start({ inputPath: file, projectId, module: 'jianying', force: true, threads: job.threadsEach });
      structure = await pipeline.wait(projectId);
      if (job.cancelled || structure?.status === 'stopped') throw Object.assign(new Error('已停止'), { stopped: true });
      if (structure?.modules?.jianying?.status !== 'succeeded') {
        throw new Error(structure?.modules?.jianying?.error || structure?.error || '剪映草稿没有生成');
      }
    }
    return structure.modules.jianying.summary.draft_path;
  } finally {
    libraryDraftPlans.delete(projectId);
  }
}

/** 对这些去重成品逐集生成剪映草稿；后台运行，进度和日志写进这部剧的「支线任务日志」。 */
async function startLibraryDrafts({ dir, files: candidates, mode, scope }) {
  const key = path.resolve(dir);
  if (!candidates.length)
    return { success: false, error: '还没有去重成品，没法生成剪映草稿。请先勾选「去重」再开始。' };
  const { files, missing, numbers } = selectDraftFiles(candidates, scope);
  if (!numbers.length) return { success: false, error: '请填要做草稿的成品集号' };
  if (!files.length) {
    return { success: false, error: `去重成品里没有第 ${missing.join('、')} 集，没法生成剪映草稿` };
  }
  if (missing.length)
    libLog(path.resolve(dir), 'warn', `剪映草稿：成品里没有第 ${missing.join('、')} 集，已跳过`, 'side');
  const kind = normalizeDraftMode(mode);
  const problem = await libraryDraftReadiness(kind);
  if (problem) {
    libLog(key, 'error', `剪映草稿：没有开始：${problem}`, 'side');
    return { success: false, error: problem };
  }
  // 已经在生成：这几集排到后面接着做，不丢。
  const running = libraryDraftJobs.get(key);
  if (running?.status === 'running') {
    const queued = new Set(
      [...running.queue.map((item) => item.file), ...[...running.active.values()].map((item) => item.file)].filter(
        Boolean,
      ),
    );
    const added = files.filter((file) => !queued.has(file));
    for (const file of added) running.queue.push({ file, mode: kind });
    running.total += added.length;
    libLog(key, 'info', `剪映草稿：正在生成，这 ${added.length} 集排到后面接着做`, 'side');
    libraryDraftEmit(running);
    return { success: true, queued: added.length, job: libraryDraftSnapshot(running) };
  }
  const lanes = Math.max(1, Math.min(draftLanesAllowed(), files.length));
  const job = {
    id: randomUUID(),
    dir: key,
    mode: kind,
    queue: files.map((file) => ({ file, mode: kind })),
    active: new Map(), // 正在做的集：projectId -> { file, label, mode, progress, message, detail, stageStartedAt, lastStage }
    status: 'running',
    total: files.length,
    done: 0,
    failed: 0,
    lanes,
    threadsEach: Math.max(DRAFT_LANE_MIN_THREADS, Math.floor(draftThreadBudget() / lanes)),
    startedAt: Date.now(),
    endTime: null,
    cancelled: false,
  };
  libraryDraftJobs.set(key, job);
  libLog(
    key,
    'info',
    `剪映草稿：开始，共 ${files.length} 集（${DRAFT_MODE_TEXT[kind]}）${lanes > 1 ? `，同时做 ${lanes} 集、每集 ${job.threadsEach} 线程` : ''}`,
    'side',
  );
  libraryDraftEmit(job);

  // 一条「车道」一次做一集。第一条车道一直做到队列空；多出来的车道每次接新一集前都重新看一眼电脑忙不忙，
  // 忙了（开了去重、系统负载高）就自己退出，剩下的集由别的车道接着做，不会把电脑拖卡。
  const runLane = async (laneIndex) => {
    while (job.queue.length && !job.cancelled) {
      if (laneIndex > 0 && laneIndex >= draftLanesAllowed()) {
        libLog(key, 'info', '剪映草稿：电脑比较忙，少开一路，剩下的接着一集一集做', 'side');
        return;
      }
      const item = job.queue.shift();
      const label = path.basename(item.file, path.extname(item.file));
      const state = {
        file: item.file,
        label,
        mode: item.mode,
        progress: 0,
        message: '',
        detail: '',
        stageStartedAt: Date.now(),
        lastStage: '',
        projectId: null,
      };
      job.active.set(label, state);
      libLog(key, 'info', `剪映草稿：${label} 开始`, 'side');
      libraryDraftEmit(job);
      try {
        const draftPath = await generateLibraryDraft(job, item.file, state);
        job.done += 1;
        libLog(key, 'ok', `剪映草稿：${label} 已生成 → ${draftPath}`, 'side');
      } catch (error) {
        if (job.cancelled || error?.stopped) return;
        job.failed += 1;
        libLog(key, 'error', `剪映草稿：${label} 失败：${error?.message || error}`, 'side');
      } finally {
        job.active.delete(label);
      }
      libraryDraftEmit(job);
    }
  };
  (async () => {
    do {
      await Promise.all(Array.from({ length: job.lanes }, (_, index) => runLane(index)));
    } while (job.queue.length && !job.cancelled); // 车道都退出之后又有新的集排进来：接着做
    job.status = job.cancelled ? 'stopped' : job.failed ? 'failed' : 'completed';
    job.active.clear();
    job.queue = [];
    job.endTime = Date.now();
    libLog(
      key,
      job.status === 'completed' ? 'ok' : job.status === 'stopped' ? 'warn' : 'error',
      job.status === 'stopped'
        ? `剪映草稿：已停止，完成 ${job.done}/${job.total} 集`
        : `剪映草稿：结束，成功 ${job.done} 集${job.failed ? `，失败 ${job.failed} 集` : ''}`,
      'side',
    );
    libraryDraftEmit(job);
  })();
  return { success: true, job: libraryDraftSnapshot(job) };
}

/** 流水线每推进一步，就把这一集的进度和当前步骤记到对应的剧里。 */
function libraryDraftProgress(payload) {
  let job = null;
  let state = null;
  for (const item of libraryDraftJobs.values()) {
    if (item.status !== 'running') continue;
    for (const entry of item.active.values()) {
      if (entry.projectId === payload?.projectId) {
        job = item;
        state = entry;
      }
    }
  }
  if (!job) return;
  const stages = Object.values(payload?.modules || {});
  const finished = stages.filter((stage) => stage.status === 'succeeded').length;
  const currentProgress = payload?.modules?.[payload?.stage]?.progress;
  state.progress = Math.min(
    99,
    Math.floor(
      ((finished + (Number.isFinite(currentProgress) ? currentProgress / 100 : 0)) / DRAFT_MODULES.length) * 100,
    ),
  );
  const stage = payload?.stage;
  state.message = DRAFT_STAGE_TEXT[stage] || '';
  state.detail = String(payload?.modules?.[stage]?.message || '').slice(0, 80);
  if (stage && stage !== state.lastStage && DRAFT_STAGE_TEXT[stage]) {
    state.lastStage = stage;
    state.stageStartedAt = Date.now();
    libLog(job.dir, 'info', `剪映草稿：${state.label}：${DRAFT_STAGE_TEXT[stage]}`, 'side');
  }
  libraryDraftEmit(job);
}

ipcMain.handle('library-draft', async (_event, payload = {}) => {
  try {
    const dir = path.resolve(String(payload.dir || ''));
    if (!seriesLibrary.isLibraryFolder(dir, downloadRoot(), libraryFolders().list())) {
      return { success: false, error: '这不是剧文件夹' };
    }
    return await startLibraryDrafts({ dir, files: libraryDedupOutputs(dir), mode: payload.mode, scope: payload.scope });
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('library-draft-cancel', (_event, dir) => {
  try {
    const job = libraryDraftJobs.get(path.resolve(String(dir || '')));
    if (!job || job.status !== 'running') return { success: false, error: '没有在生成的剪映草稿' };
    job.cancelled = true;
    for (const item of job.active.values()) if (item.projectId) getReconstructionPipeline().cancel(item.projectId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 选中的文件是不是这部剧时间线上从第一集起的连续前缀。 */
function resplitSelectionIsPrefix(dir, files) {
  const ordered = seriesLibrary.scanEpisodes(dir).map((episode) => path.resolve(episode.path));
  const chosen = new Set(files.map((file) => path.resolve(file)));
  if (!chosen.size || chosen.size > ordered.length) return false;
  return ordered.slice(0, chosen.size).every((file) => chosen.has(file));
}

const episodeDurationCache = new Map();
async function cachedEpisodeDuration(ffprobePath, file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return 0;
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (episodeDurationCache.has(key)) return episodeDurationCache.get(key);
  const media = await quchong.probeMedia(ffprobePath, file).catch(() => null);
  const duration = media?.has_video ? (media.video_duration > 0 ? media.video_duration : media.duration) : 0;
  if (duration > 0) episodeDurationCache.set(key, duration);
  return duration;
}

/** 开始处理前的预览：按这些集的时长和当前参数，估一下会得到多少集。 */
ipcMain.handle('library-estimate', async (_event, payload = {}) => {
  try {
    const dir = path.resolve(String(payload.dir || ''));
    if (!seriesLibrary.isLibraryFolder(dir, downloadRoot(), libraryFolders().list())) {
      return { success: false, error: '这不是剧文件夹' };
    }
    const wanted = new Set(
      (Array.isArray(payload.files) ? payload.files : []).map((file) => path.resolve(String(file))),
    );
    const episodes = seriesLibrary.scanEpisodes(dir).filter((episode) => wanted.has(path.resolve(episode.path)));
    if (!episodes.length) return { success: false, error: '请先选择要处理的集' };
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffprobePath) return { success: false, error: '未找到 FFmpeg/ffprobe，请先配置内置 FFmpeg' };
    const options = quchong.validateOptions({ jobs: getCurrentSettings().quchong_jobs, ...payload.opts });
    const split = resplit.validateSplit(payload.split);
    const sources = [];
    let unreadable = 0;
    // 4 路并行读时长，读过的缓存起来，改参数后重新估算是即时的。
    for (let from = 0; from < episodes.length; from += 4) {
      const part = episodes.slice(from, from + 4);
      const durations = await Promise.all(part.map((episode) => cachedEpisodeDuration(ffprobePath, episode.path)));
      part.forEach((episode, i) => {
        if (durations[i] > 0) sources.push({ file: episode.path, duration: durations[i], index: episode.index });
        else unreadable += 1;
      });
    }
    const estimate = resplit.estimatePlan({
      sources,
      split,
      speedMin: options.speed_min,
      speedMax: options.speed_max,
      intro: options.black_intro ? 0.3 : 0,
    });
    const first = episodes[0].index;
    const last = episodes[episodes.length - 1].index;
    return {
      success: true,
      ...estimate,
      selectedCount: episodes.length,
      unreadable,
      firstEpisode: first,
      lastEpisode: last,
      startNumber: split.start_number,
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/**
 * 选中的集交给去重队列处理，成品放在 剧文件夹/去重/ 里。
 * 重新拆分会先看选中的集之间有没有缺集：平台没有的直接拼；没下载的要用户决定
 * （gapPolicy：download 先补下载 / force 强制拼接 / confirm 导入的文件夹确认本来就缺）。
 */
ipcMain.handle('library-dedup', async (_event, payload = {}) => {
  try {
    const dir = path.resolve(String(payload.dir || ''));
    if (!seriesLibrary.isLibraryFolder(dir, downloadRoot(), libraryFolders().list())) {
      return { success: false, error: '这不是剧文件夹' };
    }
    // 同一部剧同一时间只跑一批，免得两批互相覆盖、出现重复的集。
    const busy = libraryBusyReason(dir);
    if (busy) return { success: false, error: busy };
    // 没勾选「去重」、只勾了剪映草稿：直接拿已有的去重成品生成草稿。
    if (payload.dedup === false) {
      const draft = normalizeSideTasks(payload.sideTasks)?.jianyingDraft;
      if (!draft) return { success: false, error: '请至少勾选一项要做的事' };
      const started = await startLibraryDrafts({
        dir,
        files: libraryDedupOutputs(dir),
        mode: draft.mode,
        scope: draft.scope,
      });
      return started.success ? { ...started, draftOnly: true } : started;
    }
    const files = [
      ...new Set(Array.isArray(payload.files) ? payload.files.map((file) => path.resolve(String(file))) : []),
    ];
    if (!files.length) return { success: false, error: '请先选择要处理的集' };
    if (files.some((file) => path.dirname(file) !== dir || !seriesLibrary.VIDEO_EXT.test(file))) {
      return { success: false, error: '选中的文件不在这部剧的文件夹里' };
    }
    const outputDir = path.join(dir, '去重');
    const sideTasks = normalizeSideTasks(payload.sideTasks);
    // 成品用新剧名命名，所以要先在「AI 发布素材」里选定剧名。
    const title = libraryReleaseTitle(dir);
    if (!title) return { success: false, error: '先在上面「AI 发布素材」里选定新剧名，成品会用新剧名命名' };
    if (payload.mode === 'episode') {
      return await startQuchongBatch({ sources: files, outputDir, opts: payload.opts, libraryDir: dir, sideTasks });
    }
    // 重新拆分按时间线处理：整部，或者从第一集起的前面若干集，不能跳着选。
    if (!resplitSelectionIsPrefix(dir, files)) {
      return { success: false, error: '重新拆分要按时间线从第一集开始连续处理：选「整部」或「前 N 集」，不能跳着选。' };
    }

    const detail = libraryEpisodeDetail(dir);
    const selected = files.map((file) => seriesLibrary.parseEpisodeIndex(path.basename(file)));
    const { blocking, notes } = seriesGaps.summarizeGaps({
      selected,
      missing: detail.missing.map((item) => ({ index: item.index, state: item.state })),
      confirmed: libraryGapNotes().get(dir),
    });
    // 下载失败的集带上具体原因（资源缺失、网络失败…），界面直接写出来。
    const reasons = new Map(detail.missing.map((item) => [item.index, item.task?.reason || null]));
    const label = (item) => ({
      ...item,
      text: seriesGaps.STATE_TEXT[item.state],
      reason: reasons.get(item.index) || null,
    });
    const policy = payload.gapPolicy;
    if (blocking.length && !policy) {
      return {
        success: false,
        needsDecision: true,
        kind: detail.linked ? 'download' : 'unknown',
        blocking: blocking.map(label),
        notes: notes.map(label),
      };
    }
    const request = { split: payload.split, opts: payload.opts, outputDir, sideTasks, title };
    if (blocking.length && policy === 'download') {
      const entry = seriesRegistry.find((item) => String(item.series_id) === detail.seriesId);
      if (!detail.linked || !entry) return { success: false, error: '这部剧不是软件下载的，没法补下载' };
      const indices = blocking.map((item) => item.index);
      const byIndex = new Map(entry.episodes.map((episode) => [Number(episode.vid_index), episode]));
      const toDownload = blocking
        .filter((item) => ['notDownloaded', 'failed'].includes(item.state))
        .map((item) => byIndex.get(item.index))
        .filter(Boolean)
        .map((episode) => ({ ...episode, cover: episode.cover || entry.cover }));
      if (toDownload.length) {
        await enqueueEpisodes({
          seriesId: entry.series_id,
          seriesTitle: entry.series_title,
          episodes: toDownload,
          cover: entry.cover,
        });
      }
      const { job } = startLibraryDownloadJob({ dir, request, entry, indices, files });
      return { success: true, waitingForDownload: true, job: libraryJobSnapshot(job), indices };
    }
    if (blocking.length && policy === 'confirm') {
      libraryGapNotes().add(
        dir,
        blocking.filter((item) => item.state === 'unknown').map((item) => item.index),
      );
    }
    const result = await startResplitBatch({ dir, files, ...request });
    const allNotes = [
      ...notes.map(label),
      ...(policy === 'force' ? blocking.map((item) => ({ ...label(item), forced: true })) : []),
    ];
    if (result.success) {
      for (const item of allNotes) {
        libLog(
          dir,
          'warn',
          item.forced
            ? `第 ${item.index} 集${item.text}，按你的选择强制拼接`
            : `第 ${item.index} 集${item.text}，直接拼接`,
        );
      }
    }
    return { ...result, notes: allNotes };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('quchong-cancel', async (_event, batchId) => {
  const batch = quchongBatches.get(String(batchId));
  if (!batch) return { success: false, error: '任务不存在或已经结束' };
  batch.cancelled = true;
  for (const controller of batch.controllers.values()) controller.abort();
  pumpQuchongBatch(batch);
  return { success: true };
});

function probeDuration(ffprobePath, file, task) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const child = execFile(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { timeout: 30000 },
      (err, stdout) => {
        if (task?.child === child) delete task.child;
        if (err) return resolve(0);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) ? d : 0);
      },
    );
    if (task) task.child = child;
  });
}

function probeVideoInfo(ffprobePath, file, task) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const child = execFile(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_data_hash',
        'sha256',
        '-show_entries',
        'stream=codec_type,codec_name,codec_tag_string,profile,level,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,time_base,extradata_hash,sample_rate,channels,channel_layout,bit_rate,color_range,color_space,color_transfer,color_primaries,field_order:format=duration,bit_rate,size',
        '-of',
        'json',
        file,
      ],
      { timeout: 30000 },
      (err, stdout) => {
        if (task?.child === child) delete task.child;
        if (err) return resolve(null);
        try {
          resolve(require('./src/native/merge-plan').readMergeInfo(JSON.parse(stdout)));
        } catch (_) {
          resolve(null);
        }
      },
    );
    if (task) task.child = child;
  });
}

ipcMain.handle('get-ffmpeg-status', async () => {
  const ff = resolveFfmpeg('ffmpeg');
  const fp = resolveFfmpeg('ffprobe');
  return { success: true, ffmpeg: ff, ffprobe: fp, available: !!ff && !!fp };
});

// 在文件管理器中定位文件
ipcMain.handle('show-in-folder', async (event, filePath) => {
  try {
    if (!filePath) return { success: false, error: '缺少路径' };
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return { success: true };
    }
    const dir = path.dirname(filePath);
    if (fs.existsSync(dir)) {
      await shell.openPath(dir);
      return { success: true };
    }
    return { success: false, error: '路径不存在' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-merge-tasks', async () => mergeTasks.map(({ child, ...rest }) => rest));

/** 下载保存目录：直接使用设置里的下载目录，不再按来源/剧名建子目录。 */
function downloadRoot() {
  const configured = String(getCurrentSettings().root || '').trim();
  return path.resolve(configured || app.getPath('downloads'));
}

/**
 * 这部剧已经占用的文件夹名：先看剧档案里记的，再看它已有下载任务落在下载目录下的哪个文件夹。
 * 找不到说明这部剧还没下载过，返回 null。
 */
function claimedSeriesFolder(seriesId) {
  const id = String(seriesId ?? '');
  if (!id) return null;
  const entry = seriesRegistry.find((s) => String(s.series_id) === id);
  if (entry?.folder) return path.basename(String(entry.folder));
  const root = downloadRoot();
  for (const task of downloadTasks) {
    if (String(task.hongguoInfo?.series_id ?? '') !== id || !task.customDir) continue;
    const dir = path.resolve(task.customDir);
    if (path.dirname(dir) === root) return path.basename(dir);
  }
  return null;
}

/** 下载目录下已被各部剧占用的文件夹名（小写）-> 剧 ID。 */
function seriesFolderOwners() {
  const root = downloadRoot();
  const owners = new Map();
  for (const entry of seriesRegistry) {
    if (entry.folder) owners.set(path.basename(String(entry.folder)).toLowerCase(), String(entry.series_id));
  }
  for (const task of downloadTasks) {
    const id = task.hongguoInfo?.series_id;
    if (id === undefined || id === null || !task.customDir) continue;
    const dir = path.resolve(task.customDir);
    if (path.dirname(dir) !== root) continue;
    const name = path.basename(dir).toLowerCase();
    if (!owners.has(name)) owners.set(name, String(id));
  }
  return owners;
}

/**
 * 下载时为每部剧建一个以剧名命名的文件夹：下载目录/剧名/，不再有来源、ID 摘要或阶段子目录。
 * 传入剧 ID 时：这部剧已经有文件夹就沿用；不同来源的两部剧同名，后来的加来源后缀，不会混进同一个文件夹。
 */
function seriesFolder(seriesTitle, seriesId) {
  const root = downloadRoot();
  const base = sanitizeFolderName(seriesTitle) || '未命名短剧';
  if (seriesId === undefined || seriesId === null || seriesId === '') return path.join(root, base);
  const claimed = claimedSeriesFolder(seriesId);
  if (claimed) return path.join(root, claimed);
  return path.join(root, seriesInfo.pickFolderName({ title: base, seriesId, owners: seriesFolderOwners() }));
}

/** 把剧文件夹名记进剧档案，之后这部剧一直用它（剧名后来变了也不会换文件夹）。 */
function rememberSeriesFolder(seriesId, dir) {
  const entry = seriesRegistry.find((s) => String(s.series_id) === String(seriesId));
  const name = path.basename(dir);
  if (!entry || entry.folder === name) return;
  entry.folder = name;
  try {
    saveSeriesRegistry();
  } catch (_) {}
}

async function fetchCoverImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: 15 * 1024 * 1024,
    headers: { 'User-Agent': hongguo.UA },
  });
  return Buffer.from(response.data);
}

/** 把来源平台的封面和简介存进剧文件夹（已有的不覆盖），失败只记日志，不影响下载。 */
function writeSeriesInfoFiles(seriesId, dir, coverHint) {
  const entry = seriesRegistry.find((s) => String(s.series_id) === String(seriesId));
  return seriesInfo
    .saveSeriesInfo({
      dir,
      cover: coverHint || entry?.cover || '',
      synopsis: entry?.synopsis || '',
      fetchImage: fetchCoverImage,
    })
    .catch((error) => console.warn('[SeriesInfo] 保存封面/简介失败:', error.message));
}

/** 输出目录：先用本次操作明确给出的目录，其次是设置里指定的目录；都没有就报错，绝不自动推导。 */
function configuredDir(explicit, settingKey, label) {
  const dir = String(explicit ?? '').trim() || String(getCurrentSettings()[settingKey] || '').trim();
  if (!dir) throw new Error(`请先选择${label}`);
  return path.resolve(dir);
}

/** 应用私有的每剧工作目录，只放字幕、分析等中间文件，不放进用户的输出目录。 */
function seriesWorkDir(seriesId) {
  const id = createHash('sha256').update(String(seriesId)).digest('hex').slice(0, 12);
  return path.join(app.getPath('userData'), 'series-data', id);
}

function hasCompleteTaskFile(task) {
  if (!task?.savePath || task.pathConflict) return false;
  if (
    downloadTasks.some(
      (other) =>
        other !== task &&
        other.savePath === task.savePath &&
        String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid),
    )
  )
    return false;
  try {
    const stat = fs.statSync(task.savePath);
    return stat.isFile() && stat.size > 1024 * 100;
  } catch (_) {
    return false;
  }
}

function repairTaskDestination(task) {
  const conflicts = downloadTasks.filter(
    (other) =>
      other !== task &&
      other.savePath === task.savePath &&
      String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid),
  );
  if (conflicts.length) for (const item of [task, ...conflicts]) item.pathConflict = true;
  if (!task.pathConflict) return;
  const settings = getCurrentSettings(),
    info = task.hongguoInfo || {};
  task.customDir = seriesFolder(info.series_title, info.series_id);
  const filename = uniqueEpisodeFilename(settings, info.series_title, {
    vid_index: info.vid_index,
    title: info.ep_title,
  });
  const suffix = createHash('sha256').update(String(info.vid)).digest('hex').slice(0, 8);
  task.filename = filename.replace(/\.mp4$/, `-${suffix}.mp4`);
  task.savePath = path.join(task.customDir, task.filename);
  task.pathConflict = false;
}

function uniqueEpisodeFilename(settings, title, episode) {
  const index = String(episode.vid_index).padStart(3, '0');
  const format = settings.name_format || '';
  const rendered = renderName(format, title, episode.vid_index, episode.title) || title;
  return `${rendered}${/集数|vid_index/.test(format) ? '' : `_第${index}集`}.mp4`;
}

/**
 * 组装合并顺序：只认下载任务记录里登记过、且磁盘上真实存在的文件，
 * 不再扫描任何目录去猜哪些文件属于哪部剧。
 */
function collectSeriesEpisodeFiles(seriesId) {
  const sid = String(seriesId);
  const byIndex = new Map();
  for (const t of downloadTasks) {
    if (!t.hongguoInfo || String(t.hongguoInfo.series_id) !== sid || !t.savePath) continue;
    if (!hasCompleteTaskFile(t)) continue;
    const idx = Number(t.hongguoInfo.vid_index) || 0;
    if (!idx) continue;
    const prev = byIndex.get(idx);
    if (!prev || (t.startTime || 0) > (prev.startTime || 0)) {
      byIndex.set(idx, { vid_index: idx, path: t.savePath, filename: t.filename || path.basename(t.savePath) });
    }
  }
  return { ordered: [...byIndex.values()].sort((a, b) => a.vid_index - b.vid_index) };
}

ipcMain.handle('merge-series', async (event, seriesId, outputName, options) => {
  try {
    const sid = String(seriesId);
    const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
    const seriesTitle =
      entry?.series_title ||
      downloadTasks.find((t) => String(t.hongguoInfo?.series_id) === sid)?.hongguoInfo.series_title ||
      '未命名短剧';
    const { ordered } = collectSeriesEpisodeFiles(sid);
    if (!ordered.length) return { success: false, error: '该剧还没有已下载完成的分集' };
    const requestedIndices = Array.isArray(options?.episodeIndices)
      ? new Set(options.episodeIndices.map(Number).filter((index) => Number.isSafeInteger(index) && index > 0))
      : null;
    let mergeOrdered = requestedIndices
      ? ordered.filter((item) => requestedIndices.has(Number(item.vid_index)))
      : ordered;
    if (!mergeOrdered.length) return { success: false, error: '指定范围内没有已下载完成的分集' };
    // 合并是“最终成品”门槛，输入必须来自已经完成的去重输出；直接把原始下载
    // 文件合并会跳过流水线阶段，后续 AI 素材也必须因此被阻断。
    const pipelineState = getPipelineStatus(sid);
    if (!pipelineState.success) return { success: false, error: pipelineState.error || '未找到该剧档案' };
    const missingDedup = mergeOrdered.filter((item) => {
      const record = pipelineEpisode(entry, item.vid_index, false);
      return (
        !record ||
        !['deduped', 'segmented'].includes(record.status) ||
        !pipelineFileValid(record.dedupPath, record.dedupFingerprint)
      );
    });
    if (missingDedup.length) {
      return {
        success: false,
        error: `第 ${missingDedup
          .slice(0, 5)
          .map((item) => item.vid_index)
          .join('、')} 集尚未完成去重，请先完成视频去重处理`,
      };
    }
    mergeOrdered = mergeOrdered.map((item) => {
      const record = pipelineEpisode(entry, item.vid_index, false);
      return { ...item, sourcePath: item.path, path: record.dedupPath };
    });
    const ffmpegPath = resolveFfmpeg('ffmpeg'),
      ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到完整 FFmpeg 工具，无法检查并合并分集' };
    if (mergeTasks.filter((t) => t.status === 'running').length >= MAX_CONCURRENT_MERGES) {
      return { success: false, busy: true, error: `当前已有 ${MAX_CONCURRENT_MERGES} 个合并任务运行，请稍后重试` };
    }
    const outDir = configuredDir(options?.outputDir, 'merge_output_dir', '合集输出目录');
    await fsp.mkdir(outDir, { recursive: true });
    const baseName =
      outputName && String(outputName).trim()
        ? sanitizeFolderName(outputName)
        : `${sanitizeFolderName(seriesTitle)}_合集`;
    if (!baseName || baseName === '.' || baseName === '..') return { success: false, error: '请输入有效输出名称' };
    const output = path.join(outDir, `${baseName}.mp4`);
    if (fs.existsSync(output)) return { success: false, error: `输出文件已存在：${baseName}.mp4，请先删除或换个名字` };
    // 不同短剧可以并行合并；同一短剧仍串行，避免同时扫描/写入同一目录造成竞态。
    if (mergeTasks.some((t) => t.status === 'running' && String(t.seriesId) === sid)) {
      return { success: false, error: '该剧已有合并任务正在运行，请等待完成或先取消' };
    }
    const outputKey = quchongPathKey(output);
    if (mergeTasks.some((t) => t.status === 'running' && t.output && quchongPathKey(t.output) === outputKey)) {
      return { success: false, error: '该输出文件已有合并任务正在运行，请等待完成或换个名称' };
    }
    const totalBytes = mergeOrdered.reduce((sum, e) => sum + fs.statSync(e.path).size, 0);
    const id = 'merge_' + randomUUID();
    const task = {
      id,
      seriesId: sid,
      seriesTitle,
      output,
      outputName: `${baseName}.mp4`,
      total: mergeOrdered.length,
      done: 0,
      checked: 0,
      progress: 0,
      status: 'running',
      stage: 'checking',
      stageText: '检查分集',
      totalBytes,
      episodeIndices: mergeOrdered.map((item) => Number(item.vid_index)).filter(Number.isSafeInteger),
      totalDuration: 0,
      codecWarning: '',
      error: '',
      startTime: Date.now(),
      elapsedSeconds: 0,
      speed: 0,
      etaSeconds: null,
    };
    mergeTasks.unshift(task);
    if (!saveMergeTasks()) {
      mergeTasks = mergeTasks.filter((t) => t.id !== id);
      return { success: false, error: '无法保存合并任务，请检查存储错误提示后重试' };
    }
    // 分组已经确定，但只有 runMerge 完成并验证输出后才能进入 ready。
    markPipelineSegmented(task);
    sendToRenderer('merge-task-added', { ...task });
    const { runMerge } = require('./src/native/merge-runner');
    (async () => {
      try {
        await runMerge({
          task,
          ordered: mergeOrdered,
          outDir,
          ffmpegPath,
          ffprobePath,
          probe: probeVideoInfo,
          pickEncoder: pickH264Encoder,
          compatible: !!options?.compatible,
          update: () => {
            const { child, ...data } = task;
            sendToRenderer('merge-progress', data);
          },
        });
      } catch (error) {
        task.status = task.cancelled ? 'stopped' : 'failed';
        task.stage = task.status;
        task.stageText = task.cancelled ? '已取消' : '合并失败';
        task.error = task.cancelled ? '已取消' : error.message;
      } finally {
        task.endTime = Date.now();
        if (task.status === 'completed' && task.verified !== false) markPipelineReady(task);
        else markPipelineMergeFailed(task);
        if (!saveMergeTasks()) task.storageWarning = '合并记录未保存，导出文件状态请以磁盘为准';
        sendToRenderer(task.status === 'completed' ? 'merge-completed' : 'merge-failed', {
          id,
          path: output,
          error: task.error,
          verified: task.verified,
          storageWarning: task.storageWarning,
        });
      }
    })().catch((error) => console.error('[Merge] 任务通知失败:', error.message));
    return {
      success: true,
      id,
      output,
      outputName: task.outputName,
      count: mergeOrdered.length,
      totalBytes,
      totalDuration: 0,
      codecWarning: '',
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-merge', async (event, id) => {
  const task = mergeTasks.find((m) => m.id === id);
  if (!task) return { success: false, error: '任务不存在' };
  if (task.status !== 'running') return { success: false, error: '任务已结束' };
  task.cancelled = true;
  require('./src/native/merge-runner').stopMergeChildren(task);
  return { success: true };
});

ipcMain.handle('delete-merge-task', async (event, id) => {
  const task = mergeTasks.find((m) => m.id === id);
  if (task?.status === 'running') return { success: false, error: '请先取消合并，再移除记录' };
  const previous = mergeTasks;
  mergeTasks = mergeTasks.filter((m) => m.id !== id);
  if (!saveMergeTasks()) {
    mergeTasks = previous;
    return { success: false, error: '无法保存任务记录' };
  }
  return { success: true };
});

function saveMergeTasks() {
  try {
    store.saveMergeTasks(mergeTasks.map(({ child, ...rest }) => rest));
    return true;
  } catch (error) {
    console.error('[Merge] 保存任务失败:', error.message);
    return false;
  }
}

function loadMergeTasks() {
  try {
    mergeTasks = (store.getMergeTasks() || []).map((t) =>
      t.status === 'running'
        ? {
            ...t,
            status: 'stopped',
            stage: 'stopped',
            stageText: '已中断',
            error: '应用关闭时中断',
            endTime: Date.now(),
          }
        : t,
    );
  } catch (_) {
    mergeTasks = [];
  }
}

/**
 * 播放页数据源：把「短剧档案」与「下载任务」合并成每集的可播放状态。
 * 判定可播的规则与下载跳过逻辑一致：文件存在且 > 100KB。
 * 由于解密文件是「先写 .enc.tmp、成功后改名 .mp4」，因此不会读到半成品。
 */
ipcMain.handle('get-series-episodes', async (event, seriesId) => {
  try {
    const sid = String(seriesId);
    const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
    const tasks = downloadTasks.filter((t) => t.hongguoInfo && String(t.hongguoInfo.series_id) === sid);

    // 一集只保留一个任务：完整文件优先，其次保留活动任务，最后才取最新失败记录。
    // 任务记录可能因重复提交或重试留下多条，不能让一条较新的失败记录遮住已下载文件。
    const taskByIndex = new Map();
    const taskPriority = (task) => {
      if (hasCompleteTaskFile(task)) return 0;
      if (task.status === 'downloading') return 1;
      if (task.status === 'pending') return 2;
      return 3;
    };
    for (const t of tasks) {
      const idx = Number(t.hongguoInfo.vid_index);
      const key = Number.isFinite(idx) && idx > 0 ? `index:${idx}` : `vid:${String(t.hongguoInfo.vid)}`;
      const prev = taskByIndex.get(key);
      if (
        !prev ||
        taskPriority(t) < taskPriority(prev) ||
        (taskPriority(t) === taskPriority(prev) && (t.startTime || 0) > (prev.startTime || 0))
      ) {
        taskByIndex.set(key, t);
      }
    }

    const baseEpisodes =
      entry && entry.episodes.length
        ? entry.episodes
        : [
            ...new Map(
              tasks.map((t) => {
                const idx = Number(t.hongguoInfo.vid_index);
                const key = Number.isFinite(idx) && idx > 0 ? `index:${idx}` : `vid:${String(t.hongguoInfo.vid)}`;
                return [
                  key,
                  {
                    vid: t.hongguoInfo.vid,
                    vid_index: t.hongguoInfo.vid_index,
                    title: t.hongguoInfo.ep_title || '',
                  },
                ];
              }),
            ).values(),
          ];

    // 目录兜底：磁盘上可能存在没有任务记录的「孤儿」文件
    // （任务被清理、跨会话下载等），仅靠任务判断会把它们误报成「未下载」。
    const seriesTitle =
      (entry && entry.series_title) || (tasks[0] && tasks[0].hongguoInfo.series_title) || '未命名短剧';
    let scannedByIndex = new Map();
    try {
      const scanned = collectSeriesEpisodeFiles(sid);
      for (const e of scanned.ordered) scannedByIndex.set(Number(e.vid_index), e);
    } catch (_) {}

    const episodes = baseEpisodes
      .map((ep) => {
        const idx = Number(ep.vid_index);
        const taskKey = Number.isFinite(idx) && idx > 0 ? `index:${idx}` : `vid:${String(ep.vid)}`;
        const t = taskByIndex.get(taskKey);
        let status = 'missing';
        let fileUrl = null;
        let progress = 0;
        let fileSize = 0;
        let savePath = null;

        if (t && t.savePath) {
          savePath = t.savePath;
          if (fs.existsSync(t.savePath)) {
            fileSize = fs.statSync(t.savePath).size;
          }
          if (hasCompleteTaskFile(t)) {
            status = 'completed';
            fileUrl = localPlayUrl(t.savePath);
          } else if (t.status === 'downloading') {
            status = 'downloading';
            progress = t.progress || 0;
          } else if (t.status === 'pending') {
            status = 'pending';
          } else {
            status = t.status === 'completed' ? 'missing' : t.status;
          }
        }

        // 任务缺失（或该任务没有可用文件）时，用磁盘扫描结果兜底
        if (status === 'missing') {
          const f = scannedByIndex.get(idx);
          if (f) {
            savePath = f.path;
            fileUrl = localPlayUrl(f.path);
            try {
              fileSize = fs.statSync(f.path).size;
            } catch (_) {}
            status = 'completed';
          }
        }

        return {
          vid: ep.vid,
          vid_index: idx,
          title: ep.title || '',
          web_available: ep.web_available ?? null,
          locked: ep.locked === true,
          taskId: t ? t.id : null,
          status,
          progress,
          fileSize,
          fileUrl,
          savePath,
          aiCopy: aiValidEpisodeCopy(entry, idx),
        };
      })
      .sort((a, b) => a.vid_index - b.vid_index);

    const completedCount = episodes.filter((e) => e.status === 'completed').length;
    return {
      success: true,
      data: {
        series_id: sid,
        series_title: seriesTitle,
        cover: (entry && entry.cover) || '',
        synopsis: (entry && entry.synopsis) || '',
        aiCover: aiValidCover(entry),
        episodeCopies: Object.fromEntries(
          (entry?.episodes || [])
            .map((item) => [String(item.vid_index), aiValidEpisodeCopy(entry, item.vid_index)])
            .filter(([, record]) => record),
        ),
        episodesUpdatedAt: Number(entry?.episodesUpdatedAt || entry?.updatedAt) || 0,
        pipeline: getPipelineStatus(sid),
        transcription: getTranscriptionManager().status(sid),
        analysis: getAnalysisManager().status(sid),
        web_accessible_episodes: entry?.web_accessible_episodes ?? null,
        total: episodes.length,
        completedCount,
        episodes,
      },
    };
  } catch (error) {
    console.error('[Player] 读取分集失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 发布素材页使用的流水线状态查询。它只读并校验磁盘，不会隐式下载、去重或合并，
// 避免点击 AI 按钮时偷偷跨过前置步骤。
ipcMain.handle('get-series-pipeline-status', async (_event, seriesId) => {
  try {
    return getPipelineStatus(seriesId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 精品剪辑第一步：只读取已去重输出，逐集生成完整 SRT。不会触碰下载、去重
// 或旧的 AI 发布素材队列；设备在本批开始时固定一次，失败直接显示原因。
ipcMain.handle('get-faster-whisper-status', async () => {
  try {
    return await fasterWhisper.checkRuntime(getTranscriptionSettings());
  } catch (error) {
    return { available: false, message: error.message };
  }
});

ipcMain.handle('get-series-transcription', async (_event, seriesId) => {
  try {
    return getTranscriptionManager().status(seriesId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-series-transcription', async (_event, payload = {}) => {
  try {
    return await getTranscriptionManager().start(payload);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-series-transcription', async (_event, batchId) => {
  try {
    return getTranscriptionManager().cancel(batchId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-series-analysis', async (_event, seriesId) => {
  try {
    return getAnalysisManager().status(seriesId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-series-analysis', async (_event, payload = {}) => {
  try {
    return await getAnalysisManager().start(payload);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-series-analysis', async (_event, batchId) => {
  try {
    return getAnalysisManager().cancel(batchId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 本地结构化拆解：独立模块与完整流程共用同一项目索引。
ipcMain.handle('get-structure-runtime', async () => {
  try {
    return { success: true, ...(await getReconstructionPipeline().availability()) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
ipcMain.handle('get-structure-projects', () =>
  Object.entries(store.getStructureProjects())
    .map(([projectId, record]) => ({ projectId, ...record }))
    .sort((a, b) => b.updatedAt - a.updatedAt),
);

ipcMain.handle('get-reconstruction-status', async (_event, projectId) => {
  try {
    return await getReconstructionPipeline().status(projectId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-reconstruction', async (_event, payload = {}) => {
  try {
    const outputRoot =
      String(payload.outputRoot || '').trim() || String(getCurrentSettings().structure_output_dir || '').trim();
    return await getReconstructionPipeline().start({ ...payload, outputRoot: outputRoot || undefined });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-reconstruction', async (_event, projectId) => {
  try {
    return getReconstructionPipeline().cancel(projectId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-series-workflow-status', async (_event, seriesId) => {
  try {
    return getSeriesWorkflowStatus(seriesId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-series-workflow', async (_event, payload = {}) => {
  try {
    return startSeriesWorkflow(payload);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cancel-series-workflow', async (_event, batchId) => {
  try {
    return cancelSeriesWorkflow(batchId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 断点续播
ipcMain.handle('save-playback-position', async (event, seriesId, vidIndex, currentTime) => {
  try {
    const map = store.getPlayback() || {};
    map[String(seriesId)] = {
      vid_index: Number(vidIndex) || 1,
      currentTime: Number(currentTime) || 0,
      updatedAt: Date.now(),
    };
    store.savePlayback(map);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-playback-position', async (event, seriesId) => {
  const map = store.getPlayback() || {};
  return map[String(seriesId)] || null;
});

/**
 * 从「浏览」页点播：切到播放页并选中该剧。
 * 主进程只负责发导航指令，具体的剧集状态由渲染层拉取，避免重复维护一份数据。
 */
ipcMain.handle('play-series', async (event, payload) => {
  const { seriesId, vidIndex } = payload || {};
  sendToRenderer('navigate', {
    page: 'player',
    payload: { seriesId: seriesId ? String(seriesId) : '', vidIndex: Number(vidIndex) || 0 },
  });
  return { success: true };
});

// ===== 在线播放 =====

/** Only a single valid byte range is supported; malformed/unsatisfiable => 416. */
function mediaRange(range, size) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return false;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end };
}

function bufferedMediaResponse(request, buffer) {
  const range = mediaRange(request.headers.get('range'), buffer.length);
  if (range === false)
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buffer.length}` } });
  const { start, end } = range || { start: 0, end: buffer.length - 1 };
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${buffer.length}`;
  return new Response(request.method === 'HEAD' ? null : buffer.subarray(start, end + 1), {
    status: range ? 206 : 200,
    headers,
  });
}

/** Same media headers and cancellation apply to download and playback. */
async function requestMedia(playInfo, options = {}) {
  const url = new URL(playInfo.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效播放地址');
  const config = {
    method: 'GET',
    url: url.href,
    responseType: 'stream',
    timeout: 60000,
    ...options,
    headers: { 'User-Agent': hongguo.UA, 'Accept-Encoding': 'identity', ...options.headers },
  };
  try {
    return await axios(config);
  } catch (error) {
    // Drain nothing from rejected bodies: destroy to release the underlying socket.
    error.response?.data?.destroy?.();
    if (error.response?.status !== 403) throw error;
    try {
      return await axios({ ...config, headers: { ...config.headers, Referer: hongguo.VIDEO_REFERER } });
    } catch (retryError) {
      retryError.response?.data?.destroy?.();
      throw retryError;
    }
  }
}

/** Proxy only addresses resolved by our native provider, never renderer-supplied URLs. */
function registerStreamProtocol() {
  protocol.handle(STREAM_SCHEME, async (request) => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\/+/, '');
    const session = url.hostname === 'play' && onlineSessions.get(id);
    if (!session || !session.entry) return new Response('not ready', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const entry = session.entry;
    entry.lastUsed = Date.now();
    if (entry.buffer) return bufferedMediaResponse(request, entry.buffer);
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416 });
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const cleanup = () => {
      session.requests.delete(controller);
      request.signal.removeEventListener('abort', abort);
    };
    try {
      const upstream = await requestMedia(entry.playInfo, {
        method: request.method,
        signal: controller.signal,
        headers: range ? { Range: range } : {},
        validateStatus: (status) => [200, 206, 416].includes(status),
      });
      upstream.data.once('close', cleanup);
      const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) {
        if (upstream.headers[name]) headers[name] = upstream.headers[name];
      }
      if (request.method === 'HEAD' || upstream.status === 416) {
        upstream.data.destroy();
        cleanup();
        return new Response(null, { status: upstream.status, headers });
      }
      return new Response(
        Readable.toWeb(upstream.data, { strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength } }),
        { status: upstream.status, headers },
      );
    } catch (error) {
      cleanup();
      return new Response('media unavailable', { status: controller.signal.aborted ? 499 : 502 });
    }
  });
}

/** 把本地文件路径转成可被渲染进程播放的 URL */
function localPlayUrl(filePath) {
  if (!filePath) return null;
  const p = path.resolve(String(filePath));
  return `${LOCAL_SCHEME}://f/${Buffer.from(p, 'utf8').toString('base64url')}`;
}

/** 把本地封面/图片路径转成渲染进程可访问的安全 URL。 */
function localAssetUrl(filePath) {
  if (!filePath) return null;
  const p = path.resolve(String(filePath));
  return `${LOCAL_SCHEME}://f/${Buffer.from(p, 'utf8').toString('base64url')}`;
}

/**
 * 注册本地文件播放协议。
 * 改由主进程用 Node 读文件供给，而不是让 Chromium 读 file://：
 * 开发模式下渲染页面来自 http://localhost:5173，Chromium 会以
 * 「Not allowed to load local resource」拒绝 file:// 请求（表现为播放器黑屏、进度 0:00）。
 * 走自定义协议后开发/打包两种模式行为一致，并且支持 Range 拖动进度。
 */
function registerLocalProtocol() {
  protocol.handle(LOCAL_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const b64 = url.pathname.replace(/^\/+/, '');
      const filePath = Buffer.from(b64, 'base64url').toString('utf8');
      if (!filePath) {
        return new Response('bad path', { status: 400, headers: { 'Content-Type': 'text/plain' } });
      }
      // 只允许取视频和应用生成的图片，避免该协议被用来读取任意本地文件
      if (!/\.(mp4|m4v|mov|webm|png|jpe?g|webp)$/i.test(filePath)) {
        return new Response('forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
      }

      let size = 0;
      try {
        size = (await fsp.stat(filePath)).size;
      } catch (_) {
        console.warn('[Local] 文件不存在:', filePath);
        return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }

      const isImage = /\.(png|jpe?g|webp)$/i.test(filePath);
      const contentType = isImage
        ? path.extname(filePath).toLowerCase() === '.png'
          ? 'image/png'
          : path.extname(filePath).toLowerCase() === '.webp'
            ? 'image/webp'
            : 'image/jpeg'
        : 'video/mp4';
      const range = request.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end >= size) end = size - 1;
        if (start > end) start = 0;
        return new Response(fs.createReadStream(filePath, { start, end }), {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }

      return new Response(fs.createReadStream(filePath), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size),
        },
      });
    } catch (e) {
      console.error('[Local] 读取失败:', e.message);
      return new Response('error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
    }
  });
}

/** App CENC uses native FFmpeg for both senc and saiz/saio layouts. Never log key/args. */
async function decryptContentKeyFile(input, output, contentKey, { signal, cancelToken } = {}) {
  if (typeof contentKey !== 'string' || !/^[a-f\d]{32}$/i.test(contentKey)) throw new Error('片源解密密钥格式无效');
  if (signal?.aborted) throw new Error('已取消媒体解密');
  cancelToken?.throwIfRequested();
  const executable = resolveFfmpeg('ffmpeg');
  if (!executable) throw new Error('未找到内置 FFmpeg，无法准备该片源');
  try {
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const child = spawn(
        executable,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-decryption_key',
          contentKey,
          '-i',
          input,
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          output,
        ],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let cancelled = false,
        killTimer;
      const abort = () => {
        if (cancelled) return;
        cancelled = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      };
      const cleanup = () => {
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        cancelToken?.unsubscribe(abort);
      };
      // Discard native diagnostics: they may contain private input paths or key material.
      child.stderr.on('data', () => {});
      signal?.addEventListener('abort', abort, { once: true });
      cancelToken?.subscribe(abort);
      if (signal?.aborted || cancelToken?.reason) abort();
      child.once('error', () => {
        cleanup();
        reject(new Error('无法启动内置 FFmpeg'));
      });
      child.once('close', (code) => {
        cleanup();
        if (cancelled) reject(new Error('已取消媒体解密'));
        else if (code !== 0) reject(new Error(`媒体解密失败（FFmpeg 退出码 ${code}），请重新获取片源后重试`));
        else resolve();
      });
    });
    if (signal?.aborted) throw new Error('已取消媒体解密');
    cancelToken?.throwIfRequested();
    if ((await fsp.stat(output)).size === 0) throw new Error('媒体解密没有生成可用文件');
  } catch (error) {
    try {
      await fsp.unlink(output);
    } catch (_) {}
    throw error;
  }
}

/** Encrypted sources and compatibility transcoding still require the complete MP4. */
async function fetchDecryptedEpisode(vid, onProgress, seriesId, playInfo, signal) {
  playInfo = playInfo || (await hongguo.fetchPlayUrlSingle(vid, seriesId));
  if (!playInfo?.url) throw new Error(playInfo?.error || '未获取到有效播放地址');
  if (signal?.aborted) throw new Error('已取消播放');
  if (playInfo.contentKey && !/^[a-f\d]{32}$/i.test(playInfo.contentKey)) throw new Error('片源解密密钥格式无效');
  const response = await requestMedia(playInfo, { signal });
  const total = Number(response.headers['content-length']) || 0;
  const chunks = [];
  let received = 0,
    lastProgress = 0;
  if (playInfo.contentKey) {
    let temporary;
    try {
      temporary = await fsp.mkdtemp(path.join(app.getPath('temp'), 'hongguo-decrypt-'));
      const input = path.join(temporary, 'encrypted.mp4'),
        output = path.join(temporary, 'decoded.mp4');
      response.data.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
          onProgress(received, total);
          lastProgress = Date.now();
        }
      });
      await pipeline(response.data, fs.createWriteStream(input, { mode: 0o600 }), { signal });
      if (total && received !== total) throw new Error('视频下载不完整，请重试');
      if (onProgress) onProgress(received, received, 'decrypting');
      await decryptContentKeyFile(input, output, playInfo.contentKey, { signal });
      return await fsp.readFile(output);
    } finally {
      response.data.destroy();
      if (temporary) await fsp.rm(temporary, { recursive: true, force: true });
    }
  }
  for await (const chunk of response.data) {
    chunks.push(chunk);
    received += chunk.length;
    if (onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
      onProgress(received, total);
      lastProgress = Date.now();
    }
  }
  if (signal?.aborted) throw new Error('已取消播放');
  let buf = Buffer.concat(chunks);
  if (playInfo.spadeA) {
    if (onProgress) onProgress(buf.length, buf.length, 'decrypting');
    const key = hongguo.deriveKey(playInfo.spadeA);
    if (!key) throw new Error('密钥派生失败');
    buf = await decryptInWorker({ buffer: buf, key }, { signal });
  }
  return buf;
}

ipcMain.handle('prepare-online-play', async (event, payload) => {
  const { vid, seriesId, vidIndex, requestId } = payload || {};
  if (!vid) return { success: false, error: '缺少 vid' };
  const key = String(vid),
    streamId = randomUUID();
  const session = { vid: key, requestId, requests: new Set(), entry: null };
  onlineSessions.set(streamId, session);
  try {
    const checkedPlayInfo = /^(xifan|hema):/.test(key) ? await hongguo.fetchPlayUrlSingle(key, seriesId) : null;
    if (checkedPlayInfo && !checkedPlayInfo.url) throw new Error(checkedPlayInfo.error || '来源未开放该集');
    let entry = onlineCache.get(key),
      cached = !!entry;
    if (!entry) {
      let job = onlinePreparing.get(key);
      if (!job) {
        const controller = new AbortController();
        job = { controller };
        job.promise = (async () => {
          const playInfo = checkedPlayInfo || (await hongguo.fetchPlayUrlSingle(key, seriesId));
          if (controller.signal.aborted) throw new Error('已取消播放');
          if (!playInfo?.url) throw new Error(playInfo?.error || '未获取到有效播放地址');
          const prepared = {
            size: 0,
            lastUsed: Date.now(),
            seriesId: String(seriesId || ''),
            vidIndex: Number(vidIndex) || 0,
          };
          if (!playInfo.spadeA && !playInfo.contentKey) return { ...prepared, playInfo };
          prepared.buffer = await fetchDecryptedEpisode(
            key,
            (received, total, phase) => {
              for (const active of onlineSessions.values())
                if (active.vid === key) {
                  sendToRenderer('online-play-progress', {
                    vid: key,
                    seriesId,
                    vidIndex,
                    requestId: active.requestId,
                    received,
                    total,
                    percent: total ? Math.floor((received / total) * 100) : 0,
                    phase: phase || 'downloading',
                  });
                }
            },
            seriesId,
            playInfo,
            controller.signal,
          );
          if (controller.signal.aborted) throw new Error('已取消播放');
          prepared.size = prepared.buffer.length;
          onlineCache.set(key, prepared);
          trimOnlineCache();
          return prepared;
        })().finally(() => {
          if (onlinePreparing.get(key) === job) onlinePreparing.delete(key);
        });
        onlinePreparing.set(key, job);
      }
      entry = await job.promise;
    }
    if (!onlineSessions.has(streamId)) throw new Error('已取消播放');
    session.entry = entry;
    entry.lastUsed = Date.now();
    return {
      success: true,
      url: `${STREAM_SCHEME}://play/${streamId}`,
      streamId,
      size: entry.size,
      cached,
      streaming: !!entry.playInfo,
    };
  } catch (error) {
    releaseOnlineSession(streamId);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('release-online-play', async (event, payload = {}) => {
  for (const [id, session] of [...onlineSessions]) {
    if ((payload.streamId && id === payload.streamId) || (payload.requestId && session.requestId === payload.requestId))
      releaseOnlineSession(id);
  }
  return { success: true };
});

ipcMain.handle('online-cache-status', async () => {
  const items = [...onlineCache.entries()].map(([vid, e]) => ({
    vid,
    size: e.size,
    vidIndex: e.vidIndex,
    seriesId: e.seriesId,
  }));
  return { success: true, count: items.length, bytes: onlineCacheTotal(), items };
});

ipcMain.handle('clear-online-cache', async () => {
  clearOnlineCache();
  return { success: true };
});

// ===== 兼容模式：把 HEVC 转成 H.264，解决「黑屏有声」=====
const COMPAT_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 转码缓存上限
let compatDir = null;
let compatEncoder = null; // 探测到的最优 H.264 编码器

function getCompatDir() {
  if (!compatDir) {
    compatDir = path.join(app.getPath('userData'), 'compat-cache');
    try {
      fs.mkdirSync(compatDir, { recursive: true });
    } catch (_) {}
  }
  return compatDir;
}

function compatFileName(seriesId, vidIndex) {
  return `${sanitizeFolderName(String(seriesId))}_${String(vidIndex).padStart(3, '0')}.mp4`;
}

function compatPathFor(seriesId, vidIndex) {
  return path.join(getCompatDir(), compatFileName(seriesId, vidIndex));
}

function compatCacheStatus() {
  const dir = getCompatDir();
  let files = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mp4')) continue;
      try {
        bytes += fs.statSync(path.join(dir, f)).size;
        files++;
      } catch (_) {}
    }
  } catch (_) {}
  return { dir, files, bytes };
}

function trimCompatCache() {
  const dir = getCompatDir();
  let entries = [];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, at: st.atimeMs || st.mtimeMs };
      });
  } catch (_) {
    return;
  }
  let total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= COMPAT_MAX_BYTES) return;
  entries.sort((a, b) => a.at - b.at); // 最早访问的先删
  for (const e of entries) {
    if (total <= COMPAT_MAX_BYTES) break;
    try {
      fs.unlinkSync(e.p);
      total -= e.size;
    } catch (_) {}
  }
}

/** 探测可用的 H.264 编码器：先看列表，再实际试编一帧（列表里有不代表能用，如无 N 卡时的 nvenc） */
async function pickH264Encoder(ffmpegPath, task) {
  if (compatEncoder) return compatEncoder;
  const { execFile } = require('child_process');

  const list = await new Promise((resolve) => {
    const child = execFile(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 20000 }, (err, stdout) => {
      if (task?.child === child) delete task.child;
      resolve(String(stdout || ''));
    });
    if (task) task.child = child;
  });
  if (task?.cancelled) throw new Error('已取消');

  const candidates = (
    process.platform === 'darwin'
      ? ['h264_videotoolbox', 'libx264']
      : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264']
  ).filter((e) => list.includes(e));
  if (!candidates.includes('libx264')) candidates.push('libx264'); // 软件兜底

  const works = (enc) =>
    new Promise((resolve) => {
      const child = execFile(
        ffmpegPath,
        [
          '-hide_banner',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=64x64:d=0.1',
          '-frames:v',
          '1',
          '-c:v',
          enc,
          '-f',
          'null',
          '-',
        ],
        { timeout: 25000 },
        (err) => {
          if (task?.child === child) delete task.child;
          resolve(!err);
        },
      );
      if (task) task.child = child;
    });

  for (const enc of candidates) {
    if (task?.cancelled) throw new Error('已取消');
    if (await works(enc)) {
      compatEncoder = enc;
      break;
    }
    console.log('[Compat] 编码器不可用，跳过:', enc);
  }
  if (!compatEncoder) compatEncoder = 'libx264';
  console.log('[Compat] 使用编码器:', compatEncoder);
  return compatEncoder;
}

/**
 * 转码为 H.264/AAC。
 * 返回 { success, path, size, elapsed }
 */
const compatPreparing = new Map();
const compatRequests = new Map();
let compatClearing = null;
const compatCancelled = () => ({ success: false, cancelled: true, error: '已取消转码' });
function cancelCompatJob(job) {
  job.cancelled = true;
  job.controller.abort();
}
ipcMain.handle('cancel-transcode-for-playback', async (_event, payload = {}) => {
  if (!payload.seriesId || payload.vidIndex == null) return { success: false };
  const key = compatPathFor(payload.seriesId, payload.vidIndex);
  const request = payload.requestId ? compatRequests.get(String(payload.requestId)) : null;
  // An old request must never fall back to cancelling the newest job for this episode.
  if (payload.requestId && (!request || request.key !== key)) return { success: true };
  const job = request ? request.job : compatPreparing.get(key);
  if (request) request.cancelled = true;
  if (job && (!request || [...job.requests.values()].every((item) => item.cancelled))) {
    cancelCompatJob(job);
    await job.promise;
  }
  return { success: true };
});
ipcMain.handle('transcode-for-playback', async (event, payload = {}) => {
  if (!payload.seriesId || payload.vidIndex == null) return { success: false, error: '缺少剧集信息' };
  const key = compatPathFor(payload.seriesId, payload.vidIndex);
  const requestId = String(payload.requestId || randomUUID());
  const existing = compatRequests.get(requestId);
  if (existing) return existing.key === key ? existing.promise : { success: false, error: '请求标识已用于其他剧集' };
  // Register before every await, including permission lookup and a cancelled predecessor.
  const previous = compatPreparing.get(key);
  let job = previous;
  if (job && !job.cancelled && job.sourceVid !== String(payload.vid || ''))
    return { success: false, error: '该集已有不同来源的准备请求，请稍后重试' };
  if (!job || job.cancelled) {
    job = {
      controller: new AbortController(),
      cancelled: false,
      requests: new Map(),
      sourceVid: String(payload.vid || ''),
    };
    const clearing = compatClearing;
    job.promise = Promise.resolve()
      .then(async () => {
        if (previous) await previous.promise;
        if (clearing) await clearing;
        if (job.cancelled) return compatCancelled();
        return transcodeForPlayback(payload, job);
      })
      .catch((error) => ({ success: false, error: error.message }))
      .finally(() => {
        if (compatPreparing.get(key) === job) compatPreparing.delete(key);
      });
    compatPreparing.set(key, job);
  }
  const request = { key, job, requestId, cancelled: false };
  job.requests.set(requestId, request);
  compatRequests.set(requestId, request);
  request.promise = job.promise
    .then((result) => ({ ...(request.cancelled ? compatCancelled() : result), requestId }))
    .finally(() => {
      job.requests.delete(requestId);
      if (compatRequests.get(requestId) === request) compatRequests.delete(requestId);
    });
  return request.promise;
});

async function transcodeForPlayback(payload, job = { controller: new AbortController() }) {
  let tmpInput, tmpOut;
  const signal = job.controller.signal;
  const checkCancelled = () => {
    if (signal.aborted) throw new Error('已取消转码');
  };
  const abortPreparation = () => {
    const child = job.child;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch (_) {}
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, 2000);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  };
  const reportProgress = (data) => {
    if (!job.requests) return sendToRenderer('transcode-progress', { ...data, requestId: payload.requestId });
    for (const request of job.requests.values()) {
      if (!request.cancelled) sendToRenderer('transcode-progress', { ...data, requestId: request.requestId });
    }
  };
  signal.addEventListener('abort', abortPreparation, { once: true });
  try {
    checkCancelled();
    const { seriesId, vidIndex, filePath, force } = payload || {};
    if (!seriesId || vidIndex == null) return { success: false, error: '缺少剧集信息' };
    if (/^(xifan|hema):/.test(String(seriesId)) || /^(xifan|hema):/.test(String(payload.vid))) {
      const current = await hongguo.fetchEpisodeList(seriesId);
      checkCancelled();
      const episode = current.episodes.find((ep) => Number(ep.vid_index) === Number(vidIndex));
      if (!episode || (payload.vid && payload.vid !== episode.vid)) return { success: false, error: '分集来源不匹配' };
      if (episode.locked) return { success: false, error: '该集已锁定，请在来源平台解锁' };
    }

    const out = compatPathFor(seriesId, vidIndex);
    if (!force && fs.existsSync(out) && fs.statSync(out).size > 1024 * 100) {
      // 命中缓存
      try {
        fs.utimesSync(out, new Date(), new Date());
      } catch (_) {}
      return { success: true, url: localPlayUrl(out), size: fs.statSync(out).size, cached: true };
    }

    const ffmpegPath = resolveFfmpeg('ffmpeg');
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath) return { success: false, error: '未找到 ffmpeg，无法转码' };

    // 1) 解析输入文件：优先本地已下载；否则先取在线缓存并落临时文件
    let inputPath = filePath || null;
    if (!inputPath || !fs.existsSync(inputPath)) {
      const vid = payload.vid;
      if (!vid) return { success: false, error: '既没有本地文件，也没有 vid' };
      let buf = onlineCache.has(String(vid)) ? onlineCache.get(String(vid)).buffer : null;
      if (!buf) {
        buf = await fetchDecryptedEpisode(String(vid), () => {}, seriesId, undefined, signal);
      }
      checkCancelled();
      tmpInput = path.join(getCompatDir(), `.tmp_${randomUUID()}.mp4`);
      fs.writeFileSync(tmpInput, buf);
      inputPath = tmpInput;
    }

    const duration = ffprobePath ? await probeDuration(ffprobePath, inputPath, job) : 0;
    checkCancelled();
    const encoder = await pickH264Encoder(ffmpegPath, job);
    checkCancelled();

    // 2) 转码（硬件编码器用各自推荐的参数）
    const encArgs =
      encoder === 'libx264'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.2']
        : encoder === 'h264_videotoolbox'
          ? ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p']
          : encoder === 'h264_nvenc'
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-b:v', '0']
            : encoder === 'h264_qsv'
              ? ['-c:v', 'h264_qsv', '-global_quality', '23']
              : encoder === 'h264_amf'
                ? ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23']
                : ['-c:v', encoder, '-cq', '23'];

    tmpOut = out + '.part';
    try {
      fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut);
    } catch (_) {}

    const { spawn } = require('child_process');
    const args = [
      '-y',
      '-hide_banner',
      '-i',
      inputPath,
      ...encArgs,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      '-f',
      'mp4',
      tmpOut,
    ];

    console.log(`[Compat] 转码 第${vidIndex}集  编码器=${encoder}  时长=${duration.toFixed(0)}s`);
    const started = Date.now();
    let stderrTail = '';
    const code = await new Promise((resolve) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true });
      let killTimer;
      const abort = () => {
        try {
          child.kill('SIGTERM');
        } catch (_) {}
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        }, 2000);
        killTimer.unref?.();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/);
          if (m && duration > 0) {
            const sec = parseInt(m[1], 10) / 1e6;
            const pct = Math.max(0, Math.min(99, Math.floor((sec / duration) * 100)));
            reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: pct });
          }
        }
      });
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-1500);
      });
      child.on('error', (e) => {
        stderrTail += ' | spawn: ' + e.message;
        resolve(-1);
      });
      child.on('close', (c) => {
        signal.removeEventListener('abort', abort);
        clearTimeout(killTimer);
        resolve(c);
      });
    });
    checkCancelled();

    if (code !== 0 || !fs.existsSync(tmpOut)) {
      try {
        fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut);
      } catch (_) {}
      const tail = stderrTail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
      console.warn('[Compat] 转码失败 code=', code, tail);
      return { success: false, error: `转码失败（ffmpeg 退出码 ${code}）${tail ? '：' + tail : ''}` };
    }

    fs.renameSync(tmpOut, out);
    trimCompatCache();
    const size = fs.statSync(out).size;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[Compat] 完成 ${(size / 1048576).toFixed(1)}MB  用时 ${elapsed}s`);

    reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: 100, done: true });
    return { success: true, url: localPlayUrl(out), size, elapsed: Number(elapsed), encoder };
  } catch (error) {
    if (signal.aborted) return compatCancelled();
    console.error('[Compat] 转码失败:', error.message);
    return { success: false, error: error.message };
  } finally {
    signal.removeEventListener('abort', abortPreparation);
    for (const temporary of [tmpInput, tmpOut]) {
      if (temporary) {
        try {
          await fsp.unlink(temporary);
        } catch (_) {}
      }
    }
  }
}

ipcMain.handle('compat-cache-status', async () => {
  const st = compatCacheStatus();
  return { success: true, ...st, maxBytes: COMPAT_MAX_BYTES };
});

ipcMain.handle('clear-compat-cache', async () => {
  if (compatClearing) return compatClearing;
  const jobs = [...compatPreparing.values()];
  for (const job of jobs) cancelCompatJob(job);
  const clearing = Promise.all(jobs.map((job) => job.promise))
    .then(() => {
      const dir = getCompatDir();
      let freed = 0,
        count = 0,
        failed = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.mp4') && !f.endsWith('.part')) continue;
          const p = path.join(dir, f);
          try {
            const size = fs.statSync(p).size;
            fs.unlinkSync(p);
            freed += size;
            count++;
          } catch (_) {
            failed++;
          }
        }
      } catch (_) {
        failed++;
      }
      return { success: failed === 0, count, freed, error: failed ? '部分兼容缓存删除失败，请稍后重试' : undefined };
    })
    .finally(() => {
      if (compatClearing === clearing) compatClearing = null;
    });
  compatClearing = clearing;
  return clearing;
});

/** 报告本机是否能解码 HEVC（供界面提前提示） */
ipcMain.handle('decode-capability', async () => ({
  ffmpegEncoder: compatEncoder || null,
  compatDir: getCompatDir(),
}));

/**
 * 把若干集加入下载队列（批量下载与播放器「下载本集」共用）。
 * 返回新建的任务数。
 */
async function enqueueEpisodes({ seriesId, seriesTitle, episodes, cover }) {
  if (!Array.isArray(episodes) || episodes.length === 0) return 0;
  if (/^(xifan|hema):/.test(String(seriesId))) {
    const current = await hongguo.fetchEpisodeList(seriesId);
    episodes = episodes.map((requested) => {
      const ep = current.episodes.find(
        (item) => item.vid === requested.vid && Number(item.vid_index) === Number(requested.vid_index),
      );
      if (!ep) throw new Error('分集不属于所选来源，请重新打开剧集');
      if (ep.locked) throw new Error('该集已锁定，请在来源平台解锁');
      return ep;
    });
  } else if (episodes.some((ep) => /^(xifan|hema):/.test(String(ep.vid)))) {
    throw new Error('剧集来源不匹配');
  }

  const settings = getCurrentSettings();
  const cleanSeriesTitle = sanitizeFolderName(seriesTitle) || '红果短剧';
  const downloadDir = seriesFolder(cleanSeriesTitle, seriesId);
  try {
    fs.mkdirSync(downloadDir, { recursive: true });
  } catch (_) {}
  rememberSeriesFolder(seriesId, downloadDir);
  // 封面和简介跟着下载一起存进剧文件夹；不等它完成，也不让它影响下载。
  void writeSeriesInfoFiles(seriesId, downloadDir, cover || (episodes[0] && episodes[0].cover));

  const batchId = 'hongguobatch_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  const firstCover = cover || (episodes[0] && episodes[0].cover) || '';

  const batchInfo = {
    batchId,
    platform: 'hongguo',
    nickname: `《${cleanSeriesTitle}》`,
    avatar: firstCover,
    totalCount: episodes.length,
    createTime: Date.now(),
  };

  let created = 0;
  const changedTasks = [];
  const previousQueue = downloadQueue.slice();
  for (const ep of episodes) {
    const epIndexStr = String(ep.vid_index).padStart(3, '0');
    const filename = uniqueEpisodeFilename(settings, cleanSeriesTitle, ep);
    const finalPath = path.join(downloadDir, filename);

    // 已有同一集在队列/已完成，避免重复建任务。重复记录中只要有完整文件或活动任务，
    // 就跳过；只有没有可用记录时，才把最新失败/停止记录重新入队。
    const duplicates = downloadTasks.filter((t) => t.hongguoInfo && String(t.hongguoInfo.vid) === String(ep.vid));
    const complete = duplicates.find((t) => hasCompleteTaskFile(t));
    const active = duplicates.find((t) => t.status === 'downloading' || t.status === 'pending');
    if (complete || active) continue;
    const dup = duplicates
      .filter(
        (t) => t.status === 'stopped' || t.status === 'failed' || (t.status === 'completed' && !hasCompleteTaskFile(t)),
      )
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))[0];
    if (dup) {
      changedTasks.push({ task: dup, previous: { ...dup } });
      repairTaskDestination(dup);
      dup.status = 'pending';
      dup.cancelled = false;
      dup.progress = 0;
      dup.receivedBytes = 0;
      dup.totalBytes = 0;
      delete dup.error;
      if (!downloadQueue.some((t) => t.id === dup.id)) downloadQueue.push(dup);
      created++;
      continue;
    }

    const task = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      batchId,
      batchInfo,
      savePath: finalPath,
      customDir: downloadDir,
      title: `《${cleanSeriesTitle}》第${epIndexStr}集${ep.title ? ' ' + ep.title : ''}`,
      filename,
      platform: 'hongguo',
      type: 'hongguo',
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      videoInfo: {
        author: cleanSeriesTitle,
        title: `《${cleanSeriesTitle}》第${epIndexStr}集`,
        cover: ep.cover || firstCover,
        aweme_id: ep.vid,
      },
      hongguoInfo: {
        vid: ep.vid,
        series_id: seriesId,
        series_title: cleanSeriesTitle,
        vid_index: ep.vid_index,
        ep_title: ep.title,
      },
    };

    downloadTasks.unshift(task);
    downloadQueue.push(task);
    sendToRenderer('download-task-added', task);
    created++;
  }

  try {
    saveDownloadTasks();
  } catch (error) {
    // An unpersisted submission must not start later through another queue action.
    downloadTasks = downloadTasks.filter((task) => task.batchId !== batchId);
    for (const { task, previous } of changedTasks) Object.assign(task, previous);
    downloadQueue = previousQueue;
    sendToRenderer('download-queue-changed', {});
    throw error;
  }
  pumpQueue();
  return created;
}

ipcMain.handle('hongguo-download-batch', async (event, payload) => {
  try {
    const { seriesId, seriesTitle, episodes, cover } = payload || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { success: false, error: '未选择集数' };
    }
    const count = await enqueueEpisodes({ seriesId, seriesTitle, episodes, cover });
    return { success: true, count, requested: episodes.length };
  } catch (error) {
    console.error('[Hongguo] 提交批量下载失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 播放器里「下载本集」：按 series_id + vid_index 补单集
ipcMain.handle('download-single-episode', async (event, seriesId, vidIndex) => {
  try {
    const entry = seriesRegistry.find((s) => String(s.series_id) === String(seriesId));
    if (!entry) return { success: false, error: '未找到该剧档案，请先解析一次' };
    const ep = entry.episodes.find((e) => Number(e.vid_index) === Number(vidIndex));
    if (!ep) return { success: false, error: '未找到该集' };
    const count = await enqueueEpisodes({
      seriesId: entry.series_id,
      seriesTitle: entry.series_title,
      episodes: [{ ...ep, cover: entry.cover }],
      cover: entry.cover,
    });
    return { success: true, count };
  } catch (error) {
    console.error('[Player] 下载单集失败:', error.message);
    return { success: false, error: error.message };
  }
});

// ===== AI 发布素材 =====
// AI 素材使用独立队列；下载、去重、合并任务只共享输入文件，不共享状态。
let aiMaterialQueue = null;
// API credentials stay in memory only. A queued task uses the settings that
// existed when it was submitted, even if the user edits Settings meanwhile.
const aiRuntimeConfigs = new Map();

function aiOutputDir() {
  return configuredDir(null, 'ai_output_dir', 'AI 素材输出目录');
}

function aiImageExtension(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('webp')) return '.webp';
  return '.png';
}

function aiTaskList() {
  const result = [];
  for (const entry of seriesRegistry) {
    for (const task of Array.isArray(entry.ai_material_tasks) ? entry.ai_material_tasks : []) result.push(task);
  }
  return result;
}

function aiLatestEntry(seriesId) {
  return seriesRegistry.find((entry) => String(entry.series_id) === String(seriesId)) || null;
}

function saveAiTask(task) {
  const entryIndex = seriesRegistry.findIndex((item) => String(item.series_id) === String(task.seriesId));
  if (entryIndex < 0) throw new Error('短剧档案已不存在，无法保存 AI 任务');
  const previous = seriesRegistry[entryIndex];
  const entry = {
    ...previous,
    ai_material_tasks: [...(previous.ai_material_tasks || [])],
    ai_episode_copies: { ...(previous.ai_episode_copies || {}) },
  };
  const index = entry.ai_material_tasks.findIndex((item) => item.id === task.id);
  if (index < 0) entry.ai_material_tasks.push({ ...task });
  else entry.ai_material_tasks[index] = { ...entry.ai_material_tasks[index], ...task };
  if (task.kind === 'episode-copy') {
    const { key, record } = aiEpisodeRecord(entry, task.episodeIndex);
    if (task.status === 'failed' || task.status === 'stopped') {
      entry.ai_episode_copies[key] = {
        ...(record || {}),
        episodeIndex: task.episodeIndex,
        productId: task.productId || record?.productId || null,
        productEpisodeIndices: task.productEpisodeIndices || record?.productEpisodeIndices || [],
        status: task.status,
        error: task.error || '',
        updatedAt: task.updatedAt,
        transcriptPath: task.transcriptPath || record?.transcriptPath || null,
        transcriptFingerprint: task.transcriptFingerprint || record?.transcriptFingerprint || null,
      };
    } else if (task.status === 'queued' || task.status === 'running') {
      entry.ai_episode_copies[key] = {
        ...(record || {}),
        episodeIndex: task.episodeIndex,
        productId: task.productId || record?.productId || null,
        productEpisodeIndices: task.productEpisodeIndices || record?.productEpisodeIndices || [],
        taskId: task.id,
        status: 'processing',
        updatedAt: task.updatedAt,
      };
    }
  }
  if (task.kind === 'cover' && task.status !== 'completed') {
    entry.ai_cover = {
      ...(entry.ai_cover || {}),
      status: ['queued', 'running'].includes(task.status) ? 'processing' : task.status,
      taskId: task.id,
      error: task.error || '',
      updatedAt: task.updatedAt,
    };
  }
  if (task.kind === 'cover' && task.status === 'completed') {
    entry.ai_cover = {
      status: 'completed',
      taskId: task.id,
      path: task.path,
      coverUrl: task.coverUrl,
      prompt: task.prompt || entry.ai_cover?.prompt || '',
      updatedAt: task.updatedAt,
      error: '',
    };
  }
  if (task.kind === 'episode-copy' && task.status === 'completed') {
    const { key } = aiEpisodeRecord(entry, task.episodeIndex);
    entry.ai_episode_copies[key] = {
      episodeIndex: task.episodeIndex,
      productId: task.productId || null,
      productEpisodeIndices: task.productEpisodeIndices || [],
      status: 'completed',
      taskId: task.id,
      outputPath: task.outputPath,
      textPath: task.textPath,
      transcriptPath: task.transcriptPath,
      inputFingerprint: task.inputFingerprint,
      copy: task.copy,
      updatedAt: task.updatedAt,
      error: '',
    };
  }
  seriesRegistry[entryIndex] = entry;
  try {
    saveSeriesRegistry();
  } catch (error) {
    seriesRegistry[entryIndex] = previous;
    throw error;
  }
}

function aiTaskSnapshot(task) {
  const { sourceCover, prompt, child, ...safe } = task || {};
  if (safe.status === 'completed') {
    const outputValid =
      safe.kind === 'cover'
        ? aiOutputIsUsable(safe.path)
        : aiOutputIsUsable(safe.outputPath) && aiOutputIsUsable(safe.textPath);
    const inputValid =
      safe.kind === 'cover' || (safe.inputPath && safe.inputFingerprint === aiInputFingerprint(safe.inputPath));
    if (!outputValid || !inputValid)
      return {
        ...safe,
        status: 'failed',
        stage: 'failed',
        completedAt: null,
        error: outputValid ? '输入视频已变化，请重新生成文案' : '输出素材已移动或删除，请重新生成',
      };
  }
  return { ...safe };
}

function aiNotify(task) {
  sendToRenderer('ai-material-progress', aiTaskSnapshot(task));
  if (['completed', 'failed', 'stopped'].includes(task.status)) aiRuntimeConfigs.delete(task.id);
}

function aiConcurrency() {
  const value = Number(getCurrentSettings().ai_concurrency);
  return Number.isInteger(value) ? Math.max(1, Math.min(4, value)) : 2;
}

function aiRedact(error) {
  const settings = getCurrentSettings();
  // 文本和作图可能是两把不同的 Key，错误信息里两把都要抹掉。
  return openai.redactError(openai.redactError(error, settings.ai_api_key), settings.ai_image_api_key);
}

function aiInputFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 100 * 1024) return null;
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch (_) {
    return null;
  }
}

// AI 文案只能读取“最终成品”。原始下载文件、单独去重输出或仍在合并中的
// 中间文件都不满足条件；getPipelineStatus 同时会检查成品指纹，文件被移动/修改后立即失效。
function aiReadyEpisodeProduct(seriesId, episodeIndex) {
  const status = getPipelineStatus(seriesId);
  if (!status.success) return { error: status.error || '未找到该剧档案' };
  const episode = status.episodes.find((item) => Number(item.episodeIndex) === Number(episodeIndex));
  if (!episode?.ready || !episode.path || !pipelineFileValid(episode.path, null)) {
    return { error: `第 ${episodeIndex} 集尚未完成去重、分组和成品导出，请先完成视频处理` };
  }
  const product =
    status.final.products.find((item) => item.id === episode.groupId) ||
    status.final.products.find((item) => item.episodeIndices.includes(Number(episodeIndex)));
  if (!product || !pipelineFileValid(product.path, null)) {
    return { error: `第 ${episodeIndex} 集的最终成品不存在或已失效，请重新处理` };
  }
  return { path: product.path, product, status };
}

function aiReadyProductForSeries(seriesId) {
  const status = getPipelineStatus(seriesId);
  if (!status.success) return { error: status.error || '未找到该剧档案' };
  const product = status.final.products[0];
  if (!product || !pipelineFileValid(product.path, null))
    return { error: '请先下载视频、完成去重，并完成至少一个分组的最终成品导出' };
  return { product, status };
}

function aiReadyProductById(seriesId, productId) {
  const status = getPipelineStatus(seriesId);
  if (!status.success) return { error: status.error || '未找到该剧档案' };
  const product = status.final.products.find((item) => String(item.id) === String(productId));
  if (!product || !pipelineFileValid(product.path, null))
    return { error: '指定的最终成品不存在或已失效，请重新完成视频处理' };
  const episodeIndex = product.episodeIndices[0];
  if (!Number.isSafeInteger(Number(episodeIndex))) return { error: '最终成品没有关联有效分集' };
  return { product, status, episodeIndex: Number(episodeIndex) };
}

function aiOutputIsUsable(filePath) {
  try {
    return !!filePath && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch (_) {
    return false;
  }
}

function runAiFfmpeg(args, signal) {
  const ffmpegPath = resolveFfmpeg('ffmpeg');
  if (!ffmpegPath) return Promise.reject(new Error('未找到内置 FFmpeg，无法提取音频'));
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const child = execFile(ffmpegPath, args, { windowsHide: true, timeout: 15 * 60 * 1000 }, (error) => {
      cleanup();
      if (signal?.aborted) reject(new Error('任务已取消'));
      else if (error) reject(new Error('音频提取失败，请检查视频是否包含音轨'));
      else resolve();
    });
    const abort = () => {
      try {
        child.kill('SIGTERM');
      } catch (_) {}
    };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    child.stderr?.on('data', () => {});
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

async function extractAudioForAi(videoPath, outputPath, signal) {
  await runAiFfmpeg(
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      videoPath,
      // whisper.cpp 的跨平台 CLI 最稳妥地读取 16 kHz、单声道 PCM WAV。
      // 不输出 m4a/AAC，避免不同平台的 whisper 构建缺少解码器而失败。
      '-vn',
      '-map',
      '0:a:0?',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    signal,
  );
  const stat = await fsp.stat(outputPath);
  if (!stat.isFile() || stat.size < 256) throw new Error('音频提取没有生成有效文件');
}

async function transcribeAiAudio(audioPath, signal, settings = {}) {
  const engine = String(settings.ai_transcription_engine || 'whisper.cpp')
    .trim()
    .toLowerCase();
  const localSettings = {
    ...settings,
    projectRoot: __dirname,
    resourcesPath: process.resourcesPath || settings.resourcesPath,
  };
  const local = () =>
    whisper.transcribeAudio(
      audioPath,
      {
        language: settings.whisper_language || 'zh',
        signal,
      },
      localSettings,
    );
  const remote = () =>
    openai.transcribeAudio(
      audioPath,
      {
        language: settings.whisper_language || 'zh',
        contentType: 'audio/wav',
        signal,
      },
      settings,
    );

  if (engine === 'openai') return remote();
  if (
    engine === 'openai-fallback' ||
    engine === 'whisper.cpp+openai-fallback' ||
    engine === 'whisper-openai-fallback'
  ) {
    try {
      return await local();
    } catch (error) {
      if (signal?.aborted) throw error;
      // This branch is only reachable when the user explicitly selected the
      // fallback mode. It is deliberately absent from the default path.
      return remote();
    }
  }
  return local();
}

function aiEpisodeRecord(entry, episodeIndex) {
  const key = String(Number(episodeIndex));
  if (!entry.ai_episode_copies || typeof entry.ai_episode_copies !== 'object') entry.ai_episode_copies = {};
  return { key, record: entry.ai_episode_copies[key] || null };
}

function aiValidEpisodeCopy(entry, episodeIndex) {
  const record = entry?.ai_episode_copies?.[String(Number(episodeIndex))];
  if (!record || record.status !== 'completed' || !aiOutputIsUsable(record.outputPath)) return null;
  if (!record.textPath || !aiOutputIsUsable(record.textPath)) return null;
  if (record.transcriptPath && !aiOutputIsUsable(record.transcriptPath)) return null;
  const ready = aiReadyEpisodeProduct(entry.series_id, episodeIndex);
  const input = ready.path;
  if (record.productId && ready.product?.id && String(record.productId) !== String(ready.product.id)) return null;
  if (!record.inputFingerprint || !input || aiInputFingerprint(input) !== record.inputFingerprint) return null;
  return record;
}

function aiValidCover(entry) {
  const cover = entry?.ai_cover;
  return cover?.status === 'completed' && aiOutputIsUsable(cover.path) ? cover : null;
}

function ensureAiQueue() {
  if (aiMaterialQueue) return aiMaterialQueue;
  aiMaterialQueue = createAiMaterialQueue({
    list: aiTaskList,
    save: saveAiTask,
    notify: aiNotify,
    concurrency: aiConcurrency,
    redact: aiRedact,
    execute: executeAiMaterialTask,
  });
  return aiMaterialQueue;
}

async function executeAiMaterialTask(task, { signal, update }) {
  const entry = aiLatestEntry(task.seriesId);
  if (!entry) throw new Error('短剧档案已不存在');
  const latestStatus = getPipelineStatus(task.seriesId);
  if (!latestStatus.success) throw new Error(latestStatus.error || '未找到该剧档案');
  const latestProduct = task.productId
    ? latestStatus.final.products.find((item) => String(item.id) === String(task.productId))
    : latestStatus.final.products.find((item) => item.episodeIndices.includes(Number(task.episodeIndex)));
  if (
    !latestProduct ||
    !pipelineFileValid(latestProduct.path, latestProduct.id === task.productId ? task.productFingerprint : null)
  ) {
    throw new Error('最终成品已移动、删除或发生变化，请重新完成视频处理后再生成 AI 素材');
  }
  const settings = aiRuntimeConfigs.get(task.id) || getCurrentSettings();
  if (task.kind === 'cover') {
    update({ stage: 'generating', progress: 10 });
    const source = task.sourceCover || entry.cover || '';
    const image = source
      ? await openai.editImage(
          {
            image: source,
            prompt: task.prompt,
            size: settings.ai_image_size,
            quality: settings.ai_image_quality,
            signal,
          },
          settings,
        )
      : await openai.generateImage(
          { prompt: task.prompt, size: settings.ai_image_size, quality: settings.ai_image_quality, signal },
          settings,
        );
    update({ stage: 'saving', progress: 90 });
    const outputDir = path.join(aiOutputDir(), '封面');
    await fsp.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(
      outputDir,
      `${sanitizeFolderName(entry.series_title) || '短剧'}-重绘-${Date.now()}${aiImageExtension(image.contentType)}`,
    );
    await fsp.writeFile(outputPath, image.buffer);
    signal.throwIfAborted();
    const cover = { path: outputPath, coverUrl: localAssetUrl(outputPath), updatedAt: Date.now() };
    return { path: outputPath, coverUrl: cover.coverUrl, updatedAt: cover.updatedAt };
  }

  if (task.kind !== 'episode-copy') throw new Error('未知 AI 任务类型');
  const videoPath = task.inputPath;
  const fingerprint = aiInputFingerprint(videoPath);
  if (!fingerprint || fingerprint !== task.inputFingerprint)
    throw new Error('输入视频已移动、删除或发生变化，请重新加入任务');
  const latest = aiLatestEntry(task.seriesId);
  const episode = latest?.episodes?.find((item) => Number(item.vid_index) === Number(task.episodeIndex));
  const materialDir = path.join(aiOutputDir(), '文案');
  const productIndices =
    Array.isArray(task.productEpisodeIndices) && task.productEpisodeIndices.length
      ? task.productEpisodeIndices.map(Number).filter(Number.isSafeInteger)
      : [Number(task.episodeIndex)].filter(Number.isSafeInteger);
  const prefix = task.productId
    ? `作品-${sanitizeFolderName(String(task.productId))}`
    : `第${String(task.episodeIndex).padStart(3, '0')}集`;
  const transcriptPath = task.transcriptPath || path.join(materialDir, `${prefix}-转写.txt`);
  let transcript;
  if (task.transcriptFingerprint === fingerprint && aiOutputIsUsable(transcriptPath)) {
    if ((await fsp.stat(transcriptPath)).size > 2 * 1024 * 1024) throw new Error('转写缓存过大，请重新生成');
    transcript = await fsp.readFile(transcriptPath, 'utf8');
    update({ stage: 'summarizing', progress: 55, transcriptPath });
  } else {
    const tempDir = path.join(app.getPath('temp'), 'hongguo-ai', randomUUID());
    const audioPath = path.join(tempDir, 'audio.wav');
    try {
      await fsp.mkdir(tempDir, { recursive: true });
      update({ stage: 'extracting', progress: 10 });
      await extractAudioForAi(videoPath, audioPath, signal);
      update({ stage: 'transcribing', progress: 35 });
      transcript = await transcribeAiAudio(audioPath, signal, settings);
      if (!transcript) throw new Error('没有识别到可用台词');
      await fsp.mkdir(materialDir, { recursive: true });
      await fsp.writeFile(transcriptPath, transcript, 'utf8');
      update({ stage: 'summarizing', progress: 55, transcriptPath, transcriptFingerprint: fingerprint });
    } finally {
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
  update({ stage: 'summarizing', progress: 70 });
  const copy = await openai.summarizeEpisode(
    transcript,
    {
      seriesTitle: latest.series_title,
      seriesSynopsis: latest.synopsis || '',
      episodeIndex: task.episodeIndex,
      episodeTitle: task.productId ? `最终成品（第 ${productIndices.join('、')} 集）` : episode?.title || '',
      signal,
    },
    settings,
  );
  update({ stage: 'saving', progress: 90 });
  await fsp.mkdir(materialDir, { recursive: true });
  const outputPath = path.join(materialDir, `${prefix}-文案.json`);
  const textPath = path.join(materialDir, `${prefix}-文案.txt`);
  const text = [
    copy.title,
    copy.summary,
    copy.hook,
    Array.isArray(copy.hashtags) ? copy.hashtags.join(' ') : copy.hashtags,
  ]
    .filter(Boolean)
    .join('\n');
  await fsp.writeFile(
    outputPath,
    JSON.stringify(
      {
        seriesId: task.seriesId,
        seriesTitle: latest.series_title,
        productId: task.productId || null,
        episodeIndices: productIndices,
        episodeIndex: task.episodeIndex,
        episodeTitle: task.productId ? `最终成品（第 ${productIndices.join('、')} 集）` : episode?.title || '',
        copy,
        transcriptPath,
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
    'utf8',
  );
  await fsp.writeFile(textPath, text, 'utf8');
  signal.throwIfAborted();
  if (aiInputFingerprint(videoPath) !== fingerprint) throw new Error('输入视频在处理期间发生变化，请重新生成');
  const updatedAt = Date.now();
  return { outputPath, textPath, transcriptPath, inputFingerprint: fingerprint, copy, updatedAt };
}

function existingAiTask(seriesId, kind, episodeIndex, productId = null) {
  return (
    aiTaskList()
      .filter(
        (item) =>
          String(item.seriesId) === String(seriesId) &&
          item.kind === kind &&
          Number(item.episodeIndex || 0) === Number(episodeIndex || 0) &&
          (productId == null || String(item.productId || '') === String(productId)),
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null
  );
}

function enqueueCopyTask(seriesId, episodeIndex, force = false, productId = null) {
  const entry = aiLatestEntry(seriesId);
  if (!entry) return { error: '未找到该剧档案' };
  const ready = productId ? aiReadyProductById(seriesId, productId) : aiReadyEpisodeProduct(seriesId, episodeIndex);
  if (ready.error) return { error: ready.error };
  episodeIndex = Number(ready.episodeIndex || episodeIndex);
  const videoPath = ready.path;
  const fingerprint = pipelineFingerprint(videoPath);
  if (!videoPath || !fingerprint) return { error: `第 ${episodeIndex} 集的最终成品不存在或已失效` };
  const previous = existingAiTask(seriesId, 'episode-copy', episodeIndex, ready.product.id);
  const cached = aiValidEpisodeCopy(entry, episodeIndex);
  if (!force && cached && previous?.inputFingerprint === fingerprint) return { cached: true, task: previous };
  const reusable = previous && !['queued', 'running'].includes(previous.status) ? previous : null;
  const taskInput = {
    kind: 'episode-copy',
    seriesId: String(seriesId),
    episodeIndex: Number(episodeIndex),
    productId: ready.product.id,
    productPath: videoPath,
    productFingerprint: fingerprint,
    productEpisodeIndices: ready.product.episodeIndices,
    inputPath: videoPath,
    inputFingerprint: fingerprint,
    stage:
      reusable?.transcriptFingerprint === fingerprint && aiOutputIsUsable(reusable.transcriptPath)
        ? 'summarizing'
        : 'queued',
    transcriptPath: reusable?.transcriptFingerprint === fingerprint ? reusable.transcriptPath : null,
    transcriptFingerprint: reusable?.transcriptFingerprint === fingerprint ? fingerprint : null,
  };
  const admission = ensureAiQueue().enqueue(taskInput, reusable);
  const queued = admission.task;
  if (!admission.duplicate) aiRuntimeConfigs.set(queued.id, { ...getCurrentSettings() });
  return { task: queued };
}

function enqueueCoverTask(payload = {}) {
  const sid = String(payload.seriesId || '');
  const entry = aiLatestEntry(sid);
  if (!entry) return { error: '未找到该剧档案' };
  const ready = aiReadyProductForSeries(sid);
  if (ready.error) return { error: ready.error };
  const previous = existingAiTask(sid, 'cover', 0);
  const active = aiTaskList().find(
    (task) => task.kind === 'cover' && String(task.seriesId) === sid && ['queued', 'running'].includes(task.status),
  );
  if (active) return { duplicate: true, task: active };
  const prompt =
    String(payload.prompt || '').trim() ||
    `为短剧《${entry.series_title}》重绘竖版发布封面，保留故事氛围但重新设计人物构图与背景，不要水印、不要平台标志、不要多余文字，适合短视频封面。`;
  const reusable = previous && !['queued', 'running'].includes(previous.status) ? previous : null;
  const task = ensureAiQueue().enqueue(
    {
      kind: 'cover',
      seriesId: sid,
      episodeIndex: 0,
      productId: ready.product.id,
      productPath: ready.product.path,
      productFingerprint: pipelineFingerprint(ready.product.path),
      productEpisodeIndices: ready.product.episodeIndices,
      sourceCover: payload.cover || entry.cover || '',
      prompt,
    },
    reusable,
  ).task;
  aiRuntimeConfigs.set(task.id, { ...getCurrentSettings() });
  return { task };
}

function startAiCopies(payload = {}) {
  const sid = String(payload.seriesId || '');
  const entry = aiLatestEntry(sid);
  if (!entry) return { success: false, error: '未找到该剧档案', tasks: [] };
  const requestedProducts = Array.isArray(payload.productIds)
    ? [...new Set(payload.productIds.map(String).filter(Boolean))]
    : [];
  const requested = Array.isArray(payload.episodeIndices) ? payload.episodeIndices : [];
  if (requestedProducts.length) {
    const tasks = [],
      skipped = [],
      cached = [];
    for (const productId of requestedProducts) {
      const ready = aiReadyProductById(sid, productId);
      if (ready.error) {
        skipped.push({ productId, error: ready.error });
        continue;
      }
      const result = enqueueCopyTask(sid, ready.episodeIndex, payload.force === true, productId);
      if (result.cached) cached.push(aiTaskSnapshot(result.task));
      else if (result.error) skipped.push({ productId, error: result.error });
      else tasks.push(aiTaskSnapshot(result.task));
    }
    return { success: true, tasks, cached, skipped, queued: tasks.filter((task) => task.status === 'queued').length };
  }
  const indices = [...new Set(requested.map(Number).filter((index) => Number.isSafeInteger(index) && index > 0))];
  if (!indices.length) return { success: false, error: '未选择有效集数', tasks: [] };
  const tasks = [],
    skipped = [],
    cached = [];
  for (const index of indices) {
    const result = enqueueCopyTask(sid, index, payload.force === true);
    if (result.cached) {
      cached.push(aiTaskSnapshot(result.task));
      continue;
    }
    if (result.error) {
      skipped.push({ episodeIndex: index, error: result.error });
      continue;
    }
    tasks.push(aiTaskSnapshot(result.task));
  }
  return { success: true, tasks, cached, skipped, queued: tasks.filter((task) => task.status === 'queued').length };
}

ipcMain.handle('ai-start-copies', async (_event, payload = {}) => {
  try {
    return startAiCopies(payload);
  } catch (error) {
    return { success: false, error: aiRedact(error), tasks: [] };
  }
});

ipcMain.handle('ai-generate-episode-copy', async (_event, payload = {}) => {
  try {
    const result = startAiCopies({ ...payload, episodeIndices: [payload.episodeIndex], force: payload.force });
    const task = result.tasks?.[0] || result.cached?.[0] || null;
    return result.success
      ? {
          ...result,
          task,
          outputPath: task?.outputPath,
          textPath: task?.textPath,
          transcriptPath: task?.transcriptPath,
          copy: task?.copy,
        }
      : result;
  } catch (error) {
    return { success: false, error: aiRedact(error) };
  }
});

ipcMain.handle('get-ai-material-tasks', async (_event, options = {}) => {
  const sid = options.seriesId == null ? null : String(options.seriesId);
  return {
    success: true,
    tasks: aiTaskList()
      .filter((task) => sid == null || String(task.seriesId) === sid)
      .map(aiTaskSnapshot),
  };
});

ipcMain.handle('cancel-ai-material', async (_event, id) => {
  try {
    return ensureAiQueue().cancel(String(id));
  } catch (error) {
    return { success: false, error: aiRedact(error) };
  }
});

ipcMain.handle('open-ai-material', async (_event, id) => {
  const task = aiTaskList().find((item) => item.id === String(id));
  if (!task) return { success: false, error: '任务不存在' };
  if (aiTaskSnapshot(task).status !== 'completed') return { success: false, error: '素材未完成或文件已发生变化' };
  const file = task.path || task.textPath || task.outputPath;
  if (!file || !fs.existsSync(file)) return { success: false, error: '素材文件不存在' };
  const error = await shell.openPath(file);
  if (error) return { success: false, error: '无法打开素材，请检查系统默认应用' };
  return { success: true, path: file };
});

ipcMain.handle('ai-generate-cover', async (_event, payload = {}) => {
  try {
    const result = enqueueCoverTask(payload);
    if (result.error) return { success: false, error: result.error };
    return { success: true, task: aiTaskSnapshot(result.task) };
  } catch (error) {
    return { success: false, error: aiRedact(error) };
  }
});

ipcMain.handle('get-whisper-status', async () => {
  const settings = getCurrentSettings();
  return whisper.checkWhisper({
    ...settings,
    projectRoot: __dirname,
    resourcesPath: process.resourcesPath || settings.resourcesPath,
  });
});

// ===== IPC：设置 =====
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-settings', async () => getCurrentSettings());

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const merged = { ...getDefaultSettings(), ...(settings || {}) };
    store.saveSettings(merged);
    getCurrentSettings(); // 刷新并发数
    // 并发上限可在运行中调整，保存设置后立即填充新增的空闲槽位。
    pumpQueue();
    await applyProxySettings(merged); // 立即生效，无需重启
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ===== IPC：网络代理 =====
ipcMain.handle('get-proxy-status', async () => {
  const settings = getCurrentSettings();
  const resolved = resolveProxyConfig(settings);
  return {
    enabled: settings.proxy_enabled === true,
    mode: resolved.mode,
    url: publicProxyUrl(resolved.url),
    effective: resolved.mode !== 'direct' && (resolved.mode !== 'custom' || !!resolved.url),
  };
});

// 用当前表单值实测代理是否连通（未保存也能测）
ipcMain.handle('test-proxy', async (event, draft) => {
  const settings = { ...getCurrentSettings(), ...(draft || {}) };
  const resolved = resolveProxyConfig(settings);
  if (resolved.mode === 'custom' && !resolved.url) {
    return { success: false, error: '请填写完整的代理地址与端口' };
  }

  // 按当前配置构造 axios 选项：custom 显式指定，system 交给环境变量，direct 关闭
  let proxyOption;
  if (resolved.mode === 'direct') {
    proxyOption = false;
  } else if (resolved.mode === 'custom') {
    try {
      const url = new URL(resolved.url);
      proxyOption = {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      };
      if (url.username)
        proxyOption.auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    } catch (_) {
      return { success: false, error: '代理地址格式无效' };
    }
  } else {
    proxyOption = null; // 交给 proxy-from-env 读环境变量
  }

  const started = Date.now();
  try {
    const res = await axios.get('https://www.baidu.com', {
      timeout: 12000,
      proxy: proxyOption,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: () => true,
    });
    const ms = Date.now() - started;
    if (res.status >= 200 && res.status < 400) {
      return {
        success: true,
        elapsed: ms,
        mode: resolved.mode,
        via: publicProxyUrl(resolved.url) || (resolved.mode === 'direct' ? '(直连)' : '(系统/环境变量代理)'),
        message: `连通正常（HTTP ${res.status}，耗时 ${ms}ms）`,
      };
    }
    return { success: false, error: `请求返回 HTTP ${res.status}（耗时 ${ms}ms）` };
  } catch (error) {
    const ms = Date.now() - started;
    const code = (error && error.code) || '';
    let hint = publicProxyError(error.message, settings, resolved);
    if (code === 'ECONNREFUSED') hint = '代理端口拒绝连接，请确认代理软件已启动、端口填写正确';
    else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') hint = '连接超时，请检查代理地址/端口或代理是否可用';
    else if (code === 'ENOTFOUND') hint = '无法解析代理地址，请检查主机名';
    else if (/407/.test(hint)) hint = '代理需要认证，请填写用户名与密码';
    return { success: false, error: `${hint}（耗时 ${ms}ms）`, code };
  }
});

// ===== IPC：下载管理 =====
ipcMain.handle('get-download-tasks', (_event, options = {}) => {
  const STATUS_ORDER = {
    downloading: 0,
    pending: 1,
    failed: 2,
    stopped: 3,
    completed: 4,
  };
  const sorted = downloadTasks.slice().sort((a, b) => {
    const wa = STATUS_ORDER[a.status] ?? 99;
    const wb = STATUS_ORDER[b.status] ?? 99;
    if (wa !== wb) return wa - wb;
    if (wa <= 1) {
      return (
        (a.hongguoInfo?.vid_index || 0) - (b.hongguoInfo?.vid_index || 0) || (a.startTime || 0) - (b.startTime || 0)
      );
    }
    return (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0);
  });
  const completedOnly = options?.completedOnly === true;
  const requestedLimit = Number(options?.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 0;
  const selected = completedOnly ? sorted.filter((task) => task.status === 'completed' && task.savePath) : sorted;
  return (limit ? selected.slice(0, limit) : selected).map((task) => {
    const { cancelSource, writer, ...serializableTask } = task;
    if (task.status === 'completed' && !hasCompleteTaskFile(task)) {
      return { ...serializableTask, status: 'failed', progress: 0, error: '本地文件已丢失或路径冲突，请重新下载' };
    }
    return serializableTask;
  });
});

// ===== 文件清理（删除已下载的本地文件）=====

/** 删除单个任务对应的本地文件（.mp4 及可能残留的 .enc.tmp），返回释放的字节数 */
function removeTaskFile(task) {
  if (!task || !task.savePath) return { freed: 0, failed: 0 };
  if (isFileInUse(task.savePath)) return { freed: 0, failed: 1, protected: true };
  let freed = 0;
  let failed = 0;
  for (const p of [task.savePath, task.savePath + '.enc.tmp', task.savePath + '.enc.tmp.decoded']) {
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        fs.unlinkSync(p);
        freed += st.size;
      }
    } catch (e) {
      failed++;
    }
  }
  return { freed, failed };
}

async function stopTaskAndWait(task) {
  task.cancelled = true;
  task.cancelSource?.cancel('用户删除任务');
  task.writer?.destroy();
  task.status = 'stopped';
  downloadQueue = downloadQueue.filter((item) => item.id !== task.id);
  await downloadRuns.get(task.id);
}

function isTaskInFlight(task) {
  return task.status === 'pending' || task.status === 'downloading' || runningDownloads.has(task.id);
}

function isFileInUse(file) {
  const key = quchongPathKey(file);
  if (key && quchongInputRuns.has(key)) return true;
  if (
    key &&
    [...quchongBatches.values()].some(
      (batch) =>
        !batch.finished &&
        (batch.tasks.some((task) => ['pending', 'running'].includes(task.status) && quchongPathKey(task.src) === key) ||
          (batch.bgm && quchongPathKey(batch.bgm) === key)),
    )
  )
    return true;
  // AI 文案提取只读取已下载源文件，任务在 queued/running 阶段也不能删除输入。
  try {
    const aiTasks = aiTaskList();
    if (
      aiTasks.some(
        (task) =>
          ['queued', 'running', 'extracting', 'transcribing'].includes(task.status) &&
          task.inputPath &&
          quchongPathKey(task.inputPath) === key,
      )
    )
      return true;
  } catch (_) {}
  return runningDownloadPaths.has(file) || downloadTasks.some((task) => task.savePath === file && isTaskInFlight(task));
}

function removeFinishedRecords(seriesId) {
  const ids = downloadTasks
    .filter(
      (task) =>
        (seriesId == null || String(task.hongguoInfo?.series_id) === String(seriesId)) &&
        !isTaskInFlight(task) &&
        task.status === 'completed' &&
        task.savePath &&
        !fs.existsSync(task.savePath),
    )
    .map((task) => task.id);
  if (ids.length) dropTaskRecords(ids);
}

/** 删掉一组任务记录（从内存与队列中移除） */
function dropTaskRecords(ids) {
  const set = new Set(ids.filter((id) => !downloadTasks.some((task) => task.id === id && isTaskInFlight(task))));
  downloadTasks = downloadTasks.filter((t) => !set.has(t.id));
  downloadQueue = downloadQueue.filter((t) => !set.has(t.id));
  saveDownloadTasks();
}

/** 某个 seriesId 下，磁盘上实际存在的文件（含没有任务记录的孤儿文件） */
function seriesFilePaths(seriesId) {
  const sid = String(seriesId);
  if (mergeTasks.some((task) => task.seriesId === sid && task.status === 'running')) return [];
  const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
  const paths = new Set();
  try {
    const { ordered } = collectSeriesEpisodeFiles(sid);
    for (const o of ordered) paths.add(o.path);
  } catch (_) {}
  for (const t of downloadTasks) {
    if (t.hongguoInfo && String(t.hongguoInfo.series_id) === sid && t.savePath) paths.add(t.savePath);
  }
  return [...paths].filter((file) => !isFileInUse(file));
}

ipcMain.handle('delete-task', async (event, taskId, options) => {
  const deleteFiles = !!(options && options.deleteFiles);
  const taskIndex = downloadTasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return { success: false, error: '任务不存在' };

  const task = downloadTasks[taskIndex];
  await stopTaskAndWait(task);

  let freed = 0;
  if (deleteFiles) {
    const result = removeTaskFile(task);
    freed = result.freed;
    if (result.failed) return { success: false, error: '文件删除失败，任务记录已保留', ...result };
  }

  downloadTasks = downloadTasks.filter((item) => item.id !== taskId);
  // 从队列移除
  const qIndex = downloadQueue.findIndex((t) => t.id === taskId);
  if (qIndex !== -1) downloadQueue.splice(qIndex, 1);

  saveDownloadTasks();
  return { success: true, freed };
});

ipcMain.handle('delete-tasks', async (event, taskIds, options) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return { success: false, error: '没有要删除的任务' };
  const deleteFiles = !!(options && options.deleteFiles);
  let freed = 0,
    failed = 0,
    count = 0;
  for (const id of taskIds) {
    const t = downloadTasks.find((x) => x.id === id);
    if (!t) continue;
    await stopTaskAndWait(t);
    if (deleteFiles) {
      const result = removeTaskFile(t);
      freed += result.freed;
      if (result.failed) {
        failed++;
        continue;
      }
    }
    await deleteOneTask(id);
    count++;
  }
  saveDownloadTasks();
  return {
    success: failed === 0,
    count,
    freed,
    failed,
    error: failed ? `${failed} 个任务的文件删除失败，记录已保留` : undefined,
  };
});

async function deleteOneTask(taskId) {
  const taskIndex = downloadTasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return;
  const task = downloadTasks[taskIndex];
  await stopTaskAndWait(task);
  downloadTasks = downloadTasks.filter((item) => item.id !== taskId);
  const qIndex = downloadQueue.findIndex((t) => t.id === taskId);
  if (qIndex !== -1) downloadQueue.splice(qIndex, 1);
}

/**
 * 删除某一部剧的全部本地文件（含合并产物），并清理对应任务记录。
 * 剧集档案保留（仍能看到分集、可在线播放），只是变成「未下载」。
 */
ipcMain.handle('delete-series-files', async (event, seriesId, options) => {
  try {
    const sid = String(seriesId);
    const includeMerged = !(options && options.includeMerged === false);
    if (mergeTasks.some((task) => task.seriesId === sid && task.status === 'running'))
      return { success: false, error: '该剧正在合并，请完成或取消合并后再清理' };
    const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
    const title = (entry && entry.series_title) || '';

    const protectedInputs = downloadTasks.filter(
      (task) => String(task.hongguoInfo?.series_id) === sid && task.savePath && isFileInUse(task.savePath),
    );
    if (protectedInputs.length) {
      return { success: false, error: '该剧有下载、视频处理或 AI 文案任务正在读取文件，请完成或停止后再清理' };
    }

    const paths = seriesFilePaths(sid);
    let count = 0;
    let freed = 0;
    let failed = 0;

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          freed += fs.statSync(p).size;
          fs.unlinkSync(p);
          count++;
        }
      } catch (e) {
        failed++;
        console.warn('[Clean] 删除失败:', p, e.message);
      }
      // 顺带清掉可能残留的临时文件
      try {
        const tmp = p + '.enc.tmp';
        if (fs.existsSync(tmp)) {
          freed += fs.statSync(tmp).size;
          fs.unlinkSync(tmp);
        }
      } catch (_) {}
    }

    // 合并产物（合集.mp4）与残留的 concat 列表
    const dir = (() => {
      try {
        const c = collectSeriesEpisodeFiles(sid);
        if (c.dir) return c.dir;
      } catch (_) {}
      return null;
    })();
    if (dir && fs.existsSync(dir)) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (_) {}
      for (const f of names) {
        const isMerged = includeMerged && f.endsWith('.mp4') && f.includes('合集');
        const isList = f.endsWith('.ffconcat.txt');
        if (!isMerged && !isList) continue;
        try {
          const p = path.join(dir, f);
          if (isFileInUse(p)) continue;
          const st = fs.statSync(p);
          fs.unlinkSync(p);
          freed += st.size;
          count++;
        } catch (_) {
          failed++;
        }
      }
      // 目录空了就一并删掉
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch (_) {}
    }

    // 清理任务记录与在线缓存
    removeFinishedRecords(sid);
    for (const [vid, e] of [...onlineCache]) {
      if (String(e.seriesId) === sid) onlineCache.delete(vid);
    }

    console.log(`[Clean] 删除《${title}》本地文件 ${count} 个，释放 ${(freed / 1048576).toFixed(1)}MB`);
    return {
      success: failed === 0,
      count,
      freed,
      failed,
      error: failed ? '部分文件删除失败，对应记录已保留' : undefined,
    };
  } catch (error) {
    console.error('[Clean] 删除剧集文件失败:', error.message);
    return { success: false, error: error.message };
  }
});

/** 删除单集本地文件（看完即删用） */
ipcMain.handle('delete-episode-file', async (event, seriesId, vidIndex) => {
  try {
    const sid = String(seriesId);
    const idx = Number(vidIndex);
    const tasks = downloadTasks.filter(
      (task) => String(task.hongguoInfo?.series_id) === sid && Number(task.hongguoInfo?.vid_index) === idx,
    );
    if (tasks.some(isTaskInFlight) || mergeTasks.some((task) => task.seriesId === sid && task.status === 'running'))
      return { success: false, error: '该集正在下载或合并，暂不删除', count: 0, freed: 0 };
    const entry = seriesRegistry.find((item) => String(item.series_id) === sid);
    const paths = [
      ...new Set(
        tasks.length
          ? tasks.map((task) => task.savePath).filter(Boolean)
          : collectSeriesEpisodeFiles(sid)
              .ordered.filter((episode) => episode.vid_index === idx)
              .map((episode) => episode.path),
      ),
    ];
    let freed = 0;
    let count = 0,
      failed = 0;
    for (const p of paths) {
      if (isFileInUse(p)) {
        failed++;
        continue;
      }
      try {
        if (fs.existsSync(p)) {
          freed += fs.statSync(p).size;
          fs.unlinkSync(p);
          count++;
        }
      } catch (_) {
        failed++;
      }
    }
    const ids = tasks.filter((task) => task.savePath && !fs.existsSync(task.savePath)).map((task) => task.id);
    if (ids.length) dropTaskRecords(ids);
    return { success: failed === 0, count, freed, failed, error: failed ? '文件删除失败，任务记录已保留' : undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/** 各处磁盘占用统计（用于展示「可释放多少」） */
ipcMain.handle('get-storage-usage', async () => {
  try {
    const series = [];
    let totalBytes = 0;
    let totalFiles = 0;
    for (const s of seriesRegistry) {
      if (s.dismissed) continue;
      const paths = seriesFilePaths(s.series_id);
      let bytes = 0;
      let files = 0;
      for (const p of paths) {
        try {
          if (fs.existsSync(p)) {
            bytes += fs.statSync(p).size;
            files++;
          }
        } catch (_) {}
      }
      // 合并产物
      let merged = 0;
      let mergedBytes = 0;
      try {
        const c = collectSeriesEpisodeFiles(s.series_id);
        if (c.dir && fs.existsSync(c.dir)) {
          for (const f of fs.readdirSync(c.dir)) {
            if (f.endsWith('.mp4') && f.includes('合集')) {
              mergedBytes += fs.statSync(path.join(c.dir, f)).size;
              merged++;
            }
          }
        }
      } catch (_) {}
      bytes += mergedBytes;
      files += merged;
      totalBytes += bytes;
      totalFiles += files;
      series.push({
        series_id: String(s.series_id),
        series_title: s.series_title,
        total: (s.episodes || []).length,
        files,
        bytes,
        merged,
      });
    }
    series.sort((a, b) => b.bytes - a.bytes);
    return { success: true, totalBytes, totalFiles, series };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/** 删除所有已下载的本地文件（剧集档案保留，之后仍可在线看） */
ipcMain.handle('delete-all-downloaded', async () => {
  try {
    let freed = 0;
    let count = 0,
      failed = 0;
    const targets = [
      ...new Set([
        ...seriesRegistry.map((s) => s.series_id),
        ...downloadTasks.map((t) => t.hongguoInfo?.series_id).filter(Boolean),
      ]),
    ];
    for (const sid of targets) {
      if (mergeTasks.some((task) => task.seriesId === String(sid) && task.status === 'running')) continue;
      const paths = seriesFilePaths(sid);
      for (const p of paths) {
        try {
          if (fs.existsSync(p)) {
            freed += fs.statSync(p).size;
            fs.unlinkSync(p);
            count++;
          }
        } catch (_) {
          failed++;
        }
      }
      try {
        const c = collectSeriesEpisodeFiles(sid);
        if (c.dir && fs.existsSync(c.dir)) {
          for (const f of fs.readdirSync(c.dir)) {
            if (f.endsWith('.mp4') && f.includes('合集')) {
              const p = path.join(c.dir, f);
              if (isFileInUse(p)) continue;
              freed += fs.statSync(p).size;
              fs.unlinkSync(p);
              count++;
            }
          }
        }
      } catch (_) {
        failed++;
      }
    }
    // 仅移除已经成功清理的完成记录；运行中和等待中的任务保留。
    removeFinishedRecords(null);
    clearOnlineCache();
    return {
      success: failed === 0,
      count,
      freed,
      failed,
      error: failed ? '部分文件删除失败，对应记录已保留' : undefined,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-download', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  task.cancelled = true;
  if (task.cancelSource) {
    try {
      task.cancelSource.cancel('用户停止下载');
    } catch (_) {}
  }
  if (task.writer) {
    try {
      task.writer.destroy();
    } catch (_) {}
  }

  task.status = 'stopped';
  task.error = '';
  task.endTime = Date.now();
  delete task.cancelSource;
  delete task.writer;

  saveDownloadTasks();
  sendToRenderer('download-stopped', { id: taskId, path: task.savePath });
  return { success: true };
});

ipcMain.handle('retry-task', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };
  if (!['failed', 'stopped'].includes(task.status) && !(task.status === 'completed' && !hasCompleteTaskFile(task)))
    return { success: false, error: '任务仍在进行中或已完成' };

  repairTaskDestination(task);

  task.status = 'pending';
  task.progress = 0;
  task.receivedBytes = 0;
  task.totalBytes = 0;
  task.cancelled = false;
  delete task.error;
  delete task.cancelSource;
  delete task.writer;

  if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
  saveDownloadTasks();
  processDownloadQueue();
  return { success: true };
});

ipcMain.handle('retry-tasks', async (event, taskIds) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return { success: false, error: '没有要重试的任务' };
  let count = 0;
  for (const taskId of taskIds) {
    const task = downloadTasks.find((t) => t.id === taskId);
    if (
      task &&
      (task.status === 'failed' ||
        task.status === 'stopped' ||
        (task.status === 'completed' && !hasCompleteTaskFile(task)))
    ) {
      repairTaskDestination(task);
      task.status = 'pending';
      task.progress = 0;
      task.receivedBytes = 0;
      task.totalBytes = 0;
      task.cancelled = false;
      delete task.error;
      delete task.cancelSource;
      delete task.writer;
      if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
      count++;
    }
  }
  if (count > 0) {
    saveDownloadTasks();
    processDownloadQueue();
  }
  return { success: true, count };
});

// ===== IPC：一键启动 / 一键暂停 =====
ipcMain.handle('pause-all', async (_event, taskIds) => {
  if (
    taskIds !== undefined &&
    (!Array.isArray(taskIds) || [...taskIds].some((id) => typeof id !== 'string' || !id.trim()))
  ) {
    return { success: false, error: '任务范围必须是有效的任务 ID 数组' };
  }
  return { success: true, count: pauseAllTasks(taskIds === undefined ? undefined : new Set(taskIds)) };
});

ipcMain.handle('resume-all', async (_event, taskIds) => {
  if (
    taskIds !== undefined &&
    (!Array.isArray(taskIds) || [...taskIds].some((id) => typeof id !== 'string' || !id.trim()))
  ) {
    return { success: false, error: '任务范围必须是有效的任务 ID 数组' };
  }
  return { success: true, count: resumeAllTasks(taskIds === undefined ? undefined : new Set(taskIds)) };
});

// 队列实时状态（供界面显示「进行中 x/并发上限」）
ipcMain.handle('get-queue-status', async () => ({
  active: activeDownloads,
  queued: downloadQueue.length,
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
}));

ipcMain.handle('open-folder', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  if (task.customDir && fs.existsSync(task.customDir)) {
    await shell.openPath(task.customDir);
    return { success: true };
  }
  if (task.savePath && fs.existsSync(task.savePath)) {
    const isDir = fs.statSync(task.savePath).isDirectory();
    if (isDir) {
      await shell.openPath(task.savePath);
    } else {
      shell.showItemInFolder(task.savePath);
    }
    return { success: true };
  }
  if (task.savePath) {
    const parentDir = path.dirname(task.savePath);
    if (fs.existsSync(parentDir)) {
      await shell.openPath(parentDir);
      return { success: true };
    }
  }
  return { success: false, error: '文件夹不存在' };
});

// ===== 应用信息 =====
ipcMain.handle('get-app-info', async () => ({
  version: APP_VERSION,
  brand: APP_TITLE,
  appName: APP_TITLE,
  platform: process.platform,
}));

// 打开外部链接（保留给需要时调用）
ipcMain.handle('open-external-url', async (event, url) => {
  if (!url) return { success: false, error: '缺少链接' };
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    console.error('[Shell] 打开链接失败:', err.message);
    return { success: false, error: err.message };
  }
});

// ===== 窗口创建 =====
function createWindow() {
  rendererClosing = false;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 620,
    title: APP_TITLE,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 20, y: 18 },
        }
      : {}),
    autoHideMenuBar: true,
    backgroundColor: '#f5f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const createdWindow = mainWindow;

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.once('did-finish-load', () => {
    if (storageError) sendToRenderer('storage-error', storageError);
  });

  // 开发模式加载 vite dev server，生产模式加载打包产物
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  }

  // 渲染进程崩溃（内存不足等）时重新加载页面；后台下载/处理任务不受影响。
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Window] 渲染进程退出:', details?.reason);
    if (details?.reason === 'clean-exit' || createdWindow.isDestroyed()) return;
    try {
      createdWindow.webContents.reload();
    } catch (_) {}
  });

  createdWindow.on('close', () => {
    if (mainWindow === createdWindow) rendererClosing = true;
  });

  createdWindow.on('closed', () => {
    // Detach the destroyed window before cancelling jobs.  Their finally
    // handlers may emit a last progress event while the renderer is gone.
    if (mainWindow === createdWindow) mainWindow = null;
    clearOnlineCache();
    for (const job of compatPreparing.values()) {
      job.cancelled = true;
      job.controller.abort();
    }
    cancelAllQuchongBatches();
    cancelAllEpisodeWorkflows();
    reconstructionPipeline?.cancelAll().catch((error) => console.warn('[Structure]', error.message));
    transcriptionManager?.cancelAll().catch((error) => console.warn('[Subtitles] 停止任务失败:', error.message));
  });
}

// ===== 应用生命周期 =====
app.whenReady().then(async () => {
  // 主进程里的未捕获错误只记录，不弹出 Electron 的致命错误对话框，也不让正在运行的下载/处理任务陪葬。
  process.on('unhandledRejection', (reason) => console.error('[Main] 未处理的 Promise 拒绝:', reason?.stack || reason));
  process.on('uncaughtException', (error) => console.error('[Main] 未捕获异常:', error?.stack || error));
  const dataFile = path.join(app.getPath('userData'), 'data.json');
  store.init(dataFile);
  // 任何一项历史数据加载失败都不能让应用没有窗口；失败项按空数据启动并留下日志。
  for (const [label, load] of [
    ['下载任务', loadDownloadTasks],
    ['去重任务', loadQuchongTasks],
    ['短剧档案', loadSeriesRegistry],
  ]) {
    try {
      load();
    } catch (e) {
      console.error(`[Startup] 读取${label}失败:`, e.message);
    }
  }
  try {
    rebuildSeriesRegistryFromTasks();
  } catch (_) {
    /* storage-error reports the failed write when the window opens. */
  }
  try {
    loadMergeTasks();
  } catch (e) {
    console.error('[Startup] 读取合并任务失败:', e.message);
  }
  registerStreamProtocol();
  registerLocalProtocol();
  const settings = getCurrentSettings();

  // 代理必须在创建窗口、发起任何请求之前生效
  try {
    await applyProxySettings(settings);
  } catch (e) {
    console.error('[Proxy] 启动时应用代理失败，使用直连:', e.message);
  }

  // 启动后自动接着跑「等待中」的任务（上次未下完的队列），无需手动点启动
  const resumed = enqueuePendingTasks();
  if (resumed > 0) {
    console.log(`[Queue] 启动自动续跑 ${resumed} 个等待中任务，并发 ${MAX_CONCURRENT_DOWNLOADS}`);
    pumpQueue();
  }

  app.on('activate', () => {
    // 搜索窗口可能仍在后台，不能用所有窗口数量判断主窗口是否存在。
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: APP_TITLE,
          submenu: [
            { role: 'about', label: `关于${APP_TITLE}` },
            { type: 'separator' },
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: '隐藏' },
            { role: 'hideOthers', label: '隐藏其他应用' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
          ],
        },
        {
          label: '编辑',
          submenu: [
            { role: 'undo', label: '撤销' },
            { role: 'redo', label: '重做' },
            { type: 'separator' },
            { role: 'cut', label: '剪切' },
            { role: 'copy', label: '复制' },
            { role: 'paste', label: '粘贴' },
            { role: 'selectAll', label: '全选' },
          ],
        },
        {
          label: '视图',
          submenu: [
            { role: 'resetZoom', label: '实际大小' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: '全屏' },
          ],
        },
        {
          label: '窗口',
          submenu: [
            { role: 'minimize', label: '最小化' },
            { role: 'close', label: '关闭窗口' },
            { type: 'separator' },
            { label: '回到主窗口', accelerator: 'CmdOrCtrl+1', click: () => app.emit('activate') },
          ],
        },
      ]),
    );
  }
  try {
    await rememberWindowsEncoder();
  } catch (e) {
    console.warn('[Encoder] 检测失败:', e.message);
  }
  createWindow();
});

function gpuAdapterNames(info) {
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  const names = [];
  for (const device of devices) {
    const vendor = Number(device?.vendorId);
    if (vendor === 0x10de) names.push('NVIDIA');
    else if (vendor === 0x1002) names.push('AMD');
    else if (vendor === 0x8086) names.push('Intel');
  }
  return names;
}

// Chromium 启动时已经枚举过显卡。打开窗口前读一次并缓存，去重不再另起 PowerShell。
async function rememberWindowsEncoder() {
  if (process.platform !== 'win32' || typeof app.getGPUInfo !== 'function') {
    if (process.platform === 'win32') quchong.setWindowsAdapters('');
    return;
  }
  let settled = false;
  const pending = app
    .getGPUInfo('basic')
    .then((info) => {
      settled = true;
      quchong.setWindowsAdapters(gpuAdapterNames(info));
    })
    .catch((error) => {
      settled = true;
      quchong.setWindowsAdapters('');
      console.warn('[Quchong] 读取显卡信息失败，使用 CPU 编码:', error?.message || error);
    });
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (!settled) console.warn('[Quchong] 显卡信息尚未返回，编码开始前会再使用缓存结果');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let waitingForSubtitles = false;
app.on('before-quit', (event) => {
  try {
    store.flushPending();
    activityLogStore?.flush();
  } catch (_) {}
  if (!transcriptionManager?.hasActive() && !reconstructionPipeline?.hasActive()) return;
  event.preventDefault();
  if (waitingForSubtitles) return;
  waitingForSubtitles = true;
  Promise.allSettled([transcriptionManager?.cancelAll(), reconstructionPipeline?.cancelAll()]).finally(() => {
    waitingForSubtitles = false;
    app.quit();
  });
});
