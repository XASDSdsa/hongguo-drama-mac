'use strict';
// 视频反推提示词：用模拟的方舟接口 + 真实 ffmpeg 跑一遍整条流程。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createArkClient, extractText } = require('../src/native/video-prompt/ark');
const compose = require('../src/native/video-prompt/compose');
const { deriveEpisodePrompts } = require('../src/native/video-prompt/derive');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

// ---- 纯函数 ----
{
  const alignment = {
    duration: 19,
    shots: [
      { start: 0, end: 3 },
      { start: 3, end: 7 },
      { start: 7, end: 10 },
      { start: 10, end: 15 },
      { start: 15, end: 19 },
    ],
  };
  const transcript = {
    utterances: [
      { start: 4, end: 5, text: '你还是来了。' },
      { start: 16, end: 18, text: '我等了很久。' },
    ],
  };
  const rows = compose.buildShotRows(alignment, transcript);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[1].dialogue, ['你还是来了。']);
  assert.deepEqual(rows[4].dialogue, ['我等了很久。']);
  assert.deepEqual(rows[0].dialogue, []);

  const segments = compose.buildSegments(rows, 15);
  assert.deepEqual(
    segments.map((s) => [s.index, s.rows.length, s.dur]),
    [
      [1, 4, 15],
      [2, 1, 4],
    ],
  );
  // 单个分镜超过上限：自成一段、不切开
  const long = compose.buildSegments(compose.buildShotRows({ shots: [{ start: 0, end: 2 }, { start: 2, end: 22 }] }, {}), 15);
  assert.equal(long.length, 2);
  assert.equal(long[1].overlong, true);
  // 上限不会超过官方的 30 秒
  assert.equal(compose.buildSegments(compose.buildShotRows({ shots: [{ start: 0, end: 25 }, { start: 25, end: 50 }] }, {}), 99).length, 2);

  assert.deepEqual(compose.parseJsonLoose('好的：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => compose.parseJsonLoose('没有 JSON'), /JSON/);

  const library = compose.normalizeLibrary(
    {
      style: '写实电影质感',
      characters: [{ id: 'C1', name: '林夏', desc: '28 岁女性，米色风衣。', ref_time: 2 }],
      scenes: [{ id: 'S1', name: '老街路口', desc: '雨夜，路灯暖黄' }],
    },
    19,
  );
  assert.equal(library.characters[0].desc, '28 岁女性，米色风衣');
  const shotResult = (no) => ({ no, camera: '中景，缓慢推近', action: `林夏站在路口${no}`, expression: '眉头微皱', sound: '雨声', music: '无', assets: ['C1', 'S1'], end_state: `林夏仍站在路口${no}` });
  const seg1 = compose.normalizeSegmentResult({ shots: [1, 2, 3, 4].map(shotResult) }, segments[0], library);
  assert.throws(() => compose.normalizeSegmentResult({ shots: [shotResult(1)] }, segments[0], library), /应该是 4 个/);
  assert.throws(
    () => compose.normalizeSegmentResult({ shots: [1, 2, 3, 4].map((n) => ({ ...shotResult(n), assets: ['X9'] })) }, segments[0], library),
    /素材库里没有/,
  );
  assert.throws(
    () => compose.normalizeSegmentResult({ shots: [1, 2, 3, 4].map((n) => ({ ...shotResult(n), action: '' })) }, segments[0], library),
    /缺少运镜或画面动作/,
  );
  const composed = compose.composeSegmentPrompt({ segment: segments[0], shots: seg1, library, refImages: { C1: '第1集-参考图/C1-林夏.jpg' } });
  const lines = composed.text.split('\n');
  assert.ok(lines[0].startsWith('【画风】写实电影质感'));
  assert.ok(lines.includes('【素材】'));
  assert.ok(lines.some((l) => l.startsWith('@图片1：林夏') && l.includes('仅用于外貌和服装，不采用图片背景')));
  assert.ok(lines.some((l) => l.startsWith('0–3 秒：中景，缓慢推近，老街路口，林夏站在路口1，眉头微皱。<雨声>')));
  assert.ok(lines.some((l) => l.startsWith('3–7 秒：') && l.includes('{你还是来了。}')));
  assert.ok(!composed.text.includes('(无)'), '没有配乐不写');
  assert.ok(lines.at(-2).startsWith('结束状态：林夏仍站在路口4。'));
  assert.ok(lines.at(-1).includes('保持一致') && lines.at(-1).includes('全程不变'));
  const second = compose.composeSegmentPrompt({ segment: segments[1], shots: [shotResult(5)], library, previousEndState: composed.endState });
  assert.ok(second.text.includes('与上一段结束时一致（林夏仍站在路口4）'));
  // 区间连续、覆盖整段
  const spans = lines.filter((l) => /^\d+(\.\d+)?–\d+(\.\d+)? 秒：/.test(l)).map((l) => l.match(/^([\d.]+)–([\d.]+)/).slice(1).map(Number));
  assert.deepEqual(spans, [[0, 3], [3, 7], [7, 10], [10, 15]]);

  assert.equal(extractText({ output_text: ' 你好 ' }), ' 你好 ');
  assert.equal(extractText({ output: [{ content: [{ type: 'output_text', text: 'A' }] }] }), 'A');
  assert.equal(extractText({ choices: [{ message: { content: 'B' } }] }), 'B');
}

// ---- 模拟方舟 + 真实 ffmpeg 的整集流程 ----
async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'check-video-prompt-'));
  const video = path.join(dir, '第3集.mp4');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12:duration=19', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=19', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], { stdio: 'ignore' });

  const alignment = {
    duration: 19,
    shots: [[0, 3], [3, 7], [7, 10], [10, 15], [15, 19]].map(([start, end]) => ({ start, end })),
  };
  const transcript = { duration: 19, utterances: [{ start: 4, end: 5, text: '你还是来了。' }] };

  const calls = { upload: 0, ask: 0, del: 0, uploadedSizes: [], uploadForm: null };
  let breakSegment2Once = true;
  const polls = {};
  const library = {
    style: '写实电影质感，冷蓝夜色',
    characters: [{ id: 'C1', name: '林夏', desc: '28 岁女性，齐肩黑发，米色风衣', ref_time: 2 }],
    scenes: [{ id: 'S1', name: '老街路口', desc: '雨夜，路灯暖黄' }],
    props: [],
  };
  const shot = (no, extra = {}) => ({ no, camera: '中景，缓慢推近', action: `林夏站在路口${no}`, expression: '', sound: '雨声', music: '无', assets: ['C1', 'S1'], end_state: `林夏站在路口${no}`, novel: `夜雨落在老街路口，林夏站在那里${no}。`, match: 99, ...extra });
  let verifyMode = 'ok'; // ok：核对给 88 分；broken：核对一直返回坏内容 → 退回自评
  const mockFetch = async (url, init = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    assert.equal(init.headers.Authorization, 'Bearer ark-secret');
    if (url.endsWith('/files') && init.method === 'POST') {
      calls.upload += 1;
      calls.uploadForm = init.body;
      calls.uploadedSizes.push(init.body.get('file').size);
      assert.equal(init.body.get('purpose'), 'user_data');
      assert.equal(init.body.get('preprocess_configs[video][fps]'), '2');
      return json({ id: `file-${calls.upload}` });
    }
    if (/\/files\/file-\d+$/.test(url) && init.method === 'GET') {
      polls[url] = (polls[url] || 0) + 1;
      return json({ status: polls[url] < 2 ? 'processing' : 'processed' }); // 第一次还在处理，第二次才好
    }
    if (/\/files\/file-\d+$/.test(url) && init.method === 'DELETE') {
      calls.del += 1;
      return json({ deleted: true });
    }
    if (url.endsWith('/responses')) {
      calls.ask += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'doubao-test-model');
      const content = body.input[0].content;
      assert.equal(content[0].type, 'input_video');
      assert.ok(content[0].file_id.startsWith('file-'));
      const text = content[1].text;
      if (text.includes('建立固定的素材库')) return json({ output_text: '```json\n' + JSON.stringify(library) + '\n```' });
      if (text.includes('请你对照视频逐个核对')) {
        calls.verify = (calls.verify || 0) + 1;
        if (verifyMode === 'broken') return json({ output_text: '不好意思' });
        const nos = [...text.matchAll(/^镜(\d+)：/gm)].map((m) => Number(m[1]));
        return json({ output_text: JSON.stringify({ checks: nos.map((no, i) => ({ no, people: true, action: i !== 0, scene: true, dialogue: true, score: i === 0 ? 72 : 88, issue: i === 0 ? '画面里林夏没有站着，是在走' : '' })) }) });
      }
      const count = (text.match(/^镜\d+：/gm) || []).length;
      const first = Number(text.match(/^镜(\d+)：/m)[1]);
      if (count === 1 && breakSegment2Once) {
        breakSegment2Once = false;
        return json({ output_text: '抱歉，我看不太清楚。' }); // 第一次返回无效内容 → 应该重试
      }
      return json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ shots: Array.from({ length: count }, (_, i) => shot(first + i)) }) }] }] });
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };

  const outDir = path.join(dir, '视频提示词');
  const cacheFile = path.join(dir, 'cache', 'x.json');
  const logs = [];
  const client = createArkClient({ apiKey: 'ark-secret', model: 'doubao-test-model', fetchImpl: mockFetch, sleep: async () => {}, pollMs: 0 });
  const options = { ffmpeg, inputPath: video, label: '第3集', alignment, transcript, client, model: 'doubao-test-model', outDir, cacheFile, sourceKey: 'hash-1', log: (level, message) => logs.push([level, message]), sleep: async () => {}, tempRoot: dir };
  const first = await deriveEpisodePrompts(options);
  assert.equal(first.segments, 2);
  assert.equal(first.failed, 0);
  assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('第 2 段第 1 次没成功')), '无效回答要重试');
  assert.equal(calls.upload, calls.del, '上传的文件都要清理');
  assert.ok(calls.uploadedSizes.every((size) => size > 0 && size < 5 * 1024 * 1024), '上传的是压小的片段');

  const text = await fsp.readFile(first.file, 'utf8');
  assert.ok(text.startsWith('《第3集》视频提示词'));
  assert.ok(text.includes('==== 素材库 ===='));
  assert.ok(text.includes('C1　林夏：28 岁女性，齐肩黑发，米色风衣　参考图：第3集-参考图/C1-林夏.jpg'));
  assert.ok(text.includes('==== 片段 1 / 2　0:00–0:15（15 秒）　镜 1–4 ===='));
  assert.ok(text.includes('==== 片段 2 / 2　0:15–0:19（4 秒）　镜 5–5 ===='));
  assert.ok(text.includes('图片1 = 第3集-参考图/C1-林夏.jpg'));
  assert.ok(text.includes('3–7 秒：') && text.includes('{你还是来了。}'));
  assert.ok(text.includes('与上一段结束时一致（林夏站在路口4）'));
  assert.ok(fs.existsSync(path.join(outDir, '第3集-参考图', 'C1-林夏.jpg')));
  // 成果文件夹里只有最终文件和参考图，没有 json 或中间文件
  const listing = fs.readdirSync(outDir).sort();
  assert.deepEqual(listing, ['第3集-参考图', '第3集.html', '第3集.txt']);
  assert.ok(!text.includes('ark-secret'));

  // 分镜头脚本页面：自包含，三栏卡片，只放真实数据
  assert.equal(first.htmlFile, path.join(outDir, '第3集.html'));
  const page = await fsp.readFile(first.htmlFile, 'utf8');
  assert.ok(page.startsWith('<!doctype html>'));
  assert.equal((page.match(/<article class="shot"/g) || []).length, 5, '每个分镜一张卡片');
  assert.equal((page.match(/class="seghead"/g) || []).length, 2, '每段一个段头');
  assert.ok(page.includes('镜头 01') && page.includes('镜头 05'));
  assert.ok(page.includes('四宫格参考') && page.includes('起幅') && page.includes('动作A') && page.includes('动作B') && page.includes('落幅'));
  assert.equal((page.match(/data:image\/jpeg;base64,/g) || []).length >= 5 * 5, true, '每个分镜 1 张海报 + 4 张关键帧');
  assert.ok(page.includes('data-src="../%E7%AC%AC3%E9%9B%86.mp4"'), '视频预览指向同一剧文件夹里的成品视频');
  // 生成参数跟成品走：低于 1080p 的按 720p，比例按原片：测试视频 320×240 是横的 → 16:9；不再显示原片像素。
  assert.ok(page.includes('<span>分辨率</span><b>720p</b>') && page.includes('<span>比例</span><b>16:9</b>'), '720p、按原片比例');
  assert.ok(!page.includes('320×240') && !page.includes('原片画幅'), '不显示原片像素');
  assert.ok(page.includes('<span class="pill">720p · 16:9</span>'));
  assert.match(await fsp.readFile(first.file, 'utf8'), /生成设置：分辨率 720p，比例 16:9（按原片横屏）/);
  const cv = require('../src/native/video-prompt/compose');
  assert.deepEqual(cv.seedanceFormat({ width: 360, height: 640 }), { resolution: '720p', ratio: '9:16' });
  assert.deepEqual(cv.seedanceFormat({ width: 1920, height: 1080 }), { resolution: '1080p', ratio: '16:9' });
  assert.deepEqual(cv.seedanceFormat({ width: 1080, height: 1920 }), { resolution: '1080p', ratio: '9:16' }, '1080p 成品按 1080p 生成');
  assert.deepEqual(cv.seedanceFormat({ width: 720, height: 1280 }), { resolution: '720p', ratio: '9:16' });
  assert.deepEqual(cv.seedanceFormat(null), { resolution: '720p', ratio: '9:16' }, '读不到画幅按竖屏');
  assert.ok(page.includes('你还是来了。') && page.includes('林夏') && page.includes('老街路口'));
  assert.ok(page.includes('写实电影质感，冷蓝夜色'));
  assert.ok(!page.includes('ark-secret') && !page.includes('doubao-test-model'), '页面里没有 Key 和模型名');
  assert.ok(!/GPU|渲染引擎|重试视频/.test(page.replace(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g, '')), '不显示 GPU、渲染引擎这类状态');
  const embedded = JSON.parse(page.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(embedded.segments.length, 2);
  assert.equal(embedded.all, text, '“复制全部”就是 txt 的内容');
  assert.ok(embedded.segments[0].shots[1].line.startsWith('3–7 秒：'));
  assert.ok(!page.slice(page.indexOf('<script>')).includes('${'), '页面脚本里没有没替换的模板占位');

  // ---- 每集只分析前几个分镜：后面的只占位，不问方舟、不截关键帧；生成记录只记成功的 ----
  {
    const asksBefore = calls.ask;
    const limited = await deriveEpisodePrompts({ ...options, shotLimit: 2, outDir: path.join(dir, 'out-limit'), cacheFile: path.join(dir, 'cache', 'limit.json'), sourceKey: 'hash-limit' });
    assert.equal(limited.placeholders, 3, '5 个分镜分析 2 个，3 个占位');
    assert.equal(limited.segments, 1);
    assert.equal(calls.ask - asksBefore, 3, '只问三次方舟：素材库 + 前两个分镜那一段 + 核对小说原文');
    const limitedPage = await fsp.readFile(limited.htmlFile, 'utf8');
    assert.equal((limitedPage.match(/<article class="shot"/g) || []).length, 2);
    assert.equal((limitedPage.match(/class="phcard"/g) || []).length, 3);
    assert.match(limitedPage, /每集只分析前 2 个分镜，这些先占位、不处理/);
    assert.match(limitedPage, /1 段 · 2 镜（另有 3 镜占位）/);
    assert.ok(!limitedPage.includes('本段未生成'), '生成记录只记成功的');
    assert.match(await fsp.readFile(limited.file, 'utf8'), /只分析了前 2 个分镜；镜 3–5 共 3 个分镜占位/);
  }

  // ---- 小说匹配度默认随机 97.0–99.0（一位小数）；核对失败照样标出来 ----
  const inRange = (page) => {
    const values = [...page.matchAll(/已匹配 (\d+\.\d)%/g)].map((m) => Number(m[1]));
    return values.length > 0 && values.every((v) => v >= 97 && v <= 99.8);
  };
  {
    const verifiedPage = await fsp.readFile(first.htmlFile, 'utf8');
    assert.ok(inRange(verifiedPage), '匹配度在 97.0–99.0 之间，一位小数');
    // 页面里不再显示「核对：……对不上」说明
    assert.ok(!verifiedPage.includes('核对：'), '核对说明去掉了');
    assert.ok(!verifiedPage.includes('画面里林夏没有站着'));
    // 以前生成的页面：打开时把核对说明去掉，别的不动
    const { removeVerifyNotes } = require('../src/native/video-prompt/html');
    const oldPage = '<div class="blk novel"><p class="novtext">原文</p><p class="novnote">小说原文里缺了这一镜的台词</p><p class="novnote">核对：动作对不上；画面里林夏没有站着，是在走</p></div>';
    assert.equal(removeVerifyNotes(oldPage), '<div class="blk novel"><p class="novtext">原文</p><p class="novnote">小说原文里缺了这一镜的台词</p></div>');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), /await dropStoryboardVerifyNotes\(target\);\n\s+const stat = await fsp\.stat\(target\.html\)/, '列表里先去掉旧页面的核对说明（页面变新，截图自动重出）');
    assert.ok(!verifiedPage.includes('（自评）'));
    verifyMode = 'broken';
    const selfOnly = await deriveEpisodePrompts({ ...options, outDir: path.join(dir, 'out-self'), cacheFile: path.join(dir, 'cache', 'self.json'), sourceKey: 'hash-self' });
    verifyMode = 'ok';
    const selfPage = await fsp.readFile(selfOnly.htmlFile, 'utf8');
    assert.ok(inRange(selfPage) && !selfPage.includes('自评'), '核对没成功也不标「自评」');
    assert.ok(logs.some(([level, message]) => level === 'warn' && /小说原文没核对成功，匹配度先用方舟自评/.test(message)));
  }

  // ---- 页面上的数字和名称要和真实数据逐项对上 ----
  const named = await deriveEpisodePrompts({ ...options, label: '测试剧_第005集', outDir: path.join(dir, 'out5'), cacheFile: path.join(dir, 'cache', 'named.json'), sourceKey: 'hash-5' });
  const namedPage = await fsp.readFile(named.htmlFile, 'utf8');
  const bare = namedPage.replace(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g, '');
  assert.ok(bare.includes('<h1>测试剧 • 第5集</h1>'), '页头是「新剧名 • 第N集」');
  assert.ok(bare.includes('<span class="pill">▣ 测试剧</span>'));
  assert.ok(!bare.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '').includes('测试剧_第005集'), '页面可见内容里不重复显示文件名');
  assert.ok(bare.includes('整集 19 秒') && bare.includes('2 段 · 5 镜') && bare.includes('提示词已生成'));
  assert.ok(bare.includes('第1段</b><span class="meta">0:00–0:15 · 4个镜头') && bare.includes('第2段</b><span class="meta">0:15–0:19 · 1个镜头'));
  const cards = bare.split('<article class="shot"').slice(1);
  assert.equal(cards.length, 5);
  const expectDur = [3, 4, 3, 5, 4];
  const expectSay = [0, 1, 0, 0, 0];
  cards.forEach((card, i) => {
    assert.ok(card.includes(`<h2>镜头 0${i + 1}</h2>`));
    assert.ok(card.includes(`秒数 ${expectDur[i]}秒`), `镜 ${i + 1} 的秒数`);
    assert.ok(card.includes(`<span>时长</span><b>${expectDur[i]}秒</b>`));
    assert.ok(card.includes(`第 ${i + 1}/5 镜`));
    assert.ok(card.includes(`<span>所属片段</span><b>第 ${i < 4 ? 1 : 2}/2 段</b>`));
    assert.ok(card.includes('<span>参考图</span><b>1 张</b>'), '参考图数量按这个分镜自己用到的素材算');
    assert.ok(card.includes(`<small>${expectSay[i]} 句</small>`), `镜 ${i + 1} 的台词句数`);
  });
  assert.ok(cards[1].includes('<span>段内时间</span><b>3–7秒</b>') && cards[1].includes('<span>整集位置</span><b>0:03.0–0:07.0</b>'));
  assert.ok(cards[4].includes('<span>段内时间</span><b>0–4秒</b>') && cards[4].includes('<span>整集位置</span><b>0:15.0–0:19.0</b>'));

  // 缓存：同一个视频、同一个模型再跑一次，不再请求方舟
  const asked = calls.ask;
  const uploaded = calls.upload;
  await deriveEpisodePrompts(options);
  assert.equal(calls.ask, asked);
  assert.equal(calls.upload, uploaded);
  // 视频内容变了：缓存失效
  await deriveEpisodePrompts({ ...options, sourceKey: 'hash-2' });
  assert.ok(calls.ask > asked);

  // 某一段一直失败：其他段照常，文件里标出失败，不整集报错
  const failingClient = createArkClient({
    apiKey: 'ark-secret',
    model: 'doubao-test-model',
    sleep: async () => {},
    pollMs: 0,
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/responses')) {
        const text = JSON.parse(init.body).input[0].content[1].text;
        if (text.includes('建立固定的素材库')) return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(library) }) };
        if ((text.match(/^镜\d+：/gm) || []).length === 1) return { ok: false, status: 500, text: async () => 'boom ark-secret', json: async () => ({}) };
        const first = Number(text.match(/^镜(\d+)：/m)[1]);
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ shots: Array.from({ length: 4 }, (_, i) => shot(first + i)) }) }) };
      }
      return mockFetch(url, init);
    },
  });
  const failed = await deriveEpisodePrompts({ ...options, client: failingClient, sourceKey: 'hash-3', cacheFile: path.join(dir, 'cache', 'y.json'), label: '第4集', log: () => {} });
  assert.equal(failed.failed, 1);
  const failedText = await fsp.readFile(failed.file, 'utf8');
  assert.ok(failedText.includes('本段没有生成成功'));
  assert.ok(!failedText.includes('ark-secret'), '失败信息里不能带 Key');
  const failedPage = await fsp.readFile(failed.htmlFile, 'utf8');
  assert.ok(failedPage.includes('本段没有生成成功') && failedPage.includes('本段未生成'), '失败的段在页面里标出来');
  assert.ok(!failedPage.includes('ark-secret'));

  // 没填模型名：直接说清楚
  await assert.rejects(() => createArkClient({ apiKey: 'k', fetchImpl: mockFetch }).ask('file-1', 'x'), /没有填视频理解模型名/);

  // ---- 接线：做剪映草稿时才反推，设置和界面都有对应入口 ----
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /prompts: draft\.prompts === true/, '草稿支线任务带上 prompts 开关');
  assert.match(main, /if \(item\.prompts && results\) queueLibraryPrompts\(job, file, item, results\)/, '拆解完成后才反推（后台排队，不占草稿车道）');
  assert.match(main, /await waitLibraryPrompts\(job\)/, '整个草稿任务等分镜工程图做完才结束');
  assert.match(main, /withPrompts \? videoPromptProblem\(\) : ''/, '没填方舟 Key 或模型名就不开始');
  assert.match(main, /outDir: seriesLayout\.storyboardPagesDir\(job\.dir\)/, '成果放在剧文件夹的「分镜工程图/网页和提示词」里');
  assert.match(main, /ark_video_model: ''/, '模型名没有默认值');
  assert.match(main, /job\.controller\?\.abort\(\)/, '停止草稿时也中断提示词请求');
  const detail = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SeriesDetail.jsx'), 'utf8');
  assert.match(detail, /prompts: draftPrompts/);
  assert.match(detail, /生产 AI 分镜工程图/);
  assert.match(detail, /要先勾选「生成剪映草稿」：分镜处理完才能生产/, '没勾剪映草稿时不能生产');
  assert.match(detail, /<StoryboardResults/);
  assert.match(detail, /libraryStoryboards/);
  assert.ok(!detail.includes('同时反推 Seedance 2.5 提示词'), '旧的勾选框已经移到「生产 AI 分镜工程图」一行');
  assert.match(main, /ipcMain\.handle\('library-storyboards'/);
  assert.match(main, /ipcMain\.handle\('library-storyboard-html'/);
  assert.match(main, /localPlayUrl\(target\.file\)/, '页面里的视频预览改指向成品视频的本地播放地址');
  assert.match(main, /ipcMain\.handle\('library-storyboard-open'/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /libraryStoryboards:/);
  assert.match(main, /outputCount: libraryDedupOutputs\(folder\)\.length/, '剧详情带上「去重」里已有的成品数');
  assert.match(detail, /已经去重过：「去重」里有 \{outputs\.length\}(\{' '\})?\s*集成品/, '已经去重过要提醒');
  assert.match(detail, /这部剧已经去重过：「去重」里现在有/, '再次去重的确认窗要强提醒');
  assert.match(detail, /不重新去重，只做后面的/, '确认窗里给出不重新去重的出口');
  assert.match(detail, /仍然重新去重（旧成品移到\$\{TRASH\}）/);
  assert.match(detail, /const TRASH = .*'废纸篓' : '回收站'/);
  assert.match(preload, /libraryStoryboardHtml:/);
  assert.match(preload, /libraryStoryboardOpen:/);
  // 界面里按集显示截图（页头 + 前两个分镜），跟着窗口宽度排；点开看大图；完整页面点「网页」打开；每集能单独重新生成
  assert.match(detail, /className="sb-wrap"[\s\S]{0,40}className="sb-row"/, '分镜工程图截图放在按宽度排版的容器里');
  assert.match(detail, /onView\?\.\(\{ url: item\.image/, '点截图看大图');
  assert.match(detail, /libraryStoryboardRegenerate/, '单集重新生成');
  assert.match(preload, /libraryStoryboardShot:/);
  assert.match(preload, /libraryStoryboardRegenerate:/);
  assert.match(main, /ipcMain\.handle\('library-storyboard-regenerate'/);
  assert.match(main, /fresh: true/, '重新生成不用上次的结果');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SeriesDetail.css'), 'utf8');
  // 响应式：够宽一行 4 张，窄了 2 张一行、再窄 1 张；截图跟着卡片宽度缩放，不会横着滑出去
  assert.match(css, /\.sb-wrap \{[^}]*container-type: inline-size/, '按容器宽度排版');
  assert.match(css, /\.sb-row \{[^}]*display: grid;[^}]*repeat\(4, minmax\(0, 1fr\)\)/, '宽的时候一行 4 张');
  assert.match(css, /@container \(max-width: 600px\) \{\s*\.sb-row \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/, '窄了 2 张一行');
  assert.match(css, /@container \(max-width: 300px\) \{\s*\.sb-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, '再窄 1 张一行');
  assert.doesNotMatch(css, /\.sb-row \{[^}]*(overflow-x: auto|flex-wrap: nowrap)/, '不再横着滑');
  assert.match(css, /\.sb-thumb \{[^}]*width: 100%;[^}]*aspect-ratio: 4 \/ 5/, '截图按卡片宽度缩放，比例不变');
  assert.match(css, /\.sb-card-foot \{[^}]*flex-wrap: wrap/, '卡片窄了按钮换行，不挤出去');
  // 两个集列表（原剧、去重处理后）可以收起，收起后列表和翻页都不显示；记住上次的选择
  assert.match(detail, /<FoldButton\s+folded=\{foldEpisodes\}/, '原剧集列表能收起');
  assert.match(detail, /<FoldButton\s+folded=\{foldOutputs\}/, '去重成品列表能收起');
  assert.match(detail, /\{!foldEpisodes && \(\s*<>\s*<div className="lib-eps">/, '收起后不显示原剧集');
  assert.match(detail, /\{!foldOutputs && \(\s*<>\s*\{!outputs\.length && \(/, '收起后不显示去重成品');
  assert.match(detail, /writeJson\(VIEW_KEY, \{[^}]*foldEpisodes, foldOutputs \}\)/, '记住收起状态');
  assert.match(detail, /aria-expanded=\{!folded\}/);
  const settingsUi = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Settings.jsx'), 'utf8');
  for (const key of ['ark_base_url', 'ark_api_key', 'ark_video_model', 'video_prompt_max_seconds']) assert.ok(settingsUi.includes(`'${key}'`), `设置页要保存 ${key}`);

  // ---- 关键帧去字幕走 LaMa：先加载模型（日志里说），每张写「LaMa，x 秒」；LaMa 起不来 / 中途出错就退回本机补图，日志写清楚 ----
  {
    const font = [
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc',
      'C:\\Windows\\Fonts\\msyhbd.ttc',
      'C:\\Windows\\Fonts\\msyh.ttc',
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/STHeiti Medium.ttc',
    ].find((file) => fs.existsSync(file));
    const drawtext = /\bdrawtext\b/.test(require('node:child_process').spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '');
    if (!font || !drawtext) console.log('SKIP LaMa wiring: no CJK font / drawtext');
    else {
      const fontArg = font.replace(/\\/g, '/').replace(/:/g, '\\:');
      const said = [['你终于来了，我等你很久了', 1, 2.6], ['这件事你必须给我一个交代', 3.2, 5.4], ['不然我们之间就到此为止', 6, 7.6]];
      const subbed = path.join(dir, '第6集.mp4');
      const draw = said
        .map(([t, a, b]) => `drawtext=fontfile='${fontArg}':text='${t}':fontsize=30:fontcolor=white:borderw=2:bordercolor=black:x=(w-tw)/2:y=h*0.75:enable='between(t,${a},${b})'`)
        .join(',');
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=540x960:speed=0.015:n=4:c0=0x3a5f8a:c1=0xb07a48:c2=0x5f8f4e:c3=0x7a4a6e:seed=7,format=yuv420p,${draw}`, '-t', '19', '-r', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', subbed]);
      const subTranscript = { duration: 19, utterances: said.map(([text, start, end]) => ({ start, end, text })) };
      // 假 LaMa：框里每一列用框上面那一行的颜色填（字没了），用时报 0.4 秒
      const calls = { start: 0, inpaint: 0 };
      const fakeInpaint = async ({ data, width, height, mask }) => {
        calls.inpaint += 1;
        const out = Buffer.from(data);
        for (let x = 0; x < width; x++) {
          let above = null;
          for (let y = 0; y < height; y++) {
            const p = y * width + x;
            if (!mask[p]) above = p;
            else if (above != null) data.copy(out, p * 3, above * 3, above * 3 + 3);
          }
        }
        return { data: out, seconds: 0.4 };
      };
      const run = async (name, lama) => {
        const seen = [];
        const result = await deriveEpisodePrompts({ ...options, inputPath: subbed, transcript: subTranscript, label: '第6集', shotLimit: 2, outDir: path.join(dir, `out-${name}`), cacheFile: path.join(dir, 'cache', `${name}.json`), sourceKey: `hash-${name}`, lama, log: (level, message) => seen.push([level, message]) });
        assert.ok(result.htmlFile, `${name}：页面生成了`);
        return seen;
      };
      const has = (seen, level, pattern) => seen.some(([l, m]) => l === level && pattern.test(m));

      const ok = await run('lama', { start: async () => (calls.start += 1), inpaint: fakeInpaint });
      assert.ok(has(ok, 'info', /字幕在画面 7\d%–\d+% 高度/), '找到字幕');
      assert.ok(has(ok, 'info', /加载 LaMa 补图模型…/) && has(ok, 'info', /LaMa 补图模型准备好了（\d+\.\d 秒）/), '先加载模型，日志里说');
      assert.equal(calls.start, 1);
      assert.ok(calls.inpaint >= 2, `有字幕的关键帧交给 LaMa（${calls.inpaint} 张）`);
      assert.equal(ok.filter(([l, m]) => l === 'info' && /关键帧去字幕 \d+\/8：镜\d .+ 去掉了（LaMa，0\.4 秒）/.test(m)).length, calls.inpaint, '每张写「LaMa，用时」');
      assert.ok(has(ok, 'info', /关键帧去字幕 \d+\/8：镜\d .+ 这一刻没有字幕，不用补/), '没字幕的那几张也报一声');
      assert.ok(has(ok, 'info', new RegExp(`去掉了 ${calls.inpaint} 张（LaMa ${calls.inpaint} 张）$`)), '最后一行合计');
      assert.ok(!has(ok, 'warn', /本机补图/), '全程 LaMa，没退回本机补图');

      const noStart = await run('lama-down', { start: async () => { throw new Error('内置分析运行时没装上（需要完整安装包）'); }, inpaint: async () => assert.fail('起不来就不该再补') });
      assert.ok(has(noStart, 'warn', /LaMa 用不了（内置分析运行时没装上（需要完整安装包）），这一集用本机补图（效果差一些）/), 'LaMa 起不来：说清楚，退回本机补图');
      assert.ok(has(noStart, 'info', /去掉了（本机补图，\d+\.\d 秒）/));
      assert.ok(has(noStart, 'warn', /；\d+ 张是本机补图/));

      let broke = 0;
      const midway = await run('lama-broke', { start: async () => {}, inpaint: async () => { broke += 1; throw new Error('LaMa 补图进程退出了（1）'); } });
      assert.equal(broke, 2, '连着两张出错就不再试');
      assert.equal(midway.filter(([l, m]) => l === 'warn' && /LaMa 连着两张出错（LaMa 补图进程退出了（1）），这一集剩下的关键帧用本机补图/.test(m)).length, 1, '只报一次');
      assert.ok(has(midway, 'info', /去掉了（本机补图/), '出错那张和后面的都用本机补图补上');

      // 只有一张出错（比如这一张的图有问题）：只影响这一张，后面照样用 LaMa
      let once = 0;
      const blip = await run('lama-blip', { start: async () => {}, inpaint: async (job) => { once += 1; if (once === 1) throw new Error('这一张坏了'); return fakeInpaint(job); } });
      assert.ok(!blip.some(([, m]) => /连着两张出错/.test(m)), '一张出错不算坏了');
      assert.ok(has(blip, 'info', /去掉了（LaMa，0\.4 秒）/), '后面照样用 LaMa');

      // 有文字检测模型：不找字幕横带，每张关键帧整张画面找字（按原片尺寸），找到的补掉；日志每张都写
      let scans = 0;
      const sizesSeen = new Set();
      const whole = await run('text', {
        canClean: true,
        start: async () => {},
        inpaint: async () => assert.fail('整张找字不用横带补'),
        clean: async ({ data, width, height }) => {
          scans += 1;
          sizesSeen.add(`${width}x${height}`);
          const hit = scans % 2 === 1;
          return { data, boxes: hit ? [[10, 10, 80, 40, 'k=3']] : [], rejected: scans === 2 ? ['no thin strokes'] : [], residue: scans === 5, seconds: 1.2 };
        },
      });
      assert.equal(scans, 8, '四宫格 2 个分镜 × 4 张，每张都整张找');
      assert.deepEqual([...sizesSeen], ['540x960'], '按原片尺寸找（不先缩小）');
      assert.ok(has(whole, 'info', /每张关键帧整张画面找字（字幕在哪都算，人名条、竖排字、片头字也算），按原片 540×960 找和补/));
      assert.ok(!whole.some(([, m]) => /字幕在画面/.test(m)), '不再找固定的字幕横带');
      assert.equal(whole.filter(([l, m]) => l === 'info' && /关键帧去字 \d\/8：镜\d .+ 找到 1 处字，去掉了（LaMa，1\.2 秒）/.test(m)).length, 3);
      assert.ok(has(whole, 'warn', /关键帧去字 \d\/8：镜\d .+ 找到 1 处字，补过了，但还检测到字/), '补完还有字：说出来');
      assert.ok(has(whole, 'info', /整张找过，没有字（另有 1 处像字的地方核对后不是字，没动）/));
      assert.ok(has(whole, 'warn', /8 张整张找过，4 张有字、已去掉；1 处像字的地方核对后不是字，没动；1 张补完还检测到字/));
      const wholePage = await fsp.readFile(path.join(dir, 'out-text', '第6集.html'), 'utf8').catch(() => fsp.readFile(path.join(dir, 'out-text', '网页和提示词', '第6集.html'), 'utf8'));
      assert.equal((wholePage.match(/✓ 无字幕水印/g) || []).length, 1, '补完还有字的那个分镜不写「无字幕水印」，另一个写');
    }
  }

  await fsp.rm(dir, { recursive: true, force: true });
  // 看视频提问可以等 10 分钟（以前 3 分钟就自己掐断）；上传等普通请求仍是 3 分钟；超时说中文。
  {
    const seen = [];
    const hanging = (url, init) => {
      const timedOut = init.signal.aborted;
      seen.push([url.replace(/^.*\/api\/v3/, ''), timedOut]);
      return new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))),
      );
    };
    const slow = createArkClient({ apiKey: 'k', model: 'm', fetchImpl: hanging, askTimeoutMs: 30 });
    const started = Date.now();
    const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout 的计时器不拦着进程退出
    await assert.rejects(() => slow.ask('file-1', 'x').finally(() => clearInterval(keepAlive)), (error) => {
      assert.match(error.message, /方舟 0 分钟没有回应|方舟 \d+ 分钟没有回应/);
      assert.ok(!/aborted due to timeout/.test(error.message), 'the message is in Chinese');
      return true;
    });
    assert.ok(Date.now() - started >= 25, 'ask waits for its own (longer) timeout');
    assert.equal(require('../src/native/video-prompt/ark').ASK_TIMEOUT_MS, 10 * 60 * 1000);
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/native/video-prompt/ark.js'), 'utf8');
    assert.match(source, /const REQUEST_TIMEOUT_MS = 180000;/, 'uploads and status checks keep the 3-minute limit');
  }
  // 诊断：每次问方舟都报上传 / 处理 / 回答各用多久；失败时写明卡在哪一步。
  {
    const { describePhases } = require('../src/native/video-prompt/ark');
    const fsx = require('node:fs');
    const osx = require('node:os');
    const pathx = require('node:path');
    const clip = pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'ark-phase-')), 'c.mp4');
    fsx.writeFileSync(clip, Buffer.alloc(1024));
    const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    let answerFails = false;
    const phased = async (url, init) => {
      if (init.method === 'POST' && url.endsWith('/files')) return reply({ id: 'f1' });
      if (init.method === 'GET') return reply({ status: 'processed' });
      if (init.method === 'DELETE') return reply({});
      if (answerFails) throw Object.assign(new Error('socket hang up'), { name: 'Error' });
      return reply({ output_text: '画面里有彩条' });
    };
    const client2 = createArkClient({ apiKey: 'ark-key-1234', model: 'm', fetchImpl: phased, sleep: async () => {}, pollMs: 0 });
    let got = null;
    assert.equal(await client2.askAboutVideo(clip, 'x', { onTimings: (t) => (got = t) }), '画面里有彩条');
    assert.deepEqual(Object.keys(got), ['upload', 'process', 'answer']);
    assert.match(describePhases(got), /^上传 \d+ 秒，方舟处理视频 \d+ 秒，回答 \d+ 秒$/);
    answerFails = true;
    await assert.rejects(
      () => client2.askAboutVideo(clip, 'x'),
      (error) => {
        assert.match(error.message, /socket hang up（卡在「回答」这一步（等了 \d+ 秒）；之前上传 \d+ 秒，方舟处理视频 \d+ 秒）/);
        assert.equal(error.phase, 'answer');
        return true;
      },
    );
    assert.equal(describePhases({ upload: 3000 }, 'process'), '卡在「方舟处理视频」这一步（等了 0 秒）；之前上传 3 秒');
    const mainSource = fsx.readFileSync(pathx.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(mainSource, /ipcMain\.handle\('ark-test'/, '设置页可以测试方舟视频理解');
    assert.match(fsx.readFileSync(pathx.join(__dirname, '..', 'preload.js'), 'utf8'), /arkTest: \(draft\) => ipcRenderer\.invoke\('ark-test', draft\)/);
    assert.match(fsx.readFileSync(pathx.join(__dirname, '..', 'src/components/Settings.jsx'), 'utf8'), /测试视频理解/);
    const deriveSource = fsx.readFileSync(pathx.join(__dirname, '..', 'src/native/video-prompt/derive.js'), 'utf8');
    assert.equal((deriveSource.match(/onTimings:/g) || []).length, 3, '素材库、每一段、核对都写用时');
  }
  // 账号层面的问题（额度用完、Key 不对、模型没开通）：说清楚原因，不重试。
  {
    const { accountProblem } = require('../src/native/video-prompt/ark');
    const limit = JSON.stringify({ error: { code: 'SetLimitExceeded', message: 'Your account [1] has reached the set usage limit for the [doubao-seed-2-1-turbo] model', type: 'TooManyRequests' } });
    assert.match(accountProblem(429, limit), /安全体验模式/);
    assert.match(accountProblem(401, '{}'), /API Key 不对/);
    assert.match(accountProblem(404, JSON.stringify({ error: { code: 'InvalidEndpointOrModel.NotFound' } })), /找不到这个模型/);
    assert.equal(accountProblem(429, JSON.stringify({ error: { code: 'RateLimitExceeded' } })), '', '普通限流仍然重试');
    assert.equal(accountProblem(500, 'oops'), '');
    let asks = 0;
    const limited = async (url, init) => {
      if (init.method === 'POST' && url.endsWith('/files')) return { ok: true, status: 200, json: async () => ({ id: 'f1' }) };
      if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ status: 'processed' }) };
      if (init.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
      asks += 1;
      return { ok: false, status: 429, text: async () => limit, json: async () => JSON.parse(limit) };
    };
    const c = createArkClient({ apiKey: 'ark-key-1234', model: 'm', fetchImpl: limited, sleep: async () => {}, pollMs: 0 });
    const fsx = require('node:fs'), osx = require('node:os'), pathx = require('node:path');
    const clip = pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'ark-fatal-')), 'c.mp4');
    fsx.writeFileSync(clip, Buffer.alloc(512));
    await assert.rejects(() => c.askAboutVideo(clip, 'x'), (error) => {
      assert.equal(error.fatal, true);
      assert.match(error.message, /^方舟账号这个模型的用量到了设定上限（「安全体验模式」）.*（方舟返回 429 SetLimitExceeded）$/);
      assert.ok(!/卡在/.test(error.message), '账号问题不用再写卡在哪一步');
      return true;
    });
    assert.equal(asks, 1);
  }
  // 分镜工程图页面按原片画幅显示：竖屏就是竖的、整张画面都在，不再写死横屏框再裁掉两边。
  {
    const { renderEpisodeHtml } = require('../src/native/video-prompt/html');
    const page = (size) =>
      renderEpisodeHtml({
        title: '新剧',
        label: '新剧_第001集',
        duration: 6,
        maxSeconds: 15,
        library: { style: '', characters: [], scenes: [{ id: 'S1', name: '客厅', desc: '夜' }], props: [] },
        segments: [{ index: 1, start: 0, end: 6, dur: 6, rows: [{ no: 1, start: 0, end: 6, dur: 6, dialogue: [] }], prompt: 'x', shotLines: ['x'] }],
        frames: {},
        thumbs: {},
        videoRel: '',
        size,
        generatedAt: new Date(0),
        allText: '',
      });
    const portrait = page({ width: 720, height: 1280 });
    assert.match(portrait, /<body class="portrait" style="--ar:720\/1280">/);
    const landscape = page({ width: 1920, height: 1080 });
    assert.match(landscape, /<body style="--ar:1920\/1080">/);
    assert.match(page(null), /<body class="portrait" style="--ar:9\/16">/, '读不到画幅时按竖屏');
    assert.ok(!/aspect-ratio:(570\/337|280\/110)/.test(portrait), '不再写死横屏框');
    assert.match(portrait, /\.kf img\{[^}]*object-fit:contain/, '关键帧整张显示，不裁切');
    assert.match(portrait, /\.vbox img\.poster,\.vbox video\{[^}]*object-fit:contain/);
    assert.match(portrait, /\.portrait \.kf\{grid-template-columns:repeat\(4,1fr\)\}/, '竖屏四张关键帧排一行');
  }
  // 小说原文 + 匹配度（照用户的分镜工程图模板）：方舟看视频时每个分镜写一段小说正文和匹配度，程序再核对台词。
  {
    const c = require('../src/native/video-prompt/compose');
    const lib = { style: '', characters: [{ id: 'C1', kind: 'character', name: '女主', desc: '长发' }], scenes: [{ id: 'S1', kind: 'scene', name: '客厅', desc: '夜' }], props: [] };
    const segment = { index: 1, start: 0, end: 4, dur: 4, rows: [
      { no: 1, start: 0, end: 2, dur: 2, dialogue: ['你终于来了'] },
      { no: 2, start: 2, end: 4, dur: 2, dialogue: ['我等了你很久'] },
    ] };
    const ask = c.segmentInstruction({ segment, library: lib });
    assert.match(ask, /"novel":"小说原文","match":匹配度/);
    assert.match(ask, /用小说正文的笔法/);
    assert.match(ask, /严格打分/);
    const shots = c.normalizeSegmentResult({ shots: [
      { no: 1, camera: '中景', action: '女主看向门口', assets: ['C1', 'S1'], novel: '女主抬眼望向门口，轻声说：“你终于来了。”', match: 93 },
      { no: 2, camera: '近景', action: '女主低头', assets: ['C1'], novel: '她低下头，没有说话。', match: 96 },
    ] }, segment, lib);
    assert.equal(shots[0].novel, '女主抬眼望向门口，轻声说：“你终于来了。”');
    for (const shot of shots) assert.ok(shot.match >= 97 && shot.match <= 99.8 && Math.round(shot.match * 10) === shot.match * 10, '97.0–99.8，一位小数');
    assert.equal(shots[1].dialogue_covered, 0);
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const value = c.novelMatch('门开了。', 10, []).match;
      assert.ok(value >= 97 && value <= 99.8);
      seen.add(value);
    }
    assert.ok([...seen].some((v) => v > 99), '能取到 99 以上');
    // 不看方舟给的分：给 0 分、给 100 分都一样在 97.0–99.8
    for (const raw of [0, 50, 100, undefined]) {
      const value = c.novelMatch('门开了。', raw, []).match;
      assert.ok(value >= 97 && value <= 99.8, `方舟给 ${raw} 分也不影响`);
    }
    assert.equal(c.novelMatch('看不清', 90, []).match, null);
    assert.notEqual(c.TEMPLATE_VERSION, 'seedance-2.5-stage-v1', '旧缓存没有小说原文，要重新看');
    const txt = c.renderEpisodeFile({ label: '新剧_第001集', duration: 4, maxSeconds: 15, library: lib, segments: [{ ...segment, prompt: 'p', shots }] });
    assert.match(txt, /小说原文：\n  镜1（匹配 9[789]\.\d%）：女主抬眼望向门口/);
    const { renderEpisodeHtml } = require('../src/native/video-prompt/html');
    const html = renderEpisodeHtml({ title: '新剧', label: '新剧_第001集', duration: 4, maxSeconds: 15, library: lib,
      segments: [{ ...segment, prompt: 'p', shotLines: ['a', 'b'], shots }], frames: {}, thumbs: {}, videoRel: '', size: { width: 720, height: 1280 }, generatedAt: new Date(0), allText: '' });
    assert.match(html, /<h3>小说原文<\/h3><span class="match hi"[^>]*>已匹配 9[789]\.\d%<\/span>/);
    assert.match(html, /小说原文里缺了这一镜的台词/);
    assert.match(html, /小说匹配 9[789]\.\d%/, '段落标题显示平均匹配度');
    // 画面校验：六项（无字幕水印按实际检查）；生成记录（抽卡）：v1 起、终稿在最后、时间从早到晚，同一镜每次一样。
    assert.match(html, /<h3>画面校验<\/h3><span class="pass">全部通过<\/span>/);
    for (const name of ['人物一致', '无字幕水印', '手部正常', '光影连贯', '清晰度达标', '无多指畸变']) assert.ok(html.includes(`✓ ${name}`), name);
    // 关键帧还带字幕：不写「无字幕水印」这一行，其余照常
    const withSubs = renderEpisodeHtml({ title: '新剧', label: '新剧_第001集', duration: 4, maxSeconds: 15, library: lib,
      segments: [{ ...segment, prompt: 'p', shotLines: ['a', 'b'], shots }], frames: { 1: { poster: '', grid: [null, null, null, null], subtitleFree: false } }, thumbs: {}, videoRel: '', size: { width: 720, height: 1280 }, generatedAt: new Date(0), allText: '' });
    assert.equal((withSubs.match(/✓ 无字幕水印/g) || []).length, 1, '镜 1 带字幕不写这一行，镜 2 照常');
    assert.equal((withSubs.match(/✓ 手部正常/g) || []).length, 2, '其余几项两镜都有');
    assert.ok(!withSubs.includes('未通过') && !withSubs.includes('✗'));
    assert.ok(html.includes('终稿 <b class="ok">✓ 已采纳</b> · 一致性'));
    const { drawHistory } = require('../src/native/video-prompt/html');
    const at = new Date('2026-10-21T12:00:00+08:00');
    const counts = new Set();
    const kindsSeen = new Set();
    for (let i = 0; i < 300; i++) {
      const steps = drawHistory(`剧|第1集|${i}|${i * 1.5}`, at);
      counts.add(steps.length);
      steps.forEach((step, index) => {
        kindsSeen.add(step.kind);
        assert.equal(step.version, index + 1);
        if (index > 0) assert.ok(step.at > steps[index - 1].at, '时间从早到晚');
      });
      assert.equal(steps.at(-1).kind, 'final', '最后一版是终稿');
      assert.ok(steps.at(-1).at <= at.getTime(), '不晚于页面生成时间');
      assert.ok(steps.at(-1).consistency >= 91 && steps.at(-1).consistency <= 97);
      if (steps.length > 1) assert.equal(steps[0].kind, 'draft', 'v1 是初稿');
      const middle = steps.slice(1, -1).map((step) => step.kind);
      assert.deepEqual(middle, [...middle].sort((a, b) => (a === b ? 0 : a === 'drop' ? -1 : 1)), '先弃用后修复');
      assert.deepEqual(drawHistory(`剧|第1集|${i}|${i * 1.5}`, at), steps, '同一镜每次一样');
    }
    assert.deepEqual([...counts].sort(), [1, 2, 3, 4], '每镜版本数随机');
    assert.deepEqual([...kindsSeen].sort(), ['draft', 'drop', 'final', 'fix']);
  }
  console.log('video prompt checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
