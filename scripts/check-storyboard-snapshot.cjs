'use strict';
// 分镜工程图截图：页头 + 前两个分镜。用假的窗口跑截图流程（真窗口在打包后的软件里），看：
// - 截图文件名就是 HTML 同名 .jpg
// - 页面高度跟着窗口变时，量到不变为止再截；截的是 1440 宽、量到的高度
// - 截出来不是 JPG、页面是空的：报错，不留半张图；窗口一定关掉
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const snapshot = require('../src/native/video-prompt/snapshot');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function fakeDriver({ heights, bytes = JPEG }) {
  const calls = [];
  let round = 0;
  return {
    calls,
    async open(file, width) {
      calls.push(['open', path.basename(file), width]);
    },
    async evaluate(code) {
      calls.push(['measure', /article\.shot/.test(code) && /Math\.min\(2,/.test(code) && /loading = 'eager'/.test(code)]);
      return heights[Math.min(round++, heights.length - 1)];
    },
    async resize(width, height) {
      calls.push(['resize', width, height]);
    },
    async capture(clip, quality) {
      calls.push(['capture', clip, quality]);
      return bytes;
    },
    async close() {
      calls.push(['close']);
    },
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '分镜截图-'));
  try {
    const html = path.join(dir, '新剧 - 第1集.html');
    fs.writeFileSync(html, '<html></html>');
    assert.equal(snapshot.snapshotFile(html), path.join(dir, '新剧 - 第1集.jpg'));

    // 页面高度随窗口变了一次（1759 → 1818），第三次量不变才截
    const driver = fakeDriver({ heights: [1759, 1818, 1818] });
    const out = await snapshot.captureStoryboard({ driver, htmlFile: html });
    assert.equal(out, snapshot.snapshotFile(html));
    assert.ok(fs.readFileSync(out).equals(JPEG));
    assert.deepEqual(driver.calls, [
      ['open', '新剧 - 第1集.html', 1440],
      ['measure', true],
      ['resize', 1440, 1759],
      ['measure', true],
      ['resize', 1440, 1818],
      ['measure', true],
      ['capture', { x: 0, y: 0, width: 1440, height: 1818 }, 85],
      ['close'],
    ]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['新剧 - 第1集.html', '新剧 - 第1集.jpg'], '没有留下临时文件');

    // 特别长的页面：最多截 8000 像素高
    const tall = fakeDriver({ heights: [20000] });
    await snapshot.captureStoryboard({ driver: tall, htmlFile: html });
    assert.equal(tall.calls.find((call) => call[0] === 'capture')[1].height, 8000);

    // 页面是空的、截出来不是 JPG：报错，原来那张图不动，窗口照样关掉
    for (const [label, options, message] of [
      ['空页面', { heights: [0] }, /页面是空的/],
      ['不是 JPG', { heights: [900], bytes: Buffer.from('PNG') }, /不是 JPG/],
    ]) {
      const bad = fakeDriver(options);
      await assert.rejects(snapshot.captureStoryboard({ driver: bad, htmlFile: html }), message, label);
      assert.deepEqual(bad.calls.at(-1), ['close'], `${label}：窗口关掉`);
      assert.ok(fs.readFileSync(out).equals(JPEG), `${label}：上次的截图还在`);
    }
    console.log('PASS storyboard snapshot: header + first two shots, re-measured after resize, JPG only, window always closed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
