'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../src/native/video-structure/io');
const { separation } = require('../src/native/video-structure/speech');

async function main() {
  const lines = [];
  const result = await run(process.execPath, ['-e', `
    process.stderr.write('Start');
    setTimeout(() => process.stderr.write('ed\\r\\nDone\\nSaved to write to out.wav'), 25);
    process.stdout.write('result');
  `], { onStderrLine: line => lines.push(line) });
  assert.deepEqual(lines, ['Started', 'Done', 'Saved to write to out.wav']);
  assert.equal(result.stdout, 'result');
  assert.match(result.stderr, /Started/);
  await assert.rejects(run(process.execPath, ['-e', `
    process.stderr.write('Started\\n');
    setInterval(() => {}, 1000);
  `], { onStderrLine() { throw new Error('callback failed'); } }), /callback failed/);
  await assert.rejects(run(process.execPath, ['-e', `
    process.stderr.write('native failure\\n'); process.exitCode = 2;
  `], { onStderrLine() {} }), /native failure/);
  await testProcessTreeCancellation();
  console.log('PASS native stderr lines, final unterminated line, callback failure and process failure');
  if (process.env.STRUCTURE_PROGRESS_NATIVE === '1') await nativeSeparation();
}
async function testProcessTreeCancellation() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'structure-progress-cancel-'));
  const marker = path.join(temp, 'child-writes.log');
  const pidsFile = path.join(temp, 'pids.json');
  const childCode = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)}, 'x'), 25);`;
  const parentCode = `const fs=require('node:fs'),{spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const task = run(process.execPath, ['-e', parentCode], { signal: controller.signal, killProcessTree: true });
  const cancelled = assert.rejects(task, error => error?.code === 'ABORT_ERR');
  let pids = [];
  // 已退出但尚未被回收的僵尸进程不算存活（容器里没有 init 回收时会一直留在进程表）。
  const alive = pid => {
    try { process.kill(pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
    try { return !/^\d+ \(.*\) Z /.test(require('node:fs').readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
  };
  try {
    const deadline = Date.now() + 3000;
    while (!(await fs.stat(marker).then(stat => stat.size > 0).catch(() => false)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    pids = JSON.parse(await fs.readFile(pidsFile, 'utf8'));
    assert((await fs.stat(marker)).size > 0, '取消前必须确认子进程已实际写入');
    controller.abort();
    await cancelled;
    const before = (await fs.stat(marker)).size;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await fs.stat(marker)).size, before, '进程树取消后，子进程仍在写入文件');
    assert.deepEqual(pids.filter(alive), [], '取消后父进程或忽略 SIGTERM 的子进程仍存活');
    console.log('PASS process tree cancellation: parent and SIGTERM-resistant child exited, file writes stopped');
  } finally {
    controller.abort();
    await cancelled;
    for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await fs.rm(temp, { recursive: true, force: true });
  }
}
async function nativeSeparation() {
  const root = path.resolve(__dirname, '..');
  const home = path.join(root, 'build/video-structure', `${process.platform}-${process.arch}`);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const ffmpegDir = path.join(root, 'build/ffmpeg', process.platform === 'win32' ? '' : `${process.platform}-${process.arch}`);
  const ffmpeg = process.env.STRUCTURE_TEST_FFMPEG || path.join(ffmpegDir, `ffmpeg${ext}`);
  const ffprobe = process.env.STRUCTURE_TEST_FFPROBE || path.join(ffmpegDir, `ffprobe${ext}`);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'structure-progress-native-'));
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', path.join(temp, 'input.wav')]);
    const events = [];
    const result = await separation({
      taskId: 'native-progress-check', dir: temp, ffprobe,
      params: { binary: path.join(home, `bin/sherpa-onnx-offline-source-separation${ext}`), model: path.join(home, 'models/UVR-MDX-NET-Inst_HQ_3.onnx'), model_id: 'UVR-MDX-NET-Inst_HQ_3', threads: 2, provider: 'cpu' },
      onProgress: event => events.push(event),
    }, { path: 'input.wav', duration: 1, sample_rate: 44100, offset: 0, mapping: { method: 'test' } }, temp);
    assert.deepEqual([...new Set(events.map(event => event.progress_completed))], [0, 1, 2, 3, 4, 5, 6]);
    assert(events.every((event, index) => event.progress_unit === 'stages' && event.progress_total === 6 && (!index || event.progress >= events[index - 1].progress)));
    assert(events.filter(event => event.progress_completed === 1).every(event => Math.abs(event.progress - 100 / 6) < 1e-9));
    assert.equal(result.tracks.vocals.duration, 1);
    assert.equal(result.tracks.background.duration, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(temp, 'separation.json'), 'utf8')).task_id, 'native-progress-check');
    console.log('PASS real native separation: truthful milestones 0/6 through 6/6, no timed percentage, both tracks exactly 1 second');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
