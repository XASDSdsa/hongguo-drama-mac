'use strict';

const { createPublicKey, verify } = require('node:crypto');

const ERRORS = {
  ACTIVATION_LIMIT: '这枚激活码已经绑定另一台电脑，请联系管理员解绑。',
  LICENSE_NOT_FOUND: '授权无效、已停用，或尚未绑定这台电脑。',
  LICENSE_EXPIRED: '授权已到期，请联系管理员续期。',
  RATE_LIMITED: '请求太频繁，请稍后再试。',
};

function checkToken(token, config, identifier, now = Date.now() / 1000) {
  const parts = typeof token === 'string' && token.length <= 16384 ? token.split('.') : [];
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const [payload, signature] = parts;
    const key = createPublicKey({
      format: 'der',
      type: 'spki',
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(config.publicKey, 'hex')]),
    });
    if (!verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    return claims.pid === config.productId && claims.did === identifier
      && ['active', 'trialing'].includes(claims.sts)
      && Number.isFinite(claims.exp) && claims.exp > now
      && (claims.vun == null || claims.vun === 0 || claims.vun > now);
  } catch {
    return false;
  }
}

async function checkOnlineLicense(config, { key, identifier, activate = false, fetcher = fetch }) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,160}$/.test(key)) return '请输入完整的激活码。';
  const body = { license_key: key, identifier };
  if (activate) body.identifier_type = 'device';
  let response, result;
  try {
    response = await fetcher(new URL('/api/v1/license/' + (activate ? 'activate' : 'verify'), config.endpoint), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    result = await response.json();
  } catch {
    return '暂时连不上授权服务器，请检查网络后重试。';
  }
  if (!response.ok || result?.success !== true) {
    return ERRORS[result?.error?.code] || (response.status >= 500 ? '授权服务器暂不可用，请稍后再试。' : '激活码无法使用，请联系管理员。');
  }
  return checkToken(result.data?.token, config, identifier) ? '' : '授权签名或设备信息不匹配。';
}

module.exports = { checkOnlineLicense, checkToken };
