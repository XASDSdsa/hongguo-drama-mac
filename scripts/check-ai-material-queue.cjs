// AI material queue regression checks. No network or API key is used.
const assert = require('node:assert/strict');
const { createAiMaterialQueue } = require('../src/native/ai-material-queue');

const stored = [];
const events = [];
let running = 0;
let peak = 0;

const queue = createAiMaterialQueue({
  list: () => stored,
  save: task => {
    const index = stored.findIndex(item => item.id === task.id);
    if (index < 0) stored.push({ ...task });
    else stored[index] = { ...stored[index], ...task };
  },
  notify: task => events.push(task),
  concurrency: () => 2,
  execute: async (task, { signal, update }) => {
    running++;
    peak = Math.max(peak, running);
    update({ stage: 'extracting', progress: 20 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    running--;
    return { outputPath: `${task.id}.json` };
  },
});

(async () => {
  const first = queue.enqueue({ kind: 'episode-copy', seriesId: 's', episodeIndex: 1 }).task;
  const second = queue.enqueue({ kind: 'episode-copy', seriesId: 's', episodeIndex: 2 }).task;
  assert.equal(queue.enqueue({ kind: 'episode-copy', seriesId: 's', episodeIndex: 1 }).duplicate, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(peak, 2);
  assert.equal(stored.filter(task => task.status === 'completed').length, 2);

  const third = queue.enqueue({ kind: 'episode-copy', seriesId: 's', episodeIndex: 3 }).task;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queue.cancel(third.id).success, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stored.find(task => task.id === third.id).status, 'stopped');
  assert.ok(events.some(task => task.id === first.id && task.stage === 'extracting'));
  console.log('AI material queue: 4 passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
