'use strict';
const path = require('node:path');
const fs = require('node:fs').promises;
const { run, json, atomicJson } = require('./io');
const { envelope, requireThat, validateIntervals } = require('./contracts');
const ALGORITHM = 'transnetv2-temporal-min2s-v1';
function reviewItems(verification, transitions) {
  const items = [];
  const seen = new Set();
  const add = (item, fallbackId) => {
    const frame = Number.isInteger(item?.frame) ? item.frame : null;
    const id = String(item?.review_id || (frame == null ? fallbackId : `shot-boundary:${frame}`));
    if (seen.has(id)) return;
    seen.add(id);
    items.push({
      review_id: id,
      type: 'shot_boundary',
      status: 'needs_review',
      severity: 'warn',
      ...(frame == null ? {} : { frame, time: Number.isFinite(item.time) ? item.time : undefined }),
      reason: String(item?.reason || '分镜边界需要人工复核'),
      source: item?.source || 'shot_verification',
    });
  };
  for (const warning of Array.isArray(verification?.warnings) ? verification.warnings : []) add(warning, `shot-verification:${items.length}`);
  // A candidate can be marked warn and then merged by the minimum-duration
  // policy, so it will not appear in the final transition list. Keep that
  // evidence visible for manual review instead of reporting a clean result.
  for (const decision of Array.isArray(verification?.decisions) ? verification.decisions : []) {
    if (decision?.status === 'warn') add({ ...decision, source: 'shot_verification' }, `shot-verification:${items.length}`);
  }
  for (const transition of transitions.filter(item => item.verification?.status === 'warn')) {
    add({ ...transition.verification, frame: transition.boundary_frame, time: transition.time }, `shot-boundary:${transition.boundary_frame}`);
  }
  return items;
}
function buildShots(media, predictions, taskId, verification) {
  const { single, all } = predictions;
  requireThat(single?.length === media.frame_count && all?.length === media.frame_count, '检测帧数与视频时间轴不一致');
  requireThat([...single, ...all].every(v => Number.isFinite(v) && v >= 0 && v <= 1), 'TransNet V2 分数无效');
  requireThat(verification?.algorithm_id === ALGORITHM && verification.frame_count === media.frame_count && verification.minimum_duration === 2, '缺少已确认的分镜复核结果');
  const { cuts: boundaries, threshold, decisions } = verification;
  requireThat(Number.isFinite(threshold) && threshold === 0.5 && Array.isArray(boundaries) && Array.isArray(decisions), '分镜复核数据无效');
  requireThat(boundaries.every((f, i) => Number.isInteger(f) && f > 0 && f < media.frame_count && (!i || f > boundaries[i - 1]) && decisions.some(d => d.frame === f && ['kept', 'warn'].includes(d.status))), '复核边界无效或未经验证');
  const transitions = boundaries.map(f => ({ boundary_frame: f, time: media.frames[f].start, score: single[f], kind: 'verified_cut', verification: decisions.find(d => d.frame === f) }));
  const cuts = [0, ...boundaries, media.frame_count];
  const shots = cuts.slice(0, -1).map((start, i) => {
    const end = cuts[i + 1];
    return { shot_id: `${taskId}:shot:${start}-${end}`, order: i + 1, start_frame: start, end_frame_exclusive: end, start: media.frames[start].start, end: end === media.frame_count ? media.video_end : media.frames[end].start };
  });
  validateIntervals(shots, media.duration, 'shot_id');
  requireThat(shots.every(s => s.end - s.start >= 2 - 1e-9) || (shots.length === 1 && media.video_end - media.frames[0].start < 2), '输出分镜未满足最短2秒约束');
  requireThat(shots.reduce((n, s) => n + s.end_frame_exclusive - s.start_frame, 0) === media.frame_count, '镜头未完整覆盖视频帧');
  const warnings = [...(verification.warnings || []), ...transitions.filter(t => t.verification.status === 'warn').map(t => ({ frame: t.boundary_frame, time: t.time, reason: t.verification.reason }))];
  const items = reviewItems(verification, transitions);
  return envelope(taskId, { detector: 'TransNet V2', model: predictions.model, threshold, algorithm_id: ALGORITHM, minimum_duration: 2, frame_count: media.frame_count, warnings, needs_review: items.length > 0, review_items: items, verification, transitions, shots });
}
async function shots(ctx, media) {
  const predictionPath = path.join(ctx.dir, 'predictions.json');
  const framesPath = path.join(ctx.dir, 'frames.rgb');
  const reviewPath = path.join(ctx.dir, 'review.rgb');
  const timelinePath = path.join(ctx.dir, 'verification-timeline.json');
  const verificationPath = path.join(ctx.dir, 'verification.json');
  const phaseProgress = (start, span) => event => ctx.onProgress?.({ ...event, progress: start + Math.max(0, Math.min(100, event.progress || 0)) * span / 100 });
  ctx.onProgress?.({ progress: 0, message: '逐帧解码以检测分镜' });
  try {
    await run(ctx.ffmpeg, ['-nostdin', '-y', '-v', 'error', '-i', ctx.input, '-map', `0:${media.video.index}`, '-an', '-vf', 'scale=48:27', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', framesPath], ctx);
    await run(ctx.runtime.command, [...ctx.runtime.prefix, 'shots', '--input', framesPath, '--output', predictionPath, '--model', ctx.params.model, '--device', ctx.params.device, '--threads', String(ctx.params.threads)], { ...ctx, onProgress: phaseProgress(5, 80) });
    ctx.onProgress?.({ progress: 85, message: '复核镜头边界，合并特效误切和短片段' });
    await atomicJson(timelinePath, { frame_count: media.frame_count, video_end: media.video_end, frames: media.frames.map(f => ({ start: f.start })) });
    await run(ctx.ffmpeg, ['-nostdin', '-y', '-v', 'error', '-i', ctx.input, '-map', `0:${media.video.index}`, '-an', '-vf', 'scale=160:90', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', reviewPath], ctx);
    await run(ctx.runtime.command, [...ctx.runtime.prefix, 'verify-shots', '--input', reviewPath, '--timeline', timelinePath, '--predictions', predictionPath, '--threshold', String(ctx.params.threshold), '--output', verificationPath], { ...ctx, onProgress: phaseProgress(90, 10) });
  } finally { await Promise.all([framesPath, reviewPath, timelinePath].map(file => fs.rm(file, { force: true }))); }
  const verification = await json(verificationPath);
  requireThat(verification.threshold === ctx.params.threshold, '复核阈值与任务参数不一致');
  const result = buildShots(media, await json(predictionPath), ctx.taskId, verification);
  await atomicJson(path.join(ctx.dir, 'shots.json'), result);
  return result;
}
module.exports = { buildShots, shots, ALGORITHM, reviewItems };
