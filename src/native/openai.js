/**
 * OpenAI-compatible AI adapter.
 *
 * The base URL is deliberately configurable because the app is commonly used
 * with an OpenAI-compatible relay (for example, https://host.example/v1).
 * This module never logs the API key or request headers.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_AUDIO = 24 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;

const TEXT_TIMEOUT = 300000;
const IMAGE_TIMEOUT = 600000;

function requestSignal(signal, timeout = TEXT_TIMEOUT) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

// 主进程启动后换成 Electron 的 net.fetch：走设置里的代理和系统代理（Clash 等），也没有 Node 自带的
// 「5 分钟没回包头就断开」限制。测试和命令行里仍用全局 fetch。
let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
}

const NETWORK_TEXT = [
  [/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/, '找不到这个地址（域名解析失败），请检查中转地址是否写对、网络是否正常'],
  [/ERR_PROXY|TUNNEL_CONNECTION_FAILED|ERR_SOCKS/, '代理连不上，请检查设置里的代理或电脑上的代理软件'],
  [/CONNECTION_REFUSED|ECONNREFUSED/, '对方拒绝连接，请检查中转地址和端口'],
  [
    /CERT|SSL|ERR_BAD_SSL|UNABLE_TO_VERIFY|self.signed/i,
    '证书校验失败（中转地址的 https 证书有问题，或被代理软件拦截）',
  ],
  [/INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|ENETUNREACH/, '网络断开或切换了'],
  [/CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|CONNECT_TIMEOUT/, '连接超时，网络不通或被拦截'],
  [/HEADERS_TIMEOUT|BODY_TIMEOUT/, '接口太久没有返回'],
  [
    /CONNECTION_RESET|ECONNRESET|CONNECTION_CLOSED|EMPTY_RESPONSE|UND_ERR_SOCKET|other side closed|EPIPE|HTTP2|QUIC/,
    '连接被中途断开（中转站或网络把这个请求断了）',
  ],
];

/** 把底层网络错误（net::ERR_xxx、fetch failed + cause）翻成一句看得懂的中文，附上原始代码方便排查。 */
function describeNetworkError(error) {
  const cause = error?.cause;
  const raw = [error?.message, cause?.code, cause?.message, cause?.cause?.code].filter(Boolean).join(' ');
  const code = (raw.match(/net::ERR_[A-Z_]+|UND_ERR_[A-Z_]+|E[A-Z]{4,}/) || [])[0] || '';
  const hit = NETWORK_TEXT.find(([pattern]) => pattern.test(raw));
  return `${hit ? hit[1] : '网络请求失败'}${code ? `（${code}）` : raw ? `（${raw.slice(0, 120)}）` : ''}`;
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || /due to timeout/i.test(String(error?.message || ''));
}

/** 连接被断、对方一时连不上这类「再试一次多半就好」的错误；超时、证书、地址写错不重试。 */
function isTransientNetworkError(error) {
  if (isTimeout(error) || error?.name === 'AbortError') return false;
  const raw = [error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join(' ');
  return /CONNECTION_RESET|ECONNRESET|CONNECTION_CLOSED|EMPTY_RESPONSE|UND_ERR_SOCKET|other side closed|EPIPE|NETWORK_CHANGED|HTTP2|QUIC|fetch failed$/.test(
    raw,
  );
}

function redactError(error, apiKey = '') {
  let message = String(error?.message || error || 'AI 请求失败');
  for (const value of [apiKey, encodeURIComponent(apiKey)].filter(Boolean))
    message = message.split(value).join('[已隐藏]');
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/sk-[\w-]+/g, '[已隐藏]')
    .slice(0, 500);
}

