'use strict';
const path = require('node:path');
const fs = require('node:fs').promises;
const { run, probe, json, atomicJson } = require('./io');
const { requireThat, envelope, validateIntervals } = require('./contracts');
const EFFECTS_FILTER = 'highpass=f=900,acompressor=threshold=0.1:ratio=3:attack=5:release=50,alimiter=limit=0.95';
const VOICE_TAIL_POLICY = 'adaptive-pcm-energy-v1';
const VOICE_TAIL_FRAME_SECONDS = 0.01;
const VOICE_TAIL_MIN_SECONDS = 0.08;
const VOICE_TAIL_SAFETY_SECONDS = 0.04;
const VOICE_TAIL_MAX_SECONDS = 0.6;
const VOICE_TAIL_RATIO_DB = 18;
const VOICE_TAIL_MIN_DROP_DB = 12;
const MASK_FRAME_FILTER = 'asetnsamples=n=64:p=0';
function sentenceRange(segment, rate) {
  const start = Number.isSafeInteger(segment.start_sample) ? segment.start_sample / rate : Number(segment.start);
  const end = Number.isSafeInteger(segment.end_sample_exclusive)
    ? segment.end_sample_exclusive / rate
    : Number(segment.end);
  requireThat(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start, '语音区间无效');
  return { start, end };
}
function sentenceSpans(segment, rate) {
  const sentence = sentenceRange(segment, rate);
  const spans = segment.speech_spans === undefined ? [segment] : segment.speech_spans;
  requireThat(Array.isArray(spans) && spans.length > 0, '完整台词缺少实际有声区间');
  let previous = sentence.start;
  const result = spans.map((span) => {
    const range = sentenceRange(span, rate);
    requireThat(
      range.start >= previous - 1e-9 && range.start >= sentence.start - 1e-9 && range.end <= sentence.end + 1e-9,
      '人声区间重叠、重复或超出完整台词',
    );
    previous = range.end;
    return {
      ...range,
      source_segment_ids: span.source_segment_ids || segment.source_segment_ids || [],
      ...(Number.isInteger(span.source_text_start) ? { source_text_start: span.source_text_start } : {}),
      ...(Number.isInteger(span.source_text_end) ? { source_text_end: span.source_text_end } : {}),
    };
  });
  requireThat(
    Math.abs(result[0].start - sentence.start) <= 1 / rate && Math.abs(result.at(-1).end - sentence.end) <= 1 / rate,
    '人声区间遗漏台词开头或结尾',
  );
  return result;
}
function utteranceId(segment, rate, taskId) {
  const range = sentenceRange(segment, rate);
  return `${taskId}:utterance:${Math.round(range.start * rate)}-${Math.round(range.end * rate)}`;
}
function voiceSegments(raw, separated, media, taskId = 'task') {
  // Only keep intervals that produced actual recognized text. VAD is useful
  // for finding work to send to ASR, but a VAD-only interval can be music,
  // effects, room tone, or a false positive. Keeping it in the vocal mask
  // makes the human track audible where there is no dialogue.
  const sourceSegments = raw && raw.segments;
  requireThat(Array.isArray(sourceSegments), '识别器没有返回可用的语音时间段');
  const end = Number(media.video_end);
  requireThat(Number.isFinite(end) && end > 0, '视频缺少有效结束时间');
  const rate = Number(raw.sample_rate || 16000),
    offset = numericOffset(separated.offset);
  const segments = sourceSegments
    .filter((segment) => String(segment?.text || '').trim())
    .flatMap((segment) => {
      const id = utteranceId(segment, rate, taskId);
      return sentenceSpans(segment, rate).flatMap((span, index) => {
        const start = Math.max(0, span.start + offset),
          finish = Math.min(end, span.end + offset);
        if (finish <= start) return [];
        return [
          {
            segment_id: `${id}:voice:${index + 1}`,
            utterance_id: id,
            start,
            end: finish,
            source_start: span.start,
            source_end: span.end,
            source_segment_ids: span.source_segment_ids,
            ...(Number.isInteger(span.source_text_start) ? { source_text_start: span.source_text_start } : {}),
            ...(Number.isInteger(span.source_text_end) ? { source_text_end: span.source_text_end } : {}),
            text: String(segment.text).trim(),
          },
        ];
      });
    });
  validateIntervals(segments, end, 'segment_id');
  segments.forEach((segment, index) =>
    requireThat(!index || segment.start >= segments[index - 1].end - 1e-9, '人声区间重叠，不能重复输出音频'),
  );
  return segments;
}
function numericOffset(value) {
  const offset = Number(value ?? 0);
  requireThat(Number.isFinite(offset), `音频偏移无效：${value}`);
  return offset;
}

