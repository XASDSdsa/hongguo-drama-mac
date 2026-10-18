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
  resplit.planPieces({ sources, split, speedMin: 1.03, speedMax: 1.21, random: () => 0.5, ...overrides });

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
      for (const segment of piece.segments)
        assert.ok(segment.speed >= 1.03 && segment.speed <= 1.21, `speed ${segment.speed}`);
      // 成品时长就是切出来的长度：每段原片秒数 ÷ 自己的倍数，加起来。
      const made = piece.segments.reduce((sum, segment) => sum + segment.duration / segment.speed, 0);
      assert.ok(Math.abs(made - piece.finalDuration) < 0.05, `${made} vs ${piece.finalDuration}`);
    }
    const kept = pieces.reduce((sum, piece) => sum + piece.length, 0);
    assert.ok(Math.abs(kept - (10 * (92 - 1.1 - 1.2)) / 1.12) < 0.05, 'whole timeline is used exactly once');
    assert.deepEqual(
      pieces.map((piece) => piece.number),
      pieces.map((_, i) => i + 1),
    );
  });

  await check(
    'every original episode gets its own random speed inside the range, and a piece spanning two keeps both',
    () => {
      const values = [0, 0.25, 0.5, 0.75, 1];
      let at = 0;
      const random = () => values[at++ % values.length];
      const { pieces } = plan(
        Array.from({ length: 5 }, (_, i) => mk('e' + i, 40, { candidates: [] })),
        { min_len: 50, max_len: 60 },
        { random },
      );
      const speeds = new Map();
      for (const segment of pieces.flatMap((piece) => piece.segments)) {
        assert.ok(segment.speed >= 1.03 && segment.speed <= 1.21);
        assert.ok(!speeds.has(segment.file) || speeds.get(segment.file) === segment.speed, 'one episode, one speed');
        speeds.set(segment.file, segment.speed);
      }
      assert.equal(new Set(speeds.values()).size, 5, '每个原集各取一个');
      assert.equal(speeds.get('/x/e0.mp4'), 1.03);
      assert.equal(speeds.get('/x/e4.mp4'), 1.21);
      const mixed = pieces.find((piece) => new Set(piece.segments.map((segment) => segment.speed)).size > 1);
      assert.ok(mixed, '有一集跨了两个原集，前后两段倍数不同');
    },
  );

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
    const junction = (70 - 1.1 - 1.2) / 1.12; // 变速后的时间线上，第一个原集占的长度
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

  await check('a small leftover at the end is merged into the last episode instead of being forced into range', () => {
    const slack = 30 * resplit.TAIL_ABSORB_RATIO;
    let absorbed = 0;
    for (let total = 40; total <= 700; total += 7) {
      // 随机数固定取中间，倍数 1.12：要让变速后的总长正好是 total，原片要 total × 1.12 秒。
      const { pieces, tailAbsorbed } = plan([mk('a', total * 1.12 + 2.3, { candidates: [] })]);
      const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
      assert.ok(Math.abs(length - total) < 0.05, `${total}: every second is used, got ${length}`);
      assert.ok(tailAbsorbed >= 0 && tailAbsorbed <= slack + 0.01, `${total}: leftover ${tailAbsorbed}`);
      pieces.slice(0, -1).forEach((piece) => {
        assert.ok(piece.finalDuration >= 30 && piece.finalDuration <= 65, `${total}: middle ${piece.finalDuration}`);
      });
      const last = pieces[pieces.length - 1];
      assert.ok(last.finalDuration >= 30 || pieces.length === 1, `${total}: last ${last.finalDuration}`);
      // 最后一集最多比最长时长多出那一点零头。
      assert.ok(last.finalDuration <= 65 + tailAbsorbed + 0.5, `${total}: last ${last.finalDuration}`);
      if (tailAbsorbed > 0) absorbed += 1;
    }
    assert.ok(absorbed > 0, 'the leftover rule is actually used');
  });

  await check('estimate: how many episodes the selected content makes before any analysis', () => {
    const sources = Array.from({ length: 80 }, (_, i) => ({ file: `/x/${i}.mp4`, duration: 92 }));
    const estimate = resplit.estimatePlan({ sources, split: {}, speedMin: 1.03, speedMax: 1.21 });
    assert.equal(estimate.usedSources, 80);
    assert.ok(Math.abs(estimate.totalSeconds - 80 * (92 - 1.1 - 1.2)) < 0.2);
    assert.ok(estimate.minCount <= estimate.count && estimate.count <= estimate.maxCount);
    // 和真正的规划（有切点）比，差距在两成以内。
    const real = plan(
      sources.map((source) => ({
        ...source,
        candidates: Array.from({ length: 12 }, (_, k) => ({ t: 5 + k * 7, score: k % 3 ? 0.55 : 1 })),
      })),
    );
    assert.ok(
      Math.abs(real.pieces.length - estimate.count) / real.pieces.length < 0.2,
      `${real.pieces.length} vs ${estimate.count}`,
    );
    // 内容越少集数越少；不够一集也至少是 1 集。
    const fewer = resplit.estimatePlan({
      sources: sources.slice(0, 10),
      split: {},
      speedMin: 1.03,
      speedMax: 1.21,
    });
    assert.ok(fewer.count < estimate.count);
    assert.equal(
      resplit.estimatePlan({ sources: [{ file: 'a', duration: 20 }], split: {}, speedMin: 1, speedMax: 1.2 }).count,
      1,
    );
    assert.equal(resplit.estimatePlan({ sources: [], split: {}, speedMin: 1, speedMax: 1.2 }).count, 0);
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

    const durationOf = (file) =>
      Number(
        execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
          .toString()
          .trim(),
      );
    const leftovers = () => fs.readdirSync(path.join(tmp, 'out')).filter((name) => name.startsWith('.hongguo'));

    await check('real ffmpeg: each segment keeps its own speed, then the whole piece is re-encoded once', async () => {
      const dst = path.join(tmp, 'out', 'piece.mp4');
      const options = { ...quchong.DEFAULTS, encoder: 'cpu' };
      const logs = [];
      // 第一集 8–12 秒（4 秒，1.25 倍 => 3.2 秒）+ 第二集 0–6 秒（6 秒，1.5 倍 => 4 秒）= 7.2 秒。
      await quchong.runJob({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        src: a,
        dst,
        segments: [
          { src: a, start: 8, duration: 4, speed: 1.25 },
          { src: b, start: 0, duration: 6, speed: 1.5 },
        ],
        opts: options,
        onLog: (line) => logs.push(String(line)),
      });
      const probe = JSON.parse(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name,width,height,duration:format=duration',
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
      assert.equal(probe.streams.find((stream) => stream.codec_type === 'audio').codec_name, 'aac');
      assert.ok(Math.abs(Number(probe.format.duration) - 7.2) < 0.5, `duration ${probe.format.duration}`);
      assert.ok(logs.some((line) => line.startsWith('[合并]')));
      // 去重编码那一步面对的是合并后的中间文件，倍数固定 1：参数里的 SPEED 必须是 1。
      assert.match(
        logs.find((line) => line.startsWith('[开始]')),
        /"SPEED":1[,}]/,
      );
      assert.deepEqual(leftovers(), [], '成品写好后中间文件必须删掉');
    });

    await check(
      'real ffmpeg: the pre-dedup file is cut and merged first, then dedup encoding reads that one file',
      async () => {
        const dst = path.join(tmp, 'out', 'order.mp4');
        const spy = path.join(tmp, 'spy.sh');
        fs.writeFileSync(spy, `#!/bin/bash\necho "$*" >> "${path.join(tmp, 'calls.log')}"\nexec ffmpeg "$@"\n`, {
          mode: 0o755,
        });
        await quchong.runJob({
          ffmpegPath: spy,
          ffprobePath: 'ffprobe',
          src: a,
          dst,
          segments: [
            { src: a, start: 1, duration: 3, speed: 1.2 },
            { src: b, start: 2, duration: 3, speed: 1.1 },
          ],
          opts: { ...quchong.DEFAULTS, encoder: 'cpu' },
        });
        const calls = fs.readFileSync(path.join(tmp, 'calls.log'), 'utf8').trim().split('\n');
        assert.ok(calls.length >= 2);
        assert.match(calls[0], /atempo=1\.2/, '第一步：按各自倍数变速并合并');
        assert.match(calls[0], /concat=n=2/);
        assert.doesNotMatch(calls[0], /unsharp|hue=|rotate=/, '第一步不加任何去重特效');
        assert.match(calls[0], /\.mkv/);
        assert.match(calls[1], /unsharp/, '第二步：统一加去重特效');
        assert.doesNotMatch(calls[1], /concat/);
        assert.match(calls[1], /\.hongguo-quchong-pre-.*\.mkv/, '第二步读的是中间文件');
      },
    );

    await check('real ffmpeg: one segment at speed 1 trims exactly', async () => {
      const dst = path.join(tmp, 'out', 'single.mp4');
      await quchong.runJob({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        src: a,
        dst,
        segments: [{ src: a, start: 2, duration: 5 }],
        opts: { ...quchong.DEFAULTS, encoder: 'cpu' },
      });
      const duration = durationOf(dst);
      assert.ok(Math.abs(duration - 5) < 0.4, `duration ${duration}`);
      assert.deepEqual(leftovers(), []);
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
        quchong.runJob({ ...base, segments: [{ src: a, start: 0, duration: 3, speed: 5 }] }),
        /变速倍数无效/,
      );
    });
  }

  if (failures) process.exitCode = 1;
})().finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
