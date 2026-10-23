'use strict';
// 成本配置报告：总投资额按 Seedance 2.5 官方价格算（和官方价格页的示例对得上）；按模板填 Word 只改表格那一行和日期，
// 其余（公章、签名图片、其他文字）一个字节不动；模板只存在用户电脑上，不进仓库；界面和主进程接好了。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pricing = require('../src/native/cost-report/pricing');
const { readZip, writeZip } = require('../src/native/cost-report/zip');
const { fillCostReport, checkTemplate, readCostReport } = require('../src/native/cost-report/docx');

const root = path.join(__dirname, '..');

// ---- 价格：官方示例（doubao-seedance-2.5，输入不含视频，5 秒 16:9）480p 3.36、720p 7.56、1080p 18.71 元 ----
{
  const five = (width, height) => pricing.episodeCost({ seconds: 5, width, height });
  assert.equal(five(854, 480).yuan.toFixed(2), '3.36');
  assert.equal(five(1280, 720).yuan.toFixed(2), '7.56');
  assert.equal(five(1920, 1080).yuan.toFixed(2), '18.71');
  assert.equal(five(1280, 720).tokens, 108000, 'token = 时长 × 宽 × 高 × 24 / 1024');
  // 竖屏短剧：720×1280 按 720p、1080×1920 按 1080p，像素数和横屏一样
  assert.equal(pricing.tierFor(720, 1280).name, '720p');
  assert.equal(pricing.tierFor(1080, 1920).name, '1080p');
  assert.equal(pricing.tierFor(540, 960).name, '480p');
  assert.equal(pricing.tierFor(1088, 1920).name, '1080p');
  assert.equal(pricing.PRICE.model, 'doubao-seedance-2.5');
  assert.deepEqual(
    pricing.PRICE.tiers.map((tier) => [tier.name, tier.yuanPerMillion]),
    [
      ['1080p', 77],
      ['720p', 70],
      ['480p', 70],
    ],
  );
}

