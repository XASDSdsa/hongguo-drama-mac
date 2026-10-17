'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const DEFAULT_MODEL = 'qwen3.8-omni-flash';
const MAX_INLINE_BYTES = 7 * 1024 * 1024;

function baseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('未配置千问兼容接口地址');
  return url.endsWith('/v1') ? url : `${url}/v1`;
}

function requiredConfig(settings = {}) {
  const apiKey = String(settings.qwen_api_key || '').trim();
  if (!apiKey) throw new Error('未配置千问 API Key');
  const model = String(settings.qwen_model || DEFAULT_MODEL).trim();
  if (!model) throw new Error('未配置千问模型');
  return {
    apiKey,
    model,
    baseUrl: baseUrl(settings.qwen_base_url),
    timeout: Math.max(10_000, Number(settings.qwen_timeout_ms) || 600_000),
    maxInlineBytes: Math.max(1_000_000, Number(settings.qwen_max_inline_bytes) || MAX_INLINE_BYTES),
  };
}

function requestSignal(signal, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('千问请求超时')), timeout);
  timer.unref?.();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason || new Error('任务已取消'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason || new Error('任务已取消')), { once: true });
  }
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

function messageText(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.output_text ?? payload?.output?.[0]?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => item?.text || item?.content || '').join('');
  return '';
}

function errorText(payload) {
  if (!payload) return '千问接口没有返回错误详情';
  if (typeof payload === 'string') return payload.slice(0, 500);
  return String(payload?.error?.message || payload?.message || '千问接口请求失败').slice(0, 500);
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter(value => value >= 0).sort((a, b) => a - b);
  if (!starts.length) throw new Error('千问返回内容不是 JSON');
  const start = starts[0];
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (end <= start) throw new Error('千问返回内容不是完整 JSON');
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch (_) { throw new Error('千问返回内容不是有效 JSON'); }
}

async function asVideoInput(videoPath, options = {}) {
  if (options.videoUrl) return String(options.videoUrl);
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('千问输入视频不存在');
  const stat = await fsp.stat(videoPath);
  const max = Number(options.maxInlineBytes) || MAX_INLINE_BYTES;
  if (stat.size > max) {
    throw new Error(`本地视频 ${Math.ceil(stat.size / 1024 / 1024)}MB，超过当前配置的 Base64 内联阈值；请提供可访问的 qwen_video_url，不能伪造本地视频已上传`);
  }
  const buffer = await fsp.readFile(videoPath);
  // 百炼 Chat Completions 的视频 Base64 形式使用 data:;base64；保持与官方示例一致。
  return `data:;base64,${buffer.toString('base64')}`;
}

