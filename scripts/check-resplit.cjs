// 重新拆分：切点规划（纯计算）+ 真实 FFmpeg 的多片段拼接。没有 ffmpeg 时只跑纯计算部分。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const resplit = require('../src/native/resplit');
const quchong = require('../src/native/quchong');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resplit-'));
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL ' + name + ': ' + e.message);
  }
}
const mk = (name, duration, extra = {}) => ({
  file: `/x/${name}.mp4`,
  duration,
  candidates: [
    { t: 20, score: 1 },
    { t: 50, score: 0.8 },
  ],
  ...extra,
});
const plan = (sources, split = {}, overrides = {}) =>
  resplit.planPieces({ sources, split, speedMin: 1.03, speedMax: 1.21, intro: 0.3, random: () => 0.5, ...overrides });

(async () => {
  await check('split parameters are validated', () => {
    assert.deepEqual(resplit.validateSplit({}), {
      min_len: 30,
      max_len: 65,
      head_trim: 1.1,
      tail_trim: 1.2,
      start_number: 1,
    });
    assert.throws(() => resplit.validateSplit({ min_len: 60, max_len: 60 }), /最长/);
    assert.throws(() => resplit.validateSplit({ head_trim: -1 }), /head_trim/);
    assert.throws(() => resplit.validateSplit({ start_number: 1.5 }), /start_number/);
  });

  await check('cut candidates: shot change inside a pause is best, edges are dropped', () => {
    const found = resplit.cutCandidates(
      {
        pauses: [
          { start: 10, end: 11 },
          { start: 30, end: 30.4 },
          { start: 1.1, end: 1.2 },
        ],
        scenes: [10.5, 40, 50.5],
      },
      1.1,
      60,
    );
    assert.deepEqual(
      found.map((item) => [Number(item.t.toFixed(2)), Number(item.score.toFixed(2))]),
      [
        [10.5, 1],
        [30.2, 0.54],
        [40, 0.55],
        [50.5, 0.55],
      ],
    );
  });

  await check('every new episode lands inside the final-duration range and nothing is lost', () => {
    const sources = Array.from({ length: 10 }, (_, i) => mk('e' + i, 92));
    const { pieces, warnings } = plan(sources);
    assert.deepEqual(warnings, []);
    for (const piece of pieces) {
      assert.ok(piece.finalDuration >= 30 && piece.finalDuration <= 65, `final ${piece.finalDuration}`);
      assert.ok(piece.speed >= 1.03 && piece.speed <= 1.21, `speed ${piece.speed}`);
    }
    const kept = pieces.reduce((sum, piece) => sum + piece.length, 0);
    assert.ok(Math.abs(kept - 10 * (92 - 1.1 - 1.2)) < 0.05, 'whole timeline is used exactly once');
    assert.deepEqual(
      pieces.map((piece) => piece.number),
      pieces.map((_, i) => i + 1),
    );
  });

  await check('head and tail trims are removed from every source', () => {
    const { pieces } = plan([mk('a', 60), mk('b', 60)]);
    const segments = pieces.flatMap((piece) => piece.segments);
    for (const file of ['/x/a.mp4', '/x/b.mp4']) {
      const own = segments.filter((segment) => segment.file === file);
      assert.ok(Math.min(...own.map((s) => s.start)) >= 1.1 - 1e-6);
      assert.ok(Math.max(...own.map((s) => s.start + s.duration)) <= 60 - 1.2 + 1e-6);
    }
  });

  await check('a piece may span two source episodes, in order', () => {
    const { pieces } = plan([mk('a', 40, { candidates: [] }), mk('b', 40, { candidates: [] })], {
      min_len: 50,
      max_len: 60,
    });
    assert.ok(pieces.some((piece) => piece.segments.length === 2));
    const two = pieces.find((piece) => piece.segments.length === 2);
    assert.deepEqual(
      two.segments.map((segment) => segment.file),
      ['/x/a.mp4', '/x/b.mp4'],
    );
  });

  await check('a missing-episode junction is preferred as the cut position', () => {
    const sources = [mk('a', 70, { candidates: [] }), mk('b', 70, { candidates: [], gapBefore: true })];
    const { pieces } = plan(sources, { min_len: 30, max_len: 65 });
    const junction = 70 - 1.1 - 1.2;
    let at = 0;
    const cuts = pieces.map((piece) => (at += piece.length));
    assert.ok(
      cuts.some((cut) => Math.abs(cut - junction) < 0.01),
      `cuts ${cuts}`,
    );
  });

  await check('too little content makes one episode and says so; tiny sources are skipped', () => {
    const short = plan([mk('a', 30, { candidates: [] })]);
    assert.equal(short.pieces.length, 1);
    assert.ok(short.warnings.length >= 1);
    const skipped = plan([mk('a', 2), mk('b', 70, { candidates: [] })]);
    assert.ok(skipped.warnings.some((text) => /不足 1 秒/.test(text)));
    assert.equal(plan([mk('a', 2)]).pieces.length, 0);
  });

  await check('numbering starts where asked', () => {
    const { pieces } = plan([mk('a', 200, { candidates: [] })], { start_number: 21 });
    assert.equal(pieces[0].number, 21);
  });

  let haveFfmpeg = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch (_) {
    haveFfmpeg = false;
  }
  if (!haveFfmpeg) console.log('SKIP real ffmpeg checks (ffmpeg not found)');
  else {
    const episode = (name) => {
      const file = path.join(tmp, name);
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=270x480:rate=25:duration=12',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-af',
        "volume=enable='between(t,5,6.5)':volume=0",
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        file,
      ]);
      return file;
    };
    const a = episode('a.mp4'),
      b = episode('b.mp4');

    await check('real ffmpeg: pauses are found and cached', async () => {
      const found = await resplit.analyzeSources({
        ffmpegPath: 'ffmpeg',
        files: [a],
        cacheDir: path.join(tmp, 'cache'),
      });
      const pauses = found.get(a).pauses;
      assert.equal(pauses.length, 1);
      assert.ok(Math.abs(pauses[0].start - 5) < 0.1 && Math.abs(pauses[0].end - 6.5) < 0.1, JSON.stringify(pauses));
      assert.equal(fs.readdirSync(path.join(tmp, 'cache')).length, 1);
      const again = await resplit.analyzeSources({
        ffmpegPath: 'ffmpeg',
        files: [a],
        cacheDir: path.join(tmp, 'cache'),
      });
      assert.deepEqual(again.get(a), found.get(a));
    });

    await check('real ffmpeg: a piece cut from two episodes is joined, sped up by the planned factor', async () => {
      const dst = path.join(tmp, 'out', 'piece.mp4');
      const options = { ...quchong.DEFAULTS, encoder: 'cpu', black_intro: false };
      // 第一集 8–12 秒（4 秒）+ 第二集 0–6 秒（6 秒）= 10 秒，变速 1.25 倍 => 8 秒。
      await quchong.runJob({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        src: a,
        dst,
        segments: [
          { src: a, start: 8, duration: 4 },
          { src: b, start: 0, duration: 6 },
        ],
        speed: 1.25,
        opts: options,
      });
      const probe = JSON.parse(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,width,height,duration:format=duration',
          '-of',
          'json',
          dst,
        ]),
      );
      const kinds = probe.streams.map((stream) => stream.codec_type).sort();
      assert.deepEqual(kinds, ['audio', 'video']);
      const video = probe.streams.find((stream) => stream.codec_type === 'video');
      assert.equal(video.width, 270, 'joined pieces keep the source resolution');
      assert.equal(video.height, 480);
      assert.ok(Math.abs(Number(probe.format.duration) - 8) < 0.5, `duration ${probe.format.duration}`);
    });

    await check('real ffmpeg: one segment with a fixed speed trims exactly', async () => {
      const dst = path.join(tmp, 'out', 'single.mp4');
      await quchong.runJob({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        src: a,
        dst,
        segments: [{ src: a, start: 2, duration: 5 }],
        speed: 1,
        opts: { ...quchong.DEFAULTS, encoder: 'cpu', black_intro: false },
      });
      const duration = Number(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=nw=1:nk=1',
          dst,
        ]).toString(),
      );
      assert.ok(Math.abs(duration - 5) < 0.4, `duration ${duration}`);
    });

    await check('segments with bad times or an invalid speed are rejected before encoding', async () => {
      const base = {
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        src: a,
        dst: path.join(tmp, 'out', 'bad.mp4'),
        opts: quchong.DEFAULTS,
      };
      await assert.rejects(quchong.runJob({ ...base, segments: [{ src: a, start: -1, duration: 3 }] }), /片段时间无效/);
      await assert.rejects(quchong.runJob({ ...base, segments: [{ src: a, start: 0, duration: 0 }] }), /片段时间无效/);
      await assert.rejects(
        quchong.runJob({ ...base, segments: [{ src: a, start: 0, duration: 3 }], speed: 5 }),
        /变速倍数无效/,
      );
    });
  }

  if (failures) process.exitCode = 1;
})().finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