// ---- 整部剧：每集按自己的清晰度算，加起来；演员片酬算进总投资 ----
{
  const list = [
    { seconds: 100, width: 1080, height: 1920 },
    { seconds: 100, width: 1080, height: 1920 },
    { seconds: 60, width: 720, height: 1280 },
  ];
  const cost = pricing.seriesCost(list);
  const expected = ((200 * 1920 * 1080 * 24) / 1024 / 1e6) * 77 + ((60 * 1280 * 720 * 24) / 1024 / 1e6) * 70;
  assert.ok(Math.abs(cost.generation - expected) < 1e-6);
  assert.equal(cost.episodes, 3);
  assert.equal(cost.seconds, 260);
  assert.equal(cost.actorFee, 0);
  assert.equal(cost.actorShare, 0, '没传占比：0');
  assert.equal(cost.total, cost.generation);
  assert.deepEqual(
    cost.tiers.map((row) => [row.name, row.episodes, row.width, row.height]),
    [
      ['1080p', 2, 1920, 1080],
      ['720p', 1, 1280, 720],
    ],
  );
  // 演员片酬按占总投资的比例算（默认 15%）：总投资 = AI 生成费用 ÷ (1 − 15%)，片酬 = 总投资 × 15%
  const withActors = pricing.seriesCost(list, { actorPercent: 15 });
  assert.ok(Math.abs(withActors.total - expected / 0.85) < 1e-6);
  assert.ok(Math.abs(withActors.actorFee - (expected / 0.85) * 0.15) < 1e-6);
  assert.ok(Math.abs(withActors.actorFee / withActors.total - 0.15) < 1e-12, '片酬正好占总投资 15%');
  assert.equal(withActors.actorShare, 0.15);
  assert.equal(pricing.formatShare(withActors.actorShare), '15%');
  assert.equal(pricing.DEFAULT_ACTOR_PERCENT, 15);
  assert.equal(pricing.normalizeActorPercent(undefined), 15, '没填按 15%');
  assert.equal(pricing.normalizeActorPercent(''), 15);
  assert.equal(pricing.normalizeActorPercent('abc'), 15);
  assert.equal(pricing.normalizeActorPercent(0), 0, '填 0 就是 0');
  assert.equal(pricing.normalizeActorPercent(-5), 0, '负数当 0');
  assert.equal(pricing.normalizeActorPercent(120), 95, '最多 95%');
  assert.equal(pricing.normalizeActorPercent('12.34'), 12.3);
  assert.deepEqual(cost.draws.counts, { 1: 3 }, '没传抽卡：每集一次');

  // 抽卡：每集随机 1～3 次，费用乘次数；同一个种子结果一样（按文件名定，和顺序无关），换种子才变
  const sixty = Array.from({ length: 60 }, (_, i) => ({
    name: `第${i + 1}集.mp4`,
    seconds: 98,
    width: 1080,
    height: 1920,
  }));
  const once = pricing.episodeCost(sixty[0]).yuan;
  const drawn = pricing.seriesCost(sixty, { draws: { min: 1, max: 3, seed: 'abc' } });
  const times = sixty.map((item) => pricing.drawCount('abc', item.name, 1, 3));
  assert.ok(times.every((n) => n >= 1 && n <= 3));
  assert.ok(new Set(times).size === 3, '1、2、3 次都有');
  assert.ok(
    Math.abs(drawn.generation - once * times.reduce((a, b) => a + b, 0)) < 1e-6,
    '费用 = 每集一次的价 × 抽卡次数',
  );
  assert.equal(
    drawn.draws.total,
    times.reduce((a, b) => a + b, 0),
  );
  assert.equal(
    Object.values(drawn.draws.counts).reduce((a, b) => a + b, 0),
    60,
  );
  assert.equal(drawn.tiers[0].generations, drawn.draws.total);
  assert.equal(drawn.tokens, Math.round(pricing.episodeCost(sixty[0]).tokens * drawn.draws.total));
  assert.equal(
    pricing.seriesCost([...sixty].reverse(), { draws: { min: 1, max: 3, seed: 'abc' } }).generation.toFixed(6),
    drawn.generation.toFixed(6),
    '顺序不影响',
  );
  assert.notDeepEqual(
    pricing.seriesCost(sixty, { draws: { min: 1, max: 3, seed: 'xyz' } }).draws.counts,
    drawn.draws.counts,
    '换种子重新随机',
  );
  assert.ok(
    Math.abs(pricing.seriesCost(sixty, { draws: { min: 2, max: 2, seed: 'abc' } }).generation - once * 120) < 1e-6,
    '固定 2 次',
  );
  assert.deepEqual(pricing.normalizeDraws({ min: 5, max: 2 }), { min: 5, max: 5, seed: '' }, '最多不小于最少');
  assert.deepEqual(pricing.normalizeDraws({ min: 0, max: 99 }), { min: 1, max: 10, seed: '' }, '1～10 次');
  assert.deepEqual(pricing.DEFAULT_DRAWS, { min: 1, max: 3 });
  // 写法
  assert.equal(pricing.formatEpisodes(60, 5874.4), '60集，共97分54秒');
  assert.equal(pricing.formatEpisodes(1, 42), '1集，共42秒');
  assert.equal(pricing.formatWan(21981.68), '2.20万元');
  assert.equal(pricing.formatWan(8165), '0.82万元');
  assert.equal(pricing.formatWan(50000), '5.00万元');
  assert.equal(pricing.formatShare(0), '0%');
  assert.equal(pricing.formatShare(0.153), '15.3%');
  assert.equal(pricing.formatYuan(21981.682), '21,981.68 元');
  console.log(
    'PASS cost: Seedance 2.5 official prices (matches the official 5 s examples), per-episode resolution, random draws, actor share (default 15%)',
  );
}

// ---- Word：照着真实模板的结构造一份（表头 5 列、空格子、「5」「万元」分两段、15 后面有书签、日期一段、两张图片） ----
const font =
  '<w:rPr><w:rFonts w:hint="eastAsia" w:ascii="仿宋_GB2312" w:hAnsi="仿宋_GB2312" w:eastAsia="仿宋_GB2312" w:cs="仿宋_GB2312"/><w:color w:val="000000"/><w:sz w:val="28"/><w:szCs w:val="21"/></w:rPr>';
