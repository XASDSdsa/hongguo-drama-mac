/**
 * 海报标题的字体样式模板（纯数据，没有任何依赖）。
 *
 * 宽度、描边、挤出等尺寸都以“字号”为单位，渲染器按实际字号换算，所以同一套模板
 * 适用于任何分辨率的海报。字体来自 @fontsource（SIL OFL 1.1，可商用、可随应用分发）。
 */

// font: 打包目录名（build/title-fonts/<font>/），family: CSS 字体名，weight: 打包的字重
const FONTS = {
  'noto-sans-sc': { family: 'Noto Sans SC', weight: 900, label: '思源黑体 Black' },
  'noto-serif-sc': { family: 'Noto Serif SC', weight: 900, label: '思源宋体 Black' },
  'zcool-qingke-huangyou': { family: 'ZCOOL QingKe HuangYou', weight: 400, label: '站酷庆科黄油体' },
  'zcool-kuaile': { family: 'ZCOOL KuaiLe', weight: 400, label: '站酷快乐体' },
  'ma-shan-zheng': { family: 'Ma Shan Zheng', weight: 400, label: '马善政毛笔楷书' },
};

const gradient = (...stops) => stops.map((color, i) => [stops.length === 1 ? 0 : i / (stops.length - 1), color]);

const STYLES = [
  {
    id: 'gold',
    name: '鎏金霸总',
    genres: ['霸总', '总裁', '豪门', '千金', '商战', '富豪', '继承'],
    font: 'zcool-qingke-huangyou',
    fill: gradient('#fffbe0', '#ffe27a', '#f0a81c', '#a45f00'),
    strokes: [
      { width: 0.2, color: '#2a1400' },
      { width: 0.1, color: '#7a4300' },
    ],
    extrude: { depth: 0.07, color: '#331b00' },
    shadow: { color: 'rgba(0,0,0,0.65)', blur: 0.16, dy: 0.08 },
    sheen: 0.45,
    letterSpacing: 0.02,
    rotate: -2,
    tagline: { bg: '#2a1400', color: '#ffe27a', border: '#f0a81c' },
  },
  {
    id: 'fire',
    name: '烈焰逆袭',
    genres: ['重生', '逆袭', '战神', '崛起', '赘婿', '神医', '打脸', '反杀', '龙王'],
    font: 'zcool-qingke-huangyou',
    fill: gradient('#fffde0', '#ffdb2e', '#ff7a00', '#e01d0a'),
    strokes: [
      { width: 0.26, color: '#2e0000' },
      { width: 0.13, color: '#ffffff' },
    ],
    extrude: { depth: 0.06, color: '#3a0000' },
    glow: { color: '#ff5a00', blur: 0.34 },
    shadow: { color: 'rgba(0,0,0,0.6)', blur: 0.12, dy: 0.07 },
    sheen: 0.4,
    letterSpacing: 0,
    rotate: -4,
    tagline: { bg: '#d4160a', color: '#ffffff', border: '#ffdb2e' },
  },
  {
    id: 'ink',
    name: '古风朱墨',
    genres: ['古风', '宫斗', '王妃', '皇后', '穿越', '宅斗', '仙侠', '侠', '江湖', '朝堂', '嫡女'],
    font: 'ma-shan-zheng',
    fill: gradient('#fffaf0', '#f6e2b6'),
    strokes: [
      { width: 0.18, color: '#220b0b' },
      { width: 0.07, color: '#8c1c13' },
    ],
    shadow: { color: 'rgba(0,0,0,0.7)', blur: 0.12, dy: 0.06 },
    sheen: 0.18,
    letterSpacing: 0.04,
    rotate: 0,
    tagline: { bg: '#a3201a', color: '#fff4dc', border: '#fff4dc' },
  },
  {
    id: 'frost',
    name: '冷光悬疑',
    genres: ['悬疑', '惊悚', '推理', '灵异', '末世', '谍战', '恐怖', '烧脑'],
    font: 'noto-serif-sc',
    fill: gradient('#ffffff', '#d6ecff', '#7db8ff'),
    strokes: [{ width: 0.14, color: '#03101c' }],
    glow: { color: '#3fa0ff', blur: 0.4 },
    shadow: { color: 'rgba(0,10,30,0.7)', blur: 0.1, dy: 0.05 },
    sheen: 0.3,
    letterSpacing: 0.08,
    rotate: 0,
    tagline: { bg: '#05182b', color: '#cfe8ff', border: '#3fa0ff' },
  },
  {
    id: 'candy',
    name: '糖果甜宠',
    genres: ['甜宠', '恋爱', '青春', '校园', '暗恋', '先婚后爱', '萌宝', '治愈', '甜'],
    font: 'zcool-kuaile',
    fill: gradient('#fff2f8', '#ffb3d6', '#ff6aa8'),
    strokes: [
      { width: 0.3, color: '#ffffff' },
      { width: 0.15, color: '#d93a86' },
    ],
    shadow: { color: 'rgba(160,20,90,0.5)', blur: 0.18, dy: 0.08 },
    sheen: 0.35,
    letterSpacing: 0.02,
    rotate: -3,
    tagline: { bg: '#ff5fa2', color: '#ffffff', border: '#ffffff' },
  },
  {
    id: 'blood',
    name: '血色复仇',
    genres: ['复仇', '虐恋', '追妻', '火葬场', '离婚', '黑化', '真相', '背叛', '虐'],
    font: 'ma-shan-zheng',
    fill: gradient('#ff7a66', '#e01414', '#940000'),
    strokes: [
      { width: 0.2, color: '#000000' },
      { width: 0.08, color: '#ffd9d0' },
    ],
    glow: { color: '#ff1a1a', blur: 0.3 },
    shadow: { color: 'rgba(0,0,0,0.8)', blur: 0.14, dy: 0.07 },
    sheen: 0.2,
    letterSpacing: 0.01,
    rotate: -3,
    tagline: { bg: '#120000', color: '#ff8a7a', border: '#d10f0f' },
  },
  {
    id: 'royal',
    name: '紫金玄幻',
    genres: ['玄幻', '修仙', '仙尊', '神', '异能', '系统', '大帝', '魔'],
    font: 'noto-serif-sc',
    fill: gradient('#fff4c2', '#f2be4a', '#a566ff'),
    strokes: [
      { width: 0.18, color: '#14062e' },
      { width: 0.07, color: '#f2be4a' },
    ],
    extrude: { depth: 0.05, color: '#14062e' },
    glow: { color: '#a566ff', blur: 0.36 },
    shadow: { color: 'rgba(10,0,30,0.7)', blur: 0.12, dy: 0.06 },
    sheen: 0.35,
    letterSpacing: 0.05,
    rotate: 0,
    tagline: { bg: '#1c0a40', color: '#f6d77a', border: '#a566ff' },
  },
  {
    id: 'urban',
    name: '都市硬朗',
    genres: ['都市', '职场', '家庭', '现实', '情感', '婚姻', '日常'],
    font: 'noto-sans-sc',
    fill: gradient('#ffffff', '#e2e6ee'),
    strokes: [{ width: 0.14, color: '#06070a' }],
    shadow: { color: 'rgba(0,0,0,0.7)', blur: 0.12, dy: 0.06 },
    accentBar: '#ff3b5c',
    sheen: 0.22,
    letterSpacing: 0.03,
    rotate: 0,
    tagline: { bg: '#ff3b5c', color: '#ffffff', border: null },
  },
];

