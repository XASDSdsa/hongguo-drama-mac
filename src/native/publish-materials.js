'use strict';
/**
 * AI 发布素材：改写剧名、改写简介、生成海报，三件事各自独立（标题由程序叠加）。
 * 海报要先选定剧名：选名字（或手填）之后才能画。
 *
 * 为什么海报标题不让图像模型直接画：图像模型写中文常常错字、缺笔画，而且每次位置不同。
 * 这里让它只画“没有任何文字的画面”，标题由 poster-title 用真字体渲染，位置和样式都由程序决定，
 * 所以字永远是对的，换标题也不用重新作图。
 *
 * 给客户看的结果放在剧文件夹里（发布剧名.txt / 发布简介.txt / 发布海报.jpg）；
 * 无字底图和状态记录放在应用私有的 workDir，不进输出目录。
 */
const fs = require('node:fs');
const path = require('node:path');
const { STYLE_IDS, pickStyleByGenre, describeStyles } = require('./poster-styles');

const OUTPUT_TITLE = '发布剧名.txt';
const OUTPUT_SYNOPSIS = '发布简介.txt';
const OUTPUT_POSTER = '发布海报.jpg';
const STATE_FILE = 'state.json';

const TITLE_MIN = 3;
const TITLE_MAX = 10;
const HOOK_WORDS = [
  '重生',
  '逆袭',
  '离婚',
  '总裁',
  '竟',
  '后',
  '却',
  '归来',
  '觉醒',
  '反转',
  '真相',
  '身份',
  '千金',
  '神医',
  '赘婿',
];
const BANNED_TITLE = /最|第一|国家级|顶级|绝对|必看/;

// 简介：90–95 个字（汉字、标点都算一个字，空白不算），严格校验，不合格就让模型照着问题重写。
const SYNOPSIS_MIN = 90;
const SYNOPSIS_MAX = 95;
const SYNOPSIS_ATTEMPTS = 4;
const TITLE_ATTEMPTS = 3;
// 和原文连着这么多个字一样，就算「沿用了原来的说法」。
const SAME_PHRASE = 4;
// 剧名关键词里不算数的虚字：「的自」「之后」这类不算关键词。
const TITLE_FILLERS = new Set(Array.from('的之了与和及在是被把将着地得也都又就还'));

const HAN = /\p{Script=Han}/u;
const countChars = (text) => Array.from(String(text || '').replace(/\s+/g, '')).length;

/** 原剧名里连着的两个汉字（去掉虚字）就是关键词：新剧名一个都不能有。 */
function titleKeywords(original) {
  const chars = Array.from(cleanTitle(original));
  const words = [];
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const pair = chars[i] + chars[i + 1];
    if (!HAN.test(chars[i]) || !HAN.test(chars[i + 1])) continue;
    if (TITLE_FILLERS.has(chars[i]) || TITLE_FILLERS.has(chars[i + 1])) continue;
    if (!words.includes(pair)) words.push(pair);
  }
  return words;
}

/** 新文本里和原文连着 SAME_PHRASE 个汉字以上一样的片段（只看汉字，标点不算）。 */
function sharedPhrases(text, original, size = SAME_PHRASE) {
  const han = (value) => Array.from(String(value || '')).filter((ch) => HAN.test(ch)).join('');
  const source = han(original);
  const chars = Array.from(han(text));
  const found = [];
  for (let i = 0; i + size <= chars.length; i += 1) {
    const piece = chars.slice(i, i + size).join('');
    if (!source.includes(piece)) continue;
    // 连着的重复合成一段，方便告诉模型改哪里。
    let end = i + size;
    while (end < chars.length && source.includes(chars.slice(i, end + 1).join(''))) end += 1;
    found.push(chars.slice(i, end).join(''));
    i = end - 1;
  }
  return found;
}

/** 检查一版简介，返回不合格的地方（空数组就是合格）。 */
function synopsisProblems(text, { original = '', title = '', names = [] } = {}) {
  const problems = [];
  const length = countChars(text);
  if (length < SYNOPSIS_MIN || length > SYNOPSIS_MAX)
    problems.push(`现在 ${length} 个字，必须是 ${SYNOPSIS_MIN}–${SYNOPSIS_MAX} 个字（汉字和标点都算）`);
  const usedNames = [...new Set(names)].filter((name) => name && String(text).includes(name));
  if (usedNames.length) problems.push(`用了原简介里的人名：${usedNames.join('、')}（改用身份称呼）`);
  const phrases = sharedPhrases(text, `${original}\n${title}`);
  if (phrases.length) problems.push(`和原简介说法相同：${phrases.slice(0, 6).map((p) => `「${p}」`).join('')}（换种说法）`);
  return problems;
}

