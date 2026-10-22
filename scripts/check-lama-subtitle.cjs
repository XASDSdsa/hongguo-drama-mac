'use strict';
// 关键帧去字幕用的 LaMa 补图：
// A) 常驻进程的收发（用一个假的补图程序）：先等「准备好」再发任务；一次一张排队；某张出错不影响下一张；
//    进程半路退出 → 这张报错、下一张自动重新拉起；卡住 → 超时报错并结束进程；停止 → 立刻不等；
//    空闲自动退出；路径里有中文（Windows 用户名）也能用；没装运行时 / 模型 → 说清楚。
// B) 真模型（打包机上装好了内置运行时，或本机给了 LAMA_PYTHON + LAMA_MODEL 时才跑）：
//    造一段带字幕的视频，关键帧用 LaMa 补：字没了、补出来接近没字幕的原片、框外面逐像素不变。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createLamaWorker, asciiJson, MODEL_FILE, DETECTOR_FILE } = require('../src/native/video-prompt/lama');
const sc = require('../src/native/video-prompt/subtitle-clean');
const structureRuntime = require('../src/native/video-structure/runtime');

const FAKE = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.FAKE_MODE || 'ok';
const counter = process.env.FAKE_COUNTER;
fs.appendFileSync(counter, 'start\n');
const args = process.argv.slice(2);
if (args[0] !== 'inpaint' || !args.includes('--model') || !args.includes('--threads')) process.exit(3);
const detector = args.includes('--detector') ? args[args.indexOf('--detector') + 1] : '';
setTimeout(() => console.log(JSON.stringify({ type: 'ready', threads: Number(args[args.indexOf('--threads') + 1]), detector: !!detector })), mode === 'slow' ? 400 : 20);
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  n += 1;
  fs.appendFileSync(counter, (/^[\x20-\x7e]+$/.test(line) ? 'ascii ' : 'NONASCII ') + line + '\n');
  const job = JSON.parse(line);
  if (mode === 'hang') return;
  if (mode === 'crash' && n === 2) process.exit(7);
  if (mode === 'error' && n === 1) return console.log(JSON.stringify({ type: 'error', id: job.id, message: 'RuntimeError: bad crop' }));
  const data = fs.readFileSync(job.input);
  if (job.op === 'clean') {
    if (!detector) return console.log(JSON.stringify({ type: 'error', id: job.id, message: 'ValueError: text detector not loaded' }));
    data.fill(77, 0, 3); // 「补」了第一个像素
    fs.writeFileSync(job.output, data);
    return console.log(JSON.stringify({ type: 'done', id: job.id, boxes: [[0, 0, 1, 1, 'k=3']], rejected: ['no thin strokes'], residue: false, seconds: 0.5 }));
  }
  const mask = fs.readFileSync(job.mask);
  for (let p = 0; p < mask.length; p++) if (mask[p]) data.fill(128, p * 3, p * 3 + 3);
  setTimeout(() => {
    fs.writeFileSync(job.output, data);
    console.log('torch warning line that is not JSON');
    console.log(JSON.stringify({ type: 'done', id: job.id, seconds: 0.123 }));
  }, 30);
});
`;

async function partA(dir) {
  const fake = path.join(dir, 'fake-lama.js');
  const model = path.join(dir, MODEL_FILE);
  fs.writeFileSync(fake, FAKE);
  fs.writeFileSync(model, 'not a real model');
  // 临时文件夹带中文（Windows 用户名是中文时就是这样）
  const tempRoot = path.join(dir, '张三的临时文件');
  fs.mkdirSync(tempRoot);
  const counter = (name) => path.join(dir, `${name}.log`);
  const make = (mode, extra = {}) => {
    process.env.FAKE_MODE = mode;
    process.env.FAKE_COUNTER = counter(mode);
    return createLamaWorker({ command: process.execPath, prefix: [fake], model, threads: 3, tempRoot, ...extra });
  };
  const job = (w = 4, h = 2) => {
    const data = Buffer.alloc(w * h * 3, 10);
    const mask = Buffer.alloc(w * h);
    mask[1] = 1;
    return { data, width: w, height: h, mask };
  };

  // 正常：三张同时交过去，排队一张一张补，结果各自对上
  {
    const worker = make('ok');
    assert.equal((await worker.start()).threads, 3, '线程数传过去了');
    const results = await Promise.all([job(), job(3, 3), job()].map((j) => worker.inpaint(j)));
    assert.deepEqual([...results[0].data.subarray(0, 6)], [10, 10, 10, 128, 128, 128], '框里补了，框外不动');
    assert.equal(results[1].data.length, 27);
    assert.equal(results[0].seconds, 0.123);
    const lines = fs.readFileSync(counter('ok'), 'utf8').trim().split('\n');
    assert.equal(lines.filter((l) => l === 'start').length, 1, '模型只加载一次');
    assert.equal(lines.filter((l) => l.startsWith('ascii ')).length, 3, '任务行全是 ASCII（中文路径写成 \\u）');
    assert.ok(lines.some((l) => l.includes('\\u5f20\\u4e09')), '路径里的「张三」原样传过去');
    assert.deepEqual(fs.readdirSync(fs.readdirSync(tempRoot).map((d) => path.join(tempRoot, d))[0]), [], '临时文件都删了');
    worker.close();
  }
  assert.equal(JSON.parse(asciiJson({ p: 'C:\\Users\\张三\\a' })).p, 'C:\\Users\\张三\\a');

  // 某张回了错误：这张报错，下一张照常
  {
    const worker = make('error');
    await assert.rejects(worker.inpaint(job()), /RuntimeError: bad crop/);
    assert.equal((await worker.inpaint(job())).data[3], 128);
    worker.close();
  }

  // 进程半路退出：这张报错（带退出码），下一张自动重新拉起
  {
    const worker = make('crash');
    await worker.inpaint(job());
    await assert.rejects(worker.inpaint(job()), /LaMa 补图进程退出了（7）/);
    assert.equal((await worker.inpaint(job())).data[3], 128, '重新拉起后照常');
    assert.equal(fs.readFileSync(counter('crash'), 'utf8').split('\n').filter((l) => l === 'start').length, 2);
    worker.close();
  }

  // 卡住：超时报错，结束进程
  {
    const worker = make('hang', { jobTimeoutMs: 300 });
    await assert.rejects(worker.inpaint(job()), /LaMa 补一张图超过 0 秒|超过/);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(worker.running, false, '卡住的进程结束掉了');
    worker.close();
  }

  // 停止：正在等的这张立刻不等了
  {
    const worker = make('hang');
    const controller = new AbortController();
    const pending = worker.inpaint({ ...job(), signal: controller.signal });
    setTimeout(() => controller.abort(new Error('已停止')), 150);
    await assert.rejects(pending, /已停止/);
    worker.close();
  }

  // 模型加载太久：报超时，不会一直等
  {
    const worker = make('slow', { startTimeoutMs: 100 });
    await assert.rejects(worker.start(), /LaMa 补图模型 0 秒还没加载好|还没加载好/);
    worker.close();
  }

  // 空闲一会儿自己退出，省内存；再用时重新拉起
  {
    const worker = make('ok', { idleMs: 150 });
    fs.rmSync(counter('ok'), { force: true });
    await worker.inpaint(job());
    assert.equal(worker.running, true);
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(worker.running, false, '空闲后退出了');
    await worker.inpaint(job());
    assert.equal(fs.readFileSync(counter('ok'), 'utf8').split('\n').filter((l) => l === 'start').length, 2);
    worker.close();
  }

  // 整张找字（clean）：有文字检测模型才传 --detector、才能 clean；结果带回找到的字和没动的
  {
    const detector = path.join(dir, 'text_detection_cn_ppocrv3_2023may.onnx');
    fs.writeFileSync(detector, 'not a real model');
    const worker = make('ok', { detector });
    assert.equal(worker.canClean, true);
    assert.equal((await worker.start()).detector, true, '传了 --detector');
    const frame = Buffer.alloc(4 * 2 * 3, 10);
    const result = await worker.clean({ data: frame, width: 4, height: 2 });
    assert.equal(result.data[0], 77);
    assert.deepEqual(result.boxes, [[0, 0, 1, 1, 'k=3']]);
    assert.deepEqual(result.rejected, ['no thin strokes']);
    assert.equal(result.residue, false);
    assert.equal(result.seconds, 0.5);
    worker.close();
    const without = make('ok');
    assert.equal(without.canClean, false, '没有文字检测模型：不能整张找字');
    await assert.rejects(without.clean({ data: frame, width: 4, height: 2 }), /text detector not loaded/);
    without.close();
  }

  // 没装运行时 / 模型：说清楚
  await assert.rejects(createLamaWorker({ command: path.join(dir, 'nope'), model }).start(), /内置分析运行时没装上（需要完整安装包）/);
  await assert.rejects(createLamaWorker({ command: process.execPath, prefix: [fake], model: path.join(dir, 'nope.pt') }).start(), /LaMa 补图模型没装上（需要完整安装包）/);
  console.log('PASS LaMa worker: loads once, one job at a time, errors / crash / hang / stop / idle handled, ASCII job lines');
}

/** 真的 LaMa：打包机上用内置运行时；本机开发可以给 LAMA_PYTHON（装了 torch 的 python）和 LAMA_MODEL。 */
function realLama() {
  if (process.env.LAMA_PYTHON && process.env.LAMA_MODEL)
    return { command: process.env.LAMA_PYTHON, prefix: [path.join(__dirname, '../src/native/video-structure/runner.py')], model: process.env.LAMA_MODEL, detector: process.env.LAMA_DETECTOR || null };
  const rt = structureRuntime.runtime({});
  const model = path.join(rt.models, MODEL_FILE);
  const detector = path.join(rt.models, DETECTOR_FILE);
  if (rt.command && fs.existsSync(model)) return { command: rt.command, prefix: rt.prefix, model, detector: fs.existsSync(detector) ? detector : null };
  return null;
}

async function partB(dir) {
  const real = realLama();
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const font = [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc',
    'C:\\Windows\\Fonts\\msyhbd.ttc',
    'C:\\Windows\\Fonts\\msyh.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
  ].find((file) => fs.existsSync(file));
  if (!real) {
    // 打包机上必须有：内置运行时打包好了却跑不了 LaMa，不能发
    if (process.env.REQUIRE_LAMA === '1') throw new Error('REQUIRE_LAMA=1 但没找到内置运行时里的 LaMa');
    return console.log('SKIP real LaMa (no bundled runtime / model here)');
  }
  // 先用一张不需要字体的图：渐变底上横着一条白杠，盖住白杠交给 LaMa，补出来接近渐变
  {
    const worker = createLamaWorker({ ...real, threads: 2 });
    try {
      const w = 160;
      const h = 96;
      const truth = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) truth.set([40 + x, 60 + y, 120], (y * w + x) * 3);
      const data = Buffer.from(truth);
      const mask = Buffer.alloc(w * h);
      for (let y = 40; y < 56; y++)
        for (let x = 20; x < 140; x++) {
          data.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3);
          mask[y * w + x] = 1;
        }
      const out = await worker.inpaint({ data, width: w, height: h, mask });
      let error = 0;
      let n = 0;
      for (let p = 0; p < w * h; p++) if (mask[p]) for (let c = 0; c < 3; c++, n++) error += Math.abs(out.data[p * 3 + c] - truth[p * 3 + c]);
      assert.ok(error / n < 20, `白杠补掉了（平均差 ${(error / n).toFixed(1)}）`);
      console.log(`PASS real LaMa through the app's worker (bar mean error ${(error / n).toFixed(1)}, ${out.seconds.toFixed(2)} s)`);
    } finally {
      worker.close();
    }
  }
  // 整张找字：1080×1920 的样图（底部一行浅灰宋体字幕、左边竖排人名条和一列小字、右上角角标、眼睛里的高光）
  if (real.detector) {
    const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
    const W = 1080;
    const H = 1920;
    const raw = execFileSync(ffmpegBin, ['-v', 'error', '-i', path.join(__dirname, 'fixtures', 'keyframe-text.png'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(raw.length, W * H * 3);
    const worker = createLamaWorker({ ...real, threads: Math.max(2, Math.min(8, os.cpus().length - 1)) });
    try {
      assert.equal(worker.canClean, true);
      const result = await worker.clean({ data: Buffer.from(raw), width: W, height: H });
      const at = (buf, x, y) => [...buf.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
      const changed = (x0, y0, x1, y1) => {
        let n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (Math.abs(raw[(y * W + x) * 3] - result.data[(y * W + x) * 3]) > 24) n += 1;
        return n;
      };
      const inside = (x, y) => result.boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
      assert.ok(inside(540, 1420), `底部字幕找到了（${JSON.stringify(result.boxes)}）`);
      assert.ok(inside(175, 870), '竖排人名条找到了');
      assert.ok(inside(110, 980), '人名条旁边那列小字找到了');
      assert.ok(inside(900, 110), '右上角角标找到了');
      assert.ok(!inside(548, 808), '眼睛里的高光不是字');
      assert.deepEqual(at(result.data, 548, 808), at(raw, 548, 808), '眼睛高光一个像素都不动');
      assert.equal(changed(400, 300, 700, 600), 0, '没字的地方不动');
      assert.ok(changed(320, 1390, 760, 1450) > 2000, '字幕那一行补过了');
      assert.equal(result.residue, false, '补完再查没有字');
      console.log(`PASS real text scan: ${result.boxes.length} pieces of text found anywhere in a 1080p frame and removed (${result.seconds.toFixed(1)} s); the eye highlight is left alone`);
    } finally {
      worker.close();
    }
  } else if (process.env.REQUIRE_LAMA === '1') throw new Error('REQUIRE_LAMA=1 但内置运行时里没有文字检测模型');
  if (!font) return console.log('SKIP real LaMa subtitle video (no CJK font for drawtext)');
  // 软件自带的 FFmpeg 不一定带 drawtext（Mac 那份就没有）：造不了带字幕的视频就只做上面那项
  if (!/\bdrawtext\b/.test(spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || ''))
    return console.log('SKIP real LaMa subtitle video (this FFmpeg has no drawtext)');
  const fontArg = font.replace(/\\/g, '/').replace(/:/g, '\\:');
  const W = 540;
  const H = 960;
  // 背景：渐变 + 一件白衬衫似的亮块（深色边），字幕压在衬衫和背景上
  const scene = `gradients=s=${W}x${H}:speed=0.015:n=4:c0=0x3a5f8a:c1=0xb07a48:c2=0x5f8f4e:c3=0x7a4a6e:seed=7,format=yuv420p,noise=alls=5:allf=t:all_seed=3,drawbox=x=150:y=640:w=240:h=200:color=0xEEEEEE@1:t=fill,drawbox=x=150:y=640:w=240:h=200:color=0x202020@1:t=4`;
  const lines = [['你终于来了，我等你很久了', 0.4, 2.6], ['这件事你必须给我一个交代', 3.2, 5.4], ['不然我们之间就到此为止', 6.0, 7.6]];
  const subtitles = lines
    .map(([text, from, to]) => `drawtext=fontfile='${fontArg}':text='${text}':fontsize=30:fontcolor=white:borderw=2:bordercolor=black:x=(w-tw)/2:y=h*0.75:enable='between(t,${from},${to})'`)
    .join(',');
  const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '25', '-pix_fmt', 'yuv420p'];
  const plain = path.join(dir, 'plain.mp4');
  const subbed = path.join(dir, 'subbed.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', scene, '-t', '8', '-r', '25', ...encode, plain]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', plain, '-vf', subtitles, ...encode, subbed]);
  const utterances = lines.map(([text, start, end]) => ({ start, end, text }));
  const rows = [{ start: 0, end: 4, dialogue: ['a'] }, { start: 4, end: 8, dialogue: ['b'] }];
  const { band, dims } = await sc.detectEpisodeBand({ ffmpeg, inputPath: subbed, rows, utterances, size: { width: W, height: H } });
  assert.ok(band, '找到字幕横带');

  const worker = createLamaWorker({ ...real, threads: Math.max(2, Math.min(8, os.cpus().length - 1)) });
  try {
    const started = Date.now();
    await worker.start();
    console.log(`LaMa ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    let total = 0;
    for (const time of [1.5, 4.4, 6.8]) {
      const result = await sc.cleanKeyframe({ ffmpeg, inputPath: subbed, time, band, dims, sizes: [{ width: 320, quality: 7 }], inpaint: worker.inpaint });
      assert.equal(result.method, 'lama', `${time}s 用 LaMa 补的${result.lamaError ? `（${result.lamaError.message}）` : ''}`);
      assert.ok(result.cleaned && result.clean, `${time}s 字幕去掉了，补完检测不到字`);
      total += result.seconds;
      // 补出来和没字幕的原片比：框里平均差多少；框外逐像素不变
      const original = await sc.grabRaw(ffmpeg, subbed, time, dims);
      const truth = await sc.grabRaw(ffmpeg, plain, time, dims);
      const cover = sc.subtitleCover(original, band);
      const lb = sc.lineBox(cover, original.width, original.height, original);
      const image = { ...original, data: Buffer.from(original.data) };
      await sc.lamaBox(image, lb, worker.inpaint);
      let inside = 0;
      let n = 0;
      let outsideChanged = 0;
      let before = 0;
      for (let p = 0; p < original.width * original.height; p++)
        for (let c = 0; c < 3; c++) {
          const i = p * 3 + c;
          if (lb.box[p]) {
            inside += Math.abs(image.data[i] - truth.data[i]);
            before += Math.abs(original.data[i] - truth.data[i]);
            n += 1;
          } else if (image.data[i] !== original.data[i]) outsideChanged += 1;
        }
      assert.equal(outsideChanged, 0, '框外一个像素都没动');
      console.log(`  ${time}s：框里和原片平均差 ${(inside / n).toFixed(1)}（补之前 ${(before / n).toFixed(1)}），LaMa ${result.seconds.toFixed(2)} 秒`);
      // （老办法：整行框比字大一圈，框里和原片比起来会多出一点差别）
      assert.ok(inside / n < 12 && inside / n < (before / n) * 0.45, '补出来接近没字幕的原片');
    }
    console.log(`PASS real LaMa removes subtitles (${(total / 3).toFixed(2)} s per keyframe)`);
  } finally {
    worker.close();
  }
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lama-'));
  try {
    await partA(dir);
    await partB(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
