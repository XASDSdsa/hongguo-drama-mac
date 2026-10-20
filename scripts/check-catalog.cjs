const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const file = path.join(root, 'src/native/catalog.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const html = (category = 'real-drama', page = 1, list) =>
  `<script>_ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      category_$: {
        isSuccess: true,
        categoryRoute: { contentType: category },
        seo: { title: '目录 } ; 测试' },
        recommendList: list || [
          {
            series_id: '1234567890123456789',
            series_name: '示例剧',
            series_cover: 'https://example.com/cover.jpg',
            episode_cnt: 77,
            tags: ['爱情'],
          },
        ],
        pagination: { pageNum: page, total: 800, totalPages: 34 },
        selectorList: [{ items: [{ selector_item_id: 'romance', show_name: '爱情' }] }],
      },
    },
  })};function runWindowFn(){throw Error('must not execute remote scripts')}</script>`;

async function main() {
  if (!fs.existsSync(file)) {
    // Exercise the old real queue, with comic navigation stalled and real-drama ready.
    const code = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const context = {
      console: { log() {}, warn() {} },
      searchWindowReady: null,
      SEARCH_TIMEOUT_MS: 1,
      SEARCH_SITE: 'https://hongguoduanju.com',
      SEARCH_UA: '',
      SNIFFER_JS: 'cards',
      BROWSE_META_JS: 'meta',
      setTimeout,
      getSearchWindow: () => ({
        loadURL: (url) => (url.endsWith('/comic') ? new Promise(() => {}) : Promise.resolve()),
        webContents: {
          executeJavaScript: async (script) =>
            script === 'cards' ? '[{"series_id":"1234567","series_title":"真人"}]' : '{}',
        },
      }),
    };
    vm.createContext(context);
    vm.runInContext(
      code.slice(code.indexOf('async function runSniffOnUrl('), code.indexOf('async function runSearchSniff(')),
      context,
    );
    context.runSniffOnUrl('https://hongguoduanju.com/category/comic', 'Browse');
    const outcome = await Promise.race([
      context.runSniffOnUrl('https://hongguoduanju.com/category/real-drama', 'Browse'),
      delay(80).then(() => 'blocked'),
    ]);
    assert.notEqual(outcome, 'blocked', '漫画导航未完成时，真人剧被共享串行队列阻塞');
    return;
  }

  const calls = [];
  const slow = deferred();
  let response = (url) =>
    url.endsWith('/ai-drama')
      ? slow.promise
      : Promise.resolve({ data: html('real-drama', url.includes('page=2') ? 2 : 1) });
  const context = {
    module: { exports: {} },
    require: (name) =>
      name === 'axios'
        ? {
            get: (url, options) => {
              calls.push({ url, options });
              return response(url);
            },
          }
        : require(name),
    AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 10000 ? 40 : ms),
    clearTimeout,
    URL,
    console,
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const { browseList } = context.module.exports;
  const slowAi = browseList({ category: 'ai-drama' });
  const realDrama = { category: 'real-drama' };
  const [real, same] = await Promise.race([
    Promise.all([browseList(realDrama), browseList(realDrama)]),
    delay(100).then(() => {
      throw Error('真人剧被 AI 剧请求阻塞');
    }),
  ]);
  assert.equal(real.success, true);
  assert.equal(real.results[0].series_id, '1234567890123456789');
  assert.equal(real.results[0].episode_count, 77);
  assert.equal(real.genres[0].slug, 'romance');
  assert.equal(real.pageTitle, '目录 } ; 测试');
  assert.equal(real.totalPages, 34);
  assert.equal(calls.length, 2, '相同目录并发请求应合并');
  assert.deepEqual(real, same);
  slow.resolve({ data: html('ai-drama') });
  assert.equal((await slowAi).results.length, 1);
  await browseList(realDrama);
  assert.equal(calls.length, 2, '再次访问应使用短缓存');
  await browseList({ ...realDrama, forceRefresh: true });
  assert.equal(calls.length, 3, '手动刷新必须跳过缓存');
  const filtered = await browseList({ ...realDrama, genre: 'romance', page: 2 });
  assert.equal(calls.at(-1).url, 'https://hongguoduanju.com/category/real-drama/romance?page=2');
  assert.equal(filtered.page, 2);
  assert.equal(calls[0].options.timeout, 10000);
  assert(calls[0].options.signal, '请求超时必须同时取消网络请求');
  response = async () => ({ data: '<html>blocked</html>' });
  const malformed = await browseList({ ...realDrama, forceRefresh: true });
  assert.equal(malformed.success, false, '目录结构缺失不能假装成功空态');
  response = () => new Promise(() => {});
  const timeout = await browseList({ category: 'ai-drama', forceRefresh: true });
  assert.equal(timeout.success, false);
  assert.match(timeout.error, /超时/);
  assert.equal(calls.at(-1).options.signal.aborted, true);
  response = async () => ({ data: html('comic-drama') });
  const animation = await browseList({ category: 'comic-drama' });
  assert.equal(animation.results.length, 1, '漫剧是视频，不能误判为图片漫画');
  const invalid = await browseList({ category: '../../outside' });
  assert.equal(invalid.success, false);
  assert.equal((await browseList({ category: 'comic' })).success, false, '图文漫画分类已经去掉');

  // 热度榜：数据在脚本标签的 data-fn-args 里。第 1 页是 JSON 文本里再套 JSON，后面的页直接给对象（单引号属性）。
  const rankItem = (rank, id) => ({
    id,
    seriesId: id,
    rank,
    title: `榜单剧${rank}`,
    cover: 'https://example.com/c.jpg',
    heatText: `${9000 - rank}万热度`,
    statusTags: rank === 1 ? ['新剧'] : [],
    scoreText: '评分9.1',
    tags: ['逆袭', '玄幻'],
    episodeVids: Array.from({ length: 80 + rank }, (_, i) => String(i)),
  });
  const esc = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const router = `<script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: { 'rank_hot-drama/page': { updatedText: '10月20日已更新 · 基于红果内观看/互动等综合热度排序', content: {} } },
  })}</script>`;
  const firstPage = (list) =>
    `${router}<script async data-fn-name="mergeLoaderData" data-fn-args="${esc(
      JSON.stringify([
        'rank_hot-drama/page',
        [{ key: 'content', routerDataFnName: 'p', routerDataFnArgs: [JSON.stringify({ isSuccess: true, rankList: list, pagination: { pageNum: 1, totalPages: 5 } })] }],
      ]),
    )}"></script><script>function runWindowFn(){throw Error('must not execute remote scripts')}</script>`;
  const laterPage = (list, page) =>
    `${router}<script async data-fn-name="mergeLoaderData" data-fn-args="${esc(
      JSON.stringify(['rank_hot-drama/page', [{ key: 'content', routerDataFnName: 's', routerDataFnArgs: ['"rank_hot-drama\\u002Fpage"', '"content"'] }]]),
    )}"></script><script async data-fn-name="r" data-fn-args='${esc(
      JSON.stringify(['rank_hot-drama/page', 'content', { isSuccess: true, rankList: list, pagination: { pageNum: page, totalPages: 5 } }]),
    )}'></script>`;
  response = async (url) => ({
    data: url.includes('page=2')
      ? laterPage([rankItem(21, '7000000000000000021'), rankItem(22, '7000000000000000022')], 2)
      : url.includes('page=9')
        ? router
        : firstPage([rankItem(1, '7000000000000000001'), rankItem(2, '7000000000000000002'), rankItem(2, '7000000000000000002'), { title: '坏数据' }]),
  });
  const plain = (value) => JSON.parse(JSON.stringify(value)); // 结果来自 vm 沙箱，换成本地对象再比较
  const hot = plain(await browseList({}));
  assert.equal(calls.at(-1).url, 'https://hongguoduanju.com/rank/hot-drama', '默认打开的是热度榜总榜');
  assert.equal(hot.success, true);
  assert.deepEqual(
    hot.results.map((item) => [item.rank, item.series_id, item.heat, item.episode_count, item.score]),
    [
      [1, '7000000000000000001', '8999万热度', 81, '9.1'],
      [2, '7000000000000000002', '8998万热度', 82, '9.1'],
    ],
    '重复和坏数据被去掉，集数来自分集列表',
  );
  assert.deepEqual(hot.results[0].status_tags, ['新剧']);
  assert.equal(hot.results[0].url, 'https://hongguoduanju.com/detail?series_id=7000000000000000001');
  assert.equal(hot.totalPages, 5);
  assert.equal(hot.genreAllLabel, '总榜');
  assert.deepEqual(
    hot.genres.map((g) => g.slug),
    ['real-drama', 'ai-drama', 'comic-drama'],
  );
  assert.match(hot.notice, /已更新/);
  const second = plain(await browseList({ category: 'hot-rank', page: 2 }));
  assert.equal(calls.at(-1).url, 'https://hongguoduanju.com/rank/hot-drama?page=2');
  assert.deepEqual(
    second.results.map((item) => item.rank),
    [21, 22],
    '后面几页的另一种写法也能读',
  );
  await browseList({ category: 'hot-rank', genre: 'real-drama' });
  assert.equal(calls.at(-1).url, 'https://hongguoduanju.com/rank/hot-real-drama');
  await browseList({ category: 'hot-rank', genre: 'comic-drama' });
  assert.equal(calls.at(-1).url, 'https://hongguoduanju.com/rank/hot-comic-drama');
  const beyond = await browseList({ category: 'hot-rank', page: 9 });
  assert.equal(beyond.success, true);
  assert.equal(beyond.results.length, 0);
  assert.match(beyond.emptyMessage, /没有这么多页/);
  assert.equal((await browseList({ category: 'hot-rank', genre: 'romance' })).success, false, '没有这个榜单');
  response = async () => ({ data: '<html>blocked</html>' });
  const blockedRank = await browseList({ category: 'hot-rank', forceRefresh: true });
  assert.equal(blockedRank.success, false, '榜单结构缺失不能假装成功空态');
  console.log(
    'PASS catalog: hot rank (both page encodings, pages, sub-lists), category isolation, SSR parsing, dedup/cache/refresh, filters/pagination, bounded timeout and invalid data',
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
