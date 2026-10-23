'use strict';
// 按用户自己的 Word 模板（《成本配置比例情况报告》）填一份：只改表格里那一行（微短剧名称、集数和总时长、总投资额、
// 演员总片酬占比）和落款日期，其余文字、格式、公章、签名一个字节都不动。
// 模板里有公章和签名，只存在用户电脑上（见 main.js），不进仓库、不进安装包。
const { readZip, writeZip } = require('./zip');

const DOCUMENT = 'word/document.xml';
const DATE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*([号日])/;
const TEXT = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const PARAGRAPH = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = (text) =>
  String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const textOf = (xml) => [...xml.matchAll(TEXT)].map((match) => unescapeXml(match[1])).join('');

/** 表格：找表头有「微短剧名称」的那张表，返回 { table, header, row, cells }（row 是表头下面第一行）。 */
function findTable(xml) {
  for (const match of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
    const rows = [...match[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((m) => m[0]);
    const headerIndex = rows.findIndex((row) => textOf(row).includes('微短剧名称'));
    if (headerIndex < 0 || headerIndex + 1 >= rows.length) continue;
    const header = rows[headerIndex];
    const row = rows[headerIndex + 1];
    const cellsOf = (r) => [...r.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => m[0]);
    const titles = cellsOf(header).map(textOf);
    const cells = cellsOf(row);
    const column = (word) => titles.findIndex((title) => title.includes(word));
    const columns = { name: column('名称'), episodes: column('集数'), total: column('投资'), share: column('片酬') };
    if (Object.values(columns).some((index) => index < 0 || index >= cells.length)) continue;
    return { table: match[0], row, cells, columns };
  }
  return null;
}

/** 模板能不能用：返回缺了什么（空数组就是能用）。 */
function checkTemplate(buffer) {
  let xml;
  try {
    const doc = readZip(buffer).find((entry) => entry.name === DOCUMENT);
    if (!doc) return ['这不是 Word 文件（docx）'];
    xml = doc.data.toString('utf8');
  } catch (error) {
    return [error.message];
  }
  const problems = [];
  if (!findTable(xml))
    problems.push('没找到表格（表头要有「微短剧名称」「集数和总时长」「总投资额」「演员总片酬占比」，下面一行填数）');
  if (![...xml.matchAll(PARAGRAPH)].some((match) => DATE.test(textOf(match[0]))))
    problems.push('没找到落款日期（像「2026年10月3号」这样）');
  return problems;
}

/** 一个格子换成一段文字：保留段落格式（居中、行距）和原来的字体字号。 */
function setCell(cell, text, fallbackStyle) {
  const paragraphs = [...cell.matchAll(PARAGRAPH)];
  if (!paragraphs.length) return cell;
  const first = paragraphs[0][0];
  const open = first.match(/^<w:p\b[^>]*>/)[0];
  const pPr = first.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || '';
  const runStyle =
    first.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/)?.[1] ||
    pPr.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ||
    fallbackStyle ||
    '';
  const paragraph = `${open}${pPr}<w:r>${runStyle}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  // 第一段换掉，其余段落去掉（一格一段）
  let index = 0;
  return cell.replace(PARAGRAPH, () => (index++ === 0 ? paragraph : ''));
}

/**
 * fields：{ name, episodes, total, share, date: Date }，前四个是写进表格的文字。
 * 返回新的 docx（Buffer）。
 */
function fillCostReport(template, fields) {
  const entries = readZip(template);
  const doc = entries.find((entry) => entry.name === DOCUMENT);
  if (!doc) throw new Error('这不是 Word 文件（docx）');
  let xml = doc.data.toString('utf8');
  const found = findTable(xml);
  if (!found) throw new Error('模板里没找到报告表格');
  const { table, row, cells, columns } = found;
  // 原来空着的格子没有字体：用同一行里已经有字的格子的字体
  const fallbackStyle = row.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/)?.[1] || '';
  const values = {
    [columns.name]: fields.name,
    [columns.episodes]: fields.episodes,
    [columns.total]: fields.total,
    [columns.share]: fields.share,
  };
  let index = 0;
  const newRow = row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, (cell) => {
    const value = values[index++];
    return value == null ? cell : setCell(cell, value, fallbackStyle);
  });
  xml = xml.replace(table, () => table.replace(row, () => newRow));

  // 落款日期：最后一个像「2026年10月3号」的段落，号 / 日照模板的写法
  const date = fields.date instanceof Date ? fields.date : new Date();
  const paragraphs = [...xml.matchAll(PARAGRAPH)].filter((match) => DATE.test(textOf(match[0])));
  const last = paragraphs[paragraphs.length - 1];
  if (last) {
    const before = textOf(last[0]);
    const suffix = before.match(DATE)[4];
    const after = before.replace(DATE, `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}${suffix}`);
    let first = true;
    const replaced = last[0].replace(TEXT, () => {
      if (!first) return '<w:t></w:t>';
      first = false;
      return `<w:t xml:space="preserve">${escapeXml(after)}</w:t>`;
    });
    xml = xml.slice(0, last.index) + replaced + xml.slice(last.index + last[0].length);
  }
  doc.data = Buffer.from(xml, 'utf8');
  return writeZip(entries);
}

/** 读回报告里表格那一行和日期（测试、界面核对用）。 */
function readCostReport(buffer) {
  const doc = readZip(buffer).find((entry) => entry.name === DOCUMENT);
  const xml = doc.data.toString('utf8');
  const found = findTable(xml);
  const cellText = (index) => textOf(found.cells[index]);
  const dates = [...xml.matchAll(PARAGRAPH)].map((match) => textOf(match[0])).filter((text) => DATE.test(text));
  return {
    name: cellText(found.columns.name),
    episodes: cellText(found.columns.episodes),
    total: cellText(found.columns.total),
    share: cellText(found.columns.share),
    date: dates[dates.length - 1] || '',
  };
}

module.exports = { fillCostReport, checkTemplate, readCostReport };
