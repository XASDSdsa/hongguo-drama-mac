'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const axios = require('axios');
const root = path.resolve(__dirname, '..');
const SOURCE_SHA = 'f0aac3de576bd494d94ec206753a2ee568c45a1b98e645d293afd6fb73f273b2';
const JRE_SHA = 'fe4656bd78fb09812dc38c49da777f79cc33e7ee435a254be82f9e7f40d9d117';
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
async function download(url, file, expected) {
  if (fs.existsSync(file) && sha(fs.readFileSync(file)) === expected) return;
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000, maxContentLength: 250 * 1024 * 1024 });
  const data = Buffer.from(response.data);
  if (sha(data) !== expected) throw new Error('取源组件下载校验失败');
  fs.writeFileSync(file, data);
}
function unzip(file, destination) {
  if (process.platform === 'win32') {
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(file)} -DestinationPath ${quote(destination)} -Force`], { stdio: 'inherit', windowsHide: true });
  } else execFileSync('unzip', ['-q', '-o', file, '-d', destination]);
}
(async () => {
  const cache = path.join(root, 'build/hongguo-player/cache');
  const output = path.join(root, 'build/hongguo-player/win32-x64');
  fs.mkdirSync(cache, { recursive: true });
  fs.rmSync(output, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(output, { recursive: true });
  const sourceZip = path.join(cache, 'hongguotv-0.11.1.zip');
  await download('https://github.com/N3urda/hongguoTV/releases/download/kotlin-v0.11.1/hongguotv-kotlin-v0.11.1-source.zip', sourceZip, SOURCE_SHA);
  const extracted = path.join(cache, 'source');
  unzip(sourceZip, extracted);
  const original = path.join(extracted, 'hongguotv-kotlin-v0.11.1');
  const project = path.join(root, 'scripts/hongguo-player');
  const java = path.join(process.env.JAVA_HOME || '', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  execFileSync(java, ['-classpath', path.join(original, 'kotlin-tv/gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', '-p', project,
    `-PcoreSource=${path.join(original, 'kotlin-tv/core/src/main/kotlin')}`, '--no-daemon', '--console=plain', 'bundle'], { stdio: 'inherit', env: process.env });
  fs.cpSync(path.join(project, 'build/bundle'), output, { recursive: true });
  fs.copyFileSync(path.join(original, 'LICENSE'), path.join(output, 'LICENSE.hongguotv.txt'));
  fs.copyFileSync(path.join(original, 'kotlin-tv/NOTICE.md'), path.join(output, 'NOTICE.hongguotv.md'));
  fs.writeFileSync(path.join(output, 'SOURCE.txt'), 'hongguoTV kotlin-v0.11.1, GPL-3.0-only\nhttps://github.com/N3urda/hongguoTV/releases/tag/kotlin-v0.11.1\nSource archive SHA256 ' + SOURCE_SHA + '\nDesktop adapter source: scripts/hongguo-player in the changeFileName source repository.\nTemurin 17.0.21+9 runtime and its licenses are included in runtime/.\n');
  const runtimeZip = path.join(cache, 'temurin17-win32-x64.zip');
  await download('https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jre_x64_windows_hotspot_17.0.21_9.zip', runtimeZip, JRE_SHA);
  const runtime = path.join(cache, 'jre');
  unzip(runtimeZip, runtime);
  const entry = fs.readdirSync(runtime).find(name => fs.existsSync(path.join(runtime, name, 'bin/java.exe')));
  if (!entry) throw new Error('取源运行库缺少 java.exe');
  fs.cpSync(path.join(runtime, entry), path.join(output, 'runtime'), { recursive: true });
  const files = fs.readdirSync(output, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => {
    const file = path.join(item.parentPath, item.name);
    return { path: path.relative(output, file).split(path.sep).join('/'), sha256: sha(fs.readFileSync(file)) };
  });
  fs.writeFileSync(path.join(output, 'bundle.json'), JSON.stringify({ sourceVersion: '0.11.1', sourceSha256: SOURCE_SHA, runtimeSha256: JRE_SHA, files }, null, 2));
  console.log('Prepared and verified hongguoTV player core and app-local Windows runtime');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