const clip = (value, limit) =>
  Array.from(String(value || '').trim())
    .slice(0, limit)
    .join('');

function textOf(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

// ---------- 文案 ----------

function originalInfo({ title, synopsis, source }) {
  return [
    `原剧名：${title}`,
    source ? `来源平台：${source}` : '',
    synopsis ? `原简介：${clip(synopsis, 1500)}` : '原简介：（没有，请只根据剧名合理概括，不要编造具体人名和情节）',
  ]
    .filter(Boolean)
    .join('\n');
}

const JSON_ONLY = '只输出一个 JSON 对象，不要任何解释或 Markdown。字段：';

/** 改写剧名：候选剧名 + 题材 + 标题样式 + 角标。 */
function buildTitleMessages({ title, synopsis, source }) {
  const system = [
    '你是短剧发布运营，负责把短剧的剧名改写得更吸引人，同时不改变剧情事实。',
    JSON_ONLY,
    '- titles：5 个新剧名，每项 {"title":"…","angle":"悬念|反转|身份落差|情绪|金句"}。要求：3–10 个汉字（最好 5–7 个），口语化、强冲突，',
    '  让人一眼想点开；不要标点（可有一个“！”或“？”）；不要出现“最”“第一”“必看”等绝对化用语；不要出现真实人名。',
    '  必须换一种说法：意思和原剧名一致，但不能出现原剧名里的任何关键词' +
      (titleKeywords(title).length ? `（这些词一个都不能有：${titleKeywords(title).join('、')}）` : '') +
      '，用同义的不同说法表达。',
    '- genre：题材，一两个词（如 霸总、重生逆袭、古风、悬疑、甜宠、复仇、玄幻、都市）。',
    `- style：从下面的标题样式里选一个最贴合题材的 id：\n${describeStyles()}`,
    '- tagline：海报角标短句，4–10 个字，有钩子（如“开局即巅峰”“全集已更新”），不要标点。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: originalInfo({ title, synopsis, source }) },
  ];
}

/** 改写简介。 */
function buildSynopsisMessages({ title, synopsis, source }) {
  const system = [
    '你是短剧发布运营，负责把短剧的剧情简介改写得更吸引人，同时不改变剧情事实。',
    JSON_ONLY,
    `- synopsis：改写后的剧情简介，严格 ${SYNOPSIS_MIN}–${SYNOPSIS_MAX} 个字（汉字和标点都算一个字），第三人称。`,
    '  讲的还是同一个故事（人物关系、核心冲突不变），但必须完全换一种说法：',
    '  1. 严禁出现原简介、原剧名里的任何人名，人物一律用身份称呼（如“落魄千金”“冷面总裁”“养女”）；',
    `  2. 严禁沿用原简介的句子和说法，不能有和原简介连着 ${SAME_PHRASE} 个字一样的片段；`,
    '  3. 不剧透结局，结尾留悬念。',
    '- names：原简介里出现的所有人名（字符串数组，没有就给空数组）。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: originalInfo({ title, synopsis, source }) },
  ];
}

/** 海报画面描述（画海报之前现想，依据选定的剧名和简介）。 */
function buildSceneMessages({ title, synopsis }) {
  const system = [
    '你是短剧海报美术指导，根据剧名和简介设计海报画面。',
    JSON_ONLY,
    '- scene：海报画面描述，80 字以内，只写人物（性别、年龄感、神态、服装）、场景、光线、氛围；不要写任何文字内容。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [`剧名：${title}`, synopsis ? `简介：${clip(synopsis, 800)}` : ''].filter(Boolean).join('\n'),
    },
  ];
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/[《》"'“”‘’【】\[\]()（）]/g, '')
    .replace(/[\s·]+/g, '')
    .replace(/[。，,.、；;：:]+$/g, '')
    .trim();
}

function sharedRun(a, b, size = 3) {
  const x = Array.from(a);
  for (let i = 0; i + size <= x.length; i += 1) if (b.includes(x.slice(i, i + size).join(''))) return true;
  return false;
}

/** 把模型给的候选按规则排序：长度合适、有钩子、不与原名雷同。返回去重后的标题数组（最好的在前）。 */
function rankTitles(candidates, original) {
  const seen = new Set();
  const scored = [];
  const keywords = titleKeywords(original);
  (Array.isArray(candidates) ? candidates : []).forEach((item, order) => {
    const title = cleanTitle(typeof item === 'string' ? item : item?.title);
    const length = Array.from(title).length;
    if (length < TITLE_MIN || length > TITLE_MAX || BANNED_TITLE.test(title) || seen.has(title)) return;
    if (title === cleanTitle(original)) return;
    if (keywords.some((word) => title.includes(word))) return; // 不得含原剧名的关键词
    seen.add(title);
    let score = length >= 5 && length <= 7 ? 3 : length === 4 || length === 8 ? 2 : 1;
    if (HOOK_WORDS.some((word) => title.includes(word))) score += 1;
    if (sharedRun(title, String(original || ''))) score -= 1.5;
    score -= order * 0.1; // 模型自己排在前面的略占优
    scored.push({ title, score });
  });
  return scored.sort((a, b) => b.score - a.score).map((item) => item.title);
}

function normalizeTitles(raw, { title, synopsis }) {
  const ranked = rankTitles(raw?.titles, title);
  if (!ranked.length) throw new Error('模型没有给出合格的剧名，请重试');
  const genre = clip(raw?.genre, 20);
  const style = STYLE_IDS.includes(raw?.style) ? raw.style : pickStyleByGenre(genre, title, synopsis, '');
  return { titles: ranked, genre, style, tagline: cleanTitle(clip(raw?.tagline, 12)) };
}

function normalizeSynopsis(raw) {
  return clip(String(raw?.synopsis || '').replace(/\s+/g, ''), 600);
}

/** 模型自己列出的原简介人名，只留像人名的（2–4 个汉字）。 */
function synopsisNames(raw) {
  return (Array.isArray(raw?.names) ? raw.names : [])
    .map((name) => cleanTitle(name))
    .filter((name) => /^\p{Script=Han}{2,4}$/u.test(name));
}

// ---------- 画面 ----------

const ART_RULES = [
  '要求：',
  '1. 画面里绝对不能出现任何文字、字母、数字、字幕、水印、Logo、标题或二维码；',
  '2. 竖版 2:3 短剧海报，电影质感、人脸清晰自然不变形；',
  '3. 人物和主体集中在画面上方三分之二；下方约三分之一是画面自然的延伸（暗部、虚化的场景或渐变），保持干净，留给后期叠加标题。',
].join('\n');

function buildArtPrompt({ scene, hasCover }) {
  const sceneLine = scene ? `画面内容参考：${scene}` : '';
  return hasCover
    ? [
        '参考上传的短剧海报，重新绘制一张同一部剧的新海报：保留主要人物的造型、服装和整体氛围，换成新的构图和光影，并去掉原图里的所有文字、标题和水印。',
        sceneLine,
        ART_RULES,
      ]
        .filter(Boolean)
        .join('\n')
    : ['为一部短剧绘制竖版海报画面。', sceneLine, ART_RULES].filter(Boolean).join('\n');
}

const INSPECT_PROMPT = [
  '检查这张竖版海报底图，只输出一个 JSON 对象，不要解释：',
  '{"has_text": 画面里是否有任何可读的文字、字母、数字、水印或 Logo（true/false）,',
  ' "text_found": "看到的文字，没有则空字符串",',
  ' "faces": [每张人脸的外接框 {"x":左边界,"y":上边界,"w":宽,"h":高}，都是相对整张图的 0–1 小数]}',
].join('\n');

function normalizeInspection(raw) {
  const faces = (Array.isArray(raw?.faces) ? raw.faces : [])
    .map((f) => ({ x: Number(f?.x), y: Number(f?.y), w: Number(f?.w), h: Number(f?.h) }))
    .filter((f) => [f.x, f.y, f.w, f.h].every(Number.isFinite) && f.w > 0 && f.h > 0 && f.w <= 1.01 && f.h <= 1.01)
    .map((f) => ({
      x: Math.max(0, Math.min(1, f.x)),
      y: Math.max(0, Math.min(1, f.y)),
      w: Math.min(1, f.w),
      h: Math.min(1, f.h),
    }))
    .slice(0, 8);
  return { hasText: raw?.has_text === true || raw?.has_text === 'true', textFound: clip(raw?.text_found, 40), faces };
}

function extensionFor(contentType) {
  if (/jpe?g/i.test(contentType || '')) return '.jpg';
  if (/webp/i.test(contentType || '')) return '.webp';
  return '.png';
}

/** 画无字底图；用视觉模型检查有没有字，有就重画（最多 attempts 次）。视觉检查失败不影响出图。 */
async function makeArt({ copy, coverPath, config, openai, signal, attempts, vision, onProgress }) {
  const prompt = buildArtPrompt({ scene: copy.scene, hasCover: !!coverPath });
  let last = null;
  const warnings = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted?.();
    onProgress?.(attempt === 1 ? '正在画海报底图' : `画面里还有文字，第 ${attempt} 次重画`);
    const image = coverPath
      ? await openai.editImage({ image: coverPath, prompt, signal }, config)
      : await openai.generateImage({ prompt, signal }, config);
    if (!image?.buffer) throw new Error('图片接口没有返回图片');
    let inspection = { hasText: false, faces: [], inspected: false };
    if (vision) {
      try {
        onProgress?.('正在检查画面（有没有文字、人脸位置）');
        const mime = /jpe?g/i.test(image.contentType || '') ? 'image/jpeg' : 'image/png';
        const raw = await openai.chatJson(
          [
            { role: 'system', content: '你是海报质检员，严格按要求输出 JSON。' },
            {
              role: 'user',
              content: [
                { type: 'text', text: INSPECT_PROMPT },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${image.buffer.toString('base64')}` } },
              ],
            },
          ],
          { signal },
          config,
        );
        inspection = { ...normalizeInspection(raw), inspected: true };
      } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push('没能用视觉模型检查画面（模型可能不支持看图），已按程序自带的版式判断处理');
      }
    }
    last = { image, inspection };
    if (!inspection.hasText) return { ...last, warnings, attempts: attempt };
  }
  warnings.push(`重画 ${attempts} 次后画面里仍可能有文字（${last.inspection.textFound || '未识别'}），请检查海报`);
  return { ...last, warnings, attempts };
}

// ---------- 状态与输出 ----------

function readState(workDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workDir, STATE_FILE), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(workDir, state) {
  writeAtomic(path.join(workDir, STATE_FILE), JSON.stringify(state, null, 2));
}

function outputPaths(outputDir) {
  return {
    title: path.join(outputDir, OUTPUT_TITLE),
    synopsis: path.join(outputDir, OUTPUT_SYNOPSIS),
    poster: path.join(outputDir, OUTPUT_POSTER),
  };
}

async function renderPoster({ renderer, state, workDir, outputDir, title, styleId, tagline, layout, signal }) {
  signal?.throwIfAborted?.();
  const art = fs.readFileSync(path.join(workDir, state.art.file));
  const out = await renderer.render({
    image: art,
    contentType: state.art.contentType,
    title,
    tagline,
    styleId,
    layout: layout || 'auto',
    faces: state.art.faces || [],
    format: 'jpeg',
  });
  writeAtomic(outputPaths(outputDir).poster, out.buffer);
  return out.meta;
}

function emptyState(originalTitle) {
  return {
    originalTitle,
    copy: { synopsis: '', titles: [], genre: '', style: '', tagline: '', scene: '' },
    chosen: null,
    createdAt: Date.now(),
  };
}

function loadState(workDir, originalTitle) {
  const state = readState(workDir) || emptyState(originalTitle);
  state.copy = { ...emptyState('').copy, ...(state.copy || {}) };
  return state;
}

/** 改写剧名：只给出一批候选，不会替换已保存的剧名（选一个并点「保存」才生效）。 */
async function makeTitles({
  title,
  synopsis = '',
  source = '',
  outputDir,
  workDir,
  config,
  copyConfig,
  openai,
  signal,
  onProgress,
}) {
  if (!title) throw new Error('缺少剧名');
  onProgress?.({ stage: 'titles', message: '正在改写剧名' });
  const messages = buildTitleMessages({ title, synopsis, source });
  let found = null;
  let lastError = null;
  for (let attempt = 1; attempt <= TITLE_ATTEMPTS && !found; attempt += 1) {
    // 文案改写可以单独走 DeepSeek 等文本模型（设置里的「文案改写」），没填就用通用文本模型。
    const raw = await openai.chatJson(messages, { signal }, copyConfig || config);
    try {
      found = normalizeTitles(raw, { title, synopsis });
    } catch (error) {
      lastError = error;
      // 全被刷掉了（多半是用了原剧名的词）：把问题告诉模型再写一轮。
      messages.push(
        { role: 'assistant', content: JSON.stringify(raw ?? {}) },
        {
          role: 'user',
          content: `这些剧名都不合格：不能出现原剧名里的关键词（${titleKeywords(title).join('、') || '原剧名的词'}），长度 ${TITLE_MIN}–${TITLE_MAX} 个字。请换种说法重新给 5 个，仍只输出 JSON。`,
        },
      );
    }
  }
  if (!found) throw lastError || new Error('模型没有给出合格的剧名，请重试');
  const state = loadState(workDir, title);
  Object.assign(state.copy, found);
  writeState(workDir, state);
  return summarize(state, outputPaths(outputDir), null);
}

/** 改写简介。 */
async function makeSynopsis({
  title,
  synopsis = '',
  source = '',
  outputDir,
  workDir,
  config,
  copyConfig,
  openai,
  signal,
  onProgress,
}) {
  if (!title) throw new Error('缺少剧名');
  onProgress?.({ stage: 'synopsis', message: '正在改写简介' });
  // 严格校验：字数、人名、和原文相同的说法，有一样不合格就把问题原样告诉模型重写，最多 SYNOPSIS_ATTEMPTS 次。
  const messages = buildSynopsisMessages({ title, synopsis, source });
  let next = '';
  let problems = [];
  let names = [];
  for (let attempt = 1; attempt <= SYNOPSIS_ATTEMPTS; attempt += 1) {
    const raw = await openai.chatJson(messages, { signal }, copyConfig || config);
    names = [...new Set([...names, ...synopsisNames(raw)])];
    next = normalizeSynopsis(raw);
    problems = synopsisProblems(next, { original: synopsis, title, names });
    if (!problems.length) break;
    onProgress?.({ stage: 'synopsis', message: `简介不合格，第 ${attempt + 1} 次重写：${problems[0]}` });
    messages.push(
      { role: 'assistant', content: JSON.stringify({ synopsis: next, names }) },
      { role: 'user', content: `这一版不合格：${problems.join('；')}。请按要求重写，仍只输出 JSON。` },
    );
  }
  if (problems.length)
    throw new Error(`改写了 ${SYNOPSIS_ATTEMPTS} 次都没有完全合格（${problems.join('；')}），请再点一次「重新改写」`);
  const state = loadState(workDir, title);
  // 只是 AI 写的新版本，放在「待保存」里；点「保存」才会写进简介文件。
  state.copy.synopsis = next;
  writeState(workDir, state);
  return summarize(state, outputPaths(outputDir), null);
}

/** 保存简介（AI 新写的或手改的）：写进简介文件，之后算「已保存」。 */
function saveSynopsis({ outputDir, workDir, synopsis }) {
  const text = clip(String(synopsis ?? '').replace(/\r\n?/g, '\n'), 600).trim();
  const length = countChars(text);
  if (length < SYNOPSIS_MIN || length > SYNOPSIS_MAX)
    throw new Error(`简介现在 ${length} 个字，要 ${SYNOPSIS_MIN}–${SYNOPSIS_MAX} 个字（汉字和标点都算）`);
  const state = loadState(workDir, '');
  state.copy.synopsis = text;
  const paths = outputPaths(outputDir);
  writeAtomic(paths.synopsis, text + '\n');
  writeState(workDir, state);
  return summarize(state, paths, null);
}

/** 生成海报：必须先选定剧名。画面描述 → 无字底图 → 程序叠标题。 */
async function makePoster({
  synopsis = '',
  coverPath = null,
  outputDir,
  workDir,
  config,
  copyConfig,
  openai,
  renderer,
  signal,
  onProgress,
  artAttempts = 3,
  vision = true,
}) {
  if (!outputDir || !workDir) throw new Error('缺少输出目录');
  const state = readState(workDir);
  const chosen = state?.chosen;
  if (!chosen?.title) throw new Error('请先选定剧名，再生成海报');
  state.copy = { ...emptyState('').copy, ...(state.copy || {}) };
  const paths = outputPaths(outputDir);
  const report = (stage, message) => onProgress?.({ stage, message });

  report('scene', '正在构思海报画面');
  const sceneRaw = await openai.chatJson(
    buildSceneMessages({ title: chosen.title, synopsis: textOf(paths.synopsis).trim() || synopsis }),
    { signal },
    copyConfig || config,
  );
  state.copy.scene = clip(sceneRaw?.scene, 300);
  if (!state.copy.scene) throw new Error('模型没有给出海报画面，请重试');

  report('art', '正在画海报底图');
  const art = await makeArt({
    copy: state.copy,
    coverPath,
    config,
    openai,
    signal,
    attempts: artAttempts,
    vision,
    onProgress: (message) => report('art', message),
  });
  const file = `art${extensionFor(art.image.contentType)}`;
  for (const stale of fs.existsSync(workDir) ? fs.readdirSync(workDir) : [])
    if (/^art\./.test(stale) && stale !== file) fs.rmSync(path.join(workDir, stale), { force: true });
  writeAtomic(path.join(workDir, file), art.image.buffer);
  state.art = {
    file,
    contentType: art.image.contentType || 'image/png',
    faces: art.inspection.faces,
    inspected: art.inspection.inspected,
    attempts: art.attempts,
    warnings: art.warnings,
    updatedAt: Date.now(),
  };
  writeState(workDir, state);

  report('poster', '正在把标题排到海报上');
  const meta = await renderPoster({
    renderer,
    state,
    workDir,
    outputDir,
    title: chosen.title,
    styleId: chosen.style,
    tagline: chosen.tagline,
    signal,
  });
  return summarize(state, paths, meta);
}

const TASKS = { titles: makeTitles, synopsis: makeSynopsis, poster: makePoster };

/** 三件事各自独立：task = titles（剧名）/ synopsis（简介）/ poster（海报，要先选定剧名）。 */
function generate({ task, ...options }) {
  const run = TASKS[task];
  if (!run) throw new Error('未知的发布素材任务');
  return run(options);
}

/**
 * 选定 / 修改剧名、标题样式、角标：不调用模型。已有海报就顺手重新排版，还没有海报就只记下来（画海报之前必须先选定剧名）。
 */
async function retitle({ outputDir, workDir, renderer, title, styleId, tagline, layout, signal }) {
  const state = loadState(workDir, String(title || ''));
  const current = state.chosen || {};
  const nextTitle = cleanTitle(title ?? current.title ?? '');
  const length = Array.from(nextTitle).length;
  if (length < 1 || length > 16) throw new Error('标题需要 1–16 个字');
  const style = styleId == null ? current.style || state.copy.style || STYLE_IDS[0] : styleId;
  if (!STYLE_IDS.includes(style)) throw new Error('未知的标题样式');
  const nextTagline = tagline == null ? (current.tagline ?? state.copy.tagline ?? '') : cleanTitle(clip(tagline, 12));
  const paths = outputPaths(outputDir);
  let meta = null;
  if (state.art?.file) {
    meta = await renderPoster({
      renderer,
      state,
      workDir,
      outputDir,
      title: nextTitle,
      styleId: style,
      tagline: nextTagline,
      layout,
      signal,
    });
  }
  state.chosen = { title: nextTitle, style, tagline: nextTagline };
  writeAtomic(paths.title, nextTitle + '\n');
  writeState(workDir, state);
  return summarize(state, paths, meta);
}

function summarize(state, paths, meta) {
  const chosen = state.chosen || {};
  const saved = textOf(paths.synopsis).trim();
  const proposed = state.copy?.synopsis || '';
  return {
    title: chosen.title || '',
    styleId: chosen.style || state.copy?.style || STYLE_IDS[0],
    tagline: chosen.tagline ?? state.copy?.tagline ?? '',
    candidates: state.copy?.titles || [],
    genre: state.copy?.genre || '',
    synopsis: saved,
    // AI 刚写好、还没点保存的简介（和已保存的不一样才有）
    proposedSynopsis: proposed && proposed !== saved ? proposed : '',
    warnings: state.art?.warnings || [],
    paths,
    layout: meta?.layout || '',
  };
}

/** 读取已有的结果（什么都没做过返回 null）。 */
function readResult({ outputDir, workDir }) {
  const state = readState(workDir);
  const paths = outputPaths(outputDir);
  if (!state) return null;
  const poster = fs.existsSync(paths.poster) ? paths.poster : null;
  const base = summarize(state, { ...paths, poster: poster || '' }, null);
  return { ...base, hasPoster: !!poster, title: textOf(paths.title).trim() || base.title };
}

module.exports = {
  OUTPUT_TITLE,
  OUTPUT_SYNOPSIS,
  OUTPUT_POSTER,
  buildTitleMessages,
  buildSynopsisMessages,
  buildSceneMessages,
  buildArtPrompt,
  normalizeTitles,
  normalizeSynopsis,
  synopsisProblems,
  titleKeywords,
  sharedPhrases,
  countChars,
  SYNOPSIS_MIN,
  SYNOPSIS_MAX,
  normalizeInspection,
  rankTitles,
  cleanTitle,
  generate,
  makeTitles,
  makeSynopsis,
  makePoster,
  retitle,
  saveSynopsis,
  readResult,
  outputPaths,
};
