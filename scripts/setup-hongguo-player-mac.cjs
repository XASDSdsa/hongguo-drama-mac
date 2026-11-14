'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const JRE_SHA = 'a5ab5bacd6e719d5a5570580ed14dceb2ed532208a39af927906b9742da1745e';
const SOURCE_SHA = 'f0aac3de576bd494d94ec206753a2ee568c45a1b98e645d293afd6fb73f273b2';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));
function download(url, file, digest) {
  execFileSync('curl', ['--fail', '--location', '--retry', '3', '--silent', '--show-error', url, '--output', file], { stdio: 'inherit' });
  assert.equal(hash(file), digest, 'Downloaded component checksum');
}
function verifyBundle(projectDir = root) {
  const directory = path.join(projectDir, 'build/hongguo-player/darwin-arm64');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json')));
  assert.equal(manifest.runtimeSha256, JRE_SHA);
  for (const name of ['runtime/Contents/Home/bin/java', 'player.jar', 'LICENSE.hongguotv.txt']) assert.ok(manifest.files.some(f => f.path === name));
  for (const item of manifest.files) {
    assert.ok(!path.isAbsolute(item.path) && !item.path.split('/').includes('..'));
    assert.equal(hash(path.join(directory, item.path)), item.sha256, item.path);
  }
  console.log('PASS Mac native resolver bundle and pinned ARM64 runtime checksums');
}
async function main() {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-native-player-'));
  const output = path.join(root, 'build/hongguo-player/darwin-arm64');
  fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
  try {
    const baseline = process.argv[2] || process.env.HONGGUO_CORE_BASELINE;
    if (baseline) {
      execFileSync('git', ['diff', '--exit-code', '455cf677e758b05ceec49c5b7955a54e000365f1', '--', 'scripts/hongguo-player'], { cwd: root, stdio: 'inherit' });
      assert.equal(hash(baseline), '9f07dc0b2d0f38355b7def6c9e4de9d341241bdfcf832b0f1e5a900c9104bad8');
      execFileSync('unzip', ['-q', baseline, '-d', path.join(temp, 'base')]);
      fs.cpSync(path.join(temp, 'base/hongguo-player'), output, { recursive: true });
    } else {
      // Building from source remains possible without access to the private build baseline.
      const source = path.join(temp, 'source.zip');
      download('https://github.com/N3urda/hongguoTV/releases/download/kotlin-v0.11.1/hongguotv-kotlin-v0.11.1-source.zip', source, SOURCE_SHA);
      execFileSync('unzip', ['-q', source, '-d', path.join(temp, 'source')]);
      const original = path.join(temp, 'source/hongguotv-kotlin-v0.11.1');
      const project = path.join(root, 'scripts/hongguo-player');
      const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
      execFileSync(java, ['-classpath', path.join(original, 'kotlin-tv/gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', '-p', project,
        '-PcoreSource=' + path.join(original, 'kotlin-tv/core/src/main/kotlin'), '--no-daemon', '--console=plain', 'bundle'], { stdio: 'inherit' });
      fs.cpSync(path.join(project, 'build/bundle'), output, { recursive: true });
      fs.copyFileSync(path.join(original, 'LICENSE'), path.join(output, 'LICENSE.hongguotv.txt'));
      fs.copyFileSync(path.join(original, 'kotlin-tv/NOTICE.md'), path.join(output, 'NOTICE.hongguotv.md'));
    }
    fs.rmSync(path.join(output, 'bundle.json'), { force: true });
    const archive = path.join(temp, 'jre.tar.gz');
    download('https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jre_aarch64_mac_hotspot_17.0.21_9.tar.gz', archive, JRE_SHA);
    fs.mkdirSync(path.join(temp, 'jre'));
    execFileSync('tar', ['-xzf', archive, '-C', path.join(temp, 'jre')]);
    const jre = fs.readdirSync(path.join(temp, 'jre')).find(name => fs.existsSync(path.join(temp, 'jre', name, 'Contents/Home/bin/java')));
    assert.ok(jre, 'Apple Silicon JRE layout');
    fs.cpSync(path.join(temp, 'jre', jre), path.join(output, 'runtime'), { recursive: true, verbatimSymlinks: true });
    fs.writeFileSync(path.join(output, 'SOURCE.txt'), 'hongguoTV kotlin-v0.11.1, GPL-3.0-only\nhttps://github.com/N3urda/hongguoTV/releases/tag/kotlin-v0.11.1\nSource SHA256 ' + SOURCE_SHA + '\nDesktop adapter source: scripts/hongguo-player in this repository.\nTemurin 17.0.21+9 macOS ARM64 JRE, unmodified before app signing. Runtime licenses are in runtime/Contents/Home/legal.\nOpenJDK source: https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jdk-sources_17.0.21_9.tar.gz\n');
    const files = walk(output).map(file => ({ path: path.relative(output, file).split(path.sep).join('/'), sha256: hash(file) }));
    fs.writeFileSync(path.join(output, 'bundle.json'), JSON.stringify({ sourceVersion: '0.11.1', sourceSha256: SOURCE_SHA, runtimeSha256: JRE_SHA, files }, null, 2));
    verifyBundle();
    const java = path.join(output, 'runtime/Contents/Home/bin/java');
    execFileSync(java, ['-version'], { stdio: 'inherit' });
    const result = JSON.parse(execFileSync(java, ['-cp', [path.join(output, 'player.jar'), path.join(output, 'lib/*')].join(path.delimiter), 'com.hongguotv.core.DesktopPlayerKt', 'invalid-id'], { encoding: 'utf8', timeout: 20000 }));
    assert.equal(result.ok, false, 'Native resolver starts and returns structured validation without network');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
module.exports = { verifyBundle };
if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
