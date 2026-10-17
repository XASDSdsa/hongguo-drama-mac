// 测试用：用 Playwright 的 Chromium 当海报标题渲染页的驱动（和应用里的隐藏窗口等价）。
// 没有浏览器时 open() 返回 null，调用方应当跳过相关检查。
const fs = require('node:fs');
const path = require('node:path');

function findPlaywright() {
  for (const name of ['playwright-core', '/opt/node-tools/node_modules/playwright-core']) {
    try {
      return require(name);
    } catch (_) {}
  }
  return null;
}

function findChromium() {
  const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

async function openBrowser() {
  const playwright = findPlaywright();
  const executablePath = findChromium();
  if (!playwright || !executablePath) return null;
  const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const driver = {
    open: (url) => page.goto(url),
    evaluate: (code) => page.evaluate(code),
    close: async () => {},
  };
  return { browser, page, driver, close: () => browser.close() };
}

const FONTS_DIR = path.join(__dirname, '..', '..', 'build', 'title-fonts');

/** 在页面里画一张没有文字的示意底图（用来测版式，不是真海报）。 */
function backgroundScript(kind, W = 1024, H = 1536) {
  return `(() => {
    const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H};
    const g = c.getContext('2d');
    const kind = ${JSON.stringify(kind)};
    const sky = g.createLinearGradient(0, 0, 0, ${H});
    if (kind === 'dusk') { sky.addColorStop(0, '#3a2a63'); sky.addColorStop(0.5, '#c4577a'); sky.addColorStop(1, '#f5a24b'); }
    else if (kind === 'night') { sky.addColorStop(0, '#0b1230'); sky.addColorStop(1, '#1d3a6b'); }
    else { sky.addColorStop(0, '#fbe3ee'); sky.addColorStop(1, '#fff6d8'); }
    g.fillStyle = sky; g.fillRect(0, 0, ${W}, ${H});
    const person = (x, y, s, coat) => {
      g.fillStyle = coat; g.beginPath(); g.moveTo(x - 190 * s, y + 520 * s); g.quadraticCurveTo(x - 160 * s, y + 150 * s, x, y + 120 * s);
      g.quadraticCurveTo(x + 160 * s, y + 150 * s, x + 190 * s, y + 520 * s); g.fill();
      g.fillStyle = '#e8b08e'; g.beginPath(); g.ellipse(x, y, 82 * s, 104 * s, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1a1210'; g.beginPath(); g.ellipse(x, y - 50 * s, 90 * s, 70 * s, 0, Math.PI, 0); g.fill();
    };
    if (kind === 'dusk') {
      person(360, 520, 1.15, '#1c1b2e'); person(650, 560, 1.05, '#7d1d3f');
      for (let i = 0; i < 26; i += 1) { const w = 60 + (i * 37) % 70, h = 200 + (i * 91) % 260; g.fillStyle = '#16121f'; g.fillRect(i * 42, ${H} - h, w, h);
        for (let k = 0; k < 6; k += 1) { g.fillStyle = '#ffd36a'; g.fillRect(i * 42 + 8 + (k % 3) * 18, ${H} - h + 16 + Math.floor(k / 3) * 30, 8, 12); } }
    } else if (kind === 'night') {
      g.fillStyle = '#f4f1d0'; g.beginPath(); g.arc(800, 260, 90, 0, Math.PI * 2); g.fill();
      person(512, 560, 1.3, '#0c0f1f');
    } else {
      person(512, 1130, 1.2, '#f0b6c8');
    }
    return c.toDataURL('image/jpeg', 0.92);
  })()`;
}

module.exports = { openBrowser, backgroundScript, FONTS_DIR };
