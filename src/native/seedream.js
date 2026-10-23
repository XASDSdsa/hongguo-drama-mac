'use strict';
// 海报 / 封面作图：火山方舟 Seedream 5.0 Pro（doubao-seedream-5-0-pro-260628）。
// 接口：POST {方舟地址}/images/generations（https://ark.cn-beijing.volces.com/api/v3），Bearer 方舟 API Key。
//   model、prompt、image（参考图：URL 或 data:image/<小写格式>;base64,…，最多 10 张，单张 ≤ 30 MB）、
//   size（「宽x高」总像素 921600～4624220，宽高比 1/16～16；或 1K / 1.5K / 2K）、
//   response_format（url / b64_json）、output_format（png / jpeg）、watermark（true 时右下角加「AI生成」）。
//   返回 data[].b64_json 或 data[].url（链接只保留 24 小时，拿到就下载）。
// 和 openai.js 的 generateImage / editImage 一样的用法，返回 { buffer, contentType }。
const fs = require('node:fs');

const DEFAULT_MODEL = 'doubao-seedream-5-0-pro-260628';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
// 竖版 2:3 海报：1664×2496 ≈ 415 万像素（上限 462 万）
const POSTER_SIZE = '1664x2496';
const MIN_PIXELS = 921600;
const MAX_PIXELS = 4624220;
const MAX_INPUT = 30 * 1024 * 1024;
const MAX_OUTPUT = 40 * 1024 * 1024;
const TIMEOUT_MS = 240_000;

let fetchImpl = (...args) => fetch(...args);

/** 「宽x高」在 Seedream 允许的范围里就用，不在就用 2:3 海报尺寸。 */
function normalizeSize(value) {
  const match = String(value || '')
    .trim()
    .match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i);
  if (!match)
    return /^(1K|1\.5K|2K)$/i.test(String(value || '').trim()) ? String(value).trim().toUpperCase() : POSTER_SIZE;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  if (width * height < MIN_PIXELS || width * height > MAX_PIXELS || ratio < 1 / 16 || ratio > 16) return POSTER_SIZE;
  return `${width}x${height}`;
}

function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP')
    return 'webp';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('latin1', 0, 6))) return 'gif';
  if (buffer.length >= 2 && buffer.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return '';
}

const redact = (text, apiKey) => {
  let out = String(text || '');
  if (apiKey) out = out.split(apiKey).join('***');
  return out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
};

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBody(response, limit) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new Error('图片太大');
  return buffer;
}

/** 参考图：本机文件、http(s) 链接（先下载）或 data URI，都转成 data:image/<格式>;base64,…。 */
async function toDataUri(source, signal) {
  if (Buffer.isBuffer(source)) {
    const format = sniffImage(source);
    if (!format) throw new Error('参考图不是能识别的图片');
    return `data:image/${format};base64,${source.toString('base64')}`;
  }
  const value = String(source || '').trim();
  if (!value) throw new Error('缺少参考图');
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value))
    return value.replace(/^data:image\/([a-z0-9.+-]+)/i, (_, f) => `data:image/${f.toLowerCase()}`);
  let buffer;
  if (/^https?:\/\//i.test(value)) {
    const response = await fetchImpl(value, { signal: withTimeout(signal, 60_000) });
    if (!response.ok) throw new Error(`参考图下载失败（HTTP ${response.status}）`);
    buffer = await readBody(response, MAX_INPUT);
  } else {
    const stat = fs.statSync(value, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error('参考图文件不存在');
    if (stat.size > MAX_INPUT) throw new Error('参考图超过 30 MB');
    buffer = fs.readFileSync(value);
  }
  return toDataUri(buffer, signal);
}

function config(base = {}) {
  const apiKey = String(base.apiKey || '').trim();
  if (!apiKey) throw new Error('请先在设置里填火山方舟 API Key（海报用 Seedream 作图）');
  return {
    baseUrl:
      String(base.baseUrl || DEFAULT_BASE_URL)
        .trim()
        .replace(/\/+$/, '') || DEFAULT_BASE_URL,
    apiKey,
    model: String(base.model || '').trim() || DEFAULT_MODEL,
  };
}

/** 作图：images 是参考图（可以没有）。返回 { buffer, contentType }。 */
async function draw({ prompt, images = [], size, signal } = {}, base = {}) {
  const { baseUrl, apiKey, model } = config(base);
  const text = String(prompt || '').trim();
  if (!text) throw new Error('缺少作图提示词');
  const refs = [];
  for (const image of images.filter(Boolean).slice(0, 10)) refs.push(await toDataUri(image, signal));
  const body = {
    model,
    prompt: text,
    size: normalizeSize(size),
    response_format: 'b64_json',
    watermark: false,
  };
  // output_format 是 5.0 才有的参数：自己填了老模型（4.x 等）就不传，免得接口不认
  if (/seedream-5/i.test(model)) body.output_format = 'png';
  if (refs.length) body.image = refs.length === 1 ? refs[0] : refs;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: withTimeout(signal, TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error?.name === 'TimeoutError') throw new Error(`Seedream 作图超过 ${TIMEOUT_MS / 1000} 秒没回`);
    throw new Error(`连不上火山方舟：${redact(error?.message || error, apiKey)}`);
  }
  const raw = await readBody(response, MAX_OUTPUT * 1.4);
  let payload = null;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (_) {}
  if (!response.ok || payload?.error) {
    const detail = payload?.error?.message || payload?.error?.code || raw.toString('utf8').slice(0, 300);
    const hint =
      response.status === 401
        ? '（方舟 API Key 不对）'
        : response.status === 404 || /model/i.test(String(payload?.error?.code || ''))
          ? `（检查海报模型名 ${model}，以及方舟控制台里有没有开通它）`
          : '';
    throw new Error(`Seedream 作图失败（HTTP ${response.status}）${hint}：${redact(detail, apiKey)}`);
  }
  const item = Array.isArray(payload?.data) ? payload.data.find((entry) => entry?.b64_json || entry?.url) : null;
  if (!item) throw new Error('Seedream 没有返回图片');
  let buffer;
  if (item.b64_json) buffer = Buffer.from(String(item.b64_json), 'base64');
  else {
    if (!/^https?:\/\//i.test(item.url)) throw new Error('Seedream 返回的图片链接无效');
    const download = await fetchImpl(item.url, { signal: withTimeout(signal, 120_000) });
    if (!download.ok) throw new Error(`Seedream 图片下载失败（HTTP ${download.status}）`);
    buffer = await readBody(download, MAX_OUTPUT);
  }
  const format = sniffImage(buffer);
  if (!format) throw new Error('Seedream 返回的不是图片');
  return { buffer, contentType: `image/${format}` };
}

/** 和 openai.generateImage 一样：只按提示词画。 */
const generateImage = (options = {}, base = {}) => draw({ ...options, images: [] }, base);
/** 和 openai.editImage 一样：按一张参考图（options.image / imagePath / imageUrl）画。 */
const editImage = (options = {}, base = {}) =>
  draw({ ...options, images: [options.image || options.imagePath || options.imageUrl] }, base);

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  POSTER_SIZE,
  normalizeSize,
  sniffImage,
  toDataUri,
  generateImage,
  editImage,
  redact,
  _setFetch(fn) {
    fetchImpl = fn;
  },
};
