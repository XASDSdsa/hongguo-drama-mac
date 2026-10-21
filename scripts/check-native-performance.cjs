const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/native/hongguo.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const page = '{"vid_list":["11","12"],"series_name":"测试剧","main_url":"https://media.example/video.mp4"}';

function fixture({ web = true, api = false, app = false, blockedVids = [], html = page } = {}) {
  let now = 0;
  const state = { web, api, app, get: 0, post: 0, appCalls: 0, waits: 0 };
  const axios = {
    async get(url) {
      state.get++;
      if (!state.web || blockedVids.some((vid) => url.endsWith(`/${vid}`))) throw new Error('web unavailable');
      return { data: html };
    },
    async post(url, body) {
      state.post++;
      if (!state.api) return { status: 200, headers: {}, data: Buffer.alloc(0) };
      const data = url.includes('multi_video_detail')
        ? { 1: { video_data: { series_title: '测试剧', video_list: [{ vid: '11', vid_index: 1 }] } } }
        : {
            [body.mixed_video_id_map['1004'][0]]: {
              video_model: JSON.stringify({
                video_list: [
                  { main_url: 'https://media.example/encrypted.mp4', encrypt_info: { spade_a: 'test-key' } },
                ],
              }),
            },
          };
      return { status: 200, headers: {}, data: Buffer.from(JSON.stringify({ code: 0, data })) };
    },
  };
  const context = {
    module: { exports: {} },
    Buffer,
    process: { env: {} },
    require: (name) =>
      name === 'axios'
        ? axios
        : name === './app-source'
          ? {
              fetchAppPlayUrl: async () => {
                state.appCalls++;
                if (!state.app) throw Error('app unavailable');
                return { url: 'https://media.example/app.mp4', contentKey: '01'.repeat(16), source: 'app' };
              },
            }
          : name === './synopsis'
            ? require('../src/native/synopsis')
            : require(name),
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout: (fn) => {
      state.waits++;
      fn();
    },
    console: { warn() {}, log() {} },
  };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return {
    native: context.module.exports,
    state,
    advance: (ms) => {
      now += ms;
    },
  };
}

