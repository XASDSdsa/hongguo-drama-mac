'use strict';
// Fandol 0.3, GPL with the font exception. Keep the upstream README and license with the fonts.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const files = {
  'FandolFang-Regular.otf': 'd838ad32ce2244d8144f408c37fe71065aba6fbbc80759a4d2aa2033948d5bc9',
  'FandolSong-Bold.otf': 'ffa76a70e128947a4dd22151d5ee829b23e24ce3cb6fe8ad49891cd1c2d9e9b9',
  README: '32537e063f4c7d4aebf016d5c8279cbce13f34fc8970f24b2578a3c04d0f8ca6',
  COPYING: '853b586f0d520493390e571431afaf36a5fbb27dcfd239338a7ee9b0505cb004',
};

const mirrors = [
  'https://mirrors.ibiblio.org/CTAN/fonts/fandol',
  'https://repo.huaweicloud.com/CTAN/fonts/fandol',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function setupReportFonts(destination) {
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(Object.entries(files).map(async ([name, expected]) => {
    const filename = path.join(destination, name.endsWith('.otf') ? name : `Fandol-${name}.txt`);
    const existing = await fs.readFile(filename).catch(() => null);
    if (existing && hash(existing) === expected) return;
    for (const mirror of mirrors) {
      try {
        const response = await fetch(`${mirror}/${name}`, { signal: AbortSignal.timeout(35_000) });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = Buffer.from(await response.arrayBuffer());
        if (hash(bytes) !== expected) throw new Error('SHA-256 mismatch');
        await fs.writeFile(filename, bytes);
        return;
      } catch (error) {
        console.warn(`Fandol ${name} from ${mirror}: ${error.message}`);
      }
    }
    throw new Error(`Could not obtain verified font asset: ${name}`);
  }));
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error('Pass the font destination directory');
  setupReportFonts(path.resolve(process.argv[2])).catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { setupReportFonts };
