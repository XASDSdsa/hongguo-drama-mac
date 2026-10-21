'use strict';
// 快速更新包：只有软件代码（resources/app.asar + 剪映草稿脚本 resources/workflow/*.py），
// 装在已有的完整版上就能用，不用重新打 2GB 的安装包。
//
// app.asar 里只有 JavaScript、页面和 axios（没有原生模块），和平台无关：这里在 Linux 上用 electron-builder
// 按同一份打包配置生成（文件清单、package.json 处理都和正式安装包一样），几分钟就好。
//
// 用法：先 npm run build:react，再 node scripts/make-quick-update.cjs [输出文件夹]
// 产物：<输出文件夹>/ai-drama-assistant-<版本>-update.zip
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const version = pkg.version;
// 快速更新只换代码：装着的完整版里要有这些运行库。运行库改了就得出完整安装包，并把这里改成那个版本。
const REQUIRES = '1.2.6';

async function buildAsar(outputDir) {
  const { build, Platform, Arch } = require('electron-builder');
  const config = JSON.parse(JSON.stringify(pkg.build));
  delete config.beforePack; // 那一步检查运行库；快速更新不带运行库
  config.directories = { output: outputDir };
  // 传配置文件（不是对象）：对象会和 package.json 的 build 合并，删掉的 beforePack 又回来了。
  const configFile = path.join(outputDir, '..', 'quick-builder.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config));
  await build({
    targets: Platform.LINUX.createTarget('dir', Arch.x64),
    config: configFile,
    publish: 'never',
  });
  return path.join(outputDir, 'linux-unpacked', 'resources');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'quick'));
  const work = path.join(out, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  if (!fs.existsSync(path.join(root, 'dist-react', 'index.html'))) throw new Error('先运行 npm run build:react');

  const resources = await buildAsar(path.join(work, 'builder'));
  const asar = path.join(resources, 'app.asar');
  const { extractFile, listPackage } = require('@electron/asar');
  const inside = JSON.parse(extractFile(asar, 'package.json').toString());
  if (inside.version !== version)
    throw new Error(`app.asar 里的版本 ${inside.version} 和 package.json ${version} 不一致`);
  const files = listPackage(asar).map((file) => file.replace(/\\/g, '/'));
  for (const need of ['/main.js', '/preload.js', '/dist-react/index.html', '/src/store.js', '/node_modules/axios'])
    if (!files.includes(need)) throw new Error(`app.asar 里缺少 ${need}`);

  const stage = path.join(work, 'stage');
  fs.mkdirSync(path.join(stage, 'workflow'), { recursive: true });
  fs.copyFileSync(asar, path.join(stage, 'app.asar'));
  for (const item of pkg.build.extraResources) {
    if (!String(item.to).startsWith('workflow/')) continue;
    fs.copyFileSync(path.join(root, item.from), path.join(stage, item.to));
  }
  for (const name of ['update.cmd', 'update.ps1', 'README.txt'])
    fs.copyFileSync(path.join(__dirname, 'quick-update', name), path.join(stage, name));
  const manifest = {
    product: 'AI短剧助手',
    version,
    requires: REQUIRES,
    sha256: sha256(path.join(stage, 'app.asar')),
    commit: process.env.GITHUB_SHA || '',
    builtAt: new Date().toISOString(),
    workflow: fs.readdirSync(path.join(stage, 'workflow')).sort(),
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const zipName = `ai-drama-assistant-${version}-update.zip`;
  const zipPath = path.join(out, zipName);
  fs.rmSync(zipPath, { force: true });
  // 文件名都是英文：Windows 自带的解压不会乱码。
  const zipped = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: stage, encoding: 'utf8' });
  if (zipped.status !== 0) throw new Error(`zip 失败：${zipped.stderr || zipped.error}`);
  fs.rmSync(work, { recursive: true, force: true });
  const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(JSON.stringify({ zip: zipPath, size: `${size}MB`, ...manifest }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
