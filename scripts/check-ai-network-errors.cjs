// AI 接口的网络错误处理：断线自动重试一次、错误说人话、超时说清等了多久、用户取消不重试、可以换成 Electron 的 net.fetch。
const assert = require('node:assert/strict');
const openai = require('../src/native/openai');

const config = { ai_base_url: 'https://relay.example.com/v1', ai_api_key: 'sk-secret-key-123', ai_text_model: 'm' };
const ok = (content) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  body: new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(JSON.stringify({ choices: [{ message: { content } }] })));
      c.close();
    },
  }),
});
const failure = (message, code) => Object.assign(new TypeError(message), code ? { cause: { code } } : {});

const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout 的计时器不挡进程退出
(async () => {
  // 1. 连接被中途断开：自动再试一次就成功。
  let calls = 0;
  openai.setFetch(async () => {
    calls += 1;
    if (calls === 1) throw new Error('net::ERR_CONNECTION_RESET');
    return ok('好');
  });
  assert.equal(await openai.chat([{ role: 'user', content: 'x' }], {}, config), '好');
  assert.equal(calls, 2, '断线后应该自动重试一次');

  // 2. 连续断两次：只重试一次，然后给出看得懂的原因和地址，不泄露 Key。
  calls = 0;
  openai.setFetch(async () => {
    calls += 1;
    throw failure('fetch failed', 'ECONNRESET');
  });
  await assert.rejects(openai.chat([{ role: 'user', content: 'x' }], {}, config), (error) => {
    assert.equal(calls, 2);
    assert.match(error.message, /连不上 AI 接口（relay\.example\.com）/);
    assert.match(error.message, /中途断开/);
    assert.match(error.message, /ECONNRESET/);
    assert.doesNotMatch(error.message, /sk-secret/);
    return true;
  });

  // 3. 地址写错 / 代理连不上 / 证书问题：不重试，直接说原因。
  for (const [message, expected] of [
    ['net::ERR_NAME_NOT_RESOLVED', /域名解析失败/],
    ['net::ERR_PROXY_CONNECTION_FAILED', /代理连不上/],
    ['net::ERR_CERT_AUTHORITY_INVALID', /证书校验失败/],
  ]) {
    calls = 0;
    openai.setFetch(async () => {
      calls += 1;
      throw new Error(message);
    });
    await assert.rejects(openai.chat([{ role: 'user', content: 'x' }], {}, config), expected);
    assert.equal(calls, 1, `${message} 不应重试`);
  }

  // 4. 等太久：说明等了几分钟，不重试。
  calls = 0;
  openai.setFetch(async (_url, init) => {
    calls += 1;
    await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  await assert.rejects(
    openai.chat([{ role: 'user', content: 'x' }], { timeout: 60000 * 0.0005 }, config),
    /AI 接口等了 0 分钟还没返回结果/,
  );
  assert.equal(calls, 1);

  // 5. 用户点取消：原样抛出取消，不重试、不改写。
  calls = 0;
  const controller = new AbortController();
  openai.setFetch(async (_url, init) => {
    calls += 1;
    setTimeout(() => controller.abort(), 10);
    await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  await assert.rejects(
    openai.chat([{ role: 'user', content: 'x' }], { signal: controller.signal }, config),
    (error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    },
  );
  assert.equal(calls, 1);

  // 6. 恢复默认：用全局 fetch。
  openai.setFetch(null);
  let globalUsed = false;
  global.fetch = async () => {
    globalUsed = true;
    return ok('全局');
  };
  assert.equal(await openai.chat([{ role: 'user', content: 'x' }], {}, config), '全局');
  assert.ok(globalUsed);

  // 7. main.js 启动时把 AI 请求换成 Electron 的 net.fetch。
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /openai\.setFetch\(/);
  assert.match(main, /net\.fetch\(url, init\)/);
  clearInterval(keepAlive);
  console.log('AI network error checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
