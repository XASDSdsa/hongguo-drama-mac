module.exports = async (context) => {
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
