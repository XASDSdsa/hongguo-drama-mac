'use strict';

const crypto = require('node:crypto');
const VERSION = '1.0.0';
const MODULES = [
  { id: 'media', label: '视频信息', deps: [], file: 'media.json' },
  { id: 'audio', label: '整集音频提取', deps: ['media'], file: 'audio.json' },
  { id: 'shots', label: '检测视觉分镜', deps: ['media'], file: 'shots.json' },
  { id: 'separation', label: '人声 / 背景分离', deps: ['audio'], file: 'separation.json' },
  { id: 'transcript', label: 'Paraformer 台词识别', deps: ['media', 'separation'], file: 'transcript.json' },
  { id: 'alignment', label: '关联台词与分镜', deps: ['shots', 'transcript'], file: 'aligned.json' },
  { id: 'clips', label: '导出最终分镜', deps: ['media', 'alignment'], file: 'clips.json' },
  { id: 'export', label: 'SRT 导出', deps: ['alignment', 'clips', 'transcript'], file: 'files.json' },
];
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
function fingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
function descendants(id) {
  const affected = new Set([id]);
  for (const module of MODULES) if (module.deps.some((dep) => affected.has(dep))) affected.add(module.id);
  return [...affected].filter((key) => key !== id);
}
function envelope(taskId, data) {
  return { schema_version: VERSION, task_id: taskId, time_unit: 'seconds', interval: '[start,end)', ...data };
}
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function validateIntervals(items, duration, key) {
  const ids = new Set();
  let previous = -Infinity;
  for (const item of items) {
    requireThat(typeof item[key] === 'string' && !ids.has(item[key]), `重复或缺失的 ID: ${item[key]}`);
    requireThat(
      Number.isFinite(item.start) &&
        Number.isFinite(item.end) &&
        item.start >= 0 &&
        item.end > item.start &&
        item.end <= duration + 0.000001,
      `无效时间区间: ${item[key]}`,
    );
    requireThat(item.start >= previous, `时间未按顺序排列: ${item[key]}`);
    previous = item.start;
    ids.add(item[key]);
  }
}
module.exports = { VERSION, MODULES, fingerprint, descendants, envelope, requireThat, validateIntervals };
