'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const run = promisify(execFile);

async function findLibreOffice() {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
      : process.platform === 'win32'
        ? [process.resourcesPath, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
            .filter(Boolean)
            .map((root) => path.join(root, 'LibreOffice', 'program', 'soffice.com'))
        : [];
  for (const file of candidates) {
    if (await fs.access(file).then(() => true, () => false)) return file;
  }
  return process.platform === 'win32' ? 'soffice.com' : 'soffice';
}

async function renderWord(docx, dir, office) {
  const input = path.join(dir, 'report.docx');
  await fs.writeFile(input, docx);
  const profile = pathToFileURL(path.join(dir, 'office-profile')).href;
  let diagnostics = '';
  try {
    const { stdout, stderr } = await run(office, [
      `-env:UserInstallation=${profile}`,
      '--headless',
      '--nologo',
      '--norestore',
      '--nodefault',
      '--convert-to',
      'pdf:writer_pdf_Export:{"UseLosslessCompression":{"type":"boolean","value":"true"}}',
      '--outdir',
      dir,
      input,
    ], {
      cwd: path.isAbsolute(office) ? path.dirname(office) : dir,
      env: process.platform === 'win32' ? { ...process.env, SAL_DISABLESKIA: '1' } : process.env,
      timeout: 60_000,
      windowsHide: true,
    });
    diagnostics = stderr.trim() || stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (process.platform === 'win32' && require('electron').app.isPackaged) {
        throw new Error('报告转换组件缺失，请重新安装 Windows 完整版。');
      }
      throw new Error('导出 PNG 需要安装 LibreOffice。安装后再试。');
    }
    if (error.killed) {
      const output = (error.stderr?.trim() || error.stdout?.trim() || '').slice(0, 500);
      throw new Error(`LibreOffice 渲染报告超时${output ? `（${output}）` : ''}，请重试。`);
    }
    throw error;
  }
  return fs.readFile(path.join(dir, 'report.pdf')).catch(() => {
    throw new Error(`LibreOffice 没有生成可用的报告 PDF${diagnostics ? `（${diagnostics}）` : ''}`);
  });
}

// 灰度纹理只应用到接近白色的纸面。章签和其他有色内容直接使用文档渲染结果。
function texturePaper(context, width, height) {
  const paper = context.getImageData(0, 0, width, height);
  const pixels = paper.data;
  function grainAt(x, y, seed) {
    let hash = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y, 0x119de1f3);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    return ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff;
  }
  function mottling(x, y, scale, seed) {
    const col = Math.floor(x / scale);
    const row = Math.floor(y / scale);
    const dx = x / scale - col;
    const dy = y / scale - row;
    const sx = dx * dx * (3 - 2 * dx);
    const sy = dy * dy * (3 - 2 * dy);
    const top = grainAt(col, row, seed) * (1 - sx) + grainAt(col + 1, row, seed) * sx;
    const bottom = grainAt(col, row + 1, seed) * (1 - sx) + grainAt(col + 1, row + 1, seed) * sx;
    return top * (1 - sy) + bottom * sy;
  }
  for (let y = 0; y < height; y++) {
    const row = y / height;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const low = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      const high = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if (low < 243 || high - low > 2) continue;
      const col = x / width;
      const texture = mottling(x, y, 173, 47);
      const tone = 5 * mottling(x, y, 137, 19) + 3 * mottling(x, y, 19, 59);
      const coarse = mottling(x, y, 3, 83) - 0.5;
      const fine = grainAt(x, y, 101) - 0.5;
      const grain = (4 + 9 * texture) * coarse + (8 + 6 * (1 - texture)) * fine;
      const shade = (9 + 1.5 * col + 1.5 * row + tone + grain) * (low - 243) / 12;
      pixels[offset] -= shade;
      pixels[offset + 1] -= shade;
      pixels[offset + 2] -= shade;
    }
  }
  context.putImageData(paper, 0, 0);
}

