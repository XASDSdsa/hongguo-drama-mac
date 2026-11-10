'use strict';
// 剧文件夹的结构：
//
// 剧文件夹/
// ├─ 原剧集信息.txt   原剧名、来源、总集数、已下载、已处理、原简介（数字自动更新；简介手改过的保留）
// ├─ 原剧集海报.jpg   （以前是「原剧」里的 封面.jpg）
// ├─ 新剧集信息.txt   新剧名、已处理、新简介（「AI 发布素材」里选定 / 保存的）
// ├─ 新剧集海报.jpg   （以前是 发布海报.jpg）
// ├─ 成本配置比例情况报告.docx  按本机导入的模板填好（「成本配置报告」里生成）
// ├─ 原剧/            原集视频
// ├─ 去重/            成品视频
// │  ├─ AI分镜工程图_第1集.jpg  最多四集分镜截图副本，不带剧名，集号补零跟视频一致
// │  ├─ 海报.jpg       新海报副本
// │  ├─ 集数.txt       实际成品集数
// │  └─ 简介.txt       已保存的新简介
// └─ 分镜工程图/      每集一张截图（页头 + 前两个分镜）
//    └─ 网页和提示词/  每集的网页、提示词 txt、参考图
//
// 以前的结构（「原剧」里的 封面 / 简介.txt，外层的 发布剧名.txt / 发布简介.txt / 发布海报.jpg，「视频提示词」文件夹）
// 打开管理剧集时自动挪成上面这样（视频一个都不动）；挪之前、挪不成时，旧位置照样认得。
const fs = require('node:fs');
const path = require('node:path');

const ORIGINAL_DIR = '原剧';
const ORIGINAL_INFO = '原剧集信息.txt';
const ORIGINAL_POSTER = '原剧集海报'; // + 原图的扩展名（.jpg / .png / .webp）
const NEW_INFO = '新剧集信息.txt';
const NEW_POSTER = '新剧集海报.jpg';
const STORYBOARD_DIR = '分镜工程图';
const STORYBOARD_PAGES = '网页和提示词';
const COST_REPORT = '成本配置比例情况报告.docx';
const COST_REPORT_PNG = '成本配置比例情况报告.png';
const POSTER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const LEGACY = {
  cover: '封面',
  synopsis: '简介.txt',
  title: '发布剧名.txt',
  newSynopsis: '发布简介.txt',
  poster: '发布海报.jpg',
  prompts: '视频提示词',
};

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
};
const isDir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch (_) {
    return false;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
};

/** 先写临时文件再换上去：写到一半出错不会留下半截文件。内容没变就不写（不动修改时间）。返回是否写了。 */
function writeIfChanged(file, text) {
  if (isFile(file) && readText(file) === text) return false;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
  return true;
}

// ---------- 两个信息文件 ----------

const PLACEHOLDER = /^（[^）]*）$/;

/** 读信息文件：「键：值」一行一项，「简介：」后面直到文件末尾都是简介。占位的（括号里的说明）当没填。 */
function parseInfo(text) {
  const lines = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const fields = {};
  let synopsis = '';
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*([^：:\s]{1,8})\s*[：:]\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    if (match[1] === '简介') {
      synopsis = [match[2], ...lines.slice(i + 1)].join('\n').trim();
      break;
    }
    fields[match[1]] = match[2].trim();
  }
  const clean = (value) => (value && !PLACEHOLDER.test(value.trim()) ? value.trim() : '');
  return { fields, title: clean(fields['剧名']), synopsis: clean(synopsis) };
}

function renderOriginalInfo({ title, source, total, downloaded, processed, synopsis }) {
  return [
    `剧名：${title || '（未知）'}`,
    source ? `来源：${source}` : '',
    total ? `总集数：${total} 集` : '',
    `已下载：${Number(downloaded) || 0} 集`,
    `已处理：${processed || '0 集'}`,
    '',
    '简介：',
    synopsis || '（暂无）',
    '',
  ]
    .filter((line, index) => line !== '' || index >= 5)
    .join('\n');
}

function renderNewInfo({ title, processed, synopsis }) {
  return [
    `剧名：${title || '（还没定：在管理剧集的「AI 发布素材」里选定新剧名）'}`,
    `已处理：${Number(processed) || 0} 集（「去重」文件夹里的成品）`,
    '',
    '简介：',
    synopsis || '（还没写：在「AI 发布素材」里改写并保存简介）',
    '',
  ].join('\n');
}

