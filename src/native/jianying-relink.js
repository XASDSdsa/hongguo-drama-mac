'use strict';
// 剪映草稿挪了位置（拷到别的盘、从剧的「剪映草稿」文件夹拷进剪映草稿目录、整个剧文件夹换了地方…）以后，
// 草稿里记的素材路径还是老位置，剪映打开就是「资源未找到」。软件做的草稿，素材全在草稿自己的「素材」文件夹里，
// 所以老路径找不到时，按「素材/…」这一段在草稿现在的位置里找回来，改写成新位置。
//
// 只处理软件自己生成的草稿（有 draft-manifest.json）；剪映保存过、已经变成密文的草稿读不了就不动。
// 文件都在、路径没变的草稿一个字都不改。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MEDIA_DIR = '素材';

/** 剪映自己的路径写法：Windows 上用正斜杠。 */
function nativePath(file, platform = process.platform) {
  return platform === 'win32' ? String(file).replace(/\\/g, '/') : String(file);
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function inside(file, dir) {
  const relative = path.relative(dir, path.resolve(file));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 老路径在草稿现在的位置里对应的文件；找不到返回 null。 */
function relocate(oldPath, draftDir) {
  const parts = String(oldPath)
    .split(/[\\/]+/)
    .filter(Boolean);
  for (let index = parts.length - 2; index >= 0; index--) {
    if (parts[index] !== MEDIA_DIR) continue;
    const candidate = path.join(draftDir, ...parts.slice(index));
    if (isFile(candidate)) return candidate;
  }
  return null;
}

async function writeJson(file, data) {
  const temp = `${file}.${process.pid}.relink`;
  await fsp.writeFile(temp, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
  await fsp.rename(temp, file);
}

async function readJson(file) {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch (_) {
    return null;
  }
}

/**
 * 修一份草稿的素材路径。
 * @returns {{ status: 'ok'|'fixed'|'skipped'|'missing', fixed: number, missing: string[] }}
 */
async function relinkDraft(draftDir, { platform = process.platform } = {}) {
  const dir = path.resolve(draftDir);
  const result = { status: 'ok', fixed: 0, missing: [] };
  if (!isFile(path.join(dir, 'draft-manifest.json'))) return { ...result, status: 'skipped' };
  const contentFile = path.join(dir, 'draft_info.json');
  const content = await readJson(contentFile);
  if (!content || typeof content.materials !== 'object') return { ...result, status: 'skipped' }; // 剪映存成了密文
  const mapping = new Map();
  for (const kind of ['videos', 'audios']) {
    for (const material of content.materials?.[kind] || []) {
      const value = typeof material?.path === 'string' ? material.path : '';
      if (!value || value.startsWith('<cloud://') || material.type === 'music') continue;
      if (isFile(value) && inside(value, dir)) continue;
      // 找不到，或者指着别的地方（草稿是拷过来的，老位置那份以后可能被删）：改成指向这份草稿自己的素材。
      const found = relocate(value, dir);
      if (!found) {
        if (!isFile(value)) result.missing.push(value);
        continue;
      }
      material.path = nativePath(found, platform);
      mapping.set(value, material.path);
      result.fixed += 1;
    }
  }
  if (!result.fixed) return { ...result, status: result.missing.length ? 'missing' : 'ok' };
  await writeJson(contentFile, content);

  const metaFile = path.join(dir, 'draft_meta_info.json');
  const meta = await readJson(metaFile);
  if (meta) {
    for (const bucket of Array.isArray(meta.draft_materials) ? meta.draft_materials : []) {
      for (const item of Array.isArray(bucket?.value) ? bucket.value : []) {
        const value = typeof item?.file_Path === 'string' ? item.file_Path : '';
        if (mapping.has(value)) item.file_Path = mapping.get(value);
        else if (value && !(isFile(value) && inside(value, dir))) {
          const found = relocate(value, dir);
          if (found) item.file_Path = nativePath(found, platform);
        }
      }
    }
    meta.draft_fold_path = nativePath(dir, platform);
    meta.draft_root_path = nativePath(path.dirname(dir), platform);
    await writeJson(metaFile, meta);
  }
  return { ...result, status: result.missing.length ? 'missing' : 'fixed' };
}

/** 修一个文件夹下面所有软件生成的草稿（只看一层子文件夹）。 */
async function relinkDraftsIn(root, options = {}) {
  const fixed = [];
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const result = await relinkDraft(dir, options);
      if (result.fixed) fixed.push({ dir, ...result });
    } catch (_) {
      // 修不了的草稿（被剪映占用、没权限）下次再试，不影响别的。
    }
  }
  return fixed;
}

module.exports = { nativePath, relocate, relinkDraft, relinkDraftsIn };