async function boundedBody(response, limit) {
  const size = Number(response.headers?.get?.('content-length') || response.headers?.['content-length'] || 0);
  if (size > limit) {
    await response.body?.cancel();
    throw new Error('AI 响应超过允许大小');
  }
  const chunks = [];
  let received = 0;
  if (!response.body) {
    if (typeof response.text !== 'function') return Buffer.alloc(0);
    const text = await response.text();
    const buffer = Buffer.from(text);
    if (buffer.length > limit) throw new Error('AI 响应超过允许大小');
    return buffer;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        throw new Error('AI 响应超过允许大小');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}

async function boundedFile(file, limit) {
  if ((await fs.stat(file)).size > limit) throw new Error('素材文件超过接口上传大小限制');
  const data = await fs.readFile(file);
  if (data.length > limit) throw new Error('素材文件超过接口上传大小限制');
  return data;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return 'https://api.openai.com/v1';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('AI 中转地址格式无效，请填写完整的 http(s) URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('AI 中转地址必须使用 http 或 https');
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('AI 中转地址不能包含认证信息、查询参数或片段');
  // OpenAI-compatible relays normally expose the API below /v1. Users can
  // still explicitly set another path and it will be preserved.
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/v1';
  return parsed.toString().replace(/\/+$/, '');
}

const DEFAULT_TEXT_MODEL = 'gpt-6.1-sol';
const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5';

function normalizeConfig(config = {}) {
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.ai_base_url);
  const apiKey = String(config.apiKey || config.ai_api_key || '').trim();
  const imageBase = String(config.imageBaseUrl || config.ai_image_base_url || '').trim();
  return {
    baseUrl,
    apiKey,
    // 作图可以单独走另一个中转地址 / Key；留空就和文本共用。
    imageBaseUrl: imageBase ? normalizeBaseUrl(imageBase) : baseUrl,
    imageApiKey: String(config.imageApiKey || config.ai_image_api_key || '').trim() || apiKey,
    imageModel: String(config.imageModel || config.ai_image_model || DEFAULT_IMAGE_MODEL).trim(),
    textModel: String(config.textModel || config.ai_text_model || DEFAULT_TEXT_MODEL).trim(),
    transcriptionModel: String(
      config.transcriptionModel || config.ai_transcription_model || 'gpt-4o-mini-transcribe',
    ).trim(),
    imageSize: String(config.imageSize || config.ai_image_size || '1024x1536').trim(),
    imageQuality: String(config.imageQuality || config.ai_image_quality || 'high').trim(),
  };
}

function requireApiConfig(config, kind = 'text') {
  const normalized = normalizeConfig(config);
  if (kind === 'image') {
    if (!normalized.imageApiKey) throw new Error('请先在设置中填写作图 API Key（或文本 API Key）');
    if (!normalized.imageModel) throw new Error('请先在设置中填写图片模型');
    return normalized;
  }
  if (!normalized.apiKey) throw new Error('请先在设置中填写 AI API Key');
  if (!normalized.imageModel) throw new Error('请先在设置中填写图片模型');
  if (!normalized.textModel) throw new Error('请先在设置中填写文案模型');
  if (!normalized.transcriptionModel) throw new Error('请先在设置中填写转写模型');
  return normalized;
}

function endpoint(baseUrl, suffix) {
  return `${baseUrl}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

async function readResponse(response, limit) {
  const text = (await boundedBody(response, limit)).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function errorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload.slice(0, 300) || fallback;
  const error = payload.error;
  if (typeof error === 'string') return error.slice(0, 300);
  if (error && typeof error.message === 'string') return error.message.slice(0, 300);
  if (typeof payload.message === 'string') return payload.message.slice(0, 300);
  return fallback;
}

async function request(baseConfig, suffix, options = {}) {
  const config = requireApiConfig(baseConfig, options.kind);
  const image = options.kind === 'image';
  const apiKey = image ? config.imageApiKey : config.apiKey;
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${apiKey}` };
  const url = endpoint(image ? config.imageBaseUrl : config.baseUrl, suffix);
  const timeout = options.timeout || TEXT_TIMEOUT;
  const what = image ? '作图接口' : 'AI 接口';
  for (let attempt = 1; ; attempt += 1) {
    let response;
    let payload;
    try {
      response = await fetchImpl(url, {
        method: options.method || 'POST',
        headers,
        body: options.body,
        signal: requestSignal(options.signal, timeout),
      });
      payload = await readResponse(response, response.ok ? options.maxBytes || MAX_TEXT : 32 * 1024);
    } catch (error) {
      if (options.signal?.aborted) throw error; // 用户点了取消
      if (/超过允许大小/.test(String(error?.message))) throw error;
      if (attempt === 1 && isTransientNetworkError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      if (isTimeout(error))
        throw new Error(
          `${what}等了 ${Math.round(timeout / 60000)} 分钟还没返回结果，已放弃。可以稍后重试，或换个更快的模型/中转`,
        );
      let host = '';
      try {
        host = new URL(url).host;
      } catch (_) {}
      throw new Error(
        redactError(
          `连不上${image ? '' : ' '}${what}${host ? `（${host}）` : ''}：${describeNetworkError(error)}`,
          apiKey,
        ),
      );
    }
    if (!response.ok) {
      const detail = redactError(errorMessage(payload, response.statusText || '未知错误'), apiKey);
      throw new Error(`AI 接口请求失败（HTTP ${response.status}）：${detail}`);
    }
    return { payload, response };
  }
}

function dataUrlBuffer(value) {
  const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(String(value || ''));
  if (!match) return null;
  return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1] || 'image/png' };
}

