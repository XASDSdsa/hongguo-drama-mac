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
const REQUEST_TIMEOUT_MS = 180000; // 上传、查状态、删除
// 看视频回答一次可能要好几分钟（模型边看边想，答案又长）；以前 3 分钟一到就自己掐断，看着像方舟超时。
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const READY_STATES = new Set(['processed', 'ready', 'active', 'completed']);
const FAILED_STATES = new Set(['failed', 'error', 'expired']);

function redact(text, apiKey) {
  let out = String(text ?? '');
  for (const secret of [apiKey, encodeURIComponent(apiKey || '')].filter(Boolean))
    out = out.split(secret).join('[已隐藏]');
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

const PHASE_TEXT = { upload: '上传', process: '方舟处理视频', answer: '回答' };
const seconds = (ms) => `${Math.max(0, Math.round(ms / 1000))} 秒`;

/** 「上传 3 秒，方舟处理视频 2 秒，回答 95 秒」；给了 stuck 时写成「卡在回答（等了 600 秒）；上传 3 秒…」。 */
function describePhases(timings = {}, stuck = '') {
  const parts = Object.keys(PHASE_TEXT)
    .filter((name) => name !== stuck && Number.isFinite(timings[name]))
    .map((name) => `${PHASE_TEXT[name]} ${seconds(timings[name])}`);
  if (!stuck) return parts.join('，');
  const head = `卡在「${PHASE_TEXT[stuck]}」这一步（等了 ${seconds(timings[stuck] || 0)}）`;
  return parts.length ? `${head}；之前${parts.join('，')}` : head;
}

/**
 * 账号或设置层面的问题：重试多少次都一样（额度用完、Key 不对、模型没开通、欠费），返回给用户看的说明；其余返回空。
 * 这类错误标成 fatal：不再重试，后面的段和集也不再去碰。
 */
function accountProblem(status, body) {
  let code = '';
  try {
    code = String(JSON.parse(body)?.error?.code || '');
  } catch (_) {}
  const text = `${code} ${body}`;
  if (/SetLimitExceeded/i.test(text))
    return '方舟账号这个模型的用量到了设定上限（「安全体验模式」），方舟已暂停这个模型的服务。请到方舟控制台「开通管理」里关闭「安全体验模式」或调高上限（超出免费额度要按量付费），然后重新开始';
  if (/Overdue|InsufficientBalance|Arrears/i.test(text)) return '方舟账户欠费或余额不足，请充值后重新开始';
  if (status === 401 || /AuthenticationError|InvalidApiKey|Unauthorized/i.test(code))
    return '方舟 API Key 不对或已失效，请在设置里重新填写';
  if (/ModelNotOpen|NotActivated/i.test(text)) return '这个模型还没有在方舟控制台「开通管理」里开通';
  if (status === 404 || /ModelNotFound|InvalidEndpointOrModel/i.test(code))
    return '方舟找不到这个模型，请检查设置里的视频理解模型名（要和方舟控制台里的完全一样）';
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
  askTimeoutMs = ASK_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function request(url, init, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { ...headers, ...(init?.headers || {}) },
        signal: withTimeout(signal, timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.name === 'TimeoutError')
        throw new Error(`方舟 ${Math.round(timeoutMs / 60000)} 分钟没有回应（网络慢或方舟繁忙），稍后重试`);
      throw new Error(`方舟请求失败：${redact(error?.message || error, apiKey)}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const problem = accountProblem(response.status, body);
      if (problem) {
        let code = '';
        try {
          code = String(JSON.parse(body)?.error?.code || '');
        } catch (_) {}
        throw Object.assign(new Error(`${problem}（方舟返回 ${response.status}${code ? ` ${code}` : ''}）`), {
          fatal: true,
          status: response.status,
        });
      }
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
      askTimeoutMs,
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

  /**
   * 上传一个视频，等它可用，对它提问；无论成败都清理。
   * 诊断：每一步花了多久交给 onTimings（毫秒：upload / process / answer）；失败时报错里写明卡在哪一步、前面几步各用了多久。
   */
  async function askAboutVideo(filePath, text, { fps, signal, onTimings } = {}) {
    const timings = {};
    let phase = 'upload';
    let mark = Date.now();
    const done = (name) => {
      timings[name] = Date.now() - mark;
      mark = Date.now();
    };
    let id = null;
    try {
      id = await uploadVideo(filePath, { fps, signal });
      done('upload');
      phase = 'process';
      await waitProcessed(id, { signal });
      done('process');
      phase = 'answer';
      const answer = await ask(id, text, { signal });
      done('answer');
      onTimings?.(timings);
      return answer;
    } catch (error) {
      if (signal?.aborted || error?.fatal) throw error; // 账号问题说清楚就够了，不用再写卡在哪一步
      timings[phase] = Date.now() - mark;
      const wrapped = new Error(`${error?.message || error}（${describePhases(timings, phase)}）`);
      wrapped.timings = timings;
      wrapped.phase = phase;
      throw wrapped;
    } finally {
      if (id) await removeFile(id);
    }
  }

  return { uploadVideo, waitProcessed, ask, removeFile, askAboutVideo };
}

module.exports = {
  createArkClient,
  extractText,
  redact,
  describePhases,
  accountProblem,
  DEFAULT_BASE_URL,
  MAX_UPLOAD_BYTES,
  ASK_TIMEOUT_MS,
};
