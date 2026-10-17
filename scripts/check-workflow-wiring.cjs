'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('main.js');
const preload = read('preload.js');
const ui = read('src/components/DownloadManager.jsx');
const settings = read('src/components/Settings.jsx');
const packageJson = JSON.parse(read('package.json'));
const { ALGORITHM, POLICY } = require('../src/native/video-structure/alignment');
const reconstruction = read('src/components/Reconstruction.jsx');
const audioPauseAlgorithm = 'whisper-audio-pause-v4';
const audioPausePolicy = 'paraformer-ct-global-whisper-audio-pause-v4';

const checks = [
  ['主进程读取工作流门禁配置', main.includes('workflowGates') && main.includes('workflow_require_dedup')],
  ['两个入口共用结构化与剪映流水线', main.includes('createDraft: ctx =>') && main.includes('createJianyingDraft(ctx') && main.includes('structure.modules.jianying.summary')],
  ['主进程会校验剪映草稿', main.includes("check-jianying-draft.py") && main.includes('workflowDraftExists')],
  ['工作流要求保留视觉切点的新草稿规则', main.includes(`manifest.boundary_policy === '${POLICY}'`) && main.includes(`manifest.alignment_algorithm === '${ALGORITHM}'`)],
  ['页面显示音频停顿分段与人声字幕同步且保留视觉切点', reconstruction.includes('连续说话可跨镜头') && reconstruction.includes('音频真实停顿分段') && reconstruction.includes('不因识别标点切断人声') && !reconstruction.includes('逗号等标点分段') && reconstruction.includes('人声字幕同步') && reconstruction.includes('不为了台词合并视频') && !reconstruction.includes('不拆句') && !reconstruction.includes('合并句中切点')],
  ['音频停顿算法贯穿 CLI、构建和发布校验', ['src/native/sentence_alignment.py', 'src/native/faster_whisper_cli.py', 'scripts/build-faster-whisper.py', 'scripts/check-faster-whisper-bundle.cjs'].every(file => read(file).includes(audioPauseAlgorithm))],
  ['运行时与流水线使用相同音频停顿缓存策略', ['src/native/video-structure/runtime.js', 'src/native/video-structure/pipeline.js'].every(file => read(file).includes(audioPausePolicy))],
  ['工作流状态持久化到短剧档案', main.includes('entry.workflow') && main.includes('saveSeriesRegistry')],
  ['渲染进程暴露工作流接口', preload.includes('startSeriesWorkflow') && preload.includes('onEpisodeWorkflowProgress')],
  ['下载管理有一键工作流入口', ui.includes('一键处理本剧') && ui.includes('startSeriesWorkflow')],
  ['设置页可调整工作流门禁', settings.includes('workflow_require_dedup') && settings.includes('workflow_validate_draft')],
  ['打包包含剪映脚本', packageJson.build.extraResources.some(item => item.to === 'workflow/create-jianying-draft.py')],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
if (failed.length) process.exitCode = 1;