function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)))];
}

/**
 * Decide whether the end of one recognized voice interval is residual room
 * tone/reverb.  This is deliberately a pure decision function so the rule can
 * be tested without an audio runtime.  It only trims a continuous low-energy
 * tail after a strong body and never moves the start of a speech interval.
 */
function detectVoiceTail(
  energies,
  sampleRate,
  {
    frameSeconds = VOICE_TAIL_FRAME_SECONDS,
    minTailSeconds = VOICE_TAIL_MIN_SECONDS,
    safetySeconds = VOICE_TAIL_SAFETY_SECONDS,
    maxTrimSeconds = VOICE_TAIL_MAX_SECONDS,
    ratioDb = VOICE_TAIL_RATIO_DB,
    minDropDb = VOICE_TAIL_MIN_DROP_DB,
  } = {},
) {
  if (!Array.isArray(energies) || energies.length < 8 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const body = percentile(energies, 0.8);
  if (!(body > 0)) return null;
  const threshold = Math.max(260, body * Math.pow(10, -ratioDb / 20));
  let tailFrames = 0;
  for (let index = energies.length - 1; index >= 0 && energies[index] < threshold; index -= 1) tailFrames += 1;
  if (tailFrames < Math.ceil(minTailSeconds / frameSeconds)) return null;
  const lastActive = energies.length - tailFrames - 1;
  if (lastActive < 1) return null;
  const bodyWindow = energies.slice(Math.max(0, lastActive - 9), lastActive + 1).filter((value) => value > 0);
  const tailWindow = energies.slice(lastActive + 1).filter((value) => value > 0);
  const activeMedian = percentile(bodyWindow, 0.5);
  const tailMedian = percentile(tailWindow, 0.5);
  if (!(activeMedian > 0 && tailMedian > 0)) return null;
  const dropDb = 20 * Math.log10(activeMedian / tailMedian);
  if (!Number.isFinite(dropDb) || dropDb < minDropDb) return null;
  const trimSeconds = Math.min(maxTrimSeconds, Math.max(0, tailFrames * frameSeconds - safetySeconds));
  if (trimSeconds < minTailSeconds) return null;
  return {
    trim_seconds: trimSeconds,
    tail_seconds: tailFrames * frameSeconds,
    threshold,
    body_db: 20 * Math.log10(Math.max(1, body) / 32768),
    drop_db: dropDb,
    last_active_frame: lastActive,
  };
}

function parsePcm16Wav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('人声音轨不是 WAV 文件');
  let offset = 12,
    channels = 0,
    sampleRate = 0,
    bits = 0,
    format = 0,
    dataStart = -1,
    dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4),
      length = buffer.readUInt32LE(offset + 4),
      body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(length, buffer.length - body);
      break;
    }
    offset = body + length + (length % 2);
  }
  if (format !== 1 || bits !== 16 || channels < 1 || sampleRate < 1 || dataStart < 0 || dataLength < 2 * channels)
    throw new Error('人声音轨不是可分析的 PCM16 WAV');
  return {
    buffer,
    channels,
    sampleRate,
    dataStart,
    dataLength,
    frameBytes: channels * 2,
    frames: Math.floor(dataLength / (channels * 2)),
  };
}

