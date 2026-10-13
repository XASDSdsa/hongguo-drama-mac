const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fw = require('../src/native/faster-whisper');
const { createTranscriptionManager, fingerprint, inspectSubtitle } = require('../src/native/transcription-manager');
const srt = '1\n00:00:01,000 --> 00:00:02,000\n完整对白。\n\n';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw new Error('state transition did not complete'); }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-queue-'));
  const original = { prepareRuntime: fw.prepareRuntime, transcribeToSrt: fw.transcribeToSrt };
  const states = new Map(), sources = new Map(), pending = [], started = [];
  let active = 0, peak = 0, passed = 0;
  fw.prepareRuntime = async (_settings, options = {}) => {
    if (options.signal?.aborted) throw new Error('任务已取消');
    return { device: 'cpu', computeType: 'int8', model: 'tiny' };
  };
  fw.transcribeToSrt = (input, output, runtime, options) => new Promise((resolve, reject) => {
    active++; peak = Math.max(peak, active); started.push(input);
    const call = { input, output, options, finish(cancelled = false) {
      pending.splice(pending.indexOf(call), 1); active--;
      try {
        if (cancelled || options.signal.aborted) throw new Error('任务已取消');
        options.beforeCommit();
        fs.writeFileSync(output, srt);
        resolve({ outputPath: output, timing: { duration: 10, videoStart: 0, audioStart: 0, audioOffset: 0 }, alignment: { word_aligned: true } });
      } catch (error) { reject(error); }
    } };
    pending.push(call);
    options.onProgress({ stage: 'aligning', progress: 30 });
  });
  function addSeries(id, count = 3) {
    const dir = path.join(root, id); fs.mkdirSync(dir, { recursive: true });
    sources.set(id, Array.from({ length: count }, (_, i) => {
      const inputPath = path.join(dir, `ep${i + 1}.mp4`);
      fs.writeFileSync(inputPath, Buffer.alloc(120000, i));
      return { episodeIndex: i + 1, inputPath, inputFingerprint: fingerprint(inputPath), srtPath: path.join(dir, `ep${i + 1}.srt`) };
    }));
  }
  const manager = createTranscriptionManager({
    getSettings: () => ({ faster_whisper_concurrency: 2 }),
    getEpisodes: id => sources.get(id) || [], getState: id => states.get(id), saveState: (id, state) => states.set(id, state),
  });
  try {
    for (const id of ['A', 'B', 'C']) { addSeries(id); assert.equal((await manager.start({ seriesId: id })).success, true); }
    await until(() => pending.length === 2);
    assert.equal(active, 2); assert.equal(manager.status('A').episodes[0].progress, 30);
    for (let i = 0; manager.hasActive() && i < 50; i++) { if (pending.length) pending[0].finish(); await tick(); }
    assert.equal(manager.hasActive(), false); assert.equal(peak, 2);
    for (const id of ['A', 'B', 'C']) assert.equal(manager.status(id).counts.completed, 3);
    assert.ok(started.slice(0, 6).some(item => item.includes(`${path.sep}C${path.sep}`)), 'another series must not starve');
    passed++;

    const first = sources.get('A')[0], originalRecord = states.get('A').episodes['1'];
    assert.equal((await manager.start({ seriesId: 'A' })).skipped, 3);
    fs.writeFileSync(first.srtPath, '');
    assert.equal(manager.status('A').episodes[0].status, 'stale');
    const repair = await manager.start({ seriesId: 'A' });
    assert.equal(repair.skipped, 2);
    await until(() => pending.length === 1); pending[0].finish(); await until(() => !manager.hasActive());
    assert.equal(manager.status('A').counts.completed, 3);
    assert.notEqual(states.get('A').episodes['1'].revision, originalRecord.revision);
    // Same-size content edits still invalidate a saved completed record.
    fs.writeFileSync(first.srtPath, srt.replace('完整', '错误'));
    assert.equal(manager.status('A').episodes[0].status, 'stale');
    passed++;

    addSeries('D', 3); addSeries('E', 1);
    const batch = await manager.start({ seriesId: 'D' });
    await until(() => pending.length === 2);
    manager.cancel(batch.batchId);
    assert.equal(manager.status('D').status, 'stopping');
    assert.equal((await manager.start({ seriesId: 'D' })).success, false, 'no retry until child exit');
    await manager.start({ seriesId: 'E' }); await tick(); await tick();
    assert.equal(pending.length, 2); assert.ok(pending.every(call => call.input.includes(`${path.sep}D${path.sep}`)));
    const old = [...pending]; old.forEach(call => call.finish(true));
    await until(() => pending.length === 1 && pending[0].input.includes(`${path.sep}E${path.sep}`));
    assert.equal(manager.status('D').counts.stopped, 3);
    pending[0].finish(); await until(() => !manager.hasActive());
    passed++;

    addSeries('F', 1);
    const item = sources.get('F')[0]; fs.writeFileSync(item.srtPath, 'previous subtitle');
    await manager.start({ seriesId: 'F' }); await until(() => pending.length === 1);
    fs.appendFileSync(item.inputPath, 'new content'); item.inputFingerprint = fingerprint(item.inputPath);
    // Queued jobs must be immutable snapshots, not aliases of a mutable source.
    pending[0].finish(); await until(() => !manager.hasActive());
    assert.equal(manager.status('F').episodes[0].status, 'failed');
    assert.equal(fs.readFileSync(item.srtPath, 'utf8'), 'previous subtitle');
    passed++;

    addSeries('G', 1);
    const g = await manager.start({ seriesId: 'G' }); manager.cancel(g.batchId);
    await manager.cancelAll();
    assert.equal(manager.status('G').counts.stopped, 1); assert.equal(pending.length, 0);
    passed++;
    assert.equal((await manager.start({ seriesId: 'A', episodeIndices: [] })).success, false);
    passed++;
    let probes = 0, peakProbes = 0;
    fw.prepareRuntime = (_settings, { signal }) => new Promise((resolve, reject) => {
      probes++; peakProbes = Math.max(probes, peakProbes);
      signal.addEventListener('abort', () => { probes--; reject(new Error('任务已取消')); }, { once: true });
    });
    for (const id of ['H', 'I', 'J', 'K']) { addSeries(id, 1); await manager.start({ seriesId: id }); }
    await until(() => probes === 2); await tick();
    assert.equal(peakProbes, 2, 'runtime checks must also obey the global quota');
    await manager.cancelAll();
    assert.equal(probes, 0); assert.equal(manager.hasActive(), false);
    passed++;
    assert.equal(inspectSubtitle(sources.get('B')[0].srtPath, 10).entries, 1);
    console.log(`Subtitle queue/integrity: ${passed} scenarios passed (global quota, fair scheduling, corruption, stop/retry, input changes, queued cancellation)`);
  } finally {
    const closing = manager.cancelAll();
    [...pending].forEach(call => call.finish(true));
    await closing;
    Object.assign(fw, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
