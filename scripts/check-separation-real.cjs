// 用打包进软件的真人声分离工具和模型，跑一段放在中文文件夹里的音频（和用户的剧集一样）。
// Windows 上这一步以前必失败：工具把路径当 UTF-8，中文 Windows 传的是 GBK，说文件不存在、退出码 -1。
// 没有打包好的运行库时跳过（只在云端打包机上跑）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const speech = require('../src/native/video-structure/speech');
const { runtime } = require('../src/native/video-structure/runtime');

const rt = runtime({});
const model = path.join(rt.models, 'UVR-MDX-NET-Inst_HQ_3.onnx');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe =
  process.env.FFPROBE_PATH || path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace('ffmpeg', 'ffprobe'));
if (!fs.existsSync(rt.binary) || !fs.existsSync(model) || spawnSync(ffmpeg, ['-version']).status !== 0) {
  if (process.env.REQUIRE_STRUCTURE_RUNTIME === '1') {
    console.error(`the bundled separation tool or model is missing: ${rt.binary}`);
    process.exit(1);
  }
  console.log('SKIP real separation (bundled runtime not built here)');
  process.exit(0);
}

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sep-real-'));
  const project = path.join(base, '真千金驭夫入局_第001集-a7d1e5ba');
  const audioDir = path.join(project, 'modules', 'audio');
  const dir = path.join(project, 'modules', 'separation');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(audioDir, 'audio.wav');
  const made = spawnSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=3:sample_rate=44100',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    wav,
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  const info = JSON.parse(
    spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', wav]).stdout.toString(),
  );
  const audio = {
    path: 'audio.wav',
    sample_rate: Number(info.streams[0].sample_rate),
    duration: Number(info.format.duration),
    offset: 0,
    mapping: 'identity',
  };
  const started = Date.now();
  const result = await speech.separation(
    {
      taskId: 'ep-real',
      dir,
      ffprobe,
      params: { binary: rt.binary, threads: 2, provider: 'cpu', model, model_id: 'sherpa-onnx/UVR-MDX-NET-Inst_HQ_3' },
      onProgress() {},
    },
    audio,
    audioDir,
  );
  for (const name of ['vocals', 'background']) {
    assert.ok(fs.existsSync(path.join(dir, `${name}.wav`)), `${name}.wav was written into the Chinese-named folder`);
    assert.equal(result.tracks[name].sample_rate, audio.sample_rate);
  }
  console.log(
    `PASS real separation on ${process.platform} with a Chinese folder name: both tracks written in ${Math.round((Date.now() - started) / 1000)} s`,
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
