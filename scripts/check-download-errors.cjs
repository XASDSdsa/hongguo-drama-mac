// 下载失败原因分类：资源缺失、网络失败、被拒绝、磁盘、解密，以及重试有没有用。
const assert = require('node:assert/strict');
const { classifyDownloadError } = require('../src/native/download-errors');

const cases = [
  [{ message: '未获取到有效播放地址' }, 'missing', false],
  [{ message: '第 8 集未开放' }, 'missing', false],
  [{ message: 'Request failed with status code 404' }, 'missing', false],
  [{ message: 'x', status: 410 }, 'missing', false],
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
assert.equal(classifyDownloadError({ message: '未获取到有效播放地址' }).label, '资源缺失');
assert.equal(classifyDownloadError({ code: 'ECONNRESET' }).label, '网络失败');
assert.ok(classifyDownloadError({ message: 'a'.repeat(1000) }).detail.length <= 200);
console.log(`PASS download error classification (${cases.length} cases)`);
