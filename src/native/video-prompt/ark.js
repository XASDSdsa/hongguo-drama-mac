'use strict';
// 火山方舟视频理解客户端：上传视频 → 等待处理完成 → 带视频提问 → 清理。
//
// 注意：接口细节（文件上传的字段、fps 参数、处理状态名、Responses 的 input_video 写法）
// 目前只对照过第三方转述，没有在真实服务上跑通。这里把所有假设集中在这一个文件里，
// 真实调试时只需要改这里；上层只依赖 uploadVideo / ask / removeFile 三个方法。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // 方舟文件接口的单文件上限
const REQUEST_TIMEOUT_MS = 180000;
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const READY_STATES = new Set(['processed', 'ready', 'active', 'completed']);
const FAILED_STATES = new Set(['failed', 'error', 'expired']);

function redact(text, apiKey) {
  let out = String(text ?? '');
  for (const secret of [apiKey, encodeURIComponent(apiKey || '')].filter(Boolean)) out = out.split(secret).join('[已隐藏]');
  return out.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 500);
}

function withTimeout(signal, ms = REQUEST_TIMEOUT_MS) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** 从各种形状的响应里取出模型回答的文字。 */
function extractText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === 'string' && (!content.type || /text/i.test(content.type))) parts.push(content.text);
    }
  }
  if (parts.length) return parts.join('\n');
  const message = data?.choices?.[0]?.message?.content;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map((part) => part?.text || '').join('\n');
  return '';
}

function createArkClient({
  baseUrl = DEFAULT_BASE_URL,
  apiKey = '',
  model = '',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 2000,
  processTimeoutMs = PROCESS_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function request(url, init, signal) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, headers: { ...headers, ...(init?.headers || {}) }, signal: withTimeout(signal) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`方舟请求失败：${redact(error?.message || error, apiKey)}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`方舟接口返回 ${response.status}：${redact(body, apiKey)}`);
    }
    return response.json();
  }

  async function uploadVideo(filePath, { fps = 2, signal } = {}) {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(`视频片段 ${Math.round(stat.size / 1048576)} MB，超过方舟 512 MB 的上传上限`);
    }
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('preprocess_configs[video][fps]', String(fps));
    form.append('file', await fs.openAsBlob(filePath, { type: 'video/mp4' }), path.basename(filePath));
    const data = await request(`${base}/files`, { method: 'POST', body: form }, signal);
    const id = data?.id;
    if (!id) throw new Error('方舟没有返回文件 ID');
    return id;
  }

  async function waitProcessed(id, { signal } = {}) {
    const deadline = Date.now() + processTimeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const data = await request(`${base}/files/${encodeURIComponent(id)}`, { method: 'GET' }, signal);
      const status = String(data?.status || '').toLowerCase();
      if (READY_STATES.has(status)) return;
      if (FAILED_STATES.has(status)) throw new Error(`方舟处理视频失败：${status}`);
      if (Date.now() > deadline) throw new Error('方舟处理视频超时');
      await sleep(pollMs);
    }
  }

  async function ask(fileId, text, { signal } = {}) {
    if (!model) throw new Error('还没有填视频理解模型名');
    const data = await request(
      `${base}/responses`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_video', file_id: fileId },
                { type: 'input_text', text },
              ],
            },
          ],
        }),
      },
      signal,
    );
    const answer = extractText(data).trim();
    if (!answer) throw new Error('方舟没有返回文字');
    return answer;
  }

  /** 上传后用完就删，方舟那边默认只留 7 天。删不掉也不影响结果。 */
  async function removeFile(id) {
    try {
      await request(`${base}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (_) {
      // best effort
    }
  }

  /** 上传一个视频，等它可用，对它提问；无论成败都清理。 */
  async function askAboutVideo(filePath, text, { fps, signal } = {}) {
    const id = await uploadVideo(filePath, { fps, signal });
    try {
      await waitProcessed(id, { signal });
      return await ask(id, text, { signal });
    } finally {
      await removeFile(id);
    }
  }

  return { uploadVideo, waitProcessed, ask, removeFile, askAboutVideo };
}

module.exports = { createArkClient, extractText, redact, DEFAULT_BASE_URL, MAX_UPLOAD_BYTES };
