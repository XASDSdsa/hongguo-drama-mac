// 代码里不能用没定义过的名字（函数、变量）。
// 1.2.0 里「视频提示词」调用了一个不存在的 getFfmpegPath，草稿照常出来，但分镜工程图每一集都失败；
// 这类错只有跑到那一行才会报，测试不一定走得到，所以这里把所有代码静态扫一遍，打包前就拦下。
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ESLint } = require('eslint');
const globals = require('globals');

const root = path.resolve(__dirname, '..');
const files = execFileSync(
  'git',
  ['ls-files', '*.js', '*.cjs', '*.mjs', '*.jsx', ':!:node_modules', ':!:dist', ':!:dist-electron', ':!:release'],
  { cwd: root },
)
  .toString()
  .split('\n')
  .filter(Boolean);

// 界面代码（React，浏览器里跑，import/export）；其余是主进程和脚本（Node，require）。
const browserModule = ['src/components/**', 'src/*.jsx', 'src/**/*.jsx', '**/*.mjs', 'vite.config.js'];

(async () => {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    allowInlineConfig: false,
    overrideConfig: [
      {
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'commonjs',
          globals: { ...globals.node, ...globals.browser },
        },
        rules: { 'no-undef': 'error' },
      },
      {
        files: browserModule,
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
          globals: { ...globals.browser, ...globals.node },
        },
        rules: { 'no-undef': 'error' },
      },
    ],
  });
  const results = await eslint.lintFiles(files);
  const problems = [];
  for (const result of results)
    for (const message of result.messages)
      problems.push(`${path.relative(root, result.filePath)}:${message.line}:${message.column} ${message.message}`);
  if (problems.length) {
    console.error(`有 ${problems.length} 处用了没定义的名字：\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`PASS no undefined names in ${results.length} files`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
