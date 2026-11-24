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
  inline = null,
  emptyResponses = 0,
  modelStatus = 200,
  fallbackModel = null,
  retryAfter = '',
  modelCode = 0,
} = {}) {
  const calls = [];
  const registrations = [];
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
    if (new URL(config.url).pathname.includes('video_model')) {
      assert.ok(config.headers['x-medusa']);
      assert.ok(config.headers['x-helios']);
      assert.equal(new URL(config.url).searchParams.get('device_id'), registrations.at(-1));
      if (config.method === 'GET') {
        const url = new URL(config.url);
        assert.equal(url.pathname, '/reading/bookapi/video_tab/multi_video_model/v1/');
        assert.equal(url.hostname, 'api5-normal-sinfonlineb.fqnovel.com');
        assert.equal(url.searchParams.get('video_id'), '11');
        assert.equal(url.searchParams.get('version_code'), '74332');
        assert.equal(config.headers['x-gorgon'], undefined);
        assert.equal(config.headers['x-ss-stub'], undefined);
        assert.equal(config.headers['Content-Type'], undefined);
        assert.equal(config.data, null);
      } else {
        const url = new URL(config.url);
        const preload = url.pathname.endsWith('/preload/v1');
        const single = url.pathname.includes('/player/video_model/');
        assert.ok(preload || single || url.pathname.endsWith('/player/v1'));
        if (preload) {
          assert.equal(url.hostname, 'reading.snssdk.com');
          assert.equal(url.searchParams.get('version_code'), '74532');
          assert.equal(config.headers['User-Agent'], 'okhttp/4.12.0');
        }
        assert.equal(config.method, 'POST');
        assert.equal(config.headers['Content-Encoding'], 'gzip');
        const sent = JSON.parse(require('node:zlib').gunzipSync(config.data));
        if (single) { assert.equal(sent.video_id, '11'); assert.equal(sent.content_type, 1004); }
        else {
          assert.deepEqual(sent.mixed_video_id_map, {1004:['11']});
          assert.equal(sent.dr_scene, preload ? 'preload' : 'player');
        }
        assert.equal(sent.biz_param.device_level, preload ? 2 : single ? 3 : 1);
        assert.equal(sent.biz_param.need_all_video_definition, true);
        assert.equal(config.headers['x-ss-stub'], crypto.createHash('md5').update(config.data).digest('hex').toUpperCase());
      }
      if (calls.length <= emptyResponses) return { status: 200, headers: { 'retry-after': retryAfter }, data: '' };
      const model = { video_model: JSON.stringify(inline || { fallback_api: fallback }) };
      const entries = {999:model,...(wrongVid ? {} : {11:model})};
      return {
        status: modelStatus,
        headers: {},
        data: JSON.stringify({ code: modelCode, data: config.method === 'GET' ? {video_model_data: entries} : {1004: entries} }),
      };
    }
    if (redirect) return { status: 302, headers: { location: redirect }, data: '' };
    return {
      status: 200,
      headers: {},
      data: JSON.stringify({
        video_info: {
          data: fallbackModel || {
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
    setTimeout,
    module: { exports: {} },
    require: (name) => {
      if (name === 'axios') return axios;
      if (name === 'node:zlib') return require(name);
      if (name === './playback-v5') return require(path.join(nativeDir, 'playback-v5'));
      if (name === './sm3') return require(path.join(nativeDir, 'sm3'));
      if (name === './playback-device') return {
        registerPlaybackDevice: async () => {
          const device_id = String(100 + registrations.length);
          registrations.push(device_id);
          return { device_id, iid: '1010', cdid: 'fixture' };
        },
      };
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
  return { fetch: context.module.exports.fetchAppPlayUrl, calls, registrations };
}

const inlineRow = {
  codec_type: 'hevc', vwidth: 1080, vheight: 1920, quality_desc: '1080p', encrypt: false,
  main_url: 'https://qznovelvod.com/episode.mp4',
};
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
    'empty current-app preload retries once then uses same-identity v5 video_tab and remembers success',
    async () => {
      const { fetch, calls, registrations } = fixture({ emptyResponses: 2, inline: { video_list: [inlineRow] } });
      assert.equal((await fetch('11')).url, inlineRow.main_url);
      assert.equal(calls.length, 3);
      assert.equal(calls[2].method, 'GET');
      assert.equal(calls[2].signal, calls[0].signal);
      for (const key of ['device_id', 'iid', 'cdid']) {
        assert.equal(new URL(calls[2].url).searchParams.get(key), new URL(calls[0].url).searchParams.get(key));
      }
      assert.equal(registrations.length, 1);
      assert.equal((await fetch('11')).sourceRoute, 'video_tab');
      assert.equal(calls.length, 4);
      assert.equal(calls[3].method, 'GET');
    },
  ],
  [
    'failed recovery preserves the empty error and never accepts another episode',
    async () => {
      const empty = fixture({emptyResponses:12});
      await assert.rejects(empty.fetch('11'), {code:'EMPTY_RESPONSE'});
      assert.equal(empty.calls.length,12);
      assert.equal(empty.registrations.length,1);
      const wrong = fixture({emptyResponses:2,wrongVid:true});
      await assert.rejects(wrong.fetch('11'), /未返回所选分集/);
      assert.equal(wrong.calls.length,3);
      assert.equal(wrong.registrations.length,1);
    },
  ],
  [
    'backoff and business refusal stop recovery immediately',
    async () => {
      const busy = fixture({emptyResponses:1,retryAfter:'30'});
      await assert.rejects(busy.fetch('11'), {code:'UPSTREAM_BACKOFF',backoff:true});
      assert.equal(busy.calls.length,1);
      const rejected = fixture({modelCode:101113});
      await assert.rejects(rejected.fetch('11'), {code:'BUSINESS_REJECTED'});
      assert.equal(rejected.calls.length,1);
      const tab = fixture({emptyResponses:2,modelCode:101113});
      await assert.rejects(tab.fetch('11'), {code:'BUSINESS_REJECTED'});
      assert.equal(tab.calls.length,3);
    },
  ],
  [
    'inline object models are parsed without requesting a fallback URL',
    async () => {
      const { fetch, calls } = fixture({ inline: { video_list: { video_1: inlineRow } } });
      assert.equal((await fetch('11')).url, inlineRow.main_url);
      assert.equal(calls.length, 1);
    },
  ],
  [
    'inline backup URLs survive missing or unsafe primary URLs and are deduplicated',
    async () => {
      const backup = 'https://fqnovelvod.com/episode.mp4';
      for (const main_url of [undefined, 'https://127.0.0.1/unsafe']) {
        const row = { ...inlineRow, main_url, backup_url: backup, backup_url_list: [backup, inlineRow.main_url] };
        const { fetch, calls } = fixture({ inline: { video_list: [row] } });
        const result = await fetch('11');
        assert.equal(result.url, backup);
        assert.equal(JSON.stringify(result.backupUrls), JSON.stringify([inlineRow.main_url]));
        assert.equal(calls.length, 1);
      }
    },
  ],
  [
    'explicit App refusal never tries an alternate host',
    async () => {
      for (const modelStatus of [403, 429]) {
        const { fetch, calls } = fixture({ modelStatus });
        await assert.rejects(fetch('11'), { status: modelStatus });
        assert.equal(calls.length, 1);
      }
    },
  ],
  [
    'inline fallback requires the same episode, duration, and minimum resolution',
    async () => {
      const metadata = { video_id: 'same', video_duration: 61.5 };
      const inline = { ...metadata, fallback_api: 'https://vod.snssdk.com/info',
        video_list: [{ ...inlineRow, encrypt: undefined }] };
      const fallbackModel = { ...metadata, video_list: [inlineRow] };
      const { fetch, calls } = fixture({ inline, fallbackModel });
      assert.equal((await fetch('11')).url, inlineRow.main_url);
      assert.equal(calls.length, 2);
      for (const mismatch of [
        { video_id: 'wrong' },
        { video_duration: 10 },
        { video_list: [{ ...inlineRow, vwidth: 360, vheight: 640 }] },
        { video_list: [{ ...inlineRow, encrypt: true }] },
      ]) {
        const f = fixture({ inline, fallbackModel: { ...fallbackModel, ...mismatch } });
        await assert.rejects(f.fetch('11'));
        assert.equal(f.calls.length, 2);
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
