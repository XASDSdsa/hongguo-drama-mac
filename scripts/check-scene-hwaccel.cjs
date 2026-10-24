// 分析切点时镜头切换检测先用显卡：Windows 上先点名用英伟达显卡（D3D11 解码 + 缩小），再用默认显卡，
// 再不行 -hwaccel auto，最后 CPU；前一种失败就换下一种，切点一个不少。
// 默认显卡是「接着显示器的那块」：显示器插在主板上时是核显，独立显卡闲着，所以英伟达要点名。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { detectScenes, sceneMethods } = require('../src/native/resplit');

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
  assert.deepEqual([...hw], [...cpu], 'hardware decoding (or its automatic fallback) finds the same cuts');
  console.log(`PASS scene detection (${hw.method}) finds the same cuts as CPU decoding (${cpu.map((t) => t.toFixed(2)).join(', ')} s)`);
  assert.equal(cpu.method, 'cpu');

  // Windows 的做法：先点名英伟达显卡 D3D11（显卡解码 + 显卡缩小，只拷回 160 宽的小图），再默认显卡 D3D11，再 -hwaccel auto，最后 CPU
  const win = sceneMethods('win32');
  assert.deepEqual(win.map((m) => m.name), ['d3d11-nvidia', 'd3d11', 'hwaccel', 'cpu']);
  assert.deepEqual(win[0].input, [
    '-init_hw_device', 'd3d11va=scene:,vendor_id=0x10de',
    '-hwaccel', 'd3d11va', '-hwaccel_device', 'scene', '-hwaccel_output_format', 'd3d11',
  ], '点名英伟达（PCI 厂商号 0x10de），不用接显示器的核显');
  assert.deepEqual(win[1].input, ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11']);
  for (const m of win.slice(0, 2)) assert.match(m.vf, /^scale_d3d11=width=160:height=-2:format=nv12,hwdownload,format=nv12,select=/);
  assert.deepEqual(sceneMethods('darwin').map((m) => m.name), ['hwaccel', 'cpu']);
  assert.deepEqual(sceneMethods('win32', false).map((m) => m.name), ['cpu']);
  assert.deepEqual(win[3].input, ['-skip_loop_filter', 'all'], 'CPU 解码跳过去块滤波');
  const { SCENE_METHOD_TEXT } = require('../src/native/resplit');
  for (const m of win) assert.ok(SCENE_METHOD_TEXT[m.name], `日志里有 ${m.name} 的中文说法`);
  assert.match(SCENE_METHOD_TEXT['d3d11-nvidia'], /英伟达/);
  // 用真的 FFmpeg 按 Windows 的顺序走一遍：这台机器上 D3D11 不可用就自动往下换，切点一样
  const chain = await detectScenes(ffmpeg, clip, null, { platform: 'win32' });
  assert.deepEqual([...chain], [...cpu], `Windows 顺序（实际用 ${chain.method}）切点一样`);
  if (process.env.GITHUB_ACTIONS && process.platform === 'win32') {
    // 打包机上看看两条 D3D11 命令本身：没显卡时应该是设备/解码器的错，不应该是参数写错
    const bad = /Option .* not found|Error parsing|No such filter|Invalid output format|Unable to parse|Invalid device specification/i;
    for (const m of win.slice(0, 2)) {
      const d3d = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...m.input, '-i', clip, '-an', '-vf', m.vf, '-f', 'null', '-']);
      const stderr = String(d3d.stderr || '');
      const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ').replace(/[\r\n]/g, ' ');
      console.log(`::notice title=${m.name} 镜头切换检测::exit=${d3d.status} method=${chain.method} ${tail}`);
      // 打包机没有英伟达显卡：FFmpeg 应该明确说「按厂商号找不到显卡」，证明 vendor_id 这个参数它认得
      // （后面跟着的 Error parsing global options 是建设备失败的正常结果，不算参数写错）
      if (m.name === 'd3d11-nvidia' && d3d.status !== 0) {
        assert.match(stderr, /Failed to find d3d11va adapter by vendor id/i, `vendor_id 没被认出来：${tail}`);
        continue;
      }
      assert.ok(!bad.test(tail), `${m.name} 命令参数写错了：${tail}`);
    }
  }

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
  assert.deepEqual([...fallback], [...cpu]);
  assert.equal(fallback.method, 'cpu');
  let lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'tried the GPU once, then the CPU once');
  assert.match(lines[0], /-hwaccel auto/);
  assert.ok(!/-hwaccel/.test(lines[1]));
  assert.match(lines[1], /-skip_loop_filter all/);
  // Windows 顺序：英伟达 D3D11、默认显卡 D3D11、-hwaccel auto 都失败，第四次用 CPU
  fs.rmSync(calls);
  const winFallback = await detectScenes(fake, clip, null, { platform: 'win32' });
  assert.deepEqual([...winFallback], [...cpu]);
  lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /-init_hw_device d3d11va=scene:,vendor_id=0x10de -hwaccel d3d11va -hwaccel_device scene -hwaccel_output_format d3d11 .*scale_d3d11=/);
  assert.match(lines[1], /^-hide_banner -nostdin -hwaccel d3d11va -hwaccel_output_format d3d11 .*scale_d3d11=/);
  assert.match(lines[2], /-hwaccel auto/);
  assert.match(lines[3], /-skip_loop_filter all/);

  // 没有英伟达显卡的电脑：第一集试过一次「找不到英伟达」后，后面的集直接从默认显卡开始，不再每集多跑一次
  const noNvidia = path.join(tmp, 'ffmpeg-no-nvidia');
  fs.writeFileSync(
    noNvidia,
    `#!/bin/bash\necho "$*" >> "${calls}"\nfor a in "$@"; do case "$a" in *vendor_id=*) echo "Failed to find d3d11va adapter by vendor id 0x10de" >&2; exit 1;; -hwaccel) echo "Failed setup for format d3d11: hwaccel initialisation returned error" >&2; exit 1;; esac; done\nexec "${ffmpeg}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.rmSync(calls);
  await detectScenes(noNvidia, clip, null, { platform: 'win32' });
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 4, '第一集：英伟达 → 默认显卡 → auto → CPU');
  fs.rmSync(calls);
  const second = await detectScenes(noNvidia, clip, null, { platform: 'win32' });
  assert.deepEqual([...second], [...cpu]);
  lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, '第二集起不再试英伟达');
  assert.ok(!lines.some((line) => /vendor_id/.test(line)));
  console.log('PASS when hardware decoding fails, the same cuts are found with CPU decoding (Windows: NVIDIA D3D11 → default D3D11 → auto → CPU; no NVIDIA → skipped after the first try)');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
