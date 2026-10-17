'use strict';
const path = require('node:path');
const fs = require('node:fs').promises;
const { atomicJson } = require('./io');
const { envelope, requireThat, validateIntervals } = require('./contracts');
// Speech indexes visual shots but never changes their cuts or splits a sentence.
const ALGORITHM = 'visual-shots-with-dialogue-index-v2';
const POLICY = 'preserve_visual_cuts_dialogue_index';
const SUBTITLE_POLICY = 'voice-segments-v1';
const overlaps = (range, shot) => range.start < shot.end && range.end > shot.start;
const sameList = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && actual.every((value, i) => value === expected[i]);
function dialogueIndex(range, shots) {
  const owners = shots.filter(shot => overlaps(range, shot));
  return {
    shot_ids: owners.map(shot => shot.shot_id),
    // These intersections are lookup metadata, never new subtitle/audio clips.
    segments: owners.map(shot => ({ shot_id: shot.shot_id, start: Math.max(range.start, shot.start), end: Math.min(range.end, shot.end) })),
  };
}
function validateDialogueIndex(aligned, transcript) {
  validateIntervals(aligned.shots, transcript.duration, 'shot_id');
  validateIntervals(transcript.utterances, transcript.duration, 'utterance_id');
  const voices = transcript.voice_timeline?.segments || [];
  validateIntervals(voices, transcript.duration, 'segment_id');
  requireThat(Array.isArray(aligned.associations) && aligned.associations.length === transcript.utterances.length, '台词关联存在遗漏或重复');
  const byId = new Map();
  for (const row of aligned.associations) {
    requireThat(row && !byId.has(row.utterance_id), '台词关联存在重复');
    byId.set(row.utterance_id, row);
  }
  for (const utterance of transcript.utterances) {
    const row = byId.get(utterance.utterance_id), expected = dialogueIndex(utterance, aligned.shots);
    requireThat(row && expected.shot_ids.length > 0 && row.start === utterance.start && row.end === utterance.end, '台词关联缺失或未保留完整时间');
    requireThat(sameList(row.shot_ids, expected.shot_ids), '台词分镜关联存在遗漏、重复或伪造');
    requireThat(row.shot_id == null ? expected.shot_ids.length > 1 : expected.shot_ids.length === 1 && row.shot_id === expected.shot_ids[0], '台词单镜头索引与完整关联不一致');
    requireThat(Array.isArray(row.segments) && row.segments.length === expected.segments.length && row.segments.every((part, i) => part && ['shot_id', 'start', 'end'].every(key => part[key] === expected.segments[i][key])), '台词交叠索引与真实时间不一致');
    requireThat(expected.segments[0].start === utterance.start && expected.segments.at(-1).end === utterance.end && expected.segments.every((part, i) => !i || part.start === expected.segments[i - 1].end), '台词关联没有覆盖完整时间');
  }
  for (const shot of aligned.shots) {
    requireThat(sameList(shot.utterance_ids, transcript.utterances.filter(u => overlaps(u, shot)).map(u => u.utterance_id)), '分镜台词索引存在遗漏、重复或伪造');
    requireThat(sameList(shot.voice_segment_ids, voices.filter(v => overlaps(v, shot)).map(v => v.segment_id)), '分镜人声索引存在遗漏、重复或伪造');
  }
}
function align(shots, transcript, taskId) {
  requireThat(Array.isArray(shots) && shots.length > 0, '缺少视觉分镜，无法关联台词');
  validateIntervals(shots, transcript.duration, 'shot_id');
  validateIntervals(transcript.utterances, transcript.duration, 'utterance_id');
  shots.forEach((shot, i) => {
    requireThat(Number.isSafeInteger(shot.start_frame) && Number.isSafeInteger(shot.end_frame_exclusive) && shot.end_frame_exclusive > shot.start_frame, '视觉分镜缺少有效帧边界');
    requireThat(i ? shot.start_frame === shots[i - 1].end_frame_exclusive && Math.abs(shot.start - shots[i - 1].end) < 1e-9 : shot.start_frame === 0, '视觉分镜有缺帧、重叠或时间缺口');
  });
  requireThat(Math.abs(shots.at(-1).end - transcript.duration) < 1e-6, '视觉分镜与台词总时间轴不一致');
  const voices = transcript.voice_timeline?.segments || [];
  validateIntervals(voices, transcript.duration, 'segment_id');
  const ranges = [
    ...transcript.utterances.map(u => ({ ...u, kind: 'utterance', id: u.utterance_id })),
    ...voices.map(v => ({ ...v, kind: 'voice', id: v.segment_id })),
  ].sort((a, b) => a.start - b.start);
  requireThat(ranges.every(r => r.start >= shots[0].start && r.end <= shots.at(-1).end), '台词或人声超出视频画面覆盖范围，不能通过裁字或截断人声对齐');
  const decisions = shots.slice(1).map(shot => ({
    time: shot.start, frame: shot.start_frame, status: 'kept',
    reason: 'visual_boundary_authoritative',
    utterance_ids: transcript.utterances.filter(u => u.start < shot.start && u.end > shot.start).map(u => u.utterance_id),
    voice_segment_ids: voices.filter(v => v.start < shot.start && v.end > shot.start).map(v => v.segment_id),
  }));
  const finalShots = shots.map((source, index) => ({
    shot_id: `${taskId}:final-shot:${source.start_frame}-${source.end_frame_exclusive}`, order: index + 1,
    start_frame: source.start_frame, end_frame_exclusive: source.end_frame_exclusive,
    start: source.start, end: source.end, source_shot_ids: [source.shot_id],
    internal_boundaries: [], adjustment: 'visual_boundary_preserved',
    utterance_ids: [], voice_segment_ids: [],
  }));
  const matches = [];
  for (const range of ranges) {
    const owners = finalShots.filter(shot => overlaps(range, shot));
    requireThat(owners.length > 0, `台词或人声未落在视觉分镜内：${range.id}`);
    if (range.kind === 'utterance') {
      const index = dialogueIndex(range, finalShots);
      owners.forEach(owner => owner.utterance_ids.push(range.id));
      matches.push({
        utterance_id: range.id, start: range.start, end: range.end,
        ...(index.shot_ids.length === 1 ? { shot_id: index.shot_ids[0] } : {}), ...index,
      });
    } else owners.forEach(owner => owner.voice_segment_ids.push(range.id));
  }
  const result = envelope(taskId, { algorithm_id: ALGORITHM, boundary_policy: POLICY, timing_method: transcript.timing_method || 'vad_segment', duration: transcript.duration, frame_count: shots.at(-1).end_frame_exclusive, raw_shot_count: shots.length, merged_boundary_count: 0, boundary_decisions: decisions, shots: finalShots, associations: matches, unmatched_utterance_ids: [] });
  validateDialogueIndex(result, transcript);
  return result;
}
async function alignment(ctx, shots, transcript) {
  ctx.onProgress?.({ progress: 0, message: '保留视觉切点，建立完整台词与分镜的关联' });
  const result = align(shots.shots, transcript, ctx.taskId);
  result.source_algorithm_id = shots.algorithm_id;
  result.review_items = shots.review_items || [];
  result.warnings = [...(shots.warnings || []), ...(transcript.warnings || [])];
  result.needs_review = shots.needs_review === true || result.review_items.length > 0 || result.warnings.length > 0;
  await atomicJson(path.join(ctx.dir, 'aligned.json'), result);
  ctx.onProgress?.({ progress: 100, message: `保留 ${result.shots.length} 个视觉分镜，已关联 ${result.associations.length} 条完整台词；跨镜头台词连续保留` });
  return result;
}
function srtTime(t) {
  const ms = Math.round(t * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function srt(utterances) {
  return utterances.map((u, i) => { requireThat(Math.round(u.end * 1000) > Math.round(u.start * 1000), '字幕段短于 SRT 时间精度'); return `${i + 1}\n${srtTime(u.start)} --> ${srtTime(u.end)}\n${u.text.replace(/[\r\n]+/g, ' ')}\n`; }).join('\n');
}
function spokenCharacters(text) {
  return Array.from(text).filter(char => !/[\p{P}\s]/u.test(char));
}
function sliceSpokenText(text, start, end) {
  const chars = Array.from(text);
  const total = spokenCharacters(text).length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > total) throw new Error('字幕声学文字边界无效');
  let spoken = 0, begin = start === 0 ? 0 : null, finish = end === total ? chars.length : null;
  for (let index = 0; index < chars.length; index += 1) {
    if (!/[\p{P}\s]/u.test(chars[index])) {
      if (spoken === start && begin === null) begin = index;
      if (spoken === end && finish === null) { finish = index; break; }
      spoken += 1;
    }
  }
  if (begin === null || finish === null) throw new Error('字幕声学文字边界无法映射到文字');
  const part = chars.slice(begin, finish).join('');
  if (!spokenCharacters(part).length) throw new Error('字幕声学文字分片为空');
  return part;
}
function voiceSubtitleCues(transcript, shots, raw, recognition) {
  const utterances = transcript.utterances;
  const voices = transcript.voice_timeline?.segments;
  requireThat(Array.isArray(voices), '缺少已校验的人声片段，无法对齐字幕');
  const byUtterance = new Map(utterances.map(u => [u.utterance_id, []]));
  const ids = new Set();
  let previousEnd = 0;
  for (const voice of voices) {
    requireThat(byUtterance.has(voice.utterance_id) && voice.segment_id && !ids.has(voice.segment_id), '人声片段缺少台词关联或存在重复');
    requireThat(Number.isFinite(voice.start) && Number.isFinite(voice.end) && voice.start >= previousEnd && voice.end > voice.start && voice.end <= transcript.duration, '人声片段区间无效');
    ids.add(voice.segment_id);
    previousEnd = voice.end;
    byUtterance.get(voice.utterance_id).push(voice);
  }
  const needsSources = [...byUtterance.values()].some(rows => rows.length > 1);
  let sourceCharacters = [];
  const sourceOffsets = new Map();
  if (needsSources) {
    requireThat(Array.isArray(raw?.segments), '缺少原始识别文字，无法将字幕配对到已有多个音频片段');
    sourceCharacters = raw.segments.flatMap(segment => {
      requireThat(Number.isSafeInteger(segment.start_sample) && Number.isSafeInteger(segment.end_sample_exclusive) && typeof segment.text === 'string', '原始识别文字来源无效');
      const sourceId = `vad:${segment.start_sample}-${segment.end_sample_exclusive}`;
      return spokenCharacters(segment.text).map(char => ({ char, sourceId }));
    });
    // Keep the complete recognition order for source attribution, even when
    // mapTranscript omitted whole utterances outside the video timeline.
    const recognized = recognition?.segments || utterances;
    requireThat(sourceCharacters.map(item => item.char).join('') === recognized.flatMap(u => spokenCharacters(u.text)).join(''), '原始识别与台词文字不一致，不能猜测字幕片段归属');
    if (recognition) {
      let cursor = 0;
      for (const segment of recognized) {
        const key = `${segment.start_sample}-${segment.end_sample_exclusive}`;
        requireThat(Number.isSafeInteger(segment.start_sample) && Number.isSafeInteger(segment.end_sample_exclusive) && !sourceOffsets.has(key), '识别段来源区间无效或重复');
        sourceOffsets.set(key, { cursor, text: spokenCharacters(segment.text).join('') });
        cursor += spokenCharacters(segment.text).length;
      }
    }
  }
  const cues = [];
  let sourceCursor = 0;
  for (const utterance of utterances) {
    const rows = byUtterance.get(utterance.utterance_id);
    const spans = utterance.speech_spans || [{ start: utterance.start, end: utterance.end }];
    requireThat(rows.length === spans.length && rows.length > 0 && rows.every((voice, i) => voice.start === spans[i].start && voice.end === spans[i].end), '已有音频片段与台词有声区间不一致');
    const text = utterance.text.replace(/[\r\n]+/g, ' ');
    const characters = Array.from(text);
    const spoken = characters.flatMap((char, index) => /[\p{P}\s]/u.test(char) ? [] : [{ char, index }]);
    if (needsSources && recognition) {
      const rate = raw.sample_rate || 16000;
      const source = sourceOffsets.get(`${Math.round(utterance.audio_start * rate)}-${Math.round(utterance.audio_end * rate)}`);
      requireThat(source && source.text === spoken.map(item => item.char).join(''), '台词与完整识别来源不一致，不能猜测字幕文字');
      sourceCursor = source.cursor;
    }
    let parts = [text];
    const explicitOffsets = rows.length > 1 && rows.every(row => Number.isInteger(row.source_text_start) && Number.isInteger(row.source_text_end));
    if (explicitOffsets) {
      const totalSpoken = spoken.length;
      requireThat(rows[0].source_text_start === 0 && rows.at(-1).source_text_end === totalSpoken && rows.every((row, index) => !index || row.source_text_start === rows[index - 1].source_text_end), '声学停顿分句文字边界不连续');
      parts = rows.map(row => sliceSpokenText(text, row.source_text_start, row.source_text_end));
    } else if (rows.length > 1) {
      const owners = spoken.map((item, index) => {
        const source = sourceCharacters[sourceCursor + index];
        const matches = rows.flatMap((voice, owner) => (voice.source_segment_ids || spans[owner].source_segment_ids || []).includes(source.sourceId) ? [owner] : []);
        requireThat(matches.length === 1, '字幕文字对应的人声来源不唯一，不能按字数或时长摊分');
        return matches[0];
      });
      requireThat(owners[0] === 0 && owners.at(-1) === rows.length - 1 && owners.every((owner, i) => !i || owner === owners[i - 1] || owner === owners[i - 1] + 1), '字幕文字与人声片段顺序不一致');
      const boundaries = rows.map((_, owner) => owner ? spoken[owners.indexOf(owner)].index : 0);
      boundaries.push(characters.length);
      parts = rows.map((_, i) => characters.slice(boundaries[i], boundaries[i + 1]).join(''));
    }
    requireThat(parts.join('') === text && parts.every(part => spokenCharacters(part).length), '字幕分段丢字、重复或为空');
    sourceCursor += spoken.length;
    rows.forEach((voice, index) => {
      const shotIds = dialogueIndex(voice, shots).shot_ids;
      requireThat(shotIds.length > 0, '字幕对应人声未落在视频时间线内');
      cues.push({ cue_id: voice.segment_id, voice_segment_id: voice.segment_id, utterance_id: utterance.utterance_id, ...(shotIds.length === 1 ? { shot_id: shotIds[0] } : {}), shot_ids: shotIds, text: parts[index], start: voice.start, end: voice.end });
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}
async function exportsModule(ctx, aligned, clips, transcript, clipsDir, transcriptDir) {
  requireThat(aligned.algorithm_id === ALGORITHM && aligned.boundary_policy === POLICY, '请先完成台词与视觉分镜关联，再导出字幕');
  validateDialogueIndex(aligned, transcript);
  requireThat(clips.boundary_policy === POLICY && clips.alignment_algorithm_id === ALGORITHM && clips.clips.length === aligned.shots.length, '切片尚未使用保留视觉切点的分镜，请重新导出分镜');
  const mediaFiles = [];
  for (const [index, clip] of clips.clips.entries()) {
    const shot = aligned.shots[index];
    requireThat(['shot_id', 'order', 'start', 'end', 'start_frame', 'end_frame_exclusive'].every(key => clip[key] === shot[key]) && sameList(clip.source_shot_ids, shot.source_shot_ids), '切片与视觉分镜边界或来源不一致');
    const absolute = path.join(clipsDir, clip.path);
    requireThat((await fs.stat(absolute)).isFile(), `切片文件不存在：${absolute}`);
    const file = path.relative(ctx.dir, absolute).split(path.sep).join('/');
    mediaFiles.push({ shot_id: clip.shot_id, path: file, start: clip.start, end: clip.end, utterance_ids: shot.utterance_ids, source_shot_ids: shot.source_shot_ids });
  }
  const needsSources = transcript.utterances.some(u => (u.speech_spans || []).length > 1);
  let raw, recognition;
  if (needsSources) {
    requireThat(transcriptDir, '缺少原始识别目录，无法配对多片段字幕');
    raw = JSON.parse(await fs.readFile(path.join(transcriptDir, 'recognition.raw.json'), 'utf8'));
    recognition = JSON.parse(await fs.readFile(path.join(transcriptDir, 'recognition.json'), 'utf8'));
  }
  const cues = voiceSubtitleCues(transcript, aligned.shots, raw, recognition);
  // The draft uses exact voice times; only the standalone SRT is millisecond-quantized.
  const srtCues = cues.map(cue => ({ ...cue, start: Math.max(0, Math.round(cue.start * 1000)) / 1000, end: Math.min(Math.round(cue.end * 1000), Math.floor(transcript.duration * 1000 + 1e-9)) / 1000 }));
  await fs.writeFile(path.join(ctx.dir, 'subtitles.srt'), srt(srtCues), 'utf8');
  const result = envelope(ctx.taskId, { boundary_policy: POLICY, subtitle_policy: SUBTITLE_POLICY, srt: 'subtitles.srt', subtitle_cues: cues, media_files: mediaFiles, utterance_count: transcript.utterances.length, shot_count: clips.clips.length, path_base: 'this_file_directory' });
  await atomicJson(path.join(ctx.dir, 'files.json'), result);
  return result;
}
module.exports = { align, alignment, srt, exportsModule, voiceSubtitleCues, ALGORITHM, POLICY, SUBTITLE_POLICY };
