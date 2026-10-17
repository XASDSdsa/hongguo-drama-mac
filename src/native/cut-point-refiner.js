'use strict';

/**
 * 镜头切断只看两件事：整段画面里的切镜，以及语音里的气口。
 * 一小句话是一口气里连着说的那一段，不是句号、字幕条或话题。
 * 话没说完、还没换气是同一件事：切镜落在这口气中间，前后画面并成同一段。
 * 只有切镜正好落在气口上才切开。有气口但画面没切，不切。
 * 模型语义点、标点、旧的 0.25 秒静音都不参与这个判断。
 */

// 气口门槛：这口气停下来的真实空隙，至少 0.18 秒（含）。
// 塞音闭合和字与字的粘连通常更短，仍算同一口气。
// 这个秒数只回答「有没有换气」。它本身不能切断，也不是旧链路里
// 单独就能把切点吸走的 0.25 秒静音。
const BREATH_GAP_SECONDS = 0.18;

// 切镜落在气口上的容差，约一帧。切镜时刻在气口内，或距气口边缘不超过
// 0.04 秒，才算正好落在这刀上。再远就是错开，不切。这不是旧的 ±15 秒吸附窗。
const SHOT_ON_BREATH_SECONDS = 0.04;

// 贴着片头或片尾 0.04 秒的切镜会切出空段，丢掉。
const EDGE_GUARD_SECONDS = 0.04;

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function normalizeSpeech(speech) {
  const regions = (Array.isArray(speech) ? speech : [])
    .map(item => {
      const start = numeric(item?.start ?? item?.[0]);
      const end = numeric(item?.end ?? item?.[1]);
      if (start == null || end == null || end <= start) return null;
      return { start, end };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const region of regions) {
    const last = merged[merged.length - 1];
    if (!last || region.start > last.end) merged.push({ start: region.start, end: region.end });
    else last.end = Math.max(last.end, region.end);
  }
  return merged;
}

// 气口只取两段语音之间的空隙。片头还没开口、片尾已经说完的静音不是气口。
function breathGaps(speech, breathGapSeconds) {
  const gaps = [];
  for (let index = 1; index < speech.length; index += 1) {
    const start = speech[index - 1].end;
    const end = speech[index].start;
    if (end - start + 1e-6 >= breathGapSeconds) gaps.push({ start, end });
  }
  return gaps;
}

function shotLandsOnBreath(time, gap, tolerance) {
  return time + 1e-9 >= gap.start - tolerance && time - 1e-9 <= gap.end + tolerance;
}

/**
 * 从整段切镜里留下「正好落在气口上」的刀。
 * speech 是有声区间（秒），shots 是画面切镜时刻（秒）。文本、标点、语义点一概不读。
 * 空语音、没有切镜、贴着片头片尾的切镜，都返回空列表，避免切出空段。
 */
function decideShotCuts({ shots, speech, duration, breathGapSeconds, toleranceSeconds, edgeSeconds } = {}) {
  const breath = Number.isFinite(Number(breathGapSeconds)) ? Number(breathGapSeconds) : BREATH_GAP_SECONDS;
  const tolerance = Number.isFinite(Number(toleranceSeconds)) ? Math.max(0, Number(toleranceSeconds)) : SHOT_ON_BREATH_SECONDS;
  const edge = Number.isFinite(Number(edgeSeconds)) ? Math.max(0, Number(edgeSeconds)) : EDGE_GUARD_SECONDS;
  const spoken = normalizeSpeech(speech);
  if (!spoken.length) return [];
  const gaps = breathGaps(spoken, breath);
  if (!gaps.length) return [];
  const span = numeric(duration);
  const times = (Array.isArray(shots) ? shots : [])
    .map(shot => numeric(typeof shot === 'number' ? shot : shot?.time))
    .filter(time => time != null)
    .sort((a, b) => a - b);
  const cuts = [];
  for (const time of times) {
    if (time <= edge) continue;
    if (span != null && time >= span - edge) continue;
    if (cuts.length && time - cuts[cuts.length - 1].time <= 1e-3) continue;
    const gap = gaps.find(item => shotLandsOnBreath(time, item, tolerance));
    if (!gap) continue;
    cuts.push({
      time,
      status: 'ok',
      source: 'shot+breath',
      reason: '画面切镜落在气口上',
      breath_start: gap.start,
      breath_end: gap.end,
    });
  }
  return cuts;
}

module.exports = {
  BREATH_GAP_SECONDS,
  SHOT_ON_BREATH_SECONDS,
  EDGE_GUARD_SECONDS,
  decideShotCuts,
  normalizeSpeech,
  breathGaps,
};
