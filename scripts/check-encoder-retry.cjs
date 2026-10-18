// 硬件编码器偶尔初始化失败：同一个编码器自动重试；必然失败的不重试；失败原因要能在日志里看到。
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const quchong = require('../src/native/quchong');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-retry-'));
const source = path.join(tmp, 'source.mp4');
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=320x180:rate=24:duration=2',
  '-f',
  'lavfi',
  '-i',
  'sine=duration=2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-shortest',
  source,
]);

// 假的 ffmpeg：前 N 次直接失败（退出码 234，和现场一样），之后把 h264_videotoolbox 换成 libx264 交给真的 ffmpeg。
function fakeFfmpeg(name, failures, message) {
  const counter = path.join(tmp, name + '.count');
  fs.writeFileSync(counter, '0');
  const file = path.join(tmp, name);
  fs.writeFileSync(
    file,
    `#!/bin/bash
n=$(cat "${counter}"); echo $((n+1)) > "${counter}"
if [ "$n" -lt ${failures} ]; then
  echo "Input #0, mov,mp4, from 'a.mp4':" >&2
  echo "  Metadata:" >&2
  echo "    comment         : vid:abc" >&2
  echo "${message}" >&2
  exit 234
fi
args=(); for a in "$@"; do [ "$a" = h264_videotoolbox ] && a=libx264; args+=("$a"); done
exec ffmpeg "\${args[@]}"
`,
    { mode: 0o755 },
  );
  return { file, count: () => Number(fs.readFileSync(counter, 'utf8')) };
}

async function run(ffmpegPath, dst, encoder = 'videotoolbox') {
  const logs = [];
  const promise = quchong.runJob({
    ffmpegPath,
    ffprobePath: 'ffprobe',
    src: source,
    dst,
    opts: { ...quchong.DEFAULTS, encoder },
    onLog: (line) => logs.push(String(line)),
  });
  return { promise, logs };
}

(async () => {
  quchong.ENCODER_RETRY_DELAYS.splice(0, quchong.ENCODER_RETRY_DELAYS.length, 5, 5);
  const check = async (name, fn) => {
    await fn();
    console.log('PASS ' + name);
  };

  await check('a transient hardware-encoder failure is retried with the same encoder and then succeeds', async () => {
    const fake = fakeFfmpeg('flaky', 2, 'Error initializing output stream 0:0 -- Error while opening encoder');
    const { promise, logs } = await run(fake.file, path.join(tmp, 'ok.mp4'));
    const result = await promise;
    assert.equal(fake.count(), 3);
    assert.ok(fs.statSync(result.path).size > 0);
    assert.equal(logs.filter((l) => l.startsWith('[重试]')).length, 2);
    assert.match(
      logs.find((l) => l.startsWith('[重试]')),
      /videotoolbox/,
    );
    assert.match(
      logs.find((l) => l.startsWith('[重试]')),
      /Error initializing output stream/,
    );
  });

  await check('after the retries are used up the real reason comes first, not the input file metadata', async () => {
    const fake = fakeFfmpeg(
      'broken',
      99,
      'Error while opening encoder for output stream #0:0 - maybe incorrect parameters',
    );
    const { promise } = await run(fake.file, path.join(tmp, 'bad.mp4'));
    await assert.rejects(promise, (error) => {
      assert.equal(fake.count(), 3, '1 次 + 重试 2 次');
      const head = error.message.split('\n')[0];
      assert.match(head, /videotoolbox 编码失败（已重试 2 次），未自动切换编码器/);
      assert.match(head, /原因：.*Error while opening encoder/);
      assert.doesNotMatch(head, /Metadata|vid:abc/);
      assert.match(error.message, /ffmpeg 退出码 234/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(tmp, 'bad.mp4')), false);
  });

  await check('the software encoder is not retried (a failure there is not a session race)', async () => {
    const fake = fakeFfmpeg('cpu', 99, 'Error: bad filter');
    const { promise } = await run(fake.file, path.join(tmp, 'cpu.mp4'), 'cpu');
    await assert.rejects(promise, /ffmpeg 退出码 234/);
    assert.equal(fake.count(), 1);
  });

  await check('keyDiagnostics skips the input header and keeps the last error lines', () => {
    const text =
      'ffmpeg 退出码 234\nInput #0, mov\n  Duration: 00:00:53.57\n  Stream #0:0: Video: h264\nfoo\nError reinitializing filters!\nFailed to inject frame into filter network: Invalid argument\nError while filtering: Invalid argument';
    const line = quchong.keyDiagnostics(text);
    assert.match(line, /Invalid argument/);
    assert.doesNotMatch(line, /Duration|Stream #/);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
