'use strict';
// Run after electron-builder NSIS; these three files are uploaded in the owner portal.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');
const pkg = require('../package.json');

async function digest(file, algorithm, encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest(encoding);
}
async function main() {
  const folder = path.resolve(process.argv[2] || 'dist');
  const file = `changeFileName-Setup-${pkg.version}.exe`;
  const installer = path.join(folder, file);
  const metadataFile = path.join(folder, 'latest.yml');
  // Keep the dense NSIS archive below its 2 GiB mmap limit, then create the
  // standard external blockmap independently using builder's own implementation.
  if (!fs.existsSync(installer + '.blockmap')) {
    const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
    const info = await buildBlockMap(installer, 'gzip', installer + '.blockmap');
    const metadata = { version: pkg.version, files: [{ url: file, size: info.size, sha512: info.sha512 }],
      path: file, sha512: info.sha512, releaseDate: new Date().toISOString() };
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
  }
  const metadata = yaml.load(fs.readFileSync(metadataFile, 'utf8'));
  if (metadata.version !== pkg.version || metadata.files?.length !== 1 || metadata.files[0].url !== file) throw new Error('Builder release metadata mismatch');
  const sha512 = await digest(installer, 'sha512', 'base64');
  if (sha512 !== metadata.files[0].sha512 || fs.statSync(installer).size !== metadata.files[0].size) throw new Error('Installer checksum mismatch');
  const result = { ...metadata, blockmapSha256: await digest(installer + '.blockmap', 'sha256'),
    releaseNotes: process.env.UPDATE_RELEASE_NOTES || metadata.releaseNotes || '软件功能改进与问题修复。' };
  fs.writeFileSync(path.join(folder, `release-${pkg.version}.json`), JSON.stringify(result, null, 2));
  console.log('PASS update release metadata, installer SHA512 and differential blockmap');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
