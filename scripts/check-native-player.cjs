'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const filename = path.resolve(__dirname, '../src/native/native-player.js');
const source = fs.readFileSync(filename, 'utf8');
const valid = { ok: true, vid: '123', url: 'https://v3-reading.qznovelvod.com/video.mp4', quality: '1080p', codec: 'bytevc1', contentKey: 'a'.repeat(32) };
function fixture(result, failure = null, exists = true) {
  const calls = [];
  const context = { module: { exports: {} }, __dirname: path.dirname(filename), URL,
    process: { platform: 'win32', arch: 'x64', resourcesPath: '/packaged', env: { JAVA_TOOL_OPTIONS: 'untrusted', _JAVA_OPTIONS: 'untrusted' } },
    require: name => name === 'node:fs' ? { existsSync: () => exists }
      : name === 'node:child_process' ? { execFile: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(failure, typeof result === 'string' ? result : JSON.stringify(result));
      } } : require(name),
  };
  vm.runInNewContext(source, context, { filename });
  return { fetch: context.module.exports.fetchNativePlayUrl, calls };
}
(async () => {
  const success = fixture(valid);
  const info = await success.fetch('123');
  assert.equal(info.codec, 'hevc');
  assert.equal(info.quality, '1080p');
  assert.equal(info.contentKey, valid.contentKey);
  assert.equal(success.calls[0].options.windowsHide, true);
  assert.ok(success.calls[0].options.timeout <= 60000);
  assert.equal(success.calls[0].options.env.JAVA_TOOL_OPTIONS, undefined);
  assert.equal(success.calls[0].options.env._JAVA_OPTIONS, undefined);
  assert.equal(success.calls[0].args.at(-1), '123');
  for (const response of [null, [], 'not JSON', { ...valid, vid: '456' }, { ...valid, url: 'file:///tmp/video' },
    { ...valid, url: 'https://qznovelvod.com.attacker.example/video' }, { ...valid, url: 'https://user:password@qznovelvod.com/video' },
    { ...valid, quality: '360p' }, { ...valid, codec: 'bytevc2' }, { ...valid, contentKey: 'secret' }]) {
    await assert.rejects(fixture(response).fetch('123'));
  }
  const invalid = fixture(valid);
  await assert.rejects(invalid.fetch('123;cmd.exe'));
  assert.equal(invalid.calls.length, 0);
  await assert.rejects(fixture(valid, null, false).fetch('123'), { code: 'PLAYER_COMPONENT_MISSING' });
  await assert.rejects(fixture('', { killed: true }).fetch('123'), { code: 'ETIMEDOUT' });
  await assert.rejects(fixture({ ok: false, error: '播放接口返回空响应', code: 'EMPTY_RESPONSE' }).fetch('123'), { code: 'EMPTY_RESPONSE' });
  console.log('PASS native player process, UTF-8 JSON boundaries, exact episode/URL/key/quality/codec validation, missing runtime and timeout');
})().catch(error => { console.error(error); process.exitCode = 1; });
