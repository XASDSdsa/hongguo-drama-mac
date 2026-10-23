'use strict';
// 成本配置报告的总投资额：按 Seedance 2.5 的官方价格，用成品（去重后的每一集）的时长和清晰度算出 AI 生成这部剧要花多少钱。
// 价格来源：火山方舟「模型价格」页（https://docs.volcengine.com/docs/ark/model-pricing?lang=zh，2026-10-22 查）：
//   doubao-seedance-2.5，在线推理，输入不含视频（文字 / 参考图生成视频，分镜工程图就是这种）：
//     480p、720p 70 元 / 百万 token；1080p 77 元 / 百万 token
//   token 用量 = 视频时长 × 宽 × 高 × 帧率 / 1024（输出 24 帧）
//   官方示例（5 秒 16:9）：480p 3.36 元、720p 7.56 元、1080p 18.71 元——下面的算法和它一致（见 check-cost-report.cjs）
// 抽卡（同一集生成好几次挑一个，每次都收全价）：每集随机抽 min～max 次（默认 1～3 次），费用乘上次数。
// 随机数由「种子 + 文件名」算出来：同一部剧不换种子，每次打开、每次生成报告都是同一组次数；换种子才重新随机。

const PRICE = {
  model: 'doubao-seedance-2.5',
  mode: '在线推理，输入不含视频（文字 / 参考图生成视频）',
  checked: '2026-10-22',
  source: 'https://docs.volcengine.com/docs/ark/model-pricing?lang=zh',
  fps: 24,
  // 按短边分档；每档按官方输出尺寸算像素（竖屏横屏像素数一样）
  tiers: [
    { name: '1080p', width: 1920, height: 1080, minShort: 1000, yuanPerMillion: 77 },
    { name: '720p', width: 1280, height: 720, minShort: 600, yuanPerMillion: 70 },
    { name: '480p', width: 854, height: 480, minShort: 0, yuanPerMillion: 70 },
  ],
};

/** 成品画面按哪一档清晰度生成：短边 1000 以上算 1080p，600 以上算 720p，再小算 480p。 */
function tierFor(width, height) {
  const short = Math.min(Number(width) || 0, Number(height) || 0);
  return PRICE.tiers.find((tier) => short >= tier.minShort) || PRICE.tiers[PRICE.tiers.length - 1];
}

/** 一集：{ seconds, width, height } → { tier, tokens, yuan }。 */
function episodeCost({ seconds, width, height }) {
  const tier = tierFor(width, height);
  const tokens = ((Number(seconds) || 0) * tier.width * tier.height * PRICE.fps) / 1024;
  return { tier: tier.name, tokens, yuan: (tokens * tier.yuanPerMillion) / 1e6 };
}

// 抽卡次数能设的范围
const DRAW_LIMIT = 10;
const DEFAULT_DRAWS = { min: 1, max: 3 };
// 演员片酬占总投资的比例（百分数），默认 15%；最多 95%（再大总投资就没法算了）
const DEFAULT_ACTOR_PERCENT = 15;
const ACTOR_PERCENT_LIMIT = 95;

/** 演员片酬占比（百分数）：0～95，没填 / 填错按 15。 */
function normalizeActorPercent(value) {
  const number = value === '' || value == null ? NaN : Number(value);
  if (!Number.isFinite(number)) return DEFAULT_ACTOR_PERCENT;
  return Math.min(ACTOR_PERCENT_LIMIT, Math.max(0, Math.round(number * 10) / 10));
}

/** 抽卡次数范围：整数，1～10，min 不大于 max。 */
function normalizeDraws(draws = {}) {
  const clamp = (value, fallback) => Math.min(DRAW_LIMIT, Math.max(1, Math.round(Number(value)) || fallback));
  const min = clamp(draws.min, DEFAULT_DRAWS.min);
  const max = Math.max(min, clamp(draws.max, DEFAULT_DRAWS.max));
  return { min, max, seed: String(draws.seed ?? '') };
}

