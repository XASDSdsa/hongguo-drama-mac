// AI 发布素材：改写简介/剧名 → 画无字底图 → 程序叠标题。
// 用本机假的 OpenAI 兼容中转站验证整条链路（含文本、作图各走各的地址和 Key），不需要网络和真实 Key。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const openai = require('../src/native/openai');
const publish = require('../src/native/publish-materials');
const { createTitleRenderer } = require('../src/native/poster-title');
const { openBrowser, FONTS_DIR } = require('./lib/poster-browser.cjs');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL ' + name + ': ' + (e.stack || e.message));
  }
}

/** 不依赖任何库生成一张 PNG（竖版渐变）。 */
function png(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = 20 + Math.round((y / height) * 40);
      row[2 + x * 3] = 30 + Math.round((y / height) * 50);
      row[3 + x * 3] = 70 + Math.round((x / width) * 60);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GOOD_COPY = {
  synopsis:
    '林晚重生回到被退婚的那一天，这一次她不再忍让。前未婚夫的家族步步紧逼，她却在暗中布下一盘大棋，等着对方自己踩进陷阱。',
  titles: [
    { title: '退婚后我嫁给了他叔叔', angle: '反转' },
    { title: '她撕了婚书转身就走', angle: '情绪' },
    { title: '重生后我撕了婚书', angle: '悬念' },
    { title: '最强千金', angle: '身份落差' },
    { title: '退婚', angle: '情绪' },
    { title: '重生后我撕了婚书', angle: '重复' },
  ],
  genre: '重生逆袭',
  style: 'fire',
  tagline: '开局即反转',
  scene: '年轻女子，冷静坚定的眼神，红色礼服，豪华宴会厅，暖色灯光，电影感',
};

function startRelay(handler) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const entry = {
        url: req.url,
        auth: req.headers.authorization,
        type: req.headers['content-type'] || '',
        raw,
        json: /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw.toString() || '{}') : null,
      };
      log.push(entry);
      const out = await handler(entry, log);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, log, base: `http://127.0.0.1:${server.address().port}` })),
  );
}

const chatReply = (content) => ({ body: { choices: [{ message: { content: JSON.stringify(content) } }] } });
const isInspect = (entry) => JSON.stringify(entry.json?.messages || []).includes('image_url');

