const axios = require('axios');

const ORIGIN = 'https://www.kuaikaw.cn';
const ID = /^\d{1,30}$/;

function plainText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch (_) {
    return '';
  }
}

function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'hema' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every((part) => ID.test(part))) {
    throw new Error('河马剧集编号无效');
  }
  return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(':') };
}

async function request(apiPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: body ? 'application/json' : 'text/html',
      'Content-Type': 'application/json',
      pname: 'www.kuaikaw.cn',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
    },
    timeout: 10000,
    signal: controller.signal,
    maxRedirects: 0,
    maxContentLength: 8 * 1024 * 1024,
    responseType: body ? 'json' : 'text',
  };
  try {
    const response = body
      ? await axios.post(ORIGIN + apiPath, body, options)
      : await axios.get(ORIGIN + apiPath, options);
    return response.data;
  } catch (error) {
    throw new Error(
      controller.signal.aborted || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
        ? '河马加载超时，请重试'
        : '河马来源暂不可用，请稍后重试',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function search(keyword, page = 1) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    const pg = Math.max(1, Number.parseInt(page, 10) || 1);
    const response = await request('/seo/video/6007', { sourceType: 1, keyword: kw, index: pg });
    if (response?.retCode !== 0 || !Array.isArray(response.data?.bookList))
      throw new Error('河马搜索数据异常，请稍后重试');
    const data = response.data;
    const seen = new Set();
    const results = data.bookList
      .filter((item) => item && ID.test(String(item.bookId || '')) && plainText(item.bookName))
      .map((item) => ({
        series_id: `hema:${item.bookId}`,
        series_title: plainText(item.bookName),
        cover: httpsUrl(item.coverWap),
        episode_count: Number(item.totalChapterNum) || 0,
        tags: Array.isArray(item.bookTypeThree)
          ? item.bookTypeThree
              .map((tag) => plainText(tag?.name))
              .filter(Boolean)
              .slice(0, 4)
          : [],
        source: 'hema',
        url: `${ORIGIN}/drama/${item.bookId}`,
      }))
      .filter((item) => {
        if (seen.has(item.series_id)) return false;
        seen.add(item.series_id);
        return true;
      });
    const hasMore = data.isMore === 1 && results.length > 0;
    return {
      success: true,
      results,
      page: pg,
      total: Number(data.totalSize) || 0,
      totalPages: 0,
      hasMore,
      nextPage: hasMore ? pg + 1 : null,
      genres: [],
      pageTitle: '河马短剧',
      sourceUrl: ORIGIN,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function detail(seriesId) {
  const { bookId } = parseId(seriesId);
  const html = await request(`/drama/${bookId}`);
  const match =
    typeof html === 'string' && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  let result;
  try {
    result = JSON.parse(match?.[1]).props.pageProps;
  } catch (_) {
    throw new Error('河马详情数据异常，请稍后重试');
  }
  if (String(result?.bookInfoVo?.bookId) !== bookId || !Array.isArray(result?.chapterList)) {
    throw new Error('河马返回的剧集与请求不一致');
  }
  const seen = new Set();
  for (const episode of result.chapterList) {
    const id = String(episode?.chapterId || '');
    if (!ID.test(id) || seen.has(id) || (episode.bookId != null && String(episode.bookId) !== bookId)) {
      throw new Error('河马分集数据异常，请稍后重试');
    }
    seen.add(id);
  }
  return result;
}

async function fetchEpisodeList(seriesId) {
  const result = await detail(seriesId);
  const series_title = plainText(result.bookInfoVo.bookName) || '未命名短剧';
  const cover = httpsUrl(result.bookInfoVo.coverWap);
  const episodes = result.chapterList
    .map((episode, index) => ({
      vid: `${seriesId}:${episode.chapterId}`,
      vid_index: Number(episode.chapterIndex) || index + 1,
      title: plainText(episode.chapterName),
      series_id: seriesId,
      series_title,
      cover,
      locked: episode.isCharge !== '0',
      source: 'hema',
    }))
    .sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('河马分集列表为空');
  return { series_id: seriesId, series_title, cover, total: episodes.length, episodes, source: 'hema' };
}

async function fetchPlayUrlSingle(vid, sid) {
  try {
    const id = parseId(vid, true);
    if (sid != null && sid !== '' && parseId(sid).seriesId !== id.seriesId) throw new Error('河马分集不属于当前剧集');
    // Re-read the public detail for every request: never reuse a cached free/paid decision.
    const result = await detail(id.seriesId);
    const episode = result.chapterList.find((item) => String(item.chapterId) === id.chapterId);
    if (!episode) throw new Error('河马未找到该分集');
    if (episode.isCharge !== '0')
      return {
        url: null,
        spadeA: null,
        codec: null,
        source: 'hema',
        locked: true,
        error: `第 ${Number(episode.chapterIndex) || ''} 集当前锁定，请在河马官方平台确认可看范围`,
      };
    const url = httpsUrl(episode.chapterVideoVo?.mp4720p) || httpsUrl(episode.chapterVideoVo?.mp4);
    if (!url) throw new Error('河马未提供有效 HTTPS 播放地址');
    return { url, spadeA: null, codec: '', source: 'hema' };
  } catch (error) {
    return { url: null, spadeA: null, codec: null, source: 'hema', error: error.message };
  }
}

module.exports = { search, fetchEpisodeList, fetchPlayUrlSingle };