function energiesForRange(wav, start, end, frameSeconds = VOICE_TAIL_FRAME_SECONDS) {
  const first = Math.max(0, Math.floor(start * wav.sampleRate));
  const last = Math.min(wav.frames, Math.ceil(end * wav.sampleRate));
  const frameSize = Math.max(1, Math.round(frameSeconds * wav.sampleRate));
  const energies = [];
  for (let frame = first; frame < last; frame += frameSize) {
    const count = Math.min(frameSize, last - frame);
    let sum = 0,
      samples = 0;
    for (let sample = frame; sample < frame + count; sample += 1) {
      const sampleStart = wav.dataStart + sample * wav.frameBytes;
      for (let channel = 0; channel < wav.channels; channel += 1) {
        const value = wav.buffer.readInt16LE(sampleStart + channel * 2);
        sum += value * value;
        samples += 1;
      }
    }
    energies.push(samples ? Math.sqrt(sum / samples) : 0);
  }
  return energies;
}

async function tightenVoiceSegments(segments, wavPath, { offset = 0 } = {}) {
  if (!Array.isArray(segments) || !segments.length) return { segments: segments || [], changed: 0, skipped: 'empty' };
  let wav;
  try {
    wav = parsePcm16Wav(await fs.readFile(wavPath));
  } catch (error) {
    return { segments, changed: 0, skipped: `${error.name}: ${error.message}` };
  }
  const updated = segments.map((segment) => {
    const start = Math.max(0, Number(segment.start) - Number(offset || 0));
    const end = Math.min(wav.frames / wav.sampleRate, Number(segment.end) - Number(offset || 0));
    // A very short utterance has too little evidence for a safe tail decision.
    if (!(end > start + 0.5)) return segment;
    const decision = detectVoiceTail(energiesForRange(wav, start, end), wav.sampleRate);
    if (!decision) return segment;
    const newEnd = Math.max(Number(segment.start) + 0.18, Number(segment.end) - decision.trim_seconds);
    if (!(newEnd > Number(segment.start) && newEnd < Number(segment.end) - 0.001)) return segment;
    return {
      ...segment,
      end: newEnd,
      tail_trimmed_seconds: Number(segment.end) - newEnd,
      tail_detection: { policy: VOICE_TAIL_POLICY, ...decision },
    };
  });
  return {
    segments: updated,
    changed: updated.filter((segment, index) => segment.end !== segments[index].end).length,
    skipped: null,
  };
}

