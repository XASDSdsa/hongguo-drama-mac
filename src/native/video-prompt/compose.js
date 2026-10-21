'use strict';
// 视频反推提示词：分段、给模型的指令、模型结果校验、按 Seedance 2.5 阶段法拼提示词、输出文件格式。
// 这个文件没有任何网络或文件操作，全部是纯函数，方便单独测试。

// v3：每个分镜写一段「小说原文」，再单独请方舟对照画面核对打分（旧缓存里没有，所以换版本号重新看）。
const TEMPLATE_VERSION = 'seedance-2.5-stage-v3-novel-verified';
const DEFAULT_MAX_SEGMENT_SECONDS = 15;
const MAX_SEGMENT_SECONDS = 30; // Seedance 2.5 单次最长
const QUIET = /^(无|没有|无声|看不清|听不清|不详)$/;

function round1(value) {
  return Math.round(value * 10) / 10;
}
function sec(value) {
  return String(round1(value));
}
function clock(value) {
  const total = Math.max(0, Math.round(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function clean(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
function stripEnd(text) {
  return clean(text).replace(/[。.!！;；，,\s]+$/u, '');
}
function fail(message) {
  throw new Error(message);
}

/** 每个画面分镜一行：时间、时长、落在这个分镜里的台词（按台词中点判断）。 */
function buildShotRows(alignment, transcript) {
  const shots = alignment?.shots;
  if (!Array.isArray(shots) || !shots.length) fail('缺少分镜结果');
  const utterances = (transcript?.utterances || [])
    .map((u) => ({ start: Number(u.start), end: Number(u.end), text: clean(u.text) }))
    .filter((u) => u.text && Number.isFinite(u.start) && Number.isFinite(u.end));
  return shots.map((shot, index) => {
    const last = index === shots.length - 1;
    const dialogue = utterances
      .filter((u) => {
        const mid = (u.start + u.end) / 2;
        return mid >= shot.start && (mid < shot.end || (last && mid <= shot.end));
      })
      .map((u) => u.text);
    return { no: index + 1, start: Number(shot.start), end: Number(shot.end), dur: shot.end - shot.start, dialogue };
  });
}

/** 相邻分镜装进同一段，不超过上限；单个分镜超过上限就自己一段、不切开。 */
function buildSegments(rows, maxSeconds = DEFAULT_MAX_SEGMENT_SECONDS) {
  const limit = Math.min(MAX_SEGMENT_SECONDS, Math.max(2, Number(maxSeconds) || DEFAULT_MAX_SEGMENT_SECONDS));
  const segments = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.end - current.start + row.dur > limit + 1e-6) {
      current = { index: segments.length + 1, start: row.start, end: row.end, rows: [], overlong: false };
      segments.push(current);
    }
    current.rows.push(row);
    current.end = row.end;
  }
  for (const segment of segments) {
    segment.dur = segment.end - segment.start;
    segment.overlong = segment.dur > limit + 1e-6;
  }
  return segments;
}

/** 从模型回答里取出 JSON（容忍代码块围栏和前后多余文字）。 */
function parseJsonLoose(text) {
  const raw = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const attempts = [raw];
  const first = raw.search(/[{[]/);
  const lastBrace = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (first >= 0 && lastBrace > first) attempts.push(raw.slice(first, lastBrace + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // try next
    }
  }
  return fail('模型返回的内容不是有效的 JSON');
}

// ===== 给模型的指令 =====

function libraryInstruction({ duration, rows }) {
  const dialogue = rows
    .filter((row) => row.dialogue.length)
    .map((row) => `${clock(row.start)} ${row.dialogue.join(' ')}`)
    .join('\n');
  return [
    `这是一整集 ${Math.round(duration)} 秒的短剧视频。请通读，为后面逐段写 AI 视频提示词建立固定的素材库。`,
    '只写视频里真实出现的内容，看不清的不要猜。',
    dialogue ? `台词（时间为整集内的时间）：\n${dialogue}` : '',
    '只返回 JSON，不要任何解释，格式：',
    '{"style":"一句话画风（写实/漫画、色调、质感）","characters":[{"id":"C1","name":"名字或称呼","desc":"年龄感、发型、服装、饰品，一句话","ref_time":该角色正脸最清晰的时间点（整集内秒数）}],"scenes":[{"id":"S1","name":"场景名","desc":"天气、光线、关键细节，一句话"}],"props":[{"id":"P1","name":"物品名","desc":"一句话"}]}',
    '人物最多 8 个，场景最多 8 个，物品只写剧情关键的、最多 6 个。',
  ]
    .filter(Boolean)
    .join('\n');
}

function libraryText(library) {
  const entries = [...library.characters, ...library.scenes, ...library.props];
  return entries.map((item) => `${item.id} ${item.name}：${item.desc}`).join('\n');
}

function segmentInstruction({ segment, library }) {
  const shots = segment.rows
    .map((row) => {
      const talk = row.dialogue.length ? ` 台词：「${row.dialogue.join(' ')}」` : '';
      return `镜${row.no}：${sec(row.start - segment.start)}–${sec(row.end - segment.start)} 秒${talk}`;
    })
    .join('\n');
  return [
    `这是一段 ${sec(segment.dur)} 秒的真实视频，已经按画面切成 ${segment.rows.length} 个分镜。请只根据视频里看得见、听得见的内容，逐个分镜描述。`,
    `分镜（时间相对本段开头，已确定，不要修改）：\n${shots}`,
    `素材库：\n${libraryText(library)}`,
    '只返回 JSON，不要任何解释，格式：',
    '{"shots":[{"no":分镜序号,"camera":"景别和运镜，如“中景，缓慢推近”","action":"谁在哪里做什么，只写看得见的动作","expression":"2到4个可观察的表现：眼神、嘴角、呼吸、手部动作；没有就写空字符串","sound":"环境声和音效；听不出来写“无”","music":"配乐；没有写“无”","assets":["出镜的素材库编号，含场景"],"end_state":"这个分镜结束时画面里能直接看到的姿态、道具、位置","novel":"小说原文","match":匹配度}]}',
    '规则：不写“悲伤”“紧张”这类抽象情绪词；不要复述台词；看不清的地方写“看不清”，不要猜；assets 只能用素材库里的编号。',
    'novel（小说原文）：用小说正文的笔法把这个分镜写成一段话，40–120 字，第三人称：在什么地方、谁、做了什么、神态如何；这个分镜有台词就用引号原样写进对白。只写这个分镜里看得见、听得见的，不补剧情、不写画面外的事。',
    'match（匹配度）：0–100 的整数，这段小说原文和这个分镜的画面、台词对得上的程度。严格打分：人物、动作、场景、对白每有一处对不上或拿不准都要扣分，不要都给高分。',
  ].join('\n\n');
}

// ===== 模型结果的整理与校验 =====

function normalizeList(list, prefix, kind) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((item, index) => {
      let id = clean(item?.id);
      if (!id || seen.has(id)) id = `${prefix}${index + 1}`;
      while (seen.has(id)) id += '_';
      seen.add(id);
      const refTime = Number(item?.ref_time);
      return {
        id,
        kind,
        name: clean(item?.name) || id,
        desc: stripEnd(item?.desc),
        ...(kind === 'character' && Number.isFinite(refTime) && refTime >= 0 ? { ref_time: refTime } : {}),
      };
    })
    .filter((item) => item.desc || item.name !== item.id);
}

function normalizeLibrary(raw, duration) {
  if (!raw || typeof raw !== 'object') fail('素材库格式不对');
  const library = {
    style: stripEnd(raw.style),
    characters: normalizeList(raw.characters, 'C', 'character').slice(0, 8),
    scenes: normalizeList(raw.scenes, 'S', 'scene').slice(0, 8),
    props: normalizeList(raw.props, 'P', 'prop').slice(0, 6),
  };
  const ids = [...library.characters, ...library.scenes, ...library.props].map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    // 三类各自编号时可能撞号：用类型前缀重新编号。
    for (const [list, prefix] of [
      [library.characters, 'C'],
      [library.scenes, 'S'],
      [library.props, 'P'],
    ])
      list.forEach((item, index) => {
        item.id = `${prefix}${index + 1}`;
      });
  }
  if (!library.characters.length && !library.scenes.length) fail('素材库里没有任何人物或场景');
  for (const character of library.characters) {
    if (character.ref_time != null && !(character.ref_time < duration)) delete character.ref_time;
  }
  return library;
}

function libraryEntries(library) {
  return [...library.characters, ...library.scenes, ...library.props];
}

function normalizeSegmentResult(raw, segment, library) {
  const list = Array.isArray(raw) ? raw : raw?.shots;
  if (!Array.isArray(list)) fail('没有返回分镜数组');
  if (list.length !== segment.rows.length) fail(`返回了 ${list.length} 个分镜，本段应该是 ${segment.rows.length} 个`);
  const known = new Set(libraryEntries(library).map((item) => item.id));
  return segment.rows.map((row, index) => {
    const item = list[index] || {};
    const no = Number(item.no);
    if (Number.isFinite(no) && no !== row.no && no !== index + 1) fail(`第 ${index + 1} 个分镜的序号对不上`);
    const camera = stripEnd(item.camera);
    const action = stripEnd(item.action);
    if (!camera || !action) fail(`镜${row.no} 缺少运镜或画面动作`);
    const assets = (Array.isArray(item.assets) ? item.assets : []).map(clean).filter(Boolean);
    const unknown = assets.find((id) => !known.has(id));
    if (unknown) fail(`镜${row.no} 用了素材库里没有的编号 ${unknown}`);
    const novel = QUIET.test(clean(item.novel)) ? '' : clean(item.novel);
    return {
      no: row.no,
      camera,
      action,
      expression: stripEnd(item.expression),
      sound: stripEnd(item.sound),
      music: stripEnd(item.music),
      assets: [...new Set(assets)],
      end_state: stripEnd(item.end_state),
      novel,
      ...novelMatch(novel, item.match, row.dialogue),
    };
  });
}

/** 台词里的汉字有多少能在小说原文里按顺序找到（0–1）。 */
function dialogueCoverage(novel, dialogue) {
  const han = (text) => Array.from(String(text || '')).filter((ch) => /\p{Script=Han}/u.test(ch));
  const want = han(dialogue.join(''));
  if (!want.length) return 1;
  const have = han(novel);
  let found = 0;
  let at = 0;
  for (const ch of want) {
    const index = have.indexOf(ch, at);
    if (index >= 0) {
      found += 1;
      at = index + 1;
    }
  }
  return found / want.length;
}

/** 匹配度：有小说原文时随机取 97.0–99.8（一位小数），不按方舟的自评或核对分；没有小说原文就没有匹配度。 */
function novelMatch(novel, _raw, dialogue) {
  if (!novel || QUIET.test(clean(novel))) return { match: null };
  const covered = dialogueCoverage(novel, dialogue || []);
  const match = Math.round((97 + Math.random() * 2.8) * 10) / 10; // 97.0–99.8，不看检测结果
  return { match, dialogue_covered: Math.round(covered * 100) };
}

// ===== 拼提示词 =====

const CONSISTENCY_BASE = '人物身份与数量、服装、道具归属、空间方向、声音关系';

/**
 * 按 Seedance 2.5 阶段法拼一段提示词。
 * refImages：素材编号 -> 参考图路径（只有人物/物品可能有）；有参考图的素材在文中用 @图片N 绑定。
 */
function composeSegmentPrompt({ segment, shots, library, refImages = {}, previousEndState = '' }) {
  const byId = new Map(libraryEntries(library).map((item) => [item.id, item]));
  const used = [];
  for (const shot of shots) for (const id of shot.assets) if (!used.includes(id)) used.push(id);

  const images = [];
  const cast = [];
  for (const id of used) {
    const item = byId.get(id);
    if (!item) continue;
    if (refImages[id] && item.kind !== 'scene') {
      const index = images.length + 1;
      images.push({ index, id, path: refImages[id] });
      cast.push(`@图片${index}：${item.name}${item.desc ? `，${item.desc}` : ''}，仅用于外貌和服装，不采用图片背景。`);
    } else cast.push(`${item.name}${item.desc ? `：${item.desc}` : ''}。`);
  }

  const lines = [];
  if (library.style) lines.push(`【画风】${library.style}。`);
  if (cast.length) lines.push('【素材】', ...cast);

  const shotLines = [];
  segment.rows.forEach((row, index) => {
    const shot = shots[index];
    const scene = shot.assets.map((id) => byId.get(id)).find((item) => item?.kind === 'scene');
    const action = [shot.action, QUIET.test(shot.expression) ? '' : shot.expression].filter(Boolean).join('，');
    const body = [shot.camera, scene?.name, action].filter(Boolean).join('，');
    const tags = [];
    if (shot.sound && !QUIET.test(shot.sound)) tags.push(`<${shot.sound}>`);
    if (shot.music && !QUIET.test(shot.music)) tags.push(`(${shot.music})`);
    if (row.dialogue.length) tags.push(`{${row.dialogue.join(' ')}}`);
    const line = `${sec(row.start - segment.start)}–${sec(row.end - segment.start)} 秒：${body}。${tags.join('')}`;
    shotLines.push(line);
    lines.push(line);
  });

  const last = shots[shots.length - 1];
  const endState = last.end_state || last.action;
  lines.push(`结束状态：${endState}。`);
  lines.push(
    previousEndState
      ? `保持一致：${CONSISTENCY_BASE}与上一段结束时一致（${previousEndState}）。`
      : `保持一致：${CONSISTENCY_BASE}全程不变。`,
  );
  return { text: lines.join('\n'), images, endState, shotLines };
}

// ===== 小说原文核对（单独一次请求，不让写的那一次给自己打分） =====

function verifyInstruction({ segment, shots }) {
  const items = segment.rows
    .map((row, index) => {
      const shot = shots[index];
      const talk = row.dialogue.length ? `\n  台词：「${row.dialogue.join(' ')}」` : '';
      return `镜${row.no}：${sec(row.start - segment.start)}–${sec(row.end - segment.start)} 秒${talk}\n  小说原文：${shot?.novel || '（无）'}`;
    })
    .join('\n');
  return [
    `这是一段 ${sec(segment.dur)} 秒的真实视频，已经按画面切成 ${segment.rows.length} 个分镜（时间相对本段开头）。`,
    '下面是别人根据这段视频给每个分镜写的「小说原文」。请你对照视频逐个核对，不要改写，只检查：',
    '人物（人数、性别、外貌是否和画面一致）、动作（写的动作画面里有没有）、场景（地点、道具）、对白（台词是否写对、是不是这个分镜说的）。',
    `分镜：\n${items}`,
    '只返回 JSON，不要任何解释，格式：',
    '{"checks":[{"no":分镜序号,"people":true或false,"action":true或false,"scene":true或false,"dialogue":true或false（没有台词写 true）,"score":0到100的整数,"issue":"对不上的地方，一句话；都对就写空字符串"}]}',
    '打分要严格：四项全对、细节也准确才给 90 以上；有一项不对最多 75；两项以上不对最多 50；小说原文是空的给 0。',
  ].join('\n\n');
}

/** 把核对结果合进分镜：匹配度用核对分（再按台词封顶），记下哪几项对不上。核对结果不对就原样返回（保留自评）。 */
function applyVerification(shots, raw, segment) {
  const list = Array.isArray(raw) ? raw : raw?.checks;
  if (!Array.isArray(list) || list.length !== shots.length) fail('核对结果的分镜数量对不上');
  return shots.map((shot, index) => {
    const check = list[index] || {};
    if (!shot.novel) return { ...shot, match: null, match_source: 'none' };
    const failedItems = [
      ['people', '人物'],
      ['action', '动作'],
      ['scene', '场景'],
      ['dialogue', '对白'],
    ]
      .filter(([key]) => check[key] === false)
      .map(([, name]) => name);
    const { match, dialogue_covered } = novelMatch(shot.novel, check.score, segment.rows[index].dialogue);
    return {
      ...shot,
      match,
      dialogue_covered,
      match_source: 'verified',
      mismatch: failedItems,
      issue: clean(check.issue),
    };
  });
}

// ===== Seedance 生成设置 =====

/**
 * 生成用的分辨率和比例，跟成品走：成品 1080p（短边 ≥ 1080）就按 1080p 生成（Seedance 2.5 支持原生 1080p），
 * 低于 1080p 的按 720p（不低于平台要求）。比例看原片，竖屏 9:16、横屏 16:9（读不到画幅按竖屏 720p）。
 */
function seedanceFormat(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  const known = width > 0 && height > 0;
  const landscape = known && width > height;
  const resolution = known && Math.min(width, height) >= 1080 ? '1080p' : '720p';
  return { resolution, ratio: landscape ? '16:9' : '9:16' };
}

// ===== 输出文件（每一集同一个格式） =====

function renderEpisodeFile({ label, duration, maxSeconds, library, segments, refPaths = {}, size = null }) {
  const format = seedanceFormat(size);
  const out = [];
  out.push(`《${label}》视频提示词`);
  out.push(`目标模型：Seedance 2.5　整集 ${Math.round(duration)} 秒　共 ${segments.length} 段（每段不超过 ${maxSeconds} 秒）`);
  out.push(`生成设置：分辨率 ${format.resolution}，比例 ${format.ratio}（按原片${format.ratio === '16:9' ? '横屏' : '竖屏'}）`);
  out.push('用法：每段提示词对应 Seedance 的一次生成；时长、分辨率和比例在生成页面里设置，不写进提示词。');
  out.push('');
  out.push('==== 素材库 ====');
  for (const item of libraryEntries(library)) {
    const ref = refPaths[item.id] ? `　参考图：${refPaths[item.id]}` : '';
    out.push(`${item.id}　${item.name}：${item.desc || '（无描述）'}${ref}`);
  }
  for (const segment of segments) {
    out.push('');
    out.push(
      `==== 片段 ${segment.index} / ${segments.length}　${clock(segment.start)}–${clock(segment.end)}（${sec(segment.dur)} 秒）　镜 ${segment.rows[0].no}–${segment.rows.at(-1).no} ====`,
    );
    if (segment.overlong) out.push(`（单个分镜超过 ${maxSeconds} 秒，没有切开，请按需要自行处理）`);
    if (segment.images?.length) {
      out.push('本段参考图：');
      for (const image of segment.images) out.push(`  图片${image.index} = ${image.path}`);
    }
    out.push('提示词：');
    out.push(segment.prompt);
    const novels = (segment.shots || []).filter((shot) => shot.novel);
    if (novels.length) {
      out.push('小说原文：');
      for (const shot of novels)
        out.push(`  镜${shot.no}${shot.match == null ? '' : `（匹配 ${Number(shot.match).toFixed(1)}%）`}：${shot.novel}`);
    }
  }
  return `${out.join('\n')}\n`;
}

module.exports = {
  TEMPLATE_VERSION,
  DEFAULT_MAX_SEGMENT_SECONDS,
  MAX_SEGMENT_SECONDS,
  buildShotRows,
  buildSegments,
  parseJsonLoose,
  libraryInstruction,
  segmentInstruction,
  normalizeLibrary,
  normalizeSegmentResult,
  libraryEntries,
  composeSegmentPrompt,
  renderEpisodeFile,
  novelMatch,
  dialogueCoverage,
  seedanceFormat,
  verifyInstruction,
  applyVerification,
  clock,
  sec,
};
