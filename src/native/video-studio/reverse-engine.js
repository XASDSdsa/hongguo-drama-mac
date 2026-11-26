'use strict';
/**
 * Core Series-Level Shared Asset Library + 2-Stage Native Video Reverse-Engineering Engine
 * for changeFileName 「视频处理」.
 *
 * Per selected episode:
 *   1. ffprobe metadata + ffmpeg scene-cut detection -> N sliced H.264+AAC shot clips + midpoint posters
 *   2. Pass 1 (Doubao-Seed-2.0-mini native video_url): watch full compressed episode MP4 + existing series sharedAssets
 *      -> extract accurate plot, reuse existing character/scene/prop IDs, output only net-new assets with refTimestampSec
 *   3. Pass 2 (Doubao-Seed-2.0-mini native video_url, concurrency 4): watch every individual shot MP4
 *      -> output detailed 90-160 char Chinese dynamic prompts, camera movement, full dialogue, exact asset bindings
 *   4. Video-Reference Image-to-Image (Doubao-Seedream auto-fallback): extract exact ref frame via ffmpeg, pass as
 *      `image: ["data:image/jpeg;base64,..."]` to generate 1:1 matching 4-view character turnarounds, empty scenes,
 *      and white-bg props (auto cutout to RGBA PNG via pure-Node pngjs!).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { cutoutWhiteBgToPng } = require('./alpha-cutout');

function execFileAsync(cmd, args, { signal = null, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error('任务已取消');
      e.code = 'ABORT_ERR';
      return reject(e);
    }
    const child = execFile(cmd, args, { encoding: 'utf8', maxBuffer }, (err, stdout, stderr) => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (err) {
        if (signal?.aborted) {
          const ae = new Error('任务已取消');
          ae.code = 'ABORT_ERR';
          return reject(ae);
        }
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      return resolve({ stdout, stderr });
    });
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_ARK_VISION_MODEL = 'doubao-seed-2-0-mini-260428';
const DEFAULT_ARK_IMAGE_MODEL = 'doubao-seedream-5-5-261028';
const SEEDREAM_FALLBACK_MODELS = [
  'doubao-seedream-5-5-261028',
  'doubao-seedream-5-0-flash-260915',
  'doubao-seedream-5-0-pro-260628',
  'doubao-seedream-5-0-260128',
  'doubao-seedream-4-0-20260415',
];

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function inferAspectRatio(width, height) {
  if (!width || !height) return '9:16';
  const r = width / height;
  if (Math.abs(r - 9 / 16) < 0.08) return '9:16';
  if (Math.abs(r - 16 / 9) < 0.08) return '16:9';
  if (Math.abs(r - 1) < 0.08) return '1:1';
  return r < 1 ? '9:16' : '16:9';
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const err = new Error('任务已取消');
    err.code = 'ABORT_ERR';
    throw err;
  }
}

async function probeVideo(ffprobePath, videoPath, signal) {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath],
    { signal },
  );
  const info = JSON.parse(stdout);
  const vStream = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!vStream) throw new Error(`视频不含视频轨：${videoPath}`);
  const width = Number(vStream.width || 1080);
  const height = Number(vStream.height || 1920);
  const durationSec = Number(info.format?.duration || vStream.duration || 0);
  let fps = 30;
  if (vStream.avg_frame_rate && vStream.avg_frame_rate.includes('/')) {
    const [n, d] = vStream.avg_frame_rate.split('/').map(Number);
    if (n && d) fps = Math.round((n / d) * 100) / 100;
  }
  return { width, height, aspectRatio: inferAspectRatio(width, height), fps, durationSec };
}

async function detectShotBoundaries(ffmpegPath, videoPath, durationSec, targetShots = 8, threshold = 0.28, signal = null) {
  let stderr = '';
  try {
    const res = await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-i', videoPath, '-vf', `scale=320:-1,select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'],
      { signal },
    );
    stderr = res.stderr || '';
  } catch (err) {
    if (err?.code === 'ABORT_ERR') throw err;
    stderr = err?.stderr || '';
  }
  const cuts = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) cuts.push(Math.round(t * 100) / 100);
  }

  const desired = Math.max(1, Math.min(12, Number(targetShots) || 8));
  const step = durationSec / desired;
  const boundaries = [0];
  for (let i = 1; i < desired; i += 1) {
    const target = i * step;
    const win = step * 0.38;
    const prev = boundaries[boundaries.length - 1];
    let best = null;
    let bestDist = Infinity;
    for (const c of cuts) {
      if (c - prev < 3 || durationSec - c < 3) continue;
      const dist = Math.abs(c - target);
      if (dist <= win && dist < bestDist) {
        best = c;
        bestDist = dist;
      }
    }
    boundaries.push(best !== null ? best : Math.round(target * 100) / 100);
  }
  boundaries.push(Math.round(durationSec * 100) / 100);

  return boundaries.slice(0, -1).map((start, i) => ({
    index: i + 1,
    start: Math.round(start * 100) / 100,
    end: Math.round(boundaries[i + 1] * 100) / 100,
    durationSec: Math.max(1, Math.round(boundaries[i + 1] - start)),
  }));
}

async function sliceShots(ffmpegPath, videoPath, segments, outDir, signal) {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const seg of segments) {
    checkAbort(signal);
    const mp4Path = path.join(outDir, `shot-${seg.index}.mp4`);
    const jpgPath = path.join(outDir, `shot-${seg.index}.jpg`);
    const dur = Math.max(0.5, seg.end - seg.start);
    const mid = seg.start + dur * 0.45;

    await execFileAsync(
      ffmpegPath,
      [
        '-y', '-ss', String(seg.start), '-i', videoPath, '-t', String(dur),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', mp4Path,
      ],
      { signal },
    );
    await execFileAsync(
      ffmpegPath,
      ['-y', '-ss', String(mid), '-i', videoPath, '-frames:v', '1', '-q:v', '3', jpgPath],
      { signal },
    );
    results.push({
      ...seg,
      mp4Path,
      jpgPath,
      timecode: `${fmtClock(seg.start)} - ${fmtClock(seg.end)} · ${seg.durationSec}s`,
    });
  }
  return results;
}

async function encodeAnalysisVideo(ffmpegPath, inputMp4, outMp4, { maxShortSide = 256, fps = 1, crf = 34, signal = null } = {}) {
  const scaleExpr = `scale='if(gt(iw,ih),-2,${maxShortSide})':'if(gt(iw,ih),${maxShortSide},-2)'`;
  await execFileAsync(
    ffmpegPath,
    [
      '-y', '-threads', '2', '-i', inputMp4,
      '-vf', `${scaleExpr},fps=${fps}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf), '-threads', '2',
      '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-movflags', '+faststart',
      outMp4,
    ],
    { signal },
  );
  return outMp4;
}

async function extractRefFrame(ffmpegPath, videoPath, timestampSec, outJpg, signal = null) {
  const t = Math.max(0.2, Number(timestampSec) || 1);
  await execFileAsync(ffmpegPath, ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-q:v', '2', outJpg], { signal });
  return outJpg;
}

async function callArkChat({ apiKey, baseUrl, model, content, signal }) {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Ark HTTP ${resp.status}: ${txt.slice(0, 220)}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Ark 返回内容为空');
  const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
  return { parsed, usage: data?.usage || { prompt_tokens: 0, completion_tokens: 0 } };
}

async function generateAssetWithSeedream({ apiKey, baseUrl, imageModel, asset, outPath, refFramePath, metaAspectRatio, signal }) {
  const primary = imageModel || DEFAULT_ARK_IMAGE_MODEL;
  const candidates = [primary, ...SEEDREAM_FALLBACK_MODELS.filter((m) => m !== primary)];
  const isChar = asset.category === 'character';
  const isProp = asset.category === 'prop';
  const size = isChar ? '1280x720' : isProp ? '1024x1024' : metaAspectRatio === '16:9' ? '1280x720' : '720x1280';

  const hasRef = refFramePath && fs.existsSync(refFramePath);
  const refB64 = hasRef ? fs.readFileSync(refFramePath).toString('base64') : null;

  const enrichedPrompt = hasRef
    ? isChar
      ? `严格以参考图中人物的真实脸部五官、发型、妆容和服装穿搭为唯一依据，生成纯白摄影棚背景(#FFFFFF)的16:9角色四视图（左侧面部特写 + 右侧全身正面、侧面、背面），确保与参考图人物完全同一张脸、同一套衣服，无文字水印：${asset.prompt}`
      : isProp
        ? `严格提取参考图中该核心道具的真实外观、颜色和材质，完整抠出并居中放置在100%纯白背景(#FFFFFF)上，无人物、无手、无阴影、边缘清晰：${asset.prompt}`
        : `严格保留参考图中的真实场景建筑结构、陈设布局和光线色调，仅将画面中的所有人物完全擦除并自然补全背景，生成100%无人物的纯空镜背景板：${asset.prompt}`
    : isChar
      ? `纯白摄影棚背景(#FFFFFF)，16:9专业影视角色设定四视图（最左侧正面面部特写 + 右侧全身正面、侧面、背面），人物五官服装严格一致，无文字水印：${asset.prompt}`
      : isProp
        ? `100%纯白背景(#FFFFFF)独立影棚产品特写，无人物、无手、无阴影、边缘清晰：${asset.prompt}`
        : `影视级写实空镜背景板，画面中严禁出现任何人物或人影（100%无人物纯空镜）：${asset.prompt}`;

  for (const model of candidates) {
    checkAbort(signal);
    const payload = { model, prompt: enrichedPrompt, size, response_format: 'b64_json', watermark: false };
    if (refB64) payload.image = [`data:image/jpeg;base64,${refB64}`];
    const resp = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      if (errText.includes('ModelNotOpen') || errText.includes('NotFound')) continue;
      return null;
    }
    const data = await resp.json();
    const item = data?.data?.[0];
    if (!item) return null;
    if (item.b64_json) {
      fs.writeFileSync(outPath, Buffer.from(item.b64_json, 'base64'));
      return { path: outPath, model };
    }
    if (item.url) {
      const imgResp = await fetch(item.url, { signal });
      if (imgResp.ok) {
        fs.writeFileSync(outPath, Buffer.from(await imgResp.arrayBuffer()));
        return { path: outPath, model };
      }
    }
  }
  return null;
}

async function extractPosterFrame(ffmpegPath, videoPath, timestampSec, outJpg, signal = null) {
  const t = Math.max(0.1, Number(timestampSec) || 0.5);
  await execFileAsync(ffmpegPath, ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outJpg], {
    signal,
  });
  return outJpg;
}

function normalizeAssetNameKey(name) {
  return String(name || '')
    .replace(/[\s·\-_（）()【】\[\]]+/g, '')
    .toLowerCase();
}

/**
 * High-Speed Parallel Native Video Reverse-Engineering:
 *   Phase 1 (Parallel): Probe + fast-encode all selected episodes simultaneously (~3s)
 *   Phase 2 (Parallel): Analyze ALL selected episodes concurrently with Doubao-Seed-2.0-mini (thinking disabled, ~8-12s!)
 *   Phase 3 (Merge & Dedupe): Unify sharedAssets across all episodes so recurring characters/scenes generate ONCE
 *   Phase 4 (Parallel): Extract all shot JPG posters + generate all unique Seedream I2I assets concurrently (~8-12s!)
 */