function timelineFilter(
  segments,
  { offset = 0, videoEnd, sourceDuration, sampleRate = 0, channels = 2, keepOnlySegments = false } = {},
) {
  const timelineEnd = Number(videoEnd);
  const sourceEnd = Number(sourceDuration);
  const audioOffset = numericOffset(offset);
  requireThat(Number.isFinite(timelineEnd) && timelineEnd > 0, '视频缺少有效结束时间');
  requireThat(Number.isFinite(sourceEnd) && sourceEnd >= 0, '音频缺少有效时长');
  const filters = [];
  if (keepOnlySegments) {
    // The filter expression is evaluated on the source track's clock. The
    // source starts at video time `offset`, so every video-time segment must
    // be translated back before masking. A single volume expression avoids
    // the old volume=0,volume=1 chain, which multiplied the whole track by 0.
    const ranges = (segments || [])
      .map(({ start, end }) => {
        const sourceStart = Math.max(0, Number(start) - audioOffset);
        const sourceEndForRange = Math.min(sourceEnd, Number(end) - audioOffset);
        if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEndForRange) || sourceEndForRange <= sourceStart)
          return null;
        return [sourceStart, sourceEndForRange];
      })
      .filter(Boolean);
    if (!ranges.length) filters.push('volume=0');
    else {
      const expression = ranges.map(([start, end]) => `between(t,${start.toFixed(6)},${end.toFixed(6)})`).join('+');
      // FFmpeg's volume expression parser does not reliably evaluate an
      // `if(...,1,0)` expression when passed through child_process.spawn. A
      // conditional mute is equivalent and keeps the original samples inside
      // the selected ranges without multiplying the whole track by zero.
      // `enable` is evaluated once per audio frame, at the frame's start time, so the mask is only
      // as precise as the frame size, which differs between FFmpeg builds. Small fixed frames keep the
      // mask edges within about a millisecond whatever the decoder hands over.
      filters.push(MASK_FRAME_FILTER, `volume=0:enable='not(${expression})'`);
    }
  }
  // Rebase the source stream onto the video timeline. For a positive offset,
  // add silence before the source. For a negative offset, discard the audio
  // that precedes video time zero. `asetpts` keeps all later filters at t=0.
  if (audioOffset < 0) {
    filters.push(`atrim=start=${(-audioOffset).toFixed(6)}`, 'asetpts=PTS-STARTPTS');
  } else if (audioOffset > 0) {
    const rate = Number(sampleRate);
    const channelCount = Math.max(1, Number(channels) || 1);
    if (Number.isFinite(rate) && rate > 0) {
      // Sample-based delays preserve sub-millisecond PTS offsets (the real
      // audio path is 44.1 kHz). Millisecond fallback keeps the helper usable
      // with older FFmpeg builds that do not support the `S` suffix.
      const delaySamples = Math.max(0, Math.round(audioOffset * rate));
      filters.push(`adelay=${Array.from({ length: channelCount }, () => `${delaySamples}S`).join('|')}`);
    } else {
      const delayMs = Math.max(0, Math.round(audioOffset * 1000));
      filters.push(`adelay=${Array.from({ length: channelCount }, () => delayMs).join('|')}`);
    }
  }
  filters.push('apad', `atrim=duration=${timelineEnd.toFixed(6)}`, 'asetpts=PTS-STARTPTS');
  return filters.join(',');
}
function voiceFilter(segments, options = {}) {
  // Keep this helper useful for callers that only need the masking expression
  // (for example, unit tests). The production timeline path supplies videoEnd
  // and sourceDuration so it can also rebase a non-zero audio offset.
  if (options.videoEnd == null && options.sourceDuration == null) {
    const ranges = (segments || [])
      .map(({ start, end }) => [Number(start), Number(end)])
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
    if (!ranges.length) return 'volume=0';
    const expression = ranges.map(([start, end]) => `between(t,${start.toFixed(6)},${end.toFixed(6)})`).join('+');
    return `${MASK_FRAME_FILTER},volume=0:enable='not(${expression})'`;
  }
  return timelineFilter(segments, { ...options, keepOnlySegments: true });
}
async function separation(ctx, audio, audioDir) {
  // Inst_HQ_3 predicts background. sherpa 1.13.8 names its direct model
  // output vocals regardless of the model target. Use the residual for speech.
  let completedStages = 0;
  const report = (completed, message) => {
    completedStages = Math.max(completedStages, completed);
    ctx.onProgress?.({
      progress: (completedStages / 6) * 100,
      progress_unit: 'stages',
      progress_completed: completedStages,
      progress_total: 6,
      message,
    });
  };
  report(0, '加载人声分离模型');
  const startedAt = Date.now();
  // The bundled sherpa binary exposes only coarse stderr milestones
  // (Started/Done/Saved), not the internal UVR frame count. Never turn an
  // elapsed-time guess into a percentage: while inference is running the UI
  // receives the true elapsed time and the explicit limitation instead.
  const pulse = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    if (completedStages < 2)
      report(
        completedStages,
        `${completedStages === 0 ? '加载分离模型' : '正在分离人声与背景'}（CPU ${ctx.params.threads} 线程，已用时 ${Math.floor(elapsed)} 秒；引擎未提供分块进度）`,
      );
  }, 2000);
  pulse.unref?.();
  try {
    await run(
      ctx.params.binary,
      [
        `--num-threads=${ctx.params.threads}`,
        `--provider=${ctx.params.provider}`,
        `--uvr-model=${ctx.params.model}`,
        `--input-wav=${path.join(audioDir, audio.path)}`,
        `--output-vocals-wav=${path.join(ctx.dir, 'background.wav')}`,
        `--output-accompaniment-wav=${path.join(ctx.dir, 'vocals.wav')}`,
      ],
      {
        ...ctx,
        onStderrLine(line) {
          const milestone = String(line).trim();
          if (milestone === 'Started') report(1, '分离引擎已启动，正在分离人声与背景；引擎未提供分块进度');
          else if (milestone === 'Done') report(2, '分离推理已完成，正在写入音轨');
          else if (/^Saved to write to /.test(milestone)) report(3, '两条音轨已写入，正在校验文件');
        },
      },
    );
  } finally {
    clearInterval(pulse);
  }
  report(3, '分离进程已完成，正在校验两条音轨');
  const tracks = {};
  for (const [index, name] of ['vocals', 'background'].entries()) {
    const info = await probe(ctx.ffprobe, path.join(ctx.dir, `${name}.wav`), ['-show_streams', '-show_format'], ctx);
    const sampleRate = Number(info.streams[0]?.sample_rate);
    const duration = Number(info.format.duration);
    requireThat(
      sampleRate === audio.sample_rate && Math.abs(duration - audio.duration) <= 1 / sampleRate + 0.000001,
      `${name} 与整集原音轨长度不一致`,
    );
    tracks[name] = {
      path: `${name}.wav`,
      sample_rate: sampleRate,
      channels: info.streams[0].channels,
      duration,
      offset: audio.offset,
    };
    report(index + 4, `已校验${name === 'vocals' ? '人声' : '背景'}音轨时长与采样率`);
  }
  report(5, '音轨时长已对齐，正在保存分离结果');
  const result = envelope(ctx.taskId, {
    model: ctx.params.model_id,
    stem_mapping: 'Inst_HQ_3: model_output=background; residual=vocals',
    offset: audio.offset,
    mapping: audio.mapping,
    tracks,
  });
  await atomicJson(path.join(ctx.dir, 'separation.json'), result);
  report(6, '分离结果已保存');
  return result;
}
function mapTranscript(raw, separated, media, taskId, adjustedSegments = null) {
  requireThat(raw.sample_rate === 16000 && Array.isArray(raw.segments), '识别器返回的结果格式无效');
  const videoEnd = Number(media.video_end);
  requireThat(Number.isFinite(videoEnd) && videoEnd > 0, '视频缺少有效结束时间');
  const warnings = [...(raw.warnings || [])];
  const offset = numericOffset(separated.offset);
  const adjustedById = new Map((adjustedSegments || []).map((segment) => [segment.segment_id, segment]));
  if (!raw.segments.length) warnings.push({ reason: '未检测到可识别的语音，请试听人声轨；不能据此认定原视频没有对白' });
  const utterances = raw.segments.flatMap((s) => {
    requireThat(
      Number.isSafeInteger(s.start_sample) &&
        Number.isSafeInteger(s.end_sample_exclusive) &&
        s.start_sample >= 0 &&
        s.end_sample_exclusive > s.start_sample &&
        typeof s.text === 'string',
      '识别段时间或文本无效',
    );
    const originalStart = s.start_sample / raw.sample_rate + offset;
    const originalEnd = s.end_sample_exclusive / raw.sample_rate + offset;
    requireThat(s.end_sample_exclusive / raw.sample_rate <= raw.duration + 1 / raw.sample_rate, '识别段超出人声轨');
    const id = utteranceId(s, raw.sample_rate, taskId);
    const speechSpans = sentenceSpans(s, raw.sample_rate).flatMap((span, index) => {
      const adjusted = adjustedById.get(`${id}:voice:${index + 1}`);
      const spanStart = Math.max(0, adjusted ? adjusted.start : span.start + offset),
        spanEnd = Math.min(videoEnd, adjusted ? adjusted.end : span.end + offset);
      return spanEnd > spanStart
        ? [
            {
              start: spanStart,
              end: spanEnd,
              source_segment_ids: span.source_segment_ids,
              ...(Number.isInteger(span.source_text_start) ? { source_text_start: span.source_text_start } : {}),
              ...(Number.isInteger(span.source_text_end) ? { source_text_end: span.source_text_end } : {}),
            },
          ]
        : [];
    });
    const start = speechSpans[0]?.start ?? Math.max(0, originalStart);
    const end = speechSpans.at(-1)?.end ?? Math.min(videoEnd, originalEnd);
    if (start !== originalStart || end !== originalEnd)
      warnings.push({
        reason: '台词时间轴已按实际人声片段收紧句尾',
        original_start: originalStart,
        original_end: originalEnd,
        adjusted_start: start,
        adjusted_end: end,
      });
    if (end <= start || !s.text.trim()) return [];
    return [
      {
        utterance_id: id,
        text: s.text.trim(),
        start,
        end,
        audio_start: s.start_sample / raw.sample_rate,
        audio_end: s.end_sample_exclusive / raw.sample_rate,
        offset,
        timing_method: s.timing_method || raw.timing_method || 'vad_segment',
        needs_review: Boolean(s.needs_review || raw.needs_review),
        source_segment_ids: s.source_segment_ids || [],
        speech_spans: speechSpans,
        ...(s.sentence_boundary_unresolved ? { sentence_boundary_unresolved: true } : {}),
      },
    ];
  });
  if (!utterances.length && raw.segments.length)
    warnings.push({ reason: '检测到了语音区间，但识别没有返回可用台词；已保留静音时间轴' });
  validateIntervals(utterances, videoEnd, 'utterance_id');
  return envelope(taskId, {
    utterances,
    warnings,
    duration: videoEnd,
    offset,
    runtime_version: raw.runtime_version,
    timing_method: raw.timing_method || 'vad_segment',
    needs_review: Boolean(raw.needs_review || utterances.some((u) => u.needs_review)),
    alignment_summary: raw.alignment_summary,
    sentence_boundary_source: raw.sentence_boundary_source,
  });
}
async function transcript(ctx, separated, media, separationDir) {
  const wav = path.join(ctx.dir, 'recognition.wav');
  await run(
    ctx.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-i',
      path.join(separationDir, separated.tracks.vocals.path),
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wav,
    ],
    ctx,
  );
  const rawPath = path.join(ctx.dir, 'recognition.raw.json');
  const args = [
    ...ctx.runtime.prefix,
    'transcript',
    '--input',
    wav,
    '--output',
    rawPath,
    '--model',
    ctx.params.model,
    '--tokens',
    ctx.params.tokens,
    '--vad',
    ctx.params.vad,
    '--device',
    ctx.params.provider,
    '--threads',
    String(ctx.params.threads),
    '--threshold',
    String(ctx.params.vad_threshold),
    '--min-silence',
    String(ctx.params.min_silence),
    '--min-speech',
    String(ctx.params.min_speech),
  ];
  if (ctx.params.punctuation) args.push('--punctuation', ctx.params.punctuation);
  await run(ctx.runtime.command, args, ctx);
  requireThat(
    ctx.params.sentence_command && ctx.params.sentence_model,
    '缺少句级声学对齐运行时或模型，请安装完整应用包',
  );
  const alignedPath = path.join(ctx.dir, 'recognition.json');
  ctx.onProgress?.({ message: '正在按完整台词进行句级声学对齐' });
  await run(
    ctx.params.sentence_command,
    [
      ...(ctx.params.sentence_prefix || []),
      '--align-transcript',
      rawPath,
      '--input',
      wav,
      '--output',
      alignedPath,
      '--model',
      ctx.params.sentence_model,
      '--device',
      ctx.params.sentence_device || 'cpu',
      '--compute-type',
      ctx.params.sentence_compute_type || 'int8',
      '--local-files-only',
    ],
    ctx,
  );
  const raw = await json(alignedPath);
  const detectedSegments = voiceSegments(raw, separated, media, ctx.taskId);
  const tailResult = await tightenVoiceSegments(
    detectedSegments,
    path.join(separationDir, separated.tracks.vocals.path),
    { offset: separated.offset },
  );
  const segments = tailResult.segments;
  const result = mapTranscript(raw, separated, media, ctx.taskId, segments);
  const vadCount = Array.isArray(raw.vad_segments) ? raw.vad_segments.length : 0;
  const timelinePath = path.join(ctx.dir, 'vocals_timeline.wav');
  await run(
    ctx.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-i',
      path.join(separationDir, separated.tracks.vocals.path),
      '-af',
      voiceFilter(segments, {
        offset: separated.offset,
        videoEnd: media.video_end,
        sourceDuration: separated.tracks.vocals.duration,
        sampleRate: separated.tracks.vocals.sample_rate,
        channels: separated.tracks.vocals.channels,
      }),
      '-ar',
      String(separated.tracks.vocals.sample_rate),
      '-ac',
      String(separated.tracks.vocals.channels),
      '-c:a',
      'pcm_s16le',
      timelinePath,
    ],
    ctx,
  );
  const backgroundTimelinePath = path.join(ctx.dir, 'background_timeline.wav');
  await run(
    ctx.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-i',
      path.join(separationDir, separated.tracks.background.path),
      '-af',
      timelineFilter(null, {
        offset: separated.offset,
        videoEnd: media.video_end,
        sourceDuration: separated.tracks.background.duration,
        sampleRate: separated.tracks.background.sample_rate,
        channels: separated.tracks.background.channels,
      }),
      '-ar',
      String(separated.tracks.background.sample_rate),
      '-ac',
      String(separated.tracks.background.channels),
      '-c:a',
      'pcm_s16le',
      backgroundTimelinePath,
    ],
    ctx,
  );
  const effectsTimelinePath = path.join(ctx.dir, 'effects_timeline.wav');
  await run(
    ctx.ffmpeg,
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-i',
      backgroundTimelinePath,
      '-af',
      `${EFFECTS_FILTER},apad,atrim=duration=${Number(media.video_end).toFixed(6)},asetpts=PTS-STARTPTS`,
      '-ar',
      String(separated.tracks.background.sample_rate),
      '-ac',
      String(separated.tracks.background.channels),
      '-c:a',
      'pcm_s16le',
      effectsTimelinePath,
    ],
    ctx,
  );
  result.voice_timeline = {
    path: 'vocals_timeline.wav',
    start: 0,
    end: media.video_end,
    duration: media.video_end,
    sample_rate: separated.tracks.vocals.sample_rate,
    channels: separated.tracks.vocals.channels,
    segments,
  };
  result.background_timeline = {
    path: 'background_timeline.wav',
    start: 0,
    end: media.video_end,
    duration: media.video_end,
    sample_rate: separated.tracks.background.sample_rate,
    channels: separated.tracks.background.channels,
  };
  result.effects_timeline = {
    path: 'effects_timeline.wav',
    start: 0,
    end: media.video_end,
    duration: media.video_end,
    sample_rate: separated.tracks.background.sample_rate,
    channels: separated.tracks.background.channels,
    method: 'heuristic_highpass_from_background',
    cutoff_hz: 900,
  };
  result.processing = {
    no_voice_ranges: 'zeroed_in_place',
    omitted_vad_only_segments: Math.max(0, vadCount - segments.length),
    concatenation: false,
    alignment: '[start,end) video timeline',
    effects: 'estimated_high_frequency_residual',
    voice_tail_policy: VOICE_TAIL_POLICY,
    voice_tail_trimmed_segments: tailResult.changed,
    voice_tail_trimmed_seconds: Number(
      segments.reduce((sum, segment) => sum + Number(segment.tail_trimmed_seconds || 0), 0).toFixed(6),
    ),
    ...(tailResult.skipped ? { voice_tail_skipped: tailResult.skipped } : {}),
  };
  if (tailResult.changed)
    result.warnings = [
      ...(result.warnings || []),
      {
        code: 'voice_tail_trimmed',
        reason: `已按自适应能量收紧 ${tailResult.changed} 段人声句尾`,
        policy: VOICE_TAIL_POLICY,
      },
    ];
  await atomicJson(path.join(ctx.dir, 'transcript.json'), result);
  await require('node:fs').promises.rm(wav, { force: true });
  return result;
}
module.exports = {
  separation,
  transcript,
  mapTranscript,
  voiceSegments,
  voiceFilter,
  timelineFilter,
  detectVoiceTail,
  tightenVoiceSegments,
  VOICE_TAIL_POLICY,
};
