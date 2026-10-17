// Run: node scripts/check-player-resume.cjs [name-filter]. In-memory media only; no playback/network/files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');
const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/Player.jsx'), 'utf8'), {
  loader: 'jsx',
  format: 'cjs',
}).code;

function mount({ local = false, saved = null, transcode, prepare, props = {} } = {}) {
  const slots = [],
    effects = [],
    cleanups = [],
    saves = [],
    prepares = [],
    transcodes = [],
    cancelled = [];
  const events = new Map(),
    mediaEvents = new Map(),
    timers = new Map();
  let cursor = 0,
    tree,
    timerId = 0,
    oldSrc = '',
    oldKey;
  let transcodeProgress;
  const media = {
    currentTime: 0,
    duration: 100,
    readyState: 0,
    videoWidth: 640,
    paused: false,
    play: async () => {
      media.paused = false;
    },
    pause: () => {
      media.paused = true;
    },
    load: () => {
      media.currentTime = 0;
      media.readyState = 0;
      media.currentSrc = '';
      media.paused = true;
    },
    addEventListener: (name, fn) => mediaEvents.set(name, fn),
    removeEventListener: (name) => mediaEvents.delete(name),
  };
  const changed = (old, deps) => !old || deps.some((d, i) => !Object.is(d, old[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (v) => {
          slots[i] = typeof v === 'function' ? v(slots[i]) : v;
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
    useCallback: (fn, deps) => react.useMemo(fn, deps),
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
  // useCallback returns the callback, unlike useMemo.
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  const episodes = [1, 2].map((n) => ({
    vid_index: n,
    vid: `v${n}`,
    status: local ? 'completed' : 'missing',
    ...(local ? { fileUrl: `file:///mock-${n}.mp4`, savePath: `/mock-${n}.mp4` } : {}),
  }));
  const api = {
    getSeriesList: async () => [{ series_id: 'A' }],
    getSeriesEpisodes: async () => ({
      success: true,
      data: { series_id: 'A', series_title: '测试剧', total: 2, episodes },
    }),
    getPlaybackPosition: async () => saved,
    savePlaybackPosition: async (...args) => saves.push(args),
    prepareOnlinePlay: async (p) => {
      prepares.push(p);
      return prepare ? prepare(p) : { success: true, url: `hongguo-stream://mock-${prepares.length}` };
    },
    transcodeForPlayback: async (p) => {
      transcodes.push(p);
      return transcode ? transcode(p) : { success: true, url: 'file:///mock-compat.mp4' };
    },
    cancelTranscodeForPlayback: async (p) => cancelled.push(p),
    onTranscodeProgress: (fn) => {
      transcodeProgress = fn;
      return () => {
        transcodeProgress = null;
      };
    },
    getSettings: async () => ({ compat_mode: true }),
    compatCacheStatus: async () => ({ success: true, files: 1, bytes: 10 }),
    clearCompatCache: async () => ({ success: true, count: 1 }),
    clearOnlineCache: async () => ({ success: true }),
  };
  const window = {
    electronAPI: new Proxy(api, { get: (o, k) => o[k] || (k.startsWith('on') ? () => () => {} : async () => ({})) }),
    addEventListener: (k, f) => events.set(k, f),
    removeEventListener: (k) => events.delete(k),
  };
  const setTimer = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, delay });
    return id;
  };
  const context = {
    module: { exports: {} },
    require: (n) => (n === 'react' ? react : n === './useDialogKeyboard' ? () => {} : {}),
    window,
    document: { querySelector: () => null },
    navigator: {},
    crypto: require('node:crypto').webcrypto,
    setTimeout: setTimer,
    clearTimeout: (id) => timers.delete(id),
    setInterval: setTimer,
    clearInterval: (id) => timers.delete(id),
    console,
  };
  context.exports = context.module.exports;
  vm.runInNewContext(source, context);
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
  const find = (fn) => nodes().find(fn);
  const text = (n) =>
    typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') || '';
  const render = () => {
    cursor = 0;
    tree = context.module.exports.default(props);
    const video = find((n) => n.type === 'video');
    if (video) {
      if (video.props.src !== oldSrc || video.props.key !== oldKey) {
        media.load();
        oldSrc = video.props.src;
        oldKey = video.props.key;
      }
      media.src = video.props.src;
      video.props.ref.current = media;
    } else for (const slot of slots) if (slot?.current === media) slot.current = null;
    effects.splice(0).forEach((fn) => fn());
    return tree;
  };
  const flush = async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      render();
    }
  };
  const metadata = () => {
    media.readyState = 1;
    media.currentSrc = media.src;
    find((n) => n.type === 'video')?.props.onLoadedMetadata?.({ currentTarget: media });
    mediaEvents.get('loadedmetadata')?.();
  };
  render();
  return {
    props,
    render,
    flush,
    find,
    media,
    metadata,
    saves,
    prepares,
    transcodes,
    cancelled,
    events,
    timers,
    transcodeProgress: (payload) => transcodeProgress?.(payload),
    button: (label) => find((n) => n.type === 'button' && text(n).includes(label)),
    episode: (n) => find((x) => x.props['aria-label'] === `第 ${n} 集`).props.onClick(),
    error: (code) =>
      find((n) => n.type === 'video').props.onError({ currentTarget: Object.assign(media, { error: { code } }) }),
    unmount: () => cleanups.forEach((fn) => fn?.()),
  };
}

