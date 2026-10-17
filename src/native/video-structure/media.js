'use strict';
const path = require('node:path');
const { run, probe, atomicJson } = require('./io');
const { envelope, requireThat } = require('./contracts');
function number(value) {
  return value == null || value === '' || value === 'N/A' ? null : Number(value);
}
function timeline(raw, info) {
  requireThat(raw.length > 0, '没有可解码的视频帧');
  const video = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  const origin = number(info.format?.start_time) ?? Math.min(raw[0].pts, number(audio?.start_time) ?? Infinity);
  const frames = raw.map((f, index) => ({ index, pts: f.pts, start: f.pts - origin, duration: f.duration }));
  const deltas = [];
  frames.forEach((f, i) => {
    requireThat(Number.isFinite(f.start) && f.start >= -0.000001, '视频帧早于统一播放起点');
    f.start = Math.max(0, f.start);
    if (i + 1 < frames.length) {
      const delta = frames[i + 1].start - f.start;
      requireThat(delta > 0, '视频时间戳重复或倒退，不能建立准确时间轴');
      f.duration = delta;
      deltas.push(delta);
    }
  });
  const last = frames.at(-1);
  if (!(last.duration > 0)) {
    const streamEnd = (number(video.start_time) ?? raw[0].pts) + (number(video.duration) ?? 0) - origin;
    requireThat(streamEnd > last.start, '末帧缺少有效时长，不能用平均帧率猜测');
    last.duration = streamEnd - last.start;
  }
  const videoEnd = last.start + last.duration;
  const audioEnd = audio ? (number(audio.start_time) ?? origin) - origin + (number(audio.duration) ?? 0) : 0;
  const duration = Math.max(videoEnd, audioEnd, number(info.format?.duration) ?? 0);
  const base = String(video.time_base || '0/1')
    .split('/')
    .map(Number);
  const tolerance = Math.max(0.000002, (base[0] / base[1]) * 1.1 || 0);
  const frameRateType =
    deltas.length < 2 ? 'unknown' : deltas.every((d) => Math.abs(d - deltas[0]) <= tolerance) ? 'cfr' : 'vfr';
  return {
    origin_pts: origin,
    duration,
    container_duration: number(info.format?.duration),
    video_start: frames[0].start,
    video_end: videoEnd,
    frame_rate_type: frameRateType,
    frame_count: frames.length,
    frames,
    video,
    audio: audio || null,
    has_audio: !!audio,
  };
}
async function media(ctx) {
  const info = await probe(ctx.ffprobe, ctx.input, ['-show_streams', '-show_format'], ctx);
  const video = info.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  requireThat(video, '文件没有可用视频流');
  const raw = [];
  await run(
    ctx.ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      String(video.index),
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp_time,duration_time,pkt_duration_time',
      '-of',
      'compact=p=0:nk=0',
      ctx.input,
    ],
    {
      ...ctx,
      onLine: (line) => {
        const fields = Object.fromEntries(line.split('|').map((pair) => pair.split('=')));
        if (fields.best_effort_timestamp_time == null) return;
        raw.push({
          pts: number(fields.best_effort_timestamp_time),
          duration: number(fields.duration_time) ?? number(fields.pkt_duration_time),
        });
        if (raw.length % 500 === 0) ctx.onProgress?.({ message: `已读取 ${raw.length} 帧时间戳` });
      },
    },
  );
  const result = envelope(ctx.taskId, {
    source: ctx.input,
    source_sha256: ctx.sourceHash,
    ...timeline(raw, info),
    streams: info.streams,
  });
  if (result.audio) {
    const first = await probe(
      ctx.ffprobe,
      ctx.input,
      [
        '-select_streams',
        String(result.audio.index),
        '-read_intervals',
        '%+#100',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time',
      ],
      ctx,
    );
    result.audio_first_pts = number(first.frames?.[0]?.best_effort_timestamp_time) ?? number(result.audio.start_time);
    requireThat(Number.isFinite(result.audio_first_pts), '音轨缺少可验证的起始时间戳');
  }
  await atomicJson(path.join(ctx.dir, 'media.json'), result);
  return result;
}
async function audio(ctx, media) {
  requireThat(media.has_audio, '该视频没有音轨，音频分离和台词识别不可运行');
  const file = path.join(ctx.dir, 'original_audio.wav');
  await run(
    ctx.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-copyts',
      '-i',
      ctx.input,
      '-map',
      `0:${media.audio.index}`,
      '-vn',
      '-af',
      'aresample=44100:async=1,asetpts=PTS-STARTPTS',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      '-progress',
      'pipe:1',
      file,
    ],
    { ...ctx, duration: media.duration },
  );
  const info = await probe(ctx.ffprobe, file, ['-show_streams', '-show_format'], ctx);
  const stream = info.streams[0];
  requireThat(stream.sample_rate === '44100' && stream.channels === 2, '提取音频格式不符合 44100 Hz 双声道约定');
  const duration = number(info.format.duration);
  requireThat(duration > 0, '提取音频为空');
  const result = envelope(ctx.taskId, {
    path: 'original_audio.wav',
    sample_rate: 44100,
    channels: 2,
    duration,
    original_start_pts: media.audio_first_pts,
    offset: media.audio_first_pts - media.origin_pts,
    mapping: 'video_time = audio_time + offset',
  });
  await atomicJson(path.join(ctx.dir, 'audio.json'), result);
  return result;
}
module.exports = { timeline, media, audio };
