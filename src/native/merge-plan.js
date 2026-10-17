// Compare decoder configuration, not per-file statistics such as bitrate or duration.
const VIDEO_FIELDS = [
  'codec_name',
  'codec_tag_string',
  'profile',
  'level',
  'width',
  'height',
  'pix_fmt',
  'sample_aspect_ratio',
  'r_frame_rate',
  'extradata_hash',
  'color_range',
  'color_space',
  'color_transfer',
  'color_primaries',
  'field_order',
];
const AUDIO_FIELDS = ['codec_name', 'profile', 'sample_rate', 'channels', 'channel_layout', 'extradata_hash'];
const signature = (stream, fields) => (stream ? JSON.stringify(fields.map((key) => stream[key] ?? null)) : '');
function readMergeInfo(data) {
  const video = data.streams?.find((s) => s.codec_type === 'video');
  if (!video) return null;
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration) || 0;
  const formatBitrate = Number(data.format?.bit_rate) || (Number(data.format?.size) * 8) / duration || 0;
  return {
    codec: video.codec_name,
    w: video.width,
    h: video.height,
    audio: !!audio,
    duration,
    video,
    audioStream: audio || null,
    videoSignature: signature(video, VIDEO_FIELDS),
    audioSignature: signature(audio, AUDIO_FIELDS),
    signature: JSON.stringify([
      signature(video, VIDEO_FIELDS),
      video.time_base,
      signature(audio, AUDIO_FIELDS),
      audio?.time_base,
    ]),
    videoBitrate:
      Number(video.bit_rate) || Math.max(0, formatBitrate - (Number(audio?.bit_rate) || (audio ? 96000 : 0))),
  };
}
function buildMergePlan(infos, { compatible = false } = {}) {
  if (!infos.length || infos.some((info) => !info || !(info.duration > 0) || !(info.w > 0) || !(info.h > 0)))
    throw new Error('分集缺少有效时长或画面尺寸');
  const first = infos[0],
    totalDuration = infos.reduce((sum, info) => sum + info.duration, 0);
  const videoMode =
    !['h264', 'hevc'].includes(first.codec) ||
    (compatible && first.codec !== 'h264') ||
    infos.some((info) => !info.video.extradata_hash || info.videoSignature !== first.videoSignature)
      ? 'encode'
      : 'copy';
  const hasAudio = infos.some((info) => info.audio);
  const audioMode = !hasAudio
    ? 'none'
    : videoMode === 'encode' ||
        infos.some(
          (info) => !info.audio || !info.audioStream.extradata_hash || info.audioSignature !== first.audioSignature,
        ) ||
        (compatible && first.audioStream?.codec_name !== 'aac')
      ? 'encode'
      : 'copy';
  const remux = infos.some(
    (info) =>
      info.video.time_base !== first.video.time_base || info.audioStream?.time_base !== first.audioStream?.time_base,
  );
  const [num, den = 1] = String(first.video.r_frame_rate || '30/1')
    .split('/')
    .map(Number);
  const fps = Math.min(60, Math.max(1, num / den || 30));
  // ponytail: one bitrate for the pass keeps encoder headers consistent; per-scene quality tuning can follow measured demand.
  const sourceRate =
    infos.reduce(
      (sum, info) =>
        sum +
        (info.videoBitrate || info.w * info.h * fps * 0.04) * (info.codec === 'hevc' ? 1.8 : 1.25) * info.duration,
      0,
    ) / totalDuration;
  const videoBitrate = Math.round(Math.min(20000000, Math.max(300000, sourceRate)) / 1000) * 1000;
  const audioBitrate = hasAudio ? 96000 : 0;
  return {
    videoMode,
    audioMode,
    remux,
    fps,
    width: Math.ceil(first.w / 2) * 2,
    height: Math.ceil(first.h / 2) * 2,
    videoBitrate,
    audioBitrate,
    totalDuration,
    estimatedBytes: (totalDuration * (videoBitrate + audioBitrate)) / 8,
  };
}

function canUseHardwareFrames(infos, plan, encoder) {
  return (
    encoder === 'h264_videotoolbox' &&
    infos.every(
      (info) =>
        ['h264', 'hevc'].includes(info.codec) &&
        info.video.pix_fmt === 'yuv420p' &&
        info.w === plan.width &&
        info.h === plan.height &&
        (!info.video.sample_aspect_ratio || info.video.sample_aspect_ratio === '1:1'),
    )
  );
}
module.exports = { readMergeInfo, buildMergePlan, canUseHardwareFrames };
