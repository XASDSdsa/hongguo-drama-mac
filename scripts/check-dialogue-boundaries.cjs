'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  align,
  exportsModule,
  breathOnCut,
  speechRanges,
  acousticPauses,
  ALGORITHM,
  POLICY,
} = require('../src/native/video-structure/alignment');
const shotsAt = (times) =>
  times.slice(0, -1).map((start, i) => ({
    shot_id: `raw-${i}`,
    order: i + 1,
    start,
    end: times[i + 1],
    start_frame: i * 50,
    end_frame_exclusive: (i + 1) * 50,
  }));
const speech = (ranges, duration, text) => ({
  duration,
  utterances: ranges.map(([start, end], i) => ({
    utterance_id: `u${i}`,
    start,
    end,
    text: text || `第${i}句话。还没换气`,
  })),
});
const voicedSpeech = (ranges, duration, text) => {
  const transcript = speech(ranges, duration, text);
  transcript.voice_timeline = {
    segments: transcript.utterances.map((u) => ({
      segment_id: `${u.utterance_id}:voice:1`,
      utterance_id: u.utterance_id,
      start: u.start,
      end: u.end,
    })),
  };
  return transcript;
};
const overlaps = (u, s) => u.start < s.end && u.end > s.start;
function keptFlags(raw, transcript) {
  const spoken = speechRanges(transcript);
  const pauses = acousticPauses(spoken);
  return raw.slice(1).map((shot) => breathOnCut(shot.start, spoken, pauses));
}
function verify(raw, transcript, result) {
  assert.equal(result.algorithm_id, ALGORITHM);
  assert.equal(result.boundary_policy, POLICY);
  const kept = keptFlags(raw, transcript);
  assert.deepEqual(
    result.boundary_decisions.map((d) => d.time),
    raw.slice(1).map((s) => s.start),
  );
  assert.deepEqual(
    result.boundary_decisions.map((d) => d.status),
    kept.map((ok) => (ok ? 'kept' : 'merged')),
  );
  assert.equal(result.merged_boundary_count, kept.filter((ok) => !ok).length);
  assert.equal(result.raw_shot_count, raw.length);
  const groups = [[raw[0]]];
  raw.slice(1).forEach((shot, index) => {
    if (kept[index]) groups.push([shot]);
    else groups.at(-1).push(shot);
  });
  assert.equal(result.shots.length, groups.length);
  assert.equal(
    result.shots.reduce((sum, s) => sum + s.end_frame_exclusive - s.start_frame, 0),
    raw.at(-1).end_frame_exclusive - raw[0].start_frame,
  );
  result.shots.forEach((shot, index) => {
    const group = groups[index];
    assert.equal(shot.order, index + 1);
    assert.equal(shot.start, group[0].start);
    assert.equal(shot.end, group.at(-1).end);
    assert.equal(shot.start_frame, group[0].start_frame);
    assert.equal(shot.end_frame_exclusive, group.at(-1).end_frame_exclusive);
    assert.deepEqual(
      shot.source_shot_ids,
      group.map((item) => item.shot_id),
    );
    assert.equal(shot.internal_boundaries.length, group.length - 1);
    assert.deepEqual(
      shot.internal_boundaries.map((item) => item.time),
      group.slice(1).map((item) => item.start),
    );
    assert.deepEqual(
      shot.utterance_ids,
      transcript.utterances.filter((u) => overlaps(u, shot)).map((u) => u.utterance_id),
    );
    assert.deepEqual(
      shot.voice_segment_ids,
      (transcript.voice_timeline?.segments || []).filter((v) => overlaps(v, shot)).map((v) => v.segment_id),
    );
  });
  assert.equal(result.associations.length, transcript.utterances.length);
  for (const u of transcript.utterances) {
    const rows = result.associations.filter((a) => a.utterance_id === u.utterance_id),
      owners = result.shots.filter((s) => overlaps(u, s));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].start, u.start);
    assert.equal(rows[0].end, u.end);
    assert.deepEqual(
      rows[0].shot_ids,
      owners.map((s) => s.shot_id),
    );
    assert.deepEqual(
      rows[0].segments,
      owners.map((s) => ({ shot_id: s.shot_id, start: Math.max(u.start, s.start), end: Math.min(u.end, s.end) })),
    );
    assert.equal(rows[0].segments[0].start, u.start);
    assert.equal(rows[0].segments.at(-1).end, u.end);
  }
  for (const pause of acousticPauses(speechRanges(transcript))) {
    const visual = raw.slice(1).some((shot) => pause.start - 1e-6 <= shot.start && shot.start <= pause.end + 1e-6);
    const cutThere = result.boundary_decisions.some(
      (decision) =>
        decision.status === 'kept' && pause.start - 1e-6 <= decision.time && decision.time <= pause.end + 1e-6,
    );
    assert.equal(
      cutThere,
      visual &&
        result.boundary_decisions.some(
          (decision) =>
            decision.status === 'kept' && pause.start - 1e-6 <= decision.time && decision.time <= pause.end + 1e-6,
        ),
    );
    if (!visual) assert.equal(cutThere, false);
  }
}
async function main() {
  const raw = shotsAt([0, 2, 4, 6, 8, 10]);
  for (const ranges of [
    [],
    [[1, 3]],
    [[1, 7]],
    [
      [0, 2],
      [2, 4],
    ],
    [
      [1, 3],
      [2.5, 5],
    ],
    [[2.001, 3.999]],
    [[0, 10]],
    [[1.9, 2.000001]],
  ]) {
    const t = speech(ranges, 10),
      copy = JSON.stringify({ raw, t });
    verify(raw, t, align(raw, t, 'test'));
    assert.equal(JSON.stringify({ raw, t }), copy);
  }
  // 话没说完，画面切了，也不切。句号不算出气口。
  const unfinished = speech([[0.4, 5.6]], 6, '这句话还没说完。镜头已经切了。');
  const unfinishedShots = shotsAt([0, 2, 4, 6]);
  const unfinishedResult = align(unfinishedShots, unfinished, 'unfinished');
  verify(unfinishedShots, unfinished, unfinishedResult);
  assert.equal(unfinishedResult.shots.length, 1);
  assert.deepEqual(
    unfinishedResult.boundary_decisions.map((d) => d.reason),
    ['speech_not_finished', 'speech_not_finished'],
  );
  // 切镜落在气口上才切。5 秒那刀还在说话，不切。
  const landedShots = shotsAt([0, 2, 5, 8]);
  const landed = voicedSpeech(
    [
      [0.2, 1.9],
      [2.3, 7.8],
    ],
    8,
  );
  const landedResult = align(landedShots, landed, 'landed');
  verify(landedShots, landed, landedResult);
  assert.deepEqual(
    landedResult.shots.map((s) => [s.start, s.end]),
    [
      [0, 2],
      [2, 8],
    ],
  );
  assert.deepEqual(
    landedResult.boundary_decisions.map((d) => d.status),
    ['kept', 'merged'],
  );
  assert.equal(landedResult.boundary_decisions[0].reason, 'acoustic_pause_on_visual_cut');
  assert.equal(landedResult.boundary_decisions[1].reason, 'speech_not_finished');
  // 有气口、没有切镜，不另切一刀。
  const gapOnlyShots = shotsAt([0, 2, 5, 7]);
  const gapOnly = voicedSpeech(
    [
      [0.2, 1.2],
      [1.5, 4.6],
    ],
    7,
  );
  const gapOnlyResult = align(gapOnlyShots, gapOnly, 'gap');
  verify(gapOnlyShots, gapOnly, gapOnlyResult);
  assert.equal(gapOnlyResult.shots.length, 1);
  assert.equal(
    gapOnlyResult.boundary_decisions.some((d) => d.time > 1.2 && d.time < 1.5),
    false,
  );
  assert.equal(gapOnlyResult.boundary_decisions[0].reason, 'speech_not_finished');
  assert.equal(gapOnlyResult.boundary_decisions[1].reason, 'no_acoustic_pause_on_visual_cut');
  // 一口气里多个切镜，都不切。
  const oneBreath = voicedSpeech([[0.3, 9.7]], 10, '一口气还没断。切了好几镜。还没换气');
  const oneBreathResult = align(raw, oneBreath, 'one-breath');
  verify(raw, oneBreath, oneBreathResult);
  assert.equal(oneBreathResult.shots.length, 1);
  assert.equal(oneBreathResult.merged_boundary_count, 4);
  assert.ok(oneBreathResult.boundary_decisions.every((d) => d.reason === 'speech_not_finished'));
  const three = speech([[1, 5]], 10),
    threeResult = align(raw, three, 'three');
  verify(raw, three, threeResult);
  assert.equal(threeResult.shots.length, 1);
  const same = speech(
      [
        [0.2, 0.8],
        [1, 1.8],
      ],
      10,
    ),
    sameResult = align(raw, same, 'same');
  assert.equal(sameResult.associations.length, 2);
  assert.equal(sameResult.associations[0].shot_id, sameResult.associations[1].shot_id);
  const voice = { ...three, voice_timeline: { segments: [{ segment_id: 'v', utterance_id: 'u0', start: 1, end: 5 }] } };
  verify(raw, voice, align(raw, voice, 'voice'));
  assert.throws(() => align([{ ...raw[0] }, { ...raw[1], start: 2.2 }], speech([], 4), 'bad'), /时间缺口/);
  assert.throws(() => align(shotsAt([1, 3]), speech([[0, 2]], 3), 'bad'), /超出/);
  // 气口在两刀之间，不落在切镜上，整段仍并在一起。
  const longRaw = shotsAt([0, 5, 10, 15, 20, 25, 30, 35, 40, 47]);
  const chained = speech(
    [
      [1, 11],
      [11.2, 21],
      [21.2, 31],
      [31.2, 46],
    ],
    47,
  );
  const chainResult = align(longRaw, chained, 'chain');
  verify(longRaw, chained, chainResult);
  assert.equal(chainResult.shots.length, 1);
  const onPause = shotsAt([0, 11.1, 47]);
  const onPauseSpeech = speech(
    [
      [1, 11],
      [11.2, 46],
    ],
    47,
  );
  const onPauseResult = align(onPause, onPauseSpeech, 'on-pause');
  verify(onPause, onPauseSpeech, onPauseResult);
  assert.deepEqual(
    onPauseResult.shots.map((s) => [s.start, s.end]),
    [
      [0, 11.1],
      [11.1, 47],
    ],
  );
  for (let n = 1; n <= 100; n++) {
    const ranges = Array.from({ length: 5 }, (_, i) => {
      const a = ((n * 17 + i * 31) % 90) / 10;
      return [a, Math.min(10, a + (((n + i) % 13) + 1) / 10)];
    }).sort((a, b) => a[0] - b[0]);
    const varied = speech(ranges, 10);
    verify(raw, varied, align(raw, varied, 'varied'));
  }
  // 切点必须离停顿边缘至少 30 ms：停顿 0.9–1.1 s 里，0.92 和 1.08 太靠边，1.0 在中间。
  const edgeSpeech = voicedSpeech(
    [
      [0, 0.9],
      [1.1, 2],
    ],
    2.5,
  );
  for (const [time, expected] of [
    [0.92, 'merged'],
    [1.0, 'kept'],
    [1.08, 'merged'],
  ]) {
    const edgeShots = shotsAt([0, time, 2.5]);
    assert.equal(align(edgeShots, edgeSpeech, 'edge').boundary_decisions[0].status, expected, `cut at ${time}`);
  }
  // 超过最长时长的段，用更短的停顿在已有画面切点处拆开；说话中间永远不切。
  const longShots = shotsAt([0, 30, 62, 90]);
  const shortPauses = voicedSpeech(
    [
      [0, 29.95],
      [30.05, 61.95],
      [62.05, 89.5],
    ],
    90,
  );
  const relaxed = align(longShots, shortPauses, 'relaxed');
  assert.deepEqual(
    relaxed.shots.map((shot) => [shot.start, shot.end]),
    [
      [0, 30],
      [30, 90],
    ],
  );
  assert.equal(relaxed.boundary_decisions[0].tier, 1);
  assert.equal(relaxed.boundary_decisions[0].reason, 'shorter_pause_to_limit_shot_length');
  assert.equal(relaxed.boundary_decisions[1].status, 'merged');
  assert.equal(relaxed.statistics.relaxed_cut_count, 1);
  assert.equal(relaxed.statistics.longest_shot_seconds, 60);
  assert.deepEqual(relaxed.statistics.over_limit_shot_ids, []);
  assert.equal(relaxed.merged_boundary_count, 1);
  assert.equal(relaxed.max_shot_seconds, 60);
  // 不超限、或明确关闭上限时，不放宽。
  assert.equal(align(longShots, shortPauses, 'unlimited', { maxShotSeconds: 0 }).shots.length, 1);
  assert.equal(align(longShots, shortPauses, 'roomy', { maxShotSeconds: 100 }).shots.length, 1);
  // 一口气说到底：没有可用停顿，保持整段并记录，不在话中间硬切。
  const nonStop = voicedSpeech([[0, 90]], 90);
  const kept = align(longShots, nonStop, 'non-stop');
  assert.equal(kept.shots.length, 1);
  assert.equal(
    kept.boundary_decisions.every((d) => d.status === 'merged' && d.reason === 'speech_not_finished'),
    true,
  );
  assert.equal(kept.statistics.over_limit_shot_ids.length, 1);
  assert.equal(kept.statistics.longest_shot_seconds, 90);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-boundaries-'));
  try {
    await fs.writeFile(path.join(dir, 'clip.mp4'), 'fixture');
    const t = voicedSpeech(
      [
        [0.1, 1.8],
        [2.3, 5.1],
        [6.2, 7.5],
        [8.2, 9.2],
      ],
      10,
    );
    t.utterances[2].text = t.utterances[1].text;
    const final = align(raw, t, 'export');
    verify(raw, t, final);
    assert.deepEqual(
      final.shots.map((s) => [s.start, s.end]),
      [
        [0, 2],
        [2, 6],
        [6, 8],
        [8, 10],
      ],
    );
    const clipSet = {
      boundary_policy: POLICY,
      alignment_algorithm_id: ALGORITHM,
      clips: final.shots.map((s) => ({ ...s, path: 'clip.mp4' })),
    };
    const run = (a = final, c = clipSet, spoken = t) => exportsModule({ taskId: 'export', dir }, a, c, spoken, dir);
    const exported = await run();
    assert.equal(exported.subtitle_cues.length, t.utterances.length);
    exported.subtitle_cues.forEach((cue, i) => {
      const voiceRow = t.voice_timeline.segments[i];
      assert.equal(cue.voice_segment_id, voiceRow.segment_id);
      assert.equal(cue.text, t.utterances[i].text);
      assert.equal(cue.start, voiceRow.start);
      assert.equal(cue.end, voiceRow.end);
      assert.deepEqual(cue.shot_ids, final.associations[i].shot_ids);
    });
    const srt = (await fs.readFile(path.join(dir, 'subtitles.srt'), 'utf8')).trim().split(/\n\s*\n/);
    assert.equal(srt.length, 4);
    assert.deepEqual(
      srt.map((block) => block.split('\n')[2]),
      t.utterances.map((u) => u.text),
    );
    assert(srt[0].includes('00:00:00,100 --> 00:00:01,800'));
    for (const [mutate, message] of [
      [(spoken) => delete spoken.voice_timeline, /缺少已校验的人声片段/],
      [(spoken) => (spoken.voice_timeline.segments = []), /已有音频片段与台词有声区间不一致/],
      [(spoken) => delete spoken.voice_timeline.segments[0].utterance_id, /人声片段缺少台词关联/],
      [(spoken) => spoken.voice_timeline.segments.pop(), /已有音频片段与台词有声区间不一致/],
    ]) {
      const bad = structuredClone(t);
      mutate(bad);
      const aligned = align(raw, bad, 'export');
      const clips = {
        boundary_policy: POLICY,
        alignment_algorithm_id: ALGORITHM,
        clips: aligned.shots.map((s) => ({ ...s, path: 'clip.mp4' })),
      };
      await assert.rejects(() => run(aligned, clips, bad), message);
    }
    const corruptions = [
      (a) => a.associations.pop(),
      (a) => a.associations.push(a.associations[0]),
      (a) => (a.associations[0].utterance_id = 'missing'),
      (a) => a.associations[0].shot_ids.push('fake-shot'),
      (a) => (a.associations[0].shot_ids[0] = 'fake-shot'),
      (a) => (a.associations[0].segments[0].end -= 0.1),
      (a) => a.associations[0].segments.pop(),
      (a) => (a.associations[0].end -= 0.1),
      (a) => {
        a.associations[0].shot_id = null;
      },
      (a) => (a.shots[0].utterance_ids = []),
      (a) => (a.shots[0].voice_segment_ids = []),
    ];
    for (const mutate of corruptions) {
      const bad = structuredClone(final);
      mutate(bad);
      await assert.rejects(() => run(bad), /台词|分镜|人声/);
    }
    const wrongClip = structuredClone(clipSet);
    wrongClip.clips[0].end += 0.1;
    await assert.rejects(() => run(final, wrongClip), /边界或来源不一致/);
    const wrongSource = structuredClone(clipSet);
    wrongSource.clips[0].source_shot_ids = ['fake'];
    await assert.rejects(() => run(final, wrongSource), /边界或来源不一致/);
    const precise = shotsAt([0, 2.041666, 4.083334]),
      spoken = voicedSpeech(
        [
          [0.1, 2.041666],
          [2.041666, 3.2],
        ],
        4.083334,
      );
    const rounded = align(precise, spoken, 'rounding');
    verify(precise, spoken, rounded);
    assert.equal(rounded.shots.length, 1);
    const roundingClips = {
      boundary_policy: POLICY,
      alignment_algorithm_id: ALGORITHM,
      clips: rounded.shots.map((s) => ({ ...s, path: 'clip.mp4' })),
    };
    await run(rounded, roundingClips, spoken);
    const roundedSrt = await fs.readFile(path.join(dir, 'subtitles.srt'), 'utf8');
    assert(roundedSrt.includes('00:00:00,100 --> 00:00:02,042'));
    assert(roundedSrt.includes('00:00:02,042 --> 00:00:03,200'));
    const tailShots = shotsAt([0, 2.041666, 4.083667]),
      tailSpeech = voicedSpeech([[0.0004, 4.083667]], 4.083667);
    const tail = align(tailShots, tailSpeech, 'tail');
    verify(tailShots, tailSpeech, tail);
    assert.equal(tail.shots.length, 1);
    const tailClips = {
      boundary_policy: POLICY,
      alignment_algorithm_id: ALGORITHM,
      clips: tail.shots.map((s) => ({ ...s, path: 'clip.mp4' })),
    };
    const tailExport = await run(tail, tailClips, tailSpeech);
    assert.equal(tailExport.subtitle_cues.length, 1);
    assert.equal(tailExport.subtitle_cues[0].start, 0.0004);
    assert.equal(tailExport.subtitle_cues[0].end, 4.083667);
    assert.equal(tailExport.subtitle_cues[0].shot_ids.length, 1);
    assert.equal(tailExport.subtitle_cues[0].text, tailSpeech.utterances[0].text);
    assert(tailExport.subtitle_cues[0].end <= tailSpeech.duration);
    assert((await fs.readFile(path.join(dir, 'subtitles.srt'), 'utf8')).includes('00:00:00,000 --> 00:00:04,083'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log('PASS 话没说完不切，气口落在切镜上才切，有气口无切镜不切，一口气里多个切镜不切');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
