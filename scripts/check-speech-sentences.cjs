'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  mapTranscript,
  voiceSegments,
  voiceFilter,
  transcript,
  detectVoiceTail,
} = require('../src/native/video-structure/speech');
const { align, srt } = require('../src/native/video-structure/alignment');
const { run } = require('../src/native/video-structure/io');

const span = (start, end, id) => ({
  start,
  end,
  start_sample: Math.round(start * 16000),
  end_sample_exclusive: Math.round(end * 16000),
  source_segment_ids: [id],
});
const raw = {
  sample_rate: 16000,
  duration: 1,
  timing_method: 'whisper-audio-pause-v5',
  sentence_boundary_source: 'ct_transformer_global',
  alignment_summary: { sentences: 2 },
  segments: [
    {
      ...span(0.1, 0.7, 'vad:a'),
      text: '先说完再继续。',
      source_segment_ids: ['vad:a', 'vad:b'],
      speech_spans: [span(0.1, 0.25, 'vad:a'), span(0.5, 0.7, 'vad:b')],
    },
    {
      ...span(0.8, 0.9, 'vad:c'),
      text: '下一句。',
      timing_method: 'vad_segment_unresolved',
      needs_review: true,
      speech_spans: [span(0.8, 0.9, 'vad:c')],
    },
  ],
};
const media = { video_end: 1.2 };
const separated = { offset: 0.125 };
function near(a, b) {
  assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
}

