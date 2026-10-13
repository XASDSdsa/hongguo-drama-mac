'use strict';

/**
 * Small SRT reader/writer used by the local transcription pipeline.
 *
 * SRT is kept as the source of truth for subtitles.  We deliberately do not
 * create a second transcript JSON/TXT copy: the analysis stage can read this
 * file when it needs the words and their time line.
 */

function parseTimestamp(value) {
  const raw = String(value || '').trim().replace('.', ',');
  const match = /^(\d{1,3}):(\d{2}):(\d{2}),(\d{1,3})$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, '0'));
  if (minutes > 59 || seconds > 59 || millis > 999) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function formatTimestamp(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const secs = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function parseSrt(content) {
  const source = String(content || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const blocks = source.split(/\n\s*\n/);
  const entries = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let timingIndex = lines.findIndex(line => /-->/.test(line));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$/);
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    const text = lines.slice(timingIndex + 1).join('\n').trim();
    if (start == null || end == null || end <= start || !text) continue;
    entries.push({ start, end, text });
  }
  return entries;
}

function normalizeEntries(entries, options = {}) {
  const duration = Number(options.duration);
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const sorted = (Array.isArray(entries) ? entries : [])
    .map(item => ({
      start: Math.max(0, Number(item?.start)),
      end: Math.max(0, Number(item?.end)),
      text: String(item?.text || '').replace(/\r/g, '').trim(),
    }))
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  for (const item of sorted) {
    const start = hasDuration ? Math.min(item.start, duration) : item.start;
    const end = hasDuration ? Math.min(item.end, duration) : item.end;
    if (end <= start) continue;
    result.push({ start, end, text: item.text });
  }
  return result;
}

function formatSrt(entries, options = {}) {
  const normalized = normalizeEntries(entries, options);
  return normalized.map((item, index) => `${index + 1}\n${formatTimestamp(item.start)} --> ${formatTimestamp(item.end)}\n${item.text}`).join('\n\n') + (normalized.length ? '\n\n' : '');
}

function normalizeSrt(content, options = {}) {
  const entries = normalizeEntries(parseSrt(content), options);
  if (!entries.length) throw new Error('SRT 没有可用的字幕时间轴');
  return formatSrt(entries, options);
}

// Unlike the display parser, completed output must not silently discard a bad
// block, reorder dialogue, or conceal an invalid timeline.
function validateSrt(content, options = {}) {
  const source = String(content || '').replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  if (!source) throw new Error('SRT 为空');
  const duration = Number(options.duration);
  const endMillis = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : Infinity;
  let previousEnd = 0;
  const entries = source.split(/\n\s*\n/).map((block, index) => {
    const lines = block.split('\n');
    const timing = /^\s*(\S+)\s*-->\s*(\S+)\s*$/.exec(lines[1] || '');
    const start = timing && parseTimestamp(timing[1]);
    const end = timing && parseTimestamp(timing[2]);
    const text = lines.slice(2).join('\n').trim();
    const invalid = message => { throw new Error(`SRT 第 ${index + 1} 条${message}`); };
    if (Number(lines[0]) !== index + 1 || !/^\d+$/.test(lines[0])) invalid('编号不连续');
    if (start == null || end == null) invalid('时间格式错误');
    const startMs = Math.round(start * 1000), endMs = Math.round(end * 1000);
    if (endMs <= startMs) invalid('结束时间必须晚于开始时间');
    if (startMs < previousEnd) invalid('与上一条重叠或时间倒退');
    if (endMs > endMillis) invalid('超出去重视频时长');
    if (!text) invalid('内容为空');
    previousEnd = endMs;
    return { start, end, text };
  });
  return { entries, content: formatSrt(entries), duration: Number.isFinite(endMillis) ? duration : null };
}

function correctSrtBounds(content, { duration, audioOffset = 0, audioEnd = duration }) {
  const checked = validateSrt(content, { duration });
  const first = Math.max(0, Math.ceil(audioOffset * 1000)) / 1000;
  const last = Math.min(Math.round(duration * 1000), Math.floor(audioEnd * 1000)) / 1000;
  let correctedCues = 0;
  const entries = checked.entries.map((entry, index) => {
    const start = Math.max(entry.start, first), end = Math.min(entry.end, last);
    if (end <= start) throw new Error(`SRT 第 ${index + 1} 条完全位于音轨之外，无法可靠校正`);
    if (start !== entry.start || end !== entry.end) correctedCues++;
    return { ...entry, start, end };
  });
  return { entries, content: formatSrt(entries), correctedCues };
}

function srtToText(content) {
  return parseSrt(content).map(item => item.text).join('\n').trim();
}

module.exports = {
  parseTimestamp,
  formatTimestamp,
  parseSrt,
  normalizeEntries,
  formatSrt,
  normalizeSrt,
  validateSrt,
  correctSrtBounds,
  srtToText,
};
