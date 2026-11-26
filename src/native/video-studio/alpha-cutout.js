'use strict';
/**
 * Pure Node.js transparent-background PNG cutout utility (Windows & macOS, zero Python).
 * Uses bundled ffmpeg to decode any JPG/PNG/WebP into raw PNG + `pngjs` border-seeded
 * flood-fill with soft alpha feathering and enclosed white-loop removal (e.g. pendant cords).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PNG } = require('pngjs');

function execFileBufferAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function cutoutWhiteBgToPng({ ffmpegPath, inputPath, outputPngPath, thresh = 242, feather = 225 }) {
  const pngBuf = await execFileBufferAsync(ffmpegPath, [
    '-y', '-i', inputPath, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
  ]);
  const png = PNG.sync.read(pngBuf);
  const { width: w, height: h, data } = png;
  const visited = new Uint8Array(w * h);
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const trySeed = (x, y) => {
    const idx = y * w + x;
    if (visited[idx]) return;
    const p = idx * 4;
    if (data[p] >= feather && data[p + 1] >= feather && data[p + 2] >= feather) {
      visited[idx] = 1;
      qx[tail] = x;
      qy[tail] = y;
      tail += 1;
    }
  };

  for (let x = 0; x < w; x += 1) {
    trySeed(x, 0);
    trySeed(x, h - 1);
  }
  for (let y = 0; y < h; y += 1) {
    trySeed(0, y);
    trySeed(w - 1, y);
  }

  const span = Math.max(1, thresh - feather);
  const applyFade = (p) => {
    const m = Math.min(data[p], data[p + 1], data[p + 2]);
    if (m >= thresh) {
      data[p + 3] = 0;
    } else {
      const alpha = Math.round((255 * (thresh - m)) / span);
      data[p + 3] = Math.max(0, Math.min(255, alpha));
    }
  };

  while (head < tail) {
    const x = qx[head];
    const y = qy[head];
    head += 1;
    applyFade((y * w + x) * 4);
    if (x > 0) trySeed(x - 1, y);
    if (x + 1 < w) trySeed(x + 1, y);
    if (y > 0) trySeed(x, y - 1);
    if (y + 1 < h) trySeed(x, y + 1);
  }

  // Also clear large enclosed pure-white holes (>= 400 px, e.g., inside necklace/cord loops)
  for (let sy = 1; sy < h - 1; sy += 8) {
    for (let sx = 1; sx < w - 1; sx += 8) {
      const sIdx = sy * w + sx;
      if (visited[sIdx]) continue;
      const sp = sIdx * 4;
      if (data[sp] >= 248 && data[sp + 1] >= 248 && data[sp + 2] >= 248) {
        const comp = [];
        let ch = 0;
        let ct = 0;
        visited[sIdx] = 1;
        qx[ct] = sx;
        qy[ct] = sy;
        ct += 1;
        while (ch < ct) {
          const cx = qx[ch];
          const cy = qy[ch];
          ch += 1;
          comp.push(cy * w + cx);
          const nbrs = [
            [cx - 1, cy],
            [cx + 1, cy],
            [cx, cy - 1],
            [cx, cy + 1],
          ];
          for (let i = 0; i < 4; i += 1) {
            const nx = nbrs[i][0];
            const ny = nbrs[i][1];
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              const ni = ny * w + nx;
              if (!visited[ni]) {
                const np = ni * 4;
                if (data[np] >= feather && data[np + 1] >= feather && data[np + 2] >= feather) {
                  visited[ni] = 1;
                  qx[ct] = nx;
                  qy[ct] = ny;
                  ct += 1;
                }
              }
            }
          }
        }
        if (comp.length >= 400) {
          for (let i = 0; i < comp.length; i += 1) {
            applyFade(comp[i] * 4);
          }
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(outputPngPath), { recursive: true });
  fs.writeFileSync(outputPngPath, PNG.sync.write(png));
  return { width: w, height: h, path: outputPngPath };
}

module.exports = { cutoutWhiteBgToPng };
