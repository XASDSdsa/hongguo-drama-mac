'use strict';

const { createHash, createPublicKey, sign, verify } = require('node:crypto');

const MAX_LICENSE_BYTES = 8192;
const DEVICE_CODE = /^AD1-[A-F0-9]{64}$/;
const PRODUCT = 'io.github.jackotom.hongguo-drama-mac';

function deviceCode(platform, identifiers) {
  return 'AD1-' + createHash('sha256')
    .update(JSON.stringify([PRODUCT, platform, ...identifiers]))
    .digest('hex').toUpperCase();
}

function issueLicense(code, privateKey) {
  if (!DEVICE_CODE.test(code)) throw new Error('设备码格式不正确');
  if (createPublicKey(privateKey).asymmetricKeyType !== 'ed25519') throw new Error('发证私钥格式不正确');
  const payload = Buffer.from(JSON.stringify({ version: 1, product: PRODUCT, device: code }));
  return JSON.stringify({ payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') }) + '\n';
}

function verifyLicense(input, code, publicKey) {
  if (Buffer.byteLength(input) > MAX_LICENSE_BYTES) throw new Error('授权文件太大');
  try {
    const { payload, signature } = JSON.parse(input);
    if (typeof payload !== 'string' || typeof signature !== 'string') throw new Error();
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new Error();
    const bytes = Buffer.from(payload, 'base64url');
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(signature, 'base64url'))) throw new Error();
    const license = JSON.parse(bytes);
    if (license.version !== 1 || license.product !== PRODUCT || !DEVICE_CODE.test(license.device)) throw new Error();
    if (license.device !== code) return '这份授权属于另一台电脑';
    return '';
  } catch {
    return '授权文件签名无效';
  }
}

module.exports = { MAX_LICENSE_BYTES, deviceCode, issueLicense, verifyLicense };
