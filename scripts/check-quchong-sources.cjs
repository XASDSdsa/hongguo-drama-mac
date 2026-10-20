'use strict';
// 各种来源都能正常出片：
//   1. 手机竖拍「横着存 + 旋转 90°」的视频按转正后的宽高处理，成品不被压扁；
//   2. 一集新片跨了画面比例不同的原集：按比例缩小补黑边，不拉伸；
//   3. 个别原集没有音轨：那几段补静音，整集照常出片（以前会报「各集的音轨不一致」）；
//   4. 显卡编码会话满了（同时开的太多 / 别的软件占用）：多出来的集排队等，不算失败。
// 需要 FFmpeg（FFMPEG_PATH / FFPROBE_PATH，默认用 PATH 里的）。
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const quchong = require('../src/native/quchong');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
if (spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status !== 0) {
  console.log('SKIP check-quchong-sources: 没有可用的 FFmpeg');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-sources-'));
const run = (args) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
const make = (name, size, audio) => {
  const file = path.join(work, name);
  run([
    '-f',
    'lavfi',
    '-i',
    `testsrc=s=${size}:r=25:d=3`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:d=3'] : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...(audio ? ['-c:a', 'aac', '-shortest'] : []),
    file,
  ]);
  return file;
};
// 画面中间一小块的平均亮度（0~255），用来判断是不是黑边。
const brightness = (file, at, crop) =>
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(at),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=${crop},scale=1:1,format=gray`,
      '-f',
      'rawvideo',
      '-',
    ],
    { windowsHide: true },
  )[0];

(async () => {
  const portrait = make('portrait.mp4', '360x640', true);
  const landscape = make('landscape.mp4', '640x360', true);
  const silent = make('silent.mp4', '360x640', false);
  const coded = make('coded.mp4', '640x360', true);
  const rotated = path.join(work, 'rotated.mp4');
  let haveRotation = true;
  try {
    run(['-display_rotation', '90', '-i', coded, '-c', 'copy', rotated]);
  } catch (_) {
    haveRotation = false;
  }

  if (haveRotation) {
    const info = await quchong.probeMedia(ffprobe, rotated);
    assert.equal(`${info.video_width}x${info.video_height}`, '360x640', '旋转 90° 的视频按转正后的宽高算');
    const out = path.join(work, 'rotated-out.mp4');
    await quchong.runJob({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src: rotated,
      dst: out,
      opts: { ...quchong.DEFAULTS, encoder: 'cpu', jobs: 1 },
    });
    const result = await quchong.probeMedia(ffprobe, out);
    assert.equal(`${result.video_width}x${result.video_height}`, '360x640', '旋转的视频去重后仍是竖屏，不被压扁');
    console.log('PASS rotated phone video keeps its upright size');
  } else console.log('SKIP rotated case: this FFmpeg has no -display_rotation');

  const segments = [
    { src: portrait, start: 0.2, duration: 1.5, speed: 1.1 },
    { src: silent, start: 0.2, duration: 1.5, speed: 1.2 },
    { src: landscape, start: 0.2, duration: 1.5, speed: 1.05 },
    ...(haveRotation ? [{ src: rotated, start: 0.2, duration: 1.5, speed: 1 }] : []),
  ];
  const out = path.join(work, 'mixed-out.mp4');
  await quchong.runJob({
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    dst: out,
    segments,
    opts: { ...quchong.DEFAULTS, encoder: 'cpu', jobs: 1 },
  });
  const info = await quchong.probeMedia(ffprobe, out);
  const planned = segments.reduce((sum, item) => sum + item.duration / item.speed, 0);
  assert.equal(`${info.video_width}x${info.video_height}`, '360x640', '跨集成片按第一段的尺寸');
  assert.ok(info.has_audio, '有音轨的集和没音轨的集拼在一起，成品仍有声音');
  assert.ok(Math.abs(info.duration - planned) < 0.3, `成片时长 ${info.duration} 应接近计划 ${planned}`);
  // 横屏那一段（第三段）上方应该是补的黑边，不是被拉伸的彩条。
  const landscapeAt = 1.5 / 1.1 + 1.5 / 1.2 + 0.7;
  const top = brightness(out, landscapeAt.toFixed(2), '200:40:80:10');
  assert.ok(top < 90, `横屏片段应按比例缩小补黑边，上方亮度 ${top}`);
  const middle = brightness(out, landscapeAt.toFixed(2), '200:40:80:300');
  assert.ok(middle > top + 30, `横屏片段中间应是画面，亮度 ${middle}`);
  console.log('PASS mixed episodes: silent episode padded with silence, other aspect letterboxed, duration as planned');

  // 非正方形像素（480×640 存储、像素宽高比 4:3，显示出来是 640×640 的正方形画面）。
  const anamorphic = path.join(work, 'anamorphic.mp4');
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=480x640:r=25:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:d=3',
    '-vf',
    'setsar=4/3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    anamorphic,
  ]);
  const anaInfo = await quchong.probeMedia(ffprobe, anamorphic);
  assert.equal(`${anaInfo.video_width}x${anaInfo.video_height}`, '640x640', '按显示宽度算');
  const anaOut = path.join(work, 'anamorphic-out.mp4');
  await quchong.runJob({
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    src: anamorphic,
    dst: anaOut,
    opts: { ...quchong.DEFAULTS, encoder: 'cpu', jobs: 1 },
  });
  const anaResult = await quchong.probeMedia(ffprobe, anaOut);
  assert.equal(`${anaResult.video_width}x${anaResult.video_height}`, '640x640', '单集去重后仍是正方形画面');
  // 拼进竖屏成片：正方形画面缩到 360×360、上下补黑边，不被压成 360×640。
  const anaPiece = path.join(work, 'anamorphic-piece.mp4');
  await quchong.runJob({
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    dst: anaPiece,
    segments: [
      { src: portrait, start: 0.2, duration: 1, speed: 1 },
      { src: anamorphic, start: 0.2, duration: 1.5, speed: 1 },
    ],
    opts: { ...quchong.DEFAULTS, encoder: 'cpu', jobs: 1 },
  });
  const anaTop = brightness(anaPiece, '1.7', '200:40:80:20');
  const anaMiddle = brightness(anaPiece, '1.7', '200:40:80:300');
  assert.ok(anaTop < 90 && anaMiddle > anaTop + 30, `正方形画面应上下补黑边：上 ${anaTop} 中 ${anaMiddle}`);
  console.log('PASS non-square pixels: shown at display size, letterboxed inside a portrait piece');

  // 显卡编码会话上限：假 FFmpeg 只给 2 个 h264_nvenc 会话，4 路同时跑 6 集。
  if (process.platform === 'win32') {
    console.log('SKIP nvenc session queue on Windows (bash fake encoder)');
  } else {
    const slots = path.join(work, 'slots');
    fs.mkdirSync(slots);
    const fake = path.join(work, 'fake-nvenc.sh');
    fs.writeFileSync(
      fake,
      `#!/bin/bash
slot=""
if printf '%s\\n' "$@" | grep -qx h264_nvenc; then
  for i in 1 2; do if mkdir "${slots}/s$i" 2>/dev/null; then slot=$i; break; fi; done
  if [ -z "$slot" ]; then
    echo "[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: incompatible client key (21): (no details)" >&2
    exit 1
  fi
fi
args=(); prev=""; skip=0
for a in "$@"; do
  # NVENC 才有的选项（-tune hq、-rc vbr、-spatial-aq 1）连同取值一起去掉，x264 认不得。
  if [ $skip -eq 1 ]; then skip=0; prev="$a"; continue; fi
  case "$a" in -tune|-rc|-spatial-aq) skip=1; prev="$a"; continue;; esac
  if [ "$prev" = "-preset" ] && [[ "$a" == p[1-7] ]]; then args+=("ultrafast"); prev="$a"; continue; fi
  case "$a" in h264_nvenc) args+=("libx264");; -cq) args+=("-crf");; *) args+=("$a");; esac
  prev="$a"
done
"${ffmpeg}" "\${args[@]}"; rc=$?
[ -n "$slot" ] && rmdir "${slots}/s$slot"
exit $rc
`,
      { mode: 0o755 },
    );
    const queue = Array.from({ length: 6 }, (_, i) => i);
    let ok = 0;
    const failures = [];
    const logs = [];
    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        try {
          await quchong.runJob({
            ffmpegPath: fake,
            ffprobePath: ffprobe,
            src: portrait,
            dst: path.join(work, `nv-${i}.mp4`),
            opts: { ...quchong.DEFAULTS, encoder: 'nvenc', jobs: 4 },
            onLog: (line) => logs.push(line),
          });
          ok += 1;
        } catch (error) {
          failures.push(error.message.split('\n')[0]);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    assert.deepEqual(failures, [], '会话满了应排队等，不应失败');
    assert.equal(ok, 6);
    assert.ok(
      logs.some((line) => line.includes('[排队]')),
      '会话满时日志里说明在排队',
    );
    console.log(
      'PASS nvenc session limit: extra episodes wait for a free session instead of failing (6/6 with 2 sessions)',
    );
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(work, { recursive: true, force: true }));
