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
        previousEndState = '';
        continue;
      }
      const composed = composeSegmentPrompt({ segment: item.segment, shots: item.shots, library, refImages, previousEndState });
      item.segment.prompt = composed.text;
      item.segment.images = composed.images;
      previousEndState = composed.endState;
    }

    const text = renderEpisodeFile({
      label,
      duration,
      maxSeconds: Math.min(30, Math.max(2, Number(maxSeconds) || DEFAULT_MAX_SEGMENT_SECONDS)),
      library,
      segments: results.map((item) => item.segment),
      refPaths,
    });
    const file = path.join(outDir, `${label}.txt`);
    await writeAtomic(file, text);
    onProgress(100, '提示词已生成');
    return { file, segments: segments.length, failed };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { deriveEpisodePrompts, runFfmpeg };
