const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const quchong = require('../src/native/quchong');

const execFileAsync = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

async function makeMedia(file, input, duration, audio = false) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push(
    '-t',
    String(duration),
    ...(audio ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] : ['-c:a', 'copy']),
    file,
  );
  await execFileAsync(ffmpeg, args);
}

async function runJobCase(label, options) {
  console.log(`RUN ${label}`);
  const result = await quchong.runJob({
    ...options,
    onStage: (stage) => {
      console.log(`  ${label}: ${stage}`);
      options.onStage?.(stage);
    },
    onLog: (line) => {
      console.log(`  ${label}: ${line}`);
      options.onLog?.(line);
    },
  });
  console.log(`PASS ${label}`);
  return result;
}

async function checkQuietProcess(implementation) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal);
    return true;
  };
  let now = 0;
  const timers = new Set();
  const advance = (ms) => {
    now += ms;
    for (const timer of [...timers]) {
      if (timer.due <= now) {
        timers.delete(timer);
        timer.fn();
      }
    }
  };
  const context = {
    require: (name) => (name === 'node:child_process' ? { ...require(name), spawn: () => child } : require(name)),
    process,
    module: { exports: {} },
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      const timer = { fn, due: now + ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  };
  vm.runInNewContext(`${implementation}\nmodule.exports.testRunProcess = runProcess;`, context);
  const stages = [],
    progress = [],
    logs = [];
  let settled = false;
  const run = context.module.exports.testRunProcess(
    'ffmpeg',
    [],
    100,
    (value) => progress.push(value),
    null,
    (stage) => stages.push(stage),
    (line) => logs.push(line),
  );
  run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const sample =
    'frame=2352\nfps=23.5\nout_time_us=98000000\nout_time=00:01:38.000000\nspeed=1.5x\nprogress=continue\n';
  child.stdout.write(sample);
  child.stdout.write(sample);
  assert.equal(logs.length, 1, '重复 progress 块不能刷屏日志');
  assert.match(logs[0], /frame=2352 fps=23.5 out_time=00:01:38.000000 speed=1.5x/);
  advance(600_000);
  await Promise.resolve();
  assert.equal(settled, false, '静默十分钟不能把仍运行的长视频判失败');
  assert.deepEqual(kills, [], '静默不能触发终止编码');
  assert.deepEqual(stages, [], '98% 不能被猜测为正在收尾');
  child.stderr.write('[mp4 @ test] Starting second pass: moving the mo');
  child.stderr.write('ov atom to the beginning of the file\n');
  advance(600_000);
  assert.deepEqual(stages, ['finalizing'], '收尾状态必须来自真实 muxer 日志');
  assert.deepEqual(kills, [], '大文件 faststart 静默期间不能被终止');
  child.stdout.write('out_time_us=99900000\nprogress=end\n');
  await Promise.resolve();
  assert.equal(settled, false, 'progress=end 不等于进程已成功退出');
  assert.equal(progress.at(-1), 99, '落盘验证前不能报告 100%');
  assert.equal(logs.length, 3, '真实faststart和progress=end必须立即记录日志');
  child.exitCode = 0;
  child.emit('close', 0, null);
  await run;
  assert.equal(settled, true);

  child.exitCode = null;
  const failedProgress = [];
  const failed = context.module.exports.testRunProcess('ffmpeg', [], 100, (value) => failedProgress.push(value), null);
  child.stdout.write('frame=0\nfps=0.00\nout_time_us=N/A\nout_time=N/A\nspeed=N/A\nprogress=end\n');
  assert.deepEqual(failedProgress, [], '零帧失败的 progress=end 不能伪装成 99%');
  child.stderr.write('No space left on device\n');
  child.exitCode = 1;
  child.emit('close', 1, null);
  await assert.rejects(failed, /ffmpeg 退出码 1[\s\S]*No space left on device/, '真实错误必须保留退出码和诊断');
}