function originalInfoFile(dir) {
  return path.join(dir, ORIGINAL_INFO);
}
function newInfoFile(dir) {
  return path.join(dir, NEW_INFO);
}

/** 原剧的简介：原剧集信息.txt 里的；没有就看以前的 简介.txt（「原剧」里或外层）。 */
function readOriginalSynopsis(dir) {
  const own = parseInfo(readText(originalInfoFile(dir))).synopsis;
  if (own) return own;
  for (const base of [path.join(dir, ORIGINAL_DIR), dir]) {
    const text = readText(path.join(base, LEGACY.synopsis)).trim();
    if (text) return text;
  }
  return '';
}

function readOriginalTitle(dir) {
  return parseInfo(readText(originalInfoFile(dir))).title;
}

/** 新剧名、新简介：新剧集信息.txt 里的；没有就看以前的 发布剧名.txt / 发布简介.txt。 */
function readNewInfo(dir) {
  const info = parseInfo(readText(newInfoFile(dir)));
  return {
    title: info.title || readText(path.join(dir, LEGACY.title)).trim(),
    synopsis: info.synopsis || readText(path.join(dir, LEGACY.newSynopsis)).trim(),
  };
}

/**
 * 更新原剧集信息.txt：数字（总集数、已下载、已处理）按传进来的写；剧名、简介文件里已经有的保留（用户可能手改过），
 * 没有才用传进来的（或以前的 简介.txt）。写好后以前的 简介.txt 就删掉，免得两份。返回是否写了。
 */
function updateOriginalInfo(dir, facts = {}) {
  const file = originalInfoFile(dir);
  const current = parseInfo(readText(file));
  const synopsis = current.synopsis || readOriginalSynopsis(dir) || String(facts.synopsis || '').trim();
  const written = writeIfChanged(file, renderOriginalInfo({ ...facts, title: current.title || facts.title, synopsis }));
  if (synopsis)
    for (const base of [path.join(dir, ORIGINAL_DIR), dir]) {
      const legacy = path.join(base, LEGACY.synopsis);
      if (isFile(legacy) && readText(legacy).trim() === synopsis) fs.rmSync(legacy, { force: true });
    }
  return written;
}

/**
 * 更新新剧集信息.txt：patch 里给了的（title、synopsis、processed）换成新的，没给的保留文件里已有的。
 * 写好后以前的 发布剧名.txt / 发布简介.txt 删掉。返回是否写了。
 */
function updateNewInfo(dir, patch = {}) {
  const file = newInfoFile(dir);
  const current = readNewInfo(dir);
  const fields = parseInfo(readText(file)).fields;
  const before = /^(\d+)/.exec(fields['已处理'] || '');
  const next = {
    title: patch.title != null ? String(patch.title).trim() : current.title,
    synopsis: patch.synopsis != null ? String(patch.synopsis).trim() : current.synopsis,
    processed: patch.processed != null ? patch.processed : before ? Number(before[1]) : 0,
  };
  const written = writeIfChanged(file, renderNewInfo(next));
  for (const [name, value] of [
    [LEGACY.title, next.title],
    [LEGACY.newSynopsis, next.synopsis],
  ]) {
    const legacy = path.join(dir, name);
    if (isFile(legacy) && (!readText(legacy).trim() || readText(legacy).trim() === value)) fs.rmSync(legacy, { force: true });
  }
  return written;
}

// ---------- 海报 ----------

/** 原剧海报：根目录的 原剧集海报.*；没有就看以前的 封面.*（「原剧」里或外层）。没有返回 null。 */
function findOriginalPoster(dir) {
  for (const [base, name] of [
    [dir, ORIGINAL_POSTER],
    [path.join(dir, ORIGINAL_DIR), LEGACY.cover],
    [dir, LEGACY.cover],
  ])
    for (const ext of POSTER_EXTENSIONS) {
      const file = path.join(base, name + ext);
      if (isFile(file)) return file;
    }
  return null;
}

function originalPosterFile(dir, ext) {
  return path.join(dir, ORIGINAL_POSTER + ext);
}

/** 新剧海报：新剧集海报.jpg；还没挪的以前的 发布海报.jpg 也认。 */
function findNewPoster(dir) {
  for (const file of [path.join(dir, NEW_POSTER), path.join(dir, LEGACY.poster)]) if (isFile(file)) return file;
  return null;
}

