// 端到端：和客户实际用法一样走一遍「原剧 → 重新拆分去重 → 分析（分镜、人声分离、台词）→ 剪映草稿」。
// 全部用打包进软件的真组件（FFmpeg、分析运行库、人声分离、剪映运行时），剧名和文件夹都是中文。
// 以前每一项单独测都通过，连起来在 Windows 上却全部失败（中文路径、时间戳）；这一项就是防这种情况。
// 台词用语音模型自带的中文录音（test_wavs）。没有打包好的组件时跳过；打包机上设 REQUIRE_E2E=1 必须跑。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const quchong = require('../src/native/quchong');
const { runtime } = require('../src/native/video-structure/runtime');
const { createVideoStructurePipeline } = require('../src/native/video-structure/pipeline');
const { createJianyingDraft } = require('../src/native/video-structure/jianying');

const root = path.resolve(__dirname, '..');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe =
  process.env.FFPROBE_PATH || path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace('ffmpeg', 'ffprobe'));
const rt = runtime({});
const target = `${process.platform}-${process.arch}`;
const jianying = path.join(
  root,
  'build',
  'jianying',
  target,
  process.platform === 'win32' ? 'jianying-runtime.exe' : 'jianying-runtime',
);
const speechDir = path.join(rt.models, 'sherpa-onnx-paraformer-zh-small-2024-03-09', 'test_wavs');
const missing = [
  [rt.command, '分析运行库'],
  [rt.binary, '人声分离工具'],
  [jianying, '剪映运行时'],
  [speechDir, '中文录音样本'],
].filter(([file]) => !file || !fs.existsSync(file));
if (missing.length || spawnSync(ffmpeg, ['-version']).status !== 0) {
  const why = missing.map(([, label]) => label).join('、') || 'FFmpeg';
  if (process.env.REQUIRE_E2E === '1') {
    console.error(`端到端检查需要的组件缺失：${why}`);
    process.exit(1);
  }
  console.log(`SKIP draft end-to-end (missing: ${why})`);
  process.exit(0);
}

