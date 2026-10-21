'use strict';
// 剪映的草稿到底放在哪。
//
// Mac：~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft。
// Windows 不一样：新版剪映的草稿直接放在「草稿位置」文件夹下面（常见是 D:\JianyingPro Drafts，
// 每份草稿一个文件夹，旁边是 root_meta_info.json），没有 Projects\com.lveditor.draft 这一层；
// 老版本才是 %LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft。
// 判断标准：哪个文件夹里直接有 root_meta_info.json，它就是剪映的草稿位置；有好几个时取剪映最近用过的
// （root_meta_info.json 最近改过的那个）。
const fs = require('node:fs');
const path = require('node:path');

const ROOT_META = 'root_meta_info.json';
const DRAFTS_DIR_NAME = 'JianyingPro Drafts';

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function rootMetaTime(dir) {
  try {
    return fs.statSync(path.join(dir, ROOT_META)).mtimeMs;
  } catch (_) {
    return -1;
  }
}

/** 剪映 User Data 文件夹的默认位置。 */
function defaultUserData({ platform = process.platform, env = process.env, home = require('node:os').homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Movies', 'JianyingPro', 'User Data');
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'JianyingPro', 'User Data');
  return null;
}

/** 从剪映自己的配置文件里找出写着的文件夹路径（剪映把「草稿位置」记在 User Data\Config 下面）。 */
function pathsInJianyingConfig(userData, { maxFiles = 200 } = {}) {
  const found = new Set();
  if (!userData) return found;
  const stack = [{ dir: path.join(userData, 'Config'), depth: 0 }];
  let files = 0;
  while (stack.length && files < maxFiles) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (++files > maxFiles) break;
      let text = '';
      try {
        if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch (_) {
        continue;
      }
      // Windows 路径（D:/JianyingPro Drafts、D:\\JianyingPro Drafts）和 Mac 路径都认。
      for (const match of text.matchAll(
        /[A-Za-z]:(?:\\\\|\\|\/)[^"'\r\n\t=<>|*?]*|\/(?:Users|Volumes)\/[^"'\r\n\t=<>|*?]*/g,
      )) {
        const value = match[0].replace(/\\\\/g, '\\').replace(/[\\/\s,;}\]]+$/, '');
        if (value.length > 3) found.add(value);
      }
    }
  }
  return found;
}

