// Run: node src/components/check-ui-state.cjs. No browser, network or media playback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const episode = (n) => ({ vid: `vid${n}`, vid_index: n, status: 'missing' });
const detail = (id) => ({ series_id: id, series_title: id, total: 2, episodes: [episode(1), episode(2)] });
const ok = (data) => ({ success: true, data });

function mount(file, api, props = {}) {
  const slots = [],
    effects = [],
    cleanups = [];
  const timers = new Map();
  let timerId = 0;
  let cursor = 0,
    tree,
    Component;
  const changed = (old, deps) => !old || deps.some((d, i) => !Object.is(d, old[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[i],
        (value) => {
          slots[i] = typeof value === 'function' ? value(slots[i]) : value;
        },
      ];
    },
    useRef: (initial) => {
      const i = cursor++;
      return (slots[i] ||= { current: initial });
    },
    useMemo: (fn, deps) => {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect: (fn, deps) => {
      const i = cursor++;
      if (changed(slots[i], deps)) {
        slots[i] = deps;
        effects.push(() => {
          cleanups[i]?.();
          cleanups[i] = fn();
        });
      }
    },
  };
  const fallback = () => Promise.resolve({});
  const window = {
    electronAPI: new Proxy(api, { get: (obj, key) => obj[key] || (key.startsWith('on') ? () => () => {} : fallback) }),
    addEventListener() {},
    removeEventListener() {},
  };
  const source = transformSync(fs.readFileSync(`${__dirname}/${file}.jsx`, 'utf8'), {
    loader: 'jsx',
    format: 'cjs',
  }).code;
  const loadHelper = () => {
    const module = { exports: {} };
    vm.runInNewContext(
      transformSync(fs.readFileSync(`${__dirname}/episodeRange.js`, 'utf8'), { loader: 'js', format: 'cjs' }).code,
      { module, exports: module.exports },
    );
    return module.exports;
  };
  const loadModule = (name) => {
    const module = { exports: {} };
    vm.runInNewContext(
      transformSync(fs.readFileSync(`${__dirname}/${name}`, 'utf8'), { loader: 'js', format: 'cjs' }).code,
      { module, exports: module.exports },
    );
    return module.exports;
  };
  const context = {
    module: { exports: {} },
    exports: {},
    require: (name) =>
      name === 'react'
        ? react
        : name === './useDialogKeyboard'
          ? () => {}
          : name === './episodeRange'
            ? loadHelper()
            : name === './downloadSeries.mjs'
              ? require('./downloadSeries.mjs')
              : name === './pagination'
                ? loadModule('pagination.js')
                : name === './useLiveData'
                  ? () => [null, () => {}]
                  : {},
    window,
    document: { querySelector: () => null },
    navigator: {},
    crypto: require('node:crypto').webcrypto,
    setTimeout: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 1,
    clearInterval() {},
    console,
  };
  context.exports = context.module.exports;
  vm.runInNewContext(source, context);
  Component = context.module.exports.default;
  const render = () => {
    cursor = 0;
    tree = Component(props);
    effects.splice(0).forEach((fn) => fn());
    return tree;
  };
  const nodes = () => {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      out.push(n);
      n.children?.forEach(walk);
    };
    walk(tree);
    return out;
  };
  const text = (n) =>
    typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') || '';
  const find = (predicate) => nodes().find(predicate);
  const button = (label) => find((n) => n.type === 'button' && text(n).includes(label));
  const flush = async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      render();
    }
  };
  render();
  const advanceTimers = (ms) => {
    for (const [id, timer] of [...timers])
      if (timer.delay <= ms) {
        timers.delete(id);
        timer.fn();
      }
  };
  return {
    render,
    flush,
    find,
    nodes,
    button,
    advanceTimers,
    setProps: (next) => {
      props = { ...props, ...next };
      render();
    },
    text: () => text(tree),
    unmount: () => cleanups.forEach((fn) => fn?.()),
  };
}

