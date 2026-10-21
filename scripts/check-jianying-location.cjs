'use strict';
// 剪映草稿放哪：Windows 新版剪映的草稿直接在「草稿位置」（如 D:\JianyingPro Drafts）下面，
// 不是 Mac 那样的 User Data/Projects/com.lveditor.draft。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveJianyingLocation,
  findJianyingDraftRoots,
  classifyConfiguredDir,
} = require('../src/native/jianying-location');

const base = fs.mkdtempSync(path.join(os.tmpdir(), '剪映位置-'));
const touch = (file, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"all_draft_store":[]}');
  if (mtime) fs.utimesSync(file, mtime, mtime);
};
let n = 0;
const fresh = () => {
  const dir = path.join(base, String(++n));
  const drive = path.join(dir, 'D');
  const local = path.join(dir, 'AppData', 'Local');
  fs.mkdirSync(drive, { recursive: true });
  fs.mkdirSync(path.join(local, 'JianyingPro', 'User Data', 'Config'), { recursive: true });
  return { dir, drive, local, env: { LOCALAPPDATA: local }, drives: [drive] };
};
const win = (t, configured = '') =>
  resolveJianyingLocation({ configured, platform: 'win32', env: t.env, home: t.dir, drives: t.drives });

try {
  // 1. Windows 新版：草稿直接在 D:\JianyingPro Drafts 下面（截图里的情况）。不往 User Data 登记。
  {
    const t = fresh();
    const drafts = path.join(t.drive, 'JianyingPro Drafts');
    touch(path.join(drafts, 'root_meta_info.json'));
    const found = findJianyingDraftRoots({ platform: 'win32', env: t.env, home: t.dir, drives: t.drives });
    assert.deepEqual(found, [path.resolve(drafts)]);
    const location = win(t);
    assert.equal(location.draftRoot, path.resolve(drafts));
    assert.equal(location.userData, null, 'not registered into User Data');
    assert.equal(location.source, 'detected');
  }
  // 2. 老版本：草稿在 User Data\Projects\com.lveditor.draft（只有这一个）。Windows 上不登记，剪映自己扫。
  {
    const t = fresh();
    const userData = path.join(t.local, 'JianyingPro', 'User Data');
    const root = path.join(userData, 'Projects', 'com.lveditor.draft');
    touch(path.join(root, 'root_meta_info.json'));
    const location = win(t);
    assert.equal(location.draftRoot, path.resolve(root));
    assert.equal(location.userData, null);
  }
  // 2b. 用户的情况：软件设置里填的是 D:\JianyingPro（里面有上个版本放过草稿的 Projects\com.lveditor.draft），
  //     剪映自己的「草稿位置」是 D:\JianyingPro Drafts → 一定放 D:\JianyingPro Drafts（剪映只在这里找草稿）。
  {
    const t = fresh();
    const drafts = path.join(t.drive, 'JianyingPro Drafts');
    touch(path.join(drafts, 'root_meta_info.json'), new Date('2025-01-01'));
    const wrong = path.join(t.drive, 'JianyingPro');
    touch(path.join(wrong, 'Projects', 'com.lveditor.draft', 'root_meta_info.json'), new Date('2026-10-21'));
    fs.writeFileSync(
      path.join(t.local, 'JianyingPro', 'User Data', 'Config', 'globalSetting'),
      `[General]\ncurrentCustomDraftPath=${drafts}\nlanguage=zh\n`,
    );
    const location = win(t, wrong);
    assert.equal(location.draftRoot, path.resolve(drafts), '按剪映自己的草稿位置');
    assert.equal(location.source, 'jianying');
    assert.equal(location.userData, null);
    // 剪映配置读不到：用设置里填的文件夹本身，不往下找 Projects\com.lveditor.draft
    fs.rmSync(path.join(t.local, 'JianyingPro', 'User Data', 'Config', 'globalSetting'));
    const fromSetting = win(t, wrong);
    assert.equal(fromSetting.draftRoot, path.resolve(wrong));
    assert.equal(fromSetting.source, 'setting');
    // 什么都没填：两个都有 root_meta_info.json 时 JianyingPro Drafts 优先（哪怕另一个更新）
    assert.equal(win(t).draftRoot, path.resolve(drafts));
  }
  // 2c. 剪映配置里中文路径是 Qt 的 \x8349 写法；User Data 不在 C 盘默认位置（装在 D:\JianyingPro\User Data）
  {
    const t = fresh();
    fs.rmSync(path.join(t.local, 'JianyingPro'), { recursive: true });
    const drafts = path.join(t.drive, '剪映草稿');
    touch(path.join(drafts, 'root_meta_info.json'));
    const userData = path.join(t.drive, 'JianyingPro', 'User Data');
    fs.mkdirSync(path.join(userData, 'Config'), { recursive: true });
    // Qt 程序写路径用正斜杠（D:/\x526a\x6620\x8349\x7a3f）
    const qt = `${t.drive.replace(/\\/g, '/')}/\\x526a\\x6620\\x8349\\x7a3f`;
    fs.writeFileSync(path.join(userData, 'Config', 'globalSetting'), `[General]\ncurrentCustomDraftPath="${qt}"\n`);
    const location = win(t);
    assert.equal(location.draftRoot, path.resolve(drafts));
    assert.equal(location.source, 'jianying');
    // 反斜杠写成两个的写法（D:\\\\剪映草稿）也认
    fs.writeFileSync(path.join(userData, 'Config', 'globalSetting'), `[General]\ncurrentCustomDraftPath=${drafts.replace(/\\/g, '\\\\')}\n`);
    assert.equal(win(t).draftRoot, path.resolve(drafts));
  }
  // 3. 两个都有：剪映最近用的那个（root_meta_info.json 最近改过）。
  {
    const t = fresh();
    const old = path.join(t.local, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
    const drafts = path.join(t.drive, 'JianyingPro Drafts');
    touch(path.join(old, 'root_meta_info.json'), new Date('2025-01-01'));
    touch(path.join(drafts, 'root_meta_info.json'), new Date('2026-10-21'));
    assert.equal(win(t).draftRoot, path.resolve(drafts));
  }
  // 4. 草稿位置改到了别的名字的文件夹：从剪映配置文件里读出来。
  {
    const t = fresh();
    const custom = path.join(t.dir, 'E', '我的剪映草稿');
    touch(path.join(custom, 'root_meta_info.json'));
    fs.writeFileSync(
      path.join(t.local, 'JianyingPro', 'User Data', 'Config', 'globalSetting'),
      `[General]\ncurrentCustomDraftPath=${custom.replace(/\//g, '\\\\')}\nother=1\n`,
    );
    // 测试机上路径是 / 开头的，再写一份正斜杠的，模拟剪映配置里两种写法都能读。
    fs.writeFileSync(
      path.join(t.local, 'JianyingPro', 'User Data', 'Config', 'draft.json'),
      JSON.stringify({ draft_path: custom }),
    );
    const location = resolveJianyingLocation({ platform: 'win32', env: t.env, home: t.dir, drives: [] });
    // Linux 上跑测试时只能认出 / 开头的写法（/Users、/Volumes 之外的绝对路径不当路径）；Windows 盘符写法在下面单测。
    if (custom.startsWith('/Users') || custom.startsWith('/Volumes'))
      assert.equal(location.draftRoot, path.resolve(custom));
  }
  // 5. 设置里填了 D:\JianyingPro Drafts，里面还有上个版本错放的 Projects\com.lveditor.draft：用填的这个文件夹本身。
  {
    const t = fresh();
    const drafts = path.join(t.drive, 'JianyingPro Drafts');
    touch(path.join(drafts, 'root_meta_info.json'));
    fs.mkdirSync(path.join(drafts, 'Projects', 'com.lveditor.draft'), { recursive: true });
    const location = win(t, drafts);
    assert.equal(location.draftRoot, drafts);
    assert.equal(location.userData, null);
    assert.equal(location.source, 'setting');
  }
  // 6. 设置里填的是 User Data：草稿放进它的 Projects\com.lveditor.draft，并登记。
  {
    const t = fresh();
    const userData = path.join(t.dir, 'UD');
    fs.mkdirSync(path.join(userData, 'Projects', 'com.lveditor.draft'), { recursive: true });
    assert.deepEqual(classifyConfiguredDir(userData), {
      draftRoot: path.join(userData, 'Projects', 'com.lveditor.draft'),
      userData,
    });
    // 设置里填的空文件夹：就放那里。
    const plain = path.join(t.dir, '随便一个文件夹');
    fs.mkdirSync(plain);
    assert.deepEqual(classifyConfiguredDir(plain), { draftRoot: plain, userData: null });
    assert.equal(classifyConfiguredDir(path.join(t.dir, '不存在')), null);
  }
  // 7. Mac：~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft，登记。
  {
    const home = path.join(base, 'mac-home');
    const userData = path.join(home, 'Movies', 'JianyingPro', 'User Data');
    const root = path.join(userData, 'Projects', 'com.lveditor.draft');
    fs.mkdirSync(root, { recursive: true });
    const location = resolveJianyingLocation({ platform: 'darwin', env: {}, home });
    assert.equal(location.draftRoot, root);
    assert.equal(location.userData, userData);
    assert.equal(location.source, 'default');
  }
  // 8. 没装剪映：没有草稿位置（软件放到剧文件夹的「剪映草稿」里）。
  {
    const t = fresh();
    fs.rmSync(path.join(t.local, 'JianyingPro'), { recursive: true });
    assert.deepEqual(win(t), { draftRoot: null, userData: null, source: '' });
  }
  // 9. 配置文件里 Windows 盘符路径的两种写法都能读出来。
  {
    const { pathsInJianyingConfig } = require('../src/native/jianying-location');
    const userData = path.join(base, 'cfg', 'User Data');
    fs.mkdirSync(path.join(userData, 'Config'), { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'Config', 'globalSetting'),
      'currentCustomDraftPath=D:/JianyingPro Drafts\n{"a":"E:\\\\剪映\\\\草稿"}\n',
    );
    const paths = [...pathsInJianyingConfig(userData)];
    assert.ok(paths.includes('D:/JianyingPro Drafts'), paths.join(' | '));
    assert.ok(paths.includes('E:\\剪映\\草稿'), paths.join(' | '));
  }
  console.log(
    'PASS Jianying draft location: Windows D:\\JianyingPro Drafts (drafts directly inside), old User Data layout, Mac, settings',
  );
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
