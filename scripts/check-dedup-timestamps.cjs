// 去重成品的时间轴必须严格递增：剪映草稿那一步逐帧读时间戳，重复或倒退就建不了时间轴。
// 以前「重新拆分」出来的成品，即使片源干净也会有一帧时间戳重复；片源本身有坏时间戳时也会原样带进成品。
// 同时不能为了修时间戳把正常的帧丢掉（加速后帧更密，按原帧率的刻度算会误丢）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const quchong = require('../src/native/quchong');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe =
  process.env.FFPROBE_PATH || path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace('ffmpeg', 'ffprobe'));
const tool = (name) => (path.isAbsolute(name) ? name : name);
if (spawnSync(tool(ffmpeg), ['-version']).status !== 0) {
  console.log('SKIP dedup timestamps (no ffmpeg)');
  process.exit(0);
}

/** 和剪映草稿那一步同样的读法：逐帧 best_effort_timestamp，必须是数字且严格递增。 */
function timeline(file) {
  const frames = JSON.parse(
    execFileSync(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        file,
      ],
      { maxBuffer: 1 << 28 },
    ).toString(),
  ).frames;
  const times = frames.map((frame) => Number(frame.best_effort_timestamp_time));
  const bad = times.filter((t, index) => !Number.isFinite(t) || (index > 0 && !(t > times[index - 1]))).length;
  return { count: times.length, bad, times };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-ts-'));
  const good = path.join(tmp, 'good.mp4');
  const broken = path.join(tmp, 'broken.mkv');
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=25:duration=8',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=8',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    good,
  ]);
  // 片源里一帧时间戳和上一帧重复、一帧往回跳。
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=25:duration=8',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=8',
    '-vf',
    "setpts='if(eq(N,50),PREV_OUTPTS,if(eq(N,120),PTS-6,PTS))'",
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    broken,
  ]);
  assert.ok(timeline(broken).bad >= 1, 'the broken source really has bad timestamps');

  const options = quchong.validateOptions({ ...quchong.DEFAULTS, encoder: 'cpu', jobs: 1 });
  for (const [label, src] of [
    ['clean source', good],
    ['source with repeated / backward timestamps', broken],
  ]) {
    const plain = path.join(tmp, `plain-${path.basename(src)}.mp4`);
    await quchong.runJob({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src,
      dst: plain,
      options,
      opts: options,
      onLog() {},
    });
    const a = timeline(plain);
    assert.equal(a.bad, 0, `${label}: plain dedup output has a strictly increasing timeline`);
    assert.ok(a.count >= 195, `${label}: no frames lost to timestamp fixing (${a.count} of 200)`);

    const split = path.join(tmp, `split-${path.basename(src)}.mp4`);
    await quchong.runJob({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      dst: split,
      segments: [{ src, start: 0.5, duration: 6.5, speed: 1.17 }],
      options,
      opts: options,
      onLog() {},
    });
    const b = timeline(split);
    assert.equal(b.bad, 0, `${label}: re-split output has a strictly increasing timeline`);
    assert.ok(b.count >= 158, `${label}: re-split keeps its frames (${b.count} of ~163)`);
    console.log(
      `PASS ${label}: plain ${a.count} frames, re-split ${b.count} frames, no repeated or backward timestamps`,
    );
  }

  const highRate = path.join(tmp, '60fps.mp4');
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=60:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    highRate,
  ]);

  const thin = path.join(tmp, 'thinned.mp4');
  const mixed = path.join(tmp, 'mixed.mp4');
  const base = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, opts: options };
  await quchong.runJob({ ...base, src: highRate, dst: thin, speed: 1.2 });
  const thinned = timeline(thin);
  assert.equal(thinned.bad, 0);
  assert.ok(Math.abs(thinned.count - 180) <= 1, `60 fps input should lose about 25% of 240 frames (${thinned.count})`);
  assert.ok(Math.abs((await quchong.probeMedia(ffprobe, thin)).video_duration - 4 / 1.2) < 0.04);

  await quchong.runJob({
    ...base,
    dst: mixed,
    segments: [
      { src: good, start: 0, duration: 2, speed: 1 },
      { src: highRate, start: 0, duration: 2, speed: 1 },
    ],
  });
  const combined = timeline(mixed);
  assert.equal(combined.bad, 0);
  const lowRateFrames = combined.times.filter((time) => time < 2).length;
  assert.ok(Math.abs(lowRateFrames - 50) <= 1, `25 fps segment should keep its frames (${lowRateFrames})`);
  const highRateFrames = combined.count - lowRateFrames;
  assert.ok(Math.abs(highRateFrames - 90) <= 1, `60 fps segment should be thinned once (${highRateFrames})`);
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-xerror',
    '-i',
    mixed,
    '-fps_mode',
    'passthrough',
    '-enc_time_base:v',
    '1:90000',
    '-f',
    'null',
    '-',
  ]);
  console.log(`PASS frame thinning: 60 fps ${thinned.count}/240 frames; mixed ${lowRateFrames} + ${highRateFrames} frames`);

  const repeated = path.join(tmp, 'repeated.mp4');
  const encoded = path.join(tmp, 'repeated-encoded.mp4');
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    "color=blue:size=320x568:rate=25:duration=4,drawbox=w=iw:h=ih:color=white:t=fill:enable='gte(t,2)'",
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    repeated,
  ]);
  const logs = [];
  await quchong.runJob({ ...base, src: repeated, dst: encoded, speed: 1, onLog: (line) => logs.push(line) });
  const still = timeline(encoded);
  assert.equal(still.bad, 0);
  assert.ok(still.count >= 50 && still.count <= 52, `the repeated clip should retain about half its frames (${still.count})`);
  const output = await quchong.probeMedia(ffprobe, encoded);
  assert.ok(Math.abs(output.video_duration - 4) < 0.015, 'keep the full still-frame hold at the end');
  const audioDuration = Number(execFileSync(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', encoded,
  ]));
  assert.ok(Math.abs(output.video_duration - audioDuration) < 0.03, 'video and audio should end within one source frame');
  assert.ok(logs.some((line) => line.includes('在 1 处镜头切换')), 'runJob should detect the hard cut');
  console.log(`PASS repeated frames: ${still.count}/100 frames, full length kept, hard cut found`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
