'use strict';
const assert = require('node:assert/strict');
const { finishReportPage } = require('../src/native/cost-report/page-look');

const width = 1200;
const height = 1700;
const source = new Uint8ClampedArray(width * height * 4).fill(255);
function rectangle(x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) source.set([...color, 255], (y * width + x) * 4);
  }
}
for (const y of [410, 610, 820]) rectangle(170, y, 1030, y + 2, [30, 30, 30]);
rectangle(720, 1110, 760, 1150, [180, 32, 30]);
rectangle(730, 1120, 750, 1126, [35, 35, 35]);
const before = new Uint8ClampedArray(source);
function run(boxes, seed = 0, glyphs = null) {
  let result;
  finishReportPage({
    getImageData: () => ({ data: source }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: ({ data }) => { result = data; },
  }, width, height, boxes, seed, glyphs);
  return result;
}
const box = { x: 725, y: 1117, w: 30, h: 14 };
const image = run([box]);
assert.deepEqual(source, before, 'the clean raster is preserved');
const control = run([]);
let mixedInk = 0;
for (let p = 0; p < image.length; p += 4) {
  assert.equal(image[p + 3], 255);
  if (control[p] > control[p + 1] + 45 && image[p] < control[p]) mixedInk++;
}
assert.ok(mixedInk > 2, 'existing red ink darkens where it touches text');
const glyphs = new Uint8ClampedArray(source.length);
for (let y = 1135; y < 1140; y++) {
  for (let x = 730; x < 750; x++) glyphs[(y * width + x) * 4 + 3] = 255;
}
const overlap = run([box, { x: 725, y: 1132, w: 30, h: 12 }], 0, glyphs);
let redChannelText = 0;
for (let p = 0; p < overlap.length; p += 4) {
  if (control[p] > control[p + 1] + 45 && overlap[p] < control[p] - 45) redChannelText++;
}
assert.ok(redChannelText > 30, 'text remains visible in the red channel at real glyph intersections');
function deviation(y0) {
  let sum = 0;
  let square = 0;
  let count = 0;
  for (let y = y0; y < y0 + 80; y++) {
    for (let x = 30; x < width - 30; x++) {
      const n = image[(y * width + x) * 4];
      sum += n;
      square += n * n;
      count++;
    }
  }
  return Math.sqrt(square / count - (sum / count) ** 2);
}
const upper = deviation(15);
const lower = deviation(height - 95);
assert.ok(upper > 2 && lower < 6 && lower > upper + .3, `grain ${upper}, ${lower}`);
const slopes = [];
for (const center of [410, 610, 820]) {
  const points = [];
  for (let x = 230; x < 970; x++) {
    let sum = 0;
    let count = 0;
    for (let y = center - 12; y < center + 14; y++) {
      if (image[(y * width + x) * 4] < 150) { sum += y; count++; }
    }
    if (count) points.push([x, sum / count]);
  }
  const n = points.length;
  const sx = points.reduce((s, [x]) => s + x, 0);
  const sy = points.reduce((s, [, y]) => s + y, 0);
  const slope = (n * points.reduce((s, [x, y]) => s + x * y, 0) - sx * sy) /
    (n * points.reduce((s, [x]) => s + x * x, 0) - sx * sx);
  slopes.push(Math.atan(slope) * 180 / Math.PI);
}
assert.ok(slopes.every((angle) => angle > .15 && angle < .8), `line angles ${slopes}`);
assert.ok(Math.max(...slopes) - Math.min(...slopes) > .04, 'local angles vary');
for (const offset of [0, (width - 1) * 4, (height - 1) * width * 4, (width * height - 1) * 4]) {
  assert.ok(image[offset] > 225, 'paper reaches the corners without a border');
}
assert.notDeepEqual(run([box], 314159), image, 'different exports vary');
console.log('PASS final image processing', { upper, lower, slopes, mixedInk, redChannelText });
