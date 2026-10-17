'use strict';
// Regression: a rotated phone video must be rotated exactly once when the working copy is made.
// ffmpeg applies the rotation itself; an extra transpose used to turn it back (320x180 instead of 180x320).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { probeMedia, normalizeMedia, mediaNeedsNormalization } = require('../src/native/reconstruction-media');

const ffmpeg = process.env.STRUCTURE_TEST_FFMPEG || path.resolve('build/ffmpeg/darwin-arm64/ffmpeg');
const ffprobe = process.env.STRUCTURE_TEST_FFPROBE || path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

function make(args) {
  const result = spawnSync(ffmpeg, ['-nostdin', '-y', '-v', 'error', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'media-rotation-'));
  try {
    const flat = path.join(temp, 'flat.mp4');
    const rotated = path.join(temp, 'rotated.mp4');
    make(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat]);
    make(['-display_rotation', '90', '-i', flat, '-c', 'copy', rotated]);
    const media = await probeMedia(ffprobe, rotated);
    assert.equal(media.width, 320);
    assert.equal(media.height, 180);
    assert.equal(Math.abs(media.rotation), 90);
    assert.equal(mediaNeedsNormalization(media), true);
    const normalized = await normalizeMedia({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, media, outputPath: path.join(temp, 'work', 'working.mp4') });
    assert.equal(normalized.normalized, true);
    assert.equal(normalized.rotation, 0);
    assert.deepEqual([normalized.width, normalized.height], [180, 320]);
    assert.equal(mediaNeedsNormalization(normalized), false);
    console.log('PASS rotated source is rotated once; working copy is upright with no rotation metadata');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
