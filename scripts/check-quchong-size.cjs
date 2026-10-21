'use strict';
// 去重成品的尺寸：原视频够 720p（短边 720、长边 1280）就保持原尺寸；不够就按比例放大到 720p（平台提审要求）。
// 横竖屏和画面比例不变，不加黑边、不做模糊背景。成品码率不低于 4Mbps、不超过 500MB。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const quchong = require('../src/native/quchong');

const media = (w, h) => ({
  has_audio: false,
  video_start: 0,
  audio_start: 0,
  video_duration: 2,
  duration: 2,
  video_width: w,
  video_height: h,
});
const graph = (w, h) => {
  const { args } = quchong.buildCommand({
    src: 'in.mp4',
    dst: 'out.mp4',
    opts: { ...quchong.DEFAULTS, encoder: 'cpu' },
    media: media(w, h),
    encoder: 'cpu',
  });
  return args[args.indexOf('-filter_complex') + 1];
};

for (const [w, h, ew, eh] of [
  [720, 1280, 720, 1280],
  [1080, 1920, 1080, 1920],
  [1920, 1080, 1920, 1080],
  [721, 1281, 720, 1280],
  [360, 640, 720, 1280],
  [640, 360, 1280, 720],
  [544, 960, 726, 1280],
]) {
  const filter = graph(w, h);
  assert.ok(filter.includes(`scale=${ew}:${eh}:flags=lanczos,setsar=1`), `${w}x${h} 必须缩放到 ${ew}x${eh}：${filter}`);
  assert.ok(!/(^|[,;\]])pad=|overlay|boxblur|split=/.test(filter), '不能再加黑边或模糊背景');
}
// 放大后不会因为取整掉到 720p 以下，比例基本不变。
for (const [w, h] of [
  [719, 1279],
  [250, 138],
  [480, 854],
  [368, 640],
]) {
  const size = quchong.deliverySize(w, h);
  assert.ok(
    Math.min(size.width, size.height) >= 720 && Math.max(size.width, size.height) >= 1280,
    `${w}x${h} → ${size.width}x${size.height}`,
  );
  assert.ok(size.width % 2 === 0 && size.height % 2 === 0);
  assert.ok(Math.abs(size.width / size.height - w / h) < 0.01, `${w}x${h} 比例不变`);
}
// 码率：默认 6Mbps；很长的片子为了不超过 500MB 往下压。
assert.equal(quchong.deliveryVideoKbps(120), 6000);
assert.ok(quchong.deliveryVideoKbps(900) < 6000);
assert.ok(((quchong.deliveryVideoKbps(900) + 128) * 900 * 1000) / 8 < 500 * 1000 * 1000, '15 分钟也不超过 500MB');
for (const encoder of ['cpu', 'nvenc', 'amf', 'qsv', 'videotoolbox']) {
  const args = quchong.encoderArgs(encoder, false, 720, 1280, 6000);
  assert.ok(args.includes('6000k'), `${encoder} 按码率编：${args.join(' ')}`);
  assert.ok(
    !args.includes('-crf') && !args.includes('-cq') && !args.includes('-global_quality'),
    `${encoder} 不再按画质目标编`,
  );
}
// 提审要求检查。
assert.deepEqual(quchong.deliveryProblems({ width: 720, height: 1280, duration: 60, size: (60 * 5_000_000) / 8 }), []);
assert.deepEqual(
  quchong
    .deliveryProblems({ width: 360, height: 640, duration: 20, size: (20 * 2_000_000) / 8 })
    .map((item) => item.key),
  ['resolution', 'bitrate', 'duration'],
);
assert.deepEqual(
  quchong.deliveryProblems({ width: 1080, height: 1920, duration: 600, size: 600_000_000 }).map((item) => item.key),
  ['size'],
);
assert.equal('resolution' in quchong.DEFAULTS, false, '不再有分辨率选项');
assert.doesNotThrow(() => quchong.validateOptions({ ...quchong.DEFAULTS, resolution: undefined }));

// 真实编码：横屏、竖屏、奇数尺寸都和源一样大。
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
if (spawnSync(ffmpeg, ['-version']).status === 0) {
  (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-size-'));
    try {
      for (const [w, h] of [
        [320, 180],
        [180, 320],
        [250, 138],
      ]) {
        const src = path.join(dir, `s${w}.mp4`);
        const dst = path.join(dir, `o${w}.mp4`);
        const made = spawnSync(ffmpeg, [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `testsrc2=size=${w}x${h}:rate=24`,
          '-t',
          '1',
          '-pix_fmt',
          'yuv420p',
          src,
        ]);
        assert.equal(made.status, 0, String(made.stderr));
        await quchong.runJob({
          ffmpegPath: ffmpeg,
          ffprobePath: ffprobe,
          src,
          dst,
          opts: { ...quchong.DEFAULTS, encoder: 'cpu' },
        });
        const info = await quchong.probeMedia(ffprobe, dst);
        const want = quchong.deliverySize(w, h);
        assert.equal(info.video_width, want.width, `${w}x${h} 宽`);
        assert.equal(info.video_height, want.height, `${w}x${h} 高`);
        // 画面再简单（测试图案）码率也不低于 4Mbps：固定码率编码。
        const kbps = (fs.statSync(dst).size * 8) / 1000 / info.duration;
        assert.ok(kbps >= 4000, `${w}x${h} 码率 ${Math.round(kbps)}kbps`);
      }
      // 同一部剧里前几集是 360p、后几集是 1080p：拼成一集时按 1080p，不把清晰的集缩成 360p。
      const low = path.join(dir, 'low.mp4');
      const high = path.join(dir, 'high.mp4');
      for (const [file, size] of [
        [low, '360x640'],
        [high, '1080x1920'],
      ]) {
        const made = spawnSync(ffmpeg, [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `testsrc2=size=${size}:rate=24`,
          '-t',
          '1.5',
          '-pix_fmt',
          'yuv420p',
          file,
        ]);
        assert.equal(made.status, 0, String(made.stderr));
      }
      const mixed = path.join(dir, 'mixed.mp4');
      await quchong.runJob({
        ffmpegPath: ffmpeg,
        ffprobePath: ffprobe,
        dst: mixed,
        segments: [
          { src: low, start: 0, duration: 1, speed: 1 },
          { src: high, start: 0, duration: 1, speed: 1 },
        ],
        opts: { ...quchong.DEFAULTS, encoder: 'cpu' },
      });
      const mixedInfo = await quchong.probeMedia(ffprobe, mixed);
      assert.equal(`${mixedInfo.video_width}x${mixedInfo.video_height}`, '1080x1920', '按最清晰的那集');
      console.log('PASS dedup output: below 720p is scaled up to 720p keeping the aspect ratio; bitrate ≥ 4Mbps');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  console.log('PASS dedup output size and bitrate rules (graph only; no ffmpeg)');
}
