const assert = require('node:assert/strict');
const { BREATH_GAP_SECONDS, SHOT_ON_BREATH_SECONDS, EDGE_GUARD_SECONDS, decideShotCuts } = require('../src/native/cut-point-refiner');
const { GAP_MEASURE_SECONDS, measurementsFromLogs, refineAnalysisCutPoints } = require('../src/native/cut-candidates');

function verdict(points) {
  return points.length ? `切 ${points.map(item => item.time).join('、')} 秒` : '不切';
}

async function runCase(name, input) {
  const analysis = {
    summary: '',
    climaxes: [],
    split_points: input.modelPoints || [],
    best_hook: null,
    arc_end: false,
  };
  const saved = await refineAnalysisCutPoints(analysis, {
    shots: input.shots,
    speech: input.speech,
    duration: input.duration,
  });
  const direct = decideShotCuts(input);
  assert.deepEqual(saved.split_points.map(item => item.time), direct.map(item => item.time));
  assert.deepEqual(saved.split_points.map(item => item.boundary_source), direct.map(() => 'shot+breath'));
  console.log(`${name}\n  输入：${input.detail}\n  结果：${verdict(saved.split_points)}`);
  return saved.split_points;
}

(async () => {
  console.log(`气口至少 ${BREATH_GAP_SECONDS} 秒（含）才算换气；切镜距气口边缘不超过 ${SHOT_ON_BREATH_SECONDS} 秒才算落在这刀上；片头片尾 ${EDGE_GUARD_SECONDS} 秒内的切镜丢掉。测量静音下限 ${GAP_MEASURE_SECONDS} 秒，只用于量出空隙，本身不切断。`);

  const unfinished = await runCase('1. 你听我｜画面切了但没换气', {
    duration: 8,
    speech: [{ start: 1.0, end: 3.2, text: '你听我把话说完' }],
    shots: [2.1],
    modelPoints: [{ time: 2.1, reason: '话题转换' }],
    detail: '语音 1.0–3.2 秒连成一口气（文本「你听我把话说完」，带了句号也不读）；切镜 2.1 秒；模型还报了 2.1 秒的话题点',
  });
  assert.deepEqual(unfinished, []);

  const breathed = await runCase('2. 你听我说完。｜换气并且画面切了', {
    duration: 8,
    speech: [{ start: 1.0, end: 2.4, text: '你听我说完。' }, { start: 2.9, end: 4.2, text: '我们走吧' }],
    shots: [2.6],
    modelPoints: [],
    detail: '语音 1.0–2.4 秒「你听我说完。」，气口 2.4–2.9 秒（0.5 秒），下一句 2.9–4.2 秒；切镜 2.6 秒落在气口里；模型没有报切点',
  });
  assert.equal(breathed.length, 1);
  assert.equal(breathed[0].time, 2.6);
  assert.equal(breathed[0].boundary_source, 'shot+breath');

  const breathOnly = await runCase('3. 有气口，画面没切', {
    duration: 8,
    speech: [{ start: 1.0, end: 2.2, text: '你听我说完。' }, { start: 2.7, end: 4.0, text: '我们走吧' }],
    shots: [],
    detail: '气口 2.2–2.7 秒（0.5 秒）；没有任何切镜',
  });
  assert.deepEqual(breathOnly, []);

  const manyShots = await runCase('4. 一口气里连续多个切镜', {
    duration: 8,
    speech: [{ start: 0.5, end: 5.5, text: '你听我把这整句话说完不要停' }],
    shots: [1.5, 2.8, 4.1],
    detail: '语音 0.5–5.5 秒同一口气；切镜 1.5、2.8、4.1 秒都落在这口气里面',
  });
  assert.deepEqual(manyShots, []);

  const misaligned = await runCase('5. 气口和切镜错开', {
    duration: 8,
    speech: [{ start: 1.0, end: 2.3, text: '你听我说完。' }, { start: 2.8, end: 5.0, text: '后面这句还在说' }],
    shots: [3.6],
    detail: '气口 2.3–2.8 秒；切镜 3.6 秒，落在下一口气里，距气口结束 0.8 秒',
  });
  assert.deepEqual(misaligned, []);

  const shortGap = await runCase('6. 空隙短于气口门槛', {
    duration: 8,
    speech: [{ start: 1.0, end: 2.0, text: '你听我' }, { start: 2.12, end: 3.2, text: '把话说完' }],
    shots: [2.06],
    detail: '两段语音之间只有 0.12 秒，短于 0.18 秒；切镜 2.06 秒落在这个短空隙上',
  });
  assert.deepEqual(shortGap, []);

  const silent = await runCase('7. 空语音', {
    duration: 8,
    speech: [],
    shots: [1.2, 3.4, 6.0],
    detail: '没有语音；切镜 1.2、3.4、6.0 秒',
  });
  assert.deepEqual(silent, []);

  const edges = await runCase('8. 切在片头片尾', {
    duration: 8,
    speech: [
      { start: 0, end: 0.005 },
      { start: 0.3, end: 1.0 },
      { start: 1.5, end: 3.0 },
    ],
    shots: [0, 0.02, 1.2, 7.97, 8],
    detail: '气口 0.005–0.3 秒和 1.0–1.5 秒；切镜 0、0.02 秒贴片头，1.2 秒落在第二个气口，7.97 秒和 8 秒贴片尾',
  });
  assert.deepEqual(edges.map(item => item.time), [1.2]);

  const fromLog = measurementsFromLogs(
    [
      'Duration: 00:00:08.00, start: 0.000000, bitrate: 128 kb/s',
      'Stream #0:0(und): Audio: aac',
      '[silencedetect @ 1] silence_start: 2.4',
      '[silencedetect @ 1] silence_end: 2.9 | silence_duration: 0.5',
    ].join('\n'),
    [
      'Duration: 00:00:08.00, start: 0.000000, bitrate: 2000 kb/s',
      '[Parsed_showinfo_1 @ 1] n:   0 pts:  78000 pts_time:2.6',
    ].join('\n'),
  );
  const logged = await refineAnalysisCutPoints({
    summary: '日志',
    split_points: [{ time: 4, reason: '话题转换' }],
  }, fromLog);
  console.log('9. 扫描日志走到同一条切断\n  输入：时长 8 秒，静音 2.4–2.9 秒，切镜 pts_time 2.6 秒；模型话题点 4 秒\n  结果：' + verdict(logged.split_points));
  assert.deepEqual(logged.split_points.map(item => item.time), [2.6]);
  assert.equal(fromLog.speech.length, 2);
  assert.equal(fromLog.speech[0].end, 2.4);
  assert.equal(fromLog.speech[1].start, 2.9);

  const noAudio = measurementsFromLogs(
    'Duration: 00:00:08.00\nStream #0:0: Video: h264\n',
    'Duration: 00:00:08.00\n[Parsed_showinfo_1 @ 1] pts_time:3.0\n',
  );
  assert.deepEqual(decideShotCuts(noAudio), []);
  console.log('10. 日志里没有音轨\n  输入：时长 8 秒，只有视频流，切镜 3.0 秒\n  结果：不切');

  console.log('PASS 切镜落在气口上才切断');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
