'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app } = require('electron');
const { PNG } = require('pngjs');
const { writeZip } = require('../src/native/cost-report/zip');
const { renderCostReportPng } = require('../src/native/cost-report/png');

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pkgRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const picture =
  '<w:drawing><wp:inline><wp:extent cx="457200" cy="457200"/><wp:docPr id="1" name="Test image"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  '<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Test image"/><pic:cNvPicPr/></pic:nvPicPr>' +
  '<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
  '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm>' +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing>';
const testImage = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([174, 23, 43, 255]) });
const entries = {
  '[Content_Types].xml':
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>',
  '_rels/.rels': `<Relationships xmlns="${pkgRel}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="${pkgRel}"><Relationship Id="rId1" Type="${rel}/image" Target="media/test.png"/></Relationships>`,
  'word/document.xml':
    `<w:document xmlns:w="${w}" xmlns:r="${rel}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body><w:p><w:r><w:t>成本配置报告 — Offline test</w:t></w:r></w:p>' +
    `<w:p><w:r>${picture}</w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
    '<w:p><w:r><w:t>Page two</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
    '</w:body></w:document>',
  'word/media/test.png': testImage,
};

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const mac = process.platform === 'darwin';
  const runtime = process.argv[2] || (mac ? 'build/libreoffice/darwin-arm64' : 'build/libreoffice/win32-x64');
  const office = path.resolve(runtime, mac ? 'LibreOffice.app/Contents/MacOS/soffice' : 'program/soffice.com');
  const docx = writeZip(Object.entries(entries).map(([name, data]) => ({ name, data: Buffer.from(data) })));
  const bytes = await renderCostReportPng(docx, { office });
  assert.equal(bytes[25], 2, 'export must be RGB');
  const { width, height, data } = PNG.sync.read(bytes);
  assert(width > 1100 && height >= 3200, 'both A4 pages must be rendered');
  let marks = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 130 && data[i + 1] < 75 && data[i + 2] < 95) marks++;
  }
  assert(marks > 500, 'embedded image must be preserved in the export');
  console.log(`PASS offline Word-to-PNG with bundled office: ${width} × ${height}, ${marks} image pixels`);
  const paragraph = (text) => '<w:p><w:r><w:rPr><w:rFonts w:ascii="仿宋_GB2312" w:eastAsia="仿宋_GB2312"/>' +
    '<w:sz w:val="28"/></w:rPr><w:t>' + text + '</w:t></w:r></w:p>';
  const cell = (content) => '<w:tc><w:tcPr><w:tcW w:w="1800" w:type="dxa"/></w:tcPr>' + content + '</w:tc>';
  const headers = ['序号', '微短剧名称', '集数和总时长', '总投资额', '演员总片酬占比'];
  const notes = ['', '', '', '（需＜100万）', '（需＜40%）'];
  const table = '<w:tbl><w:tblPr/><w:tblGrid>' + '<w:gridCol w:w="1800"/>'.repeat(5) + '</w:tblGrid>' +
    '<w:tr>' + headers.map((text, index) => cell(paragraph(text) + (notes[index] ? paragraph(notes[index]) : ''))).join('') + '</w:tr>' +
    '<w:tr>' + ['1', '合成测试', '71集', '6万元', '15%'].map((text) => cell(paragraph(text))).join('') + '</w:tr></w:tbl>';
  const body = paragraph('成本配置比例情况报告') + table + `<w:p><w:r>${picture}</w:r></w:p>` +
    paragraph('2026年11月10号') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>';
  const onePage = { ...entries, 'word/document.xml': entries['word/document.xml'].replace(/<w:body>[\s\S]*<\/w:body>/, '<w:body>' + body + '</w:body>') };
  const report = writeZip(Object.entries(onePage).map(([name, data]) => ({ name, data: Buffer.from(data) })));
  const rendered = PNG.sync.read(await renderCostReportPng(report, { office }));
  assert.equal(rendered.height, 2573, 'report fits on one page');
  assert.ok(Math.abs(rendered.width / rendered.height - 210 / 297) < 0.002, 'A4 aspect ratio');
  function paperDeviation(yStart) {
    let sum = 0;
    let squares = 0;
    let count = 0;
    for (let y = yStart; y < yStart + 80; y++) {
      for (let x = 20; x < rendered.width - 20; x++) {
        const value = rendered.data[(y * rendered.width + x) * 4];
        sum += value;
        squares += value * value;
        count++;
      }
    }
    return Math.sqrt(squares / count - (sum / count) ** 2);
  }
  const upper = paperDeviation(10);
  const lower = paperDeviation(rendered.height - 90);
  assert.ok(upper > 2 && lower < 6 && lower > upper + 0.3, `paper grain varies by region: ${upper}, ${lower}`);
  console.log(`PASS A4 report layout and paper grain: ${rendered.width} × ${rendered.height}`);

  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
