'use strict';
// 一集视频 → 一份 Seedance 2.5 分段提示词。
// 流程：分段 → 通读整集建素材库 → 逐段看视频 → 校验 → 程序拼提示词 → 写出一个 txt。
// 模型只负责“看”；时间、台词、分段、格式都由程序决定。

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const {
  TEMPLATE_VERSION,
  DEFAULT_MAX_SEGMENT_SECONDS,
  buildShotRows,
  buildSegments,
  parseJsonLoose,
  libraryInstruction,
  segmentInstruction,
  normalizeLibrary,
  normalizeSegmentResult,
  composeSegmentPrompt,
  renderEpisodeFile,
} = require('./compose');
const { renderEpisodeHtml, keyframeTimes, jpegSize } = require('./html');

const ATTEMPTS = 3;

function runFfmpeg(ffmpeg, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { signal, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error) {
        if (signal?.aborted) return reject(error);
        return reject(new Error(`FFmpeg 失败：${String(stderr || error.message).split('\n').filter(Boolean).slice(-2).join(' ')}`));
      }
      resolve();
    });
  });
}

const scaleFilter = (height) => `scale=-2:'min(${height},ih)'`;

function safeName(text) {
  return String(text || '')
    .replace(/[\\/:*?"<>|\s]+/g, '')
    .slice(0, 20);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, content);
  await fsp.rename(temp, file);
}

/** 抽一帧，返回 data URI 和原始字节；失败返回 null（缺一张图不影响整份提示词）。 */
async function grabFrame(ffmpeg, inputPath, time, width, quality, temp, name, signal) {
  const file = path.join(temp, name);
  try {
    await runFfmpeg(ffmpeg, ['-y', '-ss', String(Math.max(0, time)), '-i', inputPath, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', String(quality), file], signal);
    const bytes = await fsp.readFile(file);
    await fsp.rm(file, { force: true });
    return { uri: `data:image/jpeg;base64,${bytes.toString('base64')}`, bytes };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** 简单并发池。 */
async function pool(items, size, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function withRetries(task, { signal, sleep, label, log }) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await task(attempt, lastError);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt < ATTEMPTS) {
        log('warn', `${label}第 ${attempt} 次没成功（${error.message}），重试`);
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * @param {object} options
 * @param {string} options.ffmpeg
 * @param {string} options.inputPath       去重后的成品视频
 * @param {string} options.label           集名
 * @param {object} options.alignment       结构化拆解的分镜结果
 * @param {object} options.transcript      结构化拆解的转写结果
 * @param {object} options.client          createArkClient() 的返回值
 * @param {string} options.model           视频理解模型名（进缓存键）
 * @param {string} options.outDir          成果文件夹（只放最终的 txt 和参考图）
 * @param {string} options.cacheFile       缓存文件（放在软件数据目录，不放成果文件夹）
 * @param {string} options.sourceKey       视频内容指纹（进缓存键）
 * @param {string} [options.title]         剧名（只显示在 HTML 页头）
 */
async function deriveEpisodePrompts({
  ffmpeg,
  inputPath,
  label,
  alignment,
  transcript,
  client,
  model,
  outDir,
  cacheFile,
  sourceKey,
  title = '',
  maxSeconds = DEFAULT_MAX_SEGMENT_SECONDS,
  fps = 5,
  log = () => {},
  onProgress = () => {},
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tempRoot = os.tmpdir(),
}) {
  const duration = Number(alignment?.duration ?? transcript?.duration ?? alignment?.shots?.at(-1)?.end);
  const rows = buildShotRows(alignment, transcript);
  const segments = buildSegments(rows, maxSeconds);
  const key = crypto
    .createHash('sha256')
    .update(JSON.stringify([TEMPLATE_VERSION, model, sourceKey, maxSeconds, rows.map((r) => [r.start, r.end])]))
    .digest('hex');
  let cache = await readJson(cacheFile);
  if (!cache || cache.key !== key) cache = { key, library: null, segments: {} };
  const saveCache = () => writeAtomic(cacheFile, JSON.stringify(cache));

  const temp = await fsp.mkdtemp(path.join(tempRoot, 'hongguo-prompt-'));
  const step = (done, message) => onProgress(Math.min(99, Math.floor((done / (segments.length + 2)) * 100)), message);
  try {
    // 1) 通读整集 → 素材库
    if (!cache.library) {
      step(0, '通读整集，建立人物和场景素材库');
      const proxy = path.join(temp, 'episode.mp4');
      await runFfmpeg(
        ffmpeg,
        ['-y', '-i', inputPath, '-vf', scaleFilter(360), '-r', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', proxy],
        signal,
      );
      cache.library = await withRetries(
        async () => normalizeLibrary(parseJsonLoose(await client.askAboutVideo(proxy, libraryInstruction({ duration, rows }), { fps, signal })), duration),
        { signal, sleep, label: '素材库', log },
      );
      await saveCache();
      await fsp.rm(proxy, { force: true });
    }
    const library = cache.library;
    log('info', `素材库：${library.characters.length} 个人物、${library.scenes.length} 个场景、${library.props.length} 个物品`);

    // 2) 人物参考图：从原视频里抽出该人物最清晰的一帧
    const refDirName = `${label}-参考图`;
    const refImages = {};
    const refPaths = {};
    for (const character of library.characters) {
      if (character.ref_time == null) continue;
      const rel = path.join(refDirName, `${character.id}-${safeName(character.name)}.jpg`);
      try {
        await fsp.mkdir(path.join(outDir, refDirName), { recursive: true });
        await runFfmpeg(ffmpeg, ['-y', '-ss', String(character.ref_time), '-i', inputPath, '-frames:v', '1', '-q:v', '2', path.join(outDir, rel)], signal);
        refImages[character.id] = rel.split(path.sep).join('/');
        refPaths[character.id] = refImages[character.id];
      } catch (error) {
        if (signal?.aborted) throw error;
        log('warn', `${character.name} 的参考图没抽出来：${error.message}`);
      }
    }

    // 3) 逐段看视频
    const results = [];
    let failed = 0;
    for (const segment of segments) {
      signal?.throwIfAborted();
      step(segment.index, `看第 ${segment.index}/${segments.length} 段`);
      const cached = cache.segments[segment.index];
      if (cached) {
        results.push({ segment, shots: cached });
        continue;
      }
      try {
        const clip = path.join(temp, `segment-${segment.index}.mp4`);
        await runFfmpeg(
          ffmpeg,
          ['-y', '-ss', String(segment.start), '-i', inputPath, '-t', String(segment.dur), '-vf', scaleFilter(480), '-r', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', clip],
          signal,
        );
        const shots = await withRetries(
          async (_attempt, lastError) => {
            const hint = lastError ? `\n\n上一次的问题：${lastError.message}。请严格按格式重新回答。` : '';
            const answer = await client.askAboutVideo(clip, segmentInstruction({ segment, library }) + hint, { fps, signal });
            return normalizeSegmentResult(parseJsonLoose(answer), segment, library);
          },
          { signal, sleep, label: `第 ${segment.index} 段`, log },
        );
        cache.segments[segment.index] = shots;
        await saveCache();
        await fsp.rm(clip, { force: true });
        results.push({ segment, shots });
      } catch (error) {
        if (signal?.aborted) throw error;
        failed += 1;
        log('error', `第 ${segment.index} 段没有生成：${error.message}`);
        results.push({ segment, error: error.message });
      }
    }

    // 4) 程序拼提示词，按段衔接结束状态
    let previousEndState = '';
    for (const item of results) {
      if (item.error) {
        item.segment.prompt = `（本段没有生成成功：${item.error}。重新开始一次即可，已完成的段会直接复用。）`;
        item.segment.failedMessage = item.error;
        previousEndState = '';
        continue;
      }
      const composed = composeSegmentPrompt({ segment: item.segment, shots: item.shots, library, refImages, previousEndState });
      item.segment.prompt = composed.text;
      item.segment.images = composed.images;
      item.segment.shotLines = composed.shotLines;
      item.segment.shots = item.shots;
      previousEndState = composed.endState;
    }

    const maxLimit = Math.min(30, Math.max(2, Number(maxSeconds) || DEFAULT_MAX_SEGMENT_SECONDS));
    const allSegments = results.map((item) => item.segment);
    const text = renderEpisodeFile({ label, duration, maxSeconds: maxLimit, library, segments: allSegments, refPaths });
    const file = path.join(outDir, `${label}.txt`);
    await writeAtomic(file, text);

    // 5) 分镜头脚本页面：每个分镜抽四张关键帧，连同素材库一起写进一个 HTML。页面是附加成果，出问题只记日志。
    let htmlFile = '';
    try {
      step(segments.length + 1, '截取每个分镜的关键帧，生成分镜头脚本页面');
      const frames = {};
      const jobs = [];
      for (const row of rows) {
        frames[row.no] = { poster: '', grid: [null, null, null, null] };
        const times = keyframeTimes(row);
        jobs.push({ row, kind: 'poster', time: times[0] });
        times.forEach((time, i) => jobs.push({ row, kind: 'grid', index: i, time }));
      }
      let size = null;
      await pool(jobs, 4, async (job) => {
        const wide = job.kind === 'poster';
        const frame = await grabFrame(ffmpeg, inputPath, job.time, wide ? 560 : 320, wide ? 4 : 7, temp, `kf-${job.row.no}-${job.kind}${job.index ?? ''}.jpg`, signal);
        if (!frame) return;
        if (wide) {
          frames[job.row.no].poster = frame.uri;
          if (!size) size = jpegSize(frame.bytes);
        } else frames[job.row.no].grid[job.index] = frame.uri;
      });
      const thumbs = {};
      await pool(library.characters.filter((c) => c.ref_time != null), 4, async (character) => {
        const frame = await grabFrame(ffmpeg, inputPath, character.ref_time, 160, 5, temp, `ref-${character.id}.jpg`, signal);
        if (frame) thumbs[character.id] = frame.uri;
      });
      // 画幅：优先读原片尺寸（海报缩小过，宽高比一致但像素不对）。
      const probe = await grabFrame(ffmpeg, inputPath, rows[0].start, 100000, 31, temp, 'size.jpg', signal);
      if (probe) size = jpegSize(probe.bytes) || size;
      const html = renderEpisodeHtml({
        title,
        label,
        duration,
        maxSeconds: maxLimit,
        library,
        segments: allSegments,
        frames,
        thumbs,
        videoRel: path.relative(outDir, inputPath).split(path.sep).map(encodeURIComponent).join('/'),
        size,
        generatedAt: new Date(),
        allText: text,
      });
      htmlFile = path.join(outDir, `${label}.html`);
      await writeAtomic(htmlFile, html);
    } catch (error) {
      if (signal?.aborted) throw error;
      htmlFile = '';
      log('warn', `分镜头脚本页面没有生成：${error.message}（提示词文本已经写好）`);
    }
    onProgress(100, '提示词已生成');
    return { file, htmlFile, segments: segments.length, failed };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { deriveEpisodePrompts, runFfmpeg };
