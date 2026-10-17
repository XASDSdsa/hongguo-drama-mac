'use strict';
const assert = require('node:assert/strict');
const { voiceSubtitleCues } = require('../src/native/video-structure/alignment');
const { mapTranscript, voiceSegments } = require('../src/native/video-structure/speech');
const shots = [
  { shot_id: 's1', start: 0, end: 10.8 },
  { shot_id: 's2', start: 10.8, end: 13.366 },
  { shot_id: 's3', start: 13.366, end: 20 },
];
const source = (start, end, text) => ({
  start_sample: Math.round(start * 16000),
  end_sample_exclusive: Math.round(end * 16000),
  text,
});
const raw = {
  segments: [
    source(9.126, 10.604, '那就证明给我看'),
    source(11.878, 13.772, '什么，证明'),
    source(14.63, 16.588, '你俩继续'),
    source(17.222, 19.436, '闭上眼，救救我'),
  ],
};
const sourceIds = raw.segments.map((row) => `vad:${row.start_sample}-${row.end_sample_exclusive}`);
const span = (start, end, sourceIndex) => ({ start, end, source_segment_ids: [sourceIds[sourceIndex]] });
const utterances = [
  {
    utterance_id: 'u1',
    text: '那就证明给我看什么，',
    start: 9.126,
    end: 12.238,
    speech_spans: [span(9.126, 10.526, 0), span(11.878, 12.238, 1)],
  },
  {
    utterance_id: 'u2',
    text: '证明你俩继续闭上眼，',
    start: 12.238,
    end: 18.182,
    speech_spans: [span(12.238, 13.038, 1), span(14.63, 15.73, 2), span(17.222, 18.182, 3)],
  },
  { utterance_id: 'u3', text: '救救我', start: 18.182, end: 19.402, speech_spans: [span(18.182, 19.402, 3)] },
];
const transcript = {
  duration: 20,
  utterances,
  voice_timeline: {
    segments: utterances.flatMap((u) =>
      u.speech_spans.map((s, i) => ({
        ...s,
        utterance_id: u.utterance_id,
        segment_id: `${u.utterance_id}:voice:${i}`,
        text: u.text,
      })),
    ),
  },
};
const before = JSON.stringify({ transcript, raw, shots });
const cues = voiceSubtitleCues(transcript, shots, raw);
assert.deepEqual(
  cues.map((c) => c.text),
  ['那就证明给我看', '什么，', '证明', '你俩继续', '闭上眼，', '救救我'],
);
assert.equal(cues.length, transcript.voice_timeline.segments.length);
cues.forEach((cue, i) => {
  const voice = transcript.voice_timeline.segments[i];
  assert.equal(cue.voice_segment_id, voice.segment_id);
  assert.equal(cue.start, voice.start);
  assert.equal(cue.end, voice.end);
  assert.deepEqual(
    cue.shot_ids,
    shots.filter((s) => voice.start < s.end && voice.end > s.start).map((s) => s.shot_id),
  );
});
for (const u of utterances)
  assert.equal(
    cues
      .filter((c) => c.utterance_id === u.utterance_id)
      .map((c) => c.text)
      .join(''),
    u.text,
  );