// ---------- 分镜工程图 ----------

/** 每集的网页、提示词 txt、参考图放这里。 */
function storyboardPagesDir(dir) {
  return path.join(dir, STORYBOARD_DIR, STORYBOARD_PAGES);
}

/** 一集的网页（新位置）；还没挪的以前「视频提示词」里的也认。 */
function storyboardHtml(dir, label) {
  const file = path.join(storyboardPagesDir(dir), `${label}.html`);
  const legacy = path.join(dir, LEGACY.prompts, `${label}.html`);
  return !isFile(file) && isFile(legacy) ? legacy : file;
}

/** 网页对应的截图：网页在「网页和提示词」里时截图放上一层的「分镜工程图」里，其余（以前的）放在网页旁边。 */
function storyboardImageFor(htmlFile) {
  const parent = path.dirname(htmlFile);
  const base = `${path.basename(htmlFile, path.extname(htmlFile))}.jpg`;
  return path.basename(parent) === STORYBOARD_PAGES ? path.join(path.dirname(parent), base) : path.join(parent, base);
}

/** 补齐「去重」里的交付资料：只复制文件，不移动来源，不复制网页和中间文件夹。 */
function syncDeliveryFiles(dir) {
  const output = path.join(dir, '去重');
  if (!isDir(output)) return [];
  const entries = fs.readdirSync(output, { withFileTypes: true });
  const videos = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.mp4$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  if (!videos.length) return [];
  const written = [];
  const copy = (source, target) => {
    const stat = fs.statSync(source);
    const previous = fs.statSync(target, { throwIfNoEntry: false });
    if (previous?.isFile() && previous.size === stat.size && Math.abs(previous.mtimeMs - stat.mtimeMs) < 1) return;
    const temp = path.join(output, `.${path.basename(target)}.${process.pid}.tmp`);
    try {
      fs.copyFileSync(source, temp);
      fs.utimesSync(temp, stat.atime, stat.mtime);
      fs.renameSync(temp, target);
      written.push(path.basename(target));
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };
  const snapshots = [];
  for (const folder of [path.join(dir, STORYBOARD_DIR), path.join(dir, LEGACY.prompts)]) {
    if (!isDir(folder)) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(jpe?g|png)$/i.test(entry.name)) continue;
      const stem = path.basename(entry.name, path.extname(entry.name));
      const number = /第0*(\d+)集(?:_\d+)?$/.exec(stem)?.[1];
      if (!number) continue;
      const file = path.join(folder, entry.name);
      snapshots.push({ file, stem, number: Number(number), time: fs.statSync(file).mtimeMs });
    }
  }
  const selected = [];
  for (const video of videos) {
    const stem = path.basename(video, path.extname(video));
    const number = /第0*(\d+)集(?:_\d+)?$/.exec(stem)?.[1];
    const matches = snapshots.filter((shot) => shot.stem === stem || (number && shot.number === Number(number)))
      .sort((a, b) => Number(b.stem === stem) - Number(a.stem === stem) || b.time - a.time);
    const shot = matches[0];
    if (shot && shot.time + 1 >= fs.statSync(path.join(output, video)).mtimeMs) selected.push({ ...shot, stem });
  }
  // 取最近生成的四集；固定名称「AI分镜工程图_第N集」，仅沿用视频的集号和补零。
  selected.sort((a, b) => b.time - a.time || a.stem.localeCompare(b.stem, 'zh-CN', { numeric: true }));
  for (const shot of selected.slice(0, 4)) {
    const episode = /第\d+集(?:_\d+)?$/.exec(shot.stem)?.[0];
    if (!episode) continue;
    const extension = path.extname(shot.file);
    const target = path.join(output, 'AI分镜工程图_' + episode + extension);
    const previous = path.join(output, shot.stem + extension);
    // 上一版复制出的同名图，核对内容一致后改成正确名称；来源图和不同内容的文件保留。
    if (!fs.existsSync(target) && isFile(previous) && fs.readFileSync(previous).equals(fs.readFileSync(shot.file))) {
      fs.renameSync(previous, target);
      written.push(path.basename(target));
    }
    copy(shot.file, target);
  }
  const poster = findNewPoster(dir);
  if (poster) copy(poster, path.join(output, '海报.jpg'));
  for (const [name, text] of [
    ['集数.txt', `${videos.length}集\r\n`],
    ['简介.txt', (readNewInfo(dir).synopsis || readOriginalSynopsis(dir)).replace(/\r?\n/g, '\r\n') + '\r\n'],
  ]) {
    if (writeIfChanged(path.join(output, name), text)) written.push(name);
  }
  return written;
}

