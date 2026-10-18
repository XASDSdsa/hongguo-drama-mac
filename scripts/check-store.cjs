const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-store-'));
const file = path.join(dir, 'data.json');
const write = fs.writeFileSync;
const log = console.error;
try {
  store.init(file);
  store.saveSettings({ theme: 'light' });
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync = (target, ...args) => {
    write(target, '{');
    throw new Error('simulated disk full');
  };
  console.error = () => {};
  assert.throws(() => store.saveTasks([{ id: 'pending' }]), /simulated disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'failed write must preserve the last complete state');
  fs.writeFileSync = write;
  store.saveTasks([{ id: 'complete' }]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].id, 'complete');
  store.saveQuchongTasks([{ id: 'batch-1', status: 'completed', tasks: [{ id: 'task-1', status: 'completed' }] }]);
  assert.deepEqual(store.getQuchongTasks(), [
    { id: 'batch-1', status: 'completed', tasks: [{ id: 'task-1', status: 'completed' }] },
  ]);
  assert.deepEqual(fs.readdirSync(dir), ['data.json']);
  // 播放进度合并写入：多次保存只落一次盘，退出前 flushPending 或任何其他保存都会带上最新进度。
  const writes = [];
  fs.writeFileSync = (target, ...args) => {
    writes.push(target);
    return write(target, ...args);
  };
  store.savePlayback({ s: { currentTime: 1 } });
  store.savePlayback({ s: { currentTime: 2 } });
  store.savePlayback({ s: { currentTime: 3 } });
  assert.equal(writes.length, 0, 'playback progress must not write synchronously');
  store.flushPending();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).playback.s.currentTime, 3);
  store.flushPending();
  assert.equal(writes.length, 1, 'nothing pending after flush');
  store.savePlayback({ s: { currentTime: 4 } });
  store.saveTasks([{ id: 'other-save' }]);
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).playback.s.currentTime,
    4,
    'other saves carry pending playback',
  );
  // 去重快照也合并写入：一集要经过好几个阶段，每次都整份重写太费。
  writes.length = 0;
  store.saveQuchongTasks([{ id: 'b', status: 'running', tasks: [] }]);
  store.saveQuchongTasks([{ id: 'b', status: 'completed', tasks: [] }]);
  assert.equal(writes.length, 0, 'quchong snapshots must not write synchronously');
  store.flushPending();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).quchongTasks[0].status, 'completed');
  fs.writeFileSync = write;
  console.log('PASS: interrupted save preserves data; task and quchong snapshots recover; no temporary file remains');
} finally {
  fs.writeFileSync = write;
  console.error = log;
  fs.rmSync(dir, { recursive: true, force: true });
}
