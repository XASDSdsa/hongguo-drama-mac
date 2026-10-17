const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildMergePlan, canUseHardwareFrames } = require('./merge-plan');

function publishMergedOutput(source, destination) {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
    // FAT/exFAT cannot hard-link. COPYFILE_EXCL refuses existing files; Node removes an incomplete destination on copy failure.
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

function stopMergeChildren(task) {
  for (const child of new Set([task.child, ...(task.children || [])].filter(Boolean))) {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, 2000);
    child.once('close', () => clearTimeout(timer));
  }
}

async function runMerge({ task, ordered, outDir, ffmpegPath, ffprobePath, probe, pickEncoder, compatible, update }) {
  Object.defineProperty(task, 'children', { value: new Set(), configurable: true });
  let temporary,
    lastUpdate = 0,
    stageStarted = Date.now();
  task.phaseTimings = {};
  const check = () => {
    if (task.cancelled) throw new Error('已取消');
  };
  const emit = (force = false) => {
    task.elapsedSeconds = (Date.now() - task.startTime) / 1000;
    if (force || Date.now() - lastUpdate > 500) {
      lastUpdate = Date.now();
      update();
    }
  };
  const recordStage = () => {
    if (task.stage)
      task.phaseTimings[task.stage] = (task.phaseTimings[task.stage] || 0) + (Date.now() - stageStarted) / 1000;
    stageStarted = Date.now();
  };
  const stage = (name, text) => {
    recordStage();
    task.stage = name;
    task.stageText = text;
    task.speed = 0;
    task.etaSeconds = null;
    emit(true);
  };
  const run = (args, onTime) =>
    new Promise((resolve, reject) => {
      if (task.cancelled) return reject(new Error('已取消'));
      const child = spawn(
        ffmpegPath,
        ['-y', '-hide_banner', '-loglevel', 'error', ...args, '-progress', 'pipe:1', '-nostats'],
        { windowsHide: true },
      );
      task.children.add(child);
      let pending = '',
        errors = '',
        frames = 0,
        spawnError;
      child.stdout.on('data', (data) => {
        pending += data.toString();
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) onTime?.(Math.max(0, Number(line.slice(12)) / 1e6 || 0));
          if (line.startsWith('frame=')) frames = Number(line.slice(6)) || frames;
        }
      });
      child.stderr.on('data', (data) => {
        errors = (errors + data.toString()).slice(-2400);
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (code) => {
        task.children.delete(child);
        if (task.cancelled) reject(new Error('已取消'));
        else if (spawnError) reject(new Error('无法启动 FFmpeg: ' + spawnError.message));
        else if (code !== 0) reject(new Error(`FFmpeg 退出码 ${code}：${errors.trim() || '没有返回错误详情'}`));
        else resolve({ frames });
      });
    });
  try {
    stage('checking', '检查分集');
    const infos = [];
    for (let i = 0; i < ordered.length; i++) {
      check();
      const info = await probe(ffprobePath, ordered[i].path, task);
      check();
      if (!info || info.duration <= 0)
        throw new Error(`第 ${ordered[i].vid_index} 集无法读取有效视频信息，请重新下载本集`);
      infos.push(info);
      task.checked = i + 1;
      emit();
    }
    const plan = buildMergePlan(infos, { compatible });
    task.totalDuration = plan.totalDuration;
    const normalize = plan.videoMode === 'encode' || plan.audioMode === 'encode' || plan.remux;
    task.method =
      plan.videoMode === 'encode'
        ? '统一视频编码'
        : plan.audioMode === 'encode'
          ? '保留画质，仅统一音频'
          : plan.remux
            ? '无损统一封装'
            : '无损快速合并';
    task.codecWarning = plan.videoMode === 'encode' ? '分集编码不一致，按源画质统一为 H.264；原文件保留' : '';
    task.targetBitrate = plan.videoMode === 'encode' ? plan.videoBitrate : null;
    const estimate = plan.videoMode === 'encode' ? plan.estimatedBytes : task.totalBytes * 1.1;
    const required = estimate * (normalize ? 2.2 : 1.1);
    try {
      const st = fs.statfsSync(outDir),
        free = st.bavail * st.bsize;
      if (free < required)
        throw new Error(
          `磁盘空间不足：需要约 ${(required / 1073741824).toFixed(1)} GB，可用 ${(free / 1073741824).toFixed(1)} GB`,
        );
    } catch (error) {
      if (error.message.startsWith('磁盘空间不足')) throw error;
    }
    check();
    temporary = await fs.promises.mkdtemp(path.join(outDir, '.merge-'));
    let files = ordered.map((e) => e.path);
    if (normalize) {
      let encoder = plan.videoMode === 'encode' ? await pickEncoder(ffmpegPath, task) : null;
      let hardwareFrames = canUseHardwareFrames(infos, plan, encoder);
      check();
      const normalizeAll = async () => {
        stage(
          'preparing',
          plan.videoMode === 'encode' ? '统一视频编码' : plan.audioMode === 'encode' ? '统一音频' : '无损统一封装',
        );
        const times = ordered.map(() => 0),
          targets = ordered.map((_, i) => path.join(temporary, `${i}.mp4`));
        const started = Date.now();
        let next = 0,
          failure;
        task.done = 0;
        task.progress = 0;
        task.encoder = encoder || 'copy';
        task.decoder = hardwareFrames ? 'videotoolbox' : 'software';
        // Two hardware sessions avoid monopolising the device; software uses one bounded four-thread encoder.
        const concurrency = encoder && encoder !== 'libx264' ? 2 : 1;
        task.concurrency = concurrency;
        emit(true);
        const worker = async () => {
          while (!failure && next < ordered.length) {
            const i = next++;
            try {
              check();
              const args = [
                ...(hardwareFrames ? ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld'] : []),
                '-i',
                ordered[i].path,
              ];
              if (plan.audioMode === 'encode' && !infos[i].audio)
                args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
              args.push('-map', '0:v:0');
              if (plan.audioMode !== 'none') args.push('-map', infos[i].audio ? '0:a:0' : '1:a:0');
              if (plan.videoMode === 'encode') {
                const geometry = hardwareFrames
                  ? ''
                  : `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,`;
                args.push(
                  '-vf',
                  `${geometry}setsar=1,fps=${plan.fps},settb=1/90000,setpts=PTS-STARTPTS`,
                  '-c:v',
                  encoder,
                  ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-threads', '4'] : []),
                  '-b:v',
                  String(plan.videoBitrate),
                  '-maxrate',
                  String(plan.videoBitrate * 1.5),
                  '-bufsize',
                  String(plan.videoBitrate * 3),
                  '-profile:v',
                  'high',
                  ...(hardwareFrames ? [] : ['-pix_fmt', 'yuv420p']),
                  '-bf',
                  '0',
                  '-g',
                  String(Math.round(plan.fps * 2)),
                );
              } else args.push('-c:v', 'copy');
              args.push('-video_track_timescale', '90000');
              if (plan.audioMode === 'encode')
                args.push(
                  '-af',
                  'aresample=48000:async=1:first_pts=0,apad',
                  '-c:a',
                  'aac',
                  '-b:a',
                  String(plan.audioBitrate),
                  '-ar',
                  '48000',
                  '-ac',
                  '2',
                );
              else if (plan.audioMode === 'copy') args.push('-c:a', 'copy');
              else args.push('-an');
              args.push('-t', String(infos[i].duration), '-map_metadata', '-1', '-f', 'mp4', targets[i]);
              await run(args, (seconds) => {
                times[i] = Math.min(seconds, infos[i].duration);
                const processed = times.reduce((sum, value) => sum + value, 0);
                task.progress = Math.min(89, Math.floor((processed / plan.totalDuration) * 90));
                task.speed = processed / Math.max(0.1, (Date.now() - started) / 1000);
                task.etaSeconds = task.speed > 0 ? Math.max(0, (plan.totalDuration - processed) / task.speed) : null;
                emit();
              });
              times[i] = infos[i].duration;
              task.done++;
              emit(true);
            } catch (error) {
              if (!failure) {
                failure = error;
                stopMergeChildren(task);
              }
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        if (failure) throw failure;
        return targets;
      };
      for (;;) {
        try {
          files = await normalizeAll();
          break;
        } catch (error) {
          check();
          if (!encoder || encoder === 'libx264') throw error;
          // Every child has closed. Restart the whole pass; never mix settings or encoders.
          for (let i = 0; i < ordered.length; i++)
            await fs.promises.rm(path.join(temporary, `${i}.mp4`), { force: true });
          if (hardwareFrames) {
            hardwareFrames = false;
            task.codecWarning = '硬件解码不可用，已切换常规解码；仍使用硬件编码';
          } else {
            task.codecWarning = '硬件编码不可用，已完整切换软件编码；原文件保留';
            encoder = 'libx264';
          }
        }
      }
      // Even one encoder can choose a different header for different inputs. Never silently concatenate it.
      let reference;
      for (const file of files) {
        check();
        const info = await probe(ffprobePath, file, task);
        if (!info || (reference && info.signature !== reference.signature))
          throw new Error('统一后的分集参数仍不一致，已停止合并；原文件保留');
        reference = info;
      }
    }
    check();
    stage('joining', '写入合并文件');
    const listPath = path.join(temporary, 'list.ffconcat'),
      tmpOutput = path.join(temporary, 'output.mp4');
    fs.writeFileSync(
      listPath,
      files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n',
    );
    const joinedAt = Date.now();
    await run(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        tmpOutput,
      ],
      (seconds) => {
        task.progress = Math.min(
          97,
          Math.floor((normalize ? 90 : 0) + Math.min(1, seconds / plan.totalDuration) * (normalize ? 7 : 97)),
        );
        task.speed = seconds / Math.max(0.1, (Date.now() - joinedAt) / 1000);
        task.etaSeconds = task.speed ? Math.max(0, (plan.totalDuration - seconds) / task.speed) : null;
        if (!normalize) {
          let sum = 0;
          task.done = infos.filter((info) => (sum += info.duration) <= seconds).length;
        }
        emit();
      },
    );
    check();
    stage('verifying', '校验时长与拼接点');
    const outputInfo = await probe(ffprobePath, tmpOutput, task);
    if (!outputInfo || Math.abs(outputInfo.duration - plan.totalDuration) > Math.max(0.5, ordered.length * 0.06))
      throw new Error('合并输出时长校验失败，原始分集未改动');
    if (
      outputInfo.audio !== (plan.audioMode !== 'none') ||
      (plan.videoMode === 'encode' && outputInfo.codec !== 'h264')
    )
      throw new Error('合并输出音视频轨道校验失败');
    // Check head/tail and boundaries where original decoder configuration changes. Identical headers need no repeated decoder checks.
    const points = [0, Math.max(0, plan.totalDuration - 0.6)];
    let boundary = 0;
    for (let i = 1; i < infos.length; i++) {
      boundary += infos[i - 1].duration;
      if (infos[i].signature !== infos[i - 1].signature) points.push(Math.max(0, boundary - 0.3));
    }
    for (const start of [...new Set(points)]) {
      check();
      const duration = Math.min(0.6, plan.totalDuration - start);
      const result = await run([
        '-xerror',
        '-err_detect',
        'explode',
        '-ss',
        String(start),
        '-i',
        tmpOutput,
        '-t',
        String(duration),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-f',
        'null',
        '-',
      ]);
      if (result.frames < Math.max(1, Math.floor(duration * plan.fps * 0.5)))
        throw new Error(`拼接点画面校验失败（${start.toFixed(1)} 秒），原始分集未改动`);
    }
    check();
    // Publish without replacing a file created while the merge was running.
    publishMergedOutput(tmpOutput, task.output);
    task.verified = `${outputInfo.codec} ${outputInfo.w}x${outputInfo.h} · 时长/拼接点已校验`;
    task.outputBytes = fs.statSync(task.output).size;
    recordStage();
    task.status = 'completed';
    task.stage = 'completed';
    task.stageText = '合并完成';
    task.progress = 100;
    task.done = ordered.length;
    task.etaSeconds = 0;
  } finally {
    recordStage();
    if (temporary) {
      try {
        await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 2 });
      } catch (_) {
        task.cleanupWarning = `临时文件未清理：${temporary}`;
      }
    }
    delete task.children;
    delete task.child;
    task.elapsedSeconds = (Date.now() - task.startTime) / 1000;
  }
}
module.exports = { runMerge, stopMergeChildren, publishMergedOutput };
