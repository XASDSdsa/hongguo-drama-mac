const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(
    source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start,
    source.indexOf('\n}', start) + 2,
  );
}
const checks = [
  [
    'compatibility cache rechecks access before sharing or reusing results',
    async () => {
      const handlers = {};
      const context = {
        ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
        hongguo: {
          fetchEpisodeList: async () => ({ episodes: [{ vid: 'xifan:huabo:a:2', vid_index: 2, locked: true }] }),
        },
        compatPreparing: new Map([['cached', Promise.resolve({ success: true })]]),
        compatPathFor: () => 'cached',
        transcodeForPlayback: () => Promise.resolve({ success: true }),
      };
      const start = source.indexOf("ipcMain.handle('transcode-for-playback'");
      vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
      const result = await handlers['transcode-for-playback'](
        {},
        { seriesId: 'xifan:huabo:a', vidIndex: 2, vid: 'xifan:huabo:a:2', filePath: '/cached.mp4' },
      );
      assert.equal(result.success, false, 'locked episode must not reuse the in-flight/cache result');
      assert.match(result.error, /锁定/);
    },
  ],
  [
    'source URL accepts only the exact HTTPS origin',
    () => {
      const context = { URL, SEARCH_SITE: 'https://hongguoduanju.com' };
      vm.runInNewContext(extract('sourcePageUrl'), context);
      assert.equal(
        context.sourcePageUrl('https://hongguoduanju.com/category/comic'),
        'https://hongguoduanju.com/category/comic',
      );
      for (const value of [
        'https://hongguoduanju.com.evil.test/',
        'http://hongguoduanju.com/',
        'https://user@hongguoduanju.com/',
        'javascript:alert(1)',
      ])
        assert.throws(() => context.sourcePageUrl(value));
    },
  ],
  [
    'different sources and same-title Xifan series use different folders',
    () => {
      const context = { path, createHash, sanitizeFolderName: (value) => value };
      vm.runInNewContext(extract('seriesDownloadDir'), context);
      const resolve = context.seriesDownloadDir;
      assert.equal(resolve('/downloads', '123', '同名剧'), '/downloads/红果短剧/同名剧');
      const a = resolve('/downloads', 'xifan:huabo:a', '同名剧');
      assert.notEqual(a, resolve('/downloads', '123', '同名剧'));
      assert.notEqual(a, resolve('/downloads', 'xifan:huabo:b', '同名剧'));
    },
  ],
  [
    'queue rejects spoofed lock state before filesystem writes',
    async () => {
      const context = {
        hongguo: {
          fetchEpisodeList: async () => ({ episodes: [{ vid: 'xifan:huabo:a:2', vid_index: 2, locked: true }] }),
        },
      };
      vm.runInNewContext(extract('enqueueEpisodes'), context);
      await assert.rejects(
        async () =>
          context.enqueueEpisodes({
            seriesId: 'xifan:huabo:a',
            seriesTitle: 'test',
            episodes: [{ vid: 'xifan:huabo:a:2', vid_index: 2, locked: false }],
          }),
        /锁定/,
      );
    },
  ],
];
(async () => {
  let failures = 0;
  const selected = checks.filter(([name]) => !process.argv.includes('--compat') || name.startsWith('compatibility'));
  for (const [name, run] of selected) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  console.log(`${selected.length - failures}/${selected.length} checks passed`);
  process.exitCode = failures ? 1 : 0;
})();
