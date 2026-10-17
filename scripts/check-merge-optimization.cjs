// Metadata-only checks. No GUI, network, playback, FFmpeg or source-file writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function checkPublish() {
  const { publishMergedOutput } = require('../src/native/merge-runner');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'merge-publish-'));
  const source = path.join(root, 'source.mp4'),
    target = path.join(root, 'output.mp4');
  const link = fs.linkSync,
    copy = fs.copyFileSync;
  let copies = 0;
  fs.writeFileSync(source, 'verified video');
  try {
    fs.copyFileSync = (...args) => {
      copies++;
      return copy(...args);
    };
    publishMergedOutput(source, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'verified video');
    assert.equal(copies, 0, 'supported hard-link must not duplicate bytes');
    assert.throws(() => publishMergedOutput(source, target), { code: 'EEXIST' });
    assert.equal(copies, 0, 'EEXIST must never fall back to copying');
    fs.unlinkSync(target);
    for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS']) {
      fs.linkSync = () => {
        throw Object.assign(new Error(code), { code });
      };
      publishMergedOutput(source, target);
      assert.equal(fs.readFileSync(target, 'utf8'), 'verified video');
      assert.throws(() => publishMergedOutput(source, target), { code: 'EEXIST' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'verified video', 'fallback must preserve existing output');
      fs.unlinkSync(target);
    }
    const missingDestination = path.join(root, 'missing-directory', 'output.mp4');
    assert.throws(() => publishMergedOutput(source, missingDestination), { code: 'ENOENT' });
    assert.equal(fs.existsSync(missingDestination), false, 'failed fallback must not publish a partial result');
    assert.equal(fs.readFileSync(source, 'utf8'), 'verified video', 'publishing must not modify source');
    console.log(
      'PASS publish: hard-link, unsupported-filesystem fallback, no overwrite, failed-copy/source preservation',
    );
  } finally {
    fs.linkSync = link;
    fs.copyFileSync = copy;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv.includes('--publish-only')) {
  checkPublish();
  process.exit(0);
}
const modulePath = path.resolve(__dirname, '../src/native/merge-plan.js');
assert.ok(fs.existsSync(modulePath), '缺少智能合并计划：兼容 H.264 仍会全量转码，固定 6 Mbps 会放大低码率源文件');
const { readMergeInfo, buildMergePlan, canUseHardwareFrames } = require(modulePath);
const video = {
  codec_type: 'video',
  codec_name: 'h264',
  codec_tag_string: 'avc1',
  profile: 'High',
  level: 31,
  width: 720,
  height: 1280,
  pix_fmt: 'yuv420p',
  sample_aspect_ratio: '1:1',
  r_frame_rate: '25/1',
  time_base: '1/12800',
  extradata_hash: 'SHA256:same',
  bit_rate: '650000',
};
const audio = {
  codec_type: 'audio',
  codec_name: 'aac',
  profile: 'LC',
  sample_rate: '48000',
  channels: 2,
  channel_layout: 'stereo',
  time_base: '1/48000',
  extradata_hash: 'SHA256:audio',
  bit_rate: '64000',
};
const info = (v = {}, a = {}, duration = 20) =>
  readMergeInfo({
    streams: [{ ...video, ...v }, ...(a === null ? [] : [{ ...audio, ...a }])],
    format: { duration: String(duration), bit_rate: '720000', size: '1800000' },
  });
const plan = (infos, compatible = false) => buildMergePlan(infos, { compatible });
function checkHardware() {
  const media = [info(), info({ codec_name: 'hevc' })],
    target = plan(media);
  assert.equal(canUseHardwareFrames(media, target, 'h264_videotoolbox'), true);
  assert.equal(canUseHardwareFrames(media, target, 'libx264'), false);
  for (const mismatch of [
    { width: 1080 },
    { pix_fmt: 'yuv420p10le' },
    { sample_aspect_ratio: '4:3' },
    { codec_name: 'av1' },
  ]) {
    assert.equal(
      canUseHardwareFrames([info(), info(mismatch)], target, 'h264_videotoolbox'),
      false,
      'ineligible input must keep the normal conversion path',
    );
  }
  console.log('PASS hardware decode eligibility: matching H.264/HEVC, 8bit, dimensions, pixel aspect and encoder');
}
if (process.argv.includes('--hardware-only')) {
  checkHardware();
  process.exit(0);
}
let p = plan([info(), info({ bit_rate: '900000' })], true);
assert.equal(p.videoMode, 'copy', 'already compatible H.264 must not be transcoded');
assert.equal(p.audioMode, 'copy');
assert.equal(p.remux, false, 'bitrate differences alone are harmless');
p = plan([
  info({ codec_name: 'hevc', codec_tag_string: 'hvc1' }),
  info({ codec_name: 'hevc', codec_tag_string: 'hvc1' }),
]);
assert.equal(p.videoMode, 'copy', 'matching HEVC remains lossless in fast mode');
assert.equal(plan([info({ codec_name: 'hevc' }), info({ codec_name: 'hevc' })], true).videoMode, 'encode');
p = plan([info(), info({ time_base: '1/90000' })]);
assert.equal(p.videoMode, 'copy', 'container timebase difference only needs remux');
assert.equal(p.remux, true);
p = plan([info(), info({}, { sample_rate: '44100', time_base: '1/44100' })]);
assert.equal(p.videoMode, 'copy', 'audio-only mismatch must preserve video');
assert.equal(p.audioMode, 'encode');
assert.equal(plan([info({}, null), info({}, null)]).audioMode, 'none', 'all-silent inputs stay silent');
assert.equal(plan([info({}, null), info()]).audioMode, 'encode', 'mixed audio presence needs silence fill');
for (const mismatch of [
  { codec_name: 'hevc' },
  { width: 1080, height: 1920 },
  { extradata_hash: 'SHA256:different' },
  { extradata_hash: undefined },
]) {
  p = plan([info(), info(mismatch)]);
  assert.equal(p.videoMode, 'encode', 'unsafe bitstreams must use one encoder for the entire pass');
}
p = plan([info(), info({ codec_name: 'hevc' })]);
assert.ok(
  p.videoBitrate >= 650000 && p.videoBitrate <= 2000000,
  `source-aware bitrate must avoid fixed 6 Mbps, got ${p.videoBitrate}`,
);
assert.equal(p.fps, 25, 'do not invent 30 fps when source has 25 fps');
assert.ok(p.estimatedBytes > 0 && p.estimatedBytes < 15000000);
assert.equal(p.totalDuration, 40);
assert.throws(() => plan([info({}, {}, 0)]), /时长|duration/);
const uiSource = fs.readFileSync(path.resolve(__dirname, '../src/components/DownloadManager.jsx'), 'utf8');
const sortingSource = uiSource.slice(uiSource.indexOf('const STATUS_ORDER'), uiSource.indexOf('function fmtBytes'));
const sortTasks = require('node:vm').runInNewContext(sortingSource + '; sortTasks');
const sorted = sortTasks(
  [72, 70, 71].map((index, i) => ({
    id: String(index),
    status: i === 1 ? 'pending' : 'completed',
    endTime: index * 100,
    hongguoInfo: { series_id: 'same', vid_index: index },
  })),
);
assert.deepEqual(
  Array.from(sorted, (task) => task.hongguoInfo.vid_index),
  [70, 71, 72],
  'episodes in the same series must stay in natural order across completion events',
);
checkPublish();
checkHardware();
console.log(
  'PASS merge planning: lossless copy, H.264 compatibility, HEVC, timebase remux, audio-only repair, missing audio, unsafe bitstreams, source bitrate and duration',
);
