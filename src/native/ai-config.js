'use strict';
// 文案改写和作图用哪家服务：按设置算出实际要用的地址、Key、模型（main.js 和设置页测试都用这里）。
const providers = require('./ai-providers.json');

const trim = (value) => String(value || '').trim();

/** 没选过「用哪家」的旧设置：按填过的地址认出来；认不出就是「其他」，什么都没填当 DeepSeek。 */
function copyProviderFor(baseUrl) {
  const url = trim(baseUrl).replace(/\/+$/, '');
  if (!url) return 'deepseek';
  return providers.text.find((item) => item.baseUrl && item.baseUrl === url)?.id || 'custom';
}

/**
 * 文案改写（剧名、简介、海报画面描述）用的模型：选了哪家就用哪家的地址、Key、模型（没填用预设值）；
 * 豆包没填 Key 就用方舟 Key。选「和上面共用」或没有 Key 时返回 null，用上面的文本模型。
 */
function copyWritingConfig(settings = {}) {
  const provider = trim(settings.ai_copy_provider) || copyProviderFor(settings.ai_copy_base_url);
  if (provider === 'shared') return null;
  const preset = providers.text.find((item) => item.id === provider) || null;
  let apiKey = trim(settings.ai_copy_api_key);
  if (!apiKey && preset?.useArkKey) apiKey = trim(settings.ark_api_key);
  if (!apiKey) return null;
  return {
    ...settings,
    ai_base_url: trim(settings.ai_copy_base_url) || preset?.baseUrl || 'https://api.deepseek.com',
    ai_api_key: apiKey,
    ai_text_model: trim(settings.ai_copy_model) || preset?.model || 'deepseek-flash',
  };
}

/** 作图走 OpenAI 兼容接口（否则走火山方舟 Seedream）。 */
const usesOpenAiImages = (settings = {}) => trim(settings.image_provider) === 'openai';

module.exports = { providers, copyProviderFor, copyWritingConfig, usesOpenAiImages };
