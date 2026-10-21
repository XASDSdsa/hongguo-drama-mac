'use strict';
// 剪映草稿挪了位置后，软件把草稿里的素材路径改到新位置（剪映打开不会「资源未找到」）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  relinkDraft,
  relinkDraftsIn,
  relocate,
  nativePath,
  DRAFT_PATH_PLACEHOLDER,
} = require('../src/native/jianying-relink');

function makeDraft(root, name, { manifest = true, pathOf } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '素材', '视频'), { recursive: true });
  fs.mkdirSync(path.join(dir, '素材', '音频'), { recursive: true });
  fs.writeFileSync(path.join(dir, '素材', '视频', '第1集.mp4'), 'v');
  fs.writeFileSync(path.join(dir, '素材', '音频', '人声-整集时间轴.wav'), 'a');
  const video = pathOf(dir, ['素材', '视频', '第1集.mp4']);
  const audio = pathOf(dir, ['素材', '音频', '人声-整集时间轴.wav']);
  const content = {
    id: 'X',
    materials: {
      videos: [{ id: 'v1', path: video, type: 'video' }],
      audios: [
        { id: 'a1', path: audio, type: 'extract_music' },
        { id: 'm1', path: '', type: 'music' },
      ],
      texts: [],
    },
  };
  fs.writeFileSync(path.join(dir, 'draft_info.json'), JSON.stringify(content, null, 4));
  fs.writeFileSync(
    path.join(dir, 'draft_meta_info.json'),
    JSON.stringify({
      draft_fold_path: dir,
      draft_root_path: root,
      draft_materials: [
        {
          type: 0,
          value: [
            { file_Path: video, metetype: 'video' },
            { file_Path: audio, metetype: 'music' },
          ],
        },
      ],
    }),
  );
  if (manifest) fs.writeFileSync(path.join(dir, 'draft-manifest.json'), '{}');
  return { dir, video, audio };
}