function ff(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

(async () => {
  const started = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-e2e-'));
  const series = path.join(tmp, '真千金驭夫入局');
  const originals = path.join(series, '原剧');
  fs.mkdirSync(originals, { recursive: true });

  // 1. 一集原片：三个明显不同的镜头（各 6 秒），声音是中文录音接起来。
  const wavs = fs
    .readdirSync(speechDir)
    .filter((name) => name.endsWith('.wav'))
    .sort()
    .map((name) => path.join(speechDir, name));
  assert.ok(wavs.length > 0, 'speech samples exist');
  const voice = path.join(tmp, 'voice.wav');
  ff([
    ...wavs.flatMap((file) => ['-i', file]),
    '-filter_complex',
    `${wavs.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`).join(';')};${wavs.map((_, i) => `[a${i}]`).join('')}concat=n=${wavs.length}:v=0:a=1,apad=whole_dur=18[a]`,
    '-map',
    '[a]',
    '-t',
    '18',
    voice,
  ]);
  const episode = path.join(originals, '真千金驭夫入局_第001集.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=360x640:rate=25:duration=6',
    '-f',
    'lavfi',
    '-i',
    'smptebars=size=360x640:rate=25:duration=6',
    '-t',
    '6',
    '-f',
    'lavfi',
    '-i',
    'mandelbrot=size=360x640:rate=25',
    '-i',
    voice,
    '-filter_complex',
    '[0:v]format=yuv420p[v0];[1:v]format=yuv420p[v1];[2:v]trim=duration=6,format=yuv420p[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '3:a',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-shortest',
    episode,
  ]);

  // 2. 重新拆分去重：和「管理剧集 → 开始处理」同一个处理函数。
  const output = path.join(series, '去重', '真千金驭夫入局_第001集.mp4');
  const options = quchong.validateOptions({ ...quchong.DEFAULTS, encoder: 'cpu', jobs: 1 });
  await quchong.runJob({
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    dst: output,
    segments: [{ src: episode, start: 0.3, duration: 17.4, speed: 1.08 }],
    options,
    opts: options,
    onLog() {},
  });
  assert.ok(fs.existsSync(output), 'dedup output written into 去重');

  // 3. 分析 + 剪映草稿：和软件里 getReconstructionPipeline() 一样的接法。
  let mode = 'simple';
  const records = {};
  const drafts = path.join(series, '剪映草稿');
  const pipeline = createVideoStructurePipeline({
    getSettings: () => ({ structure_threads: 2, isPackaged: false, platform: process.platform, arch: process.arch }),
    getFfmpegPath: () => ffmpeg,
    getFfprobePath: () => ffprobe,
    getConcurrency: () => 1,
    getProjectRecord: (id) => records[id] || null,
    saveProjectRecord: (id, record) => {
      records[id] = record;
    },
    createDraft: (ctx) =>
      createJianyingDraft(ctx, {
        executable: jianying,
        createScript: path.join(
          root,
          'scripts',
          mode === 'simple' ? 'create-jianying-simple-draft.py' : 'create-jianying-draft.py',
        ),
        checkScript: path.join(root, 'scripts', 'check-jianying-draft.py'),
        outputRoot: drafts,
        name: `真千金驭夫入局_第001集-剪映草稿-${mode}`,
        userData: null,
        validate: mode !== 'simple',
      }),
    sendProgress() {},
  });
  const projectId = 'ep-e2e';
  const workRoot = path.join(tmp, '分析工作区');
  await pipeline.start({ inputPath: output, projectId, outputRoot: workRoot, threads: 2 });
  let structure = await pipeline.wait(projectId);
  const failed = Object.entries(structure?.modules || {}).filter(([, item]) => item.status !== 'succeeded');
  assert.equal(
    failed.length,
    0,
    `every step succeeds: ${failed.map(([id, item]) => `${id}: ${String(item.error || item.status).slice(0, 600)}`).join(' / ')}`,
  );
  const read = (id) =>
    JSON.parse(fs.readFileSync(path.join(structure.projectDir, structure.modules[id].result_path), 'utf8'));
  const shots = read('alignment').shots || [];
  assert.ok(shots.length >= 2, `scene changes become shots (got ${shots.length})`);
  const transcript = read('transcript');
  assert.ok(JSON.stringify(transcript).length > 200, 'speech in the episode is recognised into a transcript');

  // 三分轨草稿：音频和画面在同样的镜头处切开。
  const simplePath = structure.modules.jianying.summary.draft_path;
  const simple = JSON.parse(fs.readFileSync(path.join(simplePath, 'draft_info.json'), 'utf8'));
  const byName = Object.fromEntries(simple.tracks.map((track) => [track.name, track]));
  assert.ok(byName['视频'] && byName['音频'] && byName['文案'], '视频 / 音频 / 文案 tracks');
  assert.equal(byName['音频'].segments.length, byName['视频'].segments.length, 'audio cut at every shot');
  assert.ok(fs.existsSync(path.join(simplePath, 'draft-manifest.json')));

  // 多分轨草稿：同一份分析，只重做最后一步，并做完整校验。
  mode = 'multi';
  await pipeline.start({
    inputPath: output,
    projectId,
    outputRoot: workRoot,
    threads: 2,
    module: 'jianying',
    force: true,
  });
  structure = await pipeline.wait(projectId);
  assert.equal(structure.modules.jianying.status, 'succeeded', String(structure.modules.jianying.error || ''));
  const multiPath = structure.modules.jianying.summary.draft_path;
  assert.ok(fs.existsSync(path.join(multiPath, 'draft_info.json')), 'multi-track draft written');
  console.log(
    `PASS end to end on ${process.platform}: 原剧 → 去重 → ${shots.length} 个分镜 → 三分轨 + 多分轨草稿，中文路径，用时 ${Math.round((Date.now() - started) / 1000)} 秒`,
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