(async () => {
  let failures = 0;
  const test = async (name, fn) => {
    if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return;
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL ${name}: ${e.stack}`);
    }
  };
  await test('closing a loading detail ignores its late result', async () => {
    const pending = deferred();
    const ui = mount('Browse', {
      getSeriesList: async () => [],
      browseCategories: async () => [],
      browseList: async () => ({ success: true, results: [{ series_id: 'A', series_title: 'A' }] }),
      searchResolve: () => pending.promise,
      getSeriesEpisodes: async () => ok(detail('A')),
    });
    await ui.flush();
    ui.find((n) => n.props.className === 'browse-card').props.onClick();
    ui.render();
    const close = ui.find((n) => n.type === 'button' && n.props.title === '关闭');
    assert.equal(!!close.props.disabled, false, 'loading drawer must remain cancellable');
    close.props.onClick();
    pending.resolve(ok(detail('A')));
    await ui.flush();
    assert.equal(
      ui.find((n) => n.props.role === 'dialog'),
      undefined,
      'closed drawer reopened',
    );
    ui.unmount();
  });
  await test('download latest parse wins over a late earlier parse', async () => {
    const first = deferred(),
      second = deferred();
    let count = 0;
    const ui = mount('HongguoDownload', { hongguoResolve: () => (++count === 1 ? first.promise : second.promise) });
    ui.button('粘贴链接').props.onClick();
    ui.render();
    const input = () => ui.find((n) => n.props['aria-label'] === '短剧分享链接或剧集 ID');
    input().props.onChange({ target: { value: 'A' } });
    ui.render();
    input().props.onKeyDown({ key: 'Enter' });
    ui.render();
    input().props.onChange({ target: { value: 'B' } });
    ui.render();
    input().props.onKeyDown({ key: 'Enter' });
    second.resolve(ok(detail('B')));
    await ui.flush();
    first.resolve(ok(detail('A')));
    await ui.flush();
    assert.ok(ui.text().includes('《B》'));
    assert.ok(!ui.text().includes('《A》'));
    ui.unmount();
  });
  await test('download ignores search selection after leaving its search panel', async () => {
    const ui = mount('HongguoDownload', { hongguoResolve: async () => ok(detail('B')) });
    const oldSearchResult = ui.find((n) => n.props.onSelectSeries).props.onSelectSeries;
    ui.button('粘贴链接').props.onClick();
    ui.render();
    ui.find((n) => n.props['aria-label'] === '短剧分享链接或剧集 ID').props.onChange({ target: { value: 'B' } });
    ui.render();
    ui.button('获取剧集').props.onClick();
    await ui.flush();
    oldSearchResult(detail('A'));
    ui.render();
    assert.ok(ui.text().includes('《B》'));
    assert.ok(!ui.text().includes('《A》'));
    ui.unmount();
  });
  await test('download includes App fallback episodes by default and bounds enormous ranges', async () => {
    const data = detail('A');
    data.web_accessible_episodes = 1;
    data.episodes[0].web_available = true;
    data.episodes[1].web_available = false;
    const ui = mount('HongguoDownload', {});
    ui.find((n) => n.props.onSelectSeries).props.onSelectSeries(data);
    ui.render();
    assert.ok(ui.button('下载选中集数 (2/2)'), 'web-unavailable episodes remain selected for the App fallback');
    assert.ok(ui.text().includes('网页源提供前 1 集，后续集数自动尝试 App 片源'));
    ui.find((n) => n.props['aria-label'] === '选择集数范围').props.onChange({ target: { value: '1-999999999' } });
    ui.render();
    vm.runInNewContext('apply()', { apply: ui.button('应用').props.onClick }, { timeout: 100 });
    ui.render();
    assert.ok(ui.button('下载选中集数 (2/2)'), 'manual selection must keep the API fallback available');
    ui.unmount();
  });
  await test('reselecting active search tab preserves pending search selection', async () => {
    const ui = mount('HongguoDownload', {});
    const searchResult = ui.find((n) => n.props.onSelectSeries).props.onSelectSeries;
    ui.button('搜索剧集').props.onClick();
    // React does not rerender when setTab receives the same value.
    searchResult(detail('A'));
    ui.render();
    assert.ok(ui.text().includes('《A》'));
    ui.unmount();
  });
  await test('browse: hot rank is the first tab and opens by default; a slow tab never blocks another', async () => {
    const pendingAi = deferred();
    const calls = [];
    const list = (title, extra = {}) => ({
      success: true,
      results: [{ series_id: title, series_title: title, ...extra }],
      totalPages: 1,
    });
    const ui = mount('Browse', {
      getSeriesList: async () => [],
      browseCategories: async () => [
        { slug: 'hot-rank', label: '热度榜' },
        { slug: 'real-drama', label: '真人剧' },
        { slug: 'ai-drama', label: 'AI剧' },
      ],
      browseList: async (p) => {
        calls.push(`${p.category}/${p.genre}`);
        if (p.category === 'ai-drama') return pendingAi.promise;
        if (p.category === 'real-drama') return list('真人缓存');
        return {
          ...list(p.genre ? `榜单-${p.genre}` : '榜一大剧', { rank: 1, heat: '8070万热度', score: '9.1', status_tags: ['新剧'] }),
          genres: [{ slug: 'real-drama', label: '真人剧' }],
          genreAllLabel: '总榜',
          notice: '10月20日已更新 · 基于红果内观看/互动等综合热度排序',
        };
      },
    });
    await ui.flush();
    assert.equal(calls[0], 'hot-rank/', 'the hot rank loads first');
    const tabs = ui.nodes().filter((n) => n.type === 'button' && String(n.props.className).startsWith('browse-cat'));
    const label = (n) => (typeof n === 'string' ? n : (n?.children || []).map(label).join(''));
    assert.equal(label(tabs[0]), '热度榜');
    assert.ok(!ui.text().includes('漫画'));
    assert.ok(ui.text().includes('榜一大剧') && ui.text().includes('8070万热度') && ui.text().includes('评分 9.1'));
    assert.ok(ui.text().includes('已更新'));
    assert.ok(ui.find((n) => String(n.props.className).includes('browse-rank-badge top top-1')), 'top 3 get a coloured rank');
    assert.ok(ui.button('总榜'));
    ui.button('真人剧').props.onClick(); // 第一个「真人剧」是分类 tab
    await ui.flush();
    ui.button('AI剧').props.onClick();
    await ui.flush();
    ui.button('真人剧').props.onClick();
    pendingAi.resolve(list('迟到的AI剧'));
    await ui.flush();
    assert.ok(ui.text().includes('真人缓存'));
    assert.ok(!ui.text().includes('迟到的AI剧'), 'a late answer from another tab is ignored');
    ui.unmount();
  });
  await test('browse categories: timeout ends skeleton and retry rejects the old response', async () => {
    const pending = deferred();
    let calls = 0;
    const ui = mount('Browse', {
      getSeriesList: async () => [],
      browseCategories: async () => [],
      browseList: () =>
        ++calls === 1
          ? pending.promise
          : Promise.resolve({ success: true, results: [{ series_id: 'retry', series_title: '重试成功' }] }),
    });
    await ui.flush();
    ui.advanceTimers(30000);
    await ui.flush();
    assert.ok(ui.text().includes('超时'), 'hanging IPC must become a visible timeout');
    assert.equal(
      ui.find((n) => n.props.className === 'browse-loading-state'),
      undefined,
    );
    ui.button('重新加载').props.onClick();
    await ui.flush();
    pending.resolve({ success: true, results: [{ series_id: 'old', series_title: '旧片单' }] });
    await ui.flush();
    assert.ok(ui.text().includes('重试成功'));
    assert.ok(!ui.text().includes('旧片单'));
    ui.unmount();
  });
  await test('browse categories: cancel is immediate and cached cards survive refresh errors', async () => {
    const pending = deferred();
    let calls = 0;
    const ui = mount('Browse', {
      getSeriesList: async () => [],
      browseCategories: async () => [],
      browseList: () =>
        ++calls === 1
          ? Promise.resolve({ success: true, results: [{ series_id: 'saved', series_title: '已加载片单' }] })
          : pending.promise,
    });
    await ui.flush();
    const refresh = ui.button('刷新片单');
    assert.ok(refresh, 'cached results need an explicit refresh');
    refresh.props.onClick();
    await ui.flush();
    assert.ok(ui.text().includes('已加载片单'));
    const cancel = ui.button('取消加载');
    assert.ok(cancel, 'loading must remain cancellable');
    cancel.props.onClick();
    ui.render();
    assert.ok(ui.text().includes('已取消'));
    assert.ok(ui.text().includes('已加载片单'));
    pending.resolve({ success: false, error: '来源不可用' });
    await ui.flush();
    assert.ok(!ui.text().includes('来源不可用'), 'cancelled request must not overwrite cancellation');
    ui.button('重新加载').props.onClick();
    await ui.flush();
    assert.ok(ui.text().includes('来源不可用'));
    assert.ok(ui.text().includes('已加载片单'));
    ui.unmount();
  });

  await test('xifan browse source switch rejects late lists and opens the current source URL', async () => {
    const old = deferred(),
      opened = [],
      pages = [];
    let calls = 0;
    const ui = mount('Browse', {
      getSeriesList: async () => [],
      browseCategories: async () => [],
      browseList: (p) =>
        p.source === 'xifan'
          ? (pages.push(p.page),
            Promise.resolve({
              success: true,
              results: [{ series_id: 'X', series_title: '西饭片单' }],
              genres: [{ slug: '68', label: '都市' }],
              total: 0,
              totalPages: 0,
              hasMore: p.page === 1,
            }))
          : ++calls === 1
            ? Promise.resolve({
                success: true,
                results: [{ series_id: 'H', series_title: '红果片单' }],
                sourceUrl: 'https://www.hongguoduanju.com/category/real-drama',
              })
            : old.promise,
      searchWindowShow: async (...args) => opened.push(args),
    });
    await ui.flush();
    await ui.button('打开来源页面').props.onClick();
    assert.equal(opened[0][1], 'https://www.hongguoduanju.com/category/real-drama');
    ui.button('刷新片单').props.onClick();
    ui.render();
    const source = ui.find((n) => n.props['aria-label'] === '短剧来源');
    assert.ok(source, 'source selector missing');
    source.props.onChange({ target: { value: 'xifan' } });
    await ui.flush();
    old.resolve({ success: true, results: [{ series_id: 'late', series_title: '旧红果片单' }] });
    await ui.flush();
    assert.ok(ui.text().includes('西饭片单'));
    assert.ok(!ui.text().includes('旧红果片单'));
    assert.equal(ui.button('打开来源页面'), undefined);
    assert.ok(ui.button('都市'));
    ui.button('下一页').props.onClick();
    await ui.flush();
    assert.equal(pages.at(-1), 2);
    assert.equal(ui.button('下一页').props.disabled, true);
    assert.ok(ui.text().includes('第 2 页'));
    ui.button('上一页').props.onClick();
    await ui.flush();
    assert.ok(ui.text().includes('第 1 页'));
    ui.unmount();
  });
  await test('all-source search merges both sources and resolves the original source ID', async () => {
    const first = deferred(),
      second = deferred(),
      calls = [],
      resolved = [],
      picked = [];
    const ui = mount(
      'SearchPanel',
      {
        searchSeries: (kw, options) => {
          calls.push([kw, options.source]);
          return options.source === 'hongguo'
            ? first.promise
            : options.source === 'xifan'
              ? second.promise
              : Promise.resolve({ success: true, results: [] });
        },
        searchResolve: async (id) => {
          resolved.push(id);
          return ok(detail(id));
        },
      },
      { onSelectSeries: (d) => picked.push(d) },
    );
    assert.equal(ui.find((n) => n.props['aria-label'] === '短剧来源').props.value, 'all');
    assert.ok(ui.find((n) => n.type === 'option' && n.props.value === 'all'));
    ui.find((n) => n.type === 'input').props.onChange({ target: { value: '同名剧' } });
    ui.render();
    ui.button('搜索').props.onClick();
    assert.deepEqual(
      calls,
      [
        ['同名剧', 'hongguo'],
        ['同名剧', 'xifan'],
        ['同名剧', 'hema'],
      ],
      'all searches start without waiting for each other',
    );
    second.resolve({ success: true, results: [{ series_id: 'xifan:test:123', series_title: '同名剧' }] });
    first.resolve({ success: true, results: [{ series_id: '123', series_title: '同名剧' }] });
    await ui.flush();
    const cards = ui.nodes().filter((n) => n.props.className?.startsWith('search-card '));
    assert.equal(cards.length, 2, 'same title across sources must remain separately selectable');
    assert.ok(ui.nodes().some((n) => n.props.className === 'badge' && n.children.includes('红果短剧')));
    assert.ok(ui.nodes().some((n) => n.props.className === 'badge' && n.children.includes('西饭短剧')));
    cards[1].props.onClick();
    await ui.flush();
    assert.equal(resolved[0], 'xifan:test:123');
    assert.equal(picked[0].series_id, 'xifan:test:123');
    ui.unmount();
  });
  await test('all-source search keeps successful results when the other source fails', async () => {
    for (const failure of [{ success: false, error: '来源暂不可用' }, new Error('连接超时')]) {
      const ui = mount('SearchPanel', {
        searchSeries: async (kw, { source }) => {
          if (source === 'hongguo') return { success: true, results: [{ series_id: '123', series_title: '仍可查看' }] };
          if (failure instanceof Error) throw failure;
          return failure;
        },
      });
      ui.find((n) => n.type === 'input').props.onChange({ target: { value: '剧名' } });
      ui.render();
      ui.button('搜索').props.onClick();
      await ui.flush();
      assert.ok(ui.text().includes('仍可查看'));
      assert.ok(
        ui.find((n) => n.props.role === 'alert'),
        'failed source must not be silently omitted',
      );
      assert.ok(ui.text().includes(failure.message || failure.error));
      assert.ok(!ui.text().includes('没有找到相关短剧'));
      ui.unmount();
    }
  });
  await test('all-source search failures are not shown as an empty successful search', async () => {
    const ui = mount('SearchPanel', { searchSeries: async () => ({ success: false, error: '网络断开' }) });
    ui.find((n) => n.type === 'input').props.onChange({ target: { value: '剧名' } });
    ui.render();
    ui.button('搜索').props.onClick();
    await ui.flush();
    assert.ok(ui.find((n) => n.props.role === 'alert'));
    assert.ok(!ui.text().includes('没有找到相关短剧'));
    ui.unmount();
  });
  await test('xifan search source change ignores late searches and detail picks', async () => {
    const old = deferred(),
      pick = deferred(),
      picked = [];
    const calls = [];
    const ui = mount(
      'SearchPanel',
      {
        searchSeries: (kw, options) => {
          calls.push(options);
          return options?.source === 'xifan'
            ? Promise.resolve({ success: true, results: [{ series_id: 'X', series_title: '西饭搜索' }] })
            : old.promise;
        },
        searchResolve: () => pick.promise,
      },
      { onSelectSeries: (d) => picked.push(d) },
    );
    ui.find((n) => n.type === 'input').props.onChange({ target: { value: '剧名' } });
    ui.render();
    ui.button('搜索').props.onClick();
    ui.render();
    const source = ui.find((n) => n.props['aria-label'] === '短剧来源');
    assert.ok(source, 'source selector missing');
    source.props.onChange({ target: { value: 'xifan' } });
    ui.render();
    ui.button('搜索').props.onClick();
    await ui.flush();
    old.resolve({ success: true, results: [{ series_id: 'H', series_title: '旧搜索' }] });
    await ui.flush();
    assert.ok(ui.text().includes('西饭搜索'));
    assert.ok(!ui.text().includes('旧搜索'));
    ui.find((n) => n.props.className?.startsWith('search-card ')).props.onClick();
    ui.render();
    ui.find((n) => n.props['aria-label'] === '短剧来源').props.onChange({ target: { value: 'hongguo' } });
    ui.render();
    pick.resolve(ok(detail('X')));
    await ui.flush();
    assert.equal(picked.length, 0);
    assert.equal(calls[0].source, 'hongguo');
    ui.unmount();
  });
  await test('xifan locked episodes are excluded from every download selection', async () => {
    const data = detail('xifan:test:A');
    data.episodes[0].locked = true;
    let submitted;
    const ui = mount('HongguoDownload', {
      hongguoDownloadBatch: async (p) => {
        submitted = p;
        return { success: true, count: p.episodes.length };
      },
    });
    ui.find((n) => n.props.onSelectSeries).props.onSelectSeries(data);
    ui.render();
    assert.ok(ui.button('下载选中集数 (1/2)'), 'default must exclude locked');
    for (const label of ['全选', '前 10 集', '前 30 集', '后 30 集']) {
      ui.button(label).props.onClick();
      ui.render();
      assert.ok(ui.button('下载选中集数 (1/2)'), label);
    }
    ui.button('反选').props.onClick();
    ui.render();
    assert.ok(ui.button('下载选中集数 (0/2)'));
    ui.find((n) => n.props['aria-label'] === '选择集数范围').props.onChange({ target: { value: '1-2' } });
    ui.render();
    ui.button('应用').props.onClick();
    ui.render();
    assert.ok(ui.button('下载选中集数 (1/2)'));
    assert.ok(ui.find((n) => n.props.className?.startsWith('episode-card') && n.props.disabled));
    await ui.button('下载选中集数').props.onClick();
    assert.equal(submitted.episodes.length, 1);
    assert.equal(submitted.episodes[0].vid_index, 2);
    ui.unmount();
  });
  await test('app navigation keeps visited pages and marks background pages inactive', async () => {
    const ui = mount('../App', { getAppInfo: async () => ({ platform: 'darwin' }) });
    await ui.flush();
    ui.button('设置').props.onClick();
    ui.render();
    assert.ok(ui.find((n) => n.props['data-page'] === 'browse')?.props.hidden, 'browse must remain mounted but hidden');
    assert.equal(ui.find((n) => n.props['data-page'] === 'settings')?.props.hidden, false);
    ui.button('管理剧集').props.onClick();
    ui.render();
    ui.button('发现短剧').props.onClick();
    ui.render();
    const library = ui.find((n) => n.props['data-page'] === 'library');
    assert.ok(library?.props.hidden, 'visited library must be retained');
    // 每页外面包着 ErrorBoundary：页面元素是它的第一个子元素。
    assert.equal(library.children[0]?.children?.[0]?.props.active, false, 'hidden library must receive inactive state');
    assert.equal(ui.button('我的剧库'), undefined, 'the playback page is gone from the menu');
    assert.equal(
      ui.find((n) => n.props['data-page'] === 'player'),
      undefined,
    );
    assert.equal(ui.nodes().filter((n) => n.props['data-page'] === 'browse').length, 1);
    ui.unmount();
  });
  await test('download keeps its search panel mounted while selecting episodes', async () => {
    const ui = mount('HongguoDownload', {});
    ui.find((n) => n.props.onSelectSeries).props.onSelectSeries(detail('A'));
    ui.render();
    assert.ok(
      ui.find((n) => n.props.onSelectSeries),
      'search results must survive selecting a series',
    );
    ui.button('搜索剧集').props.onClick();
    ui.render();
    assert.ok(ui.button('下载选中集数 (2/2)'), 'episode selection must survive returning to search');
    ui.unmount();
  });
  await test('search keyboard ignores IME confirmation and duplicate Enter', async () => {
    const pending = deferred();
    let calls = 0;
    const ui = mount('SearchPanel', {
      searchSeries: () => {
        calls++;
        return pending.promise;
      },
    });
    const input = () => ui.find((n) => n.props['aria-label'] === '搜索短剧名称');
    input().props.onChange({ target: { value: '短剧' } });
    ui.render();
    input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} });
    assert.equal(calls, 0, 'confirming an IME candidate must not search');
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    ui.render();
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.equal(calls, 3, 'same pending all-source search must call each source only once');
    pending.resolve({ success: true, results: [] });
    await ui.flush();
    ui.unmount();
  });
  await test('resolve keyboard ignores IME confirmation and duplicate Enter', async () => {
    const pending = deferred();
    let calls = 0;
    const ui = mount('HongguoDownload', {
      hongguoResolve: () => {
        calls++;
        return pending.promise;
      },
    });
    ui.button('粘贴链接').props.onClick();
    ui.render();
    const input = () => ui.find((n) => n.props['aria-label'] === '短剧分享链接或剧集 ID');
    input().props.onChange({ target: { value: 'A' } });
    ui.render();
    input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} });
    assert.equal(calls, 0);
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.equal(calls, 1);
    pending.resolve(ok(detail('A')));
    await ui.flush();
    ui.unmount();
  });
  for (const file of ['HongguoDownload', 'Browse'])
    await test(`${file} range accepts Chinese separators and rejects partial numbers without changing selection`, async () => {
      const data = detail('range');
      data.total = 3;
      data.episodes.push(episode(3));
      const ui = mount(file, {
        getSeriesList: async () => [],
        browseCategories: async () => [],
        browseList: async () => ({ success: true, results: [{ series_id: 'range', series_title: 'range' }] }),
        searchResolve: async () => ok(data),
        getSeriesEpisodes: async () => ok(data),
      });
      if (file === 'Browse') {
        await ui.flush();
        ui.find((n) => n.props.className === 'browse-card').props.onClick();
        await ui.flush();
      } else {
        ui.find((n) => n.props.onSelectSeries).props.onSelectSeries(data);
        ui.render();
      }
      const input = () => ui.find((n) => n.props['aria-label'] === '选择集数范围');
      input().props.onChange({ target: { value: '1，3' } });
      ui.render();
      ui.button('应用').props.onClick();
      ui.render();
      const selected = () => ui.nodes().filter((n) => n.props['aria-pressed'] === true).length;
      assert.equal(selected(), 2, 'Chinese commas must select both episodes');
      input().props.onChange({ target: { value: '2oops' } });
      ui.render();
      ui.button('应用').props.onClick();
      ui.render();
      assert.equal(selected(), 2, 'invalid input must preserve selection');
      assert.ok(
        ui.find((n) => n.props.role === 'alert'),
        'invalid range needs visible feedback',
      );
      ui.unmount();
    });
  await test('proxy test ignores results after the draft changes or closes', async () => {
    const pending = deferred();
    const ui = mount('Settings', {
      getSettings: async () => ({
        proxy_enabled: true,
        proxy_mode: 'custom',
        proxy_host: '127.0.0.1',
        proxy_port: 7890,
      }),
      testProxy: () => pending.promise,
    });
    await ui.flush();
    ui.button('配置代理').props.onClick();
    ui.render();
    ui.button('测试连接').props.onClick();
    ui.render();
    ui.find((n) => n.props['aria-label'] === '代理端口').props.onChange({ target: { value: '7891' } });
    ui.render();
    pending.resolve({ success: true, message: 'OLD_CONFIG_OK' });
    await ui.flush();
    assert.ok(!ui.text().includes('OLD_CONFIG_OK'), 'old test result must not describe the edited draft');
    ui.unmount();
  });
  await test('settings failed save reports the reason and retains the draft', async () => {
    const ui = mount('Settings', {
      getSettings: async () => ({ root: '/old' }),
      saveSettings: async () => ({ success: false, error: '磁盘空间不足' }),
    });
    await ui.flush();
    ui.find((n) => n.props['aria-label'] === '下载目录').props.onChange({ target: { value: '/new' } });
    ui.render();
    await ui.button('保存设置').props.onClick();
    ui.render();
    assert.ok(ui.text().includes('磁盘空间不足'));
    assert.equal(ui.find((n) => n.props['aria-label'] === '下载目录').props.value, '/new');
    assert.ok(!ui.text().includes('已保存'));
    ui.unmount();
  });
  await test('library list picks up a series as soon as its download starts; back button lives in the top bar', async () => {
    const series = { name: '新剧', path: '/root/新剧', videoCount: 0, totalEpisodes: 80, source: '红果' };
    let listed = [];
    let lists = 0;
    let added = null;
    const backs = [];
    const ui = mount(
      'SeriesLibrary',
      {
        libraryList: async () => {
          lists += 1;
          return { success: true, root: '/root', folders: listed };
        },
        onDownloadTaskAdded: (cb) => {
          added = cb;
          return () => {
            added = null;
          };
        },
      },
      { active: true, onBackChange: (back) => backs.push(back) },
    );
    await ui.flush();
    assert.ok(ui.text().includes('还没有剧'));
    assert.equal(lists, 1);
    // 停在列表页时在别处点了下载：不用退出再进来，1 秒内自动重读。
    listed = [series];
    assert.equal(typeof added, 'function', 'the list listens for new downloads');
    added({ id: 't1' });
    added({ id: 't2' });
    ui.advanceTimers(1000);
    await ui.flush();
    assert.equal(lists, 2, 'several events in a row cause one re-read');
    assert.ok(ui.text().includes('新剧'), 'the new series shows up right away');
    // 打开这部剧：顶栏拿到「返回剧集列表」；点它回到列表，顶栏恢复。
    assert.equal(backs.at(-1), null);
    ui.find((n) => n.props.className === 'lib-card').props.onClick();
    await ui.flush();
    const back = backs.at(-1);
    assert.equal(typeof back, 'function', 'the top bar gets a back action');
    assert.equal(added, null, 'no list re-reads while a series is open');
    back();
    await ui.flush();
    assert.equal(backs.at(-1), null, 'back on the list: the top bar shows the page name again');
    assert.ok(ui.text().includes('新剧'));
    ui.unmount();
    // App 顶栏：打开了剧才显示返回按钮，页面里不再单独放一行。
    const app = fs.readFileSync(`${__dirname}/../App.jsx`, 'utf8');
    assert.match(app, /page === 'library' && libraryBack \?/);
    const detailSource = fs.readFileSync(`${__dirname}/SeriesDetail.jsx`, 'utf8');
    assert.ok(!detailSource.includes('/> 返回剧集列表') && !/onBack/.test(detailSource), 'no back button inside the page');
  });
  process.exitCode = failures ? 1 : 0;
})();
