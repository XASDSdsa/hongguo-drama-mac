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

function requestSignal(signal, timeout = 180000) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

function redactError(error, apiKey = '') {
  let message = String(error?.message || error || 'AI 请求失败');
  for (const value of [apiKey, encodeURIComponent(apiKey)].filter(Boolean)) message = message.split(value).join('[已隐藏]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/sk-[\w-]+/g, '[已隐藏]').slice(0, 500);
}

async function boundedBody(response, limit) {
  const size = Number(response.headers?.get?.('content-length') || response.headers?.['content-length'] || 0);
  if (size > limit) { await response.body?.cancel(); throw new Error('AI 响应超过允许大小'); }
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
      if (received > limit) { await reader.cancel(); throw new Error('AI 响应超过允许大小'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, received);
}

async function boundedFile(file, limit) {
  if ((await fs.stat(file)).size > limit) throw new Error('素材文件超过接口上传大小限制');
  const data = await fs.readFile(file);
  if (data.length > limit) throw new Error('素材文件超过接口上传大小限制');
  return data;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://api.openai.com/v1';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('AI 中转地址格式无效，请填写完整的 http(s) URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('AI 中转地址必须使用 http 或 https');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('AI 中转地址不能包含认证信息、查询参数或片段');
  // OpenAI-compatible relays normally expose the API below /v1. Users can
  // still explicitly set another path and it will be preserved.
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/v1';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeConfig(config = {}) {
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl || config.ai_base_url),
    apiKey: String(config.apiKey || config.ai_api_key || '').trim(),
    imageModel: String(config.imageModel || config.ai_image_model || 'gpt-image-2.5').trim(),
    textModel: String(config.textModel || config.ai_text_model || 'gpt-5.6').trim(),
    transcriptionModel: String(config.transcriptionModel || config.ai_transcription_model || 'gpt-4o-mini-transcribe').trim(),
    imageSize: String(config.imageSize || config.ai_image_size || '1024x1536').trim(),
    imageQuality: String(config.imageQuality || config.ai_image_quality || 'high').trim(),
  };
}

