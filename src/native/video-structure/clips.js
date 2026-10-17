'use strict';
const path = require('node:path');
const { run, probe, atomicJson } = require('./io');
const { requireThat, envelope } = require('./contracts');
const { ALGORITHM, POLICY } = require('./alignment');
async function clips(ctx, media, shotResult) {
  requireThat(shotResult.algorithm_id === ALGORITHM && shotResult.boundary_policy === POLICY, '请先关联台词与视觉分镜，再导出分镜视频');
  requireThat(Array.isArray(shotResult.shots) && shotResult.shots.length > 0 && shotResult.raw_shot_count === shotResult.shots.length && shotResult.merged_boundary_count === 0, '视觉分镜数量发生合并，请重新建立台词关联');
  const sourceIds = new Set();
  let previousFrame = 0;
  for (const shot of shotResult.shots) {
    requireThat(Number.isSafeInteger(shot.start_frame) && Number.isSafeInteger(shot.end_frame_exclusive) && shot.start_frame === previousFrame && shot.end_frame_exclusive > previousFrame && shot.end_frame_exclusive <= media.frames.length, '视觉分镜存在缺帧、重复或无效帧边界');
    requireThat(Array.isArray(shot.source_shot_ids) && shot.source_shot_ids.length === 1 && !sourceIds.has(shot.source_shot_ids[0]) && Array.isArray(shot.internal_boundaries) && shot.internal_boundaries.length === 0, '分镜必须保留单个视觉镜头，不能为台词合并镜头');
    requireThat(Math.abs(shot.start - media.frames[shot.start_frame].start) < 0.000001 && Math.abs(shot.end - (media.frames[shot.end_frame_exclusive]?.start ?? media.video_end)) < 0.000001, '视觉分镜边界与源视频帧时间不一致');
    sourceIds.add(shot.source_shot_ids[0]);
    previousFrame = shot.end_frame_exclusive;
  }
  requireThat(previousFrame === media.frames.length, '视觉分镜未覆盖完整视频帧');
  requireThat(['original', 'mute'].includes(ctx.params.audio_mode), '必须明确切片音轨模式：original 或 mute');
  const results = [];
  for (const shot of shotResult.shots) {
    ctx.signal?.throwIfAborted();
    const file = `shot-${String(shot.order).padStart(4, '0')}.mp4`;
    const sourceStart = media.origin_pts + shot.start;
    const sourceEnd = media.origin_pts + shot.end;
    const expected = shot.end_frame_exclusive - shot.start_frame;
    const lastDuration = Math.round(media.frames[shot.end_frame_exclusive - 1].duration * 1000000);
    // Subtract the decoded first-frame timestamp in its integer time base.
    // Decimal seconds / TB can round by a tick and shift every following frame.
    const filters = [`[0:${media.video.index}]trim=start_frame=${shot.start_frame}:end_frame=${shot.end_frame_exclusive},setpts=PTS-STARTPTS[v]`];
    const args = ['-nostdin', '-y', '-v', 'error', '-copyts', '-i', ctx.input];
    const audio = ctx.params.audio_mode === 'original' && media.has_audio;
    if (audio) filters.push(`[0:${media.audio.index}]atrim=start=${sourceStart}:end=${sourceEnd},asetpts=PTS-${sourceStart}/TB,aresample=async=1:first_pts=0,apad,atrim=duration=${shot.end - shot.start}[a]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[v]');
    if (audio) args.push('-map', '[a]', '-c:a', 'aac'); else args.push('-an');
    // No reordered packets: the final packet is the final displayed frame.
    // MP4 otherwise infers its duration from nominal FPS, truncating VFR tails.
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '0', '-pix_fmt', 'yuv420p', '-threads', String(ctx.params.threads), '-fps_mode', 'passthrough', '-enc_time_base', '1:1000000', '-video_track_timescale', '1000000', '-bsf:v', `setts=duration='if(eq(N,${expected - 1}),${lastDuration},DURATION)'`, '-movflags', '+faststart', '-progress', 'pipe:1', path.join(ctx.dir, file));
    await run(ctx.ffmpeg, args, { ...ctx, duration: shot.end - shot.start, onProgress: event => ctx.onProgress?.({ ...event, message: `视觉分镜 ${shot.order}/${shotResult.shots.length}（保留原切点）`, progress: (results.length + (event.progress || 0) / 100) / shotResult.shots.length * 100 }) });
    const check = await probe(ctx.ffprobe, path.join(ctx.dir, file), ['-select_streams', 'v:0', '-show_frames', '-show_streams', '-show_entries', 'frame=best_effort_timestamp_time:stream=duration'], ctx);
    requireThat(check.frames?.length === expected, `镜头 ${shot.order} 帧数校验失败：预期 ${expected}，实际 ${check.frames?.length}`);
    check.frames.forEach((frame, index) => requireThat(Math.abs(Number(frame.best_effort_timestamp_time) - (media.frames[shot.start_frame + index].start - shot.start)) < 0.00002, `镜头 ${shot.order} 时间戳与原视频不一致`));
    requireThat(Math.abs(Number(check.streams?.[0]?.duration) - (shot.end - shot.start)) < 0.00002, `镜头 ${shot.order} 尾帧时长不一致`);
    results.push({ ...shot, path: file, audio_mode: audio ? 'original' : 'mute', frame_count: expected, validation: 'frame_count_pts_and_end_duration' });
  }
  const result = envelope(ctx.taskId, { boundary_policy: POLICY, alignment_algorithm_id: ALGORITHM, clips: results });
  await atomicJson(path.join(ctx.dir, 'clips.json'), result);
  return result;
}
module.exports = { clips };
