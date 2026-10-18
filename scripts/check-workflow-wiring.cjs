'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('main.js');
const preload = read('preload.js');
const settings = read('src/components/Settings.jsx');
const packageJson = JSON.parse(read('package.json'));
const { ALGORITHM, POLICY } = require('../src/native/video-structure/alignment');
const audioPauseAlgorithm = 'whisper-audio-pause-v5';
const audioPausePolicy = 'paraformer-ct-global-whisper-audio-pause-v5';

const checks = [
  ['主进程读取工作流门禁配置', main.includes('workflowGates') && main.includes('workflow_require_dedup')],
  [
    '两个入口共用结构化与剪映流水线',
    /createDraft:\s*\(?ctx\)?\s*=>/.test(main) &&
      main.includes('createJianyingDraft(ctx') &&
      main.includes('structure.modules.jianying.summary'),
  ],
  ['主进程会校验剪映草稿', main.includes('check-jianying-draft.py') && main.includes('workflowDraftExists')],
  [
    '工作流要求气口落在切镜上才切断',
    main.includes(`manifest.boundary_policy === '${POLICY}'`) &&
      main.includes(`manifest.alignment_algorithm === '${ALGORITHM}'`),
  ],
  [
    '音频停顿算法贯穿 CLI、构建和发布校验',
    [
      'src/native/sentence_alignment.py',
      'src/native/faster_whisper_cli.py',
      'scripts/build-faster-whisper.py',
      'scripts/check-faster-whisper-bundle.cjs',
    ].every((file) => read(file).includes(audioPauseAlgorithm)),
  ],
  [
    '运行时参数带有音频停顿算法标识（缓存指纹据此失效）',
    read('src/native/video-structure/runtime.js').includes(audioPausePolicy),
  ],
  ['工作流状态持久化到短剧档案', main.includes('entry.workflow') && main.includes('saveSeriesRegistry')],
  ['渲染进程暴露工作流接口', preload.includes('startSeriesWorkflow') && preload.includes('onEpisodeWorkflowProgress')],
  [
    '设置页只放真正有用的项（没有已无入口的字幕识别、工作流门禁、去重/AI 输出目录）',
    !/faster_whisper_device|workflow_require_dedup|dedup_output_dir|ai_output_dir/.test(settings),
  ],
  [
    '打包包含剪映脚本',
    packageJson.build.extraResources.some((item) => item.to === 'workflow/create-jianying-draft.py'),
  ],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
if (failed.length) process.exitCode = 1;
