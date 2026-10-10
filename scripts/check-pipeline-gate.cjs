const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

const checks = [
  ['pipeline status persists episode/group markers', /pipelineForEntry[\s\S]*pipeline\.episodes[\s\S]*pipeline\.groups/],
  ['download completion marks downloaded stage', /markPipelineDownloaded\(task, finalPath\)/],
  ['dedup completion marks deduped stage', /markPipelineDeduped\(task\.src, task\.dst\)/],
  ['merge start records segmented stage', /markPipelineSegmented\(task\)/],
  ['merge completion records ready stage', /markPipelineReady\(task\)/],
  ['merge rejects non-dedup inputs', /尚未完成去重，请先完成视频去重处理/],
  ['AI episode enqueue requires ready product', /aiReadyEpisodeProduct\(seriesId, episodeIndex\)/],
  ['AI cover enqueue requires ready product', /aiReadyProductForSeries\(sid\)/],
  ['AI execution revalidates product fingerprint', /最终成品已移动、删除或发生变化/],
  ['AI batches accept one task per productId', /requestedProducts[\s\S]*enqueueCopyTask\(sid, ready\.episodeIndex[\s\S]*productId/],
  ['pipeline status IPC is exposed', /ipcMain\.handle\('get-series-pipeline-status'/],
  ['pipeline status IPC is available to renderer', /getSeriesPipelineStatus:.*get-series-pipeline-status/],
];

let failed = 0;
for (const [label, pattern] of checks) {
  const source = label.includes('renderer') ? preload : main;
  const ok = pattern.test(source);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
if (failed) process.exitCode = 1;
