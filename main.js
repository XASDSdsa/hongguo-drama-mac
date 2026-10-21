/**
 * main.js - AI短剧助手 主进程
 *
 * 功能：
 *   1. 红果短剧解析（分享链接 / series_id -> 全剧集列表）
 *   2. 批量提交下载任务到下载队列
 *   3. 并发下载：流式下载播放直链 -> spade_a 派生 AES Key -> CENC-AES-CTR 解密 -> 输出 mp4
 *   4. 下载管理：进度推送、暂停/取消、重试、删除、打开所在文件夹
 *   5. 设置：下载目录、命名规则、并发数（JSON 文件持久化）
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  protocol,
  Menu,
  powerSaveBlocker,
  powerMonitor,
  net,
} = require('electron');
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
const arkVideo = require('./src/native/video-prompt/ark');
const { draftCapacity } = require('./src/native/draft-capacity');
const jianyingRelink = require('./src/native/jianying-relink');
const jianyingLocator = require('./src/native/jianying-location');
const { deriveEpisodePrompts } = require('./src/native/video-prompt/derive');
const { createLamaWorker, MODEL_FILE: LAMA_MODEL_FILE } = require('./src/native/video-prompt/lama');
const structureRuntime = require('./src/native/video-structure/runtime');
const storyboardSnapshot = require('./src/native/video-prompt/snapshot');
const { seedanceFormat } = require('./src/native/video-prompt/compose');
const store = require('./src/store');
const APP_VERSION = app.getVersion() || '1.0.0';

const APP_TITLE = 'AI短剧助手';

let mainWindow = null;
// 用户在「还有任务在跑」的提示里确认过退出，之后关窗口不再拦。
let quitConfirmed = false;
// 软件改名（红果短剧 → AI短剧助手）后数据目录跟着名字变了：新目录里还没有数据时，把旧目录里的设置、
// 下载记录、日志等逐项挪过来，用户不用重新填设置。挪不动（旧版还开着）的 JSON 文件改为复制。
// 启动计时：打包机上用 AI_DRAMA_STARTUP_PROBE=<文件> 启动时，记下几个时间点写进这个文件后退出，
// 用来检查装好的软件打开要多久（平时不开）。时间都从进程启动算起，单位毫秒。
const startupProbe = process.env.AI_DRAMA_STARTUP_PROBE || '';
const startupMarks = {};
function markStartup(name) {
  if (!startupProbe || startupMarks[name] != null) return;
  startupMarks[name] = Math.round(process.uptime() * 1000);
  if (name !== 'pageLoaded') return;
  try {
    fs.writeFileSync(startupProbe, JSON.stringify({ ...startupMarks, platform: process.platform }));
  } catch (_) {}
  setTimeout(() => {
    quitConfirmed = true;
    app.quit();
  }, 500);
}
markStartup('mainScript');

function migrateRenamedUserData() {
  try {
    if (typeof app.getPath !== 'function') return;
    const target = app.getPath('userData');
    if (fs.existsSync(path.join(target, 'data.json'))) return;
    const appData = app.getPath('appData');
    for (const oldName of ['红果短剧', 'hongguo-downloader']) {
      const old = path.join(appData, oldName);
      if (path.resolve(old) === path.resolve(target) || !fs.existsSync(path.join(old, 'data.json'))) continue;
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(old)) {
        const from = path.join(old, name);
        const to = path.join(target, name);
        if (fs.existsSync(to)) continue;
        try {
          fs.renameSync(from, to);
        } catch (_) {
          try {
            if (name.endsWith('.json') && fs.statSync(from).isFile()) fs.copyFileSync(from, to);
          } catch (_) {}
        }
      }
      try {
        fs.rmdirSync(old); // 只在已经挪空时删掉旧目录
      } catch (_) {}
      return;
    }
  } catch (error) {
    console.warn('[App] 迁移旧数据目录失败:', error?.message || error);
  }
}
migrateRenamedUserData();

// 只允许开一个：两个进程同时读写 data.json、同时往同一个「去重」文件夹写成品会互相覆盖。
// 再次打开时把已有窗口拉到前面。
const singleInstance = typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true;
if (!singleInstance) app.quit();
else
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady?.()) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
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
// 保存路径索引（见 savePathVids）。
let savePathIndex = null;
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
    // 文件命名模板：可用变量 剧名(series_title) 集数(vid_index，写成「第1集」，不补 0) 标题(ep_title)
    // 默认和去重成品一样：「剧名 - 第1集」
    name_format: '剧名 - 集数',
    max_concurrent: 3,
    // 视频去重同时运行的 FFmpeg 数量（1~8），下载管理和视频处理共用。
    quchong_jobs: quchong.DEFAULTS.jobs,
    // 去重编码：auto = 有显卡就用显卡（Mac 用 VideoToolbox，Windows 按显卡选 NVENC/AMF/QSV）；
    // cpu = 只用 CPU（显卡驱动太旧、显卡编码出错时的退路）。
    quchong_encoder: 'auto',
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
    // 文案改写（剧名、简介、海报画面描述）可以单独用 DeepSeek 等 OpenAI 兼容文本模型；Key 留空就和上面的文本模型共用。
    ai_copy_base_url: 'https://api.deepseek.com',
    ai_copy_api_key: '',
    ai_copy_model: 'deepseek-flash',
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
    // 视频反推提示词（火山方舟视频理解）：模型名没有默认值，要用户自己填。
    ark_base_url: arkVideo.DEFAULT_BASE_URL,
    ark_api_key: '',
    ark_video_model: '',
    video_prompt_max_seconds: 15,
    // 分镜工程图每集只分析前几个分镜（0 = 全部），后面的分镜占位、不问方舟。
    video_prompt_shot_limit: 2,
    // 本地视频结构化拆解。
    // 0 = 自动（按本机核心数选择）。
    structure_threads: 0,
    // 剪映草稿生成成功后，清掉这一集在软件数据目录里的分析中间文件（成品和草稿不受影响）。
    structure_cleanup: true,
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
  // 以前的两个预设（「剧名 001」那种）没改过的，换成现在的「剧名 - 第1集」写法
  if (LEGACY_NAME_FORMATS[merged.name_format]) merged.name_format = LEGACY_NAME_FORMATS[merged.name_format];
  return {
    ...merged,
    max_concurrent: MAX_CONCURRENT_DOWNLOADS,
    quchong_jobs: Number.isInteger(jobs) && jobs >= 1 && jobs <= 8 ? jobs : quchong.DEFAULTS.jobs,
    quchong_encoder: merged.quchong_encoder === 'cpu' ? 'cpu' : 'auto',
  };
}

/** 去重实际用的编码器：以「设置」为准，不用界面里缓存的旧值。 */
/** 设置页「检测显卡编码」：把这台电脑能用的显卡编码器都试一遍，告诉用户哪个能用、不能用的原因。 */
let encoderCheckRunning = null;
ipcMain.handle('encoder-check', async () => {
  try {
    const ffmpegPath = resolveFfmpeg('ffmpeg');
    if (!ffmpegPath) return { success: false, error: '没有找到软件自带的 FFmpeg' };
    // 连点只跑一次。
    encoderCheckRunning ||= quchong.checkEncoders(ffmpegPath).finally(() => {
      encoderCheckRunning = null;
    });
    const result = await encoderCheckRunning;
    return { success: true, ...result, setting: getCurrentSettings().quchong_encoder === 'cpu' ? 'cpu' : 'auto' };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

function dedupEncoder() {
  return getCurrentSettings().quchong_encoder === 'cpu' ? 'cpu' : quchong.DEFAULTS.encoder;
}

// 净化文件夹/文件名称（移除非法字符、结尾的点和空格）
function sanitizeFolderName(name) {
  // 先截长度再去掉结尾的点和空格：截断处正好是空格时，Windows 建文件夹会悄悄去掉它，
  // 记录里的名字就和磁盘上对不上。CON、NUL、COM1 这类是 Windows 保留名，前面加「_」。
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, '')
    .trim();
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

const LEGACY_NAME_FORMATS = { '剧名 集数': '剧名 - 集数', '剧名 集数 标题': '剧名 - 集数 标题' };

/** 集号写法：「第1集」，不补 0（不写成 001）。 */
function episodeLabel(vidIndex) {
  const n = Number(vidIndex);
  return `第${Number.isSafeInteger(n) && n > 0 ? n : String(vidIndex || '').trim()}集`;
}

// 按命名模板渲染文件名，返回 名称(不含扩展名) 或 null
function renderName(format, seriesTitle, vidIndex, epTitle) {
  // 模板里自己写了「第集数集」的，不再套一层「第…集」
  const fmt = String(format || '')
    .trim()
    .replace(/第\s*(集数|vid_index)\s*集/g, '$1');
  if (!fmt) return null;
  const vars = {
    series_title: String(seriesTitle || '').trim(),
    vid_index: episodeLabel(vidIndex),
    ep_title: String(epTitle || '').trim(),
  };
  const keys = { 剧名: 'series_title', 集数: 'vid_index', 标题: 'ep_title', series_title: 'series_title', vid_index: 'vid_index', ep_title: 'ep_title' };
  // 一遍替换完：「剧名_集数」这种用下划线连着写的也认得（以前会原样变成 series_title_vid_index）
  let name = fmt.replace(/series_title|vid_index|ep_title|剧名|集数|标题/g, (w) => vars[keys[w]] || '');
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
  // 先把「下载到这个路径」的任务挑出来（只扫一遍下载记录），再逐集对照；
  // 以前每一集都把全部下载记录扫一遍，记录多了以后每做完一集主进程会卡住一两秒。
  const owners = new Set();
  for (const item of downloadTasks) {
    const index = Number(item.hongguoInfo?.vid_index);
    if (item.savePath && Number.isFinite(index) && quchongPathKey(item.savePath) === key)
      owners.add(`${String(item.hongguoInfo.series_id)}|${index}`);
  }
  for (const entry of seriesRegistry) {
    const pipeline = pipelineForEntry(entry);
    for (const [idx, record] of Object.entries(pipeline.episodes)) {
      const paths = [record.downloadPath, record.dedupPath, record.finalPath, record.outputPath].filter(Boolean);
      if (paths.some((candidate) => quchongPathKey(candidate) === key)) {
        matches.push({ entry, index: Number(idx), record });
      }
    }
    if (!owners.size) continue;
    for (const episode of entry.episodes || []) {
      const owned = owners.has(`${String(entry.series_id)}|${Number(episode.vid_index)}`);
      if (owned && !matches.some((item) => item.entry === entry && item.index === Number(episode.vid_index))) {
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
        const location = jianyingLocation();
        const stamp = new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, '')
          .slice(0, 14);
        const name = `${sanitizeFolderName(path.parse(ctx.input).name)}-剪映草稿-${stamp}-${randomUUID().slice(0, 4)}`;
        return createJianyingDraft(ctx, {
          executable: resolveJianyingRuntime()?.executable,
          createScript: resolveJianyingScript(simple ? 'create-jianying-simple-draft.py' : 'create-jianying-draft.py'),
          checkScript: resolveJianyingScript('check-jianying-draft.py'),
          outputRoot: location.draftRoot || plan.fallbackRoot || path.join(ctx.projectDir, '剪映草稿'),
          name,
          // Windows 不往 User Data 登记：剪映打开时自己扫草稿文件夹（capcut-mate、CapCutAPI 也都是只放文件夹、不登记）；
          // Mac 上草稿位置就是 User Data 里那个时才登记。
          userData: location.userData,
          register: !!location.userData && process.platform !== 'win32',
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
    const manifestPath = path.join(record.draftPath, 'draft-manifest.json');
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return (
      manifest.boundary_policy === 'every_visual_shot_cut' &&
      manifest.alignment_algorithm === 'visual-shots-dialogue-index-v2'
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
        : '剪映草稿缺失或不是按最新分镜逻辑生成的，请重新生成';
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
  const executableName = process.platform === 'win32' ? 'jianying-runtime.exe' : 'jianying-runtime';
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

/**
 * 剪映草稿放哪（见 jianying-location）：设置里填了就用设置的；没填就自动找剪映真正的草稿位置
 * （Windows 新版剪映常见 D:\JianyingPro Drafts，草稿直接放在下面；Mac 和老版本是 User Data\Projects\com.lveditor.draft）。
 * 找一次要看各个盘，结果留 5 分钟。
 */
let jianyingLocationCache = null;
function jianyingLocation() {
  const configured = String(getCurrentSettings().jianying_user_data_path || '').trim();
  if (jianyingLocationCache && jianyingLocationCache.configured === configured && Date.now() - jianyingLocationCache.at < 300_000)
    return jianyingLocationCache.value;
  const value = jianyingLocator.resolveJianyingLocation({ configured, home: app.getPath('home') });
  jianyingLocationCache = { configured, at: Date.now(), value };
  return value;
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
// 下载失败时程序自己换新链接重试：每次失败后等多久再试（毫秒），空数组 = 不自动重试。
// 平台的下载链接会过期、个别节点临时没有这集，手动重试几次常常就能下，这里让程序自己做。
let downloadRetryDelays = [2000, 5000, 12000];

async function executeHongguoDownload(task, attempt = 0) {
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
    const finalPath = task.savePath || path.join(downloadDir, seriesInfo.ORIGINAL_DIR, filename);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    if (task.savePath !== finalPath) savePathIndex = null;
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
    // 下载要清晰：红果优先取 App 的 1080p（官网直链只有 360p）。
    const playInfo =
      checkedPlayInfo || (await hongguo.fetchPlayUrlSingle(vid, hongguoInfo?.series_id, { best: true }));
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
    const stopWatch = watchStall(response.data);
    try {
      await pipeline(response.data, writer);
    } finally {
      stopWatch();
    }
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
      // 成品已经就位：删临时文件失败（Windows 上被杀毒软件短暂占用）不能把整集判成失败。
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
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
      // 成品已经就位：删临时文件失败（Windows 上被杀毒软件短暂占用）不能把整集判成失败。
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
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
    } else if (
      attempt < downloadRetryDelays.length &&
      downloadErrors.isAutoRetryable({
        message: error.message,
        code: error.code,
        status: error.response?.status || 0,
      })
    ) {
      // 旧的下载地址作废，等一会儿重新取新的再下；等的时候用户点了停止就算停止。
      try {
        hongguo.invalidatePlayUrl?.(vid, hongguoInfo?.series_id);
      } catch (_) {}
      task.status = 'downloading';
      task.progress = 0;
      task.receivedBytes = 0;
      sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0 });
      await new Promise((resolve) => setTimeout(resolve, downloadRetryDelays[attempt]));
      if (source.token.reason || task.cancelled) {
        task.status = 'stopped';
        task.error = '';
        task.endTime = Date.now();
        sendToRenderer('download-stopped', { id });
      } else {
        return executeHongguoDownload(task, attempt + 1);
      }
    } else {
      task.status = 'failed';
      task.error = attempt ? `${error.message}（已自动换新链接重试 ${attempt} 次）` : error.message;
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
    title: `搜索 - ${APP_TITLE}`,
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
  { slug: 'hot-rank', label: '热度榜' },
  { slug: 'real-drama', label: '真人剧' },
  { slug: 'comic-drama', label: '漫剧' },
  { slug: 'ai-drama', label: 'AI剧' },
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
// 开新批次时清理旧临时文件：只清 10 分钟没动过的。
const QUCHONG_TEMP_MIN_AGE = 10 * 60 * 1000;
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
    // 失败原因里可能带几千字的 FFmpeg 输出：快照里只留开头（完整内容在这一集的日志里），数据文件不会越存越大。
    error: String(task.error || '').slice(0, 1200),
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
  // 界面没有订阅整份历史快照（有单独的进度/状态事件），不再每次都把 50 个批次整体发过去。
  saveQuchongHistory();
}

function loadQuchongTasks() {
  try {
    const saved = store.getQuchongTasks() || [];
    let changed = false;
    // 上次被中断的任务所在的文件夹：启动时（还没有任何任务在跑）把它们留下的临时文件清掉。
    const interruptedDirs = new Set();
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
            if (task.dst) interruptedDirs.add(path.dirname(String(task.dst)));
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
    for (const dir of interruptedDirs) quchong.sweepStaleTemps(dir, 0).catch(() => {});
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

const sideStartChains = new WeakMap();
/**
 * 去重成品一出来，就把「剪映草稿 / 分镜工程图」里需要的这一集立刻排进去，不等整批做完。
 * 同一批里的几集几乎同时完成时，排队的动作按顺序一个个做，避免同时新建两个草稿任务。
 */
function startSideTaskForOutput(batch, task) {
  const draftTask = batch.sideTasks?.jianyingDraft;
  if (!draftTask?.enabled || !batch.libraryDir || batch.cancelled || !task.dst || task.sideStarted) return;
  if (!selectDraftFiles([task.dst], draftTask.scope).files.length) return;
  task.sideStarted = true;
  const dir = batch.libraryDir;
  const chain = (sideStartChains.get(batch) || Promise.resolve())
    .then(() =>
      startLibraryDrafts({
        dir,
        files: [task.dst],
        mode: draftTask.mode,
        scope: draftTask.scope,
        prompts: draftTask.prompts,
        partial: true,
      }),
    )
    .then((started) => {
      if (!started.success)
        libLog(dir, 'error', `剪映草稿：${path.basename(task.dst)} 没有自动生成：${started.error}`, 'side');
    })
    .catch((error) => libLog(dir, 'error', `剪映草稿：没有自动生成：${error?.message || error}`, 'side'));
  sideStartChains.set(batch, chain);
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
  // 勾选了「生成剪映草稿」：需要的那几集在各自去重完成时就已经开始做了（startSideTaskForOutput）；
  // 这里只补没赶上的（比如停了又续跑），并把没有成品的集号说清楚。
  const draftTask = batch.sideTasks?.jianyingDraft;
  if (draftTask?.enabled && batch.libraryDir && !batch.cancelled) {
    const outputs = batch.tasks.filter((task) => task.status === 'completed' && task.dst).map((task) => task.dst);
    const picked = selectDraftFiles(outputs, draftTask.scope);
    if (!outputs.length) {
      libLog(batch.libraryDir, 'warn', '剪映草稿：这一批没有成功的去重成品，没有生成草稿', 'side');
    } else if (!picked.files.length) {
      libLog(
        batch.libraryDir,
        'error',
        `剪映草稿：去重成品里没有第 ${picked.missing.join('、')} 集，没法生成剪映草稿`,
        'side',
      );
    } else {
      if (picked.missing.length)
        libLog(batch.libraryDir, 'warn', `剪映草稿：成品里没有第 ${picked.missing.join('、')} 集，已跳过`, 'side');
      const rest = batch.tasks
        .filter((task) => task.status === 'completed' && task.dst && !task.sideStarted)
        .map((task) => task.dst);
      for (const task of batch.tasks) if (rest.includes(task.dst)) startSideTaskForOutput(batch, task);
    }
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

/** 全应用同时跑的去重 FFmpeg 上限：设置里的并发数（最多 8）。 */
function quchongGlobalCap() {
  return Math.min(QUCHONG_MAX_ACTIVE, getCurrentSettings().quchong_jobs);
}

function stopQueuedQuchongTasks(batch, reason) {
  while (batch.queue.length) {
    const task = batch.queue.shift();
    task.status = 'stopped';
    task.stage = 'stopped';
    task.error = reason;
    task.endTime = Date.now();
    task.updatedAt = task.endTime;
    emitQuchongTask(batch, task);
  }
}

function pumpQuchongBatch(batch) {
  if (batch.finished) return;
  while (!batch.cancelled && batch.active < batch.concurrency && batch.queue.length) {
    // 全应用同时跑的去重 FFmpeg 数不超过设置里的并发数（几部剧一起处理也一样），避免 CPU、内存被打满。
    if (quchongActive >= quchongGlobalCap()) break;
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
          // 排队等显卡、重试、降级、换编码器这几类提示也写进这部剧的处理日志：
          // 进度停在 0% 时，用户能看到它在等什么，而不是以为卡死了。
          const notice = String(line).match(/^\[(排队|重试|降级|编码器)\]\s*(.+)$/);
          if (notice?.[1] === '编码器') {
            // 换编码器是整批的事：同一批只说一次（带上原因），不在每一集后面重复。
            if (!batch.encoderNoted) {
              batch.encoderNoted = true;
              libLog(batch.libraryDir, 'warn', notice[2].slice(0, 400));
            }
          } else if (notice)
            logQuchongTask(batch, task, notice[1] === '排队' ? 'info' : 'warn', notice[2].slice(0, 300));
        },
      })
      .then((result) => {
        task.status = 'completed';
        task.stage = 'completed';
        task.progress = 100;
        task.path = result.path;
        const took = Math.max(1, Math.round((Date.now() - (task.startedAt || Date.now())) / 1000));
        // 耗时拆开写：合并变速多久、去重编码多久、成品多长，编码速度是成品时长的多少倍——慢在哪一眼能看出来。
        const detail = [
          result.mergeSeconds != null ? `合并变速 ${Math.round(result.mergeSeconds)} 秒` : '',
          result.encodeSeconds != null ? `去重编码 ${Math.round(result.encodeSeconds)} 秒` : '',
          result.outputSeconds ? `成品 ${Math.round(result.outputSeconds)} 秒` : '',
        ]
          .filter(Boolean)
          .join('，');
        logQuchongTask(
          batch,
          task,
          'ok',
          `完成，用时 ${took} 秒${detail ? `（${detail}）` : ''} → 去重/${path.basename(task.dst)}`,
        );
        if (!task.segments) markPipelineDeduped(task.src, task.dst);
        startSideTaskForOutput(batch, task);
      })
      .catch((error) => {
        task.status = batch.cancelled || controller.signal.aborted ? 'stopped' : 'failed';
        task.stage = task.status;
        task.progress = 0;
        task.error = error?.message || String(error);
        task.logBuffer = task.logBuffer || [];
        task.logBuffer.push(`[${task.status === 'failed' ? '失败' : '停止'}] ${task.error}`);
        if (task.status === 'failed')
          logQuchongTask(batch, task, 'error', `失败：${String(task.error).split('\n')[0]}`);
        else logQuchongTask(batch, task, 'warn', '已停止');
        // 磁盘写满：后面每一集都会同样失败，剩下的直接停下，不再白白占着电脑。
        if (
          task.status === 'failed' &&
          // 只认确认过的「磁盘空间不足」和系统写文件时的 ENOSPC；FFmpeg 原始输出里的同名字样可能是误报（见 quchong.reallyOutOfSpace）。
          /磁盘空间不足|ENOSPC:/.test(task.error) &&
          batch.queue.length
        ) {
          const left = batch.queue.length;
          stopQueuedQuchongTasks(batch, '磁盘空间不足，已停止');
          libLog(batch.libraryDir, 'error', `磁盘写满了：剩下的 ${left} 集已停止。请清理磁盘后再处理`);
        }
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
  if (batch.cancelled) stopQueuedQuchongTasks(batch, '已取消');
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
  // 编码器在应用启动时已经从 Chromium 的显卡信息里选定，这里只读缓存；设置里选了「只用 CPU」就是 cpu。
  encoder: quchong.resolveEncoder(dedupEncoder()),
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
  // 上次崩溃、断电或强制退出留下的半成品临时文件（.ai-drama-quchong-*），开新批次时顺手清掉。
  // 别的批次还在往同一个文件夹写时不清：它的中间文件可能很久没改过，但还要用。
  // 只清 10 分钟前的：这一批自己马上要写的临时文件是新的，不会被误删。
  const busyDirs = new Set(
    [...quchongBatches.values()]
      .filter((other) => other !== batch && !other.finished)
      .flatMap((other) => other.tasks.filter((task) => task.dst).map((task) => quchongPathKey(path.dirname(task.dst)))),
  );
  for (const dir of new Set(batch.tasks.map((task) => path.dirname(task.dst)).filter(Boolean))) {
    if (busyDirs.has(quchongPathKey(dir))) continue;
    quchong
      .sweepStaleTemps(dir, QUCHONG_TEMP_MIN_AGE)
      .then((removed) => removed && libLog(libraryDir, 'info', `清理了上次中断留下的 ${removed} 个临时文件`))
      .catch(() => {});
  }
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
    status: quchongActive >= quchongGlobalCap() ? 'queued' : 'running',
    tasks: batch.tasks.map(quchongTaskPayload),
  };
}

/**
 * 重新拆分：把选中的集接成连续时间线，按成品时长范围切成新的集，每一集交给去重队列处理。
 * 规划阶段会先分析切点（镜头切换、说话停顿），分析结果缓存在应用私有目录。
 */
// 正在分析切点的剧 -> AbortController（「停止」按钮、关窗口时用来中断分析）。
const libraryPlanControllers = new Map();

function cancelLibraryPlanning(dir) {
  const controller = libraryPlanControllers.get(path.resolve(String(dir || '')));
  if (!controller) return false;
  controller.abort();
  return true;
}

async function startResplitBatch(args) {
  const dir = args.dir;
  const controller = new AbortController();
  libraryPlanControllers.set(path.resolve(dir), controller);
  libraryPlanning.set(dir, { done: 0, total: args.files.length });
  libLog(dir, 'info', `开始规划重新拆分：${args.files.length} 集，先分析切点`);
  try {
    const result = await planAndQueueResplit({ ...args, signal: controller.signal });
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
    if (controller.signal.aborted) {
      libLog(dir, 'warn', '切点分析已停止，没有开始处理，「去重」里的成品没有动');
      return { success: false, error: '已停止' };
    }
    libLog(dir, 'error', `没有开始处理：${error?.message || error}`);
    throw error;
  } finally {
    libraryPlanControllers.delete(path.resolve(dir));
    libraryPlanning.delete(dir);
    sendToRenderer('library-activity', { dir });
  }
}

/**
 * 开始前先看输出盘够不够：成品通常是原片的 1~2 倍大（原片多是 HEVC，成品是 H.264），
 * 再留 1 GB 给处理中的临时文件。磁盘半路写满会让后面每一集都失败，不如一开始就说清楚。
 */
async function dedupSpaceProblem(outputDir, inputs) {
  let total = 0;
  for (const file of inputs) {
    try {
      total += (await fsp.stat(file)).size;
    } catch (_) {}
  }
  // 每路处理中还有一个高画质中间文件（1080p 一集几百 MB），按同时处理的集数再多留一些。
  const need = total * 2 + 1024 ** 3 + getCurrentSettings().quchong_jobs * 600 * 1024 ** 2;
  let free;
  try {
    let probe = path.resolve(outputDir);
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const stats = await fsp.statfs(probe);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch (_) {
    return '';
  }
  if (!Number.isFinite(free) || free >= need) return '';
  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
  return `输出位置所在的磁盘只剩 ${gb(free)} GB，这次处理大约需要 ${gb(need)} GB。请先清理磁盘，或在设置里换一个空间更大的输出位置`;
}

// ===== 每部剧最近一次去重的记录（管理剧集「去重后」那一块显示用）=====
// 记下原剧第几集到第几集、多少集参与去重、生成了第几集到第几集、当时的参数。存在软件数据目录，不放进剧文件夹。
let dedupRecordCache = null;
function dedupRecordFile() {
  return path.join(app.getPath('userData'), 'library-dedup-records.json');
}
function dedupRecords() {
  if (dedupRecordCache) return dedupRecordCache;
  try {
    dedupRecordCache = JSON.parse(fs.readFileSync(dedupRecordFile(), 'utf8')) || {};
  } catch (_) {
    dedupRecordCache = {};
  }
  return dedupRecordCache;
}
function libraryDedupRecord(dir) {
  return dedupRecords()[libraryActivity.dirKey(dir)] || null;
}
function saveLibraryDedupRecord(dir, record) {
  const all = dedupRecords();
  all[libraryActivity.dirKey(dir)] = record;
  // 只留最近 200 部剧的记录。
  const keys = Object.keys(all).sort((a, b) => (all[b]?.at || 0) - (all[a]?.at || 0));
  for (const key of keys.slice(200)) delete all[key];
  try {
    const file = dedupRecordFile();
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(all));
    fs.renameSync(temp, file);
  } catch (error) {
    console.warn('[Dedup] 去重记录保存失败:', error?.message || error);
  }
}

async function planAndQueueResplit({
  dir,
  files,
  split,
  opts,
  outputDir,
  sideTasks = null,
  title = '',
  signal = null,
}) {
  // 并发数和编码方式以「设置」为准：界面里缓存的旧参数不能把它们改回去。
  const options = quchong.validateOptions({
    ...opts,
    jobs: getCurrentSettings().quchong_jobs,
    encoder: dedupEncoder(),
  });
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
    if (signal?.aborted) throw new Error('已停止');
    const media = await quchong.probeMedia(ffprobePath, item.file, signal);
    if (!media.has_video) return { success: false, error: `这个文件没有视频轨：${path.basename(item.file)}` };
    durations.set(item.file, media.video_duration > 0 ? media.video_duration : media.duration);
  }
  const analyzeStart = Date.now();
  const analysis = await resplit.analyzeSources({
    ffmpegPath,
    files: ordered.map((item) => item.file),
    cacheDir: path.join(app.getPath('userData'), 'resplit-cache'),
    onProgress: progress,
    signal,
  });

  libLog(
    dir,
    'info',
    `切点分析完成：${ordered.length} 集，用时 ${Math.max(1, Math.round((Date.now() - analyzeStart) / 1000))} 秒（找停顿和镜头切换，结果有缓存，同一批再排不用重做）${
      Object.keys(analysis.methods || {}).length
        ? `；镜头切换用${Object.entries(analysis.methods)
            .map(([name, count]) => `${resplit.SCENE_METHOD_TEXT[name] || name} ${count} 集`)
            .join('、')}`
        : ''
    }`,
  );
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
  });
  if (!plan.pieces.length) return { success: false, error: plan.warnings.join('；') || '没有可处理的内容' };
  libLog(
    dir,
    'info',
    `排好 ${plan.pieces.length} 集新片，同时处理 ${options.jobs} 集，编码器 ${options.encoder}；每集先合并变速，再统一加去重特效`,
  );

  const lowSpace = await dedupSpaceProblem(
    outputDir,
    ordered.map((item) => item.file),
  );
  if (lowSpace) return { success: false, error: lowSpace };
  // 用户在分析期间点了「停止」：到这里为止什么都没动，旧成品也还在。
  if (signal?.aborted) throw new Error('已停止');
  // 从这里开始要挪旧成品、登记新批次，分析阶段的「停止」不再生效（之后在处理进度里停止这一批）。
  libraryPlanControllers.delete(path.resolve(dir));

  // 新的一版开始前，旧成品挪进废纸篓：成品文件夹里只留最新一版。
  const retired = await retireLibraryOutputs(dir);
  if (retired) libLog(dir, 'info', `「去重」里的旧成品 ${retired} 个已挪进废纸篓，这一版重新生成`);
  await fsp.mkdir(outputDir, { recursive: true });
  // 等补下载的批次可能在下载期间被改了剧名：以现在选定的剧名为准，请求里带来的只是兜底。
  const seriesName =
    sanitizeFolderName(libraryReleaseTitle(dir)) ||
    sanitizeFolderName(title) ||
    sanitizeFolderName(path.basename(dir)) ||
    '短剧';
  // 平台提审要求的命名：「剧目名 - 第N集」（如「我的中国梦 - 第1集」）。
  const names = plan.pieces.map((piece) => libraryOutputStem(seriesName, piece.number));
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
        speed: segment.speed,
      })),
      label: path.basename(destinations[index], '.mp4'),
      dst: destinations[index],
    })),
  });
  const finals = plan.pieces.map((piece) => piece.finalDuration);
  if (result?.success !== false) {
    const indexes = ordered.map((item) => item.index).filter((index) => index !== null);
    const { jobs: _jobs, encoder: _encoder, ...keptOpts } = options;
    saveLibraryDedupRecord(dir, {
      at: Date.now(),
      title: seriesName,
      sourceFrom: indexes.length ? Math.min(...indexes) : null,
      sourceTo: indexes.length ? Math.max(...indexes) : null,
      sourceCount: ordered.length,
      resultFrom: plan.pieces[0].number,
      resultTo: plan.pieces[plan.pieces.length - 1].number,
      resultCount: plan.pieces.length,
      minSeconds: Math.min(...finals),
      maxSeconds: Math.max(...finals),
      opts: keptOpts,
      split: splitOptions,
    });
  }
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
    const opts = quchong.validateOptions({
      ...payload.opts,
      jobs: getCurrentSettings().quchong_jobs,
      encoder: dedupEncoder(),
    });
    const bgm = payload.bgm ? path.resolve(String(payload.bgm)) : null;
    if (bgm) {
      const stat = await fsp.stat(bgm).catch(() => null);
      if (!stat?.isFile()) return { success: false, error: `找不到 BGM 文件：${bgm}` };
    }
    const ffmpegPath = resolveFfmpeg('ffmpeg');
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到 FFmpeg/ffprobe，请先配置内置 FFmpeg' };

    const lowSpace = await dedupSpaceProblem(outputDir, sources);
    if (lowSpace) return { success: false, error: lowSpace };

    // 查重和登记之间不能再有 await：连点两下时两个请求都会通过查重，同一集被处理两遍。
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

// 总任务每隔两秒、每来一个处理/下载事件就读一次：扫描整个下载目录（每个视频都要读一次大小和时间）
// 在剧多的电脑上要几百毫秒到几秒，会拖慢主进程。总任务只用到「有哪些剧文件夹、对应哪部剧」，
// 这份名单很少变，30 秒内复用上一次的扫描；「管理剧集」列表每次打开仍然重新扫描并刷新这份名单。
let folderRecordsCache = null;
function libraryFolderRecordsCached() {
  if (folderRecordsCache && Date.now() - folderRecordsCache.at < 30_000) return folderRecordsCache.records;
  return libraryFolderRecords();
}

function libraryFolderRecords() {
  migrateAllSeriesOriginals();
  const records = scanLibraryFolderRecords();
  folderRecordsCache = { at: Date.now(), records };
  return records;
}

function scanLibraryFolderRecords() {
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
        folders: libraryFolderRecordsCached(),
        batches: getQuchongSnapshots(),
        downloads: downloadTasks,
        jobs: [...libraryJobs.values()],
        planning: libraryPlanning,
        drafts: [...libraryDraftJobs.values()].map((job) => ({ dir: job.dir, ...libraryDraftSnapshot(job) })),
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
  if (!isImported) migrateSeriesOriginals(folder);
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
    // 「去重」里已有多少集成品：再次去重会把它们全部换掉，界面要据此提醒。
    outputCount: libraryDedupOutputs(folder).length,
    // 「去重」里的成品，按集号排好：管理剧集「去重处理后」和原剧一样按集显示。
    outputs: libraryDedupOutputs(folder).map((file) => {
      const name = path.basename(file);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch (_) {}
      return { name, path: file, size, index: seriesLibrary.parseEpisodeIndex(name) };
    }),
    // 最近一次去重：原剧第几集到第几集、生成了多少集、当时的参数。
    lastDedup: libraryDedupRecord(folder),
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
    if (dir) relinkMovedDrafts([String(dir)]);
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
    folderRecordsCache = null;
    return { success: true, dir: libraryFolders().add(result.filePaths[0]) };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

// 只是不再显示这个文件夹，不会删除或改动里面的任何文件。
ipcMain.handle('library-remove-import', (_event, dir) => {
  try {
    // 这部剧还有任务在跑时先不移除：移除后列表里看不到它，正在跑的任务就没法查看和停止了。
    const busy =
      libraryBusyReason(String(dir || '')) ||
      (libraryDraftJobs.get(path.resolve(String(dir || '')))?.status === 'running' ? '剪映草稿正在生成' : '');
    if (busy) return { success: false, error: `${busy}，做完或停止后再移除` };
    libraryFolders().remove(dir);
    folderRecordsCache = null;
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

/**
 * 设置页「测试方舟视频理解」：用表单里当前填的地址、Key、模型（不用先保存），在这台电脑上现做一段 3 秒的测试视频，
 * 走和分镜工程图完全一样的流程（上传 → 等方舟处理 → 带视频提问），报告每一步用了多久和模型的回答。
 */
ipcMain.handle('ark-test', async (_event, draft = {}) => {
  const settings = { ...getCurrentSettings(), ...draft };
  const apiKey = String(settings.ark_api_key || '').trim();
  const model = String(settings.ark_video_model || '').trim();
  if (!apiKey) return { success: false, error: '请先填方舟 API Key' };
  if (!model) return { success: false, error: '请先填视频理解模型名' };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-drama-ark-test-'));
  const clip = path.join(dir, 'ark-test.mp4');
  try {
    await new Promise((resolve, reject) => {
      require('child_process').execFile(
        resolveFfmpeg('ffmpeg'),
        [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=480x270:rate=12:duration=3',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=3',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          '-movflags',
          '+faststart',
          clip,
        ],
        { windowsHide: true, timeout: 60000 },
        (error, _stdout, stderr) =>
          error ? reject(new Error(`做测试视频失败：${String(stderr || error.message).slice(-200)}`)) : resolve(),
      );
    });
    const client = arkVideo.createArkClient({
      baseUrl: String(settings.ark_base_url || '').trim() || arkVideo.DEFAULT_BASE_URL,
      apiKey,
      model,
    });
    let timings = {};
    const started = Date.now();
    const answer = await client.askAboutVideo(clip, '这是一段测试视频。用一句话说说画面里有什么。', {
      fps: 2,
      onTimings: (t) => (timings = t),
    });
    return {
      success: true,
      model,
      elapsed: Date.now() - started,
      timings,
      summary: arkVideo.describePhases(timings),
      answer: String(answer).replace(/\s+/g, ' ').slice(0, 120),
    };
  } catch (error) {
    return {
      success: false,
      error: arkVideo.redact(error?.message || String(error), apiKey),
      timings: error?.timings || null,
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
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
      // 原始的剧名和简介（改写之前的样子），页面里和「已保存」的分开显示
      original: { title: context.title, synopsis: context.synopsis },
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
            copyConfig: copyWritingConfig(settings),
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
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        const stepText = { scene: '构思画面', art: '画海报底图', poster: '排标题' }[job.stage];
        job.error = controller.signal.aborted
          ? ''
          : `${task === 'poster' && stepText ? `（在「${stepText}」这一步）` : ''}${aiRedact(error)}`;
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
    libLog(context.dir, 'ok', '发布素材：剧名/样式已保存，海报有的话已重新排版', 'side');
    renameLibraryOutputs(context.dir);
    return { success: true, result: publishResultView(context) };
  } catch (error) {
    return { success: false, error: aiRedact(error) };
  }
});

/** 保存简介：写进简介文件（AI 新写的、手改的都走这里）。 */
ipcMain.handle('publish-save-synopsis', (_event, payload = {}) => {
  try {
    const context = publishContext(payload.dir);
    if (publishJobs.get(context.dir)?.status === 'running') return { success: false, error: '这部剧正在生成中' };
    publishMaterials.saveSynopsis({
      outputDir: context.dir,
      workDir: context.workDir,
      synopsis: payload.synopsis,
    });
    libLog(context.dir, 'ok', '发布素材：简介已保存', 'side');
    return { success: true, result: publishResultView(context) };
  } catch (error) {
    return { success: false, error: aiRedact(error) };
  }
});

// ===== 成品命名：用 AI 发布素材里选定的新剧名 =====
// 平台提审要求：「剧目名 - 第N集」。以前的「剧名_第001集」也认得，改剧名时一起改成新写法。
const LIBRARY_OUTPUT_NAME = /^(.+?)(?: - |_)第0*(\d+)集(?:_\d+)?\.mp4$/i;
const libraryOutputStem = (title, number) => `${title} - 第${Number(number)}集`;

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
  const locked = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (const file of files) {
    try {
      if (typeof shell?.trashItem === 'function') await shell.trashItem(file);
      else throw new Error('no trash');
      moved += 1;
    } catch (_) {
      // U 盘、移动硬盘、网络盘没有回收站：放进同一个盘上的「去重-旧成品」文件夹（同盘改名，不占额外空间），
      // 不能挪到系统盘的应用目录——跨盘改名会直接失败。文件正被播放器打开时挪不动，记下来最后统一说明。
      try {
        const keep = path.join(dir, '去重-旧成品', stamp);
        fs.mkdirSync(keep, { recursive: true });
        fs.renameSync(file, path.join(keep, path.basename(file)));
        moved += 1;
      } catch (error) {
        locked.push(path.basename(file));
      }
    }
  }
  if (locked.length)
    throw new Error(
      `有 ${locked.length} 个旧成品正被别的程序打开（比如播放器），没法移走：${locked.slice(0, 5).join('、')}${
        locked.length > 5 ? ' 等' : ''
      }。请先关掉再开始`,
    );
  // 这些成品已经被新一版替换，它们的分析中间文件不会再被用到。
  await cleanupAndLog(dir, files, '旧成品已替换');
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
    .filter((row) => row.match && row.name !== `${libraryOutputStem(title, row.match[2])}.mp4`);
  if (!stale.length) return;
  if (busy) {
    libLog(dir, 'warn', `剧名已改成「${title}」，但${busy}，成品文件名先不改；做完后再改一次剧名即可同步`, 'side');
    return;
  }
  let renamed = 0;
  for (const row of stale) {
    const target = path.join(output, `${libraryOutputStem(title, row.match[2])}.mp4`);
    if (fs.existsSync(target)) continue;
    fs.renameSync(path.join(output, row.name), target);
    renamed += 1;
    // 改名后路径变了，旧路径对应的分析文件不会再被用到。
    cleanupAndLog(dir, [path.join(output, row.name)], '成品已改名').catch(() => {});
  }
  if (renamed) libLog(dir, 'ok', `成品已按「${title} - 第N集」改名：${renamed} 个文件`, 'side');
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
    jianyingDraft: {
      enabled: true,
      mode: normalizeDraftMode(draft.mode),
      scope: normalizeDraftScope(draft.scope),
      prompts: draft.prompts === true,
    },
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
  if (items.length) return `同时做 ${items.length} 集`;
  return job.waitingReason || '';
}

/** 分镜工程图自己的进度（和剪映草稿分开显示）。 */
function storyboardSnapshotOf(job) {
  const total = job.promptTotal || 0;
  if (!total) return null;
  const active = [...(job.promptActive?.values() || [])];
  const failed = (job.promptFailed || 0) + (job.promptSkipped?.length || 0);
  const running = active.length > 0 || (job.promptQueue?.length || 0) > 0;
  return {
    status: running ? 'running' : failed ? 'failed' : 'completed',
    total,
    done: job.promptDone || 0,
    failed,
    queued: job.promptQueue?.length || 0,
    current: active.map((item) => item.label).join('、'),
    message: active.length === 1 ? active[0].message : active.length ? `同时做 ${active.length} 集` : '',
    detail: active.length === 1 ? active[0].detail : '',
    progress: Math.floor(active.reduce((sum, item) => sum + (item.progress || 0), 0)),
    stageStartedAt: active.length === 1 ? active[0].stageStartedAt : null,
  };
}

function libraryDraftSnapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    mode: job.mode,
    prompts: job.prompts === true,
    modeText: DRAFT_MODE_TEXT[job.mode],
    status: job.status,
    total: job.total,
    done: job.done,
    failed: job.failed,
    current: draftCurrentText(job),
    progress: draftProgressPercent(job),
    message: draftMessage(job),
    // 剪映草稿这部分还在做（分镜工程图可能还在后台问方舟，单独看 storyboard）
    drafting: job.active.size > 0 || job.queue.length > 0,
    storyboard: storyboardSnapshotOf(job),
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

/** 草稿分析可用的线程总数和每集最少线程数（Mac 只算性能核，见 draft-capacity.js）。 */
function draftCapacityNow() {
  return draftCapacity({ configuredThreads: getCurrentSettings().structure_threads });
}
/** 每集分到几个线程：平分总线程，但不少于每集最少线程（总线程比这还少时就用总线程）。 */
function draftThreadsEach(lanes) {
  const { budget, minThreads } = draftCapacityNow();
  return Math.max(Math.min(minThreads, budget), Math.floor(budget / Math.max(1, lanes)));
}

/**
 * 系统是不是已经很忙。macOS 用负载；Windows 上 os.loadavg() 恒为 0，改看可用内存。
 * macOS 的 os.freemem() 不含可回收的缓存，数值常年很低，不能拿来判断。
 */
function systemBusy() {
  const cores = os.availableParallelism?.() || os.cpus().length || 1;
  if (process.platform === 'win32') return os.freemem() < DRAFT_LANE_MEMORY + 1024 ** 3;
  return os.loadavg()[0] > cores * 0.85;
}

/** 现在这台电脑适合同时做几集：看线程预算、内存，有去重在跑或系统已经很忙就退回一集一集做。 */
function draftLanesAllowed() {
  const { budget, minThreads } = draftCapacityNow();
  const byThreads = Math.floor(budget / minThreads);
  const byMemory = Math.floor((os.totalmem() * 0.5) / DRAFT_LANE_MEMORY);
  let lanes = Math.min(DRAFT_MAX_LANES, byThreads, byMemory);
  const dedupRunning = [...quchongBatches.values()].some((batch) => !batch.finished);
  if (dedupRunning || systemBusy()) lanes = Math.min(lanes, 1);
  return Math.max(1, lanes);
}

/** 所有剧加起来正在做的草稿集数（不算 except 这一部）。 */
function draftEpisodesInProgress(except) {
  let count = 0;
  for (const job of libraryDraftJobs.values()) if (job !== except && job.status === 'running') count += job.active.size;
  return count;
}

/**
 * 每做一集草稿前先排队：几部剧加起来同时做的集数不超过电脑能承受的数量；
 * Windows 上可用内存不够一集的分析时也先等着（每 5 秒看一次），不和去重抢内存把电脑拖死。
 */
async function waitForDraftCapacity(job, state) {
  let told = false;
  while (!job.cancelled) {
    const othersBusy = draftEpisodesInProgress(job) + job.active.size >= draftLanesAllowed();
    // 只在还有别的重活（去重、别的草稿）时才因为内存紧张而等；什么都没在跑时直接做，免得内存小的电脑永远等下去。
    const heavyElsewhere =
      [...quchongBatches.values()].some((batch) => !batch.finished) ||
      draftEpisodesInProgress(job) > 0 ||
      job.active.size > 0;
    const lowMemory = process.platform === 'win32' && heavyElsewhere && os.freemem() < DRAFT_LANE_MEMORY;
    if (!othersBusy && !lowMemory) {
      if (told) {
        job.waitingReason = '';
        libraryDraftEmit(job);
      }
      return;
    }
    if (!told) {
      told = true;
      job.waitingReason = lowMemory ? '排队中：等电脑空出内存' : '排队中：等别的剧的草稿做完';
      if (state) state.message = job.waitingReason;
      libLog(job.dir, 'info', `剪映草稿：${job.waitingReason}`, 'side');
      libraryDraftEmit(job);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
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

/**
 * 剪映草稿挪过位置（整个剧文件夹换了盘、草稿文件夹拷进剪映草稿目录…）时，把草稿里的素材路径改到新位置，
 * 剪映打开不会「资源未找到」。看剪映的草稿目录和每部剧的「剪映草稿」文件夹；没挪过的草稿不改动。
 */
let draftRelinkRunning = null;
function relinkMovedDrafts(seriesDirs = null) {
  if (draftRelinkRunning) return draftRelinkRunning;
  draftRelinkRunning = (async () => {
    const roots = new Map(); // 草稿所在的文件夹 -> 属于哪部剧（写日志用）
    jianyingLocationCache = null; // 剪映的草稿位置可能刚改过
    const location = jianyingLocation();
    if (location.draftRoot) roots.set(location.draftRoot, null);
    // 剪映所有可能的草稿位置都看一遍（以前的版本可能把草稿放在了别的位置，用户又挪进了现在的位置）。
    for (const root of jianyingLocator.findJianyingDraftRoots({ home: app.getPath('home') })) roots.set(root, null);
    let dirs = seriesDirs;
    if (!dirs) {
      try {
        dirs = libraryFolderRecordsCached().map((folder) => folder.path);
      } catch (_) {
        dirs = [];
      }
    }
    for (const dir of dirs) roots.set(path.join(path.resolve(dir), '剪映草稿'), path.resolve(dir));
    for (const [root, seriesDir] of roots) {
      const fixed = await jianyingRelink.relinkDraftsIn(root);
      for (const item of fixed) {
        const parts = [];
        if (item.fixed) parts.push(`挪过位置，已把 ${item.fixed} 个素材的路径改到新位置`);
        if (item.windowsFile) parts.push('补上了 Windows 版剪映读的时间线文件（draft_content.json），重开剪映后分镜就在了');
        const text = `剪映草稿：${path.basename(item.dir)} ${parts.join('；')}${
          item.missing.length ? `（还有 ${item.missing.length} 个素材找不到）` : ''
        }`;
        console.log(`[Draft] ${text}`);
        if (seriesDir) libLog(seriesDir, item.missing.length ? 'warn' : 'ok', text, 'side');
      }
    }
  })()
    .catch((error) => console.warn('[Draft] 检查草稿素材路径失败:', error?.message || error))
    .finally(() => {
      draftRelinkRunning = null;
    });
  return draftRelinkRunning;
}

function libraryDraftProjectId(file) {
  const label = path.basename(file, path.extname(file));
  return `${label}-${createHash('sha256').update(file).digest('hex').slice(0, 8)}`;
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await fsp.stat(full).catch(() => null))?.size || 0;
  }
  return total;
}

/**
 * 清理这几集在软件数据目录里的分析中间文件（分镜片段、人声/背景声、识别结果…）。
 * 只删「确实是结构化拆解项目」的文件夹：里面的 project.json 必须是 video_structure 且项目 ID 对得上；
 * 成品（「去重」文件夹）和剪映草稿都不在这里，不会动。正在跑的项目不碰。
 */
async function cleanupStructureProjects(files) {
  let count = 0;
  let freed = 0;
  for (const file of files) {
    try {
      const projectId = libraryDraftProjectId(file);
      const record = store.getStructureProjects()[projectId];
      if (!record?.manifestPath) continue;
      if (getReconstructionPipeline().isActive(projectId)) continue;
      const dir = path.dirname(path.resolve(record.manifestPath));
      let manifest = null;
      try {
        manifest = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
      } catch (_) {
        manifest = null;
      }
      if (!manifest) {
        // 文件夹已经没了：只清掉记录。
        if (!fs.existsSync(dir)) store.removeStructureProject(projectId);
        continue;
      }
      if (manifest.kind !== 'video_structure' || manifest.project_id !== projectId) continue;
      const size = await directorySize(dir);
      await fsp.rm(dir, { recursive: true, force: true });
      store.removeStructureProject(projectId);
      count += 1;
      freed += size;
    } catch (_) {
      // 清理只是省空间，失败了不影响别的。
    }
  }
  return { count, freed };
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function cleanupAndLog(dir, files, reason) {
  const { count, freed } = await cleanupStructureProjects(files);
  if (count)
    libLog(dir, 'info', `剪映草稿：${reason}，已清理 ${count} 集的分析中间文件，释放 ${formatBytes(freed)}`, 'side');
}

/** 一句话讲清楚这一集是怎么切的：画面分成几个镜头，文案按气口断成几条。 */
function describeStructure(structure) {
  const m = structure?.modules || {};
  const speech = m.transcript?.summary || {};
  const cut = m.alignment?.summary || {};
  const parts = [];
  if (Number.isFinite(speech.acoustic_pauses)) {
    parts.push(`检测到 ${speech.acoustic_pauses} 处气口，按气口拆开 ${speech.pause_cuts ?? 0} 次`);
  }
  if (Number.isFinite(cut.raw_shot_count)) {
    parts.push(`画面切点 ${cut.raw_shot_count - 1} 个，全部作为分镜边界`);
  }
  if (Number.isFinite(cut.shot_count)) parts.push(`共 ${cut.shot_count ?? '?'} 个分镜`);
  return parts.length ? parts.join('；') : '分析完成';
}

/** 要反推视频提示词时，先确认方舟的 Key 和模型名填了，免得拆解跑了很久才发现。 */
function videoPromptProblem() {
  const settings = getCurrentSettings();
  if (!String(settings.ark_api_key || '').trim()) return '要反推视频提示词，请先在设置里填火山方舟的 API Key';
  if (!String(settings.ark_video_model || '').trim()) return '要反推视频提示词，请先在设置里填视频理解模型名';
  return '';
}

/**
 * 这一集拆解完成后，用同一份分镜和台词结果反推 Seedance 2.5 提示词，写成「视频提示词/集名.txt」。
 * 失败只记日志、不影响剪映草稿。
 */
// ===== 分镜结果留底：草稿做完就把这一集的分镜（alignment）和台词（transcript）存一份小文件 =====
// 分析中间文件（几百 MB 到几 GB）草稿做完会清掉；之后再要分镜工程图，直接用这份留底和已有的草稿，
// 不重新分析、不再多做一份草稿，分镜和草稿里的镜头一一对得上。存在软件数据目录，不放进剧文件夹。
const DRAFT_RESULT_MAX_FILES = 3000;
function draftResultDir() {
  return path.join(app.getPath('userData'), 'structure-results');
}
function draftResultFile(projectId) {
  return path.join(draftResultDir(), `${projectId}.json`);
}

async function structureResults(structure, file) {
  const readResult = async (id) =>
    JSON.parse(await fsp.readFile(path.join(structure.projectDir, structure.modules[id].result_path), 'utf8'));
  const [alignment, transcript] = await Promise.all([readResult('alignment'), readResult('transcript')]);
  let sourceKey = '';
  try {
    sourceKey = JSON.parse(await fsp.readFile(structure.manifestPath, 'utf8')).source_sha256 || '';
  } catch (_) {
    sourceKey = '';
  }
  if (!sourceKey) {
    const stat = await fsp.stat(file);
    sourceKey = `${stat.size}-${Math.round(stat.mtimeMs)}`;
  }
  return { alignment, transcript, sourceKey };
}

/** 草稿做好后留底；失败只记日志，不影响草稿本身。 */
async function saveDraftResult({ projectId, file, mode, draftPath, results }) {
  try {
    const stat = await fsp.stat(file);
    const body = JSON.stringify({
      version: 1,
      file: path.resolve(file),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      mode,
      draftPath,
      sourceKey: results.sourceKey,
      alignment: results.alignment,
      transcript: results.transcript,
      savedAt: Date.now(),
    });
    if (body.length > 20 * 1024 * 1024) return; // 异常大的结果不留底，之后按老办法重新分析
    await fsp.mkdir(draftResultDir(), { recursive: true });
    const target = draftResultFile(projectId);
    const temp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temp, body);
    await fsp.rename(temp, target);
    // 只留最近的一批，防止常年使用后越攒越多。
    const names = (await fsp.readdir(draftResultDir())).filter((name) => name.endsWith('.json'));
    if (names.length > DRAFT_RESULT_MAX_FILES) {
      const dated = await Promise.all(
        names.map(async (name) => {
          const full = path.join(draftResultDir(), name);
          return { full, mtime: (await fsp.stat(full).catch(() => null))?.mtimeMs || 0 };
        }),
      );
      dated.sort((a, b) => a.mtime - b.mtime);
      for (const { full } of dated.slice(0, names.length - DRAFT_RESULT_MAX_FILES)) await fsp.rm(full, { force: true });
    }
  } catch (error) {
    console.warn('[Draft] 分镜结果留底失败:', error?.message || error);
  }
}

/**
 * 这一集以前做过草稿、成品没变、草稿还在、分轨方式一样：返回留底（分镜、台词、草稿位置），否则 null。
 */
async function loadDraftResult(projectId, file, mode) {
  try {
    const saved = JSON.parse(await fsp.readFile(draftResultFile(projectId), 'utf8'));
    const stat = await fsp.stat(file);
    if (saved?.version !== 1 || saved.file !== path.resolve(file)) return null;
    if (saved.size !== stat.size || saved.mtimeMs !== Math.round(stat.mtimeMs)) return null; // 成品重新做过
    if (!saved.alignment?.shots?.length || !saved.transcript) return null;
    const manifest = JSON.parse(
      await fsp.readFile(path.join(String(saved.draftPath || ''), 'draft-manifest.json'), 'utf8'),
    );
    if (String(manifest?.schema || '').includes('simple') !== (mode === 'simple')) return null;
    return saved;
  } catch (_) {
    return null; // 没有留底、草稿被删了、文件读不了：按老办法重新分析
  }
}

// 分镜工程图截图：一次只截一张（每张开一个隐藏的离屏窗口，一两秒）。
let storyboardSnapshotChain = Promise.resolve();
function snapshotStoryboard(htmlFile) {
  const run = storyboardSnapshotChain.then(() =>
    storyboardSnapshot.captureStoryboard({ driver: storyboardSnapshot.electronSnapshotDriver(BrowserWindow), htmlFile }),
  );
  storyboardSnapshotChain = run.catch(() => {});
  return run;
}

// 分镜工程图关键帧去字幕用的 LaMa：整个软件共用一个（模型只在内存里放一份），空闲一分钟自动退出。
let lamaWorker = null;
let lamaWorkerKey = '';
function getLamaWorker() {
  const settings = getTranscriptionSettings();
  const rt = structureRuntime.runtime(settings);
  const threads = structureRuntime.params('shots', settings, rt).threads;
  const key = [rt.command, ...rt.prefix, threads].join('\u0000');
  if (!lamaWorker || lamaWorkerKey !== key) {
    lamaWorker?.close();
    lamaWorker = createLamaWorker({ command: rt.command, prefix: rt.prefix, model: path.join(rt.models, LAMA_MODEL_FILE), threads });
    lamaWorkerKey = key;
  }
  return lamaWorker;
}

async function deriveLibraryPrompts(job, file, item, { alignment, transcript, sourceKey }) {
  const key = path.resolve(job.dir);
  const label = path.basename(file, path.extname(file));
  const settings = getCurrentSettings();
  const model = String(settings.ark_video_model || '').trim();
  // 分镜工程图的日志单独一栏（和剪映草稿分开）
  const log = (level, text) =>
    libLog(
      key,
      level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'info',
      `${label}：${text}`,
      'storyboard',
    );
  item.message = '看视频、写提示词';
  item.detail = '';
  item.progress = 0;
  item.stageStartedAt = Date.now();
  libLog(key, 'info', `${label} 开始${item.fresh ? '（重新生成，不用上次的结果）' : ''}`, 'storyboard');
  libraryDraftEmit(job);
  const cacheFile = path.join(app.getPath('userData'), 'video-prompt-cache', `${item.projectId}.json`);
  if (item.fresh) await fsp.rm(cacheFile, { force: true }).catch(() => {});
  try {
    const result = await deriveEpisodePrompts({
      ffmpeg: resolveFfmpeg('ffmpeg'),
      inputPath: file,
      label,
      alignment,
      transcript,
      client: arkVideo.createArkClient({
        baseUrl: String(settings.ark_base_url || '').trim() || arkVideo.DEFAULT_BASE_URL,
        apiKey: String(settings.ark_api_key || '').trim(),
        model,
      }),
      model,
      outDir: path.join(job.dir, '视频提示词'),
      cacheFile,
      sourceKey,
      title: path.basename(path.resolve(job.dir)),
      maxSeconds: Number(settings.video_prompt_max_seconds) || 15,
      shotLimit: Number.isFinite(Number(settings.video_prompt_shot_limit)) ? Number(settings.video_prompt_shot_limit) : 2,
      lama: (() => {
        try {
          return getLamaWorker();
        } catch (error) {
          log('warn', `LaMa 补图准备不了：${error?.message || error}`);
          return null;
        }
      })(),
      log,
      onProgress: (percent, message) => {
        item.detail = String(message || '').slice(0, 80);
        if (Number.isFinite(Number(percent))) item.progress = Math.max(0, Math.min(100, Number(percent)));
        libraryDraftEmit(job);
      },
      signal: job.controller.signal,
    });
    if (result.failed) {
      log(
        'warn',
        `共 ${result.segments} 段，有 ${result.failed} 段没有生成，重新开始一次会只补这几段 → ${result.file}`,
      );
    } else log('ok', `已生成 → ${result.htmlFile || result.file}`);
    // 页头 + 前两个分镜截成一张图，管理剧集里按集显示
    if (result.htmlFile) {
      item.detail = '截图';
      libraryDraftEmit(job);
      try {
        await snapshotStoryboard(result.htmlFile);
        log('ok', '截图已生成（页头 + 前两个分镜）');
      } catch (error) {
        log('warn', `截图没出来（${error?.message || error}），可以在管理剧集里点这一集的「重新出图」`);
      }
    }
    job.promptDone = (job.promptDone || 0) + 1;
  } catch (error) {
    if (job.cancelled || job.controller.signal.aborted) throw Object.assign(new Error('已停止'), { stopped: true });
    job.promptFailed = (job.promptFailed || 0) + 1;
    const message = openai.redactError(error, settings.ark_api_key);
    log('error', `没有生成：${message}`);
    // 额度用完、Key 不对这类账号问题：这次任务里排着的其他集也不再去问方舟。
    if (error?.fatal) job.promptFatal ||= message;
  }
}

// ===== 分镜工程图（视频提示词）后台排队 =====
// 以前每集草稿做完还要原地等方舟看完视频才放下一集，一等就是好几分钟，后面的集一直排着。
// 现在交给这个队列：最多同时 2 集在问方舟（再多容易被限流），整个草稿任务等它们都做完才算结束；停止时一起停。
const PROMPT_PARALLEL = 2;

function queueLibraryPrompts(job, file, item, data) {
  job.promptQueue ||= [];
  job.promptActive ||= new Map();
  job.promptTasks ||= new Set();
  const entry = {
    label: item.label || path.basename(file, path.extname(file)),
    projectId: item.projectId,
    mode: item.mode,
    fresh: item.fresh === true,
    message: '排队',
    detail: '',
    progress: 0,
    stageStartedAt: Date.now(),
  };
  job.promptTotal = (job.promptTotal || 0) + 1;
  job.promptQueue.push({ file, entry, data });
  pumpLibraryPrompts(job);
}

function pumpLibraryPrompts(job) {
  // 出过账号问题：排着的集不再去问方舟，记下来，任务结束时一条日志说清楚。
  if (job.promptFatal && job.promptQueue?.length) {
    job.promptSkipped ||= [];
    job.promptSkipped.push(...job.promptQueue.splice(0).map((item) => item.entry.label));
  }
  while (!job.cancelled && job.promptQueue?.length && job.promptActive.size < PROMPT_PARALLEL) {
    const { file, entry, data } = job.promptQueue.shift();
    job.promptActive.set(entry.label, entry);
    const task = deriveLibraryPrompts(job, file, entry, data)
      .catch(() => {}) // 停止时会抛「已停止」；其余错误 deriveLibraryPrompts 自己写了日志
      .finally(() => {
        job.promptActive.delete(entry.label);
        job.promptTasks.delete(task);
        libraryDraftEmit(job);
        pumpLibraryPrompts(job);
      });
    job.promptTasks.add(task);
  }
  if (job.cancelled && job.promptQueue) job.promptQueue.length = 0;
}

/** 等这个草稿任务排进去的分镜工程图全部做完（包括做的过程中新排进来的）。 */
async function waitLibraryPrompts(job) {
  while (job.promptTasks?.size) await Promise.allSettled([...job.promptTasks]);
}

async function generateLibraryDraft(job, file, item) {
  const pipeline = getReconstructionPipeline();
  const label = path.basename(file, path.extname(file));
  const workRoot =
    String(getCurrentSettings().structure_output_dir || '').trim() ||
    path.join(app.getPath('userData'), 'structure-work');
  const projectId = libraryDraftProjectId(file);
  item.projectId = projectId;
  // 只差分镜工程图：这一集已经有草稿、成品没变，就直接用当时的分镜，不重新分析，也不再多做一份草稿。
  if (item.prompts) {
    const saved = await loadDraftResult(projectId, file, item.mode);
    if (saved) {
      libLog(
        path.resolve(job.dir),
        'info',
        `剪映草稿：${label} 已有草稿，沿用它的 ${saved.alignment.shots.length} 个分镜，只补做分镜工程图（不重新分析）`,
        'side',
      );
      queueLibraryPrompts(job, file, item, saved);
      return saved.draftPath;
    }
  }
  libraryDraftPlans.set(projectId, { mode: item.mode, fallbackRoot: path.join(job.dir, '剪映草稿') });
  try {
    await pipeline.start({ inputPath: file, projectId, outputRoot: workRoot, threads: job.threadsEach });
    let structure = await pipeline.wait(projectId);
    if (job.cancelled || structure?.status === 'stopped') throw Object.assign(new Error('已停止'), { stopped: true });
    const incomplete = DRAFT_MODULES.filter((id) => structure?.modules?.[id]?.status !== 'succeeded');
    if (incomplete.length) {
      throw new Error(structure?.error || `拆解没有完成：${incomplete.map((id) => DRAFT_STAGE_TEXT[id]).join('、')}`);
    }
    libLog(path.resolve(job.dir), 'info', `剪映草稿：${label} ${describeStructure(structure)}`, 'side');
    // 读分镜/台词结果失败不影响草稿：只是这一集做不了分镜工程图、也不留底。
    let results = null;
    try {
      results = await structureResults(structure, file);
    } catch (error) {
      if (item.prompts)
        libLog(
          path.resolve(job.dir),
          'error',
          `${label}：没有生成：读不到分镜结果（${error?.message || error}）`,
          'storyboard',
        );
    }
    // 分镜工程图在后台做（只等方舟、几乎不占电脑），这一路马上接着做下一集的草稿。
    if (item.prompts && results) queueLibraryPrompts(job, file, item, results);
    // 拆解结果是缓存复用的：以前生成的草稿和这次要的分轨方式不一样时，只重做最后一步。
    const manifestOf = (draftPath) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(draftPath, 'draft-manifest.json'), 'utf8'));
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
    const draftPath = structure.modules.jianying.summary.draft_path;
    if (results) await saveDraftResult({ projectId, file, mode: item.mode, draftPath, results });
    return draftPath;
  } finally {
    libraryDraftPlans.delete(projectId);
  }
}

/** 对这些去重成品逐集生成剪映草稿；后台运行，进度和日志写进这部剧的「支线任务日志」。 */
// 同一部剧的「开始做草稿」按顺序一个个处理：准备检查要花时间（会起一个检测进程），
// 两个请求同时进来时不能各建一个任务（后建的会把先建的盖掉，先建的就成了停不下来的孤儿任务）。
const draftStartLocks = new Map();
function startLibraryDrafts(args) {
  const key = path.resolve(String(args?.dir || ''));
  const run = (draftStartLocks.get(key) || Promise.resolve()).then(() => startLibraryDraftsNow(args));
  const tail = run.catch(() => {});
  draftStartLocks.set(key, tail);
  tail.then(() => {
    if (draftStartLocks.get(key) === tail) draftStartLocks.delete(key);
  });
  return run;
}

async function startLibraryDraftsNow({ dir, files: candidates, mode, scope, prompts = false, partial = false, fresh = false }) {
  const key = path.resolve(dir);
  if (!candidates.length)
    return { success: false, error: '还没有去重成品，没法生成剪映草稿。请先勾选「去重」再开始。' };
  const { files, missing, numbers } = selectDraftFiles(candidates, scope);
  if (!numbers.length) return { success: false, error: '请填要做草稿的成品集号' };
  if (!files.length) {
    return { success: false, error: `去重成品里没有第 ${missing.join('、')} 集，没法生成剪映草稿` };
  }
  if (missing.length && !partial)
    libLog(path.resolve(dir), 'warn', `剪映草稿：成品里没有第 ${missing.join('、')} 集，已跳过`, 'side');
  const kind = normalizeDraftMode(mode);
  const withPrompts = prompts === true;
  const problem = (await libraryDraftReadiness(kind)) || (withPrompts ? videoPromptProblem() : '');
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
    for (const file of added) running.queue.push({ file, mode: kind, prompts: withPrompts, fresh: fresh === true });
    running.total += added.length;
    libLog(key, 'info', `剪映草稿：正在生成，这 ${added.length} 集排到后面接着做`, 'side');
    libraryDraftEmit(running);
    return { success: true, queued: added.length, job: libraryDraftSnapshot(running) };
  }
  // 别的剧的草稿已经占着几路，这一部只拿剩下的，两部剧加起来不超过电脑能承受的并行数。
  const othersLanes = [...libraryDraftJobs.values()]
    .filter((item) => item.status === 'running' && item.dir !== key)
    .reduce((sum, item) => sum + (item.lanes || 1), 0);
  const lanes = Math.max(1, Math.min(draftLanesAllowed() - othersLanes, files.length));
  const job = {
    id: randomUUID(),
    dir: key,
    mode: kind,
    prompts: withPrompts,
    controller: new AbortController(),
    queue: files.map((file) => ({ file, mode: kind, prompts: withPrompts, fresh: fresh === true })),
    active: new Map(), // 正在做的集：projectId -> { file, label, mode, progress, message, detail, stageStartedAt, lastStage }
    status: 'running',
    total: files.length,
    done: 0,
    failed: 0,
    lanes,
    threadsEach: draftThreadsEach(lanes),
    startedAt: Date.now(),
    endTime: null,
    cancelled: false,
  };
  libraryDraftJobs.set(key, job);
  libLog(
    key,
    'info',
    `剪映草稿：开始，共 ${files.length} 集（${DRAFT_MODE_TEXT[kind]}${withPrompts ? '，同时反推视频提示词' : ''}）${lanes > 1 ? `，同时做 ${lanes} 集、每集 ${job.threadsEach} 线程` : ''}`,
    'side',
  );
  // 草稿放哪、为什么放那：每次开始都重新看一下剪映的设置（可能刚改过草稿位置）
  jianyingLocationCache = null;
  const where = jianyingLocation();
  const WHERE_TEXT = {
    jianying: '剪映「全局设置 → 草稿位置」',
    setting: '软件设置里填的位置',
    detected: '找到的剪映草稿文件夹',
    default: '剪映默认位置',
  };
  libLog(
    key,
    'info',
    where.draftRoot
      ? `剪映草稿：放到 ${where.draftRoot}（${WHERE_TEXT[where.source] || where.source}）`
      : '剪映草稿：没找到剪映的草稿位置，放到剧文件夹的「剪映草稿」里',
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
      await waitForDraftCapacity(job);
      if (job.cancelled || !job.queue.length) return;
      const item = job.queue.shift();
      const label = path.basename(item.file, path.extname(item.file));
      const state = {
        file: item.file,
        label,
        mode: item.mode,
        prompts: item.prompts === true,
        fresh: item.fresh === true,
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
        if (getCurrentSettings().structure_cleanup !== false)
          await cleanupAndLog(key, [item.file], `${label} 草稿已生成`);
      } catch (error) {
        if (job.cancelled) return;
        // 这一集被单独中断（不是整个任务被停）：记成失败，接着做后面的集，不让整条车道悄悄退出。
        job.failed += 1;
        libLog(
          key,
          'error',
          error?.stopped ? `剪映草稿：${label} 被中断` : `剪映草稿：${label} 失败：${error?.message || error}`,
          'side',
        );
      } finally {
        job.active.delete(label);
      }
      libraryDraftEmit(job);
    }
  };
  (async () => {
    do {
      await Promise.all(Array.from({ length: job.lanes }, (_, index) => runLane(index)));
      await waitLibraryPrompts(job); // 草稿都做完了，分镜工程图还在问方舟：等它们做完
    } while (job.queue.length && !job.cancelled); // 车道都退出之后又有新的集排进来：接着做
    if (job.promptSkipped?.length) {
      libLog(
        key,
        'error',
        `剩下 ${job.promptSkipped.length} 集（${job.promptSkipped.join('、')}）没有做：${job.promptFatal}`,
        'storyboard',
      );
    }
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
    // 这部剧正在分析切点或去重时，「去重」里的成品随时会被换掉，先不单独做草稿。
    const busy = libraryBusyReason(dir);
    if (busy) return { success: false, error: busy };
    return await startLibraryDrafts({
      dir,
      files: libraryDedupOutputs(dir),
      mode: payload.mode,
      scope: payload.scope,
      prompts: payload.prompts === true,
    });
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('library-plan-cancel', (_event, dir) => {
  if (cancelLibraryPlanning(dir)) return { success: true };
  // 切点已经分析完、正在挪旧成品和登记新批次（几秒钟）：这时停不了规划，等批次出现后在处理进度里停。
  const planning = [...libraryPlanning.keys()].some((key) => quchongPathKey(key) === quchongPathKey(String(dir || '')));
  return {
    success: false,
    error: planning ? '切点已分析完，正在开始处理；稍等几秒，等这一批出现后再点「停止」' : '没有在分析切点',
  };
});

ipcMain.handle('library-draft-cancel', (_event, dir) => {
  try {
    const job = libraryDraftJobs.get(path.resolve(String(dir || '')));
    if (!job || job.status !== 'running') return { success: false, error: '没有在生成的剪映草稿' };
    job.cancelled = true;
    job.controller?.abort();
    for (const item of job.active.values()) if (item.projectId) getReconstructionPipeline().cancel(item.projectId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

// ===== AI 分镜工程图：剪映草稿任务里生成的「视频提示词/集名.html」，在管理剧集里按所选集号直接显示 =====
function storyboardTarget(dir, number) {
  const { files } = selectDraftFiles(libraryDedupOutputs(dir), { numbers: [number] });
  const file = files[0];
  if (!file) return null;
  const label = path.basename(file, path.extname(file));
  return { file, label, html: path.join(dir, '视频提示词', `${label}.html`) };
}

/**
 * 以前生成的分镜工程图把「生成分辨率」统一写成 720p；现在跟成品走（1080p 成品写 1080p）。
 * 打开时按成品实际尺寸改过来（只改分辨率那几处文字，不重新问方舟）。
 */
async function refreshStoryboardResolution(target) {
  try {
    const media = await quchong.probeMedia(resolveFfmpeg('ffprobe'), target.file).catch(() => null);
    if (!media?.video_width || !media?.video_height) return;
    const want = seedanceFormat({ width: media.video_width, height: media.video_height }).resolution;
    const html = await fsp.readFile(target.html, 'utf8').catch(() => null);
    if (html != null) {
      const fixed = html
        .replace(/(<span>分辨率<\/span><b>)(?:720p|1080p)(<\/b>)/g, `$1${want}$2`)
        .replace(/(<span class="pill">)(?:720p|1080p)( · )/g, `$1${want}$2`);
      if (fixed !== html) await fsp.writeFile(target.html, fixed);
    }
    const txtFile = target.html.replace(/\.html$/, '.txt');
    const txt = await fsp.readFile(txtFile, 'utf8').catch(() => null);
    if (txt != null) {
      const fixed = txt.replace(/(生成设置：分辨率 )(?:720p|1080p)/g, `$1${want}`);
      if (fixed !== txt) await fsp.writeFile(txtFile, fixed);
    }
  } catch (_) {
    // 改不了就按原样显示。
  }
}

function storyboardDir(payload) {
  const dir = path.resolve(String(payload?.dir || ''));
  return seriesLibrary.isLibraryFolder(dir, downloadRoot(), libraryFolders().list()) ? dir : '';
}

/** 所选集号里，每一集的分镜工程图生成到哪一步了。 */
ipcMain.handle('library-storyboards', async (_event, payload = {}) => {
  try {
    const dir = storyboardDir(payload);
    if (!dir) return { success: false, error: '这不是剧文件夹' };
    const items = [];
    for (const number of normalizeDraftScope({ numbers: payload.numbers }).numbers) {
      const target = storyboardTarget(dir, number);
      if (!target) {
        items.push({ number, state: 'no-episode' });
        continue;
      }
      const stat = await fsp.stat(target.html).catch(() => null);
      const shot = stat ? await fsp.stat(storyboardSnapshot.snapshotFile(target.html)).catch(() => null) : null;
      items.push({
        number,
        label: target.label,
        state: stat ? 'ready' : 'none',
        updatedAt: stat?.mtimeMs || 0,
        // 截图比页面旧（页面重新生成过）就当没有，界面会重新出图
        image: shot && shot.mtimeMs >= stat.mtimeMs - 1000 ? `${localAssetUrl(storyboardSnapshot.snapshotFile(target.html))}?v=${Math.round(shot.mtimeMs)}` : '',
      });
    }
    return { success: true, items };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 一集的分镜工程图页面（原样的 HTML），视频预览指向成品视频的本地播放地址，直接放进界面里显示。 */
ipcMain.handle('library-storyboard-html', async (_event, payload = {}) => {
  try {
    const dir = storyboardDir(payload);
    if (!dir) return { success: false, error: '这不是剧文件夹' };
    const target = storyboardTarget(dir, Number(payload.number));
    if (!target) return { success: false, error: '成品里没有这一集' };
    await refreshStoryboardResolution(target);
    const html = await fsp.readFile(target.html, 'utf8').catch(() => null);
    if (html == null) return { success: false, error: '这一集的分镜工程图还没有生成' };
    return {
      success: true,
      label: target.label,
      html: html.replace(/data-src="[^"]*"/g, () => `data-src="${localPlayUrl(target.file)}"`),
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('library-storyboard-open', async (_event, payload = {}) => {
  try {
    const dir = storyboardDir(payload);
    if (!dir) return { success: false, error: '这不是剧文件夹' };
    const target = storyboardTarget(dir, Number(payload.number));
    if (!target || !fs.existsSync(target.html)) return { success: false, error: '这一集的分镜工程图还没有生成' };
    await refreshStoryboardResolution(target);
    const error = await shell.openPath(target.html);
    return error ? { success: false, error } : { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

/** 按已有的分镜工程图页面重新截图（老的工程图没有截图、截图没出来时用）。 */
ipcMain.handle('library-storyboard-shot', async (_event, payload = {}) => {
  try {
    const dir = storyboardDir(payload);
    if (!dir) return { success: false, error: '这不是剧文件夹' };
    const target = storyboardTarget(dir, Number(payload.number));
    if (!target || !fs.existsSync(target.html)) return { success: false, error: '这一集的分镜工程图还没有生成' };
    await refreshStoryboardResolution(target);
    const file = await snapshotStoryboard(target.html);
    const stat = await fsp.stat(file);
    return { success: true, image: `${localAssetUrl(file)}?v=${Math.round(stat.mtimeMs)}` };
  } catch (error) {
    return { success: false, error: `截图没出来：${error?.message || error}` };
  }
});

/** 重新生成某一集的分镜工程图：不用上次问方舟的结果，重新看视频、写提示词、去字幕、截图。 */
ipcMain.handle('library-storyboard-regenerate', async (_event, payload = {}) => {
  try {
    const dir = storyboardDir(payload);
    if (!dir) return { success: false, error: '这不是剧文件夹' };
    const busy = libraryBusyReason(dir);
    if (busy) return { success: false, error: busy };
    const number = Number(payload.number);
    if (!storyboardTarget(dir, number)) return { success: false, error: '去重成品里没有这一集' };
    return await startLibraryDrafts({
      dir,
      files: libraryDedupOutputs(dir),
      mode: payload.mode,
      scope: { numbers: [number] },
      prompts: true,
      fresh: true,
    });
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

// 每集时长：按「路径 + 大小 + 修改时间」记下来，存在软件数据目录里，重启后不用再读一遍（文件改过会重新读）。
let episodeDurationCache = null;
let episodeDurationSaveTimer = null;
function episodeDurations() {
  if (episodeDurationCache) return episodeDurationCache;
  episodeDurationCache = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'episode-durations.json'), 'utf8'));
    for (const [key, value] of Object.entries(saved || {})) if (Number(value) > 0) episodeDurationCache.set(key, Number(value));
  } catch (_) {}
  return episodeDurationCache;
}
function saveEpisodeDurationsSoon() {
  clearTimeout(episodeDurationSaveTimer);
  episodeDurationSaveTimer = setTimeout(() => {
    try {
      const entries = [...episodeDurations().entries()].slice(-20000); // 只留最近的，防止越攒越多
      const file = path.join(app.getPath('userData'), 'episode-durations.json');
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(entries)));
      fs.renameSync(`${file}.tmp`, file);
    } catch (_) {}
  }, 1500);
  episodeDurationSaveTimer.unref?.();
}
async function cachedEpisodeDuration(ffprobePath, file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return 0;
  const key = `${file}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  const cache = episodeDurations();
  if (cache.has(key)) return cache.get(key);
  const media = await quchong.probeMedia(ffprobePath, file).catch(() => null);
  const duration = media?.has_video ? (media.video_duration > 0 ? media.video_duration : media.duration) : 0;
  if (duration > 0) {
    cache.delete(key);
    cache.set(key, duration);
    saveEpisodeDurationsSoon();
  }
  return duration;
}

/** 管理剧集里每一集（原剧、去重后的成品）的时长，单位秒；读不出来的不返回。 */
ipcMain.handle('library-durations', async (_event, payload = {}) => {
  try {
    const dir = path.resolve(String(payload.dir || ''));
    if (!seriesLibrary.isLibraryFolder(dir, downloadRoot(), libraryFolders().list()))
      return { success: false, error: '这不是剧文件夹' };
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffprobePath) return { success: false, error: '未找到 ffprobe' };
    const files = [...new Set((Array.isArray(payload.files) ? payload.files : []).map((file) => path.resolve(String(file))))]
      .filter((file) => {
        const relative = path.relative(dir, file);
        return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      })
      .slice(0, 2000);
    const durations = {};
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++];
        const seconds = await cachedEpisodeDuration(ffprobePath, file).catch(() => 0);
        if (seconds > 0) durations[file] = Math.round(seconds * 10) / 10;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    return { success: true, durations };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

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
    // 草稿正在读「去重」里的成品：这时重新去重会把这些成品挪走，要等草稿做完或先停止。
    if (payload.dedup !== false && libraryDraftJobs.get(dir)?.status === 'running') {
      return { success: false, error: '剪映草稿正在生成，等它做完，或先点「停止」' };
    }
    // 没勾选「去重」、只勾了剪映草稿：直接拿已有的去重成品生成草稿。
    if (payload.dedup === false) {
      const draft = normalizeSideTasks(payload.sideTasks)?.jianyingDraft;
      if (!draft) return { success: false, error: '请至少勾选一项要做的事' };
      const started = await startLibraryDrafts({
        dir,
        files: libraryDedupOutputs(dir),
        mode: draft.mode,
        scope: draft.scope,
        prompts: draft.prompts,
      });
      return started.success ? { ...started, draftOnly: true } : started;
    }
    const files = [
      ...new Set(Array.isArray(payload.files) ? payload.files.map((file) => path.resolve(String(file))) : []),
    ];
    if (!files.length) return { success: false, error: '请先选择要处理的集' };
    const originals = path.resolve(seriesInfo.originalDir(dir));
    if (files.some((file) => path.dirname(file) !== originals || !seriesLibrary.VIDEO_EXT.test(file))) {
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
      { timeout: 30000, windowsHide: true },
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
      { timeout: 30000, windowsHide: true },
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

/**
 * 下载目录里的剧：把散在剧文件夹外层的原集、原封面、原简介挪进「原剧」子文件夹，下载记录跟着改。
 * 用户导入的文件夹不动；这部剧正在处理、分析、补下载或做发布素材时先不挪，正在用的文件也跳过，下次再挪。
 */
function migrateSeriesOriginals(dir) {
  try {
    const folder = path.resolve(String(dir || ''));
    if (path.dirname(folder) !== downloadRoot() || path.basename(folder).startsWith('.')) return 0;
    if (
      libraryFolders()
        .list()
        .some((item) => path.resolve(item) === folder)
    )
      return 0;
    if (!fs.existsSync(folder) || libraryBusyReason(folder) || publishJobs.get(folder)?.status === 'running') return 0;
    const isFile = (name) => {
      try {
        return fs.statSync(path.join(folder, name)).isFile();
      } catch (_) {
        return false;
      }
    };
    const names = [
      ...seriesLibrary.scanVideos(folder).map((episode) => episode.name),
      ...seriesInfo.COVER_EXTENSIONS.map((ext) => seriesInfo.COVER_BASENAME + ext),
      seriesInfo.SYNOPSIS_FILENAME,
    ].filter(isFile);
    const target = path.join(folder, seriesInfo.ORIGINAL_DIR);
    const moved = new Map();
    if (names.length) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of names) {
        const from = path.join(folder, name);
        const to = path.join(target, name);
        if (fs.existsSync(to) || isFileInUse(from)) continue;
        try {
          fs.renameSync(from, to);
          moved.set(from, to);
        } catch (_) {}
      }
    }
    // 下载记录：挪走的指向新位置；还没下完的（文件不在外层）以后直接下进「原剧」。正在下的不动，下完再挪。
    let changed = false;
    for (const task of downloadTasks) {
      if (!task.savePath || path.dirname(path.resolve(task.savePath)) !== folder) continue;
      // 正在下的不动（下完再挪）；排队还没开始的可以直接改成下进「原剧」。
      if (task.status === 'downloading' || runningDownloads.has(task.id) || runningDownloadPaths.has(task.savePath))
        continue;
      const from = path.resolve(task.savePath);
      if (!moved.has(from) && fs.existsSync(from)) continue; // 这个文件没挪成，记录保持原样
      const next = moved.get(from) || path.join(target, path.basename(from));
      for (const suffix of ['.enc.tmp', '.enc.tmp.decoded']) {
        try {
          if (fs.existsSync(from + suffix)) {
            fs.mkdirSync(target, { recursive: true });
            fs.renameSync(from + suffix, next + suffix);
          }
        } catch (_) {}
      }
      task.savePath = next;
      changed = true;
    }
    if (changed) {
      savePathIndex = null;
      try {
        saveDownloadTasks();
      } catch (_) {}
    }
    if (moved.size) {
      folderRecordsCache = null;
      libLog(folder, 'info', `已把 ${moved.size} 个原剧文件（原集、封面、简介）挪进「原剧」文件夹`);
    }
    return moved.size;
  } catch (error) {
    console.warn('[Library] 整理原剧文件夹失败:', error?.message || error);
    return 0;
  }
}

/** 下载目录下每一部剧都整理一遍（打开「管理剧集」时）。 */
function migrateAllSeriesOriginals() {
  let entries = [];
  try {
    entries = fs.readdirSync(downloadRoot(), { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries)
    if (entry.isDirectory() && !entry.name.startsWith('.'))
      migrateSeriesOriginals(path.join(downloadRoot(), entry.name));
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
  // 原封面、原简介一律写进「原剧」；传进来的是剧文件夹时先把旧布局整理好，免得外层和里面各有一份。
  let target = path.resolve(String(dir));
  if (path.basename(target) !== seriesInfo.ORIGINAL_DIR) {
    migrateSeriesOriginals(target);
    target = path.join(target, seriesInfo.ORIGINAL_DIR);
  }
  return seriesInfo
    .saveSeriesInfo({
      dir: target,
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

// 保存路径 -> 登记在这个路径上的集（vid）。判断「同一路径被别的集占用」时查这张表，
// 不用每次把全部下载记录扫一遍：记录多了以后，打开剧集面板、列出整部剧会把主进程拖慢。
// 下载记录增删或超过 1 秒就重建；改了保存路径（repairTaskDestination）时立即作废。
function savePathVids(savePath) {
  const now = Date.now();
  if (
    !savePathIndex ||
    savePathIndex.tasks !== downloadTasks ||
    savePathIndex.size !== downloadTasks.length ||
    now - savePathIndex.at > 1000
  ) {
    const map = new Map();
    for (const item of downloadTasks) {
      if (!item?.savePath) continue;
      let vids = map.get(item.savePath);
      if (!vids) map.set(item.savePath, (vids = new Set()));
      vids.add(String(item.hongguoInfo?.vid));
    }
    savePathIndex = { map, tasks: downloadTasks, size: downloadTasks.length, at: now };
  }
  return savePathIndex.map.get(savePath);
}

function hasCompleteTaskFile(task) {
  if (!task?.savePath || task.pathConflict) return false;
  const own = String(task.hongguoInfo?.vid);
  const vids = savePathVids(task.savePath);
  if (vids && [...vids].some((vid) => vid !== own)) return false;
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
  task.savePath = path.join(task.customDir, seriesInfo.ORIGINAL_DIR, task.filename);
  task.pathConflict = false;
  savePathIndex = null;
}

function uniqueEpisodeFilename(settings, title, episode) {
  const format = settings.name_format || '';
  const rendered = renderName(format, title, episode.vid_index, episode.title) || title;
  return `${rendered}${/集数|vid_index/.test(format) ? '' : ` - ${episodeLabel(episode.vid_index)}`}.mp4`;
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

/**
 * 下载流超过 idleMs 没收到任何数据就当作网络中断：CDN 半路停止发送时，axios 的 timeout 只管到收到响应头为止，
 * 之后会一直卡在「下载中」占着名额。断开后按网络错误自动重试。
 */
function watchStall(stream, idleMs = 60_000) {
  let last = Date.now();
  const onData = () => {
    last = Date.now();
  };
  stream.on?.('data', onData);
  let timer = null;
  const check = () => {
    if (Date.now() - last > idleMs) {
      timer = null;
      stream.destroy?.(new Error(`网络中断：${Math.round(idleMs / 1000)} 秒没有收到数据`));
      return;
    }
    timer = setTimeout(check, 5000);
    timer?.unref?.();
  };
  check();
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    stream.off?.('data', onData);
  };
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
      const stopWatch = watchStall(response.data);
      try {
        await pipeline(response.data, fs.createWriteStream(input, { mode: 0o600 }), { signal });
      } finally {
        stopWatch();
      }
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
    const child = execFile(
      ffmpegPath,
      ['-hide_banner', '-encoders'],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (task?.child === child) delete task.child;
        resolve(String(stdout || ''));
      },
    );
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
          // NVENC 有最小尺寸限制（64×64 会被拒），用 256×256 才测得出显卡编码是否可用。
          'color=c=black:s=256x256:d=0.1',
          '-frames:v',
          '1',
          '-c:v',
          enc,
          '-f',
          'null',
          '-',
        ],
        { timeout: 25000, windowsHide: true },
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
  const cleanSeriesTitle = sanitizeFolderName(seriesTitle) || '未命名短剧';
  const downloadDir = seriesFolder(cleanSeriesTitle, seriesId);
  // 原集、原封面、原简介都放进「原剧」子文件夹；剧文件夹外层只放成品。
  const originalsDir = path.join(downloadDir, seriesInfo.ORIGINAL_DIR);
  migrateSeriesOriginals(downloadDir);
  try {
    fs.mkdirSync(originalsDir, { recursive: true });
  } catch (_) {}
  rememberSeriesFolder(seriesId, downloadDir);
  folderRecordsCache = null; // 新剧文件夹马上出现在「管理剧集」和总任务里，不等 30 秒的缓存过期
  // 封面和简介跟着下载一起存进「原剧」；不等它完成，也不让它影响下载。
  void writeSeriesInfoFiles(seriesId, originalsDir, cover || (episodes[0] && episodes[0].cover));

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
    const epLabel = episodeLabel(ep.vid_index);
    const filename = uniqueEpisodeFilename(settings, cleanSeriesTitle, ep);
    const finalPath = path.join(originalsDir, filename);

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
      title: `《${cleanSeriesTitle}》${epLabel}${ep.title ? ' ' + ep.title : ''}`,
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
        title: `《${cleanSeriesTitle}》${epLabel}`,
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
    if (episodes.length > 2000) return { success: false, error: '一次最多提交 2000 集，请分几次下载' };
    const count = await enqueueEpisodes({ seriesId, seriesTitle, episodes, cover });
    return { success: true, count, requested: episodes.length };
  } catch (error) {
    console.error('[Hongguo] 提交批量下载失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 播放器里「下载未完成集」：一次把这部剧要补的集都排进队列（一次保存），不再一集一集提交。
ipcMain.handle('download-series-episodes', async (_event, seriesId, indices) => {
  try {
    const entry = seriesRegistry.find((s) => String(s.series_id) === String(seriesId));
    if (!entry) return { success: false, error: '未找到该剧档案，请先解析一次' };
    const wanted = new Set((Array.isArray(indices) ? indices : []).map(Number).filter(Number.isSafeInteger));
    const episodes = (entry.episodes || [])
      .filter((ep) => wanted.has(Number(ep.vid_index)))
      .map((ep) => ({ ...ep, cover: entry.cover }));
    if (!episodes.length) return { success: false, error: '没有要下载的集' };
    const count = await enqueueEpisodes({
      seriesId: entry.series_id,
      seriesTitle: entry.series_title,
      episodes,
      cover: entry.cover,
    });
    return { success: true, count, requested: episodes.length };
  } catch (error) {
    console.error('[Player] 批量补下载失败:', error.message);
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
  // 文本、作图、文案改写可能是三把不同的 Key，错误信息里都要抹掉。
  return openai.redactError(
    openai.redactError(openai.redactError(error, settings.ai_api_key), settings.ai_image_api_key),
    settings.ai_copy_api_key,
  );
}

/**
 * 改写剧名、简介、构思海报画面用的文本模型：设置里填了「文案改写」的 Key（如 DeepSeek）就走它，
 * 否则 null（和通用文本模型共用）。检查海报底图要能看图，仍走通用文本模型。
 */
function copyWritingConfig(settings) {
  const apiKey = String(settings.ai_copy_api_key || '').trim();
  if (!apiKey) return null;
  return {
    ...settings,
    ai_base_url: String(settings.ai_copy_base_url || '').trim() || 'https://api.deepseek.com',
    ai_api_key: apiKey,
    ai_text_model: String(settings.ai_copy_model || '').trim() || 'deepseek-flash',
  };
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
    : episodeLabel(task.episodeIndex);
  const transcriptPath = task.transcriptPath || path.join(materialDir, `${prefix}-转写.txt`);
  let transcript;
  if (task.transcriptFingerprint === fingerprint && aiOutputIsUsable(transcriptPath)) {
    if ((await fsp.stat(transcriptPath)).size > 2 * 1024 * 1024) throw new Error('转写缓存过大，请重新生成');
    transcript = await fsp.readFile(transcriptPath, 'utf8');
    update({ stage: 'summarizing', progress: 55, transcriptPath });
  } else {
    const tempDir = path.join(app.getPath('temp'), 'ai-drama-material', randomUUID());
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
        // 重新拆分的一集由好几个原集的片段拼成：所有片段的原文件都算在用，不只是第一段。
        (batch.tasks.some(
          (task) =>
            ['pending', 'running'].includes(task.status) &&
            quchongTaskInputs(task).some((input) => quchongPathKey(input) === key),
        ) ||
          (batch.bgm && quchongPathKey(batch.bgm) === key)),
    )
  )
    return true;
  // 正在分析切点的剧：它文件夹里的原集马上要被拼接处理，先不能删。
  if (
    key &&
    [...libraryPlanControllers.keys(), ...libraryPlanning.keys()].some(
      (dir) => quchongPathKey(seriesInfo.seriesDirOf(file)) === quchongPathKey(dir),
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
  markStartup('windowCreated');
  mainWindow.webContents.once('did-finish-load', () => {
    if (storageError) sendToRenderer('storage-error', storageError);
    markStartup('pageLoaded');
  });

  // 开发模式加载 vite dev server，生产模式加载打包产物
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  }

  // 渲染进程崩溃（内存不足等）时重新加载页面；后台下载/处理任务不受影响。
  // 一分钟内反复崩溃就不再自动重载（避免死循环占满 CPU），改成提示页；后台任务照常在主进程里跑。
  const crashTimes = [];
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Window] 渲染进程退出:', details?.reason);
    if (details?.reason === 'clean-exit' || createdWindow.isDestroyed()) return;
    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length && now - crashTimes[0] > 60_000) crashTimes.shift();
    try {
      if (crashTimes.length <= 3) createdWindow.webContents.reload();
      else
        createdWindow.loadURL(
          'data:text/html;charset=utf-8,' +
            encodeURIComponent(
              '<meta charset="utf-8"><body style="font-family:-apple-system,\'Microsoft YaHei\',sans-serif;padding:40px;color:#333">' +
                '<h3>界面连续出错，已暂停自动刷新</h3><p>后台的下载和处理不受影响。请关闭窗口后重新打开应用；如果反复出现，请把这个情况告诉我们。</p></body>',
            ),
        );
    } catch (_) {}
  });

  // 还有任务在跑时先问一句：关窗口（Windows 上就是退出）会停掉正在下载、去重、做草稿的任务。
  createdWindow.on('close', (event) => {
    let busy = false;
    try {
      busy = appBusy();
    } catch (_) {}
    if (busy && !quitConfirmed && dialog?.showMessageBox) {
      event.preventDefault();
      askToQuit(createdWindow);
      return;
    }
    if (mainWindow === createdWindow) rendererClosing = true;
  });
  // Windows 关机、重启、注销时不再弹「还有任务」的确认框，否则系统会提示「此应用正在阻止关机」。
  const allowSystemQuit = () => {
    quitConfirmed = true;
  };
  createdWindow.on('query-session-end', allowSystemQuit);
  createdWindow.on('session-end', allowSystemQuit);

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
    // 关窗口时把后台的切点分析、剪映草稿、合并也一起停掉，不留在没有窗口的后台继续跑。
    for (const controller of libraryPlanControllers.values()) controller.abort();
    for (const job of libraryDraftJobs.values()) {
      if (job.status !== 'running') continue;
      job.cancelled = true;
      job.queue = [];
      job.controller?.abort();
    }
    for (const task of mergeTasks) {
      if (task.status !== 'running') continue;
      task.cancelled = true;
      try {
        require('./src/native/merge-runner').stopMergeChildren(task);
      } catch (_) {}
    }
    reconstructionPipeline?.cancelAll().catch((error) => console.warn('[Structure]', error.message));
    transcriptionManager?.cancelAll().catch((error) => console.warn('[Subtitles] 停止任务失败:', error.message));
  });
}

let quitDialogOpen = false;
/** 有任务在跑时退出前确认一次；确认后才真的退出（停止任务、保存状态由退出流程完成）。 */
function askToQuit(win) {
  if (quitDialogOpen) return;
  quitDialogOpen = true;
  const target = win && !win.isDestroyed() ? win : undefined;
  dialog
    .showMessageBox(target, {
      type: 'warning',
      buttons: ['继续处理', '停止并退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: APP_TITLE,
      message: '还有任务正在处理',
      detail:
        '退出会停止正在进行的下载、去重、剪映草稿等任务（已经做完的成品不受影响），下次需要重新开始这些任务。确定要停止并退出吗？',
    })
    .then(({ response }) => {
      if (response !== 1) return;
      quitConfirmed = true;
      app.quit();
    })
    .catch(() => {})
    .finally(() => {
      quitDialogOpen = false;
    });
}

// ===== 应用生命周期 =====
/**
 * 主进程的错误和警告同时写进 用户数据/logs/main.log：用户遇到问题时可以把日志发过来。
 * 启动时超过 5 MB 就换成 main.old.log；运行中最多再写 10 MB，不会把磁盘写满。
 */
function installFileLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, path.join(dir, 'main.old.log'));
    } catch (_) {}
    const stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {});
    let written = 0;
    const format = (value) => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }
    };
    for (const level of ['error', 'warn']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        if (written > 10 * 1024 * 1024) return;
        const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${args.map(format).join(' ')}\n`;
        written += Buffer.byteLength(line);
        stream.write(line);
      };
    }
    console.warn(`[App] 启动 ${APP_VERSION} ${process.platform}-${process.arch}`);
  } catch (_) {}
}

ipcMain.handle('open-log-folder', async () => {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const error = await shell.openPath(dir);
  return error ? { success: false, error } : { success: true };
});

app.whenReady().then(async () => {
  if (!singleInstance) return;
  markStartup('appReady');
  installFileLog();
  // AI 文案/海报请求走 Chromium 网络栈：跟随设置里的代理和系统代理，长时间作图不会被 Node 的 5 分钟限制断开。
  // Chromium 拒绝的少数端口（ERR_UNSAFE_PORT）退回 Node 自带的 fetch。
  if (typeof net?.fetch === 'function')
    openai.setFetch(async (url, init) => {
      try {
        return await net.fetch(url, init);
      } catch (error) {
        if (/ERR_UNSAFE_PORT/.test(String(error?.message))) return globalThis.fetch(url, init);
        throw error;
      }
    });
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
  startSleepBlockerWatch();
  // 草稿挪过位置的话把素材路径改过来（后台做，不耽误启动）。
  setTimeout(() => relinkMovedDrafts(), 8000).unref?.();
  // Mac 关机、重启时同样直接退出，不用确认框拦住关机。
  try {
    powerMonitor?.on?.('shutdown', () => {
      quitConfirmed = true;
    });
  } catch (_) {}
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

// 有下载、去重、草稿、拆解、字幕在跑时不让系统自动睡眠（屏幕可以照常关），
// 否则夜里挂着处理，电脑一睡 FFmpeg 就停在半路。全部空闲后立刻放开。
let sleepBlocker = null;
function appBusy() {
  return (
    activeDownloads > 0 ||
    downloadQueue.some((task) => task.status === 'pending') ||
    quchongActive > 0 ||
    [...quchongBatches.values()].some((batch) => !batch.finished) ||
    libraryPlanning.size > 0 ||
    [...libraryDraftJobs.values()].some((job) => job.status === 'running') ||
    mergeTasks.some((task) => ['running', 'queued'].includes(task.status)) ||
    !!transcriptionManager?.hasActive() ||
    !!reconstructionPipeline?.hasActive()
  );
}
function refreshSleepBlocker() {
  if (!powerSaveBlocker) return;
  let busy = false;
  try {
    busy = appBusy();
  } catch (_) {}
  if (busy && sleepBlocker == null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!busy && sleepBlocker != null) {
    if (powerSaveBlocker.isStarted(sleepBlocker)) powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }
}
function startSleepBlockerWatch() {
  const tick = () => {
    refreshSleepBlocker();
    setTimeout(tick, 15_000).unref?.();
  };
  tick();
}

// GPU、网络等子进程崩溃只记日志（Chromium 会自己重启它们），方便排查个别机器的显卡驱动问题。
app.on('child-process-gone', (_event, details) => {
  if (details?.reason !== 'clean-exit')
    console.error('[Process] 子进程退出:', details?.type, details?.reason, details?.exitCode);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 真要退出了（before-quit 没被拦下）：把 LaMa 补图进程一起关掉
app.on('will-quit', () => {
  try {
    lamaWorker?.close();
  } catch (_) {}
});

let waitingForSubtitles = false;
app.on('before-quit', (event) => {
  try {
    store.flushPending();
    activityLogStore?.flush();
  } catch (_) {}
  // macOS 的 ⌘Q / Dock 退出会先到这里：有任务在跑就先问，别在用户点「继续处理」之前就把任务停了。
  let busy = false;
  try {
    busy = appBusy();
  } catch (_) {}
  if (busy && !quitConfirmed && dialog?.showMessageBox) {
    event.preventDefault();
    askToQuit(mainWindow);
    return;
  }
  if (!transcriptionManager?.hasActive() && !reconstructionPipeline?.hasActive()) return;
  event.preventDefault();
  if (waitingForSubtitles) return;
  waitingForSubtitles = true;
  Promise.allSettled([transcriptionManager?.cancelAll(), reconstructionPipeline?.cancelAll()]).finally(() => {
    waitingForSubtitles = false;
    app.quit();
  });
});
