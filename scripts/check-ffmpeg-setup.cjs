const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const implementation = fs.readFileSync(path.join(__dirname, 'setup-ffmpeg.js'), 'utf8');

function checkCache(label, versions, shouldDownload) {
  const downloads = [], probes = [];
  vm.runInNewContext(implementation, {
    __dirname, process: { env: {}, exit: () => { throw new Error('Unexpected setup failure'); } },
    console: { log() {}, warn() {}, error() {} },
    require: (name) => {
      if (name === 'fs') return {
        existsSync: () => true, statSync: () => ({ size: 2 * 1024 * 1024 }), mkdirSync() {},
      };
      if (name === 'child_process') return { execFileSync: (file, args) => {
        assert.deepEqual(Array.from(args), ['-version']);
        const tool = path.basename(file, '.exe');
        probes.push(tool);
        if (versions[tool] === null) throw new Error('Invalid executable');
        return `${tool} version ${versions[tool]}-essentials_build-www.gyan.dev Copyright\n`;
      } };
      if (name === 'https') return { get: (url) => {
        downloads.push(url);
        // Stop before network I/O. A pending Promise alone has no timers or
        // handles; the assertion is about taking the cache/download branch.
        return { on() { return this; } };
      } };
      return require(name);
    },
  });
  assert.equal(downloads.length, shouldDownload ? 1 : 0, label);
  if (shouldDownload) assert.match(downloads[0], /\/9\.0\.2\/ffmpeg-9\.0\.2-essentials_build\.zip$/);
  else assert.deepEqual(probes, ['ffmpeg', 'ffprobe'], 'Both cached executables must be version checked');
  console.log(`PASS ${label}`);
}

checkCache('old 7.1 cache must be replaced', { ffmpeg: '7.1', ffprobe: '7.1' }, true);
checkCache('mixed versions must be replaced', { ffmpeg: '9.0.2', ffprobe: '7.1' }, true);
checkCache('invalid cached executable must be replaced', { ffmpeg: null, ffprobe: '9.0.2' }, true);
checkCache('exact 9.0.2 pair can be reused', { ffmpeg: '9.0.2', ffprobe: '9.0.2' }, false);
checkCache('unverified newer versions cannot bypass pin', { ffmpeg: '9.0.20', ffprobe: '9.0.20' }, true);
