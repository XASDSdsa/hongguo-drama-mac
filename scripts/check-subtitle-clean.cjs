'use strict';
// 分镜工程图四宫格关键帧去字幕：用真实 FFmpeg 造一段带字幕的视频和一段不带字幕的「原片」逐项对照。
// - 字幕横带找对位置；没字幕的视频什么都不做
// - 画面里本来就有的字（浅底深字的招牌）不当成字幕
// - 抹完后字幕那一条和原片的差距大幅缩小；横带以外一个像素都不动；这一刻没台词的帧不动
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
      `gradients=s=${W}x${H}:speed=0.015:n=4:seed=7,format=yuv420p,noise=alls=5:allf=t`,
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

    // 3) 抹字：横带里和原片的差距大幅缩小，横带以外一个像素不动
    const bandError = (a, b) => {
      const y0 = Math.max(0, band.y0 - 6);
      const y1 = Math.min(dims.height - 1, band.y1 + 6);
      let sum = 0;
      for (let y = y0; y <= y1; y++)
        for (let x = 0; x < dims.width * 3; x++) sum += Math.abs(a.data[y * dims.width * 3 + x] - b.data[y * dims.width * 3 + x]);
      return sum / ((y1 - y0 + 1) * dims.width * 3);
    };
    for (const time of [1.5, 4.0, 6.8]) {
      const truth = await sc.grabRaw(ffmpeg, plain, time, dims);
      const before = await sc.grabRaw(ffmpeg, subbed, time, dims);
      const image = { ...before, data: Buffer.from(before.data) };
      const filled = sc.cleanImage(image, band);
      assert.ok(filled > 0, `${time}s 有字幕，要抹`);
      const was = bandError(before, truth);
      const now = bandError(image, truth);
      assert.ok(now < was * 0.4, `${time}s 字幕那一条和原片的差距要缩小六成以上（${was.toFixed(1)} → ${now.toFixed(1)}）`);
      const pad = Math.round(band.height * 0.3) + 2 + 8;
      for (let y = 0; y < dims.height; y++) {
        if (y >= band.y0 - pad && y <= band.y1 + pad) continue;
        const from = y * dims.width * 3;
        assert.ok(image.data.subarray(from, from + dims.width * 3).equals(before.data.subarray(from, from + dims.width * 3)), `第 ${y} 行在横带以外，不能动`);
      }
      // 白色亮块、招牌在横带以外，原样保留
    }
    // 4) 这一刻没台词（没字幕）：不动
    const quiet = await sc.grabRaw(ffmpeg, subbed, 2.9, dims);
    const quietCopy = Buffer.from(quiet.data);
    assert.equal(sc.cleanImage(quiet, band), 0, '没字幕的那一帧不抹');
    assert.ok(quiet.data.equals(quietCopy));

    // 4b) 满画面花纹（草地、树叶、噪点）：横带里看着也「像字」，但上方对照那条一样，不抹
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
      const copy = Buffer.from(noisy.data);
      assert.equal(sc.cleanImage(noisy, band), 0, '满画面花纹不当字幕');
      assert.ok(noisy.data.equals(copy));
    }

    // 5) 出图：抹过的关键帧编码成 JPEG，尺寸和平常截的关键帧一样（320 宽）
    const frame = await sc.grabCleanFrame({ ffmpeg, inputPath: subbed, time: 4.0, band, dims, outWidth: 320, quality: 7 });
    assert.equal(frame.cleaned, true);
    assert.equal(frame.bytes[0], 0xff);
    assert.equal(frame.bytes[1], 0xd8, 'JPEG');
    const { jpegSize } = require('../src/native/video-prompt/html');
    assert.deepEqual(jpegSize(frame.bytes), { width: 320, height: 568 });

    // 6) 画幅：读不到就不处理；比 640 窄的片子按原宽处理
    assert.equal(sc.workSize(null), null);
    assert.deepEqual(sc.workSize({ width: 1080, height: 1920 }), { width: 640, height: 1138 });
    assert.deepEqual(sc.workSize({ width: 360, height: 640 }), { width: 360, height: 640 });
    console.log('PASS keyframe subtitle cleaning: band found, scene text and no-subtitle videos untouched, subtitles erased inside the band only');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
