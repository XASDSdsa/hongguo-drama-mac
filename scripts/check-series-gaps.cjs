// 缺集判定：平台无此集 / 已锁定 默认直接拼；没下载 / 下载中 / 失败 / 不确定 要用户决定。
const assert = require('node:assert/strict');
const gaps = require('../src/native/series-gaps');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL ' + name + ': ' + e.message);
  }
}
const remote = [1, 2, 3, 4, 5, 7, 8, 9, 10].map((n) => ({ vid_index: n, locked: n === 9 }));

check('each missing episode gets its own reason', () => {
  const missing = gaps.classifyMissing({
    onDisk: new Set([1, 2]),
    remote,
    tasks: new Map([
      [4, 'active'],
      [5, 'failed'],
    ]),
    upTo: 10,
  });
  assert.deepEqual(
    missing.map((item) => [item.index, item.state]),
    [
      [3, 'notDownloaded'],
      [4, 'downloading'],
      [5, 'failed'],
      [6, 'absent'],
      [7, 'notDownloaded'],
      [8, 'notDownloaded'],
      [9, 'locked'],
      [10, 'notDownloaded'],
    ],
  );
});

check('an imported folder has no platform list: every gap is unknown', () => {
  const missing = gaps.classifyMissing({ onDisk: new Set([1, 4]), remote: null, upTo: 4 });
  assert.deepEqual(missing, [
    { index: 2, state: 'unknown' },
    { index: 3, state: 'unknown' },
  ]);
});

check("only gaps between selected episodes count; unselected episodes on disk are the user's choice", () => {
  const missing = gaps.classifyMissing({ onDisk: new Set([1, 2, 5, 6]), remote, upTo: 10 });
  const result = gaps.summarizeGaps({ selected: [2, 5, 6], missing });
  assert.deepEqual(result.blocking, [
    { index: 3, state: 'notDownloaded' },
    { index: 4, state: 'notDownloaded' },
  ]);
  assert.deepEqual(result.notes, []);
  const skipping = gaps.summarizeGaps({
    selected: [1, 5],
    missing: gaps.classifyMissing({ onDisk: new Set([1, 2, 3, 4, 5]), remote, upTo: 5 }),
  });
  assert.deepEqual(skipping, { blocking: [], notes: [] }, 'episodes 2-4 are on disk, just not selected');
});

check('platform-missing and locked gaps are spliced by default with a note only', () => {
  const missing = gaps.classifyMissing({ onDisk: new Set([5, 7, 8, 10]), remote, upTo: 10 });
  const result = gaps.summarizeGaps({ selected: [5, 7, 8, 10], missing });
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(
    result.notes.map((item) => [item.index, item.state]),
    [
      [6, 'absent'],
      [9, 'locked'],
    ],
  );
});

check('a not-downloaded gap blocks even when a platform-missing gap sits beside it', () => {
  const missing = gaps.classifyMissing({ onDisk: new Set([5, 7, 10]), remote, upTo: 10 });
  const result = gaps.summarizeGaps({ selected: [5, 7, 10], missing });
  assert.deepEqual(result.blocking, [{ index: 8, state: 'notDownloaded' }]);
});

check('unknown gaps block until the user has confirmed them once', () => {
  const missing = gaps.classifyMissing({ onDisk: new Set([1, 4]), remote: null, upTo: 4 });
  assert.equal(gaps.summarizeGaps({ selected: [1, 4], missing }).blocking.length, 2);
  const confirmed = gaps.summarizeGaps({ selected: [1, 4], missing, confirmed: new Set([2, 3]) });
  assert.deepEqual(confirmed.blocking, []);
  assert.deepEqual(
    confirmed.notes.map((item) => item.state),
    ['confirmed', 'confirmed'],
  );
  const partial = gaps.summarizeGaps({ selected: [1, 4], missing, confirmed: new Set([2]) });
  assert.deepEqual(partial.blocking, [{ index: 3, state: 'unknown' }]);
});

check('episodes without a recognised number are ignored', () => {
  assert.deepEqual(gaps.summarizeGaps({ selected: [null, NaN, 3], missing: [] }), { blocking: [], notes: [] });
});

check('index lists read naturally', () => {
  assert.equal(gaps.describeIndices([6, 7]), '第 6–7 集');
  assert.equal(gaps.describeIndices([3, 5, 6, 7, 10]), '第 3、5–7、10 集');
  assert.equal(gaps.describeIndices([8]), '第 8 集');
});

if (failures) process.exitCode = 1;
