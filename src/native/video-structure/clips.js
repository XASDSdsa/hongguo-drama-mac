'use strict';
const path = require('node:path');
const { run, probe, atomicJson } = require('./io');
const { requireThat, envelope } = require('./contracts');
const { ALGORITHM, POLICY } = require('./alignment');
async function clips(ctx, media, shotResult) {
  requireThat(
    shotResult.algorithm_id === ALGORITHM && shotResult.boundary_policy === POLICY,
    '请先关联台词与视觉分镜，再导出分镜视频',
  );
  requireThat(Array.isArray(shotResult.shots) && shotResult.shots.length > 0, '缺少分镜');
  const mergedBoundaries = shotResult.shots.reduce(
    (sum, shot) => sum + (Array.isArray(shot.internal_boundaries) ? shot.internal_boundaries.length : 0),
    0,
  );
  requireThat(
    shotResult.raw_shot_count === shotResult.shots.length + mergedBoundaries &&
      shotResult.merged_boundary_count === mergedBoundaries,
    '分镜记账和视觉镜头数量不一致',
  );
  const sourceIds = new Set();
  let previousFrame = 0;
  for (const shot of shotResult.shots) {
    requireThat(
      Number.isSafeInteger(shot.start_frame) &&
        Number.isSafeInteger(shot.end_frame_exclusive) &&
        shot.start_frame === previousFrame &&
        shot.end_frame_exclusive > previousFrame &&
        shot.end_frame_exclusive <= media.frames.length,
      '视觉分镜存在缺帧、重复或无效帧边界',
    );
    requireThat(
      Array.isArray(shot.source_shot_ids) &&
        shot.source_shot_ids.length >= 1 &&
        shot.source_shot_ids.length === new Set(shot.source_shot_ids).size &&
        shot.source_shot_ids.every((id) => !sourceIds.has(id)) &&
        Array.isArray(shot.internal_boundaries) &&
        shot.internal_boundaries.length === shot.source_shot_ids.length - 1,
      '每个分镜必须对应一个视觉镜头，且不能重复引用',
    );
    requireThat(
      Math.abs(shot.start - media.frames[shot.start_frame].start) < 0.000001 &&
        Math.abs(shot.end - (media.frames[shot.end_frame_exclusive]?.start ?? media.video_end)) < 0.000001,
      '视觉分镜边界与源视频帧时间不一致',
    );
    shot.source_shot_ids.forEach((id) => sourceIds.add(id));
    previousFrame = shot.end_frame_exclusive;
  }
  requireThat(previousFrame === media.frames.length, '视觉分镜未覆盖完整视频帧');
  requireThat(['original', 'mute'].includes(ctx.params.audio_mode), '必须明确切片音轨模式：original 或 mute');
  // Each shot is cut from its own position in the source instead of decoding from the start of the file, and
  // several shots are encoded at once. Frame count, every frame PTS and the tail duration are still verified
  // per clip below, so a wrong seek can never pass silently.
  const total = shotResult.shots.length;
  const workers = Math.max(1, Math.min(total, 4, Math.floor(ctx.params.threads / 2)));
  const threadsEach = Math.max(2, Math.floor(ctx.params.threads / workers));
  const origin = media.origin_pts;
  // Frame-accurate bounds halfway between neighbouring frames, so rounding in the timestamps cannot add or drop one.
  const between = (index) => origin + (media.frames[index - 1].start + media.frames[index].start) / 2;
  const SEEK_LEAD = 3; // decode a few seconds before the shot so the first frame never depends on seek quirks
  const SEEK_TAIL = 1;
  const progressOf = new Array(total).fill(0);
  const emitProgress = (shot) =>
    ctx.onProgress?.({
      message: `分镜 ${shot.order}/${total}`,
      progress: (progressOf.reduce((sum, value) => sum + value, 0) / total) * 100,
    });
  const abort = new AbortController();
  const stop = () => abort.abort();
  ctx.signal?.addEventListener('abort', stop, { once: true });
  // exact = false: seek to the shot and trim by timestamps (fast). exact = true: decode from the file start and
  // trim by frame number (slow, but it is the reference behaviour). The fast path is only trusted when every
  // check below passes; otherwise that one shot is redone the exact way.
  const encodeOnce = async (shot, slot, exact) => {
    abort.signal.throwIfAborted();
    const file = `shot-${String(shot.order).padStart(4, '0')}.mp4`;
    const sourceStart = origin + shot.start;
    const sourceEnd = origin + shot.end;
    const expected = shot.end_frame_exclusive - shot.start_frame;
    const lastDuration = Math.round(media.frames[shot.end_frame_exclusive - 1].duration * 1000000);
    const bias = Number(ctx.debugTrimBias) || 0;
    const first = shot.start_frame === 0 ? null : between(shot.start_frame) + bias;
    const last = shot.end_frame_exclusive === media.frames.length ? null : between(shot.end_frame_exclusive) + bias;
    // Subtract the decoded first-frame timestamp in its integer time base.
    // Decimal seconds / TB can round by a tick and shift every following frame.
    const trim = [first == null ? null : `start=${first.toFixed(6)}`, last == null ? null : `end=${last.toFixed(6)}`]
      .filter(Boolean)
      .join(':');
    const filters = [
      exact
        ? `[0:${media.video.index}]trim=start_frame=${shot.start_frame}:end_frame=${shot.end_frame_exclusive},setpts=PTS-STARTPTS[v]`
        : `[0:${media.video.index}]${trim ? `trim=${trim},` : ''}setpts=PTS-STARTPTS[v]`,
    ];
    const seek = exact ? 0 : Math.max(0, sourceStart - SEEK_LEAD);
    const args = ['-nostdin', '-y', '-v', 'error', '-copyts'];
    if (seek > 0) args.push('-ss', seek.toFixed(6));
    if (!exact && last != null) args.push('-t', (last + SEEK_TAIL - seek).toFixed(6));
    args.push('-i', ctx.input);
    const audio = ctx.params.audio_mode === 'original' && media.has_audio;
    if (audio)
      filters.push(
        `[0:${media.audio.index}]atrim=start=${sourceStart}:end=${sourceEnd},asetpts=PTS-${sourceStart}/TB,aresample=async=1:first_pts=0,apad,atrim=duration=${shot.end - shot.start}[a]`,
      );
    args.push('-filter_complex', filters.join(';'), '-map', '[v]');
    if (audio) args.push('-map', '[a]', '-c:a', 'aac');
    else args.push('-an');
    // No reordered packets: the final packet is the final displayed frame.
    // MP4 otherwise infers its duration from nominal FPS, truncating VFR tails.
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      String(threadsEach),
      '-fps_mode',
      'passthrough',
      '-enc_time_base',
      '1:1000000',
      '-video_track_timescale',
      '1000000',
      '-bsf:v',
      `setts=duration='if(eq(N,${expected - 1}),${lastDuration},DURATION)'`,
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      path.join(ctx.dir, file),
    );
    await run(ctx.ffmpeg, args, {
      ...ctx,
      signal: abort.signal,
      duration: shot.end - shot.start,
      onProgress: (event) => {
        progressOf[slot] = Math.max(progressOf[slot], Math.min(0.99, (event.progress || 0) / 100));
        emitProgress(shot);
      },
    });
    const check = await probe(
      ctx.ffprobe,
      path.join(ctx.dir, file),
      [
        '-select_streams',
        'v:0',
        '-show_frames',
        '-show_streams',
        '-show_entries',
        'frame=best_effort_timestamp_time:stream=duration',
      ],
      { ...ctx, signal: abort.signal },
    );
    requireThat(
      check.frames?.length === expected,
      `镜头 ${shot.order} 帧数校验失败：预期 ${expected}，实际 ${check.frames?.length}`,
    );
    check.frames.forEach((frame, index) =>
      requireThat(
        Math.abs(
          Number(frame.best_effort_timestamp_time) - (media.frames[shot.start_frame + index].start - shot.start),
        ) < 0.00002,
        `镜头 ${shot.order} 时间戳与原视频不一致`,
      ),
    );
    requireThat(
      Math.abs(Number(check.streams?.[0]?.duration) - (shot.end - shot.start)) < 0.00002,
      `镜头 ${shot.order} 尾帧时长不一致`,
    );
    progressOf[slot] = 1;
    emitProgress(shot);
    return {
      ...shot,
      path: file,
      audio_mode: audio ? 'original' : 'mute',
      frame_count: expected,
      validation: 'frame_count_pts_and_end_duration',
      export_mode: exact ? 'exact' : 'fast',
    };
  };
  const encode = async (shot, slot) => {
    try {
      return await encodeOnce(shot, slot, false);
    } catch (error) {
      if (abort.signal.aborted) throw error;
      progressOf[slot] = 0;
      return encodeOnce(shot, slot, true);
    }
  };
  const results = new Array(total);
  let next = 0;
  const lane = async () => {
    while (next < total) {
      const slot = next++;
      results[slot] = await encode(shotResult.shots[slot], slot);
    }
  };
  try {
    await Promise.all(
      Array.from({ length: workers }, () =>
        lane().catch((error) => {
          stop(); // a failed clip stops the others instead of leaving encoders running
          throw error;
        }),
      ),
    );
  } finally {
    ctx.signal?.removeEventListener('abort', stop);
  }

  const result = envelope(ctx.taskId, { boundary_policy: POLICY, alignment_algorithm_id: ALGORITHM, clips: results });
  await atomicJson(path.join(ctx.dir, 'clips.json'), result);
  return result;
}
module.exports = { clips };
