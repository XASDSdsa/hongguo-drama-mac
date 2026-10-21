'use strict';
// 分镜工程图四宫格关键帧去字幕：用真实 FFmpeg 造一段带字幕的视频和一段不带字幕的「原片」逐项对照。
// - 字幕横带找对位置；没字幕的视频什么都不做
// - 画面里本来就有的字（浅底深字的招牌）不当成字幕
// - 作图模型的结果只贴回字幕笔画那一点：字幕那一条接近原片，别处逐像素不变；对不齐、失败就保留原图；没字幕不调作图
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
      `gradients=s=${W}x${H}:speed=0.015:n=4:seed=7,format=yuv420p,noise=alls=5:allf=t:all_seed=3`,
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

    // 3) 去字：截字幕附近的方图（1024×1024 的 PNG + 同样大的遮罩）交给作图模型，回来的图只取字幕那一点贴回原帧
    //    这里用「原片同一块」假装是作图模型的结果（再整体偏亮 6，模拟模型调色），看贴回去的效果
    const { jpegSize } = require('../src/native/video-prompt/html');
    const pngSize = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    const calls = [];
    const shiftBy = (buffer, delta) => Buffer.from(buffer.map((v) => Math.max(0, Math.min(255, v + delta))));
    const cropOf = (image, region, dy = 0) => {
      const out = Buffer.alloc(region.side * region.side * 3);
      for (let y = 0; y < region.side; y++) {
        const row = Math.max(0, Math.min(image.height - 1, region.top + y + dy));
        image.data.copy(out, y * region.side * 3, (row * image.width + region.left) * 3, (row * image.width + region.left + region.side) * 3);
      }
      return out;
    };
    const fakeModel = (mode) => async ({ image, mask, prompt, region, time }) => {
      calls.push({ mode, image: pngSize(image), mask: pngSize(mask), prompt, time });
      if (mode === 'fail') throw new Error('作图接口 500');
      const truth = await sc.grabRaw(ffmpeg, plain, time, dims);
      // moved：模型把画面改了（这里用反色当成一张不一样的图）
      const crop = mode === 'moved' ? Buffer.from(cropOf(truth, region, 60).map((v) => 255 - v)) : shiftBy(cropOf(truth, region), 6);
      return sc.encodeJpeg(ffmpeg, { width: region.side, height: region.side, data: crop }, region.side, 2);
    };
    const decode320 = (bytes) => sc.decodeRaw(ffmpeg, bytes, 320, 568);
    const truth320 = async (time) => decode320(await sc.encodeJpeg(ffmpeg, await sc.grabRaw(ffmpeg, plain, time, dims), 320, 2));
    const frameOf = (time, erase) => sc.aiCleanFrame({ ffmpeg, inputPath: subbed, time, band, dims, outWidth: 320, quality: 2, erase });
    const scaleY = 568 / dims.height;
    const bandRows = [Math.floor((band.y0 - 24) * scaleY), Math.ceil((band.y1 + 24) * scaleY)];
    const error320 = (a, b) => {
      let sum = 0;
      for (let y = bandRows[0]; y <= bandRows[1]; y++) for (let x = 0; x < 320 * 3; x++) sum += Math.abs(a[y * 960 + x] - b[y * 960 + x]);
      return sum / ((bandRows[1] - bandRows[0] + 1) * 960);
    };
    for (const time of [1.5, 4.0, 6.8]) {
      const plainFrame = await frameOf(time, null);
      assert.equal(plainFrame.cleaned, false);
      const result = await frameOf(time, fakeModel('ok'));
      assert.equal(result.cleaned, true, `${time}s 有字幕，要去`);
      assert.deepEqual(jpegSize(result.bytes), { width: 320, height: 568 }, '和平常截的关键帧一样大');
      const before = await decode320(plainFrame.bytes);
      const after = await decode320(result.bytes);
      const truth = await truth320(time);
      const was = error320(before, truth);
      const now = error320(after, truth);
      assert.ok(now < was * 0.25, `${time}s 字幕那一条和原片的差距缩小七成五以上（${was.toFixed(1)} → ${now.toFixed(1)}）`);
      // 字幕那一条以外，一个像素都不动（和不去字幕时截的图逐像素一样）
      for (let y = 0; y < 568; y++) {
        if (y >= bandRows[0] - 16 && y <= bandRows[1] + 16) continue;
        assert.ok(after.subarray(y * 960, (y + 1) * 960).equals(before.subarray(y * 960, (y + 1) * 960)), `第 ${y} 行不在字幕那一条，不能动`);
      }
    }
    assert.ok(calls.every((call) => call.image.width === 1024 && call.image.height === 1024), '发给作图模型的是 1024×1024 方图');
    assert.ok(calls.every((call) => call.mask.width === 1024 && call.mask.height === 1024), '遮罩和图一样大');
    assert.ok(calls[0].prompt.includes('只去掉') && calls[0].prompt.includes('保持完全不变'));

    // 4) 作图结果对不齐（模型挪了画面）、作图失败：保留原图，不贴半成品
    for (const mode of ['moved', 'fail']) {
      const result = await frameOf(4.0, fakeModel(mode));
      assert.equal(result.cleaned, false, mode);
      assert.equal(result.reason, mode === 'moved' ? 'mismatch' : 'failed');
      assert.ok(result.bytes.equals((await frameOf(4.0, null)).bytes), `${mode}：和原图一模一样`);
    }
    // 这一刻没字幕：不调作图模型
    calls.length = 0;
    const quiet = await frameOf(2.9, fakeModel('ok'));
    assert.equal(quiet.reason, 'none');
    assert.equal(calls.length, 0, '没字幕的那一帧不花钱调作图');

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
    console.log('PASS keyframe subtitle cleaning: band found, scene text untouched; AI result pasted back only on the subtitle strokes, everything else pixel-identical; mismatch/failure keeps the original');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
