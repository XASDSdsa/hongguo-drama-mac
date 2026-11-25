'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const quchong = require('../src/native/quchong');
const resplit = require('../src/native/resplit');
const { minSeconds } = require('../src/native/dedup-requirements.json');

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
const weaker = { encoder: 'cpu', crop_ratio: 1, rgb_shift: 0, vignette: false, eq_enable: false, shot_reframe: false,
  drop_duplicate_frames: false, pitch_min: 1, pitch_max: 1, noise_min: 0, noise_max: 0 };
const locked = quchong.deliveryOptions(weaker);
const split = { min_len: 30, max_len: 65, head_trim: 0, tail_trim: 0 };

function runFfmpeg(args) {
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
}

async function main() {
  assert.equal(locked.crop_ratio, 0.88);
  assert.ok(locked.rotation_max > 0 && locked.rgb_shift > 0 && locked.noise_min > 0 && locked.pitch_min > 1);
  for (const key of ['vignette', 'eq_enable', 'shot_reframe', 'drop_duplicate_frames']) assert.equal(locked[key], true);
  const media = {
    video_width: 320, video_height: 568, video_start: 0, audio_start: 0, video_duration: 85,
    has_audio: true, video_frame_rate: 25,
  };
  const rolled = quchong.rollParams(locked, () => 0.5);
  const { filters } = quchong.buildCommand({
    src: 'in.mp4', dst: 'out.mp4', opts: locked, rolled, media, encoder: 'cpu', sceneCuts: [2],
  });
  for (const effect of ['crop@shot', 'sendcmd', 'mpdecimate', 'rotate', 'rgbashift', 'noise', 'unsharp', 'setpts', 'eq=', 'hue=', 'vignette', 'asetrate', 'atempo', 'equalizer']) {
    assert.ok(filters.includes(effect), `missing strongest-tier effect: ${effect}`);
  }

  const plan = (durations) => resplit.planPieces({
    sources: durations.map((duration, i) => ({ file: `episode-${i + 1}.mp4`, duration })),
    split, speedMin: locked.speed_min, speedMax: locked.speed_max, random: () => 0.999, delivery: true,
  });
  assert.equal(resplit.validateDeliverySplit(split).min_len, minSeconds);
  assert.equal(plan([55]).pieces.length, 0);
  const merged = plan([35, 35]);
  assert.equal(merged.pieces.length, 1);
  assert.equal(merged.pieces[0].segments.length, 2);
  assert.ok(merged.pieces[0].length >= minSeconds);
  const tail = plan([255]);
  assert.ok(tail.pieces.length > 1 && tail.pieces.every((piece) => piece.length >= minSeconds));
  assert.equal(tail.pieces.reduce((sum, piece) => sum + piece.length, 0).toFixed(2), tail.totalSeconds.toFixed(2));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-delivery-'));
  try {
    const long = path.join(work, '素材.mp4');
    const short = path.join(work, '短素材.mp4');
    const out = path.join(work, '成品.mp4');
    const rejected = path.join(work, '不应保存.mp4');
    runFfmpeg([
      '-f', 'lavfi', '-i', "color=blue:size=320x568:rate=8:duration=65,drawbox=w=iw:h=ih:color=white:t=fill:enable='gte(t,32)'",
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=65',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', long,
    ]);
    runFfmpeg(['-i', long, '-t', '55', '-c', 'copy', short]);
    const base = { ffmpegPath, ffprobePath, opts: weaker };
    await assert.rejects(quchong.runDeliveryJob({ ...base, src: short, dst: rejected }), /至少需要 60 秒/);
    assert.ok(!fs.existsSync(rejected));
    const logs = [];
    const result = await quchong.runDeliveryJob({ ...base, src: long, dst: out, onLog: (line) => logs.push(line) });
    assert.ok(result.rolled.ROT > 0 && result.rolled.PITCH > 1 && result.rolled.NOISE > 0);
    assert.ok(logs.some((line) => line.startsWith('[构图] 在 ')));
    const output = await quchong.probeMedia(ffprobePath, out);
    assert.ok(output.video_duration >= minSeconds && output.has_audio);
    runFfmpeg(['-xerror', '-i', out, '-fps_mode', 'passthrough', '-enc_time_base:v', '1:90000', '-f', 'null', '-']);
    console.log(`PASS locked full-effects delivery, 55-second rejection, minimum-length planning and ${output.video_duration.toFixed(3)}-second decoded output`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
