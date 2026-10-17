// OpenAI-compatible adapter checks. No network and no real API key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const calls = [];
const responses = [
  { data: [{ b64_json: Buffer.from('image').toString('base64') }] },
  { data: [{ b64_json: Buffer.from('edited').toString('base64') }] },
  '识别到的对白',
  {
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: '第1集',
            summary: '主角遇到转折。',
            hook: '命运开始改变',
            hashtags: ['短剧', '反转'],
          }),
        },
      },
    ],
  },
];

global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  const payload = responses.shift();
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    async text() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
  };
};

const adapter = require('../src/native/openai');

(async () => {
  const config = {
    ai_base_url: 'https://relay.example.test/v1/',
    ai_api_key: 'secret-test-key',
    ai_image_model: 'gpt-image-2.5',
    ai_text_model: 'gpt-5.6',
    ai_transcription_model: 'gpt-4o-mini-transcribe',
  };
  const generated = await adapter.generateImage({ prompt: '封面' }, config);
  assert.equal(generated.buffer.toString(), 'image');
  assert.equal(calls[0].url, 'https://relay.example.test/v1/images/generations');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-test-key');

  const edited = await adapter.editImage({ image: 'data:image/png;base64,AA==', prompt: '重绘' }, config);
  assert.equal(edited.buffer.toString(), 'edited');
  assert.equal(calls[1].url, 'https://relay.example.test/v1/images/edits');
  assert.ok(calls[1].options.body instanceof FormData);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-ai-check-'));
  const audio = path.join(temp, 'audio.m4a');
  fs.writeFileSync(audio, Buffer.from('audio'));
  const transcript = await adapter.transcribeAudio(audio, {}, config);
  assert.equal(transcript, '识别到的对白');
  assert.equal(calls[2].url, 'https://relay.example.test/v1/audio/transcriptions');

  const copy = await adapter.summarizeEpisode(transcript, { seriesTitle: '示例剧', episodeIndex: 1 }, config);
  assert.equal(copy.summary, '主角遇到转折。');
  assert.equal(calls[3].url, 'https://relay.example.test/v1/chat/completions');
  assert.match(calls[3].options.headers.Authorization, /Bearer secret-test-key/);
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('OpenAI adapter: 4 passed');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
