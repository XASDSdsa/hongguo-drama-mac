const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const quchong = require('../src/native/quchong');

const execFileAsync = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

async function makeMedia(file, input, duration, audio = false) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-t', String(duration), ...(audio ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] : ['-c:a', 'copy']), file);
  await execFileAsync(ffmpeg, args);
}

async function main() {
  const implementation = await fs.readFile(path.join(__dirname, '..', 'src/native/quchong.js'), 'utf8');
  assert.match(implementation, /PROCESS_IDLE_TIMEOUT_MS\s*=\s*180_000/);
  assert.match(implementation, /长时间无输出/);
  assert.match(implementation, /未自动切换编码器/);
  assert.doesNotMatch(implementation, /probeHardwareEncoders|const candidates/);
  assert.ok(quchong.DEFAULTS.jobs >= 2, `默认并发数过低：${quchong.DEFAULTS.jobs}`);
  assert.equal(quchong.detectEncoder('auto', 'win32', 'NVIDIA GeForce RTX 4060'), 'nvenc');
  assert.equal(quchong.detectEncoder('auto', 'win32', 'AMD Radeon RX 7600'), 'amf');
  assert.equal(quchong.detectEncoder('auto', 'win32', 'Intel(R) UHD Graphics'), 'qsv');
  assert.equal(quchong.detectEncoder('auto', 'darwin'), 'videotoolbox');
  assert.equal(quchong.detectEncoder('auto', 'win32', []), 'cpu');
  assert.equal(quchong.DEFAULTS.encoder, process.platform === 'darwin' ? 'videotoolbox' : process.platform === 'win32' ? 'auto' : 'cpu');
  assert.deepEqual(quchong.encoderArgs('nvenc', false, 720, 1280).slice(0, 2), ['-c:v', 'h264_nvenc']);
  assert.deepEqual(quchong.encoderArgs('amf', false, 720, 1280).slice(0, 2), ['-c:v', 'h264_amf']);
  assert.deepEqual(quchong.encoderArgs('qsv', false, 720, 1280).slice(0, 2), ['-c:v', 'h264_qsv']);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-quchong-'));
  try {
    const src = path.join(dir, 'source.mp4');
    const bgm = path.join(dir, 'bgm.m4a');
    const dst = path.join(dir, 'output.mp4');
    const audioOnlyOutput = path.join(dir, 'audio-only-output.mp4');
    const silent = path.join(dir, 'silent.mp4');
    const silentOutput = path.join(dir, 'silent-output.mp4');
    await makeMedia(src, 'testsrc2=size=320x180:rate=24', 1.2, true);
    await makeMedia(silent, 'testsrc2=size=320x180:rate=24', 1.2, false);
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '2', '-c:a', 'aac', bgm]);
    const opts = {
      ...quchong.DEFAULTS, encoder: 'cpu', quality: 'lean', resolution: '720x1280',
      speed_min: 1, speed_max: 1, pitch_min: 1, pitch_max: 1,
      rotation_max: 0.004, rgb_shift: 0, noise_min: 0, noise_max: 0,
      hue_range: 0, vignette: false, black_intro: false, eq_enable: false,
    };
    await quchong.runJob({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, src, dst: audioOnlyOutput, opts });
    await quchong.runJob({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, src, dst, bgm, opts });
    const output = await quchong.probeMedia(ffprobe, dst);
    if (!output.has_video || !output.has_audio) throw new Error('合成输出缺少音视频轨道');
    if (output.video_width !== 720 || output.video_height !== 1280) throw new Error(`输出尺寸错误：${output.video_width}x${output.video_height}`);
    await quchong.runJob({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, src: silent, dst: silentOutput, bgm, opts });
    const silentResult = await quchong.probeMedia(ffprobe, silentOutput);
    if (!silentResult.has_video || !silentResult.has_audio) throw new Error('无原音+BGM 输出缺少音频轨道');
    try {
      await quchong.runJob({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, src, dst, opts });
      throw new Error('输出覆盖保护失效');
    } catch (error) {
      if (!error.message.includes('已拒绝覆盖')) throw error;
    }
    const cancelDst = path.join(dir, 'cancel.mp4');
    const controller = new AbortController();
    const cancelled = quchong.runJob({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, src, dst: cancelDst, opts, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    try { await cancelled; throw new Error('取消没有中断任务'); } catch (error) { if (!/取消|退出码/.test(error.message)) throw error; }
    const leftovers = (await fs.readdir(dir)).filter((name) => name.startsWith('.hongguo-quchong-'));
    if (leftovers.length) throw new Error(`取消后留下临时文件：${leftovers.join(', ')}`);
    console.log('quchong check passed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
