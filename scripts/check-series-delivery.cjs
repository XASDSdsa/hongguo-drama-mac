'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const layout = require('../src/native/series-layout');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'series-delivery-'));
const write = (file, text, time = 2000) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, time, time);
};
const read = (file) => fs.readFileSync(file, 'utf8');
try {
  const series = path.join(root, '剧集');
  fs.mkdirSync(series);
  assert.deepEqual(layout.syncDeliveryFiles(series), []);
  assert.equal(fs.existsSync(path.join(series, '去重')), false, '不额外创建成品目录');
  const output = path.join(series, '去重');
  fs.mkdirSync(output);
  assert.deepEqual(layout.syncDeliveryFiles(series), [], '没有成品时不伪造资料');
  const sources = [];
  for (let i = 1; i <= 49; i++) {
    const file = path.join(output, `新剧 - 第${i}集.mp4`);
    write(file, 'video-' + i, 1000);
    sources.push(file);
  }
  const shots = [2, 10, 27, 35];
  for (const number of [...shots, 49, 99]) {
    const file = path.join(series, '分镜工程图', `旧剧_第${String(number).padStart(3, '0')}集.jpg`);
    write(file, 'shot-' + number, shots.includes(number) ? 2000 + number : 1500);
    sources.push(file);
  }
  write(path.join(series, '分镜工程图', '网页和提示词', '参考图.png'), 'reference');
  write(path.join(series, '分镜工程图', '网页和提示词', '旧剧_第002集.html'), 'html');
  const poster = path.join(series, layout.NEW_POSTER);
  write(poster, 'poster');
  sources.push(poster);
  layout.updateNewInfo(series, { title: '新剧', synopsis: '第一行\n第二行', processed: 49 });
  write(path.join(series, layout.COST_REPORT_PNG), 'cost report');
  write(path.join(output, '人工说明.txt'), 'keep');
  const originals = new Map(sources.map((file) => [file, { data: fs.readFileSync(file), time: fs.statSync(file).mtimeMs }]));
  write(path.join(output, '新剧 - 第2集.jpg'), 'shot-2', 2002);
  write(path.join(output, '新剧 - 第10集.jpg'), 'manually edited image');
  const copied = layout.syncDeliveryFiles(series);
  assert.equal(fs.existsSync(path.join(output, '新剧 - 第2集.jpg')), false, '上一版复制的同内容图片改为正确名称');
  assert.equal(read(path.join(output, '新剧 - 第10集.jpg')), 'manually edited image', '不改动不同内容的既有图片');
  assert.equal(copied.length, 7, '四张分镜、海报、集数和简介');
  for (const number of shots)
    assert.equal(read(path.join(output, `AI分镜工程图_第${number}集.jpg`)), 'shot-' + number, '图片只带 AI分镜工程图 和集号，不带剧名');
  assert.equal(fs.existsSync(path.join(output, 'AI分镜工程图_第49集.jpg')), false, '最多复制最近生成的四集');
  assert.equal(fs.existsSync(path.join(output, 'AI分镜工程图_第99集.jpg')), false, '没有对应视频的图不复制');
  assert.equal(read(path.join(output, '海报.jpg')), 'poster');
  assert.equal(read(path.join(output, '集数.txt')), '49集\r\n');
  assert.equal(read(path.join(output, '简介.txt')), '第一行\r\n第二行\r\n');
  assert.equal(read(path.join(output, '人工说明.txt')), 'keep');
  for (const [file, before] of originals) {
    assert.deepEqual(fs.readFileSync(file), before.data, '来源内容不动');
    assert.equal(fs.statSync(file).mtimeMs, before.time, '来源修改时间不动');
  }
  assert.equal(fs.readdirSync(output, { withFileTypes: true }).some((entry) => entry.isDirectory()), false, '不复制任何文件夹');
  assert.equal(fs.existsSync(path.join(output, layout.COST_REPORT_PNG)), false, '不额外增加未要求的报告副本');
  const dates = new Map(fs.readdirSync(output).map((file) => [file, fs.statSync(path.join(output, file)).mtimeMs]));
  assert.deepEqual(layout.syncDeliveryFiles(series), [], '重复刷新不反复复制');
  for (const [file, time] of dates) assert.equal(fs.statSync(path.join(output, file)).mtimeMs, time);
  write(poster, 'updated poster', 3000);
  layout.updateNewInfo(series, { synopsis: '已修改的简介' });
  layout.syncDeliveryFiles(series);
  assert.equal(read(path.join(output, '海报.jpg')), 'updated poster');
  assert.equal(read(path.join(output, '简介.txt')), '已修改的简介\r\n');
  assert.equal(read(poster), 'updated poster');

  const legacy = path.join(root, '旧结构');
  write(path.join(legacy, '去重', '旧剧_第0007集.mp4'), 'video', 1000);
  write(path.join(legacy, '视频提示词', '旧剧_第0007集.jpg'), 'legacy shot');
  layout.updateOriginalInfo(legacy, { synopsis: '原简介' });
  layout.syncDeliveryFiles(legacy);
  assert.equal(read(path.join(legacy, '去重', 'AI分镜工程图_第0007集.jpg')), 'legacy shot', '完整保留视频原有的补零');
  assert.equal(read(path.join(legacy, '去重', '简介.txt')), '原简介\r\n');
  const stale = path.join(root, '新做成的视频');
  write(path.join(stale, '去重', '新剧 - 第1集.mp4'), 'new video', 3000);
  write(path.join(stale, '分镜工程图', '新剧 - 第1集.jpg'), 'old shot', 1000);
  layout.syncDeliveryFiles(stale);
  assert.equal(fs.existsSync(path.join(stale, '去重', 'AI分镜工程图_第1集.jpg')), false, '重新去重后不误用旧视频的分镜图');
  console.log('PASS delivery: four matching images, poster and text alongside videos; originals untouched; refresh, legacy and stale-image checks');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
