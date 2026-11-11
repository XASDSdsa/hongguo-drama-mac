'use strict';

// This function also runs inside the isolated PDF canvas. Keep it self-contained.
function finishReportPage(context, width, height, textBoxes, variation = 0) {
  const source = context.getImageData(0, 0, width, height);
  const warped = context.createImageData(width, height);
  const textMask = new Uint8Array(width * height);
  for (const { x, y, w, h } of textBoxes) {
    const left = Math.max(0, Math.floor(x) - 2);
    const right = Math.min(width, Math.ceil(x + w) + 2);
    for (let row = Math.max(0, Math.floor(y) - 2); row < Math.min(height, Math.ceil(y + h) + 2); row++) {
      if (right > left) textMask.fill(1, row * width + left, row * width + right);
    }
  }
  const ink = new Uint8Array(width * height);
  const pixels = warped.data;
  const curve = new Float32Array(width);
  for (let x = 0; x < width; x++) curve[x] = (x / width) * 4.5;
  for (let y = 0; y < height; y++) {
    const v = y / height;
    const phase = (variation % 65521) / 65521;
    const direction = variation & 1 ? -1 : 1;
    const angle = direction * (0.33 + 0.07 * Math.sin(2 * Math.PI * v + 0.35 + phase) +
      0.025 * Math.cos(5.4 * Math.PI * v)) * Math.PI / 180;
    const shift = angle * (y - height / 2) + 1.3 * Math.sin(8 * v + 0.3);
    for (let x = 0; x < width; x++) {
      const sx = x + shift;
      const sy = y - angle * (x - width / 2) + 1.4 * Math.sin(curve[x] + 3.5 * v);
      const index = y * width + x;
      const at = index * 4;
      pixels[at + 3] = 255;
      const left = Math.floor(sx);
      const top = Math.floor(sy);
      if (left < 0 || left + 1 >= width || top < 0 || top + 1 >= height) {
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 255;
        continue;
      }
      const dx = sx - left;
      const dy = sy - top;
      const near = (top * width + left) * 4;
      const far = near + width * 4;
      ink[index] = textMask[Math.round(sy) * width + Math.round(sx)];
      for (let c = 0; c < 3; c++) {
        const a = source.data[near + c] * (1 - dx) + source.data[near + 4 + c] * dx;
        const b = source.data[far + c] * (1 - dx) + source.data[far + 4 + c] * dx;
        pixels[at + c] = a * (1 - dy) + b * dy;
      }
    }
  }

  function grainAt(x, y, seed) {
    let hash = Math.imul(x ^ seed ^ variation, 0x45d9f3b) ^ Math.imul(y, 0x119de1f3);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    return ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff - 0.5;
  }
  function mottling(x, y, scale, seed) {
    const col = Math.floor(x / scale);
    const row = Math.floor(y / scale);
    const dx = x / scale - col;
    const dy = y / scale - row;
    const sx = dx * dx * (3 - 2 * dx);
    const sy = dy * dy * (3 - 2 * dy);
    const a = grainAt(col, row, seed) * (1 - sx) + grainAt(col + 1, row, seed) * sx;
    const b = grainAt(col, row + 1, seed) * (1 - sx) + grainAt(col + 1, row + 1, seed) * sx;
    return a * (1 - sy) + b * sy;
  }

  // Grade the page after the geometry so the paper texture runs to every edge.
  const output = new Uint8ClampedArray(pixels);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const at = index * 4;
      const r = pixels[at];
      const g = pixels[at + 1];
      const b = pixels[at + 2];
      const low = Math.min(r, g, b);
      const chroma = Math.max(r, g, b) - low;
      if (low > 228 && chroma < 12) {
        const strength = 0.86 + 0.29 * v + 0.26 * mottling(x, y, 235, 47);
        const grain = 9.5 * grainAt(x, y, 101) + 7.5 * mottling(x, y, 3, 83) + 4.8 * mottling(x, y, 15, 59);
        const shade = Math.max(0, 7.5 + 2.1 * v + 0.9 * x / width + 3.4 * mottling(x, y, 135, 19) - strength * grain);
        const paper = shade * ((low - 228) / 27) * (1 - chroma / 12);
        for (let c = 0; c < 3; c++) output[at + c] -= paper;
      }
      if (!ink[index] || x < 1 || x + 1 === width || y < 1 || y + 1 === height) continue;
      const stride = width * 4;
      const adjacent = [at - 4, at + 4, at - stride, at + stride];
      const isRed = (offset) => pixels[offset] > 95 &&
        pixels[offset] - pixels[offset + 1] > 45 && pixels[offset] - pixels[offset + 2] > 35;
      const isDark = (offset) => Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 145 &&
        Math.abs(pixels[offset] - pixels[offset + 1]) < 18;
      // Only mix pigment where the existing red ink meets a text stroke.
      if (isRed(at) && adjacent.some(isDark)) {
        const contact = 0.6 + grainAt(x, y, 179) * 0.35;
        for (let c = 0; c < 3; c++) output[at + c] -= pixels[at + c] * 0.10 * contact;
      } else if (isDark(at) && adjacent.some(isRed)) {
        output[at + 1] -= 5;
        output[at + 2] -= 4;
      }
      if (chroma > 16) continue;
      const neighbors = [at - 4, at + 4, at - stride, at + stride];
      if (low > 174 && neighbors.every((p) => pixels[p + 1] > 174)) continue;
      for (let c = 0; c < 3; c++) {
        const mean = (pixels[at - 4 + c] + pixels[at + 4 + c] + pixels[at - stride + c] + pixels[at + stride + c]) / 4;
        output[at + c] += 0.27 * (mean - pixels[at + c]);
      }
    }
  }
  warped.data.set(output);
  context.putImageData(warped, 0, 0);
}

module.exports = { finishReportPage };
