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
    '<w:body><w:p><w:r><w:t>成本配置报告 — Windows test</w:t></w:r></w:p>' +
    `<w:p><w:r>${picture}</w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
    '<w:p><w:r><w:t>Page two</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
    '</w:body></w:document>',
  'word/media/test.png': testImage,
};

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const runtime = process.argv[2] || 'build/libreoffice/win32-x64';
  const office = path.resolve(runtime, 'program', 'soffice.com');
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
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