const checks = [
  [
    '下载只取 App 的 1080p（不下官网 360p）；在线播放仍先用官网直链',
    async () => {
      const both = fixture({ web: true, app: true });
      const download = await both.native.fetchPlayUrlSingle('11', '1', { best: true });
      assert.equal(download.source, 'app', '下载先走 App（1080p）');
      assert.equal(download.url, 'https://media.example/app.mp4');
      const play = await both.native.fetchPlayUrlSingle('11', '1');
      assert.equal(play.source, 'web', '在线播放仍先走官网直链（不用等整集下载解密）');
      // App 取不到：不退回官网 360p，报错说清楚原因。
      const noApp = fixture({ web: true, app: false });
      const refused = await noApp.native.fetchPlayUrlSingle('11', '1', { best: true });
      assert.equal(refused.url, null, '不下载官网 360p');
      assert.match(refused.error, /1080p.*360p/);
      assert.equal(noApp.state.appCalls, 1);
      // 旧接口返回的流说不出清晰度（可能是 360p）：也不用。
      const legacy = fixture({ web: true, app: false, api: true });
      assert.equal((await legacy.native.fetchPlayUrlSingle('11', '1', { best: true })).url, null);
    },
  ],
  [
    'App 源补齐网页缺失分集并复用短缓存',
    async () => {
      const { native, state } = fixture({ web: false, app: true });
      const result = await native.fetchPlayUrlSingle('12', '1');
      assert.equal(result.source, 'app');
      assert.equal(result.contentKey.length, 32);
      await native.fetchPlayUrlSingle('12', '1');
      assert.equal(state.appCalls, 1);
      assert.equal(state.post, 0, 'App 新接口可用时不调用旧接口');
    },
  ],
  [
    '分集网页优先、并发合并、短期复用',
    async () => {
      const { native, state } = fixture();
      const results = await Promise.all([native.fetchEpisodeList('1'), native.fetchEpisodeList('1')]);
      assert.equal(results[0].total, 2);
      await native.fetchEpisodeList('1');
      assert.equal(state.post, 0, '有效网页不应等待 API');
      assert.equal(state.get, 1, '相同分集只取一次');
    },
  ],
  [
    '播放地址网页优先、并发合并、短期复用',
    async () => {
      const { native, state } = fixture();
      const results = await Promise.all([native.fetchPlayUrlSingle('11', '1'), native.fetchPlayUrlSingle('11', '1')]);
      assert.equal(results[0].source, 'web');
      await native.fetchPlayUrlSingle('11', '1');
      assert.equal(state.post, 0, '有效网页不应等待 API');
      assert.equal(state.get, 1, '相同播放地址只取一次');
    },
  ],
  [
    '分集 60 秒、播放地址 30 秒到期刷新',
    async () => {
      const { native, state, advance } = fixture();
      await native.fetchEpisodeList('1');
      await native.fetchPlayUrlSingle('11', '1');
      advance(29999);
      await native.fetchEpisodeList('1');
      await native.fetchPlayUrlSingle('11', '1');
      assert.equal(state.get, 2, '未到期不重复访问');
      advance(2);
      await native.fetchPlayUrlSingle('11', '1');
      assert.equal(state.get, 3, '播放地址到期后刷新');
      advance(30000);
      await native.fetchEpisodeList('1');
      assert.equal(state.get, 4, '分集到期后刷新');
    },
  ],
  [
    '空响应不退避重试，失败不缓存',
    async () => {
      const { native, state } = fixture({ web: false });
      await assert.rejects(native.fetchEpisodeList('1'));
      assert.equal((await native.fetchPlayUrlSingle('11', '1')).url, null);
      assert.equal(state.post, 2, '每个失败链路只访问一次空响应 API');
      assert.equal(state.waits, 0, '空响应不进入重试等待');
      state.web = true;
      assert.equal((await native.fetchEpisodeList('1')).total, 2);
      assert.equal((await native.fetchPlayUrlSingle('11', '1')).source, 'web');
    },
  ],
  [
    '网页失败仍可回退分集 API 和加密播放源',
    async () => {
      const { native, state } = fixture({ web: false, api: true });
      assert.equal((await native.fetchEpisodeList('1')).total, 1);
      const play = await native.fetchPlayUrlSingle('11', '1');
      assert.equal(play.source, 'api');
      assert.equal(play.spadeA, 'test-key');
      assert.ok(state.get > 0, '优先尝试网页源');
      assert.equal(state.post, 2);
    },
  ],
  [
    '网页可用范围与后续集数错误，仍保留 API 回退',
    async () => {
      const { native, state } = fixture({
        html: page.replace('"vid_list"', '"accessible_episode_cnt":1,"vid_list"'),
        blockedVids: ['11', '12'],
      });
      const unavailable = await native.fetchPlayUrlSingle('12', '1');
      const list = await native.fetchEpisodeList('1');
      assert.equal(list.web_accessible_episodes, 1);
      assert.equal(list.episodes[0].web_available, true);
      assert.equal(list.episodes[1].web_available, false);
      assert.equal(unavailable.url, null);
      assert.match(unavailable.error, /前 1 集.*第 2 集/);
      assert.doesNotMatch(unavailable.error, /付费|会员/);
      state.api = true;
      const restored = await native.fetchPlayUrlSingle('12', '1');
      assert.equal(restored.source, 'api');
      assert.equal(restored.spadeA, 'test-key');
    },
  ],
];

(async () => {
  let failed = 0;
  const selected = process.argv.includes('--app')
    ? checks.filter(([name]) => name.startsWith('App '))
    : process.argv.includes('--availability')
      ? checks.filter(([name]) => name.startsWith('网页可用范围'))
      : checks;
  for (const [name, run] of selected) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  console.log(`${selected.length - failed}/${selected.length} checks passed`);
  if (!failed && process.argv.includes('--live')) {
    const native = require(sourcePath);
    for (const [name, load] of [
      ['episodes', () => native.fetchEpisodeList('7687919221593885758')],
      ['play', () => native.fetchPlayUrlSingle('7687921187195735102', '7687919221593885758')],
    ]) {
      const start = performance.now();
      const result = await load();
      const firstMs = Math.round(performance.now() - start);
      const cachedStart = performance.now();
      await load();
      console.log(
        JSON.stringify({
          name,
          source: result.source,
          total: result.total,
          hasUrl: !!result.url,
          firstMs,
          cachedMs: Math.round(performance.now() - cachedStart),
        }),
      );
    }
  }
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
