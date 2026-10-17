/**
 * 海报标题渲染器（主进程一侧）。
 *
 * 真正的绘制在 poster-render/render.js，跑在一个隐藏的 Chromium 页面里：这样不用
 * 引入任何原生图形库，字体、描边、渐变都用浏览器自带的 Canvas。这里只负责：
 *   - 找到打包好的字体目录；
 *   - 起一个隐藏页面（Electron BrowserWindow，测试里是 Playwright 的 page）；
 *   - 把底图和标题参数送进去，把成品图取出来。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveStyle } = require('./poster-styles');

const RENDER_HTML = path.join(__dirname, 'poster-render', 'render.html');

function titleFontsDir({ resourcesPath, projectRoot } = {}) {
  const candidates = [
    process.env.HONGGUO_TITLE_FONTS_DIR,
    resourcesPath && path.join(resourcesPath, 'title-fonts'),
    projectRoot && path.join(projectRoot, 'build', 'title-fonts'),
  ].filter(Boolean);
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'fonts.css')));
  if (!found) throw new Error('缺少海报标题字体，请重新安装应用（开发环境运行 npm run setup:title-fonts）');
  return found;
}

function imageToDataUrl(buffer, contentType) {
  const type = contentType || sniffType(buffer);
  return `data:${type};base64,${Buffer.from(buffer).toString('base64')}`;
}

function sniffType(buffer) {
  const head = Buffer.from(buffer).subarray(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

/**
 * driver: { open(url) -> Promise, evaluate(expression) -> Promise<any>, close() }
 * 由调用方提供（Electron 的隐藏窗口，或测试里的 Playwright 页面）。
 */
function createTitleRenderer({ fontsDir, driver }) {
  if (!driver) throw new Error('缺少渲染驱动');
  const fontsCss = pathToFileURL(path.join(fontsDir, 'fonts.css')).href;
  let ready = null;

  const start = () => {
    if (!ready) {
      ready = (async () => {
        await driver.open(pathToFileURL(RENDER_HTML).href);
        await driver.evaluate(`window.PosterTitle.loadFontCss(${JSON.stringify(fontsCss)})`);
      })().catch((error) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  };

  return {
    /** @returns {Promise<{buffer: Buffer, contentType: string, meta: object}>} */
    async render({ image, contentType, title, tagline = '', styleId, layout = 'auto', faces = [], format = 'jpeg' }) {
      await start();
      const spec = {
        image: imageToDataUrl(image, contentType),
        title,
        tagline,
        style: resolveStyle(styleId),
        layout,
        faces: (faces || []).filter((f) => f && [f.x, f.y, f.w, f.h].every(Number.isFinite)),
        format,
      };
      const result = await driver.evaluate(`window.PosterTitle.render(${JSON.stringify(spec)})`);
      const match = /^data:([^;]+);base64,(.+)$/s.exec(result?.dataUrl || '');
      if (!match) throw new Error('标题渲染没有返回图片');
      return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1], meta: result.meta };
    },
    async close() {
      ready = null;
      await driver.close();
    },
  };
}

/** Electron 隐藏窗口驱动。 */
function electronDriver(BrowserWindow) {
  let win = null;
  return {
    async open(url) {
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: false },
      });
      await win.loadURL(url);
    },
    evaluate: (code) => win.webContents.executeJavaScript(code, true),
    async close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createTitleRenderer, electronDriver, titleFontsDir, sniffType, RENDER_HTML };
