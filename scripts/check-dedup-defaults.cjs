'use strict';
// 去重画面参数的默认值：只做便宜的调色、锐化和变速，每集在范围内随机；慢的效果默认关，手动才开。
const assert = require('node:assert/strict');
const quchong = require('../src/native/quchong');

const media = {
  has_audio: true,
  video_start: 0,
  audio_start: 0,
  video_duration: 20,
  duration: 20,
  video_width: 720,
  video_height: 1280,
};
const graph = (opts, rolled) => {
  const { args } = quchong.buildCommand({
    src: 'in.mp4',
    dst: 'out.mp4',
    opts: { ...quchong.DEFAULTS, encoder: 'cpu', ...opts },
    rolled,
    media,
    encoder: 'cpu',
  });
  return args[args.indexOf('-filter_complex') + 1];
};

const D = quchong.DEFAULTS;
assert.deepEqual(
  [D.speed_min, D.speed_max, D.brightness_min, D.brightness_max, D.contrast_min, D.contrast_max],
  [1.03, 1.21, -0.1445, 0.1474, 0.878, 1.1227],
);
assert.deepEqual(
  [D.gamma_min, D.gamma_max, D.saturation_min, D.saturation_max, D.hue_min, D.hue_max, D.unsharp_min, D.unsharp_max],
  [0.8781, 1.1227, 0.7982, 1.2841, -8.6, 7.7, -0.86, 0.73],
);
for (const key of ['rotation_max', 'rgb_shift', 'noise_min', 'noise_max']) assert.equal(D[key], 0, `${key} 默认关`);
assert.equal(D.vignette, false);
assert.equal(D.eq_enable, false);
assert.deepEqual([D.pitch_min, D.pitch_max], [1, 1], '默认不变调');

// 每集在范围内各取一个值。
for (let i = 0; i < 200; i++) {
  const r = quchong.rollParams(quchong.validateOptions({}));
  assert.ok(r.BRIGHTNESS >= D.brightness_min && r.BRIGHTNESS <= D.brightness_max);
  assert.ok(r.CONTRAST >= D.contrast_min && r.CONTRAST <= D.contrast_max);
  assert.ok(r.GAMMA >= D.gamma_min && r.GAMMA <= D.gamma_max);
  assert.ok(r.SATURATION >= D.saturation_min && r.SATURATION <= D.saturation_max);
  assert.ok(r.HUE >= D.hue_min && r.HUE <= D.hue_max);
  assert.ok(r.UNSHARP >= D.unsharp_min && r.UNSHARP <= D.unsharp_max);
  assert.ok(r.SPEED >= D.speed_min && r.SPEED <= D.speed_max);
}
// 随机裁边的位置避开正中间：默认 20% => CX、CY 都不会落在 0.4 ~ 0.6 之间，两侧都能取到。
const seen = { low: false, high: false };
for (let i = 0; i < 2000; i++) {
  const r = quchong.rollParams(quchong.validateOptions({}));
  for (const v of [r.CX, r.CY]) {
    assert.ok(v >= 0 && v <= 1 && !(v > 0.4 + 1e-9 && v < 0.6 - 1e-9), `裁边位置 ${v} 落在中心`);
    if (v < 0.4 + 1e-9) seen.low = true;
    else seen.high = true;
  }
}
assert.deepEqual(seen, { low: true, high: true });
assert.equal(D.center_exclude, 20);
const none = quchong.rollParams(quchong.validateOptions({ center_exclude: 0 }), () => 0.5);
assert.equal(none.CX, 0.5, '设成 0 就是不排除');

const ends = quchong.rollParams(quchong.validateOptions({}), () => 0);
assert.equal(ends.BRIGHTNESS, D.brightness_min);
assert.equal(ends.UNSHARP, D.unsharp_min);

// 默认的滤镜图：调色 + 锐化 + 变速，没有慢的效果。
const rolled = { ...quchong.rollParams(quchong.validateOptions({})), UNSHARP: -0.5, SPEED: 1.1 };
const fast = graph({}, rolled);
assert.match(fast, /eq=brightness=[-\d.]+:contrast=[\d.]+:gamma=[\d.]+:saturation=[\d.]+,hue=h=[-\d.]+/);
assert.match(fast, /unsharp=3:3:-0\.5000/);
assert.match(fast, /setpts=\(PTS-STARTPTS\)\/1\.100000/);
for (const slow of ['rotate=', 'rgbashift', 'noise=', 'vignette', 'asetrate', 'equalizer']) {
  assert.ok(!fast.includes(slow), `默认不应包含 ${slow}：${fast}`);
}
assert.match(fast, /atempo=1\.100000/, '音频只变速');
// 锐化接近 0 时直接跳过。
assert.ok(!graph({}, { ...rolled, UNSHARP: 0.01 }).includes('unsharp'));

// 手动打开后才有。
const slow = graph(
  {
    rotation_max: 0.008,
    rgb_shift: 2,
    noise_min: 4,
    noise_max: 7,
    vignette: true,
    pitch_min: 1.04,
    pitch_max: 1.07,
    eq_enable: true,
  },
  {
    ...quchong.rollParams(
      quchong.validateOptions({ rotation_max: 0.008, noise_min: 4, noise_max: 7, pitch_min: 1.04, pitch_max: 1.07 }),
    ),
    ROT: 0.005,
    NOISE: 5,
    PITCH: 1.05,
    SPEED: 1.1,
    UNSHARP: 0.5,
  },
);
for (const text of ['rotate=', 'rgbashift', 'noise=alls=5', 'vignette', 'asetrate', 'equalizer']) {
  assert.ok(slow.includes(text), `手动打开后应包含 ${text}`);
}

// 范围写反要报错，超出范围要报错。
assert.throws(() => quchong.validateOptions({ gamma_min: 1.2, gamma_max: 1 }), /下限不能大于上限/);
assert.throws(() => quchong.validateOptions({ brightness_min: -0.9 }), /brightness_min/);
// 编码方式以「设置」为准（自动 / 只用 CPU），两个开始去重的入口都用它，界面缓存的旧 encoder 不起作用。
{
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal((main.match(/encoder: dedupEncoder\(\)/g) || []).length, 2, '重新拆分和普通去重都要用设置里的编码方式');
  assert.match(main, /quchong_encoder: merged\.quchong_encoder === 'cpu' \? 'cpu' : 'auto'/);
  assert.match(main, /encoder: quchong\.resolveEncoder\(dedupEncoder\(\)\)/);
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src/components/Settings.jsx'), 'utf8');
  assert.match(settings, /'quchong_encoder'/);
  assert.match(settings, /只用 CPU/);
}
console.log('PASS dedup defaults: cheap colour/sharpen/speed only, heavy effects off until enabled');