const pPr = `<w:pPr><w:spacing w:line="579" w:lineRule="exact"/><w:jc w:val="center"/>${font}</w:pPr>`;
const cell = (runs) =>
  `<w:tc><w:tcPr><w:tcW w:w="900" w:type="dxa"/></w:tcPr><w:p w14:paraId="1">${pPr}${runs}</w:p></w:tc>`;
const run = (text) => `<w:r>${font}<w:t>${text}</w:t></w:r>`;
const header = ['序号', '微短剧名称', '集数和总时长', '总投资额（需＜100万）', '演员总片酬占比（需＜40%）'];
const documentXml = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>',
  `<w:p>${run('成本配置比例情况报告')}</w:p>`,
  `<w:p>${run('我公司提审的1部“其他微短剧”，详情见下：')}</w:p>`,
  '<w:tbl><w:tblPr/>',
  `<w:tr>${header.map((title) => cell(run(title))).join('')}</w:tr>`,
  `<w:tr>${cell(run('1'))}${cell('')}${cell('')}${cell(run('5') + run('万元'))}${cell(run('15') + '<w:bookmarkStart w:id="0" w:name="_GoBack"/><w:bookmarkEnd w:id="0"/>' + run('%'))}</w:tr>`,
  '</w:tbl>',
  `<w:p>${run('以上微短剧制作完成的总投资额和演员总片酬占比均符合要求。')}</w:p>`,
  `<w:p>${run('报审机构：（盖章）')}<w:r><w:drawing>seal rId5</w:drawing></w:r></w:p>`,
  `<w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run('2026年10')}${run('月3号')}</w:p>`,
  '</w:body></w:document>',
].join('');
const seal = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));
const signature = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 11 + 3) % 256));
const template = writeZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  { name: 'word/media/image1.png', data: signature },
  { name: 'word/media/image2.png', data: seal },
]);

