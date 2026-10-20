const axios = require('axios');

const SITE = 'https://hongguoduanju.com';
const CATEGORIES = new Set(['hot-rank', 'real-drama', 'comic-drama', 'ai-drama']);
// 热度榜：官网 /rank/ 下的四个榜单。「总榜」是红果热播榜，其余按剧的类型分。
const RANKS = [
  { slug: '', path: 'hot-drama', label: '总榜' },
  { slug: 'real-drama', path: 'hot-real-drama', label: '真人剧' },
  { slug: 'ai-drama', path: 'hot-ai-drama', label: 'AI剧' },
  { slug: 'comic-drama', path: 'hot-comic-drama', label: '漫剧' },
];
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

const decodeEntities = (text) =>
  String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** 在一段数据里找带 rankList 的那一层；数据可能是对象，也可能是又包了一层的 JSON 文本。 */
function findRankData(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return null;
    try {
      return findRankData(JSON.parse(text), depth + 1);
    } catch (_) {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRankData(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.rankList)) return value;
    for (const item of Object.values(value)) {
      const found = findRankData(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 榜单页的数据不在 _ROUTER_DATA 里，而是放在页面脚本标签的 data-fn-args 属性里（HTML 转义过的 JSON）。
 * 第 1 页和后面几页的写法不一样（一个是 JSON 文本里再套 JSON，一个是直接给对象），两种都只当数据读，不执行网页脚本。
 */
function readRankData(html) {
  const pattern = /data-fn-args=(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(String(html)))) {
    let args;
    try {
      args = JSON.parse(decodeEntities(match[1] ?? match[2]));
    } catch (_) {
      continue;
    }
    const found = findRankData(args);
    if (found) return found;
  }
  return null;
}

function parseRank(html, rank, page, sourceUrl) {
  const data = readRankData(html);
  let updatedText = '';
  try {
    updatedText = String(Object.values(readRouterData(html).loaderData || {}).find((v) => v?.updatedText)?.updatedText || '');
  } catch (_) {}
  const genres = RANKS.filter((item) => item.slug).map(({ slug, label }) => ({ slug, label }));
  if (!data) {
    // 超出最后一页时官网返回一页空壳。
    if (/_ROUTER_DATA/.test(html) && page > 1)
      return { success: true, results: [], page, total: 0, totalPages: 0, genres, sourceUrl, emptyMessage: '榜单没有这么多页了' };
    throw new Error('来源榜单数据暂不可用，请重试或打开来源页面');
  }
  if (data.isSuccess === false) throw new Error('来源榜单暂不可用，请重试或打开来源页面');
  const seen = new Set();
  const results = data.rankList
    .filter((item) => {
      const id = String(item?.seriesId ?? item?.id ?? '');
      if (!/^\d{6,}$/.test(id) || typeof item.title !== 'string' || !item.title.trim() || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((item) => {
      const id = String(item.seriesId ?? item.id);
      const strings = (list, max) =>
        Array.isArray(list) ? list.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, max) : [];
      return {
        series_id: id,
        series_title: item.title.trim(),
        cover: typeof item.cover === 'string' ? item.cover : '',
        episode_count: Array.isArray(item.episodeVids) ? item.episodeVids.length : 0,
        tags: strings(item.tags, 4),
        rank: Number(item.rank) || 0,
        heat: typeof item.heatText === 'string' ? item.heatText.trim() : '',
        status_tags: strings(item.statusTags, 2),
        score: typeof item.scoreText === 'string' ? item.scoreText.replace(/^评分/, '').trim() : '',
        url: `${SITE}/detail?series_id=${id}`,
      };
    });
  const pageNum = Number(data.pagination?.pageNum) || page;
  return {
    success: true,
    results,
    page: pageNum,
    total: 0,
    totalPages: Number(data.pagination?.totalPages) || pageNum,
    genres,
    genreAllLabel: RANKS[0].label,
    notice: updatedText,
    pageTitle: rank.label,
    sourceUrl,
  };
}

function parseCatalog(html, category, page, sourceUrl) {
  const router = readRouterData(html);
  const data = Object.values(router.loaderData || {}).find((value) => value?.categoryRoute?.contentType === category);
  if (!data || data.isSuccess === false || !Array.isArray(data.recommendList)) {
    throw new Error('来源目录暂不可用，请重试或打开来源页面');
  }
  const pageTitle = data.seo?.title || '';
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
  const { category = 'hot-rank', genre = '', page = 1, forceRefresh = false } = options || {};
  if (!CATEGORIES.has(category) || (genre && !/^[a-z0-9-]+$/.test(genre)))
    return { success: false, error: '无效的目录分类或题材' };
  const rank = category === 'hot-rank' ? RANKS.find((item) => item.slug === genre) : null;
  if (category === 'hot-rank' && !rank) return { success: false, error: '没有这个榜单' };
  const pg = Math.max(1, Number.parseInt(page, 10) || 1);
  const query = pg > 1 ? `?page=${pg}` : '';
  const url = rank
    ? `${SITE}/rank/${rank.path}${query}`
    : `${SITE}/category/${category}${genre ? `/${genre}` : ''}${query}`;
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
      const data = rank ? parseRank(response.data, rank, pg, url) : parseCatalog(response.data, category, pg, url);
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

module.exports = { browseList, parseRank, RANKS };
