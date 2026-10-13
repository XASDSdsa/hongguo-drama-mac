const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { parseSrt, normalizeSrt, srtToText } = require('../src/native/srt');
const fasterWhisper = require('../src/native/faster-whisper');
const { normalizeEpisodeAnalysis } = require('../src/native/openai');
const { createAnalysisManager } = require('../src/native/analysis-manager');
const { refineAnalysisCutPoints } = require('../src/native/cut-candidates');

(async () => {
  const source = '\ufeff1\n00:00:00,000 --> 00:00:01.234\n第一句\n\n2\n00:00:01,234 --> 00:00:02,000\n第二句\n';
  const entries = parseSrt(source);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].start, 1.234);
  assert.equal(srtToText(source), '第一句\n第二句');
  const normalized = normalizeSrt(source);
  assert.match(normalized, /00:00:01,234 --> 00:00:02,000/);
  assert.equal(parseSrt(normalized).length, 2);

  const analysis = normalizeEpisodeAnalysis({
    summary: '主角在危机中反击。',
    fillers: [{ start: 1, end: 2 }],
    climaxes: [{ start: 3, end: 7, desc: '反转', score: 11 }],
    split_points: [{ time: 10, reason: '场景转换' }, { time: 20 }, { time: 30 }],
    best_hook: { start: 4, end: 9, description: '悬念' },
    arc_end: true,
  });
  assert.equal(Object.hasOwn(analysis, 'fillers'), false);
  assert.deepEqual(Object.keys(analysis), ['summary', 'climaxes', 'split_points', 'best_hook', 'arc_end']);
  assert.equal(analysis.climaxes[0].score, 10);
  assert.equal(analysis.split_points.length, 2);
  const warned = await refineAnalysisCutPoints({ ...analysis, split_points: [{ time: 10, reason: '场景转换' }] }, {});
  assert.equal(warned.split_points[0].boundary_status, 'warn');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hongguo-premium-check-'));
  try {
    const fakeScript = path.join(root, 'fake_faster_whisper.py');
    await fsp.writeFile(fakeScript, `import json, pathlib, sys\nargs=sys.argv[1:]\nif '--probe' in args:\n print(json.dumps({'faster_whisper': True, 'cuda': False}))\n raise SystemExit(0)\nout=pathlib.Path(args[args.index('--output') + 1])\nout.parent.mkdir(parents=True, exist_ok=True)\nout.write_text('1\\n00:00:00,000 --> 00:00:01,000\\n测试字幕\\n\\n', encoding='utf-8')\nprint('PROGRESS 100 完成')\n`, 'utf8');
    const input = path.join(root, 'dedup.mp4');
    const output = path.join(root, 'transcripts', 'dedup.srt');
    await fsp.writeFile(input, Buffer.alloc(120 * 1024, 1));
    const runtime = await fasterWhisper.prepareRuntime({ faster_whisper_script_path: fakeScript, faster_whisper_python_path: process.env.PYTHON || 'python3', faster_whisper_device: 'auto', projectRoot: root });
    assert.equal(runtime.device, 'cpu');
    await fasterWhisper.transcribeToSrt(input, output, runtime);
    assert.equal(srtToText(await fsp.readFile(output, 'utf8')), '测试字幕');

    const analysisRoot = path.join(root, 'analysis');
    const analysisSrt = path.join(root, 'episode.srt');
    await fsp.writeFile(analysisSrt, '1\n00:00:00,000 --> 00:00:01,000\n主角反击。\n\n', 'utf8');
    const states = new Map();
    const episodes = [{ episodeIndex: 1, title: '第一集', seriesTitle: '测试剧', srtPath: analysisSrt, srtFingerprint: `${(await fsp.stat(analysisSrt)).size}:1`, analysisPath: path.join(analysisRoot, 'ep001.json') }];
    global.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '主角反击。', climaxes: [], split_points: [], best_hook: null, arc_end: true }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const manager = createAnalysisManager({
      getSettings: () => ({ ai_base_url: 'https://example.test/v1', ai_api_key: 'test', ai_text_model: 'gpt-5.6', ai_image_model: 'gpt-image-2.5', ai_transcription_model: 'x', ai_concurrency: 1 }),
      getEpisodes: () => episodes,
      getState: () => states.get('s') || { version: 1, episodes: {} },
      saveState: (_sid, value) => states.set('s', value),
    });
    const started = await manager.start({ seriesId: 's' });
    assert.equal(started.success, true);
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (manager.status('s').status === 'completed') break;
    }
    assert.equal(manager.status('s').status, 'completed');
    const savedAnalysis = JSON.parse(await fsp.readFile(episodes[0].analysisPath, 'utf8'));
    assert.equal(savedAnalysis.summary, '主角反击。');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
  console.log('PASS premium editing SRT, schema and faster-whisper adapter');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