async function renderPages(data, library, worker, applyTexture) {
  const pageSize = 1600;
  const tilt = -0.35 * Math.PI / 180;
  const maxPixels = 32_000_000;
  const moduleUrl = (source) =>
    URL.createObjectURL(new Blob([Uint8Array.fromBase64(source)], { type: 'text/javascript' }));
  const libraryUrl = moduleUrl(library);
  const workerUrl = moduleUrl(worker);
  const { getDocument, GlobalWorkerOptions } = await import(libraryUrl);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({ data: Uint8Array.fromBase64(data), useSystemFonts: true, stopAtErrors: true });
  const createCanvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
  try {
    const pdf = await task.promise;
    const pages = [];
    let height = 0;
    let width = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pageSize / Math.max(original.width, original.height) });
      const w = Math.ceil(viewport.width);
      const h = Math.ceil(viewport.height);
      width = Math.max(width, w);
      height += h;
      if (width * height > maxPixels || height > 16_384) throw new Error('报告页数太多，无法导出到一张 PNG。');
      pages.push({ page, viewport, w, h });
    }
    const output = createCanvas(width, height);
    const context = output.getContext('2d', { alpha: false });
    context.fillStyle = '#f3f3f3';
    context.fillRect(0, 0, width, height);
    let top = 0;
    for (const { page, viewport, w, h } of pages) {
      const canvas = createCanvas(w, h);
      const canvasContext = canvas.getContext('2d');
      await page.render({ canvas, canvasContext, viewport, background: '#fff' }).promise;
      applyTexture(canvasContext, w, h);
      const left = Math.floor((width - w) / 2);
      // 略微放大旋转后的纸面，让四角都被覆盖。每页保留原宽高，避免影响相邻页。
      const scale = Math.cos(tilt) + Math.abs(Math.sin(tilt)) * Math.max(w / h, h / w) + 2 / Math.min(w, h);
      context.save();
      context.beginPath();
      context.rect(left, top, w, h);
      context.clip();
      context.translate(left + w / 2, top + h / 2);
      context.rotate(tilt);
      context.scale(scale, scale);
      context.drawImage(canvas, -w / 2, -h / 2);
      context.restore();
      top += h;
      page.cleanup();
    }
    return output.toDataURL('image/png');
  } finally {
    await task.destroy();
    URL.revokeObjectURL(libraryUrl);
    URL.revokeObjectURL(workerUrl);
  }
}

// 用沙盒窗口自带的画布，快速更新包也能在 Windows 和 Mac 上渲染。
async function renderPdf(pdf) {
  const { BrowserWindow } = require('electron');
  const { PNG } = require('pngjs');
  const [library, worker] = await Promise.all([
    fs.readFile(require.resolve('pdfjs-dist/build/pdf.min.mjs'), 'base64'),
    fs.readFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), 'base64'),
  ]);
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  try {
    await window.loadURL('about:blank');
    const args = [pdf.toString('base64'), library, worker].map((part) => JSON.stringify(part));
    const script = `(${renderPages})(${args.join(',')}, ${texturePaper}).then(png => ({ png }), error => ({ error: error.message }))`;
    const { png, error } = await window.webContents.executeJavaScript(script);
    const prefix = 'data:image/png;base64,';
    if (!png?.startsWith(prefix)) throw new Error(error || '报告 PNG 渲染失败');
    const encoded = Buffer.from(png.slice(prefix.length), 'base64');
    // Chromium 即使在不透明画布上也可能输出 RGBA。保存时统一使用 RGB。
    const pixels = PNG.sync.read(encoded);
    return PNG.sync.write(pixels, { colorType: 2 });
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function renderCostReportPng(docx, { office } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-report-png-'));
  try {
    const pdf = await renderWord(docx, dir, office || await findLibreOffice());
    return await renderPdf(pdf);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

module.exports = { renderCostReportPng };
