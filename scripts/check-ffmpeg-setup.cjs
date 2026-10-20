const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createHash } = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const implementation = fs.readFileSync(path.join(__dirname, 'setup-ffmpeg.js'), 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const binaries = { 'ffmpeg.exe': Buffer.from('compatible ffmpeg'), 'ffprobe.exe': Buffer.from('compatible ffprobe') };
const archive = Buffer.from('compatible archive');
const manifest = {
  version: '9.0.2',
  buildVersion: '9.0.2-aidrama-nvenc11.1',
  url: 'https://github.com/XASDSdsa/hongguo-drama-mac/releases/download/v1.1.41-breath-on-shot/ffmpeg-9.0.2-nvenc11.1-win-x64.zip',
  sha256: hash(archive),
  binaries: Object.fromEntries(Object.entries(binaries).map(([name, data]) => [name, hash(data)])),
};
const dest = path.resolve(__dirname, '..', 'build', 'ffmpeg');
const tmp = path.resolve(__dirname, '..', 'build', '_ffmpeg_tmp');

async function setup(options = {}) {
  const downloads = [],
    probes = [],
    copied = [],
    errors = [],
    exits = [];
  const files = new Map([[path.join(dest, 'WINDOWS-BUILD.json'), Buffer.from(JSON.stringify(manifest))]]);
  for (const [name, value] of Object.entries(options.cache || binaries))
    if (value) files.set(path.join(dest, name), value);
  const versions = options.versions || { ffmpeg: manifest.buildVersion, ffprobe: manifest.buildVersion };
  const virtualFs = {
    existsSync: (file) => files.has(file),
    statSync: () => ({ size: 2 * 1024 * 1024 }),
    readFileSync: (file, encoding) => {
      const value = files.get(file);
      if (!value) throw new Error('ENOENT');
      return encoding ? value.toString(encoding) : value;
    },
    mkdirSync() {},
    rmSync: (file) => {
      for (const key of files.keys()) if (key === file || key.startsWith(file + path.sep)) files.delete(key);
    },
    createWriteStream: (file) => {
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          files.set(file, Buffer.concat(chunks));
          callback();
        },
      });
    },
    readdirSync: (dir) => {
      const children = new Map();
      for (const file of files.keys())
        if (file.startsWith(dir + path.sep)) {
          const parts = file.slice(dir.length + 1).split(path.sep);
          children.set(parts[0], parts.length > 1);
        }
      return [...children].map(([name, directory]) => ({
        name,
        isFile: () => !directory,
        isDirectory: () => directory,
      }));
    },
    copyFileSync: (source, target) => {
      assert.ok(files.has(source));
      copied.push(target);
      files.set(target, files.get(source));
    },
  };
  const context = {
    __dirname,
    module: { exports: {} },
    process: { env: {}, exit: (code) => exits.push(code) },
    console: { log() {}, warn() {}, error: (message) => errors.push(message) },
    require: (name) => {
      if (name === 'fs') return virtualFs;
      if (name === 'child_process')
        return {
          execFileSync: (file, args) => {
            if (file === 'powershell') {
              const root = path.join(tmp, 'release');
              for (const [name, value] of Object.entries(options.extracted || binaries))
                files.set(path.join(root, 'bin', name), value);
              files.set(path.join(root, 'BUILD-REPORT.txt'), Buffer.from('reproducible build'));
              files.set(path.join(root, 'SOURCES.txt'), Buffer.from('source commits'));
              files.set(path.join(root, 'SHA256SUMS'), Buffer.from('archive checksums'));
              files.set(path.join(root, 'licenses', 'nvEncodeAPI-LICENSE.txt'), Buffer.from('NVIDIA license'));
              return '';
            }
            assert.deepEqual(Array.from(args), ['-version']);
            const tool = path.basename(file, '.exe');
            probes.push(tool);
            const version = file.startsWith(tmp + path.sep)
              ? options.extractedVersion || manifest.buildVersion
              : versions[tool];
            if (version === null) throw new Error('Invalid executable');
            return `${tool} version ${version} Copyright\n`;
          },
        };
      if (name === 'https')
        return {
          get: (url, _options, callback) => {
            downloads.push(url);
            setImmediate(() => {
              const response = Readable.from([options.archive || archive]);
              response.statusCode = 200;
              response.headers = {};
              callback(response);
            });
            return {
              on() {
                return this;
              },
            };
          },
        };
      return require(name);
    },
  };
  vm.runInNewContext(implementation.replace('(async () => {', 'module.exports.ready = (async () => {'), context);
  await context.module.exports.ready;
  return { downloads, probes, copied, errors, exits, files };
}

async function main() {
  for (const [label, options] of [
    ['old version', { versions: { ffmpeg: '7.1', ffprobe: '7.1' } }],
    [
      'same version, wrong build',
      { versions: { ffmpeg: '9.0.2-essentials_build-www.gyan.dev', ffprobe: '9.0.2-essentials_build-www.gyan.dev' } },
    ],
    [
      'mixed cached builds',
      { versions: { ffmpeg: manifest.buildVersion, ffprobe: '9.0.2-essentials_build-www.gyan.dev' } },
    ],
    ['same build, wrong binary checksum', { cache: { ...binaries, 'ffmpeg.exe': Buffer.from('wrong ffmpeg') } }],
    ['missing cached executable', { cache: { 'ffmpeg.exe': binaries['ffmpeg.exe'] } }],
    ['invalid cached executable', { versions: { ffmpeg: null, ffprobe: manifest.buildVersion } }],
  ]) {
    const result = await setup(options);
    assert.deepEqual(result.downloads, [manifest.url], label);
    assert.deepEqual(result.errors, [], label);
    assert.deepEqual(result.exits, [], label);
    for (const [name, data] of Object.entries(binaries))
      assert.deepEqual(result.files.get(path.join(dest, name)), data);
    for (const name of ['BUILD-REPORT.txt', 'SOURCES.txt', 'SHA256SUMS', 'nvEncodeAPI-LICENSE.txt'])
      assert.ok(result.copied.includes(path.join(dest, name)), `Missing ${name}`);
    console.log(`PASS ${label} replaced with verified compatible build and metadata`);
  }
  const cached = await setup();
  assert.deepEqual(cached.downloads, []);
  assert.deepEqual(cached.probes, ['ffmpeg', 'ffprobe']);
  console.log('PASS exact checksum and build version pair reused');
  for (const [label, options] of [
    ['archive checksum mismatch', { archive: Buffer.from('corrupt archive') }],
    ['extracted binary checksum mismatch', { extracted: { ...binaries, 'ffprobe.exe': Buffer.from('corrupt probe') } }],
    ['extracted binary version mismatch', { extractedVersion: '9.0.2-other-build' }],
  ]) {
    const cache = { ...binaries, 'ffmpeg.exe': Buffer.from('old cache') };
    const result = await setup({ cache, ...options });
    assert.deepEqual(result.exits, [1], label);
    assert.deepEqual(result.copied, [], 'Neither executable may be copied until both verify');
    for (const [name, data] of Object.entries(cache))
      assert.deepEqual(result.files.get(path.join(dest, name)), data, label);
    console.log(`PASS ${label} preserves cached executables`);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
