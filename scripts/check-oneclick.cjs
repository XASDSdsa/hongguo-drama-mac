'use strict';
// 一键处理：用假的去重引擎和假的 AI 接口，验证目录、跳过/覆盖、停止、失败隔离和海报。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createOneclick, scanVideos, DEFAULT_POSTER_PROMPT } = require('../src/native/oneclick');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-oneclick-'));
let serial = 0;
const wait = async (read, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout');
};
function fixture({ names = ['剧 1.mp4', '剧 2.mp4', '剧 10.mp4'], runJob, editImage } = {}) {
  const dir = path.join(root, String(++serial));
  const input = path.join(dir, 'in');
  const output = path.join(dir, 'out');
  fs.mkdirSync(input, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(input, name), 'source:' + name);
  const events = [];
  const calls = { dedup: [], image: [] };
  const quchong = {
    validateOptions: (value) => ({ resolution: '1080x1920', ...value }),
    runJob:
      runJob ||
      (async (options) => {
        calls.dedup.push(options);
        fs.writeFileSync(options.dst, 'deduped:' + path.basename(options.src));
        options.onProgress?.(100);
        return { path: options.dst };
      }),
  };
  const openai = {
    editImage:
      editImage ||
      (async (options) => {
        calls.image.push(options);
        return { buffer: Buffer.from('png'), contentType: 'image/png' };
      }),
  };
  const app = createOneclick({
    quchong,
    openai,
    resolveFfmpeg: (name) => name,
    getSettings: () => ({ ai_image_size: '1024x1536', ai_image_quality: 'high' }),
    send: (channel, payload) => events.push({ channel, payload }),
  });
  const finished = () => {
    const status = app.status().status;
    return !['running', 'stopping'].includes(status) && status !== 'idle' ? app.status() : null;
  };
  return { dir, input, output, app, events, calls, finished };
}
async function check(name, run) {
  await run();
  console.log('PASS ' + name);
}

