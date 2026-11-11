'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
function verifyPlayerBundle(root = path.resolve(__dirname, '..')) {
  const directory = path.join(root, 'build/hongguo-player/win32-x64');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json')));
  assert.equal(manifest.sourceVersion, '0.11.1');
  for (const file of ['runtime/bin/java.exe', 'player.jar', 'LICENSE.hongguotv.txt', 'NOTICE.hongguotv.md']) {
    assert.ok(manifest.files.some(item => item.path === file), 'Missing player file ' + file);
  }
  for (const item of manifest.files) {
    assert.ok(!path.isAbsolute(item.path) && !item.path.split('/').includes('..'));
    const actual = createHash('sha256').update(fs.readFileSync(path.join(directory, item.path))).digest('hex');
    assert.equal(actual, item.sha256, item.path);
  }
  console.log('PASS bundled native player files and SHA256 manifest');
}
module.exports = { verifyPlayerBundle };
if (require.main === module) {
  verifyPlayerBundle();
  if (process.argv.includes('--live')) {
    require('../src/native/native-player').fetchNativePlayUrl('7696354284157291544').then(info => {
      assert.ok(info.url);
      assert.ok(Number.parseInt(info.quality) >= 720);
      console.log('PASS real Windows native resolver:', info.quality, info.codec);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
