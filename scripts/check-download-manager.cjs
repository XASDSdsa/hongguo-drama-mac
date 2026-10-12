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
    quchongDefaults: async () => ({ jobs: 1 }), quchongSetConcurrency: async () => ({ success: true, jobs: 1 }), getSettings: async () => ({ root: '/videos' }),
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
    assert.deepEqual(payload.sources, ['/videos/第1集.mp4']); assert.equal(payload.opts.jobs, 1); assert.equal(payload.outputDir, '/videos/红果短剧/处理后/示例剧'); ui.unmount();
  });

  await test('dedup concurrency is loaded, saved and submitted', async () => {
    let savedJobs = null, payload;
    const ui = mount({
      getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 1 }],
      quchongDefaults: async () => ({ jobs: 4 }), quchongSetConcurrency: async jobs => { savedJobs = jobs; return { success: true, jobs }; },
      quchongStart: async value => { payload = value; return { success: true, batchId: 'batch-jobs', tasks: [] }; },
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    const select = ui.find(node => node.type === 'select' && node.props['aria-label'] === '去重并发数');
    assert.ok(select); assert.equal(select.props.value, 4);
    select.props.onChange({ target: { value: '6' } }); await ui.flush();
    assert.equal(savedJobs, 6); assert.equal(ui.find(node => node.type === 'select' && node.props['aria-label'] === '去重并发数').props.value, 6);
    ui.emit('onQuchongConcurrencyChanged', { jobs: 8 }); await ui.flush();
    assert.equal(ui.find(node => node.type === 'select' && node.props['aria-label'] === '去重并发数').props.value, 8);
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.equal(payload.opts.jobs, 8); ui.unmount();
  });

  await test('running and queued counts are shown separately and a new batch can be appended', async () => {
    let payload;
    const ui = mount({
      getDownloadTasks: async () => [task(1), task(2), task(3), task(4)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 4 }],
      getQuchongTasks: async () => [{ id: 'batch-old', createdAt: 20, tasks: [{ id: 'q1', src: '/videos/第1集.mp4', status: 'running', stage: 'encoding' }, { id: 'q2', src: '/videos/第2集.mp4', status: 'processing', stage: 'processing' }, { id: 'q3', src: '/videos/第3集.mp4', status: 'pending' }] }],
      quchongStart: async value => { payload = value; return { success: true, batchId: 'batch-new', tasks: [{ id: 'q4', src: '/videos/第4集.mp4', status: 'pending' }] }; },
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    assert.ok(ui.text().includes('处理中 2')); assert.ok(ui.text().includes('等待 1'));
    assert.equal(ui.button('一键去重').props.disabled, false);
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.deepEqual(payload.sources, ['/videos/第4集.mp4']);
    assert.equal(ui.button('一键去重').props.disabled, true);
    assert.ok(ui.text().includes('等待 2')); assert.ok(!ui.text().includes('提交中'));
    ui.unmount();
  });

  await test('duplicate download records count and submit each source once', async () => {
    let payload;
    const ui = mount({
      getDownloadTasks: async () => [task(1), { ...task(1), id: 't1-copy' }, task(2), { ...task(2), id: 't2-copy' }],
      getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 2 }],
      getQuchongTasks: async () => [{ id: 'batch-old', createdAt: 20, tasks: [{ id: 'q1', src: '/videos/第1集.mp4', status: 'running', stage: 'encoding' }] }],
      quchongStart: async value => { payload = value; return { success: true, batchId: 'batch-new', tasks: [] }; },
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    assert.ok(ui.text().includes('处理中 1'));
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.deepEqual(payload.sources, ['/videos/第2集.mp4']);
    ui.unmount();
  });

  await test('newest snapshot wins when a source has multiple batches', async () => {
    const ui = mount({
      getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 1 }],
      getQuchongTasks: async () => [
        { id: 'batch-new', createdAt: 20, tasks: [{ id: 'new', src: '/videos/第1集.mp4', status: 'completed', stage: 'completed', progress: 100 }] },
        { id: 'batch-old', createdAt: 10, tasks: [{ id: 'old', src: '/videos/第1集.mp4', status: 'pending', stage: 'queued', progress: 0 }] },
      ],
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    assert.ok(ui.text().includes('去重：已去重')); assert.ok(!ui.text().includes('等待去重')); assert.ok(ui.button('一键去重').props.disabled); ui.unmount();
  });

  await test('concurrency loading and saving block submission and failed saves retain the current value', async () => {
    let resolveDefaults, resolveSave;
    const ui = mount({
      getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 1 }],
      quchongDefaults: () => new Promise(resolve => { resolveDefaults = resolve; }),
      quchongSetConcurrency: () => new Promise(resolve => { resolveSave = resolve; }),
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    const select = () => ui.find(node => node.type === 'select' && node.props['aria-label'] === '去重并发数');
    assert.ok(select().props.disabled); assert.ok(ui.button('一键去重').props.disabled);
    resolveDefaults({ jobs: 4 }); await ui.flush();
    assert.equal(select().props.value, 4); assert.equal(select().props.disabled, false);
    select().props.onChange({ target: { value: '6' } }); await ui.flush();
    assert.ok(select().props.disabled); assert.ok(ui.button('一键去重').props.disabled);
    resolveSave({ success: false, error: '测试保存失败' }); await ui.flush();
    assert.equal(select().props.value, 4); assert.equal(select().props.disabled, false);
    assert.equal(ui.button('一键去重').props.disabled, false); assert.ok(ui.text().includes('测试保存失败'));
    ui.unmount();
  });

  await test('a late defaults response does not overwrite a live concurrency change', async () => {
    let resolveDefaults;
    const ui = mount({
      getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 1 }],
      quchongDefaults: () => new Promise(resolve => { resolveDefaults = resolve; }),
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    ui.emit('onQuchongConcurrencyChanged', { jobs: 6 }); await ui.flush();
    resolveDefaults({ jobs: 2 }); await ui.flush();
    assert.equal(ui.find(node => node.type === 'select' && node.props['aria-label'] === '去重并发数').props.value, 6);
    ui.unmount();
  });

  await test('submission lock is released while an earlier batch is still running', async () => {
    const payloads = [];
    let downloads = [task(1), task(2, 'downloading')];
    const ui = mount({
      getDownloadTasks: async () => downloads, getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 2 }],
      quchongStart: async value => {
        payloads.push(value);
        return { success: true, batchId: `batch-${payloads.length}`, tasks: value.sources.map((src, index) => ({ id: `q${payloads.length}-${index}`, src, status: 'running', stage: 'encoding', updatedAt: Date.now() })) };
      },
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.ok(!ui.text().includes('提交中'));
    downloads = [task(1), task(2)];
    ui.emit('onDownloadCompleted', task(2)); ui.advance(200); await ui.flush();
    assert.equal(ui.button('一键去重').props.disabled, false);
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.deepEqual(payloads.map(payload => payload.sources), [['/videos/第1集.mp4'], ['/videos/第2集.mp4']]);
    ui.emit('onQuchongComplete', { batchId: 'unrelated', success: true }); await ui.flush();
    assert.ok(!ui.text().includes('本批视频去重完成'));
    ui.emit('onQuchongComplete', { batchId: 'batch-1', success: true }); await ui.flush();
    assert.ok(ui.text().includes('本批视频去重完成'));
    ui.emit('onQuchongComplete', { batchId: 'batch-2', success: false }); await ui.flush();
    assert.ok(ui.text().includes('本批去重结束，部分视频失败'));
    ui.unmount();
  });

  await test('a refresh keeps a newer live completed event and never resubmits its source', async () => {
    let payload;
    const ui = mount({
      getDownloadTasks: async () => [task(1), task(2)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 2 }],
      getQuchongTasks: async () => [{ id: 'batch-1', createdAt: 10, tasks: [{ id: 'q1', src: '/videos/第1集.mp4', status: 'running', stage: 'encoding', progress: 40, updatedAt: 20 }] }],
      quchongStart: async value => { payload = value; return { success: true, batchId: 'batch-2', tasks: [] }; },
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    ui.emit('onQuchongTask', { batchId: 'batch-1', task: { id: 'q1', src: '/videos/第1集.mp4', status: 'completed', stage: 'completed', progress: 100, updatedAt: 30 } }); await ui.flush();
    ui.advance(15000); await ui.flush();
    assert.ok(ui.text().includes('去重：已去重')); assert.ok(!ui.text().includes('40%'));
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.deepEqual(payload.sources, ['/videos/第2集.mp4']); ui.unmount();
  });

  await test('a live running event arriving during submission is not replaced by its pending response', async () => {
    let emitRunning;
    const ui = mount({
      getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 1 }],
      quchongStart: async () => {
        emitRunning();
        return { success: true, batchId: 'batch-1', tasks: [{ id: 'q1', src: '/videos/第1集.mp4', status: 'pending', stage: 'queued', progress: 0 }] };
      },
    });
    emitRunning = () => ui.emit('onQuchongTask', { batchId: 'batch-1', task: { id: 'q1', src: '/videos/第1集.mp4', status: 'running', stage: 'encoding', progress: 12, updatedAt: 25 } });
    await ui.flush(); openSeries(ui); await ui.flush();
    await ui.button('一键去重').props.onClick(); await ui.flush();
    assert.ok(ui.text().includes('处理中 1')); assert.ok(ui.text().includes('12%')); assert.ok(!ui.text().includes('去重：等待去重'));
    ui.unmount();
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

  await test('finalization remains running without claiming a percent or allowing duplicate submission', async () => {
    const runtime = { id: 'q1', src: '/videos/第1集.mp4', status: 'running', stage: 'encoding', progress: 98 };
    const ui = mount({
      getDownloadTasks: async () => [task(1)], getSeriesList: async () => [{ series_id: 'A', series_title: '示例剧', total: 1 }],
      getQuchongTasks: async () => [{ id: 'batch-a', tasks: [runtime] }],
    });
    await ui.flush(); openSeries(ui); await ui.flush();
    assert.ok(ui.text().includes('98%'));
    for (const [stage, label] of [['finalizing', '写入 MP4 索引'], ['validating', '校验输出'], ['saving', '保存文件']]) {
      ui.emit('onQuchongTask', { batchId: 'batch-a', task: { ...runtime, stage } }); await ui.flush();
      assert.ok(ui.text().includes(`去重：${label}`));
      assert.ok(!ui.text().includes('98%'));
      assert.ok(!ui.text().includes('去重：已去重'));
      assert.ok(ui.button('一键去重').props.disabled);
      assert.ok(ui.find(node => node.props.role === 'progressbar' && node.props['aria-valuenow'] === undefined && node.props['aria-valuetext'] === label));
    }
    ui.unmount();
  });

  console.log(`Download manager: ${passed} passed, ${failures} failed`); process.exitCode = failures ? 1 : 0;
})();