(async () => {
  await check('scan lists top-level videos in episode order and skips hidden, dedup outputs and other files', () => {
    const f = fixture({
      names: ['剧 10.mp4', '剧 2.mp4', '剧 1.mp4', '.hidden.mp4', '剧 1_去重.mp4', 'notes.txt', '剧 3.MOV'],
    });
    fs.mkdirSync(path.join(f.input, 'sub'));
    fs.writeFileSync(path.join(f.input, 'sub', '剧 99.mp4'), 'x');
    assert.deepEqual(
      scanVideos(f.input).map((item) => item.name),
      ['剧 1.mp4', '剧 2.mp4', '剧 3.MOV', '剧 10.mp4'],
    );
    assert.equal(f.app.scan(f.input).files.length, 4);
    assert.equal(f.app.scan('').success, false);
  });

  await check('start rejects missing input, output, tasks and empty folders', () => {
    const f = fixture();
    assert.match(f.app.start({ outputDir: f.output }).error, /输入目录/);
    assert.match(f.app.start({ inputDir: f.input }).error, /输出目录/);
    assert.match(f.app.start({ inputDir: path.join(f.dir, 'nope'), outputDir: f.output }).error, /找不到输入目录/);
    assert.match(f.app.start({ inputDir: f.input, outputDir: f.output, dedup: false }).error, /至少勾选一项/);
    const empty = fixture({ names: [] });
    assert.match(empty.app.start({ inputDir: empty.input, outputDir: empty.output }).error, /没有视频文件/);
    assert.equal(fs.existsSync(f.output), false, 'rejected starts must not create the output folder');
  });

  await check('dedup writes <name>_去重.mp4 only into the output folder and never touches sources', async () => {
    const f = fixture();
    const result = f.app.start({ inputDir: f.input, outputDir: f.output, jobs: 2 });
    assert.equal(result.success, true, result.error);
    const state = await wait(f.finished);
    assert.equal(state.status, 'completed');
    assert.deepEqual(fs.readdirSync(f.output).sort(), ['剧 10_去重.mp4', '剧 1_去重.mp4', '剧 2_去重.mp4']);
    for (const name of ['剧 1.mp4', '剧 2.mp4', '剧 10.mp4'])
      assert.equal(fs.readFileSync(path.join(f.input, name), 'utf8'), 'source:' + name);
    assert.deepEqual(fs.readdirSync(f.input).sort(), ['剧 1.mp4', '剧 10.mp4', '剧 2.mp4']);
    assert.equal(state.completed, 3);
    assert.equal(state.progress, 100);
    assert.ok(state.logs.main.some((line) => line.includes('主任务结束')));
    assert.equal(f.events.at(-1).channel, 'oneclick-update');
  });

  await check(
    'existing outputs are skipped unless overwrite is checked, and a failed overwrite restores the old file',
    async () => {
      const f = fixture({ names: ['剧 1.mp4'] });
      fs.mkdirSync(f.output);
      const existing = path.join(f.output, '剧 1_去重.mp4');
      fs.writeFileSync(existing, 'old');
      f.app.start({ inputDir: f.input, outputDir: f.output });
      let state = await wait(f.finished);
      assert.equal(state.skipped, 1);
      assert.equal(f.calls.dedup.length, 0);
      assert.equal(fs.readFileSync(existing, 'utf8'), 'old');

      const failing = fixture({
        names: ['剧 1.mp4'],
        runJob: async () => {
          throw new Error('编码失败');
        },
      });
      fs.mkdirSync(failing.output);
      const kept = path.join(failing.output, '剧 1_去重.mp4');
      fs.writeFileSync(kept, 'old');
      failing.app.start({ inputDir: failing.input, outputDir: failing.output, overwrite: true });
      state = await wait(failing.finished);
      assert.equal(state.failed, 1);
      assert.equal(state.status, 'partial');
      assert.equal(fs.readFileSync(kept, 'utf8'), 'old', 'old output must survive a failed overwrite');
      assert.deepEqual(fs.readdirSync(failing.output), ['剧 1_去重.mp4']);

      f.app.start({ inputDir: f.input, outputDir: f.output, overwrite: true });
      state = await wait(() => f.app.status().status === 'completed' && f.app.status());
      assert.equal(fs.readFileSync(existing, 'utf8'), 'deduped:剧 1.mp4');
      assert.deepEqual(fs.readdirSync(f.output), ['剧 1_去重.mp4'], 'backup of the old output must be removed');
    },
  );

  await check('one failing video does not stop the others', async () => {
    const f = fixture({
      runJob: async (options) => {
        if (options.src.endsWith('剧 2.mp4')) throw new Error('坏文件');
        fs.writeFileSync(options.dst, 'ok');
        return { path: options.dst };
      },
    });
    f.app.start({ inputDir: f.input, outputDir: f.output, jobs: 1 });
    const state = await wait(f.finished);
    assert.equal(state.status, 'partial');
    assert.deepEqual([state.completed, state.failed], [2, 1]);
    assert.match(state.files.find((item) => item.name === '剧 2.mp4').error, /坏文件/);
  });

  await check('stop aborts running jobs and marks the rest stopped', async () => {
    let started = 0;
    const f = fixture({
      runJob: (options) =>
        new Promise((resolve, reject) => {
          started++;
          options.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
        }),
    });
    f.app.start({ inputDir: f.input, outputDir: f.output, jobs: 2 });
    await wait(() => started === 2);
    assert.equal(f.app.stop().success, true);
    const state = await wait(f.finished);
    assert.equal(state.status, 'stopped');
    assert.equal(started, 2, 'queued videos must not start after stop');
    assert.ok(state.files.every((item) => item.status === 'stopped'));
    assert.equal(
      f.app.start({ inputDir: f.input, outputDir: f.output }).success,
      true,
      'a new run may start afterwards',
    );
    f.app.stop();
  });

  await check(
    'poster uses the title in the preset prompt, the chosen image, and saves beside the results',
    async () => {
      const f = fixture({ names: ['剧 1.mp4'] });
      const image = path.join(f.dir, 'ref.png');
      fs.writeFileSync(image, 'ref');
      f.app.start({
        inputDir: f.input,
        outputDir: f.output,
        title: '夺产背债',
        poster: { enabled: true, sourceImage: image },
      });
      const state = await wait(f.finished);
      assert.equal(state.status, 'completed');
      assert.equal(state.poster.status, 'completed');
      assert.equal(f.calls.image.length, 1);
      assert.equal(f.calls.image[0].image, image);
      assert.equal(f.calls.image[0].size, '1024x1536');
      assert.ok(f.calls.image[0].prompt.includes('《夺产背债》'));
      assert.ok(!f.calls.image[0].prompt.includes('{标题}'));
      assert.deepEqual(fs.readdirSync(f.output).sort(), ['剧 1_去重.mp4', '夺产背债-海报.png']);
      assert.ok(DEFAULT_POSTER_PROMPT.includes('{标题}'));
    },
  );

  await check(
    'poster failure is reported but does not undo dedup; existing poster is skipped without overwrite',
    async () => {
      const failing = fixture({
        names: ['剧 1.mp4'],
        editImage: async () => {
          throw new Error('接口未配置');
        },
      });
      const image = path.join(failing.dir, 'ref.png');
      fs.writeFileSync(image, 'ref');
      failing.app.start({
        inputDir: failing.input,
        outputDir: failing.output,
        poster: { enabled: true, sourceImage: image },
      });
      let state = await wait(failing.finished);
      assert.equal(state.status, 'partial');
      assert.equal(state.poster.status, 'failed');
      assert.match(state.poster.message, /接口未配置/);
      assert.equal(state.completed, 1);
      assert.ok(state.logs.branch.some((line) => line.includes('接口未配置')));

      const f = fixture({ names: ['剧 1.mp4'] });
      fs.mkdirSync(f.output);
      fs.writeFileSync(path.join(f.output, '剧-海报.jpg'), 'old poster');
      f.app.start({
        inputDir: f.input,
        outputDir: f.output,
        title: '剧',
        dedup: false,
        poster: { enabled: true, sourceImage: image },
      });
      state = await wait(f.finished);
      assert.equal(state.poster.status, 'skipped');
      assert.equal(f.calls.image.length, 0);
    },
  );

  const ffmpeg = spawnSync('ffmpeg', ['-version']);
  if (ffmpeg.status === 0) {
    await check('poster-only run grabs a frame from the first episode as the source image', async () => {
      const f = fixture({ names: [] });
      const video = path.join(f.input, '剧 1.mp4');
      const made = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x90:rate=10:duration=3',
        video,
      ]);
      assert.equal(made.status, 0, String(made.stderr));
      f.app.start({ inputDir: f.input, outputDir: f.output, title: 'T', dedup: false, poster: { enabled: true } });
      const state = await wait(f.finished);
      assert.equal(state.status, 'completed', JSON.stringify(state.poster));
      assert.equal(path.basename(f.calls.image[0].image), 'frame.png');
      assert.deepEqual(fs.readdirSync(f.output), ['T-海报.png']);
      assert.equal(fs.existsSync(f.calls.image[0].image), false, 'temporary frame must be cleaned up');
    });
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