/** 按文件头判断图片类型：中转站和官方接口都会校验上传文件的 MIME，不能把 JPEG 标成 PNG。 */
function sniffImage(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return { type: 'image/jpeg', ext: '.jpg' };
  if (buffer.subarray(1, 4).toString('latin1') === 'PNG') return { type: 'image/png', ext: '.png' };
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP')
    return { type: 'image/webp', ext: '.webp' };
  return { type: 'image/png', ext: '.png' };
}

async function readImage(image, signal) {
  if (image?.byteLength > MAX_IMAGE || (typeof image === 'string' && image.length > MAX_IMAGE * 1.4))
    throw new Error('封面图片过大');
  if (Buffer.isBuffer(image) || image instanceof Uint8Array) {
    const buffer = Buffer.from(image);
    const kind = sniffImage(buffer);
    return { buffer, contentType: kind.type, name: `cover${kind.ext}` };
  }
  const value = String(image || '').trim();
  if (!value) throw new Error('缺少原封面图片');
  const data = dataUrlBuffer(value);
  if (data) return { ...data, name: 'cover.png' };
  if (/^https?:\/\//i.test(value)) {
    const response = await fetchImpl(value, { signal: requestSignal(signal) });
    if (!response.ok) throw new Error(`原封面下载失败（HTTP ${response.status}）`);
    return {
      buffer: await boundedBody(response, MAX_IMAGE),
      contentType: response.headers.get('content-type') || 'image/png',
      name: path.basename(new URL(value).pathname) || 'cover.png',
    };
  }
  const buffer = await boundedFile(value, MAX_IMAGE);
  const kind = sniffImage(buffer);
  const base = path.basename(value, path.extname(value)) || 'cover';
  return { buffer, contentType: kind.type, name: `${base}${kind.ext}` };
}

function parseImageData(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!item) throw new Error('图片接口没有返回图片数据');
  if (item.b64_json) {
    if (item.b64_json.length > MAX_IMAGE * 1.4) throw new Error('生成封面图片过大');
    return { buffer: Buffer.from(item.b64_json, 'base64'), contentType: 'image/png' };
  }
  if (item.url) return { url: String(item.url) };
  throw new Error('图片接口返回格式不受支持');
}

async function fetchImageResult(result, signal) {
  if (!result?.url) return result;
  if (!/^https?:\/\//i.test(result.url)) throw new Error('生成图片链接无效');
  const response = await fetchImpl(result.url, { signal: requestSignal(signal) });
  if (!response.ok) throw new Error(`生成图片下载失败（HTTP ${response.status}）`);
  return {
    buffer: await boundedBody(response, MAX_IMAGE),
    contentType: response.headers.get('content-type') || 'image/png',
  };
}

async function generateImage(options = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig, 'image');
  const prompt = String(options.prompt || '').trim();
  if (!prompt) throw new Error('缺少图片生成提示词');
  const { payload } = await request(config, '/images/generations', {
    kind: 'image',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model || config.imageModel,
      prompt,
      size: options.size || config.imageSize,
      quality: options.quality || config.imageQuality,
      n: 1,
    }),
    signal: options.signal,
    timeout: IMAGE_TIMEOUT,
    maxBytes: MAX_IMAGE * 1.4,
  });
  return fetchImageResult(parseImageData(payload), options.signal);
}

