// AI 素材面板行为检查：只验证队列契约、独立任务入口和实时状态，不发起真实请求。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function mount(api = {}) {
  const slots = [], effects = [], cleanups = [];
  let cursor = 0; let tree;
  const changed = (old, deps) => !old || deps.some((value, index) => !Object.is(value, old[index]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef: initial => { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo: (fn, deps) => { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: fn() }; return slots[index].value; },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect: (fn, deps) => { const index = cursor++; if (changed(slots[index], deps)) { slots[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } },
  };
  const compile = name => {
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/${name}`, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
      module, exports: module.exports, require: request => request === 'react' ? react : request === './episodeRange' ? compile('episodeRange.js') : {},
      window: { electronAPI: api }, console,
    });
    return module.exports;
  };
  const Component = compile('AiMaterialsPanel.jsx').default;
  const props = { seriesId: 'A', title: '示例剧', cover: '/cover.jpg', active: true, episodes: [{ vid_index: 1, status: 'completed' }, { vid_index: 2, status: 'completed' }] };
  const render = () => { cursor = 0; tree = Component(props); effects.splice(0).forEach(effect => effect()); };
  const nodes = () => { const result = []; const walk = node => { if (!node || typeof node !== 'object') return; result.push(node); node.children?.forEach(walk); }; walk(tree); return result; };
  const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') || '';
  const find = predicate => nodes().find(predicate);
  render();
  return { render, nodes, text: () => textOf(tree), button: label => find(node => node.type === 'button' && textOf(node).includes(label)), flush: async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); render(); } }, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}

(async () => {
  let passed = 0; let failed = 0;
  const test = async (name, run) => { try { await run(); passed++; } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); } };

  await test('submits selected downloaded episodes as one background batch', async () => {
    let payload; let calls = 0;
    const ui = mount({ getAiMaterialTasks: async () => ({ success: true, tasks: [] }), aiStartCopies: async input => { payload = input; calls++; return { success: true, queued: 2, tasks: input.episodeIndices.map(index => ({ id: `c${index}`, kind: 'episode-copy', seriesId: 'A', episodeIndex: index, status: 'queued', stage: 'queued' })) }; } });
    await ui.flush(); assert.equal(ui.button('生成选中文案').props.disabled, false); await ui.button('生成选中文案').props.onClick(); await ui.flush();
    assert.equal(calls, 1); assert.deepEqual(payload.episodeIndices, [1, 2]); assert.ok(ui.text().includes('排队中')); ui.unmount();
  });

  await test('cover submission remains independent while copy batch is queued', async () => {
    const waiting = deferred(); let coverCalls = 0;
    const ui = mount({ getAiMaterialTasks: async () => ({ success: true, tasks: [] }), aiStartCopies: () => waiting.promise, aiGenerateCover: async () => { coverCalls++; return { success: true, task: { id: 'cover-1', kind: 'cover', seriesId: 'A', status: 'queued', stage: 'queued' } }; } });
    await ui.flush(); ui.button('全部已下载').props.onClick(); ui.render(); const copyRequest = ui.button('生成选中文案').props.onClick(); ui.render(); await ui.button('重绘封面').props.onClick();
    assert.equal(coverCalls, 1); waiting.resolve({ success: true, queued: 2, tasks: [] }); await copyRequest; ui.unmount();
  });

  await test('live backend stage is rendered without changing download state', async () => {
    let notify;
    const ui = mount({ getAiMaterialTasks: async () => ({ success: true, tasks: [{ id: 'c1', kind: 'episode-copy', seriesId: 'A', episodeIndex: 1, status: 'running', stage: 'extracting' }] }), onAiMaterialProgress: callback => { notify = callback; return () => {}; } });
    await ui.flush(); assert.ok(ui.text().includes('提取音频')); notify({ id: 'c1', kind: 'episode-copy', seriesId: 'A', episodeIndex: 1, status: 'running', stage: 'summarizing' }); ui.render(); assert.ok(ui.text().includes('AI 概括')); ui.unmount();
  });

  console.log(`AI materials panel: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
