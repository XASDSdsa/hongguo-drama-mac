// Windows 上的人声分离工具读不了带中文的路径（它把参数当 UTF-8，中文 Windows 给的是 GBK）。
// 路径里有中文时，模型、输入、输出都要先放到纯英文路径的临时文件夹里，做完再挪回来。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const speech = require('../src/native/video-structure/speech');
const { toolError } = require('../src/native/video-structure/io');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe =
  process.env.FFPROBE_PATH || path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace('ffmpeg', 'ffprobe'));
if (process.platform === 'win32' || spawnSync(ffmpeg, ['-version']).status !== 0) {
  console.log('SKIP separation ascii (needs a POSIX shell and ffmpeg)');
  process.exit(0);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sep-ascii-'));
  const install = path.join(tmp, 'AI短剧助手', 'resources');
  const work = path.join(tmp, '剧', '真千金驭夫入局_第001集-a7d1e5ba', 'modules', 'separation');
  const audioDir = path.join(tmp, '剧', '真千金驭夫入局_第001集-a7d1e5ba', 'modules', 'audio');
  const asciiRoot = path.join(tmp, 'ascii-root');
  for (const dir of [install, work, audioDir, asciiRoot]) fs.mkdirSync(dir, { recursive: true });
  const model = path.join(install, 'UVR-MDX-NET-Inst_HQ_3.onnx');
  fs.writeFileSync(model, Buffer.alloc(4096, 7));
  const wav = path.join(audioDir, 'audio.wav');
  const made = spawnSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=300:duration=2:sample_rate=44100',
    '-ac',
    '2',
    wav,
  ]);
  assert.equal(made.status, 0, String(made.stderr));

  // 假的分离工具：收到任何非英文字符的路径就照真工具的样子失败（退出码 -1）；否则把输入抄成两条输出。
  const tool = path.join(tmp, 'sherpa-onnx-offline-source-separation');
  const argsLog = path.join(tmp, 'args.log');
  fs.writeFileSync(
    tool,
    [
      '#!/bin/bash',
      `printf '%s\\n' "$@" > "${argsLog}"`,
      'for a in "$@"; do',
      '  if printf \'%s\' "$a" | LC_ALL=C grep -q \'[^ -~]\'; then echo "Filename \'$a\' does not exist" >&2; echo "Failed to read" >&2; exit 255; fi',
      'done',
      'for a in "$@"; do case "$a" in --input-wav=*) IN="${a#*=}";; --output-vocals-wav=*) V="${a#*=}";; --output-accompaniment-wav=*) A="${a#*=}";; --uvr-model=*) M="${a#*=}";; esac; done',
      '[ -f "$M" ] || { echo "model missing" >&2; exit 255; }',
      'echo Started >&2; cp "$IN" "$V"; cp "$IN" "$A"; echo Done >&2',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
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
  const ctx = (platform) => ({
    taskId: 'ep-test',
    dir: work,
    ffprobe,
    platform,
    asciiRoot,
    params: { binary: tool, threads: 2, provider: 'cpu', model, model_id: 'uvr' },
    onProgress() {},
  });

  // 1. 「Windows」：工具只看到英文路径，结果照样落在原来的（中文）文件夹里，临时文件清掉。
  const result = await speech.separation(ctx('win32'), audio, audioDir);
  const seen = fs.readFileSync(argsLog, 'utf8');
  assert.ok(speech.isAscii(seen), `the tool only got ASCII paths:\n${seen}`);
  for (const name of ['vocals.wav', 'background.wav']) assert.ok(fs.existsSync(path.join(work, name)), name);
  assert.equal(result.tracks.vocals.path, 'vocals.wav');
  const left = fs.readdirSync(asciiRoot);
  assert.deepEqual(left, ['models'], 'the per-run staging folder is removed; only the reusable model copy stays');
  assert.ok(fs.existsSync(path.join(asciiRoot, 'models', 'UVR-MDX-NET-Inst_HQ_3.onnx')));
  console.log('PASS Windows with Chinese paths: the separation tool only sees ASCII paths, results land in place');

  // 2. 第二次：模型不再重新放（还是同一个文件）。
  const before = fs.statSync(path.join(asciiRoot, 'models', 'UVR-MDX-NET-Inst_HQ_3.onnx')).ino;
  await speech.separation(ctx('win32'), audio, audioDir);
  assert.equal(fs.statSync(path.join(asciiRoot, 'models', 'UVR-MDX-NET-Inst_HQ_3.onnx')).ino, before);
  console.log('PASS the model copy is reused on the next episode');

  // 3. 不是 Windows：原样把路径交给工具（这时假工具会因为中文路径失败，正说明没有绕路）。
  await assert.rejects(speech.separation(ctx('darwin'), audio, audioDir), (error) => {
    assert.match(error.message, /退出码 255：/);
    assert.match(error.message.split('\n')[0], /does not exist \| Failed to read/, 'the real error comes first');
    return true;
  });
  console.log('PASS other systems pass paths unchanged; tool errors put the real reason first');

  // 4. 工具报错：最后几行放前面，Windows 的 4294967295 显示成 -1。
  const error = toolError(
    'C:/x/tool.exe',
    4294967295,
    "cmd 'a' 'b'\nconfig(...)\nFilename 'x' does not exist\nFailed to read 'x'\n",
  );
  assert.equal(error.exitCode, -1);
  assert.match(
    error.message,
    /^tool\.exe 退出码 -1：config\(\.\.\.\) \| Filename 'x' does not exist \| Failed to read 'x'/,
  );
  console.log('PASS tool errors lead with their last lines');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
