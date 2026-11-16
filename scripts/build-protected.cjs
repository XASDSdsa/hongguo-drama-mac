'use strict';
const { build, Platform, Arch } = require('electron-builder');
const fs = require('node:fs');
const path = require('node:path');
const { prepareProtectedApp } = require('./protect-app.cjs');
async function main() {
  const [platform, target = 'nsis'] = process.argv.slice(2);
  if (platform !== 'win') throw new Error('Use build-mac-dmg.cjs for Mac builds');
  const snapshot = prepareProtectedApp();
  const config = structuredClone(require('../package.json').build);
  config.directories.app = snapshot.directory;
  config.files.push('protected-build.json', '!**/*.map');
  const configFile = path.join(snapshot.directory, 'builder.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  try { await build({ targets: Platform.WINDOWS.createTarget(target, Arch.x64), config: configFile, publish: 'never' }); }
  finally { snapshot.dispose(); }
}
main().catch(error => { console.error(error); process.exit(1); });
