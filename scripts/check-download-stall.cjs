'use strict';
// 下载流半路停住（CDN 不再发数据）时，超过空闲时限就断开并按网络错误重试，不会一直卡在「下载中」。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { isAutoRetryable } = require('../src/native/download-errors');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('function watchStall(');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start > 0, 'watchStall must exist');
const watchStall = new Function(`${source.slice(start, end)}; return watchStall;`)();
assert.ok(source.includes('const stopWatch = watchStall(response.data);'), 'download pipeline must be watched');

(async () => {
  // 一直有数据：不断开。
  const busy = new PassThrough();
  const stopBusy = watchStall(busy, 120);
  const feeder = setInterval(() => busy.write('x'), 20);
  await new Promise((resolve) => setTimeout(resolve, 400));
  clearInterval(feeder);
  stopBusy();
  assert.equal(busy.destroyed, false);

  // 停住：超过空闲时限后断开，错误按网络中断处理（会自动重试）。
  const stalled = new PassThrough();
  const errors = [];
  stalled.on('error', (error) => errors.push(error));
  stalled.write('x');
  const stop = watchStall(stalled, 50);
  await new Promise((resolve) => setTimeout(resolve, 5300));
  stop();
  assert.equal(stalled.destroyed, true);
  assert.match(errors[0]?.message || '', /网络中断/);
  assert.equal(isAutoRetryable({ message: errors[0].message }), true);
  console.log('PASS a stalled download stream is cut after the idle limit and retried as a network error');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
