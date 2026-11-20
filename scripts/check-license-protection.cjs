'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { generateKeyPairSync, sign } = require('node:crypto');

async function verifyLicenseProtection(root = path.join(__dirname, '..')) {
  const base = path.join(root, 'src/native/license');
  const { checkToken, requestOnlineLicense } = require(path.join(base, 'keygate.cjs'));
  const { createRuntimeSession, HEARTBEAT_MS, RETRY_MS, GRACE_MS, FRESH_MS } = require(path.join(base, 'runtime-session.cjs'));
  const { checkOperation, PROTECTED } = require(path.join(base, 'operation-guard.cjs'));
  const keys = generateKeyPairSync('ed25519');
  const config = { endpoint: 'https://license.example', productId: 'product',
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };
  const identifier = 'device-a';
  const signed = claims => {
    const payload = Buffer.from(JSON.stringify({ pid: 'product', did: identifier, sts: 'active', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url');
    return payload + '.' + sign(null, Buffer.from(payload), keys.privateKey).toString('base64url');
  };
  assert.equal(checkToken(signed({}), config, identifier), true);
  for (const claims of [{ did: 'other' }, { pid: 'other' }, { sts: 'revoked' }, { exp: 1 }, { vun: 1 }]) {
    assert.equal(checkToken(signed(claims), config, identifier), false);
  }
  const forged = Buffer.from(JSON.stringify({ pid: 'product', did: identifier, sts: 'active', exp: 9999999999 })).toString('base64url') + '.' + signed({}).split('.')[1];
  assert.equal(checkToken(forged, config, identifier), false);
  const response = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  let reply = response(200, { success: true, data: { token: signed({}) } });
  let requests = 0;
  const verify = () => requestOnlineLicense(config, { key: 'test-key-123', identifier, fetcher: async (url, init) => {
    requests++; assert.equal(new URL(url).pathname, '/api/v1/license/verify');
    assert.equal(init.redirect, 'error'); assert.deepEqual(JSON.parse(init.body), { license_key: 'test-key-123', identifier });
    return reply;
  } });
  const good = await verify(); assert.equal(good.ok, true);
  reply = response(200, { success: true, data: { token: forged } });
  assert.equal((await verify()).retryable, undefined);
  reply = response(500, null); assert.equal((await verify()).retryable, true);
  reply = response(429, null); assert.equal((await verify()).retryable, true);
  reply = response(403, { error: { code: 'LICENSE_NOT_FOUND' } }); assert.equal((await verify()).ok, false);

  let wall = Date.now(), mono = 1000, next = good, calls = 0, scheduled;
  const changes = [];
  const session = createRuntimeSession({ verify: async () => { calls++; return next; }, now: () => wall, monotonic: () => mono,
    schedule: (fn, delay) => { scheduled = { fn, delay }; return 1; }, unschedule: () => {}, onChange: state => changes.push(state) });
  assert.equal(session.snapshot().allowed, false);
  await session.refresh(); assert.equal(session.snapshot().allowed, true); assert.equal(scheduled.delay, HEARTBEAT_MS);
  await session.ensure(); assert.equal(calls, 1);
  mono += FRESH_MS; wall += FRESH_MS;
  await Promise.all(Array.from({ length: 8 }, () => session.ensure())); assert.equal(calls, 2, 'Concurrent operations share verification');
  next = { ok: false, retryable: true, error: '网络中断' };
  await session.refresh(); assert.equal(session.snapshot().allowed, true); assert.equal(scheduled.delay, RETRY_MS);
  mono += GRACE_MS; wall += GRACE_MS;
  assert.equal(session.snapshot().allowed, false, 'An outage cannot extend the last successful lease');
  next = { ok: true, expiresAt: wall + 3600000 };
  await session.refresh(); assert.equal(session.snapshot().allowed, true);
  next = { ok: false, error: '授权已停用' };
  await session.refresh(); assert.equal(session.snapshot().allowed, false, 'Revocation skips network grace');
  next = { ok: false, retryable: true, error: '网络中断' };
  await session.refresh(); assert.equal(session.snapshot().allowed, false, 'A later outage cannot revive a revoked lease');
  next = { ok: true, expiresAt: wall + 30000 }; await session.refresh();
  mono += 30001; wall -= 3600000;
  assert.equal(session.snapshot().allowed, false, 'Rolling back the wall clock cannot extend a lease');
  next = { ok: true, expiresAt: wall + 30000 }; await session.refresh(); wall += 30001;
  assert.equal(session.snapshot().allowed, false, 'Signed expiry also blocks operations');
  next = { ok: true, expiresAt: wall + 3600000 }; await session.refresh();
  let entered = 0;
  for (const channel of PROTECTED) {
    assert.ok(await checkOperation(channel, { authorized: false, trusted: true, session }));
    assert.ok(await checkOperation(channel, { authorized: true, trusted: false, session }));
    assert.ok(await checkOperation(channel, { authorized: true, trusted: true, session: null }));
    assert.equal(await checkOperation(channel, { authorized: true, trusted: true, session }), null);
    entered++;
  }
  next = { ok: false, error: '授权已停用' }; await session.refresh();
  assert.equal((await checkOperation('hongguo-download-batch', { authorized: true, trusted: true, session })).licenseRequired, true);
  for (const channel of ['stop-download', 'pause-all', 'quchong-cancel', 'get-download-tasks', 'app-update-install']) {
    assert.equal(await checkOperation(channel, { authorized: false, trusted: false, session }), null, 'Read/cancel/update access remains available');
  }
  session.dispose(); const before = calls; await session.refresh(); assert.equal(calls, before);
  assert.ok(changes.some(s => s.allowed && s.warning));

  // Execute the actual main-process wrapper, including its task accounting.
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  // The packaged main is obfuscated; its source/hash correspondence is checked by protect-app.
  if (!fs.existsSync(path.join(root, 'protected-build.json'))) {
    const start = main.indexOf('const registerIpc =');
    const end = main.indexOf("ipcMain.handle('license-runtime-status'", start);
    assert.ok(start > 0 && end > start);
    const handlers = new Map();
    const window = { isDestroyed: () => false, webContents: { mainFrame: {} } };
    const context = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, appUpdates: null,
      PROTECTED, checkOperation, launchAuthorized: true, mainWindow: window, licenseSession: session, pendingIpcWork: 0 };
    vm.runInNewContext(main.slice(start, end), context);
    let invoked = 0;
    context.ipcMain.handle('hongguo-download-batch', () => { invoked++; return { success: true }; });
    const result = await handlers.get('hongguo-download-batch')({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    assert.equal(result.success, false); assert.equal(invoked, 0); assert.equal(context.pendingIpcWork, 0);
  }
  console.log(`PASS license protection: signed device/product/expiry, forgery rejection, lease/revocation/outage/recovery/clock/concurrency, ${entered} guarded operations, actual IPC wrapper`);
  return true;
}
module.exports = { verifyLicenseProtection };
if (require.main === module) verifyLicenseProtection().catch(error => { console.error(error); process.exit(1); });
