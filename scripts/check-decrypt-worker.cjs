const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
(async () => {
  const { decryptInWorker } = require('../src/native/decrypt-worker.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-worker-'));
  try {
    const bytes = Buffer.from([0, 0, 0, 8, 109, 111, 111, 118]); // empty valid moov, no encrypted samples
    const srcPath = path.join(dir, 'input.mp4'),
      dstPath = path.join(dir, 'out.mp4');
    await fs.writeFile(srcPath, bytes);
    const key = Buffer.alloc(16);
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    const result = await decryptInWorker({ buffer: bytes, key });
    assert.deepEqual(result, bytes);
    assert.ok(yielded, 'worker must yield the main event loop');
    await decryptInWorker({ srcPath, dstPath, key });
    assert.deepEqual(await fs.readFile(dstPath), bytes);
    assert.deepEqual(await fs.readFile(srcPath), bytes, 'source must remain unchanged');
    await assert.rejects(decryptInWorker({ buffer: Buffer.from('invalid'), key }), /moov|bounds|offset|MP4/i);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(decryptInWorker({ buffer: bytes, key }, { signal: controller.signal }), /取消/);
    const mid = new AbortController();
    const pending = decryptInWorker({ srcPath, dstPath: path.join(dir, 'cancelled.mp4'), key }, { signal: mid.signal });
    mid.abort();
    await assert.rejects(pending, /取消/);
    assert.equal(
      await fs.stat(path.join(dir, 'cancelled.mp4')).then(
        () => true,
        () => false,
      ),
      false,
    );
    console.log('PASS decrypt worker: parity, event-loop yield, file integrity, error and cancellation');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('FAIL decrypt worker:', e.message);
  process.exitCode = 1;
});
