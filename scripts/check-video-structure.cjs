const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { MODULES, VERSION, envelope, descendants, fingerprint } = require('../src/native/video-structure/contracts');
const { timeline, media, audio } = require('../src/native/video-structure/media');
const { buildShots, ALGORITHM } = require('../src/native/video-structure/shots');
const { clips } = require('../src/native/video-structure/clips');
const {
  align,
  srt,
  exportsModule,
  ALGORITHM: ALIGNMENT_ALGORITHM,
  POLICY: BOUNDARY_POLICY,
} = require('../src/native/video-structure/alignment');
const { mapTranscript, voiceSegments, voiceFilter, timelineFilter } = require('../src/native/video-structure/speech');
const {
  createVideoStructurePipeline,
  implementationFilesFor,
  brief,
} = require('../src/native/video-structure/pipeline');
const { atomicJson, run, sha256 } = require('../src/native/video-structure/io');
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'structure-test-'));
  try {
    const m = timeline(
      [
        { pts: 5, duration: 0.04 },
        { pts: 5.04, duration: 0.08 },
        { pts: 5.12, duration: 0.04 },
      ],
      {
        format: { start_time: '5', duration: '.2' },
        streams: [
          { index: 0, codec_type: 'video', time_base: '1/1000000' },
          { index: 1, codec_type: 'audio', start_time: '5.02', duration: '.18' },
        ],
      },
    );
    assert.equal(m.frame_rate_type, 'vfr');
    assert.equal(m.origin_pts, 5);
    assert(Math.abs(m.duration - 0.2) < 1e-9);
    assert(Math.abs(m.video_end - 0.16) < 1e-9);
    assert.throws(
      () =>
        timeline(
          [
            { pts: 0, duration: 0.04 },
            { pts: 0, duration: 0.04 },
          ],
          { streams: [{ codec_type: 'video' }] },
        ),
      /重复/,
    );
    const verified = (media, cuts) => ({
      algorithm_id: ALGORITHM,
      threshold: 0.5,
      minimum_duration: 2,
      boundary_convention: 'first_frame_of_next_shot',
      frame_count: media.frame_count,
      cuts,
      decisions: cuts.map((frame) => ({ frame, status: 'kept' })),
    });
    const scores3 = { single: [0, 0.8, 0], all: [0, 0.9, 0] };
    assert.throws(() => buildShots(m, scores3, 'task'), /复核/);
    assert.throws(() => buildShots(m, scores3, 'task', verified(m, [1])), /最短2秒/);
    const short = buildShots(m, scores3, 'task', verified(m, []));
    assert.equal(short.shots.length, 1);
    assert.equal(short.shots[0].end_frame_exclusive, 3);
    const warned = verified(m, []);
    warned.warnings = [{ reason: '边界结构不充分' }];
    warned.decisions.push({ frame: 2, status: 'warn', reason: '候选边界被合并' });
    const warnedShots = buildShots(m, scores3, 'warned', warned);
    assert.equal(warnedShots.needs_review, true);
    assert.equal(warnedShots.review_items.length, 2);
    assert.equal(
      warnedShots.review_items.some((item) => item.frame === 2),
      true,
    );
    assert.equal(warnedShots.review_items[0].status, 'needs_review');
    assert.equal(brief(warnedShots).needs_review, true);
    assert.equal(brief(warnedShots).review_items.length, 2);
    assert.equal(brief({ review_items: [{ review_id: 'x' }] }).warning_count, 1);
    const offset = {
      ...m,
      duration: 3,
      video_start: 2.1,
      video_end: 2.26,
      frames: m.frames.map((f) => ({ ...f, start: f.start + 2.1 })),
    };
    assert.equal(buildShots(offset, scores3, 'offset', verified(offset, [])).shots[0].start, 2.1);
    const shot = envelope('task', {
      shots: [
        { shot_id: 'left', start: 0, end: 0.04, start_frame: 0, end_frame_exclusive: 1 },
        { shot_id: 'right', start: 0.04, end: 0.16, start_frame: 1, end_frame_exclusive: 3 },
      ],
    });
    const t = mapTranscript(
      {
        sample_rate: 16000,
        duration: 0.2,
        segments: [{ start_sample: 0, end_sample_exclusive: 1600, text: '跨镜头的话' }],
      },
      { offset: 0.02 },
      m,
      'task',
    );
    t.voice_timeline = {
      segments: t.utterances.map((u) => ({
        segment_id: `${u.utterance_id}:voice:1`,
        utterance_id: u.utterance_id,
        start: u.start,
        end: u.end,
      })),
    };
    const vs = voiceSegments(
      { segments: [{ start: 0.02, end: 0.08, text: '说话' }] },
      { offset: 0.01 },
      { video_end: 0.2 },
    );
    assert.deepEqual(
      vs.map((x) => [x.start, x.end]),
      [[0.03, 0.09]],
    );
    assert.match(voiceFilter(vs), /^asetnsamples=n=64:p=0,volume=0:enable='not\(/);
    assert.equal(voiceFilter([]), 'volume=0');
    // VAD-only intervals are candidates for ASR, not confirmed human speech.
    // They must be muted in place instead of being copied into the vocal track.
    const vadOnly = voiceSegments(
      { segments: [], vad_segments: [{ start: 0.1, end: 0.16, text: '' }] },
      { offset: 0.01 },
      { video_end: 0.2 },
    );
    assert.deepEqual(vadOnly, []);
    assert.equal(voiceFilter(vadOnly), 'volume=0');
    const emptyText = voiceSegments(
      { segments: [{ start: 0.1, end: 0.16, text: '   ' }], vad_segments: [{ start: 0.1, end: 0.16 }] },
      { offset: 0.01 },
      { video_end: 0.2 },
    );
    assert.deepEqual(emptyText, []);
    const emptyTranscript = mapTranscript(
      { sample_rate: 16000, duration: 0.2, segments: [], warnings: [] },
      { offset: 0.02 },
      m,
      'empty',
    );
    assert.equal(emptyTranscript.utterances.length, 0);
    assert(emptyTranscript.warnings.length > 0);
    assert.equal(emptyTranscript.duration, m.video_end);
    const a = align(shot.shots, t, 'task');
    assert.equal(a.associations.length, 1);
    assert.equal(a.shots.length, 1);
    assert.equal(a.merged_boundary_count, 1);
    assert.equal(a.boundary_decisions[0].reason, 'speech_not_finished');
    assert.equal(a.associations[0].shot_ids.length, 1);
    assert.equal(a.associations[0].utterance_id, t.utterances[0].utterance_id);
    assert.equal((srt(t.utterances).match(/-->/g) || []).length, 1);
    assert(srt(t.utterances).includes('00:00:00,020 --> 00:00:00,120'));
    assert.equal(
      align(
        [
          { shot_id: 'a', start: 0, end: 1, start_frame: 0, end_frame_exclusive: 25 },
          { shot_id: 'b', start: 1, end: 2, start_frame: 25, end_frame_exclusive: 50 },
        ],
        { duration: 2, utterances: [{ utterance_id: 'x', start: 1, end: 2, text: '边界' }] },
        't',
      ).associations.length,
      1,
    );
    assert.deepEqual(
      MODULES.map((s) => s.id),
      ['media', 'audio', 'shots', 'separation', 'transcript', 'alignment', 'clips', 'export'],
    );
    assert.deepEqual(descendants('shots'), ['alignment', 'clips', 'export']);
    assert.deepEqual(descendants('transcript'), ['alignment', 'clips', 'export']);
    assert.deepEqual(
      implementationFilesFor('shots').map((file) => path.basename(file)),
      ['contracts.js', 'io.js', 'runtime.js', 'shots.js'],
    );
    assert.deepEqual(
      implementationFilesFor('transcript').map((file) => path.basename(file)),
      ['contracts.js', 'io.js', 'runtime.js', 'speech.js'],
    );
    const cd = path.join(temp, 'clips'),
      ed = path.join(temp, 'export');
    await fs.mkdir(cd);
    await fs.mkdir(ed);
    await fs.writeFile(path.join(cd, 'a.mp4'), 'fixture');
    const ex = await exportsModule(
      { dir: ed, taskId: 'task' },
      a,
      {
        boundary_policy: a.boundary_policy,
        alignment_algorithm_id: a.algorithm_id,
        clips: a.shots.map((s) => ({ ...s, path: 'a.mp4', audio_mode: 'original' })),
      },
      t,
      cd,
    );
    assert.equal(ex.utterance_count, 1);
    assert.equal('csv' in ex, false);
    await assert.rejects(() => fs.access(path.join(ed, 'shots.csv')));
    for (const f of ex.media_files) await fs.access(path.resolve(ed, f.path));
    await scheduler(temp);
    const ffmpeg = process.env.STRUCTURE_TEST_FFMPEG,
      ffprobe = process.env.STRUCTURE_TEST_FFPROBE;
    if (ffmpeg && ffprobe) {
      const input = path.join(temp, 'vfr.mp4');
      await run(ffmpeg, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=192x108:rate=24:duration=3',
        '-itsoffset',
        '0.17',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=400:sample_rate=44100:duration=1.7',
        '-vf',
        "setpts='if(gte(N,8),PTS*2,PTS)'",
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-fps_mode',
        'passthrough',
        input,
      ]);
      const dir = path.join(temp, 'real');
      await fs.mkdir(dir);
      const ctx = { taskId: 'vfr', input, dir, ffmpeg, ffprobe, params: { threads: 2, audio_mode: 'original' } };
      const real = await media(ctx);
      assert.equal(real.frame_rate_type, 'vfr');
      assert((await audio(ctx, real)).offset > 0);
      const scores = Array(real.frame_count).fill(0);
      scores[40] = 0.9;
      const cc = await clips(
        ctx,
        real,
        align(
          buildShots(real, { single: scores, all: scores }, 'vfr', verified(real, [40])).shots,
          { duration: real.video_end, utterances: [] },
          'vfr',
        ),
      );
      assert.equal(
        cc.clips.reduce((n, c) => n + c.frame_count, 0),
        real.frame_count,
      );
      await assert.rejects(() => audio(ctx, { has_audio: false }), /没有音轨/);
      // Real PCM regression: a non-zero audio offset must be represented on the
      // video clock, and masking must preserve speech samples only in the selected
      // interval. The output is padded/truncated to exactly video_end (sample
      // precision) without concatenating the retained ranges.
      const wavIn = path.join(temp, 'timeline-input.wav'),
        wavOut = path.join(temp, 'timeline-output.wav');
      await run(ffmpeg, [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=8000:duration=0.3',
        '-c:a',
        'pcm_s16le',
        wavIn,
      ]);
      const filter = voiceFilter([{ start: 0.15, end: 0.22 }], {
        offset: 0.05,
        videoEnd: 0.4,
        sourceDuration: 0.3,
        sampleRate: 8000,
        channels: 1,
      });
      await run(ffmpeg, [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-i',
        wavIn,
        '-af',
        filter,
        '-ar',
        '8000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wavOut,
      ]);
      const wave = await readPcm16(wavOut);
      assert(Math.abs(wave.duration - 0.4) <= 1 / 8000);
      assert(wave.rms(0, 0.14) < 50);
      assert(wave.rms(0.16, 0.2) > 500);
      assert(wave.rms(0.25, 0.39) < 50);
      // When ASR returns no text, the whole human track must stay silent while
      // retaining the exact video duration and clock.
      const noVoiceOut = path.join(temp, 'timeline-no-voice.wav');
      await run(ffmpeg, [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-i',
        wavIn,
        '-af',
        voiceFilter([], { offset: 0.05, videoEnd: 0.4, sourceDuration: 0.3, sampleRate: 8000, channels: 1 }),
        '-ar',
        '8000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        noVoiceOut,
      ]);
      const noVoiceWave = await readPcm16(noVoiceOut);
      assert(Math.abs(noVoiceWave.duration - 0.4) <= 1 / 8000);
      assert(noVoiceWave.rms(0, 0.4) < 1);
      const backgroundOut = path.join(temp, 'background-output.wav');
      await run(ffmpeg, [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-i',
        wavIn,
        '-af',
        timelineFilter(null, { offset: 0.05, videoEnd: 0.4, sourceDuration: 0.3, sampleRate: 8000, channels: 1 }),
        '-ar',
        '8000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        backgroundOut,
      ]);
      const backgroundWave = await readPcm16(backgroundOut);
      assert(Math.abs(backgroundWave.duration - 0.4) <= 1 / 8000);
      assert(backgroundWave.rms(0, 0.04) < 50);
      assert(backgroundWave.rms(0.08, 0.28) > 500);
      console.log('PASS real FFmpeg VFR frame count, PTS, audio offset and missing audio');
    }
    console.log('PASS structure contracts, alignment, exports and orchestration');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
async function readPcm16(file) {
  const data = await fs.readFile(file);
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  const channels = data.readUInt16LE(22),
    rate = data.readUInt32LE(24),
    bits = data.readUInt16LE(34);
  assert.equal(bits, 16);
  let pos = 12,
    samples = null;
  while (pos + 8 <= data.length) {
    const size = data.readUInt32LE(pos + 4),
      id = data.toString('ascii', pos, pos + 4);
    if (id === 'data') {
      samples = data.subarray(pos + 8, pos + 8 + size);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  assert(samples);
  const frameSize = channels * 2;
  const values = [];
  for (let i = 0; i + 1 < samples.length; i += frameSize) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += Math.abs(samples.readInt16LE(i + c * 2));
    values.push(sum / channels);
  }
  return {
    duration: values.length / rate,
    rms(start, end) {
      const a = Math.max(0, Math.floor(start * rate)),
        b = Math.min(values.length, Math.ceil(end * rate));
      if (b <= a) return 0;
      return values.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
    },
  };
}
async function scheduler(temp) {
  const rt = path.join(temp, 'runtime'),
    exe = process.platform === 'win32' ? '.exe' : '';
  for (const name of [
    'worker/hongguo-structure' + exe,
    'bin/sherpa-onnx-offline-source-separation' + exe,
    'models/transnetv2.pth',
    'models/UVR-MDX-NET-Inst_HQ_3.onnx',
    'models/silero_vad.onnx',
    'models/sherpa-onnx-paraformer-zh-small-2024-03-09/model.int8.onnx',
    'models/sherpa-onnx-paraformer-zh-small-2024-03-09/tokens.txt',
    'models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/model.int8.onnx',
  ]) {
    const f = path.join(rt, name);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, 'fixture');
  }
  for (const name of [
    'hongguo-transcribe' + exe,
    ...['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'].map((file) => 'models/tiny/' + file),
  ]) {
    const f = path.join(rt, 'faster-whisper', name);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, 'fixture');
  }
  const input = path.join(temp, 'episode.mp4');
  await fs.writeFile(input, 'source');
  const records = {},
    calls = {};
  let settings = { structure_runtime_dir: rt, resourcesPath: rt, isPackaged: true },
    fail = null,
    hold = null;
  const handlers = Object.fromEntries(
    MODULES.map((s) => [
      s.id,
      async (ctx) => {
        calls[s.id] = (calls[s.id] || 0) + 1;
        if (fail === s.id) throw Error('fixture failure');
        if (hold === s.id)
          await new Promise((r, j) => ctx.signal.addEventListener('abort', () => j(Error('stopped')), { once: true }));
        const d = envelope(ctx.taskId, {
          fixture: s.id,
          ...(s.id === 'alignment' ? { algorithm_id: ALIGNMENT_ALGORITHM, boundary_policy: BOUNDARY_POLICY } : {}),
          ...(s.id === 'export' ? { subtitle_policy: 'voice-segments-v1' } : {}),
        });
        await atomicJson(path.join(ctx.dir, s.file), d);
        return d;
      },
    ]),
  );
  const opt = {
    getSettings: () => settings,
    getFfmpegPath: () => process.execPath,
    getFfprobePath: () => process.execPath,
    getProjectRecord: (id) => records[id],
    saveProjectRecord: (id, r) => (records[id] = r),
    handlers,
  };
  const p = createVideoStructurePipeline(opt),
    payload = { inputPath: input, outputRoot: temp, projectId: 'fixture' };
  await p.start({ ...payload, module: 'clips' });
  assert.equal((await p.wait('fixture')).status, 'blocked');
  assert.equal(Object.keys(calls).length, 0);
  await p.start(payload);
  assert.equal((await p.wait('fixture')).status, 'completed');
  assert(MODULES.every((s) => calls[s.id] === 1));
  await p.start(payload);
  let result = await p.wait('fixture');
  assert(MODULES.every((s) => calls[s.id] === 1));
  assert(result.modules.export.reused);
  settings = { ...settings, structure_threshold: 0.6 };
  await p.start(payload);
  await p.wait('fixture');
  assert.equal(calls.shots, 1);
  settings = { ...settings, structure_device: 'mps' };
  await p.start(payload);
  await p.wait('fixture');
  assert.equal(calls.media, 1);
  assert.equal(calls.shots, 2);
  assert.equal(calls.clips, 2);
  assert.equal(calls.transcript, 1);
  result = await p.status('fixture');
  await fs.writeFile(path.join(result.projectDir, result.modules.transcript.result_path), 'corrupted');
  await p.start(payload);
  await p.wait('fixture');
  assert.equal(calls.transcript, 2);
  assert.equal(calls.shots, 2);
  fail = 'clips';
  await p.start({ ...payload, module: 'clips', force: true });
  result = await p.wait('fixture');
  assert.equal(result.modules.clips.status, 'failed');
  assert.equal(result.modules.export.status, 'stale');
  assert.equal(result.modules.alignment.status, 'succeeded');
  fail = null;
  await p.start({ ...payload, module: 'clips' });
  assert.equal((await p.wait('fixture')).status, 'partial');
  await p.start(payload);
  assert.equal((await p.wait('fixture')).status, 'completed');
  assert.equal((await createVideoStructurePipeline(opt).status('fixture')).status, 'completed');
  const many = await Promise.allSettled([p.start(payload), p.start(payload)]);
  assert.equal(many.filter((r) => r.status === 'fulfilled').length, 1);
  await p.wait('fixture');
  hold = 'clips';
  await p.start({ ...payload, module: 'clips', force: true });
  while ((await p.status('fixture')).stage !== 'clips') await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  p.cancel('fixture');
  assert.equal((await p.wait('fixture')).status, 'stopped');
  hold = null;
  await p.start(payload);
  result = await p.wait('fixture');
  assert.equal(result.status, 'completed');
  for (const s of MODULES) assert.equal((await fs.readdir(path.join(result.projectDir, 'modules', s.id))).length, 1);
  // Upgrading an existing 8-step project must generate a draft without
  // repeating completed media work, even if runtime settings have changed.
  const beforeDraft = { ...calls };
  let draftCalls = 0,
    draftFailure = false;
  const draftOptions = {
    ...opt,
    createDraft: async (ctx) => {
      draftCalls++;
      if (draftFailure) throw Error('draft failure');
      assert.equal(ctx.projectDir, result.projectDir);
      ctx.onProgress({ progress: 42, message: '生成特效声 2/4' });
      const control = path.join(temp, 'draft_info.json');
      await fs.writeFile(control, 'draft');
      const data = envelope(ctx.taskId, {
        draft_path: temp,
        validated: true,
        control_files: [
          { path: control, sha256: require('node:crypto').createHash('sha256').update('draft').digest('hex') },
        ],
      });
      await atomicJson(path.join(ctx.dir, 'jianying.json'), data);
      return data;
    },
  };
  const withDraft = createVideoStructurePipeline(draftOptions);
  settings = { ...settings, structure_threads: 3 };
  await withDraft.start({ ...payload, module: 'jianying' });
  result = await withDraft.wait('fixture');
  assert.equal(result.status, 'completed');
  assert.equal(result.modules.jianying.summary.draft_path, temp);
  assert.deepEqual(calls, beforeDraft);
  assert.equal(draftCalls, 1);
  assert.equal(
    (await createVideoStructurePipeline(draftOptions).status('fixture')).modules.jianying.status,
    'succeeded',
  );
  draftFailure = true;
  await withDraft.start({ ...payload, module: 'jianying', force: true });
  result = await withDraft.wait('fixture');
  assert.equal(result.status, 'failed');
  assert(MODULES.every((s) => result.modules[s.id].status === 'succeeded'));
  assert.deepEqual(calls, beforeDraft);
  draftFailure = false;
  await withDraft.start({ ...payload, module: 'jianying' });
  result = await withDraft.wait('fixture');
  assert.equal(result.status, 'completed');
  await fs.writeFile(path.join(result.projectDir, result.modules.transcript.result_path), 'tampered');
  await withDraft.start({ ...payload, module: 'jianying', force: true });
  result = await withDraft.wait('fixture');
  assert.equal(result.status, 'failed');
  assert.match(result.error, /结果缺失或已修改/);
  assert.equal(draftCalls, 3);
  // Metadata-only changes during a module must not discard valid output.
  // A same-size content change must still fail, even with mtime restored.
  let sourceMutation = null;
  const integrityHandlers = Object.fromEntries(
    MODULES.map((spec) => [
      spec.id,
      async (ctx) => {
        if (spec.id === 'shots' && sourceMutation) await sourceMutation();
        const data = envelope(ctx.taskId, {
          fixture: spec.id,
          ...(spec.id === 'alignment' ? { algorithm_id: ALIGNMENT_ALGORITHM, boundary_policy: BOUNDARY_POLICY } : {}),
          ...(spec.id === 'export' ? { subtitle_policy: 'voice-segments-v1' } : {}),
        });
        await atomicJson(path.join(ctx.dir, spec.file), data);
        return data;
      },
    ]),
  );
  const integrity = createVideoStructurePipeline({ ...opt, handlers: integrityHandlers });
  const integrityPayload = { ...payload, projectId: 'source-integrity' };
  sourceMutation = async () => {
    const st = await fs.stat(input);
    await fs.chmod(input, st.mode ^ 0o100);
    await fs.utimes(input, st.atime, new Date(st.mtimeMs + 2000));
  };
  await integrity.start(integrityPayload);
  result = await integrity.wait(integrityPayload.projectId);
  assert.equal(result.status, 'completed');
  assert.equal(result.modules.shots.status, 'succeeded');
  sourceMutation = null;
  await integrity.start(integrityPayload);
  result = await integrity.wait(integrityPayload.projectId);
  assert.equal(result.status, 'completed');
  assert(MODULES.every((spec) => result.modules[spec.id].reused));
  sourceMutation = async () => {
    const st = await fs.stat(input);
    await fs.writeFile(input, 'SOURCE');
    await fs.utimes(input, st.atime, st.mtime);
  };
  await integrity.start({ ...integrityPayload, module: 'shots', force: true });
  result = await integrity.wait(integrityPayload.projectId);
  assert.equal(result.status, 'failed');
  assert.equal(result.modules.shots.status, 'failed');
  assert.match(result.error, /SHA-256/);
  assert.equal(result.modules.clips.status, 'stale');
  assert.equal(
    (await fs.readdir(path.join(result.projectDir, 'modules', 'shots'))).some((name) => name.endsWith('.partial')),
    false,
  );
  console.log('PASS source metadata changes, existing-project reuse, and real content-change rejection');
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