{
  assert.deepEqual(checkTemplate(template), [], '照真实结构造的模板能用');
  assert.deepEqual(readCostReport(template), {
    name: '',
    episodes: '',
    total: '5万元',
    share: '15%',
    date: '2026年10月3号',
  });
  const filled = fillCostReport(template, {
    name: '金蛋蛋逆袭记 & <新>',
    episodes: '60集，共97分54秒',
    total: '2.20万元',
    share: '0%',
    date: new Date(2026, 9, 22),
  });
  const read = readCostReport(filled);
  assert.deepEqual(read, {
    name: '金蛋蛋逆袭记 & <新>',
    episodes: '60集，共97分54秒',
    total: '2.20万元',
    share: '0%',
    date: '2026年10月22号',
  });
  const before = readZip(template);
  const after = readZip(filled);
  assert.deepEqual(
    after.map((entry) => entry.name),
    before.map((entry) => entry.name),
    '文件顺序不变（[Content_Types].xml 第一个）',
  );
  for (const name of ['[Content_Types].xml', 'word/media/image1.png', 'word/media/image2.png'])
    assert.ok(
      after.find((entry) => entry.name === name).data.equals(before.find((entry) => entry.name === name).data),
      `${name} 一个字节不动`,
    );
  const xml = after.find((entry) => entry.name === 'word/document.xml').data.toString('utf8');
  assert.ok(xml.includes('金蛋蛋逆袭记 &amp; &lt;新&gt;'), '特殊字符转义');
  // 表格外的文字、表头、序号、公章段落原样
  for (const piece of [
    '我公司提审的1部“其他微短剧”',
    '报审机构：（盖章）',
    '<w:drawing>seal rId5</w:drawing>',
    ...header,
    '<w:t>1</w:t>',
  ])
    assert.ok(xml.includes(piece), `原样保留：${piece}`);
  // 原来空的格子用同一行的字体（仿宋_GB2312、四号），段落格式（居中、行距）保留
  const nameCell = xml.match(/<w:tc>(?:(?!<\/w:tc>)[\s\S])*金蛋蛋(?:(?!<\/w:tc>)[\s\S])*<\/w:tc>/)[0];
  assert.match(nameCell, /<w:r><w:rPr><w:rFonts[^>]*仿宋_GB2312[\s\S]*<w:sz w:val="28"\/>/);
  assert.match(nameCell, /<w:jc w:val="center"\/>/);
  assert.equal((xml.match(/<w:tbl>/g) || []).length, 1);
  assert.ok(!xml.includes('_GoBack'), '片酬格子换成一段字（书签一起去掉）');
  // 打出来的 zip 别的工具也认得
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cost-report-'));
  try {
    fs.writeFileSync(path.join(dir, 'out.docx'), filled);
    let unzip = '';
    try {
      unzip = execFileSync('unzip', ['-t', path.join(dir, 'out.docx')], { encoding: 'utf8' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (unzip) assert.match(unzip, /No errors detected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 填不了的模板说清楚
  const blank = writeZip([
    {
      name: 'word/document.xml',
      data: Buffer.from('<w:document><w:body><w:p><w:r><w:t>随便</w:t></w:r></w:p></w:body></w:document>'),
    },
  ]);
  const problems = checkTemplate(blank);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /没找到表格/);
  assert.match(problems[1], /没找到落款日期/);
  assert.deepEqual(checkTemplate(Buffer.from('not a zip')), ['不是 Word 文件（docx）：读不到文件目录']);
  console.log(
    'PASS cost report docx: only the table row and the date change; seal, signature and other text untouched',
  );
}

// ---- 模板只在用户电脑上：不进仓库 ----
{
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
  assert.deepEqual(
    tracked.filter((file) => /\.docx$/i.test(file)),
    [],
    '仓库里不放任何 docx（模板有公章和签名）',
  );
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(
    main,
    /path\.join\(app\.getPath\('userData'\), 'cost-report-template\.docx'\)/,
    '模板存在本机用户数据目录',
  );
  assert.match(main, /costDocx\.checkTemplate\(buffer\)/, '选模板时先核对能不能填');
  assert.match(main, /ipcMain\.handle\('library-cost-report'/);
  // 报告只在「开始处理」里生成：没有单独的「生成 / 打开报告」接口
  assert.doesNotMatch(main, /ipcMain\.handle\('library-cost-report-make'/);
  // 查看报告：只看文件在不在、用系统默认程序打开
  assert.match(main, /ipcMain\.handle\('library-cost-report-file'/);
  assert.match(main, /ipcMain\.handle\('library-cost-report-open'[\s\S]{0,400}shell\.openPath\(file\)/);
  assert.match(main, /ipcMain\.handle\('cost-report-template-pick'/);
  assert.match(main, /libraryDedupOutputs\(dir\)/, '按「去重」里的成品算');
  assert.match(main, /报告正在 Word 里打开着/);
  const layout = require('../src/native/series-layout');
  assert.equal(layout.COST_REPORT, '成本配置比例情况报告.docx');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  for (const name of ['libraryCostReport:', 'libraryCostReportFile:', 'libraryCostReportOpen:', 'costReportTemplatePick:'])
    assert.ok(preload.includes(name), name);
  assert.ok(!/libraryCostReportMake:/.test(preload));
  const detail = fs.readFileSync(path.join(root, 'src/components/SeriesDetail.jsx'), 'utf8');
  // 页面上只有「☑ 成本配置报告」和旁边的「报告设置」，在分镜工程图下面；其余都在弹窗里
  const storyboard = detail.indexOf('<StoryboardResults');
  const item = detail.indexOf('<b>成本配置报告</b>');
  assert.ok(storyboard > 0 && item > storyboard, '成本配置报告在分镜工程图下面');
  const pageItem = detail.slice(item - 600, detail.indexOf('{costOpen && (', item));
  assert.match(pageItem, /<input\s+type="checkbox"\s+checked=\{costOn\}/, '一个勾选框');
  assert.match(pageItem, /onClick=\{\(\) => setCostOpen\(true\)\}>\s*报告设置/, '旁边点「报告设置」弹窗');
  assert.match(pageItem, /onClick=\{openCostReport\}\s*disabled=\{!costFile\?\.exists\}[\s\S]*查看报告/, '旁边一个「查看报告」，生成过才能点');
  assert.match(detail, /libraryCostReportFile\?\.\(\{ dir: detail\.dir \}\)/, '打开这部剧、日志有新内容时看报告在不在');
  assert.match(detail, /const costRefresh = `\$\{detail\?\.dir \|\| ''\}\|\$\{activity\?\.logs\?\.length \|\| 0\}/);
  assert.doesNotMatch(pageItem, /cost-grid|proc-summary|生成报告|抽卡/, '页面上不放别的');
  assert.match(detail, /const \[costOn, setCostOn\] = useState\(saved\.costOn === true\)/, '勾选记住');
  assert.match(
    detail,
    /costReport: \{ enabled: costOn, \.\.\.costRequest\(readCostSettings\(detail\.dir\)\) \}/,
    '开始处理带上报告设置',
  );
  assert.match(detail, /const nothingToDo = dedupOn \? !selectedCount : !draftOn && !costOn;/, '只勾报告也能开始');
  // 「报告设置」弹窗只管设置（剧名、抽卡、片酬占比、模板），下面估个数；不在这里生成报告；「确定」才记住
  const dialog = detail.slice(detail.indexOf('function CostReportDialog'), detail.indexOf('/** 剧的子页面：'));
  assert.match(dialog, /className="lib-confirm cost-dialog"[\s\S]*aria-label="成本配置报告设置"/);
  assert.match(dialog, /aria-label="每集最少抽几次"[\s\S]*aria-label="每集最多抽几次"/);
  assert.match(dialog, /aria-label="演员片酬占总投资的百分比"/);
  assert.match(dialog, /libraryCostReport\?\.\(\{ dir, \.\.\.request \}\)/, '边改边算');
  assert.doesNotMatch(dialog, /libraryCostReportMake|libraryCostReportOpen|生成报告|打开报告/, '设置里不生成报告');
  assert.match(dialog, /恢复默认/);
  assert.match(dialog, /saveCostSettings\(dir, settings\);\s*onClose\(\);/, '确定才记住');
  assert.match(dialog, /useDialogKeyboard\(true, onClose, '\.cost-dialog'\)/, 'Esc 关闭');
  assert.match(dialog, /抽一次收一次全价/);
  assert.match(detail, /drawMin: String\(stored\.drawMin \?\? 1\)/, '默认最少 1 次');
  assert.match(detail, /drawMax: String\(stored\.drawMax \?\? 3\)/, '默认最多 3 次');
  assert.match(detail, /actorPercent: String\(stored\.actorPercent \?\? DEFAULT_ACTOR_PERCENT\)/, '片酬占比默认 15%');
  assert.match(detail, /const DEFAULT_ACTOR_PERCENT = 15;/);
  assert.match(detail, /drawSeed: stored\.drawSeed \|\| newSeed\(\)/);
  assert.match(detail, /if \(!stored\.drawSeed\) writeJson\(COST_KEY/, '第一次用就把随机种子记住');
  assert.doesNotMatch(detail, /演员片酬（元）|actorFee: fee/, '不再按元填片酬');
  // 主进程：勾了就在处理做完时自动生成（停止了不生成），写进日志
  assert.match(main, /costSummary\(dir, payload\.actorPercent, payload\.draws\)/);
  assert.match(main, /costPricing\.normalizeActorPercent\(value\.actorPercent\)/);
  assert.match(main, /name: path\.basename\(files\[index\]\)/, '抽卡次数按文件名定');
  assert.match(
    main,
    /if \(cost\?\.enabled\) tasks\.costReport = \{ enabled: true, \.\.\.normalizeCostRequest\(cost\) \};/,
  );
  assert.match(
    main,
    /if \(costTask\?\.enabled && batch\.libraryDir && !batch\.cancelled\) runCostReportTask\(batch\.libraryDir, costTask\);/,
  );
  assert.match(main, /if \(side\?\.costReport\) await runCostReportTask\(dir, side\.costReport\);/);
  assert.match(main, /成本配置报告：已生成/);
  console.log('PASS cost report wiring: template stays on this computer, IPC + UI under the storyboard section');
}
