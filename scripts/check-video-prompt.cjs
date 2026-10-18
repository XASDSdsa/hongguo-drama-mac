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
  const shot = (no, extra = {}) => ({ no, camera: '中景，缓慢推近', action: `林夏站在路口${no}`, expression: '', sound: '雨声', music: '无', assets: ['C1', 'S1'], end_state: `林夏站在路口${no}`, ...extra });
  const mockFetch = async (url, init = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    assert.equal(init.headers.Authorization, 'Bearer ark-secret');
    if (url.endsWith('/files') && init.method === 'POST') {
      calls.upload += 1;
      calls.uploadForm = init.body;
      calls.uploadedSizes.push(init.body.get('file').size);
      assert.equal(init.body.get('purpose'), 'user_data');
      assert.equal(init.body.get('preprocess_configs[video][fps]'), '5');
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
  assert.deepEqual(listing, ['第3集-参考图', '第3集.txt']);
  assert.ok(!text.includes('ark-secret'));

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

  // 没填模型名：直接说清楚
  await assert.rejects(() => createArkClient({ apiKey: 'k', fetchImpl: mockFetch }).ask('file-1', 'x'), /没有填视频理解模型名/);

  // ---- 接线：做剪映草稿时才反推，设置和界面都有对应入口 ----
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /prompts: draft\.prompts === true/, '草稿支线任务带上 prompts 开关');
  assert.match(main, /if \(item\.prompts\) await deriveLibraryPrompts\(job, file, item, structure\)/, '拆解完成后才反推');
  assert.match(main, /withPrompts \? videoPromptProblem\(\) : ''/, '没填方舟 Key 或模型名就不开始');
  assert.match(main, /path\.join\(job\.dir, '视频提示词'\)/, '成果放在剧文件夹的「视频提示词」里');
  assert.match(main, /ark_video_model: ''/, '模型名没有默认值');
  assert.match(main, /job\.controller\?\.abort\(\)/, '停止草稿时也中断提示词请求');
  const detail = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SeriesDetail.jsx'), 'utf8');
  assert.match(detail, /prompts: draftPrompts/);
  assert.match(detail, /同时反推 Seedance 2\.5 提示词/);
  const settingsUi = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Settings.jsx'), 'utf8');
  for (const key of ['ark_base_url', 'ark_api_key', 'ark_video_model', 'video_prompt_max_seconds']) assert.ok(settingsUi.includes(`'${key}'`), `设置页要保存 ${key}`);

  await fsp.rm(dir, { recursive: true, force: true });
  console.log('video prompt checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
