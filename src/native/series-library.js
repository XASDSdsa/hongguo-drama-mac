'use strict';
// 「管理剧集」：把一个文件夹当作一部剧。集以文件夹里实际存在的视频为准，不依赖下载记录，
// 所以软件下载的剧和用户自己导入的文件夹用同一套逻辑。
const fs = require('node:fs');
const path = require('node:path');
const seriesInfo = require('./series-info');

const VIDEO_EXT = /\.(mp4|mov|mkv|m4v|avi|flv|ts|webm)$/i;
// 去重成品的命名；放在子文件夹里不会被扫到，但用户自己拷进来的也要排除。
const PROCESSED_NAME = /_去重(?:_\d+)?\.[^.]+$/i;
const collator = new Intl.Collator('zh-CN', { numeric: true });

/** 从文件名里认集号：优先「第N集」，其次 EP12 / E12，最后是文件名里最后一个数字。认不出返回 null。 */
function parseEpisodeIndex(filename) {
  const stem = String(filename || '').replace(/\.[^.]+$/, '');
  let match = /第\s*0*(\d{1,4})\s*集/.exec(stem);
  if (match) return Number(match[1]);
  match = /(?:^|[^a-z])e(?:p|pisode)?[\s._-]*0*(\d{1,4})(?!\d)/i.exec(stem);
  if (match) return Number(match[1]);
  const numbers = stem.match(/(?<!\d)\d{1,3}(?!\d)/g);
  if (numbers) {
    const value = Number(numbers[numbers.length - 1]);
    if (value > 0) return value;
  }
  return null;
}

function isVideoFile(entry) {
  return (
    entry.isFile() && !entry.name.startsWith('.') && VIDEO_EXT.test(entry.name) && !PROCESSED_NAME.test(entry.name)
  );
}

/** 剧文件夹顶层的视频，按集号（认不出的排最后）再按名称排序。 */
function scanEpisodes(dir) {
  const items = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!isVideoFile(entry)) continue;
    const file = path.join(dir, entry.name);
    let size = 0;
    let mtime = 0;
    try {
      const stat = fs.statSync(file);
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch (_) {
      continue;
    }
    items.push({ name: entry.name, path: file, size, mtime, index: parseEpisodeIndex(entry.name) });
  }
  return items.sort((a, b) => {
    if (a.index !== null && b.index !== null && a.index !== b.index) return a.index - b.index;
    if ((a.index === null) !== (b.index === null)) return a.index === null ? 1 : -1;
    return collator.compare(a.name, b.name);
  });
}

/** 一个文件夹的概况；既没有视频也没有封面的空文件夹返回 null（不当成一部剧）。 */
function describeFolder(dir) {
  let videos = 0;
  let totalSize = 0;
  let newest = 0;
  for (const episode of scanEpisodes(dir)) {
    videos++;
    totalSize += episode.size;
    newest = Math.max(newest, episode.mtime);
  }
  const cover = seriesInfo.findCover(dir);
  if (!videos && !cover) return null;
  if (!newest) {
    try {
      newest = fs.statSync(dir).mtimeMs;
    } catch (_) {}
  }
  return {
    name: path.basename(dir),
    path: dir,
    coverPath: cover,
    hasSynopsis: !!seriesInfo.readSynopsis(dir),
    videoCount: videos,
    totalSize,
    updatedAt: newest,
  };
}

/** 下载目录下的一级子文件夹，加上用户导入的文件夹；导入的排在前面，其余按最近更新排序。 */
function scanLibrary(root, imported = []) {
  const found = new Map();
  const add = (dir, isImported) => {
    const key = path.resolve(dir);
    if (found.has(key)) return;
    let info = null;
    let exists = false;
    try {
      exists = fs.statSync(key).isDirectory();
      if (exists) info = describeFolder(key);
    } catch (_) {}
    // 导入的文件夹还在、只是暂时没有视频时保留在列表里；文件夹已经不存在就不显示（记录仍留着，盘接回来就恢复）。
    if (!info && isImported && exists)
      info = {
        name: path.basename(key),
        path: key,
        coverPath: null,
        hasSynopsis: false,
        videoCount: 0,
        totalSize: 0,
        updatedAt: 0,
      };
    if (info) found.set(key, { ...info, imported: isImported });
  };
  for (const dir of imported) add(dir, true);
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) add(path.join(root, entry.name), false);
    }
  } catch (_) {}
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt || collator.compare(a.name, b.name));
}

/** 记录用户导入过哪些文件夹的小文件；只记路径，从不改动或删除这些文件夹里的东西。 */
function createFolderList(file) {
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
    } catch (_) {
      return [];
    }
  };
  const write = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  };
  return {
    list: read,
    add(dir) {
      const resolved = path.resolve(String(dir));
      const list = read();
      if (!list.includes(resolved)) write([...list, resolved]);
      return resolved;
    },
    remove(dir) {
      const resolved = path.resolve(String(dir));
      write(read().filter((item) => item !== resolved));
    },
  };
}

/** 记住用户确认过「这几集本来就缺」的导入文件夹，下次不再问。{ 文件夹路径: [集号] } */
function createGapNotes(file) {
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
      return {};
    }
  };
  return {
    get(dir) {
      const list = read()[path.resolve(String(dir))];
      return new Set(Array.isArray(list) ? list.filter(Number.isInteger) : []);
    },
    add(dir, indices) {
      const all = read();
      const key = path.resolve(String(dir));
      const merged = new Set([...(Array.isArray(all[key]) ? all[key] : []), ...indices.filter(Number.isInteger)]);
      all[key] = [...merged].sort((a, b) => a - b);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

/** 文件夹必须是下载目录的一级子文件夹，或者是导入过的文件夹，才允许在里面读写。 */
function isLibraryFolder(dir, root, imported) {
  const resolved = path.resolve(String(dir || ''));
  if (imported.map((item) => path.resolve(item)).includes(resolved)) return true;
  return path.dirname(resolved) === path.resolve(root) && !path.basename(resolved).startsWith('.');
}

module.exports = {
  VIDEO_EXT,
  parseEpisodeIndex,
  scanEpisodes,
  describeFolder,
  scanLibrary,
  createFolderList,
  createGapNotes,
  isLibraryFolder,
};
