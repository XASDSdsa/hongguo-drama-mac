'use strict';
// 来源平台自带的剧简介。三个来源的字段名不一样，这里按常见字段名优先，其次按字段名特征兜底；
// 读不到就返回空字符串，绝不编造。

const MAX_LENGTH = 2000;
const MIN_LENGTH = 6;
const KNOWN_KEYS = [
  'introduction',
  'series_intro',
  'series_introduction',
  'series_desc',
  'series_description',
  'series_abstract',
  'series_brief',
  'intro',
  'synopsis',
  'abstract',
  'description',
  'desc',
  'brief',
  'summary',
  'plot',
  'storyline',
];
const KEY_HINT = /(intro|synops|abstract|desc|brief|plot|summary|story|剧情|简介)/i;
const KEY_EXCLUDE = /(title|name|url|img|image|cover|tag|categor|count|cnt|time|date|_id$|id$|type|label|seo|keyword)/i;

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 去掉 HTML 标签、转义和多余空白；太短（多半是标签或占位符）的视为没有简介。 */
function cleanSynopsis(value) {
  if (typeof value !== 'string') return '';
  const text = decodeEntities(value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length >= MIN_LENGTH ? text.slice(0, MAX_LENGTH) : '';
}

/** 从一个 JSON 对象里取简介：已知字段名优先，其次字段名含 intro/desc/abstract 等的最长文本。 */
function pickSynopsis(object) {
  if (!object || typeof object !== 'object') return '';
  for (const key of KNOWN_KEYS) {
    const text = cleanSynopsis(object[key]);
    if (text) return text;
  }
  let best = '';
  for (const [key, value] of Object.entries(object)) {
    if (!KEY_HINT.test(key) || KEY_EXCLUDE.test(key)) continue;
    const text = cleanSynopsis(value);
    if (text.length > best.length) best = text;
  }
  return best;
}

/**
 * 从网页里内嵌的 JSON 文本取简介（红果官网页面）。页面里可能同时带着推荐剧的数据，
 * 所以只看离当前剧名字段最近的一段，避免把别的剧的简介当成这部剧的。
 */
function pickSynopsisFromText(text, anchorKey = 'series_name', radius = 4000) {
  const source = String(text || '');
  const anchor = source.indexOf(`"${anchorKey}"`);
  if (anchor < 0) return '';
  const from = Math.max(0, anchor - radius);
  const windowText = source.slice(from, anchor + radius);
  const found = [];
  const pattern = /"([A-Za-z_][\w]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(windowText))) {
    const [, key, raw] = match;
    const known = KNOWN_KEYS.indexOf(key);
    if (known < 0 && (!KEY_HINT.test(key) || KEY_EXCLUDE.test(key))) continue;
    let value;
    try {
      value = JSON.parse(`"${raw}"`);
    } catch (_) {
      continue;
    }
    const text = cleanSynopsis(value);
    if (!text) continue;
    found.push({ text, known, distance: Math.abs(from + match.index - anchor) });
  }
  if (!found.length) return '';
  // 已知字段名优先；同类里取离剧名最近的。
  found.sort((a, b) => (a.known < 0) - (b.known < 0) || a.known - b.known || a.distance - b.distance);
  return found[0].text;
}

module.exports = { cleanSynopsis, pickSynopsis, pickSynopsisFromText, KNOWN_KEYS };
