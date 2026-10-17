'use strict';
// 去重不改分辨率：成品和原视频一样大（宽高取偶数），横屏也保持横屏，不加黑边、不做模糊背景。
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
  [719, 1279, 718, 1278],
]) {
  const filter = graph(w, h);
  assert.ok(filter.includes(`scale=${ew}:${eh},setsar=1`), `${w}x${h} 必须缩回 ${ew}x${eh}：${filter}`);
  assert.ok(!/(^|[,;\]])pad=|overlay|boxblur|split=/.test(filter), '不能再加黑边或模糊背景');
}
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
        assert.equal(info.video_width, Math.floor(w / 2) * 2, `${w}x${h} 宽`);
        assert.equal(info.video_height, Math.floor(h / 2) * 2, `${w}x${h} 高`);
      }
      console.log('PASS dedup keeps the original resolution');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  console.log('PASS dedup keeps the original resolution (graph only; no ffmpeg)');
}
