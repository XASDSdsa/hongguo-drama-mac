'use strict';
// Transform a disposable app snapshot before ASAR hashes/signatures are generated.
// Never overwrite the editable source tree or transform third-party dependencies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const obfuscator = require('javascript-obfuscator');
const root = path.join(__dirname, '..');
const sha = data => createHash('sha256').update(data).digest('hex');
function transform(source, name) {
  return Buffer.from(obfuscator.obfuscate(source.toString(), {
    target: name.endsWith('/activation.js') ? 'browser-no-eval' : 'node', compact: true, seed: parseInt(sha(name + sha(source)).slice(0, 8), 16) || 1,
    renameGlobals: false, renameProperties: false, controlFlowFlattening: false,
    deadCodeInjection: false, debugProtection: false, selfDefending: false,
    stringArray: true, stringArrayThreshold: 0.75, stringArrayEncoding: ['base64'],
    splitStrings: false, sourceMap: false, ignoreImports: true,
  }).getObfuscatedCode());
}
function prepareProtectedApp() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changefilename-protected-'));
  try {
    for (const name of ['main.js', 'preload.js', 'package.json', 'src/native', 'src/store.js', 'dist-react']) {
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
    }
    const appPackage = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    for (const key of ['build', 'scripts', 'devDependencies']) delete appPackage[key];
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(appPackage));
    const records = {};
    for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      const name = path.relative(directory, file).split(path.sep).join('/');
      if (name.endsWith('.map')) throw new Error('Source maps must not ship: ' + name);
      if (!/\.(?:c?js)$/.test(name)) continue;
      const source = fs.readFileSync(file);
      // Vite output is already minified; keep browser compatibility and source maps disabled.
      const output = name.startsWith('dist-react/') ? source : transform(source, name);
      fs.writeFileSync(file, output);
      records[name] = { source: sha(source), output: sha(output), obfuscated: !name.startsWith('dist-react/') };
    }
    const manifest = { version: require('../package.json').version, tool: 'javascript-obfuscator@4.1.1', files: records };
    fs.writeFileSync(path.join(directory, 'protected-build.json'), JSON.stringify(manifest));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return { directory, manifest, dispose: () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }) };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
function verifyProtectedArchive(archive) {
  const assert = require('node:assert/strict');
  const { extractFile, listPackage } = require('@electron/asar');
  const manifest = JSON.parse(extractFile(archive, 'protected-build.json'));
  assert.equal(manifest.version, require('../package.json').version);
  for (const [name, record] of Object.entries(manifest.files)) {
    const source = fs.readFileSync(path.join(root, name));
    assert.equal(sha(source), record.source, 'Source changed: ' + name);
    const output = record.obfuscated ? transform(source, name) : source;
    assert.equal(sha(output), record.output, 'Reproducible transform: ' + name);
    assert.equal(sha(extractFile(archive, name)), record.output, 'Packaged bytes: ' + name);
  }
  for (const name of ['main.js', 'preload.js', 'src/native/license/keygate.cjs', 'src/native/license/runtime-session.cjs', 'src/native/license/operation-guard.cjs']) {
    assert.ok(manifest.files[name]?.obfuscated && manifest.files[name].source !== manifest.files[name].output, name);
  }
  assert.ok(!listPackage(archive).some(name => name.endsWith('.map')));
  return manifest;
}
module.exports = { prepareProtectedApp, verifyProtectedArchive, transform };