(async () => {
  let failures = 0;
  const test = async (name, fn) => {
    if (process.argv[2] && !name.includes(process.argv[2])) return;
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e) {
      failures++;
      console.error(`FAIL ${name}: ${e.stack}`);
    }
  };
  await test('saved online episode resumes after metadata', async () => {
    const ui = mount({ saved: { vid_index: 2, currentTime: 34 } });
    await ui.flush();
    assert.equal(ui.prepares.at(-1)?.vidIndex, 2, 'saved online episode must be prepared');
    ui.metadata();
    assert.equal(ui.media.currentTime, 34);
    ui.unmount();
  });
  await test('local episode saves exact position before switching and on hide', async () => {
    const ui = mount({ local: true, saved: { vid_index: 1, currentTime: 21 } });
    await ui.flush();
    ui.metadata();
    assert.equal(ui.media.currentTime, 21);
    ui.media.currentTime = 22.2;
    ui.episode(2);
    assert.ok(
      ui.saves.some((p) => p[1] === 1 && p[2] === 22.2),
      'switch must save latest second',
    );
    await ui.flush();
    ui.metadata();
    ui.media.currentTime = 1.2;
    ui.props.active = false;
    ui.render();
    assert.ok(
      ui.saves.some((p) => p[1] === 2 && p[2] === 1.2),
      'hide must bypass periodic save threshold',
    );
    assert.equal(ui.events.has('keydown'), false, 'hidden player must not capture keys');
    assert.equal(
      [...ui.timers.values()].some((t) => t.delay === 2000),
      false,
      'hidden idle detail polling must stop',
    );
    ui.unmount();
  });
  await test('online decoding error auto-falls back once and retains time', async () => {
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } } });
    await ui.flush();
    ui.metadata();
    ui.media.currentTime = 27;
    ui.error(3);
    ui.error(3);
    await ui.flush();
    assert.equal(ui.transcodes.length, 1);
    assert.equal(ui.find((n) => n.type === 'video').props.src, 'file:///mock-compat.mp4');
    ui.metadata();
    assert.equal(ui.media.currentTime, 27);
    ui.error(4);
    await ui.flush();
    assert.equal(ui.transcodes.length, 1, 'compat errors must not loop');
    assert.ok(ui.button('重试本集'), 'compat failure must offer explicit retry');
    ui.find((n) => n.props.className?.includes('series-picker-btn')).props.onClick();
    await ui.flush();
    await ui.button('清空转码缓存').props.onClick();
    await ui.flush();
    assert.ok(
      ui.find((n) => n.type === 'video'),
      'cache clear keeps the fullscreen node',
    );
    assert.equal(ui.media.paused, true, 'cleared cached media must stop safely');
    assert.ok(ui.button('重试本集'), 'cache clear must offer explicit recovery');
    await ui.button('重试本集').props.onClick();
    await ui.flush();
    ui.metadata();
    assert.equal(ui.media.currentTime, 27, 'retry after clearing current cache retains position');
    ui.unmount();
  });
  await test('failed automatic transcode does not loop on repeated decode events', async () => {
    const ui = mount({ local: true, transcode: async () => ({ success: false, error: 'mock failure' }) });
    await ui.flush();
    ui.metadata();
    ui.error(4);
    await ui.flush();
    ui.error(4);
    await ui.flush();
    assert.equal(ui.transcodes.length, 1);
    assert.ok(ui.button('转码后播放'));
    ui.unmount();
    let resolve;
    const pending = mount({
      local: true,
      transcode: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    await pending.flush();
    pending.metadata();
    pending.error(3);
    await pending.flush();
    assert.ok(pending.button('取消转码'));
    pending.episode(2);
    await pending.flush();
    assert.equal(pending.cancelled[0]?.vidIndex, 1, 'switch must cancel old transcode');
    resolve({ success: true, url: 'file:///late-compat.mp4' });
    await pending.flush();
    assert.equal(pending.find((n) => n.type === 'video').props.src, 'file:///mock-2.mp4');
    pending.unmount();
  });
  await test('local loading failure exposes retry and preserves the second', async () => {
    const ui = mount({ local: true });
    await ui.flush();
    ui.metadata();
    ui.media.currentTime = 42;
    ui.error(2);
    await ui.flush();
    assert.ok(ui.button('重试本集'));
    await ui.button('重试本集').props.onClick();
    await ui.flush();
    ui.metadata();
    assert.equal(ui.media.currentTime, 42);
    ui.find((n) => n.props.className?.includes('series-picker-btn')).props.onClick();
    await ui.flush();
    await ui.button('清空播放缓存').props.onClick();
    await ui.flush();
    assert.equal(
      ui.find((n) => n.type === 'video').props.src,
      'file:///mock-1.mp4',
      'clearing online cache must not interrupt local media',
    );
    assert.equal(ui.media.currentTime, 42);
    ui.unmount();
  });
  await test('transcode request identity ignores old progress and cancels the original request', async () => {
    const ui = mount({ local: true, transcode: () => new Promise(() => {}) });
    await ui.flush();
    ui.metadata();
    ui.error(3);
    await ui.flush();
    const first = ui.transcodes[0];
    ui.button('取消转码').props.onClick();
    await ui.flush();
    await ui.button('重试本集').props.onClick();
    await ui.flush();
    ui.metadata();
    ui.error(3);
    await ui.flush();
    const second = ui.transcodes[1];
    assert.ok(second, 'retry must create a second request for the same episode');
    const progress = (request, percent) =>
      ui.transcodeProgress({ seriesId: 'A', vidIndex: 1, requestId: request.requestId, percent });
    progress(second, 20);
    ui.render();
    assert.equal(ui.find((n) => n.props.className === 'player-wait-fill').props.style.width, '20%');
    progress(first, 87);
    ui.render();
    assert.equal(
      ui.find((n) => n.props.className === 'player-wait-fill').props.style.width,
      '20%',
      'old request must not overwrite retry progress',
    );
    assert.ok(
      first.requestId && second.requestId && first.requestId !== second.requestId,
      'each attempt needs a unique request ID',
    );
    assert.equal(ui.cancelled[0].requestId, first.requestId, 'cancel must carry the original request snapshot');
    ui.unmount();
    assert.equal(ui.cancelled[1].requestId, second.requestId, 'unmount cancels only the current request');
  });
  await test('fullscreen playback keeps the video key across local auto-next and compatibility changes', async () => {
    const ui = mount({ local: true });
    await ui.flush();
    ui.metadata();
    const key = ui.find((n) => n.type === 'video').props.key;
    ui.find((n) => n.type === 'video').props.onEnded();
    await ui.flush();
    assert.equal(
      ui.find((n) => n.type === 'video').props.key,
      key,
      'auto-next must not replace the fullscreen video element',
    );
    assert.equal(ui.find((n) => n.type === 'video').props.src, 'file:///mock-2.mp4');
    ui.metadata();
    ui.error(3);
    await ui.flush();
    assert.equal(
      ui.find((n) => n.type === 'video').props.key,
      key,
      'compatibility source swap must not replace the fullscreen video element',
    );
    assert.equal(ui.find((n) => n.type === 'video').props.src, 'file:///mock-compat.mp4');
    ui.unmount();
  });
  await test('fullscreen playback retains video and last source while the next online episode prepares', async () => {
    let finishNext;
    const ui = mount({
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      prepare: (p) =>
        p.vidIndex === 1
          ? { success: true, url: 'hongguo-stream://one' }
          : new Promise((r) => {
              finishNext = r;
            }),
    });
    await ui.flush();
    ui.metadata();
    const first = ui.find((n) => n.type === 'video');
    first.props.onEnded();
    await ui.flush();
    const preparing = ui.find((n) => n.type === 'video');
    assert.ok(preparing, 'preparing the next episode must not unmount the fullscreen video');
    assert.equal(preparing.props.key, first.props.key);
    assert.equal(preparing.props.src, first.props.src, 'retain the ended frame until the next source is ready');
    finishNext({ success: true, url: 'hongguo-stream://two' });
    await ui.flush();
    assert.equal(ui.find((n) => n.type === 'video').props.key, first.props.key);
    assert.equal(ui.find((n) => n.type === 'video').props.src, 'hongguo-stream://two');
    ui.unmount();
  });
  process.exitCode = failures ? 1 : 0;
})();
