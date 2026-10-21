'use strict';
// 剪映草稿挪了位置后，软件把草稿里的素材路径改到新位置（剪映打开不会「资源未找到」）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { relinkDraft, relinkDraftsIn, relocate, nativePath } = require('../src/native/jianying-relink');

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

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '草稿挪位置-'));
  try {
    const oldRoot = path.join(base, '旧位置', '剪映草稿');
    const newRoot = path.join(base, '新位置', 'com.lveditor.draft');
    fs.mkdirSync(oldRoot, { recursive: true });
    fs.mkdirSync(newRoot, { recursive: true });

    // 1. 正常的草稿（没挪过）：一个字都不改。
    const intact = makeDraft(newRoot, '没挪过', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    const before = fs.readFileSync(path.join(intact.dir, 'draft_info.json'), 'utf8');
    const intactResult = await relinkDraft(intact.dir);
    assert.equal(intactResult.status, 'ok');
    assert.equal(intactResult.fixed, 0);
    assert.equal(fs.readFileSync(path.join(intact.dir, 'draft_info.json'), 'utf8'), before);

    // 2. 整个草稿文件夹挪走（老位置已经没有了）：路径改到新位置，素材都找得到。
    const moved = makeDraft(oldRoot, '挪过的草稿', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    const movedDir = path.join(newRoot, '挪过的草稿');
    fs.renameSync(moved.dir, movedDir);
    const movedResult = await relinkDraft(movedDir);
    assert.equal(movedResult.status, 'fixed');
    assert.equal(movedResult.fixed, 2);
    const content = read(path.join(movedDir, 'draft_info.json'));
    assert.equal(content.materials.videos[0].path, nativePath(path.join(movedDir, '素材', '视频', '第1集.mp4')));
    assert.equal(
      content.materials.audios[0].path,
      nativePath(path.join(movedDir, '素材', '音频', '人声-整集时间轴.wav')),
    );
    assert.equal(content.materials.audios[1].path, '', '云端音乐不动');
    for (const material of [...content.materials.videos, content.materials.audios[0]])
      assert.ok(fs.existsSync(material.path));
    const meta = read(path.join(movedDir, 'draft_meta_info.json'));
    assert.equal(meta.draft_fold_path, nativePath(movedDir));
    assert.equal(meta.draft_root_path, nativePath(newRoot));
    assert.deepEqual(
      meta.draft_materials[0].value.map((item) => item.file_Path),
      [content.materials.videos[0].path, content.materials.audios[0].path],
    );
    // 再跑一次：已经修好，不再改。
    assert.equal((await relinkDraft(movedDir)).fixed, 0);

    // 3. Windows 生成、路径是 C:/… 或 C:\… 写法，拿到别的电脑上：按「素材/…」找回来。
    for (const [label, pathOf] of [
      ['正斜杠', (_dir, parts) => ['C:', 'Users', '张三', 'AppData', '某草稿', ...parts].join('/')],
      ['反斜杠', (_dir, parts) => ['D:', '短剧', '剪映草稿', '某草稿', ...parts].join('\\')],
      ['Mac', (_dir, parts) => ['', 'Users', 'me', 'Movies', '某草稿', ...parts].join('/')],
    ]) {
      const other = makeDraft(newRoot, `别的电脑-${label}`, { pathOf });
      const result = await relinkDraft(other.dir);
      assert.equal(result.status, 'fixed', label);
      const fixed = read(path.join(other.dir, 'draft_info.json'));
      assert.ok(fs.existsSync(fixed.materials.videos[0].path), label);
      assert.ok(fs.existsSync(fixed.materials.audios[0].path), label);
    }

    // 4. 草稿是拷过来的（老位置那份还在）：改成指向自己这份，老位置以后删了也不影响。
    const original = makeDraft(oldRoot, '拷贝来源', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    const copyDir = path.join(newRoot, '拷贝来源');
    fs.cpSync(original.dir, copyDir, { recursive: true });
    const copyResult = await relinkDraft(copyDir);
    assert.equal(copyResult.fixed, 2);
    assert.ok(read(path.join(copyDir, 'draft_info.json')).materials.videos[0].path.startsWith(nativePath(copyDir)));
    assert.ok(
      read(path.join(original.dir, 'draft_info.json')).materials.videos[0].path.startsWith(original.dir),
      '来源那份不动',
    );

    // 5. 素材真的丢了：报告找不到，不乱改。
    const lost = makeDraft(oldRoot, '素材丢了', { pathOf: (dir, parts) => path.join(dir, ...parts) });
    fs.rmSync(path.join(lost.dir, '素材'), { recursive: true });
    const lostResult = await relinkDraft(lost.dir);
    assert.equal(lostResult.status, 'missing');
    assert.equal(lostResult.missing.length, 2);

    // 6. 不是软件做的草稿（没有 draft-manifest.json）、剪映存成密文的草稿：不碰。
    const foreign = makeDraft(oldRoot, '用户自己的草稿', {
      manifest: false,
      pathOf: (_dir, parts) => ['', 'nowhere', ...parts].join('/'),
    });
    assert.equal((await relinkDraft(foreign.dir)).status, 'skipped');
    const encrypted = makeDraft(oldRoot, '密文草稿', { pathOf: (_dir, parts) => ['', 'nowhere', ...parts].join('/') });
    fs.writeFileSync(path.join(encrypted.dir, 'draft_info.json'), 'ENCRYPTED-BYTES');
    assert.equal((await relinkDraft(encrypted.dir)).status, 'skipped');
    assert.equal(fs.readFileSync(path.join(encrypted.dir, 'draft_info.json'), 'utf8'), 'ENCRYPTED-BYTES');

    // 7. 整个文件夹一起修，只报修过的。
    const batch = makeDraft(base, '批量', { pathOf: (_dir, parts) => ['', 'gone', 'x', ...parts].join('/') });
    const fixedList = await relinkDraftsIn(path.dirname(batch.dir));
    assert.deepEqual(
      fixedList.map((item) => path.basename(item.dir)),
      ['批量'],
    );
    assert.deepEqual(await relinkDraftsIn(path.join(base, '不存在')), []);

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
