// Offline aggregation checks; no Electron, network, or app data.
const assert = require('node:assert/strict');

const task = (id, seriesId, index, status = 'completed', extra = {}) => ({
  id, status, startTime: 10, hongguoInfo: { series_id: seriesId, vid_index: index, vid: `video-${index}`, series_title: '同名短剧' }, ...extra,
});

(async () => {
  const { downloadSeriesKey, groupDownloadSeries: group } = await import('../src/components/downloadSeries.mjs');
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

  check('same-title series from different sources remain separate', () => {
    const cards = group([task('a', '123', 1), task('b', 'xifan:123', 1)], []);
    assert.equal(cards.length, 2);
    assert.deepEqual(new Set(cards.map(card => card.seriesId)), new Set(['123', 'xifan:123']));
    assert.ok(cards.every(card => card.title === '同名短剧' && card.completed === 1 && card.total === null));
  });

  check('duplicate episode records count once and successful output wins', () => {
    const cards = group([
      task('old', 'A', 1, 'completed'), task('new', 'A', '1', 'failed', { startTime: 20 }),
      task('wait', 'A', 2, 'pending'), task('running', 'A', 2, 'downloading'),
      task('failed', 'A', 3, 'failed'), task('stopped', 'A', 3, 'stopped'),
    ], [{ series_id: 'A', total: 2 }]);
    assert.equal(cards[0].count, 3);
    assert.equal(cards[0].total, 3);
    assert.equal(cards[0].completed, 1);
    assert.equal(cards[0].downloading, 1);
    assert.equal(cards[0].failed, 1);
    assert.equal(cards[0].pending, 0);
    assert.equal(cards[0].stopped, 0);
  });

  check('episode identity falls back to video ID then task ID', () => {
    const tasks = [
      task('a', 'A', 0), task('b', 'A', -1), task('c', 'A', 1.5),
      task('d', 'A', null), task('e', 'A', undefined),
    ];
    tasks[0].hongguoInfo.vid = tasks[1].hongguoInfo.vid = 'same-video';
    tasks[2].hongguoInfo.vid = tasks[3].hongguoInfo.vid = tasks[4].hongguoInfo.vid = '';
    assert.equal(group(tasks, [])[0].count, 4);
  });

  check('registry enriches metadata but browsing alone creates no card', () => {
    const cards = group([task('a', 'A', 1)], [
      { series_id: 'A', series_title: '完整剧名', cover: 'cover.jpg', episodes: [{ vid_index: 1 }, { vid_index: '1' }, { vid_index: 2 }] },
      { series_id: 'B', series_title: '只浏览过', total: 80 },
    ]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, '完整剧名');
    assert.equal(cards[0].cover, 'cover.jpg');
    assert.equal(cards[0].total, 2);
    assert.equal(group([], [{ series_id: 'A', total: 80 }]).length, 0);
  });

  check('legacy tasks without series IDs stay reachable and use metadata fallbacks', () => {
    const cards = group([
      { id: 'a', title: '旧视频', status: 'completed', startTime: 30 },
      { id: 'b', status: 'failed', videoInfo: { author: '旧作者', cover: 'old.jpg' }, hongguoInfo: { series_id: ' ' } },
      { id: 'c', status: 'pending', batchInfo: { avatar: 'avatar.jpg' } },
    ], []);
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map(card => card.seriesId), [null, null, null]);
    assert.deepEqual(cards.map(card => card.title), ['旧视频', '旧作者', '未命名短剧']);
    assert.deepEqual(cards.map(card => card.cover), ['', 'old.jpg', 'avatar.jpg']);
    assert.ok(cards.every(card => card.total === null && card.count === 1));
    assert.equal(downloadSeriesKey({ id: 'a', hongguoInfo: { series_id: 0 } }), 'series:0');
  });

  check('unknown totals stay unknown instead of claiming all episodes downloaded', () => {
    assert.equal(group([task('a', 'A', 1)], [])[0].total, null);
    assert.equal(group([task('a', 'A', 1)], [{ series_id: 'A' }])[0].total, null);
    assert.equal(group([task('a', 'A', 1)], [{ series_id: 'A', total: 80 }])[0].total, 80);
  });

  check('progress never reorders cards but statuses update their counts', () => {
    const tasks = [task('a', 'A', 1, 'pending'), task('b', 'B', 1, 'completed', { startTime: 20 })];
    const before = group(tasks, []);
    const after = group(tasks.map(item => item.id === 'a' ? { ...item, status: 'completed', progress: 100, endTime: 9999 } : item), []);
    assert.deepEqual(after.map(card => card.key), before.map(card => card.key));
    assert.equal(before[1].pending, 1);
    assert.equal(after[1].pending, 0);
    assert.equal(after[1].completed, 1);
    assert.equal(after[1].updatedAt, 10);
  });

  check('aggregation preserves inputs and breaks equal-time ties by key', () => {
    const tasks = [task('b', 'B', 1), task('a', 'A', 1)];
    const registry = [{ series_id: 'A', total: 2, episodes: [{ vid_index: 1 }] }];
    const snapshot = JSON.stringify({ tasks, registry });
    const cards = group(tasks, registry);
    assert.deepEqual(cards.map(card => card.key), ['series:A', 'series:B']);
    assert.equal(JSON.stringify({ tasks, registry }), snapshot);
    assert.ok(cards.every(card => !Object.hasOwn(card, 'episodes')));
    assert.deepEqual(group(tasks, registry), cards);
  });
  console.log(`Download series: ${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