async function asImageInput(filePath, options = {}) {
  if (options.url) return String(options.url);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = await fsp.stat(filePath);
  if (stat.size > (Number(options.maxImageBytes) || 2 * 1024 * 1024)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${type};base64,${(await fsp.readFile(filePath)).toString('base64')}`;
}

function shotContext(shot) {
  return {
    shot_id: shot.shot_id,
    order: shot.order,
    start_frame: shot.start_frame,
    end_frame_exclusive: shot.end_frame_exclusive,
    start_us: shot.start_us,
    end_us: shot.end_us,
    duration_us: shot.duration_us,
  };
}

const JSON_RULES = `只返回 JSON，不要 Markdown 代码围栏。不能修改程序提供的 shot_id、帧边界、时间边界、文件路径或 asset_id。未知字段用 null，数组没有内容用 []。所有镜头内部事件时间必须是该镜头内的整数微秒区间。`;

async function callQwen(prompt, inputs, settings, options = {}) {
  const config = requiredConfig(settings);
  const content = [{ type: 'text', text: `${prompt}\n\n${JSON_RULES}` }];
  const videos = Array.isArray(inputs.videos) ? inputs.videos : (inputs.videoPath || inputs.videoUrl ? [{ path: inputs.videoPath, url: inputs.videoUrl }] : []);
  for (const item of videos) {
    const video = typeof item === 'string' ? { path: item } : (item || {});
    if (video.label) content.push({ type: 'text', text: `[视频输入标记] ${String(video.label)}` });
    const url = await asVideoInput(video.path, { videoUrl: video.url, maxInlineBytes: config.maxInlineBytes });
    content.push({ type: 'video_url', video_url: { url } });
  }
  for (const image of inputs.images || []) {
    if (image?.label) content.push({ type: 'text', text: `[图片输入标记] ${String(image.label)}` });
    const url = await asImageInput(image.path, image);
    if (url) content.push({ type: 'image_url', image_url: { url } });
  }
  const reasoning = String(settings.qwen_reasoning_effort || '').trim().toLowerCase();
  const body = {
    model: config.model,
    messages: [{ role: 'user', content }],
    modalities: ['text'],
    temperature: 0,
    stream: false,
  };
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning)) body.reasoning_effort = reasoning;
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal(options.signal, config.timeout),
  });
  const payload = await readBody(response);
  if (!response.ok) throw new Error(`千问接口请求失败（HTTP ${response.status}）：${errorText(payload)}`);
  const text = messageText(payload);
  if (!text) throw new Error('千问接口没有返回文本内容');
  return { data: parseJson(text), usage: payload?.usage || null, rawText: text };
}

async function analyzeGlobal({ videoPath, videoUrl, representativeFrames = [], metadata = {}, settings, signal }) {
  const prompt = `你是中文 AI 漫剧工程分析器。分析整集有声视频，建立可复用的全局事实字典。\n${JSON.stringify({ metadata }, null, 2)}\n返回对象：{"styles":[],"characters":[],"scenes":[],"audio_events":[],"subtitle_cues":[],"review_items":[]}。\nstyles 每项至少包含 style_id、render_type、linework、material、palette、lighting、character_proportion、evidence_frame_indices、prompt_fragment。\ncharacters 每项至少包含 character_id、display_name、name_evidence、face、hair、body、appearances、evidence_frame_indices、reference_frame_indices、reference_crop_xyxy、prompt_fragment、needs_review；reference_crop_xyxy 必须是原画面归一化坐标 [x1,y1,x2,y2]，没有可靠框就填 null，不要猜。\nscenes 每项至少包含 scene_id、name、location_type、layout、time_of_day、lighting、palette、landmarks、evidence_frame_indices、reference_frame_indices、reference_crop_xyxy、prompt_fragment。\naudio_events 和 subtitle_cues 只记录视频实际能听见或看见的内容；字幕时间用整数微秒，不能把没有读到的对白补出来。角色、场景、风格只写画面和声音能证明的内容；证据帧号只能引用程序提供的代表帧或其附近可确认的工作帧；不能猜原始模型、种子、提示词。`;
  return callQwen(prompt, { videoPath, videoUrl, images: representativeFrames }, settings, { signal });
}

async function analyzeShots({ videoPath, videoUrl, videoPaths = [], shots = [], frames = [], dictionaries = {}, metadata = {}, settings, signal }) {
  const prompt = `你是逐镜头中文音视频分析器。下面是程序已确定的镜头边界和全局字典：\n${JSON.stringify({ metadata, dictionaries, shots: shots.map(shotContext) }, null, 2)}\n为每个 shot_id 返回一个对象，放在 {"shots":[]} 中。每个镜头对象至少包含 shot_id、scene_id、character_ids、appearance_ids、shot_size、camera_angle、composition、camera_movement、start_state、action_beats、end_state、subtitle_ids、audio_event_ids、visual_description、uncertainty_codes、prompt_parts、prompt_text、avoid。prompt_parts 必须包含 subject、environment、composition、action_sequence、camera、dialogue、audio、style、continuity、exclusions；如果存在 prompt_parts.timeline，它必须是该镜头内部从 0 到 duration_us 的连续区间，使用 start_us/end_us 整数微秒字段，每段都详细写角色、动作、表情、场景、镜头、风格、声音。不要把工程编号或“素材反推”写进可复制提示词。模型只能补充语义，不能改变程序提供的边界。`;
  const result = await callQwen(prompt, { videoPath, videoUrl, videos: videoPaths, images: frames }, settings, { signal });
  const list = Array.isArray(result.data?.shots) ? result.data.shots : Array.isArray(result.data) ? result.data : [];
  return { ...result, data: list };
}

module.exports = {
  DEFAULT_MODEL,
  requiredConfig,
  parseJson,
  analyzeGlobal,
  analyzeShots,
};