(async () => {
  const art = png(1024, 1536);
  const artB64 = art.toString('base64');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const dirs = (name) => {
    const outputDir = path.join(tmp, name, '剧');
    const workDir = path.join(tmp, name, 'work');
    fs.mkdirSync(outputDir, { recursive: true });
    return { outputDir, workDir };
  };
  const cover = path.join(tmp, '封面.png');
  fs.writeFileSync(cover, art);

  // 真渲染器（有 Chromium 和字体时）；否则用一个只回传底图的假渲染器，仍然检查流程。
  let session = null;
  let renderer;
  if (fs.existsSync(FONTS_DIR)) session = await openBrowser();
  if (session) renderer = createTitleRenderer({ fontsDir: FONTS_DIR, driver: session.driver });
  else {
    console.log('NOTE using a stub title renderer (no Chromium or fonts)');
    renderer = {
      async render(spec) {
        return { buffer: spec.image, contentType: 'image/png', meta: { layout: 'bottom', title: spec.title } };
      },
    };
  }

  // ---- 文本中转站 + 独立的作图中转站（不同地址、不同 Key） ----
  let textMode = 'ok';
  let imageCalls = 0;
  let inspectResults = [];
  const text = await startRelay(async (entry) => {
    if (!entry.url.endsWith('/chat/completions')) return { status: 404, body: { error: { message: 'no' } } };
    if (isInspect(entry)) {
      if (textMode === 'novision') return { status: 400, body: { error: { message: 'image input not supported' } } };
      return chatReply(inspectResults.shift() || { has_text: false, text_found: '', faces: [] });
    }
    if (textMode === 'badjson') return { body: { choices: [{ message: { content: '抱歉，我没法输出 JSON' } }] } };
    if (textMode === 'badcopy') return chatReply({ synopsis: '太短', titles: ['最强'] });
    return chatReply(GOOD_COPY);
  });
  const image = await startRelay(async (entry) => {
    imageCalls += 1;
    return { body: { data: [{ b64_json: artB64 }] } };
  });
  const config = {
    ai_base_url: `${text.base}/relay/v1`,
    ai_api_key: 'text-secret-key',
    ai_image_base_url: `${image.base}/img/v1`,
    ai_image_api_key: 'image-secret-key',
    ai_text_model: 'gpt-6.1-sol',
    ai_image_model: 'gpt-image-2.5',
  };
  const run = (extra) => {
    const d = dirs(extra.name);
    return publish
      .generate({
        title: '退婚之后',
        synopsis: '她被退婚，家族羞辱，随后一切发生了反转。',
        source: '红果',
        coverPath: cover,
        config,
        openai,
        renderer,
        ...d,
        ...extra.options,
      })
      .then((result) => ({ result, ...d }));
  };

  try {
    await check('defaults: text model is 6.1 sol and image model is gpt-image-2.5', () => {
      const normalized = openai.normalizeConfig({ ai_base_url: 'https://relay.example/v1', ai_api_key: 'k' });
      assert.equal(normalized.textModel, 'gpt-6.1-sol');
      assert.equal(normalized.imageModel, 'gpt-image-2.5');
      assert.equal(normalized.imageBaseUrl, normalized.baseUrl, 'image shares the text relay unless set');
      assert.equal(normalized.imageApiKey, 'k');
    });

    await check('text and image go to their own relay URLs with their own keys and models', async () => {
      text.log.length = 0;
      image.log.length = 0;
      const { result, outputDir } = await run({ name: 'happy' });
      const textCalls = text.log.filter((e) => !isInspect(e));
      assert.equal(textCalls.length, 1);
      assert.equal(textCalls[0].url, '/relay/v1/chat/completions');
      assert.equal(textCalls[0].auth, 'Bearer text-secret-key');
      assert.equal(textCalls[0].json.model, 'gpt-6.1-sol');
      assert.equal(image.log.length, 1);
      assert.equal(image.log[0].url, '/img/v1/images/edits', 'an existing cover is redrawn, not drawn from scratch');
      assert.equal(image.log[0].auth, 'Bearer image-secret-key');
      assert.match(image.log[0].raw.toString('latin1'), /gpt-image-2\.5/);
      assert.match(image.log[0].raw.toString('latin1'), /filename="封面\.png"|filename="[^"]*\.png"/);
      assert.ok(result.paths.poster.endsWith('发布海报.jpg'));
      assert.ok(fs.statSync(result.paths.poster).size > 1000);
      assert.equal(fs.readFileSync(result.paths.title, 'utf8').trim(), result.title);
      assert.match(fs.readFileSync(result.paths.synopsis, 'utf8'), /重生回到被退婚/);
      assert.deepEqual(fs.readdirSync(outputDir).sort(), ['发布剧名.txt', '发布海报.jpg', '发布简介.txt']);
    });

    await check('the prompt asks for no text, keeps the lower third clear, and carries the scene', async () => {
      const entry = image.log[0].raw.toString('utf8');
      assert.match(entry, /绝对不能出现任何文字/);
      assert.match(entry, /下方约三分之一/);
      assert.match(entry, /红色礼服/);
    });

    await check('titles: rules drop the original name, absolutes and duplicates; the best hook leads', async () => {
      const { result } = await run({ name: 'titles' });
      assert.ok(!result.candidates.includes('最强千金'), 'absolute wording removed');
      assert.ok(!result.candidates.includes('退婚'), 'too short removed');
      assert.equal(new Set(result.candidates).size, result.candidates.length);
      assert.equal(result.title, result.candidates[0]);
      assert.equal(result.styleId, 'fire');
      assert.equal(result.tagline, '开局即反转');
      const ranked = publish.rankTitles(['退婚之后', '退婚之后的我', '她回来了', '重生后我撕了婚书'], '退婚之后');
      assert.deepEqual(ranked[0], '重生后我撕了婚书');
      assert.ok(!ranked.includes('退婚之后'));
    });

    await check('the work file with the unlabeled art stays in the private dir, not the series folder', async () => {
      const { outputDir, workDir } = await run({ name: 'private' });
      assert.ok(fs.existsSync(path.join(workDir, 'art.png')));
      assert.ok(fs.existsSync(path.join(workDir, 'state.json')));
      assert.ok(!fs.readdirSync(outputDir).some((n) => /art|state/.test(n)));
    });

    await check('art with text in it is redrawn, and the redraw is what gets used', async () => {
      imageCalls = 0;
      inspectResults = [
        { has_text: true, text_found: '红果短剧', faces: [] },
        { has_text: false, faces: [{ x: 0.3, y: 0.1, w: 0.2, h: 0.12 }] },
      ];
      const { result, workDir } = await run({ name: 'retry' });
      assert.equal(imageCalls, 2);
      assert.deepEqual(result.warnings, []);
      const state = JSON.parse(fs.readFileSync(path.join(workDir, 'state.json'), 'utf8'));
      assert.equal(state.art.attempts, 2);
      assert.equal(state.art.faces.length, 1);
    });

    await check('if the art keeps having text after the last attempt, the user is told', async () => {
      imageCalls = 0;
      inspectResults = Array.from({ length: 5 }, () => ({ has_text: true, text_found: 'LOGO', faces: [] }));
      const { result } = await run({ name: 'stubborn', options: { artAttempts: 2 } });
      assert.equal(imageCalls, 2);
      assert.ok(result.warnings.some((w) => /仍可能有文字/.test(w)));
      assert.ok(fs.existsSync(result.paths.poster), 'a poster is still produced');
    });

    await check('a model without image input does not block the poster', async () => {
      textMode = 'novision';
      try {
        const { result } = await run({ name: 'novision' });
        assert.ok(result.warnings.some((w) => /视觉模型/.test(w)));
        assert.ok(fs.existsSync(result.paths.poster));
      } finally {
        textMode = 'ok';
      }
    });

    await check('changing the title or style re-lays the poster without calling any model', async () => {
      const { result, outputDir, workDir } = await run({ name: 'retitle' });
      const before = text.log.length + image.log.length;
      const first = fs.readFileSync(result.paths.poster);
      const next = await publish.retitle({
        outputDir,
        workDir,
        renderer,
        title: result.candidates[1],
        styleId: 'ink',
      });
      assert.equal(text.log.length + image.log.length, before, 'no network calls');
      assert.equal(next.title, result.candidates[1]);
      assert.equal(next.styleId, 'ink');
      assert.equal(fs.readFileSync(result.paths.title, 'utf8').trim(), result.candidates[1]);
      if (session) assert.notDeepEqual(fs.readFileSync(result.paths.poster), first);
      await assert.rejects(publish.retitle({ outputDir, workDir, renderer, styleId: 'nope' }), /未知的标题样式/);
      await assert.rejects(publish.retitle({ outputDir, workDir, renderer, title: '一'.repeat(20) }), /1–16/);
      const read = publish.readResult({ outputDir, workDir });
      assert.equal(read.title, result.candidates[1]);
      assert.equal(read.hasPoster, true);
    });

    await check('redrawing only the picture reuses the saved copy (no second text call)', async () => {
      const { result, outputDir, workDir } = await run({ name: 'keepcopy' });
      const before = text.log.filter((e) => !isInspect(e)).length;
      imageCalls = 0;
      await publish.generate({
        title: '退婚之后',
        coverPath: cover,
        outputDir,
        workDir,
        config,
        openai,
        renderer,
        keepCopy: true,
      });
      assert.equal(text.log.filter((e) => !isInspect(e)).length, before);
      assert.equal(imageCalls, 1);
      assert.equal(fs.readFileSync(result.paths.title, 'utf8').trim(), result.title);
      await assert.rejects(
        publish.generate({
          title: 'x',
          outputDir,
          workDir: path.join(tmp, 'empty'),
          config,
          openai,
          renderer,
          keepCopy: true,
        }),
        /先完整生成一次/,
      );
    });

    await check('without an original poster the picture is generated from the scene description', async () => {
      image.log.length = 0;
      const d = dirs('nocover');
      await publish.generate({
        title: '退婚之后',
        outputDir: d.outputDir,
        workDir: d.workDir,
        config,
        openai,
        renderer,
      });
      assert.equal(image.log[0].url, '/img/v1/images/generations');
      assert.match(image.log[0].json.prompt, /红色礼服/);
      assert.equal(image.log[0].json.model, 'gpt-image-2.5');
    });

    await check('unusable model output stops with a clear message and leaves no half-written files', async () => {
      for (const mode of ['badjson', 'badcopy']) {
        textMode = mode;
        const d = dirs('bad-' + mode);
        await assert.rejects(
          publish.generate({ title: '退婚之后', coverPath: cover, ...d, config, openai, renderer }),
          mode === 'badjson' ? /不是有效 JSON/ : /简介太短/,
        );
        assert.deepEqual(fs.readdirSync(d.outputDir), []);
      }
      textMode = 'ok';
    });

    await check('errors never contain either API key', async () => {
      const dead = { ...config, ai_base_url: 'http://127.0.0.1:1/v1' };
      const d = dirs('dead');
      await assert.rejects(publish.generate({ title: '退婚之后', ...d, config: dead, openai, renderer }), (e) => {
        assert.ok(!/text-secret-key|image-secret-key/.test(e.message));
        return true;
      });
    });

    await check('missing keys are reported per endpoint', async () => {
      const d = dirs('nokey');
      await assert.rejects(
        publish.generate({ title: 'x', ...d, config: { ...config, ai_api_key: '' }, openai, renderer }),
        /文本 API Key|AI API Key/,
      );
      await assert.rejects(
        openai.generateImage(
          { prompt: 'x' },
          { ai_base_url: config.ai_base_url, ai_api_key: '', ai_image_api_key: '' },
        ),
        /作图 API Key/,
      );
    });
  } finally {
    text.server.close();
    image.server.close();
    if (session) {
      await renderer.close();
      await session.close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
})();
