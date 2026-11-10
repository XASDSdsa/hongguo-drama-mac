module.exports = async (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createPublicKey } = require('node:crypto');
  const key = fs.readFileSync(path.join(context.packager.projectDir, 'src/native/license/public-key.pem'));
  if (createPublicKey(key).asymmetricKeyType !== 'ed25519') throw new Error('缺少有效的设备授权公钥');
  if (context.electronPlatformName === 'win32') {
    const office = path.join(context.packager.projectDir, 'build/libreoffice/win32-x64/program');
    for (const file of ['soffice.com', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
      if (!fs.existsSync(path.join(office, file))) {
        throw new Error(`报告转换组件缺少 ${file}，请先运行 npm run setup:office:win`);
      }
    }
  }
  if (context.electronPlatformName === 'darwin') {
    const office = path.join(context.packager.projectDir, 'build/libreoffice/darwin-arm64/LibreOffice.app/Contents/MacOS/soffice');
    if (!fs.existsSync(office)) throw new Error('缺少报告转换组件，请先运行 npm run setup:office:mac');
  }
  require('./check-title-fonts.cjs').verifyBundle(context.packager.projectDir);
  await require('./check-faster-whisper-bundle.cjs')(context);
  require('./check-video-structure-bundle.cjs').verifyBundle(
    context.packager.projectDir,
    context.electronPlatformName,
    require('builder-util').Arch[context.arch],
  );
  require('./check-jianying-runtime.cjs').verifyBundle(
    context.packager.projectDir,
    context.electronPlatformName,
    require('builder-util').Arch[context.arch],
  );
};