async function editImage(options = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig, 'image');
  const prompt = String(options.prompt || '').trim();
  if (!prompt) throw new Error('缺少封面重绘提示词');
  const source = await readImage(options.image || options.imagePath || options.imageUrl, options.signal);
  const form = new FormData();
  form.append('model', options.model || config.imageModel);
  form.append('prompt', prompt);
  form.append('size', options.size || config.imageSize);
  form.append('quality', options.quality || config.imageQuality);
  form.append('n', '1');
  form.append('image', new Blob([source.buffer], { type: source.contentType }), source.name);
  const { payload } = await request(config, '/images/edits', {
    kind: 'image',
    body: form,
    signal: options.signal,
    timeout: IMAGE_TIMEOUT,
    maxBytes: MAX_IMAGE * 1.4,
  });
  return fetchImageResult(parseImageData(payload), options.signal);
}

async function transcribeAudio(filePath, options = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig);
  const source = await boundedFile(filePath, MAX_AUDIO);
  const form = new FormData();
  form.append('file', new Blob([source], { type: options.contentType || 'audio/mp4' }), path.basename(filePath));
  form.append('model', options.model || config.transcriptionModel);
  form.append('language', options.language || 'zh');
  form.append('response_format', options.responseFormat || 'json');
  const { payload } = await request(config, '/audio/transcriptions', { body: form, signal: options.signal });
  if (typeof payload === 'string') return payload.trim();
  const text = payload?.text || payload?.transcript || payload?.data?.text;
  if (!text) throw new Error('音频转写接口没有返回文本');
  return String(text).trim();
}

function parseJsonContent(content) {
  const raw = String(content || '').trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {}
  }
  return { summary: cleaned };
}

function messageText(payload) {
  const value = payload?.choices?.[0]?.message?.content;
  const text = Array.isArray(value)
    ? value.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : value;
  return String(text || '').trim();
}

/**
 * 通用对话请求（OpenAI 兼容 /chat/completions）。默认不带 temperature / response_format：
 * 不同模型和中转站对这两个参数的支持不一，JSON 靠提示词约束再宽松解析。
 * 返回纯文本；messages 的 content 可以是数组，用来带图片（视觉检查）。
 */
async function chat(messages, options = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig);
  const body = { model: options.model || config.textModel, messages };
  if (Number.isFinite(options.temperature)) body.temperature = options.temperature;
  const { payload } = await request(config, '/chat/completions', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
    timeout: options.timeout || TEXT_TIMEOUT,
  });
  const text = messageText(payload);
  if (!text) throw new Error('文本接口没有返回内容');
  return text;
}

function parseJsonStrict(content) {
  const cleaned = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const attempts = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(cleaned.slice(start, end + 1));
  for (const text of attempts) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch (_) {}
  }
  return null;
}

async function chatJson(messages, options = {}, baseConfig = {}) {
  const parsed = parseJsonStrict(await chat(messages, options, baseConfig));
  if (!parsed) throw new Error('文本接口返回的不是有效 JSON');
  return parsed;
}

async function summarizeEpisode(transcript, metadata = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig);
  const text = String(transcript || '').trim();
  if (!text) throw new Error('缺少待概括的字幕/音频文本');
  if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('转写文本过长，请分段处理');
  const title = String(metadata.seriesTitle || metadata.title || '未命名短剧');
  const episodeIndex = Number(metadata.episodeIndex) || 0;
  const episodeTitle = String(metadata.episodeTitle || '').trim();
  const seriesSynopsis = String(metadata.seriesSynopsis || '')
    .trim()
    .slice(0, 1200);
  const { payload } = await request(config, '/chat/completions', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: metadata.model || config.textModel,
      messages: [
        {
          role: 'system',
          content:
            '你是短剧发布文案编辑。只根据输入内容提炼剧情，不要编造。输出严格 JSON，字段为 title、summary、hook、hashtags；summary 控制在 80 字以内，hook 控制在 30 字以内，hashtags 为 3-5 个中文标签数组。',
        },
        {
          role: 'user',
          content: `剧名：${title}\n${
            seriesSynopsis ? `来源平台的剧简介（仅供理解背景，不要照抄）：${seriesSynopsis}\n` : ''
          }集数：${episodeIndex || '未知'}\n分集标题：${episodeTitle || '无'}\n\n转写文本：\n${text}`,
        },
      ],
    }),
    signal: metadata.signal,
  });
  const contentValue = payload?.choices?.[0]?.message?.content;
  const content = Array.isArray(contentValue)
    ? contentValue.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : contentValue;
  if (!content) throw new Error('文案接口没有返回内容');
  const copy = parseJsonContent(content);
  return { ...copy, raw: String(content) };
}