const STYLE_IDS = STYLES.map((style) => style.id);
const DEFAULT_STYLE = 'urban';

function getStyle(id) {
  return STYLES.find((style) => style.id === id) || STYLES.find((style) => style.id === DEFAULT_STYLE);
}

/** 文本模型没给出可用样式时，按题材关键词选一个（先匹配先得，顺序即优先级）。 */
function pickStyleByGenre(...texts) {
  const haystack = texts.filter(Boolean).join(' ');
  let best = null;
  for (const style of STYLES) {
    let hits = 0;
    for (const word of style.genres) if (haystack.includes(word)) hits += 1;
    if (hits > (best?.hits || 0)) best = { style, hits };
  }
  return (best?.style || getStyle(DEFAULT_STYLE)).id;
}

/** 渲染页需要的完整样式（带字体信息）。 */
function resolveStyle(id) {
  const style = getStyle(id);
  const font = FONTS[style.font];
  return { ...style, fontFamily: font.family, fontWeight: font.weight };
}

function describeStyles() {
  return STYLES.map((style) => `${style.id}（${style.name}，适合：${style.genres.slice(0, 5).join('、')}）`).join('\n');
}

module.exports = { FONTS, STYLES, STYLE_IDS, DEFAULT_STYLE, getStyle, resolveStyle, pickStyleByGenre, describeStyles };
