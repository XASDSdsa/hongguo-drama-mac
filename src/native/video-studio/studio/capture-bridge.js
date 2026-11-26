(function () {
  'use strict';

  let injectedState = null;
  let resolveStateReady = null;
  const stateReadyPromise = new Promise((r) => { resolveStateReady = r; });

  // Intercept /__studio_api__/state so the exact original studio.js runs 100% offline inside Electron!
  const origFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (String(url).includes('/__studio_api__/state')) {
      if (opts && opts.method === 'POST') {
        try { injectedState = JSON.parse(opts.body); } catch {}
        renderEmbeddedDag();
        return new Response(JSON.stringify({ ok: true, state: injectedState }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      await stateReadyPromise;
      return new Response(JSON.stringify(injectedState), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return origFetch(url, opts);
  };

  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function getActiveSeriesAndEp() {
    if (!injectedState?.seriesList?.length) return { series: null, ep: null };
    const series = injectedState.seriesList.find((s) => s.id === injectedState.activeSeriesId) || injectedState.seriesList[0];
    const ep = series.episodes.find((e) => e.id === series.activeEpisodeId) || series.episodes[0];
    return { series, ep };
  }

  function renderEmbeddedDag() {
    const { series, ep } = getActiveSeriesAndEp();
    const nodesEl = document.getElementById('embedded-dag-nodes');
    const svgEl = document.getElementById('embedded-dag-svg');
    if (!series || !ep || !nodesEl || !svgEl) return;

    const refSet = new Set((ep.shots || []).flatMap((s) => s.assetIds || []));
    const epAssets = (series.sharedAssets || []).filter((a) => refSet.has(a.id));
    const assets = epAssets.length ? epAssets : series.sharedAssets || [];
    const shots = ep.shots || [];

    nodesEl.innerHTML = '';
    const paths = [];
    const pos = {};
    const addNode = (id, x, y, w, h, title, bodyHtml) => {
      pos[id] = { x, y, w, h };
      const d = document.createElement('div');
      d.className = 'edag-node';
      d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;min-height:${h}px;`;
      d.innerHTML = `<div class="edag-nh">${esc(title)}</div>${bodyHtml}`;
      nodesEl.appendChild(d);
    };
    const addEdge = (from, to, color = 'rgba(56,189,248,0.45)') => {
      const a = pos[from], b = pos[to];
      if (!a || !b) return;
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
      const cx = (x1 + x2) / 2;
      paths.push(`<path d="M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2"/>`);
    };

    addNode('script', 20, 20, 230, 126, `剧本摘要 · ${ep.title}`, `<div class="edag-nb">${esc(ep.synopsis).slice(0, 78)}...</div>`);
    assets.forEach((a, i) => {
      addNode(a.id, 20, 166 + i * 144, 230, 130, a.caption || a.name, `<img class="edag-img" style="height:98px" src="${a.image}"/>`);
      addEdge('script', a.id, 'rgba(148,163,184,0.38)');
    });
    shots.forEach((s, i) => {
      const y = 20 + i * 144;
      const pId = `p-${s.index}`, vId = `v-${s.index}`;
      addNode(pId, 330, y, 300, 130, `${s.title} (${s.timecode})`, `<div class="edag-nb">${esc(s.description).slice(0, 82)}...</div>`);
      addNode(vId, 710, y, 200, 130, s.videoTitle, `<img class="edag-img" style="height:98px" src="${s.poster}"/>`);
      addEdge(pId, vId, 'rgba(96,165,250,0.75)');
      (s.assetIds || []).forEach((aid) => addEdge(aid, vId, 'rgba(56,189,248,0.42)'));
    });
    const maxShotH = Math.max(1, shots.length) * 144;
    const tlY = Math.max(40, Math.round(maxShotH / 2 - 78));
    addNode(
      'timeline', 1000, tlY, 340, 156,
      `${ep.title} · 全集拼接成片（${shots.length}镜）`,
      `<div class="edag-tl">${shots.slice(0, 4).map((s) => `<img src="${s.poster}"/>`).join('')}</div>`,
    );
    shots.forEach((s) => addEdge(`v-${s.index}`, 'timeline', 'rgba(16,185,129,0.68)'));
    svgEl.innerHTML = paths.join('');
    requestAnimationFrame(fitEmbeddedDag);
  }

  function fitEmbeddedDag() {
    const stage = document.getElementById('embedded-dag-stage');
    const inner = document.getElementById('embedded-dag-inner');
    const nodes = Array.from(document.querySelectorAll('#embedded-dag-nodes .edag-node'));
    if (!stage || !inner || !nodes.length) return;

    const stageW = stage.clientWidth || 1380;
    const stageH = stage.clientHeight || 900;
    const topBarReserve = 62; // keep clear of floating canvas toolbar
    const padX = 36;
    const padY = 26;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      const x = parseFloat(n.style.left) || 0;
      const y = parseFloat(n.style.top) || 0;
      const w = n.offsetWidth || parseFloat(n.style.width) || 240;
      const h = n.offsetHeight || parseFloat(n.style.minHeight) || 130;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    });

    const dagW = Math.max(1, maxX - minX);
    const dagH = Math.max(1, maxY - minY);
    const availW = Math.max(300, stageW - padX * 2);
    const availH = Math.max(300, stageH - topBarReserve - padY * 2);
    const scale = Math.min(availW / dagW, availH / dagH, 1.0);

    const tx = Math.round((stageW - dagW * scale) / 2 - minX * scale);
    const ty = Math.round(topBarReserve + (availH - dagH * scale) / 2 + padY - minY * scale);
    inner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale.toFixed(4)})`;
  }

  window.__studio = {
    async init(payload) {
      const seriesId = 'series-export';
      const randomCredits = Math.floor(2000 + Math.random() * 7001);
      const v2 = {
        schemaVersion: 2,
        credits: randomCredits,
        activeSeriesId: seriesId,
        seriesList: [
          {
            id: seriesId,
            title: payload.seriesTitle,
            activeEpisodeId: payload.episodes[0]?.id || 'ep-1',
            sharedAssets: (payload.sharedAssets || []).map((a) => ({
              ...a,
              image: a.imageUrl || a.image,
              candidates: [a.imageUrl || a.image],
            })),
            episodes: (payload.episodes || []).map((ep) => ({
              ...ep,
              projectId: `local-${ep.id}`,
              shots: (ep.shots || []).map((s) => ({
                ...s,
                poster: s.posterUrl || s.poster,
                videoUrl: s.videoUrl || '',
              })),
            })),
          },
        ],
      };
      injectedState = v2;
      resolveStateReady();
      // Wait for studio.js boot render
      await new Promise((r) => setTimeout(r, 250));
      renderEmbeddedDag();
    },
    setMode(m) {
      const btn = document.querySelector(`.mode-tab[data-mode="${m}"]`);
      if (btn) btn.click();
      if (m === 'canvas') {
        renderEmbeddedDag();
        const omni = document.getElementById('omni-panel');
        if (omni) omni.classList.add('collapsed');
      }
    },
    selectEpisode(i) {
      const btns = document.querySelectorAll('#episode-list .ep-item');
      if (btns[i]) btns[i].click();
      setTimeout(renderEmbeddedDag, 80);
    },
    clickFilter(cat) {
      const pill = document.querySelector(`#asset-category-pills .filter-pill[data-cat="${cat}"]`);
      if (pill) pill.click();
    },
    scrollAssets(y) {
      const el = document.getElementById('asset-cards-container');
      if (el) el.scrollTo({ top: y, behavior: 'smooth' });
    },
    getAssetsScrollMax() {
      const el = document.getElementById('asset-cards-container');
      return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
    },
    getTabCenter(modeName) {
      const el = document.querySelector(`.mode-tab[data-mode="${modeName}"]`);
      if (!el) return { x: 760, y: 28 };
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    getEpisodeButtonCenter(i) {
      const btns = document.querySelectorAll('#episode-list .ep-item');
      const el = btns[i];
      if (!el) return { x: 105, y: 180 + i * 40 };
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    scrollPipeline(y) {
      const el = document.querySelector('.pipeline-scroll');
      if (el) el.scrollTo({ top: y, behavior: 'smooth' });
    },
    highlightCanvasNode(i) {
      document.querySelectorAll('.edag-node').forEach((n, idx) => n.classList.toggle('hl', idx === i + 1));
    },
    toggleOmni(open) {
      const omni = document.getElementById('omni-panel');
      if (omni) omni.classList.toggle('collapsed', !open);
    },
    fitCanvas() { fitEmbeddedDag(); },
    moveCursor(x, y) {
      const c = document.getElementById('demo-cursor');
      if (c) { c.classList.add('show'); c.style.left = x + 'px'; c.style.top = y + 'px'; }
    },
    hideCursor() {
      const c = document.getElementById('demo-cursor');
      if (c) c.classList.remove('show');
    },
    waitForImages() {
      const imgs = Array.from(document.querySelectorAll('img'));
      return Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; }))));
    },
  };
})();
