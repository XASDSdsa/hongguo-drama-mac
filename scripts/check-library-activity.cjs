// 管理剧集的处理日志和总任务：日志按剧保存且重启后还在，总任务按剧汇总。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createActivityLog,
  summarizeProcessing,
  buildOverview,
  sourceEpisodes,
} = require('../src/native/library-activity');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-activity-'));
const file = path.join(tmp, 'activity.json');

// ---- 日志 ----
let clock = 1000;
const log = createActivityLog({ file, perDir: 5, maxDirs: 2, now: () => ++clock });
log.add('/d/A', 'info', '一');
log.add('/d/A', 'error', '二');
log.add('/d/A', 'bogus-level', '三');
assert.deepEqual(
  log.list('/d/A').map((line) => [line.text, line.level]),
  [
    ['一', 'info'],
    ['二', 'error'],
    ['三', 'info'],
  ],
  'unknown levels fall back to info',
);
assert.deepEqual(log.list('/d/B'), [], 'another series has its own log');
for (let i = 4; i <= 9; i++) log.add('/d/A', 'info', String(i));
assert.deepEqual(
  log.list('/d/A').map((line) => line.text),
  ['5', '6', '7', '8', '9'],
  'keeps only the newest perDir lines',
);
assert.equal(log.add('', 'info', 'x'), null, 'no folder, no log');
log.add('/d/B', 'ok', 'b');
log.add('/d/C', 'ok', 'c');
assert.deepEqual(log.list('/d/A'), [], 'the least recently written series is dropped beyond maxDirs');
log.flush();
const reopened = createActivityLog({ file, perDir: 5, maxDirs: 2 });
assert.deepEqual(
  reopened.list('/d/B').map((line) => line.text),
  ['b'],
  'the log survives a restart',
);
reopened.clear('/d/B');
reopened.flush();
assert.deepEqual(createActivityLog({ file }).list('/d/B'), [], 'clear is persisted');
fs.writeFileSync(file, '{not json');
assert.deepEqual(createActivityLog({ file }).list('/d/B'), [], 'a corrupt file is treated as empty');

// ---- 处理汇总 ----
const task = (status, progress = 0, extra = {}) => ({ id: Math.random(), status, progress, ...extra });
const batch = (id, status, tasks, extra = {}) => ({
  id,
  status,
  createdAt: extra.createdAt || 1,
  tasks,
  libraryDir: '/d/A',
  ...extra,
});
let sum = summarizeProcessing([batch('b1', 'running', [task('completed', 100), task('running', 40), task('pending')])]);
assert.equal(sum.state, 'running');
assert.deepEqual([sum.total, sum.done, sum.running, sum.queued], [3, 1, 1, 1]);
assert.equal(sum.progress, Math.floor((100 + 40 + 0) / 3));
sum = summarizeProcessing([batch('b1', 'queued', [task('pending'), task('pending')])]);
assert.equal(sum.state, 'queued');
sum = summarizeProcessing([
  batch('old', 'failed', [task('failed')], { createdAt: 1, endTime: 5 }),
  batch('new', 'completed', [task('completed', 100), task('completed', 100)], { createdAt: 9, endTime: 20 }),
]);
assert.equal(sum.state, 'completed', 'without a running batch the newest batch decides');
assert.equal(sum.batchId, 'new');
sum = summarizeProcessing([batch('b', 'failed', [task('completed', 100), task('failed')], { endTime: 7 })]);
assert.deepEqual([sum.state, sum.failed, sum.done], ['failed', 1, 1]);
sum = summarizeProcessing([
  batch('done', 'completed', [task('completed', 100)], { createdAt: 1 }),
  batch('live', 'running', [task('running', 10)], { createdAt: 2 }),
]);
assert.equal(sum.state, 'running', 'a running batch wins over finished ones');
assert.equal(sum.total, 1);
assert.equal(summarizeProcessing([]), null);

// ---- 总任务 ----
const folders = [
  { name: '甲', path: '/d/A', seriesId: '1' },
  { name: '乙', path: '/d/B', seriesId: '2' },
  { name: '丙', path: '/d/C', seriesId: '3' },
  { name: '丁', path: '/d/D', seriesId: '' },
  { name: '戊', path: '/d/E', seriesId: '5' },
];
const overview = buildOverview({
  folders,
  batches: [
    batch('a1', 'running', [task('running', 50), task('pending')], { libraryDir: '/d/A' }),
    batch('c1', 'completed', [task('completed', 100)], { libraryDir: '/d/C', endTime: 9 }),
    batch('x1', 'running', [task('running')], { libraryDir: '/not/a/series' }),
    batch('n1', 'running', [task('running')], { libraryDir: '' }),
  ],
  downloads: [
    { status: 'downloading', hongguoInfo: { series_id: '2' } },
    { status: 'pending', hongguoInfo: { series_id: '2' } },
    { status: 'failed', hongguoInfo: { series_id: '2' }, endTime: 5 },
    { status: 'completed', hongguoInfo: { series_id: '2' } },
    { status: 'failed', hongguoInfo: { series_id: '5' }, endTime: 3 },
    { status: 'downloading', hongguoInfo: { series_id: '999' } },
  ],
  jobs: [
    { id: 'j1', dir: '/d/D', status: 'waiting', message: '正在补下载', updatedAt: 4 },
    { id: 'j2', dir: '/d/D', status: 'started', message: '已开始', updatedAt: 6 },
  ],
  planning: new Map([['/d/A', { done: 2, total: 8 }]]),
});
assert.deepEqual(
  overview.items.map((item) => item.name),
  ['乙', '甲', '丁', '戊', '丙'],
  'busy series first (newest first), then waiting, then failures, then finished',
);
const byName = new Map(overview.items.map((item) => [item.name, item]));
assert.deepEqual(byName.get('甲').planning, { done: 2, total: 8 });
assert.equal(byName.get('甲').processing.state, 'running');
assert.deepEqual(byName.get('乙').downloads, { active: 1, pending: 1, failed: 1, stopped: 0 });
assert.equal(byName.get('丁').job.status, 'waiting', 'only waiting/starting/failed jobs are shown');
assert.equal(byName.get('丙').processing.state, 'completed');
assert.ok(!byName.has('x'), 'batches outside the library are ignored');
assert.deepEqual(overview.totals, {
  processingRunning: 1,
  processingQueued: 1,
  processingFailed: 0,
  downloadActive: 2,
  downloadFailed: 2,
  busy: 3,
});
assert.deepEqual(buildOverview({ folders, batches: [], downloads: [] }).items, [], 'nothing running, nothing listed');

// ---- 一集由哪些原集拼成 ----
const parse = (name) => Number((/第0*(\d+)集/.exec(name) || [])[1]) || null;
assert.deepEqual(sourceEpisodes({ src: '/d/A/剧_第003集.mp4' }, parse), [3]);
assert.deepEqual(
  sourceEpisodes(
    { segments: [{ src: '/d/A/剧_第003集.mp4' }, { src: '/d/A/剧_第004集.mp4' }, { src: '/d/A/剧_第003集.mp4' }] },
    parse,
  ),
  [3, 4],
);
assert.deepEqual(sourceEpisodes({ src: '/d/A/随便.mp4' }, parse), []);
console.log('PASS library activity log + overview');
