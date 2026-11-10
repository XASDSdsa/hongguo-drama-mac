'use strict';

// Private issuer. Run on the owner's computer, never inside a customer build.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPublicKey, generateKeyPairSync } = require('node:crypto');
const { issueLicense } = require('../src/native/license/signed-license.cjs');

const vault = path.join(os.homedir(), '.ai-drama-license');
const keyFile = path.join(vault, 'issuer.pem');

function readKey() {
  return fs.readFileSync(keyFile);
}

try {
  const [command, value, output] = process.argv.slice(2);
  if (command === 'init' && value) {
    fs.mkdirSync(vault, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(keyFile)) {
      const keys = generateKeyPairSync('ed25519');
      fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    }
    const publicKey = createPublicKey(readKey()).export({ type: 'spki', format: 'pem' });
    if (fs.existsSync(value)) {
      if (fs.readFileSync(value, 'utf8') !== publicKey) throw new Error('现有公钥与私钥不匹配，请保留原公钥并检查发证电脑。');
    } else fs.writeFileSync(value, publicKey, { flag: 'wx' });
    console.log('授权公钥已就绪。');
  } else if (command === 'issue' && value) {
    const code = value.trim().toUpperCase();
    const data = issueLicense(code, readKey());
    const target = output || path.join(os.homedir(), 'Downloads', `短剧授权-${code.slice(-8)}-${Date.now()}.json`);
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
    console.log(`授权文件已生成：${target}`);
  } else {
    throw new Error('用法：node license-admin.cjs issue 设备码 [输出路径]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
