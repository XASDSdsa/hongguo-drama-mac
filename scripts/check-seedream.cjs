'use strict';
// 海报作图走火山方舟 Seedream 5.0 Pro：请求按官方接口发（模型、参考图 data URI、尺寸、不加水印、要 base64），
// 返回的图片能用；出错说清楚、不泄露 Key；main.js 里海报、一键处理、封面重绘都走它；提示词要求结构相同、人物和物件不同。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const seedream = require('../src/native/seedream');

const root = path.join(__dirname, '..');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

async function main() {
  // 尺寸：「宽x高」在官方范围里（总像素 921600～4624220）就用，不在就用 2:3 海报尺寸
  assert.equal(seedream.POSTER_SIZE, '1664x2496');
  assert.equal(seedream.normalizeSize('1024x1536'), '1024x1536');
  assert.equal(seedream.normalizeSize('512x768'), '1664x2496', '太小（官方最少 921600 像素）换成海报尺寸');
  assert.equal(seedream.normalizeSize('1440x2560'), '1440x2560');
  assert.equal(seedream.normalizeSize('3000x3000'), '1664x2496', '超过 4624220 像素');
  assert.equal(seedream.normalizeSize('2k'), '2K');
  assert.equal(seedream.normalizeSize(''), '1664x2496');
  assert.equal(seedream.DEFAULT_MODEL, 'doubao-seedream-5-0-pro-260628');
  assert.equal(seedream.sniffImage(png), 'png');
  assert.equal(seedream.sniffImage(jpeg), 'jpeg');

  const calls = [];
  let reply = () => ({ status: 200, body: { data: [{ b64_json: png.toString('base64') }] } });
  seedream._setFetch(async (url, init = {}) => {
    calls.push({ url, init });
    const { status, body, raw } = reply(url, init);
    const data = raw || Buffer.from(JSON.stringify(body));
    return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => data };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedream-'));
  try {
    const cover = path.join(dir, '原海报.jpg');
    fs.writeFileSync(cover, jpeg);
    const config = { baseUrl: 'https://ark.example.com/api/v3/', apiKey: 'ark-secret-123', model: '' };
    const out = await seedream.editImage({ image: cover, prompt: '画海报', size: '512x512' }, config);
    assert.equal(out.contentType, 'image/png');
    assert.ok(out.buffer.equals(png));
    const [call] = calls;
    assert.equal(call.url, 'https://ark.example.com/api/v3/images/generations');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer ark-secret-123');
    const body = JSON.parse(call.init.body);
    assert.deepEqual(Object.keys(body).sort(), ['image', 'model', 'output_format', 'prompt', 'response_format', 'size', 'watermark']);
    assert.equal(body.model, 'doubao-seedream-5-0-pro-260628', '没填模型用默认的 Seedream 5.0 Pro');
    assert.equal(body.size, '1664x2496');
    assert.equal(body.response_format, 'b64_json');
    assert.equal(body.watermark, false, '不加「AI生成」水印（海报要叠标题）');
    assert.equal(body.image, `data:image/jpeg;base64,${jpeg.toString('base64')}`, '参考图转成小写格式的 data URI');

    // 只按提示词画：不带 image
    calls.length = 0;
    await seedream.generateImage({ prompt: '画海报' }, { apiKey: 'k', model: 'my-model' });
    const plain = JSON.parse(calls[0].init.body);
    assert.equal(plain.image, undefined);
    assert.equal(plain.model, 'my-model');
    assert.equal(calls[0].url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations', '没填地址用方舟默认地址');

    // 返回的是链接：马上下载（链接只保留 24 小时）
    calls.length = 0;
    reply = (url) =>
      url.includes('/images/generations')
        ? { status: 200, body: { data: [{ url: 'https://cdn.example.com/a.png' }] } }
        : { status: 200, raw: png };
    const linked = await seedream.generateImage({ prompt: 'x' }, { apiKey: 'k' });
    assert.ok(linked.buffer.equals(png));
    assert.equal(calls[1].url, 'https://cdn.example.com/a.png');

    // 出错：说清楚、不泄露 Key
    reply = () => ({ status: 401, body: { error: { code: 'AuthenticationError', message: 'bad key ark-secret-123' } } });
    await assert.rejects(seedream.generateImage({ prompt: 'x' }, config), (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /方舟 API Key 不对/);
      assert.ok(!error.message.includes('ark-secret-123'), '错误里不带 Key');
      return true;
    });
    reply = () => ({ status: 404, body: { error: { code: 'InvalidEndpointOrModel.NotFound', message: 'model not found' } } });
    await assert.rejects(seedream.generateImage({ prompt: 'x' }, config), /检查海报模型名 doubao-seedream-5-0-pro-260628/);
    reply = () => ({ status: 200, body: { data: [] } });
    await assert.rejects(seedream.generateImage({ prompt: 'x' }, config), /没有返回图片/);
    await assert.rejects(seedream.generateImage({ prompt: 'x' }, { apiKey: '' }), /请先在设置里填火山方舟 API Key/);
    await assert.rejects(seedream.editImage({ image: path.join(dir, 'nope.jpg'), prompt: 'x' }, config), /参考图文件不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('PASS Seedream: official request (model, data-URI reference, size, no watermark, base64), url download, clear errors without the key');

  // main.js：海报（AI 发布素材）、一键处理的海报、封面重绘都走 Seedream；方舟地址、Key 和视频理解共用
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(mainSource, /ark_image_model: seedream\.DEFAULT_MODEL/, '设置默认 Seedream 5.0 Pro');
  assert.match(mainSource, /generateImage: \(options, settings\) => seedream\.generateImage\(options, arkImageConfig\(settings\)\)/);
  assert.match(mainSource, /editImage: \(options, settings\) => seedream\.editImage\(options, arkImageConfig\(settings\)\)/);
  assert.match(mainSource, /copyConfig: copyWritingConfig\(settings\),\s*openai: imageAi,/, 'AI 发布素材的海报');
  assert.match(mainSource, /createOneclick\(\{\s*quchong,\s*openai: imageAi,/, '一键处理的海报');
  assert.match(mainSource, /\? await imageAi\.editImage\(/, '封面重绘');
  assert.doesNotMatch(mainSource, /openai\.(editImage|generateImage)\(/, '作图不再走 OpenAI 中转');
  assert.match(mainSource, /seedream\._setFetch\(chromiumFetch\)/, '走 Chromium 网络栈（跟随代理）');
  assert.match(mainSource, /settings\.ark_api_key,\s*\);/, '错误里抹掉方舟 Key');
  const settingsUi = fs.readFileSync(path.join(root, 'src/components/Settings.jsx'), 'utf8');
  assert.ok(settingsUi.includes("'ark_image_model'"), '设置页保存海报模型');
  assert.match(settingsUi, /海报模型（火山方舟 Seedream）/);
  assert.match(settingsUi, /placeholder="doubao-seedream-5-0-pro-260628"/);

  // 提示词：结构和原海报相同，人物换成完全不同的人，画面元素不能一样
  const publish = require('../src/native/publish-materials');
  const prompt = publish.buildArtPrompt
    ? publish.buildArtPrompt({ scene: '年轻女子，红色礼服', hasCover: true })
    : fs.readFileSync(path.join(root, 'src/native/publish-materials.js'), 'utf8');
  assert.match(prompt, /结构和原海报相同/);
  assert.match(prompt, /人物数量、站位、姿势和朝向、景别、镜头角度、主次关系、画面分区都照原海报来/);
  assert.match(prompt, /人物必须换成完全不同的人/);
  assert.match(prompt, /不能让人认出是原海报里的任何一个人/);
  assert.match(prompt, /不要照搬原海报里的任何物件/);
  assert.doesNotMatch(prompt, /保留主要人物的造型、服装/);
  const oneclickSource = fs.readFileSync(path.join(root, 'src/native/oneclick.js'), 'utf8');
  assert.match(oneclickSource, /结构和原画面相同/);
  assert.match(oneclickSource, /人物换成完全不同的人/);
  assert.match(oneclickSource, /不要出现原画面里同样的物件/);
  assert.doesNotMatch(oneclickSource, /保留画面里主要人物的外貌/);
  console.log('PASS poster prompts: same layout as the original, entirely different people, no identical elements');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
