// 分析切点时镜头切换检测用显卡解码（-hwaccel auto）；显卡解码失败就用 CPU 再做一遍，切点一个不少。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectScenes } = require('../src/native/resplit');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
if (spawnSync(ffmpeg, ['-version']).status !== 0) {
  console.log('SKIP scene hwaccel (no ffmpeg)');
  process.exit(0);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-hw-'));
  const clip = path.join(tmp, '原剧_第001集.mp4');
  // 三个完全不同的画面拼起来：2 秒、4 秒处各有一次镜头切换。
  const made = spawnSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=640x360:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'color=c=blue:size=640x360:rate=25:duration=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[v]', '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
  ]);
  assert.equal(made.status, 0, String(made.stderr));

  const cpu = await detectScenes(ffmpeg, clip, null, { hwaccel: false });
  const hw = await detectScenes(ffmpeg, clip, null);
  const near = (list, t) => list.some((x) => Math.abs(x - t) < 0.1);
  assert.ok(near(cpu, 2) && near(cpu, 4), `CPU finds both cuts: ${cpu}`);
  assert.deepEqual(hw, cpu, 'hardware decoding (or its automatic fallback) finds the same cuts');
  console.log(`PASS scene detection with -hwaccel auto finds the same cuts as CPU decoding (${cpu.map((t) => t.toFixed(2)).join(', ')} s)`);

  if (process.platform === 'win32') return console.log('SKIP fallback check on Windows (needs a POSIX shell)');
  // 显卡解码失败：假 FFmpeg 只要看到 -hwaccel 就报错退出。应自动改用 CPU，结果一样。
  const fake = path.join(tmp, 'ffmpeg-no-hw');
  const calls = path.join(tmp, 'calls.log');
  fs.writeFileSync(
    fake,
    `#!/bin/bash\necho "$*" >> "${calls}"\nfor a in "$@"; do if [ "$a" = "-hwaccel" ]; then echo "Failed setup for format d3d11: hwaccel initialisation returned error" >&2; exit 1; fi; done\nexec "${ffmpeg}" "$@"\n`,
    { mode: 0o755 },
  );
  const fallback = await detectScenes(fake, clip, null);
  assert.deepEqual(fallback, cpu);
  const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'tried the GPU once, then the CPU once');
  assert.match(lines[0], /-hwaccel auto/);
  assert.ok(!/-hwaccel/.test(lines[1]));
  console.log('PASS when hardware decoding fails, the same cuts are found with CPU decoding');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