/**
 * Return the stable per-episode analysis used by the editing pipeline.
 * The complete SRT remains on disk; this response only stores decisions and
 * time ranges, so the state file never grows with a whole transcript.
 */
function normalizeEpisodeAnalysis(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const number = (input) => (Number.isFinite(Number(input)) ? Number(input) : null);
  const range = (item) => {
    const start = number(item?.start ?? item?.start_time ?? item?.from);
    const end = number(item?.end ?? item?.end_time ?? item?.to);
    if (start == null || end == null || end <= start) return null;
    return { start, end };
  };
  const climaxes = (Array.isArray(source.climaxes) ? source.climaxes : [])
    .map((item) => {
      const times = range(item);
      if (!times) return null;
      const score = Math.max(1, Math.min(10, Math.round(Number(item.score ?? item.rating) || 0)));
      return { ...times, description: String(item.description ?? item.desc ?? item.reason ?? '').trim(), score };
    })
    .filter((item) => item && item.description)
    .slice(0, 20);
  const splitPoints = (Array.isArray(source.split_points) ? source.split_points : [])
    .map((item) => {
      const value = typeof item === 'number' ? item : (item?.time ?? item?.at ?? item?.seconds);
      const time = number(value);
      if (time == null || time < 0) return null;
      return { time, reason: String(typeof item === 'object' ? (item.reason ?? item.description ?? '') : '').trim() };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time)
    .slice(0, 2);
  const hookRange = range(source.best_hook);
  const bestHook = hookRange
    ? {
        ...hookRange,
        description: String(source.best_hook?.description ?? source.best_hook?.desc ?? '').trim(),
      }
    : null;
  return {
    summary: String(source.summary || '')
      .trim()
      .slice(0, 200),
    climaxes,
    split_points: splitPoints,
    best_hook: bestHook,
    arc_end: source.arc_end === true || source.arc_end === 'true',
  };
}

async function analyzeEpisode(transcriptSrt, metadata = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig);
  const text = String(transcriptSrt || '').trim();
  if (!text) throw new Error('缺少待分析的 SRT 内容');
  if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('SRT 文本过长，请分段处理');
  const title = String(metadata.seriesTitle || metadata.title || '未命名短剧');
  const episodeIndex = Number(metadata.episodeIndex) || 0;
  const response = await request(config, '/chat/completions', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: metadata.model || config.textModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是短剧剪辑导演。只根据输入的 SRT 理解剧情，转写可能有错别字，按语义理解，不要编造。输出严格 JSON，且只能包含 summary、climaxes、split_points、best_hook、arc_end 五个字段。summary 是 200 字以内梗概；climaxes 是数组，每项包含 start、end、description、score(1-10)；split_points 是数组，最多 2 项，每项包含 time、reason，只标场景或话题转换处，禁止标在对话中间；best_hook 是 {start,end,description} 或 null，时长 5-15 秒；arc_end 是布尔值。不要输出 fillers、废话段或其他字段。',
        },
        {
          role: 'user',
          content: `剧名：${title}\n集数：${episodeIndex || '未知'}\n\n完整 SRT：\n${text}`,
        },
      ],
    }),
    signal: metadata.signal,
  });
  const contentValue = response.payload?.choices?.[0]?.message?.content;
  const content = Array.isArray(contentValue)
    ? contentValue.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : contentValue;
  if (!content) throw new Error('分析接口没有返回内容');
  return normalizeEpisodeAnalysis(parseJsonContent(content));
}

module.exports = {
  setFetch,
  describeNetworkError,
  normalizeBaseUrl,
  normalizeConfig,
  requireApiConfig,
  redactError,
  generateImage,
  editImage,
  transcribeAudio,
  summarizeEpisode,
  analyzeEpisode,
  normalizeEpisodeAnalysis,
  chat,
  chatJson,
  parseJsonContent,
  parseJsonStrict,
  DEFAULT_TEXT_MODEL,
  DEFAULT_IMAGE_MODEL,
};
