module.exports = async (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createPublicKey } = require('node:crypto');
  const key = fs.readFileSync(path.join(context.packager.projectDir, 'src/native/license/public-key.pem'));
  if (createPublicKey(key).asymmetricKeyType !== 'ed25519') throw new Error('缺少有效的设备授权公钥');
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
