'use strict';
// 剧文件夹里的“剧信息”：原剧海报和简介。下载一部剧时顺手存进去，之后各功能直接从文件夹里读。
// 已经存在的一律不覆盖（用户可能手动换过海报、改过简介）；读不到就不写，绝不编造。
// 放在哪：剧文件夹根目录的 原剧集海报.jpg 和 原剧集信息.txt（见 series-layout.js）；以前「原剧」里的 封面 / 简介.txt 也认。

const fs = require('node:fs');
const path = require('node:path');
const { cleanSynopsis } = require('./synopsis');
const layout = require('./series-layout');

// 原集视频放在剧文件夹下的「原剧」子文件夹；成品（去重、分镜工程图、发布素材）在外面。
// 用户自己导入的文件夹没有「原剧」子文件夹时，原集就是文件夹顶层的视频。
const ORIGINAL_DIR = layout.ORIGINAL_DIR;
// 以前的名字：整理旧文件夹、认旧文件时用
const COVER_BASENAME = layout.LEGACY.cover;
const SYNOPSIS_FILENAME = layout.LEGACY.synopsis;
const MAX_COVER_BYTES = 15 * 1024 * 1024;
const MIN_COVER_BYTES = 512;
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const SOURCE_LABELS = { hongguo: '红果', xifan: '西饭', hema: '河马' };

/** 剧 ID 带 hema:/xifan: 前缀的是对应来源，其余都是红果。 */
function sourceKey(seriesId) {
  const match = /^(xifan|hema):/.exec(String(seriesId || ''));
  return match ? match[1] : 'hongguo';
}

function sourceLabel(seriesId) {
  return SOURCE_LABELS[sourceKey(seriesId)];
}

/** 按文件头判断图片格式，返回扩展名；不是常见图片返回空字符串（防止把错误页当封面存下来）。 */
function sniffImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP')
    return '.webp';
  return '';
}

/** 这部剧的原剧放在哪：有「原剧」子文件夹就是它，否则是剧文件夹本身（导入的文件夹）。 */
function originalDir(dir) {
  const sub = path.join(dir, ORIGINAL_DIR);
  try {
    if (fs.statSync(sub).isDirectory()) return sub;
  } catch (_) {}
  return dir;
}

/** 一个原集文件属于哪个剧文件夹：在「原剧」里就往上一层。 */
function seriesDirOf(file) {
  const parent = path.dirname(path.resolve(String(file)));
  return path.basename(parent) === ORIGINAL_DIR ? path.dirname(parent) : parent;
}

/** 剧文件夹里已有的原剧海报（原剧集海报.*；以前的 封面.* 也认），没有返回 null。 */
function findCover(dir) {
  return layout.findOriginalPoster(dir);
}

/** 读原剧简介（原剧集信息.txt 里的；以前的 简介.txt 也认）；没有返回空字符串。 */
function readSynopsis(dir) {
  return layout.readOriginalSynopsis(dir);
}

/** 先写临时文件，再用“不覆盖”的方式放到目标位置；中途失败不会留下半截文件。 */
function writeIfAbsent(dest, data) {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

/**
 * 把原剧海报和简介存进剧文件夹（dir 是剧文件夹本身）：海报存成 原剧集海报.*，简介写进 原剧集信息.txt
 * （facts：剧名、来源、总集数、已下载、已处理，一起写进去）。
 * fetchImage(url) 由调用方提供，返回图片 Buffer。每一项互不影响，任何一项失败都不抛出。
 * 返回 { cover, synopsis }，值为 saved / exists / none / failed。
 */
async function saveSeriesInfo({ dir, cover, synopsis, fetchImage, facts = {} }) {
  const result = { cover: 'none', synopsis: 'none' };
  if (!dir) return result;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    return { cover: 'failed', synopsis: 'failed' };
  }

  const text = cleanSynopsis(synopsis);
  if (readSynopsis(dir)) result.synopsis = 'exists';
  else if (text) {
    try {
      layout.updateOriginalInfo(dir, { ...facts, synopsis: text });
      result.synopsis = 'saved';
    } catch (_) {
      result.synopsis = 'failed';
    }
  }

  const url = String(cover || '').trim();
  if (findCover(dir)) result.cover = 'exists';
  else if (/^https?:\/\//i.test(url) && typeof fetchImage === 'function') {
    try {
      const buffer = await fetchImage(url);
      const ext = sniffImageExtension(buffer);
      if (!ext || buffer.length < MIN_COVER_BYTES || buffer.length > MAX_COVER_BYTES) result.cover = 'failed';
      // 下载期间用户可能已经放了自己的封面，再查一次。
      else if (findCover(dir)) result.cover = 'exists';
      else result.cover = writeIfAbsent(layout.originalPosterFile(dir, ext), buffer) ? 'saved' : 'exists';
    } catch (_) {
      result.cover = 'failed';
    }
  }
  return result;
}

/**
 * 给一部剧选文件夹名。优先 `剧名`；已被另一部剧占用时依次尝试 `剧名（来源）`、`剧名（来源-短ID）`。
 * owners 是 名称(小写) -> 剧ID 的映射，表示哪些文件夹名已经属于哪部剧。
 */
function pickFolderName({ title, seriesId, owners }) {
  const base = String(title || '').trim();
  const id = String(seriesId || '');
  const taken = (name) => {
    const owner = owners && owners.get(name.toLowerCase());
    return owner !== undefined && String(owner) !== id;
  };
  const shortId = id.replace(/^(xifan|hema):/, '').slice(-6);
  const candidates = [base, `${base}（${sourceLabel(id)}）`, `${base}（${sourceLabel(id)}-${shortId}）`];
  for (const name of candidates) if (!taken(name)) return name;
  return candidates[candidates.length - 1];
}

module.exports = {
  ORIGINAL_DIR,
  originalDir,
  seriesDirOf,
  COVER_EXTENSIONS,
  COVER_BASENAME,
  SYNOPSIS_FILENAME,
  sourceKey,
  sourceLabel,
  sniffImageExtension,
  findCover,
  readSynopsis,
  saveSeriesInfo,
  pickFolderName,
};