async function reverseSeriesEpisodes({
  ffmpegPath,
  ffprobePath,
  seriesTitle,
  selectedEpisodes,
  workDir,
  arkApiKey,
  arkBaseUrl = DEFAULT_ARK_BASE_URL,
  visionModel = DEFAULT_ARK_VISION_MODEL,
  imageModel = DEFAULT_ARK_IMAGE_MODEL,
  signal = null,
  onProgress = () => {},
}) {
  fs.mkdirSync(workDir, { recursive: true });
  const baseUrl = String(arkBaseUrl || DEFAULT_ARK_BASE_URL).replace(/\/+$/, '');
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  let totalImagesGenerated = 0;
  const totalEps = selectedEpisodes.length;

  // Phase 1: Parallel probe + compact video encode for ALL selected episodes
  onProgress({
    stage: 'probe',
    percent: 5,
    message: `正在并发预处理全部 ${totalEps} 集视频（探针与极速压缩）...`,
  });

  const prepped = await Promise.all(
    selectedEpisodes.map(async (epInput) => {
      checkAbort(signal);
      const epNum = Number(epInput.number);
      const epDir = path.join(workDir, `ep-${epNum}`);
      fs.mkdirSync(epDir, { recursive: true });
      const meta = await probeVideo(ffprobePath, epInput.filePath, signal);
      let fullB64 = null;
      if (arkApiKey) {
        const fullMini = path.join(epDir, '_full_mini.mp4');
        await encodeAnalysisVideo(ffmpegPath, epInput.filePath, fullMini, { maxShortSide: 256, fps: 1, crf: 34, signal });
        fullB64 = fs.readFileSync(fullMini).toString('base64');
        try { fs.unlinkSync(fullMini); } catch {}
      }
      return { epInput, epNum, epDir, meta, fullB64 };
    }),
  );

  // Phase 2: Parallel AI video reverse-engineering across ALL episodes simultaneously!
  const rawResults = new Array(totalEps);
  if (arkApiKey) {
    onProgress({
      stage: 'analyze_episode',
      percent: 22,
      message: `正在并发调用 ${visionModel} 同步反推全部 ${totalEps} 集的动态分镜、提示词与资产...`,
    });
    let doneCount = 0;
    await Promise.all(
      prepped.map(async (item, idx) => {
        checkAbort(signal);
        const { epNum, meta, fullB64 } = item;
        const durInt = Math.max(10, Math.round(meta.durationSec));
        const minShots = Math.max(4, Math.min(8, Math.round(durInt / 18)));
        const maxShots = Math.max(minShots + 2, Math.min(12, Math.round(durInt / 9)));
        const unifiedPrompt = `你是专业AI短剧导演与视频分镜反推专家。请完整观看这段《${seriesTitle}》第${epNum}集视频（画幅 ${meta.aspectRatio}，总时长 ${durInt} 秒），按真实剧情节拍与镜头切换自动拆分整集分镜，输出严格 JSON（全部使用简体中文，不要 markdown 包裹）：
要求：
1. assets 列出本集核心人物、关键场景、重要道具（人物名称尽量用明确身份如“退役男主”“女总裁”“女助理”以便跨集复用）；每个资产必须填 refTimestampSec（最清晰视频秒数）。
2. 角色 prompt 写纯白棚拍四视图；场景 prompt 写 100% 无人物纯空镜；道具设 cutoutAlpha=true 写纯白底独立特写。
3. 【强制要求】shots 数组必须包含 ${minShots} ~ ${maxShots} 个连续分镜，从 startSec=0 一直连续覆盖到 endSec=${durInt}（严禁只输出 1~2 个分镜或漏掉后半段！）。每镜 description 写 75~130 字中文动态画面提示词（景别构图+场景光影+人物穿搭+连续动作表情+运镜），dialogue 写完整对白，assetKeys 填本镜出场的资产 key。

输出格式：
{
  "subtitle": "本集标题(4-10字)",
  "synopsis": "120字以内完整梗概",
  "reverseNote": "3条导演反推手记（\\n分隔）",
  "assets": [
    { "key": "英文key", "category": "character|scene|prop", "subCategory": "主角|配角|核心场景|关键道具", "name": "中文名", "refTimestampSec": 10.0, "cutoutAlpha": false, "prompt": "详细中文视觉提示词" }
  ],
  "shots": [
    { "index": 1, "startSec": 0, "endSec": ${Math.round(durInt / minShots)}, "description": "中文动态提示词", "subject": "核心主体动作", "camera": "景别+运镜+光影", "dialogue": "完整对白", "assetKeys": ["..."] },
    { "index": 2, "startSec": ${Math.round(durInt / minShots)}, "endSec": ${Math.round((durInt * 2) / minShots)}, "description": "中文动态提示词", "subject": "核心主体动作", "camera": "景别+运镜+光影", "dialogue": "完整对白", "assetKeys": ["..."] }
  ]
}
注意：shots 必须继续列出第 3、4...直到最后一镜 endSec=${durInt}，总数不少于 ${minShots} 镜！`;

        const callOnce = (promptText) =>
          callArkChat({
            apiKey: arkApiKey,
            baseUrl,
            model: visionModel,
            signal,
            content: [
              { type: 'video_url', video_url: { url: `data:video/mp4;base64,${fullB64}` } },
              { type: 'text', text: promptText },
            ],
          });

        let res = await callOnce(unifiedPrompt);
        totalUsage.prompt_tokens += res.usage.prompt_tokens || 0;
        totalUsage.completion_tokens += res.usage.completion_tokens || 0;

        // Hard guardrail: if model lazily returned too few shots or didn't cover the full episode, auto-retry once!
        const checkCoverage = (p) => {
          const sh = Array.isArray(p?.shots) ? p.shots : [];
          const maxEnd = sh.reduce((m, x) => Math.max(m, Number(x.endSec) || 0), 0);
          return sh.length >= Math.min(4, minShots) && maxEnd >= durInt * 0.65;
        };
        if (!checkCoverage(res.parsed)) {
          const gotN = Array.isArray(res.parsed?.shots) ? res.parsed.shots.length : 0;
          const retryPrompt = `${unifiedPrompt}\n\n【重要纠偏】你上一次只输出了 ${gotN} 个分镜，没有覆盖完整 ${durInt} 秒！请务必完整输出 ${minShots}~${maxShots} 个连续分镜，从 0 秒覆盖到 ${durInt} 秒！`;
          const retryRes = await callOnce(retryPrompt);
          totalUsage.prompt_tokens += retryRes.usage.prompt_tokens || 0;
          totalUsage.completion_tokens += retryRes.usage.completion_tokens || 0;
          if ((retryRes.parsed?.shots?.length || 0) > gotN) {
            res = retryRes;
          }
        }

        rawResults[idx] = res.parsed || {};
        doneCount += 1;
        onProgress({
          stage: 'analyze_episode',
          percent: 22 + Math.round((doneCount / totalEps) * 26),
          message: `已完成 ${doneCount}/${totalEps} 集视频反推（第${epNum}集：${res.parsed?.subtitle || ''} · ${res.parsed?.shots?.length || 0} 镜）...`,
        });
      }),
    );
  } else {
    // Offline fast auto-cut fallback
    await Promise.all(
      prepped.map(async (item, idx) => {
        const autoCount = Math.max(4, Math.min(8, Math.round(item.meta.durationSec / 12)));
        const segs = await detectShotBoundaries(ffmpegPath, item.epInput.filePath, item.meta.durationSec, autoCount, 0.28, signal);
        rawResults[idx] = {
          subtitle: `第${item.epNum}集`,
          synopsis: `《${seriesTitle}》第${item.epNum}集（未配置方舟 Key，离线自动切分 ${segs.length} 镜）。`,
          assets: [
            { key: 'lead', category: 'character', name: '核心主角', refTimestampSec: segs[0]?.start + 1 || 1, prompt: `《${seriesTitle}》核心主角` },
            { key: 'scene', category: 'scene', name: '核心场景', refTimestampSec: segs[1]?.start + 1 || 3, prompt: `《${seriesTitle}》核心场景空镜` },
          ],
          shots: segs.map((s) => ({
            index: s.index,
            startSec: s.start,
            endSec: s.end,
            description: `《${seriesTitle}》第${item.epNum}集分镜 #${s.index}（${fmtClock(s.start)} - ${fmtClock(s.end)}）`,
            subject: `第${item.epNum}集分镜 #${s.index}`,
            camera: `${item.meta.aspectRatio} · 自动场景切分`,
            dialogue: '',
            assetKeys: ['lead', 'scene'],
          })),
        };
      }),
    );
  }

  // Phase 3: Deduplicate & unify sharedAssets across ALL episodes (same character/scene generated ONCE!)
  const sharedAssetSpecs = [];
  const nameToCanonicalId = new Map();
  const perEpKeyMaps = [];

  for (let i = 0; i < totalEps; i += 1) {
    const { epInput, epNum, epDir, meta } = prepped[i];
    const parsed = rawResults[i] || {};
    const epKeyMap = new Map();
    const rawAssets = Array.isArray(parsed.assets) ? parsed.assets : [];

    for (let ai = 0; ai < rawAssets.length; ai += 1) {
      const a = rawAssets[ai];
      const normKey = `${a.category || 'scene'}:${normalizeAssetNameKey(a.name)}`;
      let canonicalId = nameToCanonicalId.get(normKey);
      if (!canonicalId) {
        canonicalId = `series-asset-${sharedAssetSpecs.length + 1}-${a.key || ai + 1}`;
        nameToCanonicalId.set(normKey, canonicalId);
        sharedAssetSpecs.push({
          id: canonicalId,
          asset: a,
          epInput,
          epDir,
          meta,
        });
      }
      if (a.key) epKeyMap.set(a.key, canonicalId);
      if (a.name) epKeyMap.set(a.name, canonicalId);
      epKeyMap.set(canonicalId, canonicalId);
    }
    perEpKeyMaps.push(epKeyMap);
  }

  // Phase 4: Extract ALL shot posters + generate ALL unique Seedream I2I assets IN PARALLEL!
  onProgress({
    stage: 'gen_asset',
    percent: 52,
    message: `跨集去重后共 ${sharedAssetSpecs.length} 项全剧共享资产，正在并发截取全部封面并生成纯净资产图...`,
  });

  // 4A. Extract all shot posters in parallel
  const allEpNormalizedShots = await Promise.all(
    prepped.map(async (item, i) => {
      const parsed = rawResults[i] || {};
      const rawShots = Array.isArray(parsed.shots) && parsed.shots.length > 0 ? parsed.shots : [];
      const count = rawShots.length || 6;
      const step = item.meta.durationSec / count;
      const segs = (rawShots.length ? rawShots : Array.from({ length: count }, (_, k) => ({ index: k + 1 }))).map((sh, k) => {
        const start = Number.isFinite(Number(sh.startSec)) ? Math.max(0, Number(sh.startSec)) : Math.round(k * step * 10) / 10;
        const end = Number.isFinite(Number(sh.endSec))
          ? Math.min(item.meta.durationSec, Math.max(start + 1, Number(sh.endSec)))
          : Math.min(item.meta.durationSec, Math.round((k + 1) * step * 10) / 10);
        return { ...sh, index: k + 1, start, end, durationSec: Math.max(1, Math.round(end - start)) };
      });
      await Promise.all(
        segs.map((seg) => {
          const jpgPath = path.join(item.epDir, `shot-${seg.index}.jpg`);
          seg.posterPath = jpgPath;
          return extractPosterFrame(ffmpegPath, item.epInput.filePath, seg.start + Math.max(0.2, (seg.end - seg.start) * 0.45), jpgPath, signal);
        }),
      );
      return segs;
    }),
  );

  // 4B. Generate ALL deduplicated shared assets concurrently (cap concurrency at 6)
  const sharedAssets = new Array(sharedAssetSpecs.length);
  let assetDone = 0;
  let assetCursor = 0;
  const assetWorker = async () => {
    while (assetCursor < sharedAssetSpecs.length) {
      checkAbort(signal);
      const idx = assetCursor;
      assetCursor += 1;
      const { id, asset: a, epInput, epDir, meta } = sharedAssetSpecs[idx];
      const refPath = path.join(epDir, `_ref_${idx}.jpg`);
      try {
        await extractRefFrame(ffmpegPath, epInput.filePath, a.refTimestampSec || 2, refPath, signal);
      } catch {}

      const needAlpha = Boolean(a.cutoutAlpha || a.category === 'prop');
      let finalImgPath = fs.existsSync(refPath) ? refPath : '';

      if (arkApiKey && a.prompt) {
        const rawOut = path.join(workDir, `shared-${idx}-raw.jpg`);
        const genRes = await generateAssetWithSeedream({
          apiKey: arkApiKey,
          baseUrl,
          imageModel,
          asset: a,
          outPath: rawOut,
          refFramePath: fs.existsSync(refPath) ? refPath : null,
          metaAspectRatio: meta.aspectRatio,
          signal,
        });
        if (genRes) {
          totalImagesGenerated += 1;
          if (needAlpha) {
            const pngPath = path.join(workDir, `shared-${idx}.png`);
            await cutoutWhiteBgToPng({ ffmpegPath, inputPath: rawOut, outputPngPath: pngPath });
            try { fs.unlinkSync(rawOut); } catch {}
            finalImgPath = pngPath;
          } else {
            const jpgPath = path.join(workDir, `shared-${idx}.jpg`);
            fs.renameSync(rawOut, jpgPath);
            finalImgPath = jpgPath;
          }
          try { fs.unlinkSync(refPath); } catch {}
        }
      }

      const catLabel = a.category === 'character' ? '人物四视图' : a.category === 'prop' ? '道具' : '场景';
      sharedAssets[idx] = {
        id,
        category: a.category || 'scene',
        subCategory: a.subCategory || (a.category === 'character' ? '主角' : a.category === 'prop' ? '关键道具' : '核心场景'),
        name: a.name || `资产${idx + 1}`,
        caption: `${catLabel} · ${a.name || `资产${idx + 1}`}${needAlpha ? '（透明背景）' : ''}`,
        shotType: a.category === 'prop' ? '特写' : '全景',
        framing: a.category === 'character' ? '全身' : '主体',
        imagePath: finalImgPath,
        prompt: a.prompt || '',
        aspectRatio: a.category === 'character' ? '16:9' : a.category === 'prop' ? '1:1' : meta.aspectRatio,
      };
      assetDone += 1;
      onProgress({
        stage: 'gen_asset',
        percent: 52 + Math.round((assetDone / Math.max(1, sharedAssetSpecs.length)) * 20),
        message: `已完成纯净资产图 ${assetDone}/${sharedAssetSpecs.length}（「${sharedAssets[idx].name}」）...`,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, sharedAssetSpecs.length)) }, () => assetWorker()));

  // Assemble episodes
  const episodes = prepped.map((item, i) => {
    const parsed = rawResults[i] || {};
    const epKeyMap = perEpKeyMaps[i];
    const segs = allEpNormalizedShots[i];
    const shots = segs.map((seg) => {
      const rawKeys = Array.isArray(seg.assetKeys) ? seg.assetKeys : [];
      const resolvedIds = [
        ...new Set(rawKeys.map((k) => epKeyMap.get(k) || (sharedAssets.some((a) => a.id === k) ? k : null)).filter(Boolean)),
      ];
      return {
        id: `ep${item.epNum}-shot-${seg.index}`,
        index: seg.index,
        title: `分镜提示词 #${seg.index}`,
        videoTitle: `分镜成片 #${seg.index}`,
        description: seg.description || '',
        subject: seg.subject || `分镜 #${seg.index}`,
        camera: seg.camera || `${item.meta.aspectRatio} · 实拍镜头`,
        dialogue: seg.dialogue || '',
        aspectRatio: item.meta.aspectRatio,
        durationSec: seg.durationSec,
        timecode: `${fmtClock(seg.start)} - ${fmtClock(seg.end)} · ${seg.durationSec}s`,
        posterPath: seg.posterPath,
        videoPath: item.epInput.filePath,
        assetIds: resolvedIds.length ? resolvedIds : sharedAssets.slice(0, 2).map((a) => a.id),
      };
    });
    const usedAssetCount = new Set(shots.flatMap((s) => s.assetIds)).size;
    return {
      id: `ep-${item.epNum}`,
      number: item.epNum,
      title: `${seriesTitle}-第${item.epNum}集`,
      subtitle: parsed.subtitle || `第${item.epNum}集`,
      synopsis: parsed.synopsis || `《${seriesTitle}》第${item.epNum}集，共 ${shots.length} 镜。`,
      reverseNote: parsed.reverseNote || `原片规格：${item.meta.width}×${item.meta.height}`,
      nodeCount: 2 + usedAssetCount + shots.length * 2 + 1,
      shots,
    };
  });

  const estVisionRmb = (totalUsage.prompt_tokens / 1e6) * 0.2 + (totalUsage.completion_tokens / 1e6) * 2.0;
  return {
    seriesTitle,
    sharedAssets,
    episodes,
    stats: {
      episodeCount: episodes.length,
      sharedAssetCount: sharedAssets.length,
      imagesGenerated: totalImagesGenerated,
      promptTokens: totalUsage.prompt_tokens,
      completionTokens: totalUsage.completion_tokens,
      estimatedVisionRmb: Number(estVisionRmb.toFixed(4)),
    },
  };
}

module.exports = {
  DEFAULT_ARK_BASE_URL,
  DEFAULT_ARK_VISION_MODEL,
  DEFAULT_ARK_IMAGE_MODEL,
  reverseSeriesEpisodes,
};