async function checkNvencApiMismatch(implementation) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-nvenc-api-'));
  const diagnostics =
    '[h264_nvenc @ test] Driver does not support the required nvenc API version. Required: 13.1 Found: 12.2\n[h264_nvenc @ test] The minimum required Nvidia driver for nvenc is 610.00 or newer\nConversion failed!\n';
  let spawnCount = 0;
  const context = {
    require: (name) =>
      name === 'node:child_process'
        ? {
            execFile: (_file, _args, _opts, callback) => {
              const child = new EventEmitter();
              setImmediate(() =>
                callback(
                  null,
                  JSON.stringify({
                    format: { duration: '10' },
                    streams: [{ codec_type: 'video', width: 1080, height: 1920, duration: '10' }],
                  }),
                  '',
                ),
              );
              return child;
            },
            spawn: (_file, args) => {
              spawnCount++;
              assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc');
              const child = new EventEmitter();
              child.stdout = new PassThrough();
              child.stderr = new PassThrough();
              child.exitCode = null;
              setImmediate(() => {
                child.stderr.write(diagnostics.slice(0, 70));
                child.stderr.write(diagnostics.slice(70));
                child.stdout.write('frame=0\nfps=0.00\nout_time_us=N/A\nout_time=N/A\nspeed=N/A\nprogress=end\n');
                child.exitCode = 1;
                child.emit('close', 1, null);
              });
              return child;
            },
          }
        : require(name),
    process,
    module: { exports: {} },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(implementation, context);
  const progress = [];
  const dst = path.join(dir, 'output.mp4');
  try {
    await assert.rejects(
      context.module.exports.runJob({
        ffmpegPath: 'mock-ffmpeg',
        ffprobePath: 'mock-ffprobe',
        src: path.join(dir, 'source.mp4'),
        dst,
        opts: { ...quchong.DEFAULTS, encoder: 'nvenc' },
        onProgress: (value) => progress.push(value),
      }),
      (error) => {
        assert.match(error.message, /FFmpeg 需要 NVENC API 13\.1，当前显卡驱动提供 12\.2/);
        assert.match(error.message, /与当前驱动 API 兼容的 FFmpeg 构建/);
        assert.ok(error.message.endsWith(`ffmpeg 退出码 1\n${diagnostics}`), '友好说明必须保留退出码及原始完整诊断');
        return true;
      },
    );
    assert.equal(spawnCount, 1, 'API 版本不兼容不能触发自动更换编码器');
    assert.deepEqual(progress, [], '初始化失败且零帧不得显示编码已完成');
    assert.deepEqual(await fs.readdir(dir), [], '失败后不得留下成品或临时文件');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const implementation = await fs.readFile(path.join(__dirname, '..', 'src/native/quchong.js'), 'utf8');
  await checkQuietProcess(implementation);
  console.log('PASS quiet encoding/faststart for simulated 20 minutes; real exit controls completion');
  await checkNvencApiMismatch(implementation);
  console.log('PASS real runJob NVENC API mismatch preserves driver versions and original diagnostics');
  assert.match(implementation, /未自动切换编码器/);
  assert.doesNotMatch(implementation, /probeHardwareEncoders|const candidates/);
  assert.ok(quchong.DEFAULTS.jobs >= 2, `默认并发数过低：${quchong.DEFAULTS.jobs}`);
  assert.equal(quchong.detectEncoder('auto', 'win32', 'NVIDIA GeForce RTX 4060'), 'nvenc');
  assert.equal(quchong.detectEncoder('auto', 'win32', 'AMD Radeon RX 7600'), 'amf');
  assert.equal(quchong.detectEncoder('auto', 'win32', 'Intel(R) UHD Graphics'), 'qsv');
  assert.equal(quchong.detectEncoder('auto', 'darwin'), 'videotoolbox');
  assert.equal(quchong.detectEncoder('auto', 'win32', []), 'cpu');
  quchong.setWindowsAdapters(['NVIDIA', 'Intel']);
  assert.equal(quchong.resolveEncoder('auto', 'win32'), 'nvenc');
  quchong.setWindowsAdapters(['AMD']);
  assert.equal(quchong.resolveEncoder('auto', 'win32'), 'amf');
  quchong.setWindowsAdapters([]);
  assert.equal(quchong.resolveEncoder('auto', 'win32'), 'cpu');
  assert.equal(
    quchong.DEFAULTS.encoder,
    process.platform === 'darwin' ? 'videotoolbox' : process.platform === 'win32' ? 'auto' : 'cpu',
  );
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
    const longAudio = path.join(dir, 'long-audio.mp4');
    const longAudioOutput = path.join(dir, 'long-audio-output.mp4');
    const delayedVideo = path.join(dir, 'delayed-video.mp4');
    const delayedOutput = path.join(dir, 'delayed-output.mp4');
    const portrait = path.join(dir, 'portrait.mp4');
    await makeMedia(src, 'testsrc2=size=320x180:rate=24', 1.2, true);
    await makeMedia(silent, 'testsrc2=size=320x180:rate=24', 1.2, false);
    await makeMedia(portrait, 'testsrc2=size=180x320:rate=24', 1.2, true);
    await execFileAsync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=44100',
      '-t',
      '2',
      '-c:a',
      'aac',
      bgm,
    ]);
    await execFileAsync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=1.2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      longAudio,
    ]);
    await execFileAsync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-itsoffset',
      '0.5',
      '-i',
      src,
      '-i',
      src,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      delayedVideo,
    ]);
    const opts = {
      ...quchong.DEFAULTS,
      encoder: 'cpu',
      quality: 'lean',
      speed_min: 1,
      speed_max: 1,
      pitch_min: 1,
      pitch_max: 1,
      rotation_max: 0.004,
      rgb_shift: 0,
      noise_min: 0,
      noise_max: 0,
      hue_range: 0,
      vignette: false,
      black_intro: false,
      eq_enable: false,
    };
    const stages = [],
      progress = [];
    await runJobCase('source audio', {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src,
      dst: audioOnlyOutput,
      opts,
      onStage: (stage) => stages.push(stage),
      onProgress: (value) => progress.push(value),
    });
    assert.deepEqual(
      stages,
      ['probing', 'encoding', 'finalizing', 'validating', 'saving'],
      '真实编码必须依次进入收尾、验证和保存阶段',
    );
    assert.equal(progress.at(-1), 100);
    assert.ok(
      progress.slice(0, -1).every((value) => value < 100),
      '文件验证保存前不得完成',
    );
    await runJobCase('source audio with looping BGM', {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src,
      dst,
      bgm,
      opts,
    });
    const output = await quchong.probeMedia(ffprobe, dst);
    if (!output.has_video || !output.has_audio) throw new Error('合成输出缺少音视频轨道');
    const sourceSize = await quchong.probeMedia(ffprobe, src);
    if (output.video_width !== sourceSize.video_width || output.video_height !== sourceSize.video_height)
      throw new Error(`输出必须保持原分辨率：${output.video_width}x${output.video_height}`);
    await runJobCase('silent video with looping BGM', {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src: silent,
      dst: silentOutput,
      bgm,
      opts,
    });
    const silentResult = await quchong.probeMedia(ffprobe, silentOutput);
    if (!silentResult.has_video || !silentResult.has_audio) throw new Error('无原音+BGM 输出缺少音频轨道');
    const longAudioMedia = await quchong.probeMedia(ffprobe, longAudio);
    assert.ok(longAudioMedia.duration > 3.9 && longAudioMedia.video_duration < 1.3);
    const command = quchong.buildCommand({
      src: longAudio,
      dst: longAudioOutput,
      opts,
      media: longAudioMedia,
      encoder: 'cpu',
    });
    assert.equal(command.duration, longAudioMedia.video_duration, '进度估时不能取更长的音频/容器时长');
    await runJobCase('short video with longer audio and looping BGM', {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src: longAudio,
      dst: longAudioOutput,
      bgm,
      opts,
    });
    const longAudioResult = await quchong.probeMedia(ffprobe, longAudioOutput);
    assert.ok(longAudioResult.duration < 1.7, '长音频与循环 BGM 不能使视频任务无限运行');
    const shifted = { ...longAudioMedia, has_audio: false, video_start: 5, audio_start: 0 };
    assert.equal(
      quchong.buildCommand({ src, dst, opts, media: shifted, encoder: 'cpu' }).duration,
      shifted.video_duration,
      '无声视频的非零起始时间已归零，不能重复计入进度时长',
    );
    const delayedMedia = await quchong.probeMedia(ffprobe, delayedVideo);
    const delayedCommand = quchong.buildCommand({
      src: delayedVideo,
      dst: delayedOutput,
      opts,
      media: delayedMedia,
      encoder: 'cpu',
    });
    assert.ok(delayedMedia.video_start >= 0.49);
    assert.ok(Math.abs(delayedCommand.duration - delayedMedia.video_duration - 0.5) < 0.02, '有声视频偏移只应累计一次');
    await runJobCase('video delayed by 0.5 seconds with looping BGM', {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src: delayedVideo,
      dst: delayedOutput,
      bgm,
      opts,
    });
    const delayedResult = await quchong.probeMedia(ffprobe, delayedOutput);
    assert.ok(Math.abs(delayedResult.video_duration - delayedCommand.duration) < 0.1, '音画偏移样本输出时长错误');
    // Exercise exactly the production 1080p defaults, including noise, RGB
    // shift, rotation, vignette, pitch/EQ and black intro, on concurrent jobs.
    // The hardware is pinned to CPU so the same test runs on every CI host.
    const defaultOpts = { ...quchong.DEFAULTS, encoder: 'cpu' };
    let active = 0,
      peakActive = 0;
    const parallel = await Promise.all(
      [0, 1].map(async (index) => {
        const target = path.join(dir, `default-parallel-${index}.mp4`);
        const progress = [],
          stages = [];
        const result = await runJobCase(`default 1080p filters, parallel job ${index + 1}`, {
          ffmpegPath: ffmpeg,
          ffprobePath: ffprobe,
          src: portrait,
          dst: target,
          opts: defaultOpts,
          onProgress: (value) => progress.push(value),
          onStage: (stage) => {
            stages.push(stage);
            if (stage === 'encoding') {
              active += 1;
              peakActive = Math.max(peakActive, active);
            }
            if (stage === 'saving') active -= 1;
          },
        });
        const info = await quchong.probeMedia(ffprobe, target);
        const sourceInfo = await quchong.probeMedia(ffprobe, portrait);
        assert.equal(info.video_width, sourceInfo.video_width, '不改分辨率');
        assert.equal(info.video_height, sourceInfo.video_height, '不改分辨率');
        assert.equal(info.has_audio, true);
        assert.equal(progress.at(-1), 100);
        assert.deepEqual(stages, ['probing', 'encoding', 'finalizing', 'validating', 'saving']);
        const source = await quchong.probeMedia(ffprobe, portrait);
        assert.ok(
          Math.abs(info.video_duration - source.video_duration / result.rolled.SPEED - 0.3) < 0.1,
          '默认变速+黑片头的输出时长错误',
        );
        return result;
      }),
    );
    assert.equal(peakActive, 2, '默认完整滤镜必须支持两个并行任务');
    assert.equal(parallel.length, 2);
    console.log('PASS default 1080p filters with two concurrent jobs');
    try {
      await quchong.runJob({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, src, dst, opts });
      throw new Error('输出覆盖保护失效');
    } catch (error) {
      if (!error.message.includes('已拒绝覆盖')) throw error;
    }
    // 取消要在任务还在跑的时候发生：机器快的话 50 毫秒任务就跑完了，所以等 ffmpeg 真正启动后立刻取消，
    // 用一个够长的源视频，避免「任务先跑完」造成偶发失败。
    const longSrc = path.join(dir, 'long-source.mp4');
    await execFileAsync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '120',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      longSrc,
    ]);
    const cancelDst = path.join(dir, 'cancel.mp4');
    const controller = new AbortController();
    const cancelled = quchong.runJob({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      src: longSrc,
      dst: cancelDst,
      opts,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    try {
      await cancelled;
      throw new Error('取消没有中断任务');
    } catch (error) {
      if (!/取消|退出码/.test(error.message)) throw error;
    }
    const leftovers = (await fs.readdir(dir)).filter((name) => name.startsWith('.hongguo-quchong-'));
    if (leftovers.length) throw new Error(`取消后留下临时文件：${leftovers.join(', ')}`);
    console.log('quchong check passed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
