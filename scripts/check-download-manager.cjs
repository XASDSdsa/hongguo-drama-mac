// Download manager UI checks. No network, browser, media or real timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function mount(api = {}, props = {}) {
  const slots = [], effects = [], cleanups = [], events = new Map(), timers = new Map();
  let cursor = 0, tree, timerId = 0;
  const changed = (old, deps) => !old || deps.some((d, i) => !Object.is(d, old[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect: (fn, deps) => { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const defaults = {
    getDownloadTasks: async () => [], getSeriesList: async () => [], getQueueStatus: async () => ({ active: 0, queued: 0, maxConcurrent: 3 }),
    getSeriesPipelineStatus: async () => ({ success: true, episodes: [] }), getQuchongTasks: async () => [],
    quchongDefaults: async () => ({ jobs: 1 }), getSettings: async () => ({ root: '/videos' }),
    quchongStart: async () => ({ success: true, batchId: 'batch-1', tasks: [] }),
  };
  const window = { electronAPI: new Proxy({ ...defaults, ...api }, { get: (obj, key) => obj[key] || (key.startsWith('on') ? fn => { events.set(key, fn); return () => events.delete(key); } : async () => ({ success: true })) }) };
  const setTimer = (fn, delay, interval = false) => { const id = ++timerId; timers.set(id, { fn, delay, interval }); return id; };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/DownloadManager.jsx`, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
    module, exports: module.exports, require: name => name === 'react' ? react : name === './SeriesEpisodePanel' ? 'SeriesEpisodePanel' : name === './downloadSeries.mjs' ? require('../src/components/downloadSeries.mjs') : name === './useDialogKeyboard' ? () => {} : {}, window,
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
    unmount: () => cleanups.forEach(fn => fn?.()),
  };
}

const task = (i, status = 'completed', extra = {}) => ({ id: `t${i}`, title: `第${i}集`, status, progress: status === 'completed' ? 100 : 0, savePath: `/videos/第${i}集.mp4`, startTime: i, hongguoInfo: { series_id: 'A', series_title: '示例剧', vid_index: i }, ...extra });
const rows = ui => ui.nodes().filter(n => /^dm-task(?: selected)?$/.test((n.props.className || '').trim()));
const openSeries = ui => { const card = ui.find(n => n.props['data-series-key'] === 'series:A'); assert.ok(card); card.props.onClick(); ui.render(); };

(async () => {
  let failures = 0, passed = 0;
  const test = async (name, fn) => { if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return; try { await fn(); passed++; } catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); } };

  await test('overview keeps series cards and removes old batch controls', async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 10 }] });
    await ui.flush();
    assert.equal(ui.nodes().filter(n => n.props.className === 'browse-card').length, 1);
    assert.equal(ui.button('开始本剧'), undefined); assert.equal(ui.button('暂停本剧'), undefined); assert.equal(ui.button('更多操作'), undefined); assert.equal(ui.button('分组并生成成品'), undefined);
    ui.unmount();
  });

  await test('series detail has only the one-click dedup action', async () => {
    const ui = mount({ getDownloadTasks: async () => [task(1), task(2, 'downloading')], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 2 }] });
    await ui.flush(); openSeries(ui); await ui.flush();
    assert.ok(ui.button('一键去重')); assert.ok(ui.text().includes('去重：未去重')); assert.ok(ui.text().includes('去重：等待下载'));
    assert.equal(ui.button('开始本剧'), undefined); assert.equal(ui.button('暂停本剧'), undefined); assert.equal(ui.button('重试失败'), undefined); assert.equal(ui.button('更多操作'), undefined); assert.equal(ui.button('分组并生成成品'), undefined);
    ui.unmount();
  });

  await test('one-click dedup submits only completed undeduped source files', async () => {
    let payload;
    const ui = mount({
      getDownloadTasks: async () => [task(1), task(2, 'failed'), task(3, 'completed')],
      getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 3 }],
      getSeriesPipelineStatus: async () => ({ success: true, episodes: [{ episodeIndex: 1, status: 'missing' }, { episodeIndex: 3, status: 'deduped' }] }),
      quchongStart: async value => { payload = value; return { success: true, batchId: 'batch-1', tasks: [{ id: 'q1', src: '/videos/第1集.mp4', status: 'pending', progress: 0 }] }; },
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.deepEqual(payload.sources, ['/videos/第1集.mp4']); assert.equal(payload.outputDir, '/videos/红果短剧/处理后/示例剧'); ui.unmount();
  });

  await test('dedup progress is rendered on the matching video row', async () => {
    const ui = mount({
      getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 1 }],
      quchongStart: async () => ({ success: true, batchId: 'batch-1', tasks: [{ id: 'q1', src: '/videos/第1集.mp4', status: 'pending', progress: 0 }] }),
    });
    await ui.flush(); openSeries(ui); await ui.flush(); await ui.button('一键去重').props.onClick(); await ui.flush();
    ui.emit('onQuchongProgress', { batchId: 'batch-1', taskId: 'q1', progress: 47, stage: 'processing' }); await ui.flush();
    assert.ok(ui.text().includes('去重中')); assert.ok(ui.text().includes('47%')); assert.ok(ui.find(n => n.props.role === 'progressbar' && n.props['aria-valuenow'] === 47)); ui.unmount();
  });

  await test('completed and failed dedup states remain visible', async () => {
    const ui = mount({
      getDownloadTasks: async () => [task(1), task(2)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 2 }],
      getQuchongTasks: async () => [{ id: 'batch-old', tasks: [{ id: 'q1', src: '/videos/第1集.mp4', status: 'completed', progress: 100 }, { id: 'q2', src: '/videos/第2集.mp4', status: 'failed', error: '测试失败' }] }],
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    assert.ok(ui.text().includes('去重：已去重')); assert.ok(ui.text().includes('去重：去重失败')); ui.unmount();
  });

  console.log(`Download manager: ${passed} passed, ${failures} failed`); process.exitCode = failures ? 1 : 0;
})();
