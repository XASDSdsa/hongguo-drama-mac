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
build({ targets: Platform.MAC.createTarget('dmg', Arch.arm64), publish: 'never' })
  .catch(error => { console.error(error); process.exit(1); });