async function main() {
  const syntheticSpeech = Array(80).fill(12000).concat(Array(20).fill(700));
  const tailDecision = detectVoiceTail(syntheticSpeech, 16000);
  assert(tailDecision && tailDecision.trim_seconds >= 0.1 && tailDecision.trim_seconds <= 0.2);
  assert.equal(detectVoiceTail(Array(100).fill(12000), 16000), null);
  assert.equal(detectVoiceTail(Array(80).fill(12000).concat(Array(20).fill(5000)), 16000), null);
  const mapped = mapTranscript(raw, separated, media, 'test');
  const voices = voiceSegments(raw, separated, media, 'test');
  assert.equal(mapped.utterances.length, 2);
  assert.equal(voices.length, 3);
  assert.equal(mapped.timing_method, raw.timing_method);
  assert.equal(mapped.utterances[1].timing_method, 'vad_segment_unresolved');
  assert.equal(mapped.utterances[1].needs_review, true);
  assert.equal(mapped.needs_review, true);
  assert.deepEqual(mapped.utterances[0].source_segment_ids, ['vad:a', 'vad:b']);
  assert.deepEqual(
    mapped.utterances[0].speech_spans.map((s) => [s.start, s.end]),
    [
      [0.225, 0.375],
      [0.625, 0.825],
    ],
  );
  assert.equal(voices[0].utterance_id, mapped.utterances[0].utterance_id);
  assert.equal(voices[1].utterance_id, mapped.utterances[0].utterance_id);
  near(voices[2].start, 0.925);
  near(voices[2].end, 1.025);
  const tightened = voices.map((voice, index) => (index === 1 ? { ...voice, end: 0.775 } : voice));
  const remapped = mapTranscript(raw, separated, media, 'test', tightened);
  near(remapped.utterances[0].speech_spans[1].end, 0.775);
  near(remapped.utterances[0].end, 0.775);
  const negative = voiceSegments(raw, { offset: -0.15 }, media, 'negative');
  near(negative[0].start, 0);
  near(negative[0].end, 0.1);
  const negativeMap = mapTranscript(raw, { offset: -0.15 }, media, 'negative');
  assert.equal(negativeMap.utterances[0].start, 0);
  assert(negativeMap.warnings.length);
  const duplicated = structuredClone(raw);
  duplicated.segments[0].speech_spans.push(duplicated.segments[0].speech_spans[1]);
  assert.throws(() => voiceSegments(duplicated, separated, media), /重叠|重复/);
  const lost = structuredClone(raw);
  lost.segments[0].speech_spans.pop();
  assert.throws(() => mapTranscript(lost, separated, media, 'lost'), /遗漏/);
  assert.throws(() => voiceSegments(raw, { offset: NaN }, media), /偏移无效/);
  const cuts = [0, 0.3, 0.5, 0.9, 1.2].slice(0, -1).map((start, i) => ({
    shot_id: `s${i}`,
    order: i + 1,
    start,
    end: [0, 0.3, 0.5, 0.9, 1.2][i + 1],
    start_frame: i * 10,
    end_frame_exclusive: (i + 1) * 10,
  }));
  const indexed = align(cuts, { ...mapped, voice_timeline: { segments: voices } }, 'test');
  // Every visual cut is a shot boundary, wherever the speech is; dialogue is only indexed against the shots.
  assert.deepEqual(
    indexed.boundary_decisions.map((d) => [d.time, d.status]),
    [
      [0.3, 'kept'],
      [0.5, 'kept'],
      [0.9, 'kept'],
    ],
  );
  assert.equal(indexed.shots.length, cuts.length);
  assert.equal(indexed.raw_shot_count, cuts.length);
  assert.equal(indexed.merged_boundary_count, 0);
  assert.equal(indexed.associations.length, 2);
  assert.equal(indexed.associations[0].shot_ids.length, 3);
  // Audio-confirmed continuity crosses both an ASR window and a visual cut;
  // wrong punctuation must remain text, never become another voice clip.
  const continuousSpan = { ...span(0.1, 0.9, 'vad:a'), source_segment_ids: ['vad:a', 'vad:b'] };
  const continuousRaw = {
    ...raw,
    segments: [{ ...continuousSpan, text: '突破汉月。五、品', speech_spans: [continuousSpan] }],
  };
  const continuousVoices = voiceSegments(continuousRaw, separated, media, 'continuous');
  const continuousText = mapTranscript(continuousRaw, separated, media, 'continuous');
  assert.equal(continuousVoices.length, 1);
  assert.equal(continuousText.utterances.length, 1);
  near(continuousVoices[0].start, continuousText.utterances[0].start);
  near(continuousVoices[0].end, continuousText.utterances[0].end);
  const continuousIndex = align(
    cuts,
    { ...continuousText, voice_timeline: { segments: continuousVoices } },
    'continuous',
  );
  // Continuous speech stays one voice clip even though every visual cut is still a shot boundary.
  assert.equal(continuousIndex.shots.length, cuts.length);
  assert.equal(continuousIndex.associations[0].shot_ids.length, cuts.length);
  assert.equal(continuousText.utterances[0].text, '突破汉月。五、品');
  const punctuation = {
    ...raw,
    alignment_summary: { sentences: 3 },
    segments: [
      { ...span(0.1, 0.3, 'vad:a'), text: '桥，', speech_spans: [span(0.1, 0.3, 'vad:a')] },
      { ...span(0.3, 0.5, 'vad:a'), text: '谁乱动通道就会提前关闭，', speech_spans: [span(0.3, 0.5, 'vad:a')] },
      { ...span(0.5, 0.7, 'vad:a'), text: '下一批慢一点，', speech_spans: [span(0.5, 0.7, 'vad:a')] },
    ],
  };
  const clauses = mapTranscript(punctuation, separated, media, 'punctuation');
  const clauseVoices = voiceSegments(punctuation, separated, media, 'punctuation');
  assert.deepEqual(
    clauses.utterances.map((item) => item.text),
    ['桥，', '谁乱动通道就会提前关闭，', '下一批慢一点，'],
  );
  assert.equal(clauses.utterances.map((item) => item.text).join(''), '桥，谁乱动通道就会提前关闭，下一批慢一点，');
  assert.equal((srt(clauses.utterances).match(/-->/g) || []).length, 3);
  assert.equal(clauseVoices.length, 3);
  assert.equal(clauseVoices[0].end, clauses.utterances[0].end);
  assert.equal(clauseVoices[1].start, clauses.utterances[1].start);
  assert.equal(clauseVoices[0].end, clauseVoices[1].start);
  assert.equal(clauseVoices[1].end, clauseVoices[2].start);
  assert.equal(clauseVoices[2].start, clauses.utterances[2].start);
  assert.equal(clauseVoices[2].end, clauses.utterances[2].end);
  assert.deepEqual(
    clauseVoices.map((item) => item.utterance_id),
    clauses.utterances.map((item) => item.utterance_id),
  );
  const clauseIndex = align(cuts, { ...clauses, voice_timeline: { segments: clauseVoices } }, 'punctuation');
  // Shots follow the picture only; clause voices neither add nor remove a cut.
  assert.deepEqual(
    clauseIndex.shots.map((item) => [item.start, item.end]),
    cuts.map((item) => [item.start, item.end]),
  );
  assert.equal(clauseIndex.merged_boundary_count, 0);
  assert.equal(clauseIndex.associations.length, 3);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-sentence-test-'));
  try {
    const ffmpeg = process.env.STRUCTURE_TEST_FFMPEG || path.resolve('build/ffmpeg/darwin-arm64/ffmpeg');
    const input = path.join(temp, 'vocals.wav');
    await run(ffmpeg, [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000:duration=1',
      '-ac',
      '1',
      input,
    ]);
    const worker = path.join(temp, 'worker.cjs');
    await fs.writeFile(
      worker,
      `const fs=require('node:fs');const a=process.argv.slice(2);const get=k=>a[a.indexOf(k)+1];fs.appendFileSync(${JSON.stringify(path.join(temp, 'calls.jsonl'))},JSON.stringify(a)+String.fromCharCode(10));if(a.includes('--align-transcript')){if(!get('--align-transcript').endsWith('recognition.raw.json')||!fs.existsSync(get('--align-transcript'))||!a.includes('--local-files-only')||get('--device')!=='cpu'||get('--compute-type')!=='int8')throw Error('alignment invocation mismatch');}else if(a[0]!=='transcript'||!get('--output').endsWith('recognition.raw.json'))throw Error('raw invocation mismatch');fs.writeFileSync(get('--output'),${JSON.stringify(JSON.stringify(raw))});`,
    );
    const stage = path.join(temp, 'output');
    await fs.mkdir(stage);
    const result = await transcript(
      {
        dir: stage,
        ffmpeg,
        taskId: 'integration',
        runtime: { command: process.execPath, prefix: [worker] },
        params: {
          model: 'paraformer',
          tokens: 'tokens',
          vad: 'vad',
          provider: 'cpu',
          threads: 1,
          vad_threshold: 0.5,
          min_silence: 0.5,
          min_speech: 0.25,
          punctuation: 'punctuation',
          sentence_command: process.execPath,
          sentence_prefix: [worker],
          sentence_model: 'tiny',
          sentence_device: 'cpu',
          sentence_compute_type: 'int8',
        },
      },
      {
        ...separated,
        tracks: {
          vocals: { path: 'vocals.wav', duration: 1, sample_rate: 16000, channels: 1 },
          background: { path: 'vocals.wav', duration: 1, sample_rate: 16000, channels: 1 },
        },
      },
      media,
      temp,
    );
    assert.equal(result.voice_timeline.segments.length, 3);
    assert.equal(result.utterances.length, 2);
    assert.equal(result.timing_method, raw.timing_method);
    const calls = (await fs.readFile(path.join(temp, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'transcript');
    assert(calls[1].includes('--align-transcript'));
    await fs.access(path.join(stage, 'recognition.raw.json'));
    await fs.access(path.join(stage, 'recognition.json'));
    const samples = path.join(temp, 'samples.raw');
    await run(ffmpeg, [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-i',
      path.join(stage, 'vocals_timeline.wav'),
      '-f',
      's16le',
      '-ac',
      '1',
      samples,
    ]);
    const pcm = await fs.readFile(samples);
    const rms = (start, end) => {
      let sum = 0,
        n = 0;
      for (let i = Math.floor(start * 16000); i < Math.floor(end * 16000); i++) {
        const v = pcm.readInt16LE(i * 2);
        sum += v * v;
        n++;
      }
      return Math.sqrt(sum / n);
    };
    assert.equal(pcm.length / 2, 19200);
    assert(rms(0.25, 0.32) > 500);
    assert(rms(0.45, 0.55) < 1);
    assert(rms(0.67, 0.73) > 500);
    assert.match(voiceFilter(voices), /between/);
    console.log(
      'PASS speech mapping: pre-segmented text/voice boundaries, breath-gated visual cuts, metadata, offsets, no duplicate/lost spans, real silent gaps, raw→alignment CLI sequence',
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