/** 一集抽几次：由种子和这一集的文件名定（FNV-1a 哈希），在 min～max 之间均匀分布。 */
function drawCount(seed, key, min, max) {
  let hash = 0x811c9dc5;
  for (const ch of `${seed}|${key}`) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return min + (hash % (max - min + 1));
}

/**
 * 整部剧：每一集按自己的时长和清晰度算，乘上这一集的抽卡次数，加起来就是 AI 生成费用。
 * actorPercent 是演员片酬占总投资的百分比：总投资 = AI 生成费用 ÷ (1 − 占比)，演员片酬 = 总投资 × 占比。
 * list 里每一集 { name, seconds, width, height }（name 用来定抽卡次数）。
 * 返回 { episodes, seconds, tokens, generation, actorFee, total, actorShare, draws: { min, max, seed, total, average, counts },
 *        tiers: [{ name, width, height, episodes, seconds, generations, tokens, yuan, yuanPerMillion }] }。
 */
function seriesCost(list, { actorPercent = 0, draws } = {}) {
  // 没传 draws（旧调用）就是不抽卡：每集一次
  const range = draws ? normalizeDraws(draws) : { min: 1, max: 1, seed: '' };
  const tiers = new Map();
  const counts = {};
  let seconds = 0;
  let tokens = 0;
  let generation = 0;
  let generations = 0;
  for (const [index, item] of list.entries()) {
    const once = episodeCost(item);
    const times =
      range.min === range.max ? range.min : drawCount(range.seed, item.name ?? String(index), range.min, range.max);
    counts[times] = (counts[times] || 0) + 1;
    generations += times;
    const cost = { tier: once.tier, tokens: once.tokens * times, yuan: once.yuan * times };
    seconds += Number(item.seconds) || 0;
    tokens += cost.tokens;
    generation += cost.yuan;
    const tier = PRICE.tiers.find((entry) => entry.name === cost.tier);
    const row = tiers.get(cost.tier) || {
      name: cost.tier,
      width: tier.width,
      height: tier.height,
      episodes: 0,
      seconds: 0,
      generations: 0,
      tokens: 0,
      yuan: 0,
      yuanPerMillion: tier.yuanPerMillion,
    };
    row.episodes += 1;
    row.seconds += Number(item.seconds) || 0;
    row.generations += times;
    row.tokens += cost.tokens;
    row.yuan += cost.yuan;
    tiers.set(cost.tier, row);
  }
  const percent = normalizeActorPercent(actorPercent);
  const total = generation / (1 - percent / 100);
  const fee = total - generation;
  return {
    episodes: list.length,
    seconds,
    tokens: Math.round(tokens),
    generation,
    actorFee: fee,
    total,
    actorShare: percent / 100,
    draws: { ...range, total: generations, average: list.length ? generations / list.length : 0, counts },
    tiers: PRICE.tiers.map((tier) => tiers.get(tier.name)).filter(Boolean),
  };
}

/** 报告表格里的写法：几分几秒（不折成小时，和备案材料常见写法一致） */
function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes ? `${minutes}分` : ''}${rest}秒`;
}
const formatEpisodes = (episodes, seconds) => `${episodes}集，共${formatDuration(seconds)}`;
/** 总投资额：和模板一样写「万元」，保留两位小数（不到 1 万也写万元，比如 0.82万元）。 */
const formatWan = (yuan) => `${(Math.round((Number(yuan) || 0) / 100) / 100).toFixed(2)}万元`;
const formatShare = (share) => `${Math.round((Number(share) || 0) * 1000) / 10}%`;
const formatYuan = (yuan) =>
  `${(Number(yuan) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`;

// 报审的硬性要求（模板表头写的）
const LIMITS = { totalYuan: 1_000_000, actorShare: 0.4 };

module.exports = {
  PRICE,
  LIMITS,
  DRAW_LIMIT,
  DEFAULT_DRAWS,
  DEFAULT_ACTOR_PERCENT,
  ACTOR_PERCENT_LIMIT,
  normalizeActorPercent,
  normalizeDraws,
  drawCount,
  tierFor,
  episodeCost,
  seriesCost,
  formatDuration,
  formatEpisodes,
  formatWan,
  formatShare,
  formatYuan,
};
