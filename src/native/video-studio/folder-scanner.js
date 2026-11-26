'use strict';
/**
 * Drama folder scanner & output filename builder for 「视频处理」.
 * Output naming rules:
 *   - 资产图截图: <剧名>AI资产图.png
 *   - 操作视频:   <剧名>操作视频.mp4
 *   - 分镜截图:   <剧名>第<数字>集.png  (e.g., 退役归来，这个保镖不好惹第1集.png)
 */

const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.ts']);

function sanitizeFilename(name) {
  return String(name || '未命名短剧')
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '未命名短剧';
}

function cleanSeriesTitle(folderName) {
  return sanitizeFilename(
    String(folderName || '')
      .replace(/[-_\s]*(全集|完整版|高清|1080p|720p|全\d+集|\(\d+集\)|（\d+集）)$/i, '')
      .trim(),
  );
}

function parseEpisodeNumber(fileName, fallbackIdx) {
  const stem = path.basename(fileName, path.extname(fileName));
  const patterns = [
    /第\s*0*(\d{1,4})\s*[集话回]/i,
    /(?:ep|episode|e)[\s._-]*0*(\d{1,4})(?!\d)/i,
    /(?:^|[\s._-])0*(\d{1,4})$/,
    /0*(\d{1,4})(?!\d)/,
  ];
  for (const re of patterns) {
    const m = stem.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return fallbackIdx;
}

function walkVideos(dir, maxDepth = 2, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === '__MACOSX' || ent.name === '.studio_cache') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkVideos(full, maxDepth, depth + 1, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (VIDEO_EXTS.has(ext) && !ent.name.includes('操作视频')) {
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(full).size;
        } catch {}
        out.push({ filePath: full, fileName: ent.name, sizeBytes });
      }
    }
  }
  return out;
}

function extractTitleFromVideoName(fileName) {
  const stem = path.basename(fileName, path.extname(fileName));
  const stripped = stem
    .replace(/[-_\s·—–]*第\s*0*\d{1,4}\s*[集话回].*$/i, '')
    .replace(/[-_\s·—–]*(?:ep|episode|e)[\s._-]*0*\d{1,4}.*$/i, '')
    .replace(/[-_\s·—–]+0*\d{1,4}$/, '')
    .replace(/[-_\s·—–]+$/g, '')
    .trim();
  // Ignore if nothing meaningful remains (e.g. "01.mp4" or "第1集.mp4")
  if (!stripped || /^\d+$/.test(stripped)) return '';
  return cleanSeriesTitle(stripped);
}

function inferSeriesTitle(rawVideos, folderName) {
  const counts = new Map();
  for (const v of rawVideos) {
    const t = extractTitleFromVideoName(v.fileName);
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  if (counts.size > 0) {
    let best = '';
    let bestCnt = 0;
    for (const [t, c] of counts.entries()) {
      if (c > bestCnt || (c === bestCnt && t.length > best.length)) {
        best = t;
        bestCnt = c;
      }
    }
    if (best) return best;
  }
  return cleanSeriesTitle(folderName);
}

function scanDramaFolder(folderPath) {
  const absDir = path.resolve(String(folderPath || ''));
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`找不到剧集文件夹：${absDir}`);
  }
  const rawVideos = walkVideos(absDir, 2);
  const seriesTitle = inferSeriesTitle(rawVideos, path.basename(absDir));
  const usedNums = new Set();

  const episodes = rawVideos
    .map((v, idx) => {
      let num = parseEpisodeNumber(v.fileName, idx + 1);
      while (usedNums.has(num)) num += 1;
      usedNums.add(num);
      return {
        number: num,
        label: `第${num}集`,
        fileName: v.fileName,
        filePath: v.filePath,
        sizeBytes: v.sizeBytes,
      };
    })
    .sort((a, b) => a.number - b.number);

  return {
    folderPath: absDir,
    seriesTitle,
    episodes,
  };
}

function buildOutputPaths(outputDir, seriesTitle, episodeNumbers = []) {
  const safeTitle = sanitizeFilename(seriesTitle);
  const dir = path.resolve(outputDir);
  return {
    outputDir: dir,
    assetScreenshot: path.join(dir, `${safeTitle}AI资产图.png`),
    operationVideo: path.join(dir, `${safeTitle}操作视频.mp4`),
    episodeScreenshots: episodeNumbers.map((num) => ({
      number: Number(num),
      fileName: `${safeTitle}第${Number(num)}集.png`,
      filePath: path.join(dir, `${safeTitle}第${Number(num)}集.png`),
    })),
  };
}

module.exports = {
  sanitizeFilename,
  cleanSeriesTitle,
  parseEpisodeNumber,
  scanDramaFolder,
  buildOutputPaths,
};
