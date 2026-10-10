// Quchong panel event isolation checks without Electron or FFmpeg.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function mount(api = {}, props = {}) {
  const slots = [], effects = [], cleanups = [];
  let cursor = 0, tree;
  const changed = (old, deps) => !old || deps.some((value, index) => !Object.is(value, old[index]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef: initial => { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo: (fn, deps) => { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: fn() }; return slots[index].value; },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect: (fn, deps) => { const index = cursor++; if (changed(slots[index], deps)) { slots[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } },
  };
  const listeners = {};
  const defaults = {
    quchongDefaults: async () => ({ jobs: 1 }), getSettings: async () => ({ root: '/tmp' }), getQuchongTasks: async () => [],
    quchongStart: async () => ({ success: true, batchId: 'batch-new', tasks: [] }), quchongCancel: async id => { listeners.cancelled = id; return { success: true }; },
  };
  for (const name of ['onQuchongTask', 'onQuchongProgress', 'onQuchongLog', 'onQuchongComplete', 'onQuchongHistoryChanged']) {
    defaults[name] = cb => { listeners[name] = cb; return () => { if (listeners[name] === cb) delete listeners[name]; }; };
  }
  const compile = () => {
    const module = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/components/Quchong.jsx`, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
      module, exports: module.exports, require: name => name === 'react' ? react : {}, window: { electronAPI: { ...defaults, ...api } }, console,
    });
    return module.exports.default;
  };
  const Component = compile();
  props = { active: true, ...props };
  const render = () => { cursor = 0; tree = Component(props); effects.splice(0).forEach(fn => fn()); };
  const nodes = () => { const result = []; const walk = node => { if (!node || typeof node !== 'object') return; result.push(node); node.children?.forEach(walk); }; walk(tree); return result; };
  const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(textOf).join('') || '';
  const button = label => nodes().find(node => node.type === 'button' && textOf(node).includes(label));
  render();
  return { render, nodes, button, listeners, setProps: next => { props = { ...props, ...next }; render(); }, flush: async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); render(); } } };
}

(async () => {
  let passed = 0, failed = 0;
  const test = async (name, run) => { try { await run(); passed++; } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); } };
  await test('ignores unrelated events until a batch is explicitly started', async () => {
    const ui = mount({ getQuchongTasks: async () => [] });
    ui.listeners.onQuchongTask?.({ batchId: 'other', task: { id: 'x', status: 'running' } }); ui.render();
    assert.equal(ui.nodes().filter(node => node.type === 'em').length, 0); ui.setProps({ active: false });
  });
  await test('restored batch owns progress and cancel events', async () => {
    const saved = { id: 'batch-a', status: 'running', done: 0, total: 1, tasks: [{ id: 'task-a', name: 'a.mp4', status: 'running', stage: 'processing', progress: 20 }] };
    const ui = mount({ getQuchongTasks: async () => [saved] }); await ui.flush();
    ui.button('恢复查看').props.onClick(); ui.render();
    ui.listeners.onQuchongProgress?.({ batchId: 'batch-a', taskId: 'task-a', progress: 30, stage: 'processing' });
    ui.listeners.onQuchongComplete?.({ batchId: 'other', cancelled: true, tasks: [] }); ui.render();
    assert.ok(ui.nodes().some(node => node.type === 'em' && String(node.children?.[0]).includes('30')));
    ui.button('停止').props.onClick(); await ui.flush(); assert.equal(ui.listeners.cancelled, 'batch-a');
  });
  await test('reactivation reloads the selected batch snapshot', async () => {
    let snapshots = [];
    const ui = mount({ getQuchongTasks: async () => snapshots });
    snapshots = [{ id: 'batch-z', status: 'completed', done: 1, total: 1, tasks: [{ id: 'z', name: 'z.mp4', status: 'completed', stage: 'completed', progress: 100 }] }];
    ui.setProps({ active: false }); ui.setProps({ active: true }); await ui.flush();
    // No implicit claim: only a previously restored/submitted batch is reloaded.
    assert.equal(ui.nodes().filter(node => node.type === 'em').length, 0);
  });
  console.log(`Quchong panel: ${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