const WIN_DRIVES = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`);

/** Qt 配置文件里非 ASCII 字符写成 \x8349 这种：还原成中文。 */
function decodeQtString(value) {
  return String(value).replace(/\\x([0-9a-fA-F]{1,4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 剪映自己记的「草稿位置」：User Data\Config\globalSetting 里的 currentCustomDraftPath=…（剪映「全局设置 → 草稿位置」）。
 * 剪映只在这个文件夹里找草稿，所以 Windows 上草稿一定要放这里。读不到、文件夹不存在返回 null。
 */
function draftPathFromGlobalSetting(userData) {
  try {
    const file = path.join(userData, 'Config', 'globalSetting');
    const match = /^\s*currentCustomDraftPath\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    if (!match) return null;
    const value = decodeQtString(match[1].replace(/^"(.*)"$/, '$1')).trim();
    if (!value || !isDir(value)) return null;
    return { dir: path.resolve(value), time: fs.statSync(file).mtimeMs };
  } catch (_) {
    return null;
  }
}

/** 剪映 User Data 可能在的地方：默认的 %LOCALAPPDATA%、各盘的 JianyingPro\User Data、设置里填的文件夹附近。 */
function userDataCandidates({ platform = process.platform, env = process.env, home, drives = platform === 'win32' ? WIN_DRIVES : [], configured = '' } = {}) {
  const dirs = new Set();
  const fallback = defaultUserData({ platform, env, home });
  if (fallback) dirs.add(fallback);
  if (platform === 'win32')
    for (const drive of drives) {
      if (!isDir(drive)) continue;
      for (const sub of ['JianyingPro', path.join('Program Files', 'JianyingPro'), path.join('Program Files (x86)', 'JianyingPro')])
        dirs.add(path.join(drive, sub, 'User Data'));
    }
  if (configured) {
    dirs.add(configured);
    dirs.add(path.join(configured, 'User Data'));
    dirs.add(path.dirname(configured));
  }
  return [...dirs].filter(isDir);
}

/** 剪映自己设的草稿位置（有好几个 User Data 时取配置最近改过的那个）。 */
function jianyingOwnDraftRoot(options = {}) {
  return (
    userDataCandidates(options)
      .map(draftPathFromGlobalSetting)
      .filter(Boolean)
      .sort((a, b) => b.time - a.time)[0]?.dir || null
  );
}

/**
 * 可能是剪映草稿位置的文件夹，剪映最近用过的排前面。只返回里面真有 root_meta_info.json 的。
 */
function findJianyingDraftRoots({
  platform = process.platform,
  env = process.env,
  home = require('node:os').homedir(),
  drives = platform === 'win32' ? WIN_DRIVES : [],
} = {}) {
  const userData = defaultUserData({ platform, env, home });
  const candidates = new Set();
  for (const value of pathsInJianyingConfig(userData)) {
    candidates.add(value);
    candidates.add(path.dirname(value)); // 配置里记的可能是某份草稿或者里面的文件
  }
  if (userData) candidates.add(path.join(userData, 'Projects', 'com.lveditor.draft'));
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.add(path.join(env.LOCALAPPDATA, DRAFTS_DIR_NAME));
    for (const drive of drives) {
      if (!isDir(drive)) continue;
      candidates.add(path.join(drive, DRAFTS_DIR_NAME));
      for (const programs of ['Program Files', 'Program Files (x86)', 'JianyingPro'])
        candidates.add(path.join(drive, programs, DRAFTS_DIR_NAME));
    }
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)'])
      if (env[key]) candidates.add(path.join(env[key], DRAFTS_DIR_NAME));
  }
  return [...candidates]
    .map((dir) => ({ dir: path.resolve(dir), time: rootMetaTime(dir) }))
    .filter((item) => item.time >= 0)
    .filter(
      (item, index, list) => list.findIndex((other) => other.dir.toLowerCase() === item.dir.toLowerCase()) === index,
    )
    // Windows 新版剪映的草稿位置是「JianyingPro Drafts」这种文件夹；Projects\com.lveditor.draft 是老版本 / Mac 的，排后面
    .sort((a, b) => {
      if (platform === 'win32') {
        const oldA = /com\.lveditor\.draft$/i.test(a.dir);
        const oldB = /com\.lveditor\.draft$/i.test(b.dir);
        if (oldA !== oldB) return oldA ? 1 : -1;
      }
      return b.time - a.time;
    })
    .map((item) => item.dir);
}

/**
 * 设置里填的文件夹是什么：
 *   - 里面直接有 root_meta_info.json，或者文件夹本身就是剪映草稿位置 → 草稿位置
 *   - 里面有 Projects/com.lveditor.draft → 剪映 User Data
 *   - 其他存在的文件夹 → 当作草稿位置（用户说放这里就放这里）
 */
function classifyConfiguredDir(dir) {
  if (!dir || !isDir(dir)) return null;
  if (rootMetaTime(dir) >= 0) return { draftRoot: dir, userData: null };
  const inUserData = path.join(dir, 'Projects', 'com.lveditor.draft');
  if (isDir(inUserData)) return { draftRoot: inUserData, userData: dir };
  return { draftRoot: dir, userData: null };
}

/**
 * 草稿放哪、要不要登记到剪映 User Data。
 * 只有草稿位置正好是 User Data 下面的 Projects/com.lveditor.draft 时才登记（pyJianYingDraft 只会写那里的
 * root_meta_info.json）；草稿位置在别处（Windows 的 D:\JianyingPro Drafts）时不登记，剪映打开时自己会扫到。
 */
function resolveJianyingLocation({
  configured = '',
  platform = process.platform,
  env = process.env,
  home,
  drives,
} = {}) {
  const userDataDefault = defaultUserData({ platform, env, home });
  const userData = userDataDefault && isDir(userDataDefault) ? userDataDefault : null;
  const typed = String(configured || '').trim();
  if (platform === 'win32') {
    // Windows：剪映只在它自己设的「草稿位置」里找草稿 → 先读剪映的配置；读不到再用设置里填的文件夹（原样，不往下找
    // Projects\com.lveditor.draft）；都没有就找有 root_meta_info.json 的文件夹（JianyingPro Drafts 优先）。都不登记。
    const own = jianyingOwnDraftRoot({ platform, env, home, ...(drives ? { drives } : {}), configured: typed });
    if (own) return { draftRoot: own, userData: null, source: 'jianying' };
    if (typed && isDir(typed)) return { draftRoot: path.resolve(typed), userData: null, source: 'setting' };
    const found = findJianyingDraftRoots({ platform, env, home, ...(drives ? { drives } : {}) });
    if (found.length) return { draftRoot: found[0], userData: null, source: 'detected' };
    if (userData) return { draftRoot: path.join(userData, 'Projects', 'com.lveditor.draft'), userData: null, source: 'default' };
    return { draftRoot: null, userData: null, source: '' };
  }
  const fromSetting = classifyConfiguredDir(typed);
  let draftRoot = fromSetting?.draftRoot || null;
  let registerUserData = fromSetting?.userData || null;
  let source = fromSetting ? 'setting' : '';
  if (!draftRoot) {
    const found = findJianyingDraftRoots({ platform, env, home, ...(drives ? { drives } : {}) });
    if (found.length) {
      draftRoot = found[0];
      source = 'detected';
    } else if (userData) {
      draftRoot = path.join(userData, 'Projects', 'com.lveditor.draft');
      source = 'default';
    }
  }
  if (!registerUserData && userData && draftRoot) {
    const standard = path.join(userData, 'Projects', 'com.lveditor.draft');
    if (path.resolve(standard).toLowerCase() === path.resolve(draftRoot).toLowerCase()) registerUserData = userData;
  }
  return { draftRoot, userData: registerUserData, source };
}

module.exports = {
  DRAFTS_DIR_NAME,
  draftPathFromGlobalSetting,
  jianyingOwnDraftRoot,
  defaultUserData,
  pathsInJianyingConfig,
  findJianyingDraftRoots,
  classifyConfiguredDir,
  resolveJianyingLocation,
};
