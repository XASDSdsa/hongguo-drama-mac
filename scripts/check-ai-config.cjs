'use strict';
// 文案改写、作图能选好几家服务：预设齐全、旧设置能认出来、实际用的地址 / Key / 模型对；设置页能选、能测。
// 剧集管理的剧卡片显示最后处理时间（成品、分镜工程图、新海报、成本报告里最新的）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { providers, copyProviderFor, copyWritingConfig, usesOpenAiImages } = require('../src/native/ai-config');
const layout = require('../src/native/series-layout');

const root = path.join(__dirname, '..');

async function main() {
  // ---- 预设 ----
  const ids = providers.text.map((item) => item.id);
  assert.deepEqual(ids, ['deepseek', 'doubao', 'qwen', 'kimi', 'glm', 'shared', 'custom']);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of providers.text.filter((entry) => entry.baseUrl)) {
    assert.match(item.baseUrl, /^https:\/\/[^/]+/, item.id);
    assert.ok(item.model, `${item.id} 有默认模型`);
    assert.ok(item.hint, `${item.id} 有说明`);
  }
  assert.equal(providers.text.find((item) => item.id === 'doubao').useArkKey, true);
  assert.deepEqual(
    providers.image.map((item) => item.id),
    ['seedream', 'openai'],
  );
  assert.deepEqual(
    providers.image[0].models.map((item) => item.id),
    ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'],
  );

  // ---- 旧设置：按填过的地址认出是哪家 ----
  assert.equal(copyProviderFor(''), 'deepseek');
  assert.equal(copyProviderFor('https://api.deepseek.com/'), 'deepseek');
  assert.equal(copyProviderFor('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'qwen');
  assert.equal(copyProviderFor('https://my-relay.example.com/v1'), 'custom');

  // ---- 实际用的地址 / Key / 模型 ----
  const base = { ai_base_url: 'https://api.openai.com/v1', ai_api_key: 'main-key', ai_text_model: 'gpt-6.1-sol', ark_api_key: 'ark-key' };
  const deepseek = copyWritingConfig({ ...base, ai_copy_provider: 'deepseek', ai_copy_api_key: 'ds-key', ai_copy_base_url: '', ai_copy_model: '' });
  assert.equal(deepseek.ai_base_url, 'https://api.deepseek.com');
  assert.equal(deepseek.ai_api_key, 'ds-key');
  assert.equal(deepseek.ai_text_model, 'deepseek-flash', '没填模型用预设');
  const qwen = copyWritingConfig({ ...base, ai_copy_provider: 'qwen', ai_copy_api_key: 'qw', ai_copy_model: 'qwen-max' });
  assert.equal(qwen.ai_base_url, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(qwen.ai_text_model, 'qwen-max', '填了模型用填的');
  const doubao = copyWritingConfig({ ...base, ai_copy_provider: 'doubao', ai_copy_api_key: '' });
  assert.equal(doubao.ai_api_key, 'ark-key', '豆包没填 Key 用方舟 Key');
  assert.equal(doubao.ai_base_url, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(copyWritingConfig({ ...base, ai_copy_provider: 'shared', ai_copy_api_key: 'x' }), null, '选「和上面共用」');
  assert.equal(copyWritingConfig({ ...base, ai_copy_provider: 'kimi', ai_copy_api_key: '' }), null, '没 Key 就用上面的文本模型');
  const custom = copyWritingConfig({ ...base, ai_copy_provider: 'custom', ai_copy_api_key: 'c', ai_copy_base_url: 'https://r.example.com/v1', ai_copy_model: 'm' });
  assert.deepEqual([custom.ai_base_url, custom.ai_api_key, custom.ai_text_model], ['https://r.example.com/v1', 'c', 'm']);
  // 旧设置没有 provider：照旧按地址走（DeepSeek）
  const legacy = copyWritingConfig({ ...base, ai_copy_api_key: 'old', ai_copy_base_url: 'https://api.deepseek.com', ai_copy_model: 'deepseek-flash' });
  assert.equal(legacy.ai_api_key, 'old');
  assert.equal(usesOpenAiImages({ image_provider: 'openai' }), true);
  assert.equal(usesOpenAiImages({ image_provider: 'seedream' }), false);
  assert.equal(usesOpenAiImages({}), false, '默认 Seedream');
  console.log('PASS AI providers: presets for DeepSeek / 豆包 / 通义千问 / Kimi / 智谱 / shared / custom, legacy settings recognized, keys and models resolved');

  // ---- main.js 和设置页 ----
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /ai_copy_provider: 'deepseek'/);
  assert.match(main, /if \(!saved\.ai_copy_provider\) merged\.ai_copy_provider = aiConfig\.copyProviderFor\(merged\.ai_copy_base_url\);/);
  assert.match(main, /return aiConfig\.copyWritingConfig\(settings\);/);
  assert.match(main, /ipcMain\.handle\('test-ai-copy'/);
  assert.match(main, /ipcMain\.handle\('test-ai-image'/);
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.ok(preload.includes('testAiCopy:') && preload.includes('testAiImage:'));
  const settings = fs.readFileSync(path.join(root, 'src/components/Settings.jsx'), 'utf8');
  assert.match(settings, /import AI_PROVIDERS from '\.\.\/native\/ai-providers\.json';/, '设置页和主进程用同一份预设');
  assert.match(settings, /aria-label="文案改写用哪家"/);
  assert.match(settings, /aria-label="作图用哪家"/);
  for (const key of ['ai_copy_provider', 'ai_copy_base_url', 'ai_copy_api_key', 'ai_copy_model', 'image_provider'])
    assert.ok(settings.includes(`'${key}'`), `保存 ${key}`);
  assert.match(settings, /window\.electronAPI\.testAiCopy\(/);
  assert.match(settings, /window\.electronAPI\.testAiImage\(/);
  assert.match(settings, /ai_copy_base_url: preset\.baseUrl, ai_copy_model: preset\.model/, '换一家就填这家的地址和模型');
  // 设置页分三页；AI 页只露「选哪家 + Key」，模型和地址折叠；方舟 Key 只填一次
  assert.match(settings, /const SETTINGS_TABS = \[\s*\['basic', '下载与保存'\],\s*\['process', '去重与剪映'\],\s*\['ai', 'AI'\],?\s*\];/);
  for (const [label, tab] of [['保存位置', 'basic'], ['下载与网络', 'basic'], ['去重与剪映草稿', 'process'], ['火山方舟', 'ai'], ['文案', 'ai'], ['作图', 'ai'], ['看图检查', 'ai']])
    assert.match(settings, new RegExp(`aria-label="${label}" hidden=\\{tab !== '${tab}'\\}`), `${label} 在「${tab}」页`);
  assert.equal((settings.match(/aria-label="方舟 API Key"/g) || []).length, 1, '方舟 Key 只有一个框');
  assert.match(settings, /<summary>\s*改模型或接口地址/);
  // 看图检查没单独配就用文案那家
  assert.match(main, /visionConfig: String\(settings\.ai_api_key \|\| ''\)\.trim\(\) \? settings : copyWritingConfig\(settings\) \|\| settings,/);
  const publish = fs.readFileSync(path.join(root, 'src/native/publish-materials.js'), 'utf8');
  assert.match(publish, /visionConfig \|\| config,/);

  // ---- 最后处理时间 ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processed-'));
  try {
    assert.equal(layout.lastProcessedAt(dir), 0, '什么都没做过');
    fs.mkdirSync(path.join(dir, '原剧'));
    fs.writeFileSync(path.join(dir, '原剧', '1.mp4'), 'x');
    assert.equal(layout.lastProcessedAt(dir), 0, '只下载了不算处理');
    const at = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));
    fs.mkdirSync(path.join(dir, '去重'));
    fs.writeFileSync(path.join(dir, '去重', '剧 - 第1集.mp4'), 'x');
    at(path.join(dir, '去重', '剧 - 第1集.mp4'), 1_700_000_000_000);
    assert.equal(layout.lastProcessedAt(dir), 1_700_000_000_000);
    fs.writeFileSync(path.join(dir, layout.COST_REPORT), 'x');
    at(path.join(dir, layout.COST_REPORT), 1_700_000_500_000);
    fs.writeFileSync(path.join(dir, layout.NEW_POSTER), 'x');
    at(path.join(dir, layout.NEW_POSTER), 1_700_000_300_000);
    fs.mkdirSync(path.join(dir, layout.STORYBOARD_DIR, layout.STORYBOARD_PAGES), { recursive: true });
    fs.writeFileSync(path.join(dir, layout.STORYBOARD_DIR, '剧 - 第1集.png'), 'x');
    at(path.join(dir, layout.STORYBOARD_DIR, '剧 - 第1集.png'), 1_700_000_400_000);
    assert.equal(layout.lastProcessedAt(dir), 1_700_000_500_000, '取最新的');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { processedText } = await import('../src/components/processed-time.mjs');
  const now = new Date(2026, 9, 23, 19, 0);
  assert.equal(processedText(new Date(2026, 9, 23, 18, 56).getTime(), now), '今天 18:56');
  assert.equal(processedText(new Date(2026, 9, 22, 9, 5).getTime(), now), '昨天 09:05');
  assert.equal(processedText(new Date(2026, 9, 21, 14, 3).getTime(), now), '10-21 14:03');
  assert.equal(processedText(new Date(2025, 11, 1, 8, 0).getTime(), now), '2025-12-01');
  assert.equal(processedText(0, now), '');
  assert.match(main, /processedAt: Math\.max\(seriesLayout\.lastProcessedAt\(folder\.path\), Number\(libraryDedupRecord\(folder\.path\)\?\.at\) \|\| 0\)/);
  const library = fs.readFileSync(path.join(root, 'src/components/SeriesLibrary.jsx'), 'utf8');
  assert.match(library, /folder\.processedAt \? `最后处理 \$\{processedText\(folder\.processedAt\)\}` : '还没处理'/);
  console.log('PASS series cards show the last processing time (outputs, storyboard, new poster, cost report)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