assert.equal(JSON.stringify({ transcript, raw, shots }), before);
assert.throws(() => voiceSubtitleCues(transcript, shots), /原始识别/);
const changed = structuredClone(raw);
changed.segments[0].text = '错字';
assert.throws(() => voiceSubtitleCues(transcript, shots, changed), /文字不一致/);
const ambiguous = structuredClone(transcript);
ambiguous.voice_timeline.segments[1].source_segment_ids.push(sourceIds[0]);
assert.throws(() => voiceSubtitleCues(ambiguous, shots, raw), /不唯一/);
const missing = structuredClone(transcript);
missing.voice_timeline.segments.pop();
assert.throws(() => voiceSubtitleCues(missing, shots, raw), /有声区间/);
const duplicate = structuredClone(transcript);
duplicate.voice_timeline.segments[1].segment_id = duplicate.voice_timeline.segments[0].segment_id;
assert.throws(() => voiceSubtitleCues(duplicate, shots, raw), /重复/);
const one = {
  duration: 20,
  utterances: [{ utterance_id: 'one', text: '连续台词，', start: 10.00003125, end: 11.12345625 }],
  voice_timeline: {
    segments: [{ segment_id: 'voice-one', utterance_id: 'one', start: 10.00003125, end: 11.12345625 }],
  },
};
const exact = voiceSubtitleCues(one, shots);
assert.equal(exact[0].start, one.voice_timeline.segments[0].start);
assert.equal(exact[0].end, one.voice_timeline.segments[0].end);
assert.deepEqual(exact[0].shot_ids, ['s1', 's2']);
// Repeated words and punctuation use their source sequence, never string search or duration ratios.
const englishRaw = { segments: [source(1, 2, 'go'), source(3, 4, 'go，')] };
const englishSpans = englishRaw.segments.map((s) => ({
  start: s.start_sample / 16000,
  end: s.end_sample_exclusive / 16000,
  source_segment_ids: [`vad:${s.start_sample}-${s.end_sample_exclusive}`],
}));
const english = {
  duration: 20,
  utterances: [{ utterance_id: 'en', text: 'go go，', start: 1, end: 4, speech_spans: englishSpans }],
  voice_timeline: { segments: englishSpans.map((s, i) => ({ ...s, segment_id: `en${i}`, utterance_id: 'en' })) },
};
assert.deepEqual(
  voiceSubtitleCues(english, shots, englishRaw).map((c) => c.text),
  ['go ', 'go，'],
);
const explicitEnglish = structuredClone(english);
explicitEnglish.voice_timeline.segments.forEach((voice, i) =>
  Object.assign(voice, { source_text_start: i * 2, source_text_end: (i + 1) * 2 }),
);
const explicitCues = voiceSubtitleCues(explicitEnglish, shots, englishRaw);
assert.deepEqual(
  explicitCues.map((c) => c.text),
  ['go ', 'go，'],
);
assert.equal(explicitCues.map((c) => c.text).join(''), english.utterances[0].text);
// Correctly omitted off-video dialogue must not shift the remaining source text.
const tailRaw = { sample_rate: 16000, segments: [source(0, 0.5, '你'), source(1, 1.5, '好'), source(3, 3.5, '片尾')] };
const tailSpans = tailRaw.segments.slice(0, 2).map((s) => ({
  start: s.start_sample / 16000,
  end: s.end_sample_exclusive / 16000,
  source_segment_ids: [`vad:${s.start_sample}-${s.end_sample_exclusive}`],
}));
const tailTranscript = {
  duration: 2,
  utterances: [
    { utterance_id: 'tail', text: '你好', start: 0, end: 1.5, audio_start: 0, audio_end: 1.5, speech_spans: tailSpans },
  ],
  voice_timeline: { segments: tailSpans.map((s, i) => ({ ...s, segment_id: `tail${i}`, utterance_id: 'tail' })) },
};
const tailRecognition = { segments: [source(0, 1.5, '你好'), source(3, 3.5, '片尾')] };
assert.deepEqual(
  voiceSubtitleCues(tailTranscript, [{ shot_id: 'tailshot', start: 0, end: 2 }], tailRaw, tailRecognition).map(
    (c) => c.text,
  ),
  ['你', '好'],
);
// Tail trimming changes the playable span, never its recognition lookup key.
const trimmedRecognition = {
  sample_rate: 16000,
  duration: 3.5,
  segments: tailRecognition.segments.map((row, i) => (i ? row : { ...row, speech_spans: tailSpans })),
};
const adjustedVoices = voiceSegments(trimmedRecognition, { offset: 0.125 }, { video_end: 2 }, 'trimmed').map(
  (voice, i) => (i === 1 ? { ...voice, end: voice.end - 0.125 } : voice),
);
const trimmedTranscript = mapTranscript(
  trimmedRecognition,
  { offset: 0.125 },
  { video_end: 2 },
  'trimmed',
  adjustedVoices,
);
trimmedTranscript.voice_timeline = { segments: adjustedVoices };
assert.equal(trimmedTranscript.utterances[0].end, 1.5);
assert.equal(trimmedTranscript.utterances[0].audio_end, 1.5);
const trimmedCues = voiceSubtitleCues(
  trimmedTranscript,
  [{ shot_id: 'trimmedshot', start: 0, end: 2 }],
  tailRaw,
  trimmedRecognition,
);
assert.deepEqual(
  trimmedCues.map((c) => c.text),
  ['你', '好'],
);
assert.deepEqual(
  trimmedCues.map((c) => [c.start, c.end]),
  adjustedVoices.map((v) => [v.start, v.end]),
);
// A fully omitted clause can also share the same original VAD source.
const sharedRaw = { sample_rate: 16000, segments: [source(0, 0.5, '你'), source(1, 3.5, '好片尾')] };
const shared = structuredClone(tailTranscript);
shared.utterances[0].speech_spans[1].source_segment_ids = ['vad:16000-56000'];
shared.voice_timeline.segments[1].source_segment_ids = ['vad:16000-56000'];
assert.deepEqual(
  voiceSubtitleCues(shared, [{ shot_id: 'tailshot', start: 0, end: 2 }], sharedRaw, tailRecognition).map((c) => c.text),
  ['你', '好'],
);
console.log(
  'PASS voice-authoritative subtitles: real regression, source text conservation, silence gaps, repeated text, exact timing, unchanged audio/video and invalid mapping rejection',
);
