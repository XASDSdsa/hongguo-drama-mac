/**
 * setup-ffmpeg.js —— 打包前置：下载并放置内置 ffmpeg
 *
 * 为什么需要：
 *   视频去重、合并与兼容转码依赖 ffmpeg，二进制不纳入版本管理。
 *   clone 仓库后执行一次本脚本，即可把 ffmpeg.exe / ffprobe.exe 放到
 *   build/ffmpeg/，之后 `npm run build` 会通过 extraResources 打进安装包。
 *
 * Windows 工具链固定使用 WINDOWS-BUILD.json 中兼容 NVENC API 12.2 的构建。
 * 同一 FFmpeg 版本的其他构建不能替代它；压缩包和两个程序均校验 SHA256。
 *
 * 用法：node scripts/setup-ffmpeg.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createHash } = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'build', 'ffmpeg');
const ZIP = path.join(ROOT, 'build', 'ffmpeg-windows.zip');
const TMP = path.join(ROOT, 'build', '_ffmpeg_tmp');
const BUILD = JSON.parse(fs.readFileSync(path.join(DEST, 'WINDOWS-BUILD.json'), 'utf8'));

const URL =
  // A mirror may serve the same pinned archive, never a different version.
  process.env.FFMPEG_ZIP_URL ||
  BUILD.url;

function hasPinnedBinary(file, name) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= 1024 * 1024) return false;
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== BUILD.binaries[`${name}.exe`]) return false;
    const output = execFileSync(file, ['-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    const reported = output.match(new RegExp(`^${name} version ([^\\s]+)`))?.[1];
    return reported === BUILD.buildVersion;
  } catch (_) { return false; }
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向过多'));
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        let lastPct = -1;
        const ws = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            if (pct >= lastPct + 10) { lastPct = pct; console.log(`  下载中 ${pct}%`); }
          }
        });
        res.pipe(ws);
        ws.on('finish', () => resolve());
        ws.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  const ffmpegExe = path.join(DEST, 'ffmpeg.exe');
  const ffprobeExe = path.join(DEST, 'ffprobe.exe');

  // 许可证文本随源码入库，这里只做一次存在性校验（合规需要）
  const requiredLicenses = ['COPYING.GPLv3', 'COPYING.GPLv2', 'COPYING.LGPLv2.1', 'LICENSE.md', 'FFMPEG-NOTICE.txt'];
  const missing = requiredLicenses.filter((f) => !fs.existsSync(path.join(DEST, f)));
  if (missing.length) {
    console.warn('警告：build/ffmpeg/ 缺少以下许可文件，分发前请补回：');
    missing.forEach((f) => console.warn('  - ' + f));
  }

  if (hasPinnedBinary(ffmpegExe, 'ffmpeg') && hasPinnedBinary(ffprobeExe, 'ffprobe')) {
    console.log(`FFmpeg / FFprobe ${BUILD.buildVersion} 已就绪：${DEST}`);
    return;
  }

  fs.mkdirSync(DEST, { recursive: true });
  fs.mkdirSync(path.dirname(ZIP), { recursive: true });

  console.log(`正在下载兼容构建 FFmpeg ${BUILD.buildVersion}…`);
  await download(URL, ZIP);
  const digest = createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
  if (digest !== BUILD.sha256) throw new Error(`FFmpeg ${BUILD.buildVersion} 压缩包 SHA256 校验失败，未替换现有工具`);
  console.log('下载完成：' + (fs.statSync(ZIP).size / 1048576).toFixed(1) + 'MB');

  console.log('正在解压…');
  fs.rmSync(TMP, { recursive: true, force: true });
  // 用 PowerShell 解压（Windows 自带，无需额外依赖）
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${TMP}' -Force`,
  ], { stdio: 'inherit' });

  const find = (dir, name) => {
    let out = null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name) return p;
      if (e.isDirectory()) { const r = find(p, name); if (r) return r; }
    }
    return out;
  };

  const srcFf = find(TMP, 'ffmpeg.exe');
  const srcFp = find(TMP, 'ffprobe.exe');
  if (!srcFf || !srcFp) throw new Error('压缩包里没找到 ffmpeg.exe / ffprobe.exe');
  if (!hasPinnedBinary(srcFf, 'ffmpeg') || !hasPinnedBinary(srcFp, 'ffprobe')) {
    throw new Error(`解压后的 FFmpeg / FFprobe 构建或 SHA256 不匹配：需要 ${BUILD.buildVersion}`);
  }

  fs.copyFileSync(srcFf, ffmpegExe);
  fs.copyFileSync(srcFp, ffprobeExe);
  const copyMetadata = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) copyMetadata(source);
      else if (entry.isFile() && (/\.txt$/i.test(entry.name) || entry.name === 'SHA256SUMS')) {
        fs.copyFileSync(source, path.join(DEST, entry.name));
      }
    }
  };
  copyMetadata(TMP);

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });

  console.log('完成：');
  console.log('  ' + ffmpegExe + '  ' + (fs.statSync(ffmpegExe).size / 1048576).toFixed(1) + 'MB');
  console.log('  ' + ffprobeExe + '  ' + (fs.statSync(ffprobeExe).size / 1048576).toFixed(1) + 'MB');
})().catch((e) => {
  console.error('失败：' + e.message);
  console.error(`请使用 WINDOWS-BUILD.json 指定的兼容构建：${BUILD.url}`);
  process.exit(1);
});
