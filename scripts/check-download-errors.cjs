// 下载失败原因分类：资源缺失、网络失败、被拒绝、磁盘、解密，以及重试有没有用。
const assert = require('node:assert/strict');
const { classifyDownloadError, isAutoRetryable } = require('../src/native/download-errors');

const cases = [
  // 平台明确说没有 / 未开放 / 锁定，才是资源缺失
  [{ message: '第 8 集未开放' }, 'missing', false],
  [{ message: '来源未开放该集' }, 'missing', false],
  [{ message: '第 3 集当前锁定，请在西饭官方 App 确认可看范围' }, 'missing', false],
  [{ message: '官网网页当前仅提供前 5 集，第 6 集暂无可用播放地址；请在官方 App 确认可播情况。' }, 'missing', false],
  [{ message: '西饭未找到该分集' }, 'missing', false],
  // 取不到播放地址、下载链接 404/410 都可能是链接过期或节点临时没有，换新链接常常就能下：不是资源缺失
  [{ message: '未获取到有效播放地址' }, 'other', true],
  [{ message: '官网与备用接口均未提供有效播放地址，请稍后重试' }, 'other', true],
  [{ message: 'Request failed with status code 404' }, 'expired', true],
  [{ message: 'x', status: 410 }, 'expired', true],
  [{ message: 'socket hang up', code: 'ECONNRESET' }, 'network', true],
  [{ message: 'connect ETIMEDOUT 1.2.3.4:443' }, 'network', true],
  [{ message: '下载不完整：已收到 10MB，预期 20MB' }, 'network', true],
  [{ message: 'Request failed with status code 503' }, 'network', true],
  [{ message: 'x', status: 502 }, 'network', true],
  [{ message: 'Request failed with status code 403' }, 'denied', true],
  [{ message: 'x', status: 429 }, 'denied', true],
  [{ message: 'ENOSPC: no space left on device, write' }, 'disk', true],
  [{ message: 'x', code: 'EACCES' }, 'disk', true],
  [{ message: 'Key 派生失败' }, 'decrypt', true],
  [{ message: '莫名其妙的错误' }, 'other', true],
  ['plain string timeout', 'network', true],
  [undefined, 'other', true],
];
for (const [input, kind, retryHelps] of cases) {
  const result = classifyDownloadError(input);
  assert.equal(result.kind, kind, JSON.stringify(input));
  assert.equal(result.retryHelps, retryHelps, JSON.stringify(input));
  assert.ok(result.label && result.text, 'every kind has a label and an explanation');
}
assert.equal(classifyDownloadError({ message: '第 8 集未开放' }).label, '资源缺失');
assert.equal(classifyDownloadError({ status: 404 }).label, '链接失效');
// 磁盘错误、平台明确没有的不自动重试，其余都让程序自己换新链接再试
assert.equal(isAutoRetryable({ status: 404 }), true);
assert.equal(isAutoRetryable({ message: '网络失败 ECONNRESET' }), true);
assert.equal(isAutoRetryable({ message: '未获取到有效播放地址' }), true);
assert.equal(isAutoRetryable({ message: '第 8 集未开放' }), false);
assert.equal(isAutoRetryable({ message: 'ENOSPC: no space left' }), false);
assert.equal(classifyDownloadError({ code: 'ECONNRESET' }).label, '网络失败');
assert.ok(classifyDownloadError({ message: 'a'.repeat(1000) }).detail.length <= 200);
console.log(`PASS download error classification (${cases.length} cases)`);
