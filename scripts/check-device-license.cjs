'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { generateKeyPairSync } = require('node:crypto');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-drama-license-'));
  try {
    for (const name of ['startup.cjs', 'signed-license.cjs']) {
      await fs.copyFile(path.join(__dirname, '../src/native/license', name), path.join(temp, name));
    }
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    await fs.writeFile(path.join(temp, 'public-key.pem'), publicKey);
    const { authorizeStartup, readDeviceCode } = require(path.join(temp, 'startup.cjs'));
    const { issueLicense, deviceCode, verifyLicense } = require(path.join(temp, 'signed-license.cjs'));
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const uuid = 'bbbbbbbb-1111-2222-3333-444444444444';
    const codeA = await readDeviceCode('win32', async () => ({ stdout: guid + '\r\n' + uuid.toUpperCase() + '\r\n' }));
    assert.equal(codeA, deviceCode('win32', [guid, uuid]));
    const codeB = deviceCode('win32', [guid, 'other motherboard']);
    assert.notEqual(codeA, codeB);
    await assert.rejects(readDeviceCode('win32', async () => ({ stdout: '' })), /设备标识/);

    const license = issueLicense(codeA, keys.privateKey);
    const tampered = JSON.parse(license);
    const payload = JSON.parse(Buffer.from(tampered.payload, 'base64url'));
    tampered.payload = Buffer.from(JSON.stringify({ ...payload, device: codeB })).toString('base64url');
    assert.match(verifyLicense(JSON.stringify(tampered), codeB, publicKey), /签名无效/);
    assert.match(verifyLicense(issueLicense(codeA, generateKeyPairSync('ed25519').privateKey), codeA, publicKey), /签名无效/);

    const file = path.join(temp, 'issued.json');
    await fs.writeFile(file, license);
    const clientA = path.join(temp, 'device-a');
    const clientB = path.join(temp, 'device-b');
    const start = (dir, code, dialog, clipboard) => authorizeStartup({
      app: { isPackaged: true, getPath: () => dir },
      getDeviceCode: async () => code,
      dialog, clipboard,
    });

    let prompts = 0;
    let copied = '';
    assert.equal(await start(clientA, codeA, {
      showMessageBox: async () => ({ response: prompts++ === 0 ? 1 : 0 }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [file] }),
    }, { writeText: (value) => { copied = value; } }), true);
    assert.equal(copied, codeA);
    assert.equal(await start(clientA, codeA, {
      showMessageBox: () => assert.fail('合法授权下次启动不需要弹窗'),
    }), true);

    await fs.cp(clientA, clientB, { recursive: true });
    assert.equal(await start(clientB, codeB, {
      showMessageBox: async (options) => {
        assert.match(options.message, /属于另一台电脑/);
        return { response: 2 };
      },
    }), false);
    await fs.rm(path.join(temp, 'public-key.pem'));
    assert.equal(await start(clientA, codeA, {
      showMessageBox: async (options) => {
        assert.equal(options.message, '无法验证本机授权');
        return { response: 0 };
      },
    }), false);
    console.log('PASS license: import, offline restart, copied profile rejected, forged signatures rejected, missing key blocks startup');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
