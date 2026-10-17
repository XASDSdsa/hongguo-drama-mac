const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nativeDir = path.join(__dirname, '../src/native');

// Published SM3 vectors plus a long input cross-checked with Node 22/OpenSSL.
const vectors = [
  ['abc', '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0'],
  ['abcd'.repeat(16), 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732'],
  ['x'.repeat(10000), '335de0cbf893f7af9a3e548067c72f47630b9fa9293d93959c79c2085fab7e5e'],
];
const keyHex = '0123456789abcdef0123456789abcdef';
function encodedKey() {
  const plain = Buffer.from(`0${keyHex}`);
  const raw = Buffer.alloc(34);
  const previous = [246, 85];
  for (let i = 0; i < plain.length; i++) {
    const pop = i.toString(2).split('1').length - 1;
    raw[i + 1] = ((plain[i] + 21 + pop) & 255) ^ previous[i & 1];
    previous[i & 1] = raw[i + 1];
  }
  raw[0] = 48 ^ raw[1] ^ raw[2];
  return raw.toString('base64');
}
function fixture({
  wrongVid = false,
  fallback = 'https://vod.snssdk.com/info',
  media = 'https://v3-reading.qznovelvod.com/video.mp4',
  redirect = '',
  malformedKey = false,
} = {}) {
  const calls = [];
  const seed = Buffer.alloc(16, 7);
  const constants = Buffer.from(
    '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58',
    'hex',
  );
  const material = crypto
    .createHash('sha512')
    .update(Buffer.concat([crypto.createHash('sha512').update(seed).digest(), constants]))
    .digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const encryptedUrl = Buffer.concat([Buffer.from([0xa8, 0, 1, 0]), cipher.update(media), cipher.final()]).toString(
    'base64',
  );
  const axios = async (config) => {
    calls.push(config);
    assert.equal(config.maxRedirects, 0);
    assert.ok(config.timeout > 0 && config.timeout <= 12000);
    assert.ok(config.signal);
    if (calls.length === 1) {
      assert.ok(config.headers['x-medusa']);
      assert.ok(config.headers['x-gorgon']);
      const model = { video_model: JSON.stringify({ fallback_api: fallback }) };
      return {
        status: 200,
        headers: {},
        data: JSON.stringify({ code: 0, data: { 999: model, ...(wrongVid ? {} : { 11: model }) } }),
      };
    }
    if (redirect) return { status: 302, headers: { location: redirect }, data: '' };
    return {
      status: 200,
      headers: {},
      data: JSON.stringify({
        video_info: {
          data: {
            key_seed: seed.toString('base64'),
            video_list: {
              bad: { main_url: media, codec_type: 'bytevc2', quality_desc: '2160P', spade_a: encodedKey() },
              good: {
                main_url: encryptedUrl,
                codec_type: 'h264',
                quality_desc: '720P',
                spade_a: malformedKey ? 'bad' : encodedKey(),
              },
            },
          },
        },
      }),
    };
  };
  const context = {
    Buffer,
    URL,
    URLSearchParams,
    AbortSignal,
    module: { exports: {} },
    require: (name) => {
      if (name === 'axios') return axios;
      if (name === './sm3') return require(path.join(nativeDir, 'sm3'));
      if (name === 'node:crypto')
        return {
          ...crypto,
          createHash(name, ...args) {
            assert.notEqual(name.toLowerCase(), 'sm3', 'must not depend on OpenSSL SM3');
            return crypto.createHash(name, ...args);
          },
        };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, 'app-source.js'), 'utf8'), context);
  return { fetch: context.module.exports.fetchAppPlayUrl, calls };
}

const checks = [
  [
    'pure JS SM3 vectors',
    async () => {
      assert.ok(fs.existsSync(path.join(nativeDir, 'sm3.js')), 'pure JS SM3 missing');
      const sm3 = require(path.join(nativeDir, 'sm3'));
      for (const [input, expected] of vectors) {
        assert.equal(sm3(input).toString('hex'), expected);
        if (crypto.getHashes().includes('sm3'))
          assert.equal(sm3(input).toString('hex'), crypto.createHash('sm3').update(input).digest('hex'));
      }
    },
  ],
  [
    'signed exact-episode model, fallback and compatible media',
    async () => {
      assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
      const { fetch, calls } = fixture();
      const result = await fetch('11');
      assert.equal(result.source, 'app');
      assert.equal(result.contentKey, keyHex);
      assert.equal(result.codec, 'h264');
      assert.equal(result.quality, '720P');
      assert.equal(calls.length, 2);
    },
  ],
  [
    'no wrong-episode fallback',
    async () => {
      assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
      const { fetch, calls } = fixture({ wrongVid: true });
      await assert.rejects(fetch('11'));
      assert.equal(calls.length, 1);
    },
  ],
  [
    'URL boundary and redirect validation',
    async () => {
      assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
      for (const fallback of [
        'http://vod.snssdk.com/info',
        'https://127.0.0.1/info',
        'https://vod.snssdk.com.attacker.test/info',
        'https://user:pass@vod.snssdk.com/info',
      ]) {
        const { fetch, calls } = fixture({ fallback });
        await assert.rejects(fetch('11'));
        assert.equal(calls.length, 1);
      }
      const { fetch, calls } = fixture({ redirect: 'https://127.0.0.1/private' });
      await assert.rejects(fetch('11'));
      assert.equal(calls.length, 2);
      await assert.rejects(fixture({ media: 'https://127.0.0.1/video' }).fetch('11'));
    },
  ],
  [
    'invalid input and invalid key rejected',
    async () => {
      assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
      const { fetch, calls } = fixture();
      await assert.rejects(fetch('../11'));
      assert.equal(calls.length, 0);
      await assert.rejects(fixture({ malformedKey: true }).fetch('11'));
    },
  ],
];
(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  console.log(
    `${checks.length - failed}/${checks.length} passed; Node ${process.versions.node}; OpenSSL SM3=${crypto.getHashes().includes('sm3')}`,
  );
  process.exitCode = failed ? 1 : 0;
})();
