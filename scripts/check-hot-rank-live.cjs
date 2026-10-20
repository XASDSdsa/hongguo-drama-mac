// 打包时联网读一次红果官网的四个热度榜，用软件里同一套解析代码，必须读出完整的榜单。
// 官网改了页面写法时这里会失败（打包前就知道热度榜坏了）；只是网络暂时连不上时只提示、不拦打包。
const assert = require('node:assert/strict');
const axios = require('axios');
const catalog = require('../src/native/catalog');

const SITE = 'https://hongguoduanju.com';

async function fetchPage(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.get(url, { timeout: 20000, responseType: 'text', maxContentLength: 8 * 1024 * 1024 });
      return String(response.data);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

(async () => {
  const pages = [
    ...catalog.RANKS.map((rank) => ({ rank, page: 1, url: `${SITE}/rank/${rank.path}` })),
    { rank: catalog.RANKS[0], page: 2, url: `${SITE}/rank/${catalog.RANKS[0].path}?page=2` },
  ];
  for (const { rank, page, url } of pages) {
    let html;
    try {
      html = await fetchPage(url);
    } catch (error) {
      console.log(`WARN 连不上红果官网，跳过热度榜联网检查：${url} ${error.message}`);
      return;
    }
    const result = catalog.parseRank(html, rank, page, url);
    assert.equal(result.success, true, url);
    assert.ok(result.results.length >= 10, `${url}: only ${result.results.length} items`);
    assert.ok(result.totalPages >= page, `${url}: page count ${result.totalPages}`);
    for (const item of result.results) {
      assert.match(item.series_id, /^\d{6,}$/, `${url}: series id`);
      assert.ok(item.series_title, `${url}: title`);
      assert.ok(item.rank > 0, `${url}: rank`);
    }
    assert.ok(
      result.results.filter((item) => /热度/.test(item.heat)).length >= result.results.length / 2,
      `${url}: heat`,
    );
    assert.ok(result.results.filter((item) => item.episode_count > 0).length >= result.results.length / 2, `${url}: episodes`);
    const first = result.results[0];
    console.log(
      `PASS ${rank.label}${page > 1 ? ` 第${page}页` : ''}: ${result.results.length} 部，共 ${result.totalPages} 页；第 ${first.rank} 名 ${first.series_title} ${first.heat} ${first.episode_count} 集`,
    );
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