// 通用情况不补 Windows 的 draft_content.json（那一条在 7b 单独测），这样在 Windows 打包机上结果也一样。
const generic = { windowsTimeline: false };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '草稿挪位置-'));
  try {
    const oldRoot = path.join(base, '旧位置', '剪映草稿');
    const newRoot = path.join(base, '新位置', 'com.lveditor.draft');
    fs.mkdirSync(oldRoot, { recursive: true });
    fs.mkdirSync(newRoot, { recursive: true });

    const P = DRAFT_PATH_PLACEHOLDER;
    const media = (value, dir) =>
      value.startsWith(P) ? path.join(dir, ...value.slice(P.length + 1).split('/')) : value;

    // 1. 已经是剪映占位符写法的草稿：挪到哪都对，一个字都不改。
    const portable = makeDraft(newRoot, '占位符草稿', { pathOf: (_dir, parts) => `${P}/${parts.join('/')}` });
    const before = fs.readFileSync(path.join(portable.dir, 'draft_info.json'), 'utf8');
    const portableResult = await relinkDraft(portable.dir, generic);
    assert.equal(portableResult.status, 'ok');
    assert.equal(portableResult.fixed, 0);
    assert.equal(fs.readFileSync(path.join(portable.dir, 'draft_info.json'), 'utf8'), before);

    // 1b. 以前的版本写的绝对路径（素材在草稿里）：改成占位符写法，以后挪位置也不会丢。
    const intact = makeDraft(newRoot, '没挪过', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    const intactResult = await relinkDraft(intact.dir, generic);
    assert.equal(intactResult.status, 'fixed');
    assert.equal(intactResult.fixed, 2);
    const upgraded = read(path.join(intact.dir, 'draft_info.json'));
    assert.equal(upgraded.materials.videos[0].path, `${P}/素材/视频/第1集.mp4`);
    assert.equal(upgraded.materials.audios[0].path, `${P}/素材/音频/人声-整集时间轴.wav`);
    assert.equal(upgraded.config.material_save_mode, 1, '素材都在草稿里');
    const upgradedMeta = read(path.join(intact.dir, 'draft_meta_info.json'));
    assert.deepEqual(
      upgradedMeta.draft_materials[0].value.map((item) => item.file_Path),
      ['./素材/视频/第1集.mp4', './素材/音频/人声-整集时间轴.wav'],
    );
    assert.equal(upgradedMeta.draft_name, '没挪过', 'draft_name 和文件夹名一致');
    assert.ok(!upgradedMeta.draft_fold_path.includes('\\'), '正斜杠');
    assert.equal((await relinkDraft(intact.dir, generic)).fixed, 0, '再跑一次不再改');

    // 2. 整个草稿文件夹挪走（老位置已经没有了）：按「素材/…」找回来，写成占位符。
    const moved = makeDraft(oldRoot, '挪过的草稿', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    const movedDir = path.join(newRoot, '挪过的草稿');
    fs.renameSync(moved.dir, movedDir);
    const movedResult = await relinkDraft(movedDir, generic);
    assert.equal(movedResult.status, 'fixed');
    assert.equal(movedResult.fixed, 2);
    const content = read(path.join(movedDir, 'draft_info.json'));
    assert.equal(content.materials.audios[1].path, '', '云端音乐不动');
    for (const material of [...content.materials.videos, content.materials.audios[0]]) {
      assert.ok(material.path.startsWith(P));
      assert.ok(fs.existsSync(media(material.path, movedDir)));
    }
    const meta = read(path.join(movedDir, 'draft_meta_info.json'));
    assert.equal(meta.draft_fold_path, movedDir.split(path.sep).join('/'));
    assert.equal(meta.draft_root_path, newRoot.split(path.sep).join('/'));
    assert.equal((await relinkDraft(movedDir, generic)).fixed, 0);

    // 3. 别的电脑生成（C:/… 或 C:\… 或 Mac 路径）：按「素材/…」找回来。
    for (const [label, pathOf] of [
      ['正斜杠', (_dir, parts) => ['C:', 'Users', '张三', 'AppData', '某草稿', ...parts].join('/')],
      ['反斜杠', (_dir, parts) => ['D:', '短剧', '剪映草稿', '某草稿', ...parts].join('\\')],
      ['Mac', (_dir, parts) => ['', 'Users', 'me', 'Movies', '某草稿', ...parts].join('/')],
    ]) {
      const other = makeDraft(newRoot, `别的电脑-${label}`, { pathOf });
      const result = await relinkDraft(other.dir, generic);
      assert.equal(result.status, 'fixed', label);
      const fixed = read(path.join(other.dir, 'draft_info.json'));
      assert.ok(fs.existsSync(media(fixed.materials.videos[0].path, other.dir)), label);
      assert.ok(fs.existsSync(media(fixed.materials.audios[0].path, other.dir)), label);
    }

    // 4. 草稿是拷过来的（老位置那份还在）：改成这份草稿自己的素材，来源那份不动。
    const original = makeDraft(oldRoot, '拷贝来源', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    const copyDir = path.join(newRoot, '拷贝来源');
    fs.cpSync(original.dir, copyDir, { recursive: true });
    const copyResult = await relinkDraft(copyDir, generic);
    assert.equal(copyResult.fixed, 2);
    assert.ok(read(path.join(copyDir, 'draft_info.json')).materials.videos[0].path.startsWith(P));
    assert.ok(
      read(path.join(original.dir, 'draft_info.json')).materials.videos[0].path.startsWith(original.dir),
      '来源那份不动',
    );

    // 5. 素材真的丢了：报告找不到，不乱改。
    const lost = makeDraft(oldRoot, '素材丢了', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    fs.rmSync(path.join(lost.dir, '素材'), { recursive: true });
    const lostResult = await relinkDraft(lost.dir, generic);
    assert.equal(lostResult.status, 'missing');
    assert.equal(lostResult.missing.length, 2);

    // 6. 不是软件做的草稿（没有 draft-manifest.json）、剪映存成密文的草稿：不碰。
    const foreign = makeDraft(oldRoot, '用户自己的草稿', {
      manifest: false,
      pathOf: (_dir, parts) => ['', 'nowhere', ...parts].join('/'),
    });
    assert.equal((await relinkDraft(foreign.dir, generic)).status, 'skipped');
    const encrypted = makeDraft(oldRoot, '密文草稿', { pathOf: (_dir, parts) => ['', 'nowhere', ...parts].join('/') });
    fs.writeFileSync(path.join(encrypted.dir, 'draft_info.json'), 'ENCRYPTED-BYTES');
    assert.equal((await relinkDraft(encrypted.dir, generic)).status, 'skipped');
    assert.equal(fs.readFileSync(path.join(encrypted.dir, 'draft_info.json'), 'utf8'), 'ENCRYPTED-BYTES');

    // 7. 整个文件夹一起修，只报修过的。
    const batch = makeDraft(base, '批量', { pathOf: (_dir, parts) => ['', 'gone', 'x', ...parts].join('/') });
    const fixedList = await relinkDraftsIn(path.dirname(batch.dir), generic);
    assert.deepEqual(
      fixedList.map((item) => path.basename(item.dir)),
      ['批量'],
    );
    assert.deepEqual(await relinkDraftsIn(path.join(base, '不存在'), generic), []);

    // 7b. Windows：以前只写了 draft_info.json（Mac 版剪映读的），补一份 draft_content.json（Windows 版剪映读的）。
    const winDraft = makeDraft(base, 'Windows草稿', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    const winResult = await relinkDraft(winDraft.dir, { platform: 'win32' });
    assert.equal(winResult.windowsFile, true);
    assert.deepEqual(
      read(path.join(winDraft.dir, 'draft_content.json')),
      read(path.join(winDraft.dir, 'draft_info.json')),
      '内容和 draft_info.json 一样',
    );
    assert.ok(!(await relinkDraft(winDraft.dir, { platform: 'win32' })).windowsFile, '已经有了就不再写');
    assert.ok(!fs.existsSync(path.join(intact.dir, 'draft_content.json')), 'Mac / Linux 上不写');

    // 8. 路径写法和找回规则。
    assert.equal(nativePath('C:\\Users\\a\\素材\\视频\\1.mp4', 'win32'), 'C:/Users/a/素材/视频/1.mp4');
    assert.equal(nativePath('/Users/a/素材/1.mp4', 'darwin'), '/Users/a/素材/1.mp4');
    assert.equal(relocate('/x/素材/视频/不存在.mp4', movedDir), null);
    console.log(
      'PASS moved / copied / cross-machine Jianying drafts get their media paths relinked; intact and foreign drafts untouched',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
