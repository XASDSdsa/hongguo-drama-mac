'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { generateKeyPairSync, sign } = require('node:crypto');

async function verifyOnlineStartup(root = path.join(__dirname, '..')) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'online-startup-'));
  const base = path.join(root, 'src/native/license');
  const localRequire = createRequire(path.join(base, 'online-startup.cjs'));
  const pair = generateKeyPairSync('ed25519');
  const config = { endpoint: 'https://license.example', productId: 'product',
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };
  const payload = Buffer.from(JSON.stringify({ pid: 'product', did: 'device-a', sts: 'active', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const token = payload + '.' + sign(null, Buffer.from(payload), pair.privateKey).toString('base64url');
  let deny = false, input = '', sessions = [], windows = 0, loadError = null;
  const requests = [], handlers = new Map();
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = { mainFrame: {}, setWindowOpenHandler: () => {}, on: () => {} }; this.dead = false; windows++; }
    isDestroyed() { return this.dead; }
    show() {}
    destroy() { this.dead = true; this.emit('closed'); }
    async loadFile() {
      if (loadError) throw loadError;
      setImmediate(async () => {
        this.emit('ready-to-show');
        if (input) {
          const result = await handlers.get('online-license:activate')({ sender: this.webContents, senderFrame: this.webContents.mainFrame }, input);
          assert.equal(result, '');
        } else this.destroy();
      });
    }
  }
  const electron = { BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: key => Buffer.from('safe:' + key), decryptString: bytes => {
      assert.ok(bytes.toString().startsWith('safe:')); return bytes.toString().slice(5);
    } }, net: { fetch: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return { status: deny ? 403 : 200, ok: !deny, json: async () => deny ? { success: false, error: { code: 'LICENSE_NOT_FOUND' } } : { success: true, data: { token } } };
    } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'online-startup.cjs'), 'utf8'), {
    module, exports: module.exports, __dirname: base, Buffer, setImmediate,
    require: name => name === 'electron' ? electron : localRequire(name),
  });
  const start = () => module.exports.authorizeOnlineStartup({ app: { getPath: () => temporary }, config, identifier: 'device-a',
    onAuthorized: session => sessions.push(session) });
  try {
    assert.equal(await start(), false, 'Closing activation cannot open the app');
    assert.equal(handlers.size, 0);
    input = 'valid-key-123';
    assert.equal(await start(), true);
    assert.equal(requests.at(-1).body.identifier_type, 'device');
    assert.ok(requests.at(-1).url.endsWith('/activate'));
    assert.equal(fs.readFileSync(path.join(temporary, 'online-license.key'), 'utf8'), 'safe:valid-key-123');
    assert.equal(sessions.at(-1).snapshot().allowed, true);
    const count = windows; input = '';
    assert.equal(await start(), true, 'Saved activation is verified online and reused');
    assert.equal(windows, count); assert.ok(requests.at(-1).url.endsWith('/verify'));
    deny = true;
    assert.equal((await sessions.at(-1).refresh()).allowed, false, 'The real startup-created session observes revocation');
    assert.equal(await start(), false, 'Revoked saved key cannot reach the main app');
    loadError = new Error('load failed');
    await assert.rejects(start(), /load failed/);
    assert.equal(handlers.size, 0);
    console.log('PASS online startup: activation/cancel, safeStorage persistence, saved-key online verification, runtime revocation, load failure cleanup');
    return true;
  } finally {
    sessions.forEach(session => session.dispose());
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
module.exports = { verifyOnlineStartup };
if (require.main === module) verifyOnlineStartup().catch(error => { console.error(error); process.exit(1); });
