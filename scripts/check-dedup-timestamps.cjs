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
  let bad = 0;
  frames.forEach((frame, index) => {
    const t = Number(frame.best_effort_timestamp_time);
    if (!Number.isFinite(t) || (index && !(t > Number(frames[index - 1].best_effort_timestamp_time)))) bad += 1;
  });
  return { count: frames.length, bad };
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
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
