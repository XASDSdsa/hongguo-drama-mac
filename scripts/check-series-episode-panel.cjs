// Component behavior checks without real files, network or Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function mount(api = {}, props = {}) {
  const slots = [], effects = [], cleanups = [], notices = [];
  let cursor = 0, tree, writes = 0;
  const changed = (old, deps) => !old || deps.some((value, index) => !Object.is(value, old[index]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { writes++; slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef: initial => { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo: (fn, deps) => { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: fn() }; return slots[index].value; },
    useCallback: (fn, deps) => react.useMemo(fn, deps),
    useEffect: (fn, deps) => { const index = cursor++; if (changed(slots[index], deps)) { slots[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } },
  };
  // useCallback stores the callback without invoking it.
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  const defaults = { getSeriesEpisodes: async () => response([]), searchResolve: async () => ({ success: true }), hongguoDownloadBatch: async () => ({ success: true, count: 1 }), playSeries: async () => ({ success: true }) };
  props = { seriesId: 'A', title: '示例剧', cover: '/poster.jpg', onNotify: (...args) => notices.push(args), ...props };
  const compile = name => {
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/${name}`, 'utf8'), { loader: name.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code, {
      module, exports: module.exports, require: name => name === 'react' ? react : name === './episodeRange' ? compile('episodeRange.js') : {},
      window: { electronAPI: { ...defaults, ...api } }, console,
    });
    return module.exports;
  };
  const Component = compile('SeriesEpisodePanel.jsx').default;
  const render = () => { cursor = 0; tree = Component(props); effects.splice(0).forEach(fn => fn()); };
  const nodes = () => { const result = []; const walk = node => { if (!node || typeof node !== 'object') return; result.push(node); node.children?.forEach(walk); }; walk(tree); return result; };
  const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') || '';
  const find = predicate => nodes().find(predicate);
  render();
  return {
    render, nodes, find, notices, writes: () => writes, text: () => textOf(tree),
    button: label => find(node => node.type === 'button' && textOf(node).includes(label)),
    episode: index => find(node => node.props['data-episode-index'] === index),
    flush: async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); render(); } },
    setProps: next => { props = { ...props, ...next }; render(); },
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}
const episode = (index, status = 'missing', extra = {}) => ({ vid: `vid${index}`, vid_index: index, title: `第${index}集`, status, ...extra });
const response = episodes => ({ success: true, data: { series_id: 'A', series_title: '示例剧', episodes, total: episodes.length } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const selected = ui => ui.nodes().filter(node => node.props['data-episode-index'] && node.props['aria-pressed']).map(node => node.props['data-episode-index']);

(async () => {
  let passed = 0, failed = 0;
  const test = async (name, run) => { try { await run(); passed++; } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); } };
  await test('all registered episodes render without tasks, cover falls back, no network or default selection', async () => {
    let remote = 0, reads = 0;
    const list = Array.from({ length: 309 }, (_, index) => episode(index + 1, index < 10 ? 'completed' : 'missing'));
    const ui = mount({ getSeriesEpisodes: async () => { reads++; return response(list); }, searchResolve: async () => { remote++; return { success: true }; } });
    await ui.flush();
    assert.equal(reads, 1); assert.equal(remote, 0);
    assert.equal(ui.nodes().filter(node => node.props['data-episode-index']).length, 309);
    assert.ok(ui.text().includes('共 309 集 · 已下载 10 集'));
    assert.ok(ui.episode(1).props.className.includes('completed')); assert.ok(ui.text().includes('已下载'));
    assert.equal(ui.find(node => node.type === 'img').props.src, '/poster.jpg');
    assert.deepEqual(selected(ui), []); assert.equal(ui.button('下载选中').props.disabled, true); ui.unmount();
  });
  await test('select/download excludes completed, active, locked and invalid episodes; deduplicates rapid clicks', async () => {
    const waiting = deferred(), calls = [];
    const list = [episode(1, 'completed'), episode(2, 'downloading'), episode(3, 'pending'), episode(4, 'missing', { locked: true }), episode(5), episode(6, 'failed'), episode(7, 'stopped'), episode(8, 'missing', { vid: '' }), episode(9, 'queued')];
    let changed = 0;
    const ui = mount({ getSeriesEpisodes: async () => response(list), hongguoDownloadBatch: async payload => { calls.push(payload); return waiting.promise; } }, { onDownloadsChanged: () => changed++ }); await ui.flush();
    ui.button('选择未下载').props.onClick(); ui.render(); assert.deepEqual(selected(ui), [5, 6, 7]);
    ui.episode(1).props.onClick(); ui.episode(4).props.onClick(); ui.render(); assert.deepEqual(selected(ui), [5, 6, 7]);
    const submit = ui.button('下载选中').props.onClick, one = submit(), two = submit();
    assert.equal(calls.length, 1); assert.deepEqual(Array.from(calls[0].episodes, ep => ep.vid_index), [5, 6, 7]);
    assert.ok(calls[0].episodes.every(ep => ep.cover === '/poster.jpg'));
    waiting.resolve({ success: true, count: 3 }); await Promise.all([one, two]); await ui.flush();
    assert.equal(changed, 1); assert.deepEqual(selected(ui), []); assert.ok(ui.text().includes('共 9 集')); ui.unmount();
  });
  await test('range handles Chinese commas and keeps selection on malformed input', async () => {
    const ui = mount({ getSeriesEpisodes: async () => response([episode(1, 'completed'), episode(2), episode(3, 'missing', { locked: true }), episode(4), episode(5)]) }); await ui.flush();
    const input = () => ui.find(node => node.props['aria-label'] === '选择下载集数');
    input().props.onChange({ target: { value: '1-3，5' } }); ui.render(); ui.button('应用').props.onClick(); ui.render(); assert.deepEqual(selected(ui), [2, 5]);
    input().props.onChange({ target: { value: 'bad' } }); ui.render(); ui.button('应用').props.onClick(); ui.render(); assert.deepEqual(selected(ui), [2, 5]); assert.ok(ui.text().includes('集数格式不正确')); ui.unmount();
  });
  await test('revision reads fresh status once and preserves only still available selections', async () => {
    let list = [episode(1), episode(2), episode(3)], reads = 0;
    const ui = mount({ getSeriesEpisodes: async () => { reads++; return response(list); } }); await ui.flush();
    ui.button('选择未下载').props.onClick(); ui.render();
    list = [episode(1, 'completed'), episode(2), episode(3, 'downloading')]; ui.setProps({ revision: 1 }); await ui.flush();
    assert.equal(reads, 2); assert.deepEqual(selected(ui), [2]); assert.equal(ui.episode(1).props['data-episode-status'], 'completed');
    ui.setProps({ revision: 1 }); await ui.flush(); assert.equal(reads, 2); ui.unmount();
  });
  await test('late response cannot replace a newer revision', async () => {
    const first = deferred(); let calls = 0;
    const ui = mount({ getSeriesEpisodes: () => ++calls === 1 ? first.promise : Promise.resolve(response([episode(1, 'completed')])) });
    ui.setProps({ revision: 1 }); await ui.flush(); first.resolve(response([episode(1)])); await ui.flush();
    assert.equal(ui.episode(1).props['data-episode-status'], 'completed'); ui.unmount();
  });
  await test('hidden panel ignores pending responses and revisions, reactivation reads fresh', async () => {
    const first = deferred(); let calls = 0;
    const ui = mount({ getSeriesEpisodes: () => ++calls === 1 ? first.promise : Promise.resolve(response([episode(2)])) });
    ui.setProps({ active: false, revision: 1 }); const before = ui.writes(); first.resolve(response([episode(1)])); await ui.flush();
    assert.equal(calls, 1); assert.equal(ui.writes(), before); assert.equal(ui.episode(1), undefined);
    ui.setProps({ active: true }); await ui.flush(); assert.equal(calls, 2); assert.ok(ui.episode(2)); ui.unmount();
  });
  await test('failed network update keeps local catalog and selection', async () => {
    const ui = mount({ getSeriesEpisodes: async () => response([episode(1, 'completed'), episode(2)]), searchResolve: async () => { throw new Error('离线'); } }); await ui.flush();
    ui.episode(2).props.onClick(); ui.render(); await ui.button('更新剧集').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('更新失败：离线')); assert.ok(ui.episode(1)); assert.deepEqual(selected(ui), [2]); ui.unmount();
  });
  await test('explicit update discovers new episodes and never starts a download', async () => {
    let list = [], downloads = 0, remote = 0;
    const ui = mount({ getSeriesEpisodes: async () => response(list), searchResolve: async () => { remote++; list = [episode(1), episode(2)]; return { success: true }; }, hongguoDownloadBatch: async () => { downloads++; return { success: true }; } }); await ui.flush();
    assert.ok(ui.text().includes('尚未保存分集信息')); await ui.button('更新剧集').props.onClick(); await ui.flush();
    assert.equal(remote, 1); assert.equal(downloads, 0); assert.ok(ui.episode(2)); assert.deepEqual(selected(ui), []); ui.unmount();
  });
  await test('navigating away suppresses delayed update callbacks', async () => {
    const waiting = deferred(); let reads = 0, changed = 0;
    const ui = mount({ getSeriesEpisodes: async () => { reads++; return response([episode(1)]); }, searchResolve: () => waiting.promise }, { onDownloadsChanged: () => changed++ }); await ui.flush();
    const operation = ui.button('更新剧集').props.onClick(); ui.unmount(); const before = ui.writes();
    waiting.resolve({ success: true }); await operation; await ui.flush();
    assert.equal(reads, 1); assert.equal(changed, 0); assert.equal(ui.notices.length, 0); assert.equal(ui.writes(), before);
  });
  await test('play prefers a downloaded episode and does not close the page', async () => {
    let sent;
    const ui = mount({ getSeriesEpisodes: async () => response([episode(1), episode(2, 'completed')]), playSeries: async payload => { sent = payload; return { success: true }; } }); await ui.flush();
    await ui.button('立即播放').props.onClick(); await ui.flush(); assert.equal(sent.vidIndex, 2); assert.ok(ui.episode(1)); ui.unmount();
  });
  console.log(`Series episode panel: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
