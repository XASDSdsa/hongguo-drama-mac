const axios = require('axios');

const SITE = 'https://hongguoduanju.com';
const CATEGORIES = new Set(['real-drama', 'comic-drama', 'ai-drama', 'comic']);
const TIMEOUT_MS = 10000;
const CACHE_MS = 30000;
const cache = new Map();
const pending = new Map();

// Read only the JSON assignment; never execute scripts received from the website.
function readRouterData(html) {
  const match = String(html).match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) throw new Error('来源页面未返回目录数据，请重试或打开来源页面');
  const start = match.index + match[0].length - 1;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('来源目录数据不完整，请重试');
}

function parseCatalog(html, category, page, sourceUrl) {
  const router = readRouterData(html);
  const data = Object.values(router.loaderData || {}).find((value) => value?.categoryRoute?.contentType === category);
  if (!data || data.isSuccess === false || !Array.isArray(data.recommendList)) {
    throw new Error('来源目录暂不可用，请重试或打开来源页面');
  }
  const pageTitle = data.seo?.title || '';
  if (category === 'comic') {
    return {
      success: true,
      results: [],
      page: 1,
      total: 0,
      totalPages: 0,
      genres: [],
      pageTitle,
      sourceUrl,
      unsupported: true,
      emptyMessage: '漫画属于图文阅读，暂不支持视频播放或下载；请切换「漫剧」或打开来源页面阅读。',
    };
  }
  const seen = new Set();
  const results = data.recommendList
    .filter((item) => {
      if (
        !/^\d{6,}$/.test(item?.series_id) ||
        typeof item.series_name !== 'string' ||
        !item.series_name.trim() ||
        seen.has(String(item.series_id))
      )
        return false;
      seen.add(String(item.series_id));
      return true;
    })
    .map((item) => ({
      series_id: String(item.series_id),
      series_title: item.series_name.trim(),
      cover: item.series_cover || '',
      episode_count: Number(item.episode_cnt) || 0,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string').slice(0, 4) : [],
      url: `${SITE}/detail?series_id=${item.series_id}`,
    }));
  const genres = (Array.isArray(data.selectorList) ? data.selectorList : [])
    .flatMap((row) => (Array.isArray(row?.items) ? row.items : []))
    .filter((item) => /^[a-z0-9-]+$/.test(item?.selector_item_id) && typeof item.show_name === 'string')
    .map((item) => ({ slug: item.selector_item_id, label: item.show_name }));
  return {
    success: true,
    results,
    page: Number(data.pagination?.pageNum) || page,
    total: Number(data.pagination?.total) || 0,
    totalPages: Number(data.pagination?.totalPages) || 0,
    genres,
    pageTitle,
    sourceUrl,
  };
}

async function browseList(options = {}) {
  const { category = 'real-drama', genre = '', page = 1, forceRefresh = false } = options || {};
  if (!CATEGORIES.has(category) || (genre && !/^[a-z0-9-]+$/.test(genre)))
    return { success: false, error: '无效的目录分类或题材' };
  const pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const url = `${SITE}/category/${category}${genre ? `/${genre}` : ''}${pg > 1 ? `?page=${pg}` : ''}`;
  if (!forceRefresh && cache.get(url)?.expires > Date.now()) return cache.get(url).data;
  if (pending.has(url)) return pending.get(url);

  // Each URL owns its request: a slow comic page cannot queue behind real drama (or vice versa).
  const task = (async () => {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('目录加载超时，请重试'));
        }, TIMEOUT_MS);
      });
      const response = await Promise.race([
        axios.get(url, {
          timeout: TIMEOUT_MS,
          signal: controller.signal,
          responseType: 'text',
          maxContentLength: 8 * 1024 * 1024,
        }),
        timeout,
      ]);
      const data = parseCatalog(response.data, category, pg, url);
      cache.set(url, { expires: Date.now() + CACHE_MS, data });
      // Bound memory while retaining the latest category/filter pages.
      if (cache.size > 32) cache.delete(cache.keys().next().value);
      return data;
    } catch (error) {
      return {
        success: false,
        error: controller.signal.aborted || error.code === 'ECONNABORTED' ? '目录加载超时，请重试' : error.message,
        sourceUrl: url,
      };
    } finally {
      clearTimeout(timer);
      pending.delete(url);
    }
  })();
  pending.set(url, task);
  return task;
}

module.exports = { browseList };
