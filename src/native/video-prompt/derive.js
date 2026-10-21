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
  verifyInstruction,
  applyVerification,
  composeSegmentPrompt,
  renderEpisodeFile,
} = require('./compose');
const { renderEpisodeHtml, keyframeTimes, jpegSize, FRAME_LABELS } = require('./html');
const { describePhases } = require('./ark');
const { detectEpisodeBand, cleanKeyframe } = require('./subtitle-clean');

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
      if (signal?.aborted || error?.fatal) throw error; // 额度用完、Key 不对这类，重试也没用
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
  // 每集只分析前几个分镜（0 = 全部）：后面的分镜只在页面上占位，不问方舟、不截关键帧，省额度。
  shotLimit = 0,
  fps = 2,
  // 四宫格关键帧去字幕（视频本身不动；在本机用 LaMa 补，不调接口）
  cleanSubtitles = true,
  // LaMa 补图：createLamaWorker() 的返回值（{ start, inpaint }）；没有或用不了时退回本机补图
  lama = null,
  log = () => {},
  onProgress = () => {},
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tempRoot = os.tmpdir(),
}) {
  const duration = Number(alignment?.duration ?? transcript?.duration ?? alignment?.shots?.at(-1)?.end);
  const allRows = buildShotRows(alignment, transcript);
  const limit = Math.max(0, Math.floor(Number(shotLimit) || 0));
  const rows = limit > 0 ? allRows.slice(0, limit) : allRows;
  const placeholders = allRows.slice(rows.length);
  // 素材库也只看要分析的这几个分镜（从开头到最后一个分析的分镜结束）。
  const analyzedEnd = placeholders.length ? rows.at(-1).end : duration;
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
        ['-y', '-i', inputPath, ...(placeholders.length ? ['-t', String(analyzedEnd)] : []), '-vf', scaleFilter(360), '-r', '8', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', proxy],
        signal,
      );
      cache.library = await withRetries(
        async () => normalizeLibrary(parseJsonLoose(await client.askAboutVideo(proxy, libraryInstruction({ duration: analyzedEnd, rows }), { fps, signal, onTimings: (t) => log('info', `素材库：方舟用时 ${describePhases(t)}`) })), analyzedEnd),
        { signal, sleep, label: '素材库', log },
      );
      await saveCache();
      await fsp.rm(proxy, { force: true });
    }
    const library = cache.library;
    log('info', `素材库：${library.characters.length} 个人物、${library.scenes.length} 个场景、${library.props.length} 个物品`);
    if (placeholders.length) log('info', `只分析前 ${rows.length} 个分镜，后面 ${placeholders.length} 个分镜占位、不处理`);

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
            const answer = await client.askAboutVideo(clip, segmentInstruction({ segment, library }) + hint, {
              fps,
              signal,
              onTimings: (t) => log('info', `第 ${segment.index} 段：方舟用时 ${describePhases(t)}`),
            });
            return normalizeSegmentResult(parseJsonLoose(answer), segment, library);
          },
          { signal, sleep, label: `第 ${segment.index} 段`, log },
        );
        // 小说原文写好后，单独再问一次方舟：对照画面核对人物、动作、场景、对白，按核对结果给匹配度。
        // 核对失败（不是账号问题）就保留写的那一次的自评分，页面上标「自评」。
        let checked = shots.map((shot) => ({ ...shot, match_source: shot.novel ? 'self' : 'none' }));
        if (shots.some((shot) => shot.novel)) {
          try {
            checked = await withRetries(
              async () =>
                applyVerification(
                  shots,
                  parseJsonLoose(
                    await client.askAboutVideo(clip, verifyInstruction({ segment, shots }), {
                      fps,
                      signal,
                      onTimings: (t) => log('info', `第 ${segment.index} 段核对小说原文：方舟用时 ${describePhases(t)}`),
                    }),
                  ),
                  segment,
                ),
              { signal, sleep, label: `第 ${segment.index} 段核对`, log },
            );
          } catch (error) {
            if (signal?.aborted || error?.fatal) throw error;
            log('warn', `第 ${segment.index} 段小说原文没核对成功，匹配度先用方舟自评：${error.message}`);
          }
        }
        cache.segments[segment.index] = checked;
        await saveCache();
        await fsp.rm(clip, { force: true });
        results.push({ segment, shots: checked });
      } catch (error) {
        if (signal?.aborted || error?.fatal) throw error; // 账号问题：后面的段也一样会失败，整集直接停
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
    // 原片画幅（决定生成用的比例 9:16 / 16:9）：先读出来，txt 和页面都要用。
    let size = null;
    const probe = await grabFrame(ffmpeg, inputPath, rows[0].start, 100000, 31, temp, 'size.jpg', signal);
    if (probe) size = jpegSize(probe.bytes);
    let text = renderEpisodeFile({ label, duration, maxSeconds: maxLimit, library, segments: allSegments, refPaths, size });
    if (placeholders.length)
      text += `\n（只分析了前 ${rows.length} 个分镜；镜 ${placeholders[0].no}–${placeholders.at(-1).no} 共 ${placeholders.length} 个分镜占位，没有处理）\n`;
    const file = path.join(outDir, `${label}.txt`);
    await writeAtomic(file, text);

    // 5) 分镜头脚本页面：每个分镜抽四张关键帧，连同素材库一起写进一个 HTML。页面是附加成果，出问题只记日志。
    let htmlFile = '';
    try {
      step(segments.length + 1, '截取每个分镜的关键帧，生成分镜头脚本页面');
      const frames = {};
      const jobs = [];
      for (const row of rows) {
        frames[row.no] = { poster: '', grid: [null, null, null, null], subtitleFree: true };
        const times = keyframeTimes(row);
        jobs.push({ row, kind: 'poster', time: times[0] });
        times.forEach((time, i) => jobs.push({ row, kind: 'grid', index: i, time }));
      }
      // 四宫格关键帧去字幕：先在整集里找字幕横带；找到了，每张关键帧把字幕那一行用旁边真实的画面补上。
      // 视频首帧（播放前显示的那张）就用去过字幕的「起幅」，不另外截。
      let subtitle = { band: null, dims: null };
      const tally = { cleaned: 0, residue: 0, failed: 0, lama: 0 };
      if (cleanSubtitles && size) {
        try {
          subtitle = await detectEpisodeBand({ ffmpeg, inputPath, rows, utterances: transcript?.utterances, size, signal });
          if (subtitle.band) {
            const { y0, y1, frameHeight } = subtitle.band;
            log('info', `关键帧去字幕：字幕在画面 ${Math.round((y0 / frameHeight) * 100)}%–${Math.round((y1 / frameHeight) * 100)}% 高度，四宫格关键帧和视频首帧都去掉字幕`);
          } else log('info', '关键帧去字幕：没找到烧在画面里的字幕，关键帧照常截');
        } catch (error) {
          if (signal?.aborted) throw error;
          log('warn', `关键帧去字幕没做成（${error.message}），关键帧照常截`);
          // 没查成：有没有字幕不知道，画面校验里「无字幕水印」不写
          for (const row of rows) frames[row.no].subtitleFree = false;
        }
      }
      // 先把 LaMa 模型加载好（第一次要几秒到十几秒）：每 15 秒报一次还在加载，不让日志干等着没动静
      let lamaBroken = null;
      if (subtitle.band) {
        if (!lama) lamaBroken = new Error('没有 LaMa 补图');
        else {
          const started = Date.now();
          log('info', '关键帧去字幕：加载 LaMa 补图模型…');
          const beat = setInterval(() => log('info', `关键帧去字幕：LaMa 补图模型还在加载（已 ${Math.round((Date.now() - started) / 1000)} 秒）…`), 15000);
          try {
            // 加载中途点了停止：马上停，不等模型加载完
            await new Promise((resolve, reject) => {
              lama.start().then(resolve, reject);
              signal?.addEventListener?.('abort', () => reject(signal.reason || new Error('已停止')), { once: true });
            });
            log('info', `关键帧去字幕：LaMa 补图模型准备好了（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
          } catch (error) {
            if (signal?.aborted) throw error;
            lamaBroken = error;
          } finally {
            clearInterval(beat);
          }
        }
        if (lamaBroken) log('warn', `关键帧去字幕：LaMa 用不了（${lamaBroken.message}），这一集用本机补图（效果差一些）`);
      }
      // LaMa 出过一次错（进程起不来、模型坏了）：这一集剩下的关键帧不再试，直接用本机补图
      const inpaint = async (job) => {
        if (lamaBroken) throw lamaBroken;
        try {
          return await lama.inpaint(job);
        } catch (error) {
          if (!signal?.aborted && !lamaBroken) {
            lamaBroken = error;
            log('warn', `关键帧去字幕：LaMa 出错了（${error.message}），这一集剩下的关键帧用本机补图（效果差一些）`);
          }
          throw error;
        }
      };
      const gridTotal = jobs.filter((job) => job.kind === 'grid').length;
      let gridDone = 0;
      await pool(jobs, 4, async (job) => {
        const wide = job.kind === 'poster';
        if (wide && subtitle.band) return; // 视频首帧由「起幅」那张一起出
        let frame = null;
        if (!wide && subtitle.band) {
          const started = Date.now();
          try {
            const first = job.index === 0;
            const clean = await cleanKeyframe({
              ffmpeg,
              inputPath,
              time: job.time,
              band: subtitle.band,
              dims: subtitle.dims,
              sizes: first ? [{ width: 320, quality: 7 }, { width: 560, quality: 4 }] : [{ width: 320, quality: 7 }],
              signal,
              inpaint: lamaBroken ? null : inpaint,
            });
            frame = { uri: `data:image/jpeg;base64,${clean.outputs[0].toString('base64')}`, bytes: clean.outputs[0] };
            if (first) frames[job.row.no].poster = `data:image/jpeg;base64,${clean.outputs[1].toString('base64')}`;
            if (clean.cleaned) tally.cleaned += 1;
            if (!clean.clean) {
              tally.residue += 1;
              frames[job.row.no].subtitleFree = false;
            }
            if (clean.method === 'lama') tally.lama += 1;
            gridDone += 1;
            const where = `镜${job.row.no} ${FRAME_LABELS[job.index] || ''}`.trim();
            // LaMa 一次只补一张（几张同时排队）：写 LaMa 自己用的时间，不算排队等的
            const seconds = (clean.method === 'lama' ? clean.seconds : (Date.now() - started) / 1000).toFixed(1);
            const how = clean.method === 'lama' ? 'LaMa' : '本机补图';
            if (clean.cleaned)
              log(
                clean.clean ? 'info' : 'warn',
                `关键帧去字幕 ${gridDone}/${gridTotal}：${where} ${clean.clean ? '去掉了' : '补过了，但还检测到字'}（${how}，${seconds} 秒）`,
              );
            else log('info', `关键帧去字幕 ${gridDone}/${gridTotal}：${where} 这一刻没有字幕，不用补`);
            onProgress(99, `关键帧去字幕 ${gridDone}/${gridTotal}`);
          } catch (error) {
            if (signal?.aborted) throw error;
            tally.failed += 1;
            log('warn', `关键帧去字幕：镜${job.row.no} ${FRAME_LABELS[job.index] || ''} 没做成（${error.message}），用原图`);
          }
          // 去字幕这一步出错退回普通截图：这一刻有没有字幕不知道，不算干净
          if (!frame) frames[job.row.no].subtitleFree = false;
        }
        if (!frame) frame = await grabFrame(ffmpeg, inputPath, job.time, wide ? 560 : 320, wide ? 4 : 7, temp, `kf-${job.row.no}-${job.kind}${job.index ?? ''}.jpg`, signal);
        if (!frame) return;
        if (wide) {
          frames[job.row.no].poster = frame.uri;
          if (!size) size = jpegSize(frame.bytes);
        } else {
          frames[job.row.no].grid[job.index] = frame.uri;
          // 起幅去字幕没做成：视频首帧也用这张原图
          if (job.index === 0 && subtitle.band && !frames[job.row.no].poster) frames[job.row.no].poster = frame.uri;
        }
      });
      if (subtitle.band) {
        const local = tally.cleaned - tally.lama;
        const notes = [
          local > 0 && `${local} 张是本机补图`,
          tally.residue && `${tally.residue} 张补完还检测到字`,
          tally.failed && `${tally.failed} 张没做成`,
        ].filter(Boolean);
        log(notes.length ? 'warn' : 'info', `关键帧去字幕：去掉了 ${tally.cleaned} 张（LaMa ${tally.lama} 张）${notes.length ? `；${notes.join('、')}` : ''}`);
      }
      const thumbs = {};
      await pool(library.characters.filter((c) => c.ref_time != null), 4, async (character) => {
        const frame = await grabFrame(ffmpeg, inputPath, character.ref_time, 160, 5, temp, `ref-${character.id}.jpg`, signal);
        if (frame) thumbs[character.id] = frame.uri;
      });
      // 成品文件名是「新剧名 - 第1集」（以前是「新剧名_第001集」）：页头显示新剧名和「第1集」，不重复文件名
      const named = /^(.+?)(?: - |_)第0*(\d+)集(?:_\d+)?$/.exec(label);
      const html = renderEpisodeHtml({
        title: named ? named[1] : title,
        label,
        episodeName: named ? `第${named[2]}集` : '',
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
        placeholders,
        shotLimit: limit,
      });
      htmlFile = path.join(outDir, `${label}.html`);
      await writeAtomic(htmlFile, html);
    } catch (error) {
      if (signal?.aborted) throw error;
      htmlFile = '';
      log('warn', `分镜头脚本页面没有生成：${error.message}（提示词文本已经写好）`);
    }
    onProgress(100, '提示词已生成');
    return { file, htmlFile, segments: segments.length, failed, placeholders: placeholders.length };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { deriveEpisodePrompts, runFfmpeg };
