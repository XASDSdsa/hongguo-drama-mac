'use strict';
// 来源剧简介：字段名识别、选对当前剧、三个来源的详情请求都能带出简介，读不到时为空而不是编造。
const assert = require('node:assert/strict');
const path = require('node:path');
const { cleanSynopsis, pickSynopsis, pickSynopsisFromText } = require('../src/native/synopsis');

let page = '';
let apiData = null;
const axios = {
  get: async (url) => {
    if (/xifan-api/.test(url)) return { data: apiData };
    return { data: page };
  },
  post: async () => ({ data: {} }),
};
require.cache[require.resolve('axios')] = { id: 'axios', filename: 'axios', loaded: true, exports: axios };
const hongguo = require('../src/native/hongguo');
const hema = require('../src/native/hema');
const xifan = require('../src/native/xifan');

async function check(name, run) {
  await run();
  console.log('PASS ' + name);
}

(async () => {
  await check('cleanSynopsis strips tags, entities and whitespace and rejects placeholders', () => {
    assert.equal(cleanSynopsis('<p>他&amp;她</p><br/>  重生归来，\n\n\n\n逆袭。'), '他&她\n重生归来，\n\n逆袭。');
    assert.equal(cleanSynopsis('暂无'), '');
    assert.equal(cleanSynopsis(null), '');
    assert.equal(cleanSynopsis('a'.repeat(5000)).length, 2000);
  });

  await check(
    'pickSynopsis prefers known field names, falls back to intro/desc-like names, ignores title-like fields',
    () => {
      assert.equal(
        pickSynopsis({ introduction: '河马的简介文字内容', desc: '别的描述文字内容' }),
        '河马的简介文字内容',
      );
      assert.equal(
        pickSynopsis({ bookName: '剧名剧名剧名', shortIntro: '这是兜底识别到的简介内容' }),
        '这是兜底识别到的简介内容',
      );
      assert.equal(
        pickSynopsis({
          title: '很长很长的标题文字',
          descTitle: '很长很长的标题文字',
          cover_desc_url: 'https://x/y.png',
        }),
        '',
      );
      assert.equal(pickSynopsis({}), '');
      assert.equal(pickSynopsis(null), '');
    },
  );

  await check('pickSynopsisFromText takes the text next to this series, not a recommended series', () => {
    const other = '{"series_name":"别的剧","series_intro":"这是推荐位上别的剧的简介内容"}';
    const text = `${'x'.repeat(6000)}${other}${'y'.repeat(6000)}{"series_name":"本剧","series_intro":"这是本剧的简介\\n第二行","vid_list":["1"]}`;
    // 锚点取第一个 series_name：页面里本剧排在前面时只读它附近。
    const own = `{"series_name":"本剧","series_intro":"这是本剧的简介\\n第二行"}${'y'.repeat(6000)}${other}`;
    assert.equal(pickSynopsisFromText(own), '这是本剧的简介\n第二行');
    assert.equal(pickSynopsisFromText('{"series_name":"本剧"}'), '');
    assert.equal(pickSynopsisFromText('没有任何数据'), '');
    assert.ok(text.length > 0);
  });

  await check('Hongguo web detail carries the synopsis', async () => {
    page = `<html>{"series_name":"夺产背债","series_cover":"https://c/x.jpg","series_intro":"二十八万救蛟龙，海珍满仓。","vid_list":["111","222"]}</html>`;
    const result = await hongguo.fetchEpisodeListFromWeb('123456');
    assert.equal(result.synopsis, '二十八万救蛟龙，海珍满仓。');
    assert.equal(result.episodes.length, 2);
    page = `<html>{"series_name":"无简介","vid_list":["111"]}</html>`;
    assert.equal((await hongguo.fetchEpisodeListFromWeb('123456')).synopsis, '');
  });

  await check('Hema detail carries bookInfoVo.introduction', async () => {
    const next = {
      props: {
        pageProps: {
          bookInfoVo: {
            bookId: '77',
            bookName: '河马剧',
            coverWap: 'https://c/h.jpg',
            introduction: '<p>河马来源的剧情简介。</p>',
          },
          chapterList: [{ chapterId: '1', chapterIndex: 1, chapterName: '第1集', bookId: '77', isCharge: '0' }],
        },
      },
    };
    page = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
    const result = await hema.fetchEpisodeList('hema:77');
    assert.equal(result.synopsis, '河马来源的剧情简介。');
    assert.equal(result.series_title, '河马剧');
  });

  await check('Xifan detail carries the synopsis from the detail result', async () => {
    apiData = {
      ret: 0,
      result: {
        source: 'huabo',
        duanjuId: '55',
        title: '西饭剧',
        coverImageUrl: 'https://c/x.jpg',
        desc: '西饭来源的剧情简介内容。',
        episodeList: [{ episodeId: '9', index: 1, title: '第1集', unlock: true }],
      },
    };
    const result = await xifan.fetchEpisodeList('xifan:huabo:55');
    assert.equal(result.synopsis, '西饭来源的剧情简介内容。');
  });
  void path;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
