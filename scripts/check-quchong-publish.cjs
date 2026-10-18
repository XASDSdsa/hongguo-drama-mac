'use strict';
// 成品落盘：U 盘/移动硬盘（FAT32、exFAT）不支持硬链接时改用改名，且绝不覆盖已有文件；
// 上次中断留下的隐藏临时文件在开新批次时清掉，正在写的不动。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const quchong = require('../src/native/quchong');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quchong-publish-'));
  const realLink = fs.promises.link;
  try {
    // 1) 正常文件系统：硬链接成功，目标存在时拒绝。
    fs.writeFileSync(path.join(dir, 'a.tmp'), 'A');
    await quchong.publishOutput(path.join(dir, 'a.tmp'), path.join(dir, '剧_第001集.mp4'));
    assert.equal(fs.readFileSync(path.join(dir, '剧_第001集.mp4'), 'utf8'), 'A');
    fs.writeFileSync(path.join(dir, 'b.tmp'), 'B');
    await assert.rejects(
      quchong.publishOutput(path.join(dir, 'b.tmp'), path.join(dir, '剧_第001集.mp4')),
      /已拒绝覆盖/,
    );
    assert.equal(fs.readFileSync(path.join(dir, '剧_第001集.mp4'), 'utf8'), 'A', '已有成品不能被覆盖');

    // 2) 不支持硬链接（exFAT/FAT32 报 EPERM/ENOTSUP）：改名落盘，目标存在时同样拒绝。
    for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'EISDIR']) {
      fs.promises.link = async () => {
        throw Object.assign(new Error('link not supported'), { code });
      };
      const tmp = path.join(dir, `${code}.tmp`);
      const dst = path.join(dir, `剧_${code}.mp4`);
      fs.writeFileSync(tmp, code);
      await quchong.publishOutput(tmp, dst);
      assert.equal(fs.readFileSync(dst, 'utf8'), code);
      assert.equal(fs.existsSync(tmp), false, '改名后临时文件不再存在');
      fs.writeFileSync(tmp, 'other');
      await assert.rejects(quchong.publishOutput(tmp, dst), /已拒绝覆盖/);
      assert.equal(fs.readFileSync(dst, 'utf8'), code);
    }
    // 其他错误（比如磁盘满）照常抛出，不悄悄改名。
    fs.promises.link = async () => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    };
    fs.writeFileSync(path.join(dir, 'c.tmp'), 'C');
    await assert.rejects(quchong.publishOutput(path.join(dir, 'c.tmp'), path.join(dir, 'c.mp4')), /no space/);
    fs.promises.link = realLink;

    // 3) 清理中断留下的临时文件：只删超过时限的，正在写的保留；不碰别的文件。
    const old = Date.now() / 1000 - 3 * 3600;
    const stale = ['.hongguo-quchong-1.mp4', '.hongguo-quchong-pre-2.mkv'];
    for (const name of stale) {
      fs.writeFileSync(path.join(dir, name), 'x');
      fs.utimesSync(path.join(dir, name), old, old);
    }
    fs.mkdirSync(path.join(dir, '.hongguo-quchong-sep-3'));
    fs.writeFileSync(path.join(dir, '.hongguo-quchong-sep-3', 'audio.wav'), 'x');
    fs.utimesSync(path.join(dir, '.hongguo-quchong-sep-3'), old, old);
    fs.writeFileSync(path.join(dir, '.hongguo-quchong-live.mp4'), 'still writing');
    const removed = await quchong.sweepStaleTemps(dir);
    assert.equal(removed, 3);
    for (const name of [...stale, '.hongguo-quchong-sep-3']) assert.equal(fs.existsSync(path.join(dir, name)), false);
    assert.equal(fs.existsSync(path.join(dir, '.hongguo-quchong-live.mp4')), true, '正在写的临时文件不能删');
    assert.equal(fs.existsSync(path.join(dir, '剧_第001集.mp4')), true, '成品不能删');
    assert.equal(await quchong.sweepStaleTemps(path.join(dir, 'missing')), 0);
    console.log('PASS outputs never overwrite, work without hard links, and stale temp files are swept');
  } finally {
    fs.promises.link = realLink;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
