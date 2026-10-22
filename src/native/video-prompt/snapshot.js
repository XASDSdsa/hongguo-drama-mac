'use strict';
// 分镜工程图截图：页头 + 前两个分镜，存成一张 JPG（同名 .jpg）：网页在「分镜工程图/网页和提示词」里，截图放「分镜工程图」里。
// 管理剧集里按集显示这张图（固定大小，点开看大图）；要看完整的交互页面再打开 HTML。

const fsp = require('node:fs/promises');
const path = require('node:path');
const { storyboardImageFor } = require('../series-layout');

const SNAPSHOT_WIDTH = 1440; // 和设计稿一样宽，三栏卡片不挤
const MAX_HEIGHT = 8000;

/** 网页对应的截图文件：网页在「网页和提示词」里时放上一层的「分镜工程图」，以前的（还没挪的）放网页旁边。 */
function snapshotFile(htmlFile) {
  return storyboardImageFor(htmlFile);
}

/** 页面里跑：等字体和图片都好了，量出「页头 + 前 shots 个分镜」到哪为止（像素）。 */
function measureScript(shots) {
  // 隐藏窗口里：懒加载的图片在可见区外面永远不加载、requestAnimationFrame 不跑，所以先全部改成立刻加载，
  // 每样最多等 3 秒，等不到也照样截。
  return `(async () => {
    const wait = (promise) => Promise.race([promise, new Promise((done) => setTimeout(done, 3000))]);
    document.documentElement.style.overflow = 'hidden'; // 截图里不要滚动条
    try { await wait(document.fonts ? document.fonts.ready : null); } catch (_) {}
    for (const img of document.images) img.loading = 'eager';
    await wait(Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; })))));
    await new Promise((done) => setTimeout(done, 150));
    const cards = document.querySelectorAll('article.shot');
    const last = cards[Math.min(${Number(shots) || 2}, cards.length) - 1];
    const full = document.documentElement.scrollHeight;
    const bottom = last ? last.getBoundingClientRect().bottom + window.scrollY + 8 : full;
    return Math.ceil(Math.min(bottom, full));
  })()`;
}

/**
 * 截一张分镜工程图。driver：{ open(file, width), evaluate(code), resize(width, height), capture(clip, quality), close() }。
 * 先写临时文件再改名，截到一半出错不会留下半张图。返回截图路径。
 */
async function captureStoryboard({ driver, htmlFile, outFile = snapshotFile(htmlFile), shots = 2, quality = 85 }) {
  await driver.open(htmlFile, SNAPSHOT_WIDTH);
  try {
    // 页面里有些高度跟着窗口高度走：量一次、把窗口拉到那么高、再量，直到不变（最多 3 次）
    let height = 0;
    for (let round = 0; round < 3; round++) {
      const next = Number(await driver.evaluate(measureScript(shots)));
      if (!(next > 100)) throw new Error('分镜工程图页面是空的');
      if (Math.abs(next - height) <= 1) break;
      height = Math.min(next, MAX_HEIGHT);
      await driver.resize(SNAPSHOT_WIDTH, height);
    }
    const bytes = await driver.capture({ x: 0, y: 0, width: SNAPSHOT_WIDTH, height: Math.min(height, MAX_HEIGHT) }, quality);
    if (!bytes?.length || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('截图不是 JPG');
    const temp = `${outFile}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await fsp.writeFile(temp, bytes);
    await fsp.rename(temp, outFile);
    return outFile;
  } finally {
    await driver.close();
  }
}

/**
 * 软件里用的截图方式：离屏窗口（offscreen 渲染到内存，不显示、不占任务栏，窗口多高都行，不受屏幕大小限制）。
 * 量好高度后把窗口拉到那么高，等它画好再整张截下来。
 */
function electronSnapshotDriver(BrowserWindow) {
  let win = null;
  return {
    async open(file, width) {
      win = new BrowserWindow({
        show: false,
        width,
        height: 900,
        useContentSize: true,
        frame: false,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
      });
      win.webContents.setFrameRate(30);
      await win.loadFile(file);
    },
    evaluate: (code) => win.webContents.executeJavaScript(code, true),
    async resize(width, height) {
      win.setContentSize(width, height);
      // 等离屏窗口按新尺寸画出一帧（最多 3 秒）
      await new Promise((done) => {
        const timer = setTimeout(done, 3000);
        const onPaint = (_event, _dirty, image) => {
          const size = image.getSize();
          if (size.height >= height - 2) {
            clearTimeout(timer);
            win.webContents.off('paint', onPaint);
            setTimeout(done, 200);
          }
        };
        win.webContents.on('paint', onPaint);
        win.webContents.invalidate();
      });
    },
    async capture(clip, quality) {
      const image = await win.webContents.capturePage(clip);
      if (image.isEmpty()) throw new Error('截图是空的');
      const { width } = image.getSize();
      // 高分屏上截出来是 2 倍像素：缩回设计宽度
      return (width > clip.width ? image.resize({ width: clip.width, quality: 'best' }) : image).toJPEG(quality);
    },
    async close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { SNAPSHOT_WIDTH, snapshotFile, measureScript, captureStoryboard, electronSnapshotDriver };