function requireApiConfig(config) {
  const normalized = normalizeConfig(config);
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
  try { return JSON.parse(text); } catch (_) { return text; }
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
  const config = requireApiConfig(baseConfig);
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${config.apiKey}` };
  const response = await fetch(endpoint(config.baseUrl, suffix), {
    method: options.method || 'POST',
    headers,
    body: options.body,
    signal: requestSignal(options.signal, options.timeout),
  });
  const payload = await readResponse(response, response.ok ? options.maxBytes || MAX_TEXT : 32 * 1024);
  if (!response.ok) {
    const detail = redactError(errorMessage(payload, response.statusText || '未知错误'), config.apiKey);
    throw new Error(`AI 接口请求失败（HTTP ${response.status}）：${detail}`);
  }
  return { payload, response };
}

function dataUrlBuffer(value) {
  const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(String(value || ''));
  if (!match) return null;
  return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1] || 'image/png' };
}

async function readImage(image, signal) {
  if (image?.byteLength > MAX_IMAGE || (typeof image === 'string' && image.length > MAX_IMAGE * 1.4)) throw new Error('封面图片过大');
  if (Buffer.isBuffer(image)) return { buffer: image, contentType: 'image/png', name: 'cover.png' };
  if (image instanceof Uint8Array) return { buffer: Buffer.from(image), contentType: 'image/png', name: 'cover.png' };
  const value = String(image || '').trim();
  if (!value) throw new Error('缺少原封面图片');
  const data = dataUrlBuffer(value);
  if (data) return { ...data, name: 'cover.png' };
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value, { signal: requestSignal(signal) });
    if (!response.ok) throw new Error(`原封面下载失败（HTTP ${response.status}）`);
    return {
      buffer: await boundedBody(response, MAX_IMAGE),
      contentType: response.headers.get('content-type') || 'image/png',
      name: path.basename(new URL(value).pathname) || 'cover.png',
    };
  }
  const buffer = await boundedFile(value, MAX_IMAGE);
  return { buffer, contentType: 'image/png', name: path.basename(value) || 'cover.png' };
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
  const response = await fetch(result.url, { signal: requestSignal(signal) });
  if (!response.ok) throw new Error(`生成图片下载失败（HTTP ${response.status}）`);
  return {
    buffer: await boundedBody(response, MAX_IMAGE),
    contentType: response.headers.get('content-type') || 'image/png',
  };
}

async function generateImage(options = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig);
  const prompt = String(options.prompt || '').trim();
  if (!prompt) throw new Error('缺少图片生成提示词');
  const { payload } = await request(config, '/images/generations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model || config.imageModel,
      prompt,
      size: options.size || config.imageSize,
      quality: options.quality || config.imageQuality,
      n: 1,
    }),
    signal: options.signal,
    timeout: 600000,
    maxBytes: MAX_IMAGE * 1.4,
  });
  return fetchImageResult(parseImageData(payload), options.signal);
}

async function editImage(options = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig);
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
  const { payload } = await request(config, '/images/edits', { body: form, signal: options.signal, timeout: 600000, maxBytes: MAX_IMAGE * 1.4 });
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
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {}
  }
  return { summary: cleaned };
}

async function summarizeEpisode(transcript, metadata = {}, baseConfig = {}) {
  const config = requireApiConfig(baseConfig);
  const text = String(transcript || '').trim();
  if (!text) throw new Error('缺少待概括的字幕/音频文本');
  if (Buffer.byteLength(text) > MAX_TEXT) throw new Error('转写文本过长，请分段处理');
  const title = String(metadata.seriesTitle || metadata.title || '未命名短剧');
  const episodeIndex = Number(metadata.episodeIndex) || 0;
  const episodeTitle = String(metadata.episodeTitle || '').trim();
  const { payload } = await request(config, '/chat/completions', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: metadata.model || config.textModel,
      messages: [
        {
          role: 'system',
          content: '你是短剧发布文案编辑。只根据输入内容提炼剧情，不要编造。输出严格 JSON，字段为 title、summary、hook、hashtags；summary 控制在 80 字以内，hook 控制在 30 字以内，hashtags 为 3-5 个中文标签数组。',
        },
        {
          role: 'user',
          content: `剧名：${title}\n集数：${episodeIndex || '未知'}\n分集标题：${episodeTitle || '无'}\n\n转写文本：\n${text}`,
        },
      ],
    }),
    signal: metadata.signal,
  });
  const contentValue = payload?.choices?.[0]?.message?.content;
  const content = Array.isArray(contentValue)
    ? contentValue.map(part => typeof part === 'string' ? part : part?.text || '').join('')
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
  const number = input => Number.isFinite(Number(input)) ? Number(input) : null;
  const range = item => {
    const start = number(item?.start ?? item?.start_time ?? item?.from);
    const end = number(item?.end ?? item?.end_time ?? item?.to);
    if (start == null || end == null || end <= start) return null;
    return { start, end };
  };
  const climaxes = (Array.isArray(source.climaxes) ? source.climaxes : [])
    .map(item => {
      const times = range(item);
      if (!times) return null;
      const score = Math.max(1, Math.min(10, Math.round(Number(item.score ?? item.rating) || 0)));
      return { ...times, description: String(item.description ?? item.desc ?? item.reason ?? '').trim(), score };
    })
    .filter(item => item && item.description)
    .slice(0, 20);
  const splitPoints = (Array.isArray(source.split_points) ? source.split_points : [])
    .map(item => {
      const value = typeof item === 'number' ? item : item?.time ?? item?.at ?? item?.seconds;
      const time = number(value);
      if (time == null || time < 0) return null;
      return { time, reason: String(typeof item === 'object' ? item.reason ?? item.description ?? '' : '').trim() };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time)
    .slice(0, 2);
  const hookRange = range(source.best_hook);
  const bestHook = hookRange ? {
    ...hookRange,
    description: String(source.best_hook?.description ?? source.best_hook?.desc ?? '').trim(),
  } : null;
  return {
    summary: String(source.summary || '').trim().slice(0, 200),
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
          content: '你是短剧剪辑导演。只根据输入的 SRT 理解剧情，转写可能有错别字，按语义理解，不要编造。输出严格 JSON，且只能包含 summary、climaxes、split_points、best_hook、arc_end 五个字段。summary 是 200 字以内梗概；climaxes 是数组，每项包含 start、end、description、score(1-10)；split_points 是数组，最多 2 项，每项包含 time、reason，只标场景或话题转换处，禁止标在对话中间；best_hook 是 {start,end,description} 或 null，时长 5-15 秒；arc_end 是布尔值。不要输出 fillers、废话段或其他字段。',
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
    ? contentValue.map(part => typeof part === 'string' ? part : part?.text || '').join('')
    : contentValue;
  if (!content) throw new Error('分析接口没有返回内容');
  return normalizeEpisodeAnalysis(parseJsonContent(content));
}

module.exports = {
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
};
