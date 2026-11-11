'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { costReportPngRequirements } = require('./docx');
const { checkReportFonts } = require('./font-check');
const { finishReportPage } = require('./page-look');
const { renderWpsPdf } = require('./wps');

const run = promisify(execFile);

async function findLibreOffice() {
  const candidates =
    process.platform === 'darwin'
      ? [process.resourcesPath, '/Applications']
          .filter(Boolean)
          .map((root) => path.join(root, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'))
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

async function renderLibreOfficePdf(input, dir, office) {
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
      if (require('electron').app.isPackaged) {
        throw new Error('报告转换组件缺失，请重新安装完整版。');
      }
      throw new Error('导出 PNG 需要安装 LibreOffice。安装后再试。');
    }
    const output = (error.stderr?.trim() || error.stdout?.trim() || '').slice(0, 500);
    const code = Number.isInteger(error.code) && process.platform === 'win32'
      ? `0x${(error.code >>> 0).toString(16).padStart(8, '0').toUpperCase()}`
      : error.code || error.signal || '未知';
    console.warn('[cost-report] PDF conversion failed', { code, timedOut: Boolean(error.killed), output });
    if (error.killed) throw new Error('报告转换超时，请关闭软件后重试。');
    if (code === '0xC0000135' || code === '0xC0000139' || code === '0xC000007B') {
      throw new Error(`报告转换组件无法加载运行库（${code}），请重新安装 Windows 完整版。`);
    }
    throw new Error(`Word 报告转换失败（${code}）。请先确认报告能正常打开。`);
  }
  return fs.readFile(path.join(dir, 'report.pdf')).catch(() => {
    throw new Error(`LibreOffice 没有生成可用的报告 PDF${diagnostics ? `（${diagnostics}）` : ''}`);
  });
}

async function renderPages(data, library, worker, finishPage, checkFonts, requirements) {
  const pageSize = 2573;
  const maxPixels = 32_000_000;
  const moduleUrl = (source) =>
    URL.createObjectURL(new Blob([Uint8Array.fromBase64(source)], { type: 'text/javascript' }));
  const libraryUrl = moduleUrl(library);
  const workerUrl = moduleUrl(worker);
  const { getDocument, GlobalWorkerOptions, Util, OPS } = await import(libraryUrl);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({
    data: Uint8Array.fromBase64(data),
    useSystemFonts: true,
    stopAtErrors: true,
    fontExtraProperties: requirements.fonts.length > 0,
  });
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
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    const paintOps = new Set([
      OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
      OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.shadingFill, OPS.rawFillPath,
      OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
      OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask,
    ]);
    const usedFonts = new Map();
    const lines = new Map();
    for (const entry of pages) {
      const { page, viewport, w, h } = entry;
      const canvas = createCanvas(w, h);
      const canvasContext = canvas.getContext('2d');
      await page.render({ canvas, canvasContext, viewport, background: '#fff' }).promise;
      const { items } = await page.getTextContent();
      const textBoxes = items.filter((item) => item.str?.trim()).map((item) => {
        if (requirements.fonts.length && /[\p{L}\p{N}]/u.test(item.str)) {
          const font = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : null;
          const identity = usedFonts.get(item.fontName) || { name: font?.name, embedded: Boolean(font?.data) && !font.missingFile };
          identity.han ||= /\p{Script=Han}/u.test(item.str);
          usedFonts.set(item.fontName, identity);
        }
        if (requirements.singlePage) {
          const row = Math.round(item.transform[5] * 2);
          if (!lines.has(row)) lines.set(row, []);
          lines.get(row).push({ x: item.transform[4], text: item.str });
        }
        const [, , skew, size, x, baseline] = Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(skew, size);
        return { x, y: baseline - height, w: item.width * viewport.scale, h: height * 1.22 };
      });
      const glyphCanvas = createCanvas(w, h);
      const glyphContext = glyphCanvas.getContext('2d');
      await page.render({
        canvas: glyphCanvas,
        canvasContext: glyphContext,
        viewport,
        background: 'rgba(0,0,0,0)',
        annotationMode: 0,
        operationsFilter: (index, list) => {
          const op = list.fnArray[index];
          return !paintOps.has(op) && (op !== OPS.constructPath || !paintOps.has(list.argsArray[index][0]));
        },
      }).promise;
      const textGlyphs = glyphContext.getImageData(0, 0, w, h).data;
      glyphCanvas.width = 0;
      entry.raster = { canvas, canvasContext, textBoxes, textGlyphs };
      page.cleanup();
    }
    checkFonts(requirements, [...usedFonts.values()]);
    if (requirements.singlePage) {
      if (pdf.numPages !== 1) throw new Error('转换结果超出一页，无法按原模板导出 PNG。');
      const renderedLines = [...lines.values()].map((line) =>
        line.sort((a, b) => a.x - b.x).map(({ text }) => text).join('').normalize('NFKC').replace(/\s/g, ''),
      );
      if (requirements.notes.some((note) => !renderedLines.some((line) => line.includes(note)))) {
        throw new Error('转换时表头换行与原模板不一致，无法按原模板导出 PNG。');
      }
    }
    // WPS has already fixed the layout and each clean page is fully rasterized.
    let top = 0;
    for (const { raster, w, h } of pages) {
      finishPage(raster.canvasContext, w, h, raster.textBoxes, crypto.getRandomValues(new Uint32Array(1))[0], raster.textGlyphs);
      context.drawImage(raster.canvas, Math.floor((width - w) / 2), top);
      raster.canvas.width = 0;
      top += h;
    }
    return output.toDataURL('image/png');
  } finally {
    await task.destroy();
    URL.revokeObjectURL(libraryUrl);
    URL.revokeObjectURL(workerUrl);
  }
}

// 用沙盒窗口自带的画布，快速更新包也能在 Windows 和 Mac 上渲染。
async function renderPdf(pdf, requirements) {
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
    const script = `(${renderPages})(${args.join(',')}, ${finishReportPage}, ${checkReportFonts}, ${JSON.stringify(requirements)}).then(png => ({ png }), error => ({ error: error.message }))`;
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
    const requirements = costReportPngRequirements(docx);
    const input = path.join(dir, 'report.docx');
    await fs.writeFile(input, docx);
    const pdf = process.platform === 'win32' && !office
      ? await renderWpsPdf(input, path.join(dir, 'report.pdf'))
      : await renderLibreOfficePdf(input, dir, office || await findLibreOffice());
    return await renderPdf(pdf, requirements);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

module.exports = { renderCostReportPng };
