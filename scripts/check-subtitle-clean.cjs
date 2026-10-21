'use strict';
// 分镜工程图四宫格关键帧去字幕：用真实 FFmpeg 造一段带字幕的视频和一段不带字幕的「原片」逐项对照。
// - 字幕横带找对位置；没字幕的视频什么都不做
// - 画面里本来就有的字（浅底深字的招牌）不当成字幕
// - 字幕那一行用旁边真实的画面补：补完接近没字幕的原片、检测不到字，框外面逐像素不变；这一刻没字幕不动
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sc = require('../src/native/video-prompt/subtitle-clean');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const FONTS = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc',
  'C:\\Windows\\Fonts\\msyhbd.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
];
const font = FONTS.find((file) => fs.existsSync(file));

(async () => {
  if (!font) {
    console.log('SKIP subtitle clean: no CJK font for drawtext');
    return;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '关键帧去字幕-'));
  try {
    const fontArg = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    const W = 540;
    const H = 960;
    const lines = [
      ['你终于来了，我等你很久了', 0.4, 2.6],
      ['这件事你必须给我一个交代', 3.2, 5.4],
      ['不然我们之间就到此为止', 6.0, 7.6],
    ];
    // 背景：缓慢变化的渐变 + 噪点；一块白衣服似的亮块（深色边）；一块浅底深字的招牌（一直在画面里）
    const scene = [
      `gradients=s=${W}x${H}:speed=0.015:n=4:c0=0x3a5f8a:c1=0xb07a48:c2=0x5f8f4e:c3=0x7a4a6e:seed=7,format=yuv420p,noise=alls=5:allf=t:all_seed=3`,
      `drawbox=x=150:y=500:w=240:h=200:color=0xEEEEEE@1:t=fill,drawbox=x=150:y=500:w=240:h=200:color=0x202020@1:t=4`,
      `drawbox=x=60:y=330:w=420:h=70:color=0xF2F2F2@1:t=fill`,
      `drawtext=fontfile='${fontArg}':text='永和豆浆 全天营业 欢迎光临':fontsize=30:fontcolor=0x222222:x=80:y=348`,
    ].join(',');
    const subtitles = lines
      .map(
        ([text, from, to]) =>
          `drawtext=fontfile='${fontArg}':text='${text}':fontsize=30:fontcolor=white:borderw=2:bordercolor=black:x=(w-tw)/2:y=h*0.75:enable='between(t,${from},${to})'`,
      )
      .join(',');
    const encode = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '25', '-pix_fmt', 'yuv420p'];
    const plain = path.join(dir, 'plain.mp4');
    const subbed = path.join(dir, 'subbed.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', scene, '-t', '8', '-r', '25', ...encode, plain]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', plain, '-vf', subtitles, ...encode, subbed]);

    const spoken = [1, 1.8, 2.4, 3.6, 4.4, 5.2, 6.4, 7.2];
    const silent = [2.9, 5.7, 7.85];
    const rows = [...spoken.map((t) => [t, true]), ...silent.map((t) => [t, false])]
      .sort((a, b) => a[0] - b[0])
      .map(([t, talk]) => ({ start: t - 0.1, end: t + 0.1, dialogue: talk ? ['台词'] : [] }));
    const size = { width: W, height: H };

    // 1) 字幕横带找对位置
    const { band, dims } = await sc.detectEpisodeBand({ ffmpeg, inputPath: subbed, rows, size });
    assert.ok(band, '带字幕的视频要找到字幕横带');
    const top = band.y0 / band.frameHeight;
    const bottom = band.y1 / band.frameHeight;
    assert.ok(top >= 0.72 && bottom <= 0.82, `字幕在 75% 高度附近（找到 ${top.toFixed(3)}–${bottom.toFixed(3)}）`);

    // 1b) 有逐句时间时按句子挑样本：分镜全都有台词（没有「没台词」的分镜做对照）也能找到，招牌不当字幕
    const utterances = lines.map(([text, from, to]) => ({ start: from, end: to, text }));
    const allTalking = [{ start: 0, end: 4, dialogue: ['a'] }, { start: 4, end: 8, dialogue: ['b'] }];
    const byLines = await sc.detectEpisodeBand({ ffmpeg, inputPath: subbed, rows: allTalking, utterances, size });
    assert.ok(byLines.band && Math.abs(byLines.band.y0 - band.y0) <= 6, '按句子挑样本也找到同一条');
    assert.equal((await sc.detectEpisodeBand({ ffmpeg, inputPath: plain, rows: allTalking, utterances, size })).band, null);
    const times = sc.sampleTimes(allTalking, utterances);
    const round = (list) => list.map((t) => Math.round(t * 100) / 100);
    assert.deepEqual(round(times.spoken), [1.5, 4.3, 6.8], '每句中间');
    assert.deepEqual(round(times.silent), [2.9], '两句之间空出 0.6 秒以上才算没说话（5.4–6.0 刚好卡线、7.6–8.0 太短）');

    // 2) 没字幕的视频：浅底深字的招牌、白色亮块都不当字幕
    assert.equal((await sc.detectEpisodeBand({ ffmpeg, inputPath: plain, rows, size })).band, null, '没字幕就不处理');
    // 整集没台词：也不处理
    assert.equal((await sc.detectEpisodeBand({ ffmpeg, inputPath: subbed, rows: rows.map((r) => ({ ...r, dialogue: [] })), size })).band, null);

    // 3) 去字（本机，用旁边真实的画面补）：字幕那一条和没字幕的原片差距大幅缩小；字幕那一行框外面一个像素都不动
    const { jpegSize } = require('../src/native/video-prompt/html');
    const decodeAt = (bytes, w, h) => sc.decodeRaw(ffmpeg, bytes, w, h);
    const frameOf = (time, sizes = [{ width: 320, quality: 2 }]) => sc.cleanKeyframe({ ffmpeg, inputPath: subbed, time, band, dims, sizes });
    const plainAt = async (time) => sc.grabRaw(ffmpeg, plain, time, dims);
    const bandRows = [Math.max(0, band.y0 - 24), Math.min(dims.height - 1, band.y1 + 24)];
    // 背景是随机噪点：补出来的纹理不可能和原片的噪点一模一样，所以两张都先抹掉噪点（7×7 平均）再比
    const blurred = (data) => {
      const W = dims.width;
      const out = new Float32Array((bandRows[1] - bandRows[0] + 1) * W * 3);
      for (let y = bandRows[0]; y <= bandRows[1]; y++)
        for (let x = 0; x < W; x++)
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            let n = 0;
            for (let dy = -3; dy <= 3; dy++)
              for (let dx = -3; dx <= 3; dx++) {
                const yy = y + dy;
                const xx = x + dx;
                if (yy < 0 || yy >= dims.height || xx < 0 || xx >= W) continue;
                sum += data[(yy * W + xx) * 3 + c];
                n += 1;
              }
            out[((y - bandRows[0]) * W + x) * 3 + c] = sum / n;
          }
      return out;
    };
    const errorIn = (a, b) => {
      const pa = blurred(a.data);
      const pb = blurred(b.data);
      let sum = 0;
      for (let i = 0; i < pa.length; i++) sum += Math.abs(pa[i] - pb[i]);
      return sum / pa.length;
    };
    for (const time of [1.5, 4.0, 6.8]) {
      const original = await sc.grabRaw(ffmpeg, subbed, time, dims);
      const cover = sc.subtitleCover(original, band);
      assert.ok(cover, `${time}s 有字幕`);
      const lb = sc.lineBox(cover, dims.width, dims.height, original);
      const image = { ...original, data: Buffer.from(original.data) };
      const started = Date.now();
      sc.cleanBox(image, lb);
      const ms = Date.now() - started;
      assert.ok(ms < 8000, `一张不到 8 秒（${ms} ms）`);
      const truth = await plainAt(time);
      const was = errorIn(original, truth);
      const now = errorIn(image, truth);
      assert.ok(now < was * 0.5, `${time}s 字幕那一条和原片的差距至少缩小一半（${was.toFixed(1)} → ${now.toFixed(1)}）`);
      assert.equal(sc.subtitleCover(image, band), null, `${time}s 补完检测不到字`);
      // 框外面一个像素都不动
      for (let y = 0; y < dims.height; y++)
        for (let x = 0; x < dims.width; x++) {
          if (y >= lb.y0 && y <= lb.y1 && x >= lb.x0 && x <= lb.x1) continue;
          const i = (y * dims.width + x) * 3;
          if (image.data[i] !== original.data[i] || image.data[i + 1] !== original.data[i + 1] || image.data[i + 2] !== original.data[i + 2])
            assert.fail(`(${x},${y}) 在字幕框外面，不能动`);
        }
      // 整条流程：出 320 宽的四宫格，起幅那张顺便出 560 宽的视频首帧
      const result = await frameOf(time, [{ width: 320, quality: 2 }, { width: 560, quality: 2 }]);
      assert.equal(result.cleaned, true);
      assert.equal(result.clean, true);
      assert.deepEqual(jpegSize(result.outputs[0]), { width: 320, height: 568 });
      assert.deepEqual(jpegSize(result.outputs[1]), { width: 540, height: 960 }, '首帧 560 宽（原片只有 540 宽就按原宽）');
      const small = await decodeAt(result.outputs[0], dims.width, dims.height);
      assert.ok(errorIn({ data: small }, truth) < was * 0.7, '出来的图里字幕也没了（缩小再放大会糊一点）');
    }

    // 4) 这一刻没字幕：一个像素不动
    const quiet = await frameOf(2.9);
    assert.equal(quiet.reason, 'none');
    assert.equal(quiet.cleaned, false);
    assert.equal(quiet.clean, true, '这一刻本来就没字幕');
    const quietPlain = await sc.encodeJpeg(ffmpeg, await sc.grabRaw(ffmpeg, subbed, 2.9, dims), 320, 2);
    assert.ok(quiet.outputs[0].equals(quietPlain), '和原图一模一样');

    // 4b) 满画面花纹（草地、树叶、噪点）：横带里看着也「像字」，但上方对照那条一样，不当字幕
    {
      let seed = 1;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      const noisy = { width: dims.width, height: dims.height, data: Buffer.alloc(dims.width * dims.height * 3) };
      for (let i = 0; i < noisy.data.length; i += 3) {
        const v = rand() < 0.5 ? 20 + rand() * 40 : 200 + rand() * 55;
        noisy.data[i] = v;
        noisy.data[i + 1] = v;
        noisy.data[i + 2] = v;
      }
      assert.equal(sc.subtitleCover(noisy, band), null, '满画面花纹不当字幕');
    }

    // 6) 画幅：读不到就不处理；比 640 窄的片子按原宽处理
    assert.equal(sc.workSize(null), null);
    assert.deepEqual(sc.workSize({ width: 1080, height: 1920 }), { width: 640, height: 1138 });
    assert.deepEqual(sc.workSize({ width: 360, height: 640 }), { width: 360, height: 640 });
    console.log('PASS keyframe subtitle cleaning: band found, scene text untouched; subtitle line filled from real texture around it, nothing outside the box changed, no subtitle left');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