// ---------- 以前的结构自动挪过来 ----------

/** 挪一个文件 / 文件夹：目标已经有了就不动（不覆盖）。返回是否挪了。 */
/**
 * 这部剧最后一次处理的时间（毫秒）：去重成品、分镜工程图、新剧集海报、成本配置报告里最新的修改时间；
 * 一样都没有就是 0（还没处理过）。只看文件，不读视频。
 */
function lastProcessedAt(dir) {
  let latest = 0;
  const consider = (file) => {
    try {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch (_) {}
  };
  const scan = (folder, test) => {
    try {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true }))
        if (entry.isFile() && !entry.name.startsWith('.') && test(entry.name)) consider(path.join(folder, entry.name));
    } catch (_) {}
  };
  scan(path.join(dir, '去重'), (name) => /\.mp4$/i.test(name));
  scan(path.join(dir, STORYBOARD_DIR), (name) => /\.(png|jpe?g|webp)$/i.test(name));
  scan(storyboardPagesDir(dir), (name) => /\.html?$/i.test(name));
  const poster = findNewPoster(dir);
  if (poster) consider(poster);
  consider(path.join(dir, COST_REPORT));
  return Math.round(latest);
}

function move(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return true;
  } catch (_) {
    return false;
  }
}

/** 文件夹空了就删掉（里面还有东西不动）。 */
function removeIfEmpty(dir) {
  try {
    if (isDir(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch (_) {}
}

/**
 * 把以前结构里的海报和分镜工程图挪到新位置（简介、剧名由 updateOriginalInfo / updateNewInfo 合进信息文件）。
 * 视频不动；目标已经有的不覆盖；挪不成的留在原地（下次再挪，期间旧位置照样认得）。返回挪了哪些（给日志用）。
 */
function migrateLayout(dir) {
  const moved = [];
  // 原剧海报：封面.* → 原剧集海报.*
  if (!POSTER_EXTENSIONS.some((ext) => isFile(originalPosterFile(dir, ext)))) {
    const legacy = findOriginalPoster(dir);
    if (legacy && move(legacy, originalPosterFile(dir, path.extname(legacy).toLowerCase()))) moved.push('原剧集海报');
  }
  // 新剧海报：发布海报.jpg → 新剧集海报.jpg
  if (move(path.join(dir, LEGACY.poster), path.join(dir, NEW_POSTER))) moved.push('新剧集海报');
  // 分镜工程图：「视频提示词」里的截图放「分镜工程图」，网页、提示词、参考图放「分镜工程图/网页和提示词」
  const prompts = path.join(dir, LEGACY.prompts);
  if (isDir(prompts)) {
    let count = 0;
    for (const entry of fs.readdirSync(prompts, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const from = path.join(prompts, entry.name);
      const isImage = entry.isFile() && /\.jpe?g$/i.test(entry.name);
      const to = isImage ? path.join(dir, STORYBOARD_DIR, entry.name) : path.join(storyboardPagesDir(dir), entry.name);
      if (move(from, to)) count += 1;
    }
    removeIfEmpty(prompts);
    if (count) moved.push(`分镜工程图 ${count} 项`);
  }
  return moved;
}

module.exports = {
  ORIGINAL_DIR,
  ORIGINAL_INFO,
  ORIGINAL_POSTER,
  NEW_INFO,
  NEW_POSTER,
  STORYBOARD_DIR,
  STORYBOARD_PAGES,
  COST_REPORT,
  COST_REPORT_PNG,
  POSTER_EXTENSIONS,
  LEGACY,
  parseInfo,
  renderOriginalInfo,
  renderNewInfo,
  writeIfChanged,
  originalInfoFile,
  newInfoFile,
  readOriginalSynopsis,
  readOriginalTitle,
  readNewInfo,
  updateOriginalInfo,
  updateNewInfo,
  findOriginalPoster,
  originalPosterFile,
  findNewPoster,
  storyboardPagesDir,
  storyboardHtml,
  storyboardImageFor,
  syncDeliveryFiles,
  lastProcessedAt,
  migrateLayout,
};
