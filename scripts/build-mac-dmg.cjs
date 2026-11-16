'use strict';
// osx-sign walks all resources before applying signIgnore, including thousands
// of LibreOffice icons. Bound its binary probes instead of exhausting macOS FDs.
const { createRequire } = require('node:module');
const signerRequire = createRequire(require.resolve('@electron/osx-sign'));
const binary = signerRequire('isbinaryfile');
const original = binary.isBinaryFile;
let available = 32;
const waiting = [];
binary.isBinaryFile = async (...args) => {
  if (available) available--;
  else await new Promise(resolve => waiting.push(resolve));
  try { return await original(...args); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else available++;
  }
};
const { build, Platform, Arch } = require('electron-builder');
const { prepareProtectedApp } = require('./protect-app.cjs');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const snapshot = prepareProtectedApp();
  const config = structuredClone(require('../package.json').build);
  config.directories.app = snapshot.directory;
  config.files.push('protected-build.json', '!**/*.map');
  const configFile = path.join(snapshot.directory, 'builder.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  try { await build({ targets: Platform.MAC.createTarget(process.argv.includes('--dir') ? 'dir' : 'dmg', Arch.arm64), config: configFile, publish: 'never' }); }
  finally { snapshot.dispose(); }
}
main()
  .catch(error => { console.error(error); process.exit(1); });
