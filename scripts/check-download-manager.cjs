// No network, browser, media or real timers. Run: node scripts/check-download-manager.cjs [name].
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function mount(api = {}, props = {}) {
  const slots = [], effects = [], cleanups = [], events = new Map(), timers = new Map();
  let cursor = 0, tree, timerId = 0, writes = 0, dialogOpen;
  const changed = (old, deps) => !old || deps.some((d, i) => !Object.is(d, old[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { writes++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect: (fn, deps) => { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const defaults = { getDownloadTasks: async () => [], getSeriesList: async () => [], getMergeTasks: async () => [], getQueueStatus: async () => ({ active: 0, queued: 0, maxConcurrent: 3 }) };
  const window = { electronAPI: new Proxy({ ...defaults, ...api }, { get: (obj, key) => obj[key] || (key.startsWith('on') ? fn => { events.set(key, fn); return () => events.delete(key); } : async () => ({ success: true })) }) };
  const setTimer = (fn, delay, interval = false) => { const id = ++timerId; timers.set(id, { fn, delay, interval }); return id; };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/DownloadManager.jsx`, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => name === 'react' ? react : name === './SeriesEpisodePanel' ? 'SeriesEpisodePanel' : name === './downloadSeries.mjs' ? require('../src/components/downloadSeries.mjs') : name === './useDialogKeyboard' ? open => { dialogOpen = open; } : {}, window,
    document: { querySelector: () => null }, console, setTimeout: (fn, delay) => setTimer(fn, delay), clearTimeout: id => timers.delete(id), setInterval: (fn, delay) => setTimer(fn, delay, true), clearInterval: id => timers.delete(id),
  });
  const render = () => { cursor = 0; tree = module.exports.default(props); effects.splice(0).forEach(fn => fn()); };
  const nodes = () => { const out = []; const walk = n => { if (!n || typeof n !== 'object') return; out.push(n); n.children?.forEach(walk); }; walk(tree); return out; };
  const textOf = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(textOf).join('') || '';
  const find = predicate => nodes().find(predicate);
  render();
  return {
    render, find, nodes, text: () => textOf(tree), button: label => find(n => n.type === 'button' && textOf(n).includes(label)),
    flush: async () => { for (let i = 0; i < 25; i++) { await Promise.resolve(); render(); } },
    advance: ms => { for (const [id, timer] of [...timers]) if (timer.delay <= ms && timers.has(id)) { if (!timer.interval) timers.delete(id); timer.fn(); } },
    emit: (name, data) => events.get(name)?.(data), setProps: next => { props = { ...props, ...next }; render(); },
    writes: () => writes, dialogOpen: () => dialogOpen, intervals: () => [...timers.values()].filter(t => t.interval).length,
    unmount: () => cleanups.forEach(fn => fn?.()),
  };
}
const task = (i, status = 'downloading') => ({ id: `t${i}`, title: `第${i}集`, status, progress: 0, startTime: i, hongguoInfo: { series_id: 'A', series_title: '示例剧', vid_index: i } });
const rows = ui => ui.nodes().filter(n => /^dm-task(?: selected)?$/.test((n.props.className || '').trim()));
const openSeries = (ui, key = 'series:A') => { const card = ui.find(n => n.props['data-series-key'] === key); assert.ok(card, `missing series card ${key}`); card.props.onClick(); ui.render(); };
const runningMerge = () => ({ id: 'm', seriesId: 'A', status: 'running', total: 2, done: 0, progress: 0, seriesTitle: 'A', startTime: Date.now() });

(async () => {
  let failures = 0, passed = 0;
  const test = async (name, fn) => { if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return; try { await fn(); passed++; } catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); } };
  await test('one initial snapshot and no polling or focus trap while hidden', async () => {
    let calls = 0;
    const ui = mount({ getDownloadTasks: async () => { calls++; return [task(1)]; } });
    await ui.flush(); assert.equal(calls, 1, 'initial effects must not request duplicate snapshots');
    openSeries(ui); ui.find(n => n.props.title?.startsWith('删除任务')).props.onClick(); ui.render(); assert.equal(ui.dialogOpen(), true);
    ui.setProps({ active: false }); const before = calls; ui.advance(20000); await ui.flush();
    assert.equal(ui.intervals(), 0); assert.equal(calls, before); assert.equal(ui.dialogOpen(), false);
    const writes = ui.writes(); ui.emit('onDownloadProgress', { id: 't1', progress: 98 }); ui.advance(250); await ui.flush();
    assert.equal(ui.writes(), writes, 'hidden page must ignore high frequency task events'); ui.unmount();
  });
  await test('reactivation refreshes series metadata and clears stale task selections', async () => {
    let list = [{ series_id: 'A', series_title: 'Old' }], tasks = [task(1)];
    const ui = mount({ getSeriesList: async () => list, getDownloadTasks: async () => tasks }); await ui.flush();
    openSeries(ui); rows(ui)[0].props.onClick(); ui.render();
    ui.setProps({ active: false }); list = [{ series_id: 'A', series_title: 'New' }]; tasks = [task(2)]; ui.setProps({ active: true }); await ui.flush();
    assert.ok(ui.text().includes('New')); assert.ok(!ui.text().includes('Old')); assert.equal(ui.button('删除选中').props.disabled, true); ui.unmount();
  });
  await test('progress events coalesce into one task update and keep the latest value', async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1)] }); await ui.flush(); openSeries(ui); const before = ui.writes();
    for (let progress = 1; progress <= 80; progress++) ui.emit('onDownloadProgress', { id: 't1', progress });
    assert.equal(ui.writes(), before, 'progress must wait for one short batch'); ui.advance(250); await ui.flush();
    assert.equal(ui.writes() - before, 1); assert.ok(ui.text().includes('80%')); ui.unmount();
  });
  await test('select-all covers every page and clears every selection', async () => {
    const ui = mount({ getDownloadTasks: async () => Array.from({ length: 205 }, (_, i) => task(i + 1, 'completed')) }); await ui.flush(); openSeries(ui);
    const all = ui.button('全选'); assert.ok(all, 'select-all must be visible beside task counts'); all.props.onClick(); ui.render();
    assert.ok(ui.text().includes('已选 205 项')); assert.ok(rows(ui).every(r => r.props.className.includes('selected')));
    ui.button('下一页').props.onClick(); ui.render(); ui.button('下一页').props.onClick(); ui.render();
    assert.equal(rows(ui).length, 5); assert.ok(rows(ui).every(r => r.props.className.includes('selected')));
    ui.button('取消全选').props.onClick(); ui.render(); assert.ok(rows(ui).every(r => !r.props.className.includes('selected'))); assert.equal(ui.button('删除选中').props.disabled, true);
    rows(ui)[0].props.onClick(); ui.render(); ui.button('全选').props.onClick(); ui.render(); assert.ok(ui.text().includes('已选 205 项')); ui.unmount();
  });
  await test('whole-series merge needs no checked tasks and identifies its series', async () => {
    let sent;
    const ui = mount({ getDownloadTasks: async () => [task(1, 'completed'), task(2, 'completed')], getSeriesList: async () => [{ series_id: 'A', series_title: '整部示例剧' }], getSeriesPipelineStatus: async () => ({ success: true, episodes: [{ episodeIndex: 1, status: 'deduped' }, { episodeIndex: 2, status: 'deduped' }] }), mergeSeries: async (...args) => { sent = args; return { success: true, count: 2, totalBytes: 1000 }; } }); await ui.flush();
    openSeries(ui); await ui.flush(); assert.ok(ui.text().includes('只使用已完成去重')); const merge = ui.button('分组并生成成品'); assert.ok(merge); assert.equal(!!merge.props.disabled, false);
    merge.props.onClick(); ui.render(); assert.ok(ui.text().includes('《整部示例剧》')); assert.ok(ui.text().includes('全部已下载集'));
    await ui.button('智能快速合并').props.onClick(); await ui.flush(); assert.equal(sent[0], 'A'); assert.equal(sent[2].compatible, false); ui.unmount();
  });
  await test('overview refreshes every downloaded series and reports newly added episodes', async () => {
    let calls = 0;
    const ui = mount({
      getDownloadTasks: async () => [task(1, 'completed')],
      getSeriesList: async () => [{ series_id: 'A', series_title: '待更新剧', total: 2 }],
      refreshAllSeries: async () => { calls++; return { success: true, total: 1, succeeded: 1, failed: 0, addedEpisodes: 3, results: [] }; },
    });
    await ui.flush();
    const refreshButton = ui.button('更新全部剧集');
    assert.ok(refreshButton); assert.equal(refreshButton.props.disabled, false);
    await refreshButton.props.onClick(); await ui.flush();
    assert.equal(calls, 1); assert.ok(ui.text().includes('新增 3 集')); ui.unmount();
  });
  await test('task list pages at 100 while global totals and cross-page selections persist', async () => {
    const ui = mount({ getDownloadTasks: async () => Array.from({ length: 205 }, (_, i) => task(i + 1, 'completed')) }); await ui.flush();
    openSeries(ui); assert.equal(rows(ui).length, 100); assert.ok(ui.text().includes('已完成 205'));
    rows(ui)[0].props.onClick(); ui.render(); ui.button('下一页').props.onClick(); ui.render(); assert.equal(rows(ui).length, 100);
    rows(ui)[0].props.onClick(); ui.render(); ui.button('删除选中').props.onClick(); ui.render(); assert.ok(ui.text().includes('共 2 个任务'));
    ui.button('取消').props.onClick(); ui.render(); ui.button('下一页').props.onClick(); ui.render(); assert.equal(rows(ui).length, 5); ui.unmount();
  });
  for (const rejected of [false, true]) await test(`delete ${rejected ? 'rejection' : 'failure response'} is visible and preserves selection`, async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1, 'completed')], deleteTasksWithFiles: async () => { if (rejected) throw new Error('删除失败示例'); return { success: false, error: '删除失败示例' }; } });
    await ui.flush(); openSeries(ui); rows(ui)[0].props.onClick(); ui.render(); ui.button('删除选中').props.onClick(); ui.render();
    await assert.doesNotReject(() => ui.button('仅删除记录').props.onClick(), 'delete rejection must become visible feedback'); await ui.flush();
    assert.ok(ui.text().includes('删除失败示例')); assert.ok(rows(ui)[0].props.className.includes('selected')); ui.unmount();
  });
  await test('merge cancellation only acknowledges the request and exposes failure', async () => {
    let fail = false;
    const ui = mount({ getDownloadTasks: async () => [task(1)], getMergeTasks: async () => [runningMerge()], cancelMerge: async () => fail ? { success: false, error: '取消请求失败' } : { success: true } }); await ui.flush();
    openSeries(ui); await ui.find(n => n.props.title === '取消合并').props.onClick(); await ui.flush();
    assert.ok(!ui.text().includes('已取消合并')); assert.ok(ui.text().includes('取消请求'));
    fail = true; await ui.find(n => n.props.title === '取消合并').props.onClick(); await ui.flush(); assert.ok(ui.text().includes('取消请求失败')); ui.unmount();
  });
  await test('unknown merge duration does not claim zero minutes', async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1, 'completed')], getSeriesList: async () => [{ series_id: 'A', series_title: 'A' }], getSeriesPipelineStatus: async () => ({ success: true, episodes: [{ episodeIndex: 1, status: 'deduped' }] }), mergeSeries: async () => ({ success: true, count: 2, totalBytes: 100000, totalDuration: 0 }) }); await ui.flush();
    openSeries(ui); await ui.flush(); ui.button('分组并生成成品').props.onClick(); ui.render(); await ui.button('智能快速合并').props.onClick(); await ui.flush();
    assert.ok(!ui.text().includes('0 分钟')); assert.ok(ui.text().includes('已提交 1 集合并任务')); ui.unmount();
  });
  await test('overview shows only series cards and live deduplicated download counts', async () => {
    const one = task(1, 'completed'), two = task(2);
    const other = { ...task(3, 'completed'), hongguoInfo: { series_id: 'xifan:A', series_title: '同名短剧', vid_index: 1 } };
    const ui = mount({ getDownloadTasks: async () => [one, two, { ...one, id: 'duplicate' }, other], getSeriesList: async () => [
      { series_id: 'A', series_title: '同名短剧', total: 17 },
      { series_id: 'xifan:A', series_title: '同名短剧', total: 20 },
      { series_id: 'browsed', series_title: '只浏览过' },
    ] }); await ui.flush();
    assert.equal(rows(ui).length, 0); assert.equal(ui.nodes().filter(n => n.props.className === 'browse-card').length, 2);
    assert.ok(ui.text().includes('已下载 1 / 17 集')); assert.ok(ui.text().includes('已下载 1 / 20 集')); assert.ok(!ui.text().includes('只浏览过'));
    assert.equal(ui.button('全选'), undefined); assert.equal(ui.button('分组并生成成品'), undefined);
    ui.emit('onDownloadCompleted', { id: 't2', path: '/sample.mp4' }); ui.advance(250); await ui.flush();
    assert.ok(ui.text().includes('已下载 2 / 17 集')); assert.equal(rows(ui).length, 0);
    openSeries(ui, 'series:xifan:A'); assert.equal(rows(ui).length, 1); assert.ok(ui.text().includes('第3集')); assert.ok(!ui.text().includes('第2集')); ui.unmount();
  });
  await test('series detail scopes batch controls, selections, deletion and merge records', async () => {
    const calls = [], a = [task(1, 'failed'), task(2, 'stopped')];
    const b = { ...task(3, 'failed'), hongguoInfo: { series_id: 'B', series_title: '另一部剧', vid_index: 1 } };
    const ui = mount({
      getDownloadTasks: async () => [...a, b],
      getMergeTasks: async () => [{ ...runningMerge(), seriesId: 'A', seriesTitle: '本剧合并' }, { ...runningMerge(), id: 'other', seriesId: 'B', seriesTitle: '别剧合并' }],
      resumeAll: async ids => { calls.push(['resume', ids]); return { success: true, count: ids.length }; },
      pauseAll: async ids => { calls.push(['pause', ids]); return { success: true, count: ids.length }; },
      retryTasks: async ids => { calls.push(['retry', ids]); return { success: true, count: ids.length }; },
      deleteTasksWithFiles: async (ids, files) => { calls.push(['delete', ids, files]); return { success: true, count: ids.length }; },
    }); await ui.flush(); openSeries(ui);
    assert.equal(rows(ui).length, 2); assert.ok(ui.text().includes('本剧合并')); assert.ok(!ui.text().includes('别剧合并'));
    await ui.button('开始本剧').props.onClick(); await ui.flush();
    ui.emit('onDownloadProgress', { id: 't1', progress: 10 }); ui.advance(250); await ui.flush();
    await ui.button('暂停本剧').props.onClick(); await ui.flush();
    await ui.button('重试失败').props.onClick(); await ui.flush();
    ui.button('全选').props.onClick(); ui.render(); ui.button('删除选中').props.onClick(); ui.render();
    await ui.button('仅删除记录').props.onClick(); await ui.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['resume', ['t1', 't2']], ['pause', ['t1', 't2']], ['retry', ['t1', 't2']], ['delete', ['t1', 't2'], false]]);
    ui.button('返回短剧列表').props.onClick(); ui.render(); openSeries(ui, 'series:B');
    assert.equal(rows(ui).length, 1); assert.equal(ui.button('删除选中').props.disabled, true); assert.ok(!rows(ui)[0].props.className.includes('selected')); ui.unmount();
  });
  await test('return preserves card page and search while resetting detail selection', async () => {
    const tasks = Array.from({ length: 35 }, (_, i) => ({ ...task(i + 1, 'completed'), hongguoInfo: { series_id: `s${i}`, series_title: `短剧${i}`, vid_index: 1 } }));
    const ui = mount({ getDownloadTasks: async () => tasks }); await ui.flush();
    assert.equal(ui.nodes().filter(n => n.props.className === 'browse-card').length, 30);
    ui.button('下一页').props.onClick(); ui.render();
    const card = ui.find(n => n.props.className === 'browse-card'), key = card.props['data-series-key'];
    openSeries(ui, key); rows(ui)[0].props.onClick(); ui.render(); ui.button('返回短剧列表').props.onClick(); ui.render();
    assert.equal(rows(ui).length, 0); assert.ok(ui.text().includes('第 2 / 2 页')); assert.equal(ui.nodes().filter(n => n.props.className === 'browse-card').length, 5);
    ui.find(n => n.props['aria-label'] === '搜索已添加的短剧').props.onChange({ target: { value: '短剧12' } }); ui.render();
    assert.equal(ui.nodes().filter(n => n.props.className === 'browse-card').length, 1); openSeries(ui, 'series:s12');
    assert.equal(ui.button('删除选中').props.disabled, true); ui.button('返回短剧列表').props.onClick(); ui.render();
    assert.equal(ui.find(n => n.props['aria-label'] === '搜索已添加的短剧').props.value, '短剧12'); ui.unmount();
  });
  await test('merge records remain accessible after all download records are cleared', async () => {
    let tasks = [task(1, 'completed')];
    const ui = mount({ getDownloadTasks: async () => tasks, getMergeTasks: async () => [runningMerge()], deleteTasksWithFiles: async () => { tasks = []; return { success: true, count: 1 }; } });
    await ui.flush(); openSeries(ui); ui.button('清空已完成').props.onClick(); ui.render();
    await ui.button('仅删除记录').props.onClick(); await ui.flush();
    ui.button('返回短剧列表').props.onClick(); ui.render();
    assert.equal(ui.nodes().filter(n => n.props.className === 'browse-card').length, 0);
    assert.ok(ui.find(n => n.props.title === '取消合并'), 'active merge must still be cancellable');
    ui.emit('onMergeProgress', { id: 'm', status: 'completed', output: '/out.mp4', outputName: 'out.mp4' }); ui.render();
    assert.ok(ui.find(n => n.props.title === '打开所在文件夹'), 'completed output must remain accessible'); ui.unmount();
  });
  await test('series opens an inline episode panel above its scoped video list', async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1), { ...task(2), hongguoInfo: { series_id: 'B', vid_index: 1 } }], getSeriesList: async () => [{ series_id: 'A', series_title: '完整剧名', cover: 'https://example.com/poster.jpg' }] }, { onNavigate: () => {} });
    await ui.flush();
    const panel = () => ui.find(n => n.type === 'SeriesEpisodePanel');
    assert.equal(panel(), undefined);
    openSeries(ui);
    assert.equal(panel().props.seriesId, 'A');
    assert.equal(panel().props.title, '完整剧名');
    assert.equal(panel().props.cover, 'https://example.com/poster.jpg');
    assert.equal(rows(ui).length, 1);
    assert.ok(ui.nodes().indexOf(panel()) < ui.nodes().indexOf(rows(ui)[0]), 'full episode picker must precede video rows');
    assert.equal(ui.find(n => n.props.role === 'dialog'), undefined, 'episode details are not a popup');
    assert.equal(ui.button('添加下载'), undefined, 'download selection happens within this page');
    const before = panel().props.revision;
    ui.emit('onDownloadProgress', { id: 't1', progress: 20 }); ui.advance(250); await ui.flush();
    assert.equal(panel().props.revision, before, 'progress ticks must not trigger disk rescans');
    ui.emit('onDownloadCompleted', { id: 't1' }); ui.advance(250); await ui.flush();
    assert.ok(panel().props.revision > before, 'completed status refreshes the episode overview');
    ui.setProps({ active: false }); assert.equal(panel().props.active, false);
    ui.button('返回短剧列表').props.onClick(); ui.render(); assert.equal(panel(), undefined); ui.unmount();
  });
  console.log(`Download manager: ${passed} passed, ${failures} failed`); process.exitCode = failures ? 1 : 0;
})();
