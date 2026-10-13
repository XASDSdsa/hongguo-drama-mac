const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareAudio, transcribeToSrt } = require('../src/native/faster-whisper');
const { validateSrt, correctSrtBounds } = require('../src/native/srt');

const bin = path.resolve(__dirname, '../build/ffmpeg', ...(process.platform === 'win32' ? [] : [`${process.platform}-${process.arch}`]));
const runtime = {
  ffmpegPath: process.env.FFMPEG_PATH || path.join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  ffprobePath: process.env.FFPROBE_PATH || path.join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
};
function ffmpeg(args) { execFileSync(runtime.ffmpegPath, ['-v', 'error', '-nostdin', '-y', ...args], { windowsHide: true }); }
function pcm(file) {
  const bytes = fs.readFileSync(file);
  let pos = 12;
  while (pos + 8 < bytes.length && bytes.toString('ascii', pos, pos + 4) !== 'data') pos += 8 + bytes.readUInt32LE(pos + 4) + bytes.readUInt32LE(pos + 4) % 2;
  assert.equal(bytes.toString('ascii', pos, pos + 4), 'data');
  return bytes.subarray(pos + 8);
}
function soundRanges(bytes) {
  // RMS in 10 ms windows avoids a sine wave's zero crossings.
  const ranges = [];
  let start = null;
  for (let i = 0; i < bytes.length / 2; i += 160) {
    let sum = 0;
    for (let j = i; j < Math.min(i + 160, bytes.length / 2); j++) sum += bytes.readInt16LE(j * 2) ** 2;
    const sound = Math.sqrt(sum / 160) > 300;
    if (sound && start == null) start = i / 16000;
    if (!sound && start != null) { ranges.push([start, i / 16000]); start = null; }
  }
  if (start != null) ranges.push([start, bytes.length / 32000]);
  return ranges;
}
function near(actual, expected, tolerance = 0.011) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`); }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '红果 subtitle timing '));
  let checks = 0;
  try {
    const valid = '1\n00:00:01,000 --> 00:00:02,000\n第一句\n\n2\n00:00:05,000 --> 00:00:06,000\n最后一句\n\n';
    assert.equal(validateSrt(valid, { duration: 300 }).entries[1].end, 6, 'never stretch silence to fill the video');
    for (const broken of ['', valid + '坏掉的一条\n', valid.replace('00:00:05,000', '00:00:01,500'), valid.replace('00:00:06,000', '00:10:00,000'), valid.replace('2\n00:00:05', '3\n00:00:05')]) assert.throws(() => validateSrt(broken, { duration: 8 }), /SRT/);
    checks += 6;
    const early = '1\n00:00:01,650 --> 00:00:03,350\n完整对白。\n\n';
    const corrected = correctSrtBounds(early, { duration: 8, audioOffset: 2, audioEnd: 3 });
    assert.equal(corrected.entries[0].start, 2); assert.equal(corrected.entries[0].end, 3);
    assert.equal(corrected.entries[0].text, '完整对白。'); assert.equal(corrected.correctedCues, 1);
    assert.throws(() => correctSrtBounds(early, { duration: 8, audioOffset: 4, audioEnd: 6 }), /完全位于音轨之外/);
    checks += 2;

    async function checkMedia(name, videoStart, audioStart, duration, audioFilter, expected) {
      const input = path.join(root, `${name}.mkv`), output = path.join(root, `${name}.wav`);
      ffmpeg(['-itsoffset', String(videoStart), '-f', 'lavfi', '-i', `color=size=32x32:rate=1:duration=${duration}`,
        '-itsoffset', String(audioStart), '-f', 'lavfi', '-i', audioFilter, '-map', '0:v', '-map', '1:a', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', input]);
      const timing = await prepareAudio(input, output, runtime);
      near(timing.duration, duration, 0.001);
      near(timing.audioOffset, audioStart - videoStart, 0.001);
      const audio = pcm(output);
      near(audio.length / 32000, duration, 1 / 16000);
      const actual = soundRanges(audio);
      assert.equal(actual.length, expected.length, name);
      actual.forEach((item, i) => item.forEach((time, j) => near(time, expected[i][j])));
      console.log(`PASS ${name}: ${JSON.stringify(actual)} seconds, duration ${duration}`);
      checks++;
      return input;
    }
    const input = await checkMedia('audio-delay', 0, 2, 8, 'sine=frequency=440:sample_rate=16000:duration=1', [[2, 3]]);
    await checkMedia('nonzero-video-origin', 5, 7, 8, 'sine=frequency=440:sample_rate=16000:duration=1', [[2, 3]]);
    await checkMedia('audio-before-video', 2, 0, 8, 'sine=frequency=440:sample_rate=16000:duration=3', [[0, 1]]);
    await checkMedia('ten-minute-clock', 0, 0, 605, "aevalsrc=if(between(t\\,301\\,301.25)+between(t\\,601\\,601.25)\\,0.4*sin(2*PI*440*t)\\,0):s=16000:d=605", [[301, 301.25], [601, 601.25]]);
    const gapInput = path.join(root, 'packet-gap.mkv'), gapOutput = path.join(root, 'gap.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'color=size=32x32:rate=1:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=5', '-af', "aselect='lt(t,1)+gte(t,3)'", '-c:v', 'ffv1', '-c:a', 'pcm_s16le', gapInput]);
    await prepareAudio(gapInput, gapOutput, runtime);
    const ranges = soundRanges(pcm(gapOutput));
    assert.equal(ranges.length, 2);
    near(ranges[1][0], 3, 0.07); near(ranges[1][1], 5);
    checks++;
    console.log(`PASS packet timestamps preserve the internal gap: ${JSON.stringify(ranges)}`);

    // Real child process ignores the first stop signal and writes later. It
    // must not overwrite a previously completed SRT or outlive cancellation.
    const worker = path.join(root, 'worker.cjs');
    fs.writeFileSync(worker, `const fs=require('fs'); const args=process.argv; const out=args[args.indexOf('--output')+1];
