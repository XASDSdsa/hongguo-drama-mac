'use strict';
// 下载失败的原因分类：让用户一眼看出是“平台没有这集”、还是“这次网络没连上”、还是别的，
// 以及点“重试”有没有用。只看错误信息、错误码和 HTTP 状态，不依赖任何运行时。

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ERR_NETWORK',
  'ERR_BAD_RESPONSE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const DISK_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'EMFILE', 'ENAMETOOLONG', 'ENOTDIR']);

const KINDS = {
  missing: {
    label: '资源缺失',
    text: '平台明确表示没有这一集（已下架、未开放或需要解锁），重试通常没有用',
    retryHelps: false,
  },
  expired: {
    label: '链接失效',
    text: '这条下载链接过期了，或者平台节点这会儿没有这集；程序会自动换新链接重试，仍不行可以稍后再点重试',
    retryHelps: true,
  },
  network: { label: '网络失败', text: '这次网络连接中断或超时，重试一般就能成功', retryHelps: true },
  denied: { label: '被平台拒绝', text: '平台拒绝了请求（链接过期或访问太频繁），稍等一会儿再重试', retryHelps: true },
  disk: { label: '磁盘错误', text: '磁盘空间不足或没有写入权限，先处理磁盘再重试', retryHelps: true },
  decrypt: { label: '解密失败', text: '下载到的视频数据异常，重试会重新获取', retryHelps: true },
  other: { label: '下载失败', text: '下载出错了，重试会重新获取播放地址', retryHelps: true },
};

// 只有平台自己明确说“没有 / 未开放 / 锁定”才算资源缺失。
// 取不到播放地址、下载链接返回 404 都可能是链接过期或节点临时抽风，换个新链接往往就能下，不能直接判成缺失。
const MISSING_PATTERN =
  /未开放|已下架|未解锁|需要解锁|当前锁定|付费|会员|暂无可用播放地址|仅提供前|暂未提供可播放分集|未找到该分集|分集列表为空/;

/** 这类失败值得程序自己换个新链接再试几次（磁盘、平台明确没有的不用）。 */
function isAutoRetryable(input) {
  const { kind } = classifyDownloadError(input);
  return kind !== 'disk' && kind !== 'missing';
}

function classifyDownloadError(input) {
  const source = typeof input === 'string' ? { message: input } : input || {};
  const message = String(source.message || source.error || '');
  const code = String(source.code || '').toUpperCase();
  const status = Number(source.status) || 0;
  const codeInMessage = (/\b(E[A-Z]{3,}|ERR_[A-Z_]+|UND_ERR_[A-Z_]+)\b/.exec(message) || [])[1] || '';
  const errno = code || codeInMessage;

  let kind = 'other';
  if (DISK_CODES.has(errno) || /no space|磁盘|写入权限|disk full/i.test(message)) kind = 'disk';
  else if (/Key 派生|解密|decrypt/i.test(message)) kind = 'decrypt';
  else if (MISSING_PATTERN.test(message)) kind = 'missing';
  else if (status === 404 || status === 410) kind = 'expired';
  else if (status === 401 || status === 403 || status === 451) kind = 'denied';
  else if (status === 408 || status === 429 || status >= 500) kind = status === 429 ? 'denied' : 'network';
  else if (/status code (404|410)\b/.test(message)) kind = 'expired';
  else if (/status code (401|403|451|429)\b/.test(message)) kind = 'denied';
  else if (/status code (408|5\d\d)\b/.test(message)) kind = 'network';
  else if (
    NETWORK_CODES.has(errno) ||
    /timeout|timed out|socket hang up|network|connect|aborted|不完整|中断|断开/i.test(message)
  )
    kind = 'network';

  const info = KINDS[kind];
  return {
    kind,
    label: info.label,
    text: info.text,
    retryHelps: info.retryHelps,
    detail: message.slice(0, 200),
  };
}

module.exports = { classifyDownloadError, KINDS, isAutoRetryable };
