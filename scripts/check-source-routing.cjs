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
        AbortController,
        randomUUID: require('node:crypto').randomUUID,
        hongguo: {
          fetchEpisodeList: async () => ({ episodes: [{ vid: 'xifan:huabo:a:2', vid_index: 2, locked: true }] }),
        },
        compatPreparing: new Map(),
        compatRequests: new Map(),
        compatClearing: null,
        compatCancelled: () => ({ success: false, cancelled: true }),
        compatPathFor: () => 'cached',
      };
      // 锁定判断位于转码任务本身：即使磁盘上已有缓存路径，也必须先复查来源权限。
      vm.runInNewContext(extract('transcodeForPlayback'), context);
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
    'downloads go straight into the configured download directory for every source',
    () => {
      const make = (root) => {
        const context = {
          path,
          app: { getPath: () => '/system/downloads' },
          getCurrentSettings: () => ({ root }),
        };
        vm.runInNewContext(extract('downloadRoot'), context);
        return context.downloadRoot();
      };
      assert.equal(make('/downloads'), path.resolve('/downloads'));
      assert.equal(make('  /my/videos  '), path.resolve('/my/videos'));
      assert.equal(make(''), path.resolve('/system/downloads'));
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