const srt='1\\n00:00:02,000 --> 00:00:03,000\\n测试字幕\\n\\n';
function save(){fs.writeFileSync(out,srt);console.log(JSON.stringify({word_aligned:true,entries:1}));}
if(process.env.SUBTITLE_WAIT==='1'){
 process.on('SIGTERM',()=>setTimeout(()=>{save();process.exit(0);},150));
 setInterval(()=>{},1000); console.error('PROGRESS 10 ready');
}else{save();console.error('PROGRESS 100 done');}
`);
    const output = path.join(root, '正式字幕.srt');
    fs.writeFileSync(output, valid);
    const workerRuntime = { ...runtime, command: process.execPath, prefixArgs: [worker], model: 'tiny', device: 'cpu', computeType: 'int8' };
    const controller = new AbortController();
    let cancelTime;
    process.env.SUBTITLE_WAIT = '1';
    try {
      await assert.rejects(() => transcribeToSrt(input, output, workerRuntime, { signal: controller.signal, onProgress: info => {
        if (info.message === 'ready') { cancelTime = Date.now(); controller.abort(); }
      } }), /任务已取消/);
    } finally { delete process.env.SUBTITLE_WAIT; }
    assert.ok(cancelTime);
    if (process.platform !== 'win32') assert.ok(Date.now() - cancelTime >= 120, 'must wait for child close');
    assert.equal(fs.readFileSync(output, 'utf8'), valid);
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.subtitle-')));
    checks++;
    await transcribeToSrt(input, output, workerRuntime);
    assert.match(fs.readFileSync(output, 'utf8'), /测试字幕/);
    checks++;
    await assert.rejects(() => transcribeToSrt(input, output, workerRuntime, { beforeCommit: () => { throw new Error('输入视频版本已变化'); } }), /输入视频版本已变化/);
    assert.match(fs.readFileSync(output, 'utf8'), /测试字幕/);
    checks++;
    console.log(`Subtitle timing and child lifecycle: ${checks} checks passed`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
