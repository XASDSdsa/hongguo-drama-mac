(function () {
  'use strict';

  let studioState = null;
  let activeMode = 'pipeline'; // default to 分镜流水线 or URL hash
  let assetCategoryFilter = 'all';
  let assetScope = 'series'; // 'series' = 全剧共享资产库 | 'episode' = 仅看本集引用
  let spliceActiveIdx = 0;
  let spliceAutoPlaying = false;
  let canvasSyncVersion = 1;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function showToast(msg) {
    const el = $('#studio-toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  function getActiveSeries() {
    if (!studioState || !Array.isArray(studioState.seriesList) || !studioState.seriesList.length) return null;
    return (
      studioState.seriesList.find((s) => s.id === studioState.activeSeriesId) ||
      studioState.seriesList[0]
    );
  }

  function getActiveEpisode() {
    const series = getActiveSeries();
    if (!series || !Array.isArray(series.episodes) || !series.episodes.length) return null;
    return (
      series.episodes.find((e) => e.id === series.activeEpisodeId) ||
      series.episodes[0]
    );
  }

  function getSeriesSharedAssets() {
    const series = getActiveSeries();
    return series?.sharedAssets || [];
  }

  function getEpisodeReferencedAssets(ep) {
    const pool = getSeriesSharedAssets();
    if (!ep) return pool;
    const refSet = new Set();
    (ep.shots || []).forEach((s) => (s.assetIds || []).forEach((id) => refSet.add(id)));
    if (refSet.size === 0) return pool;
    const sub = pool.filter((a) => refSet.has(a.id));
    return sub.length ? sub : pool;
  }

  async function persistState() {
    $('#save-status-text').textContent = '同步画布中...';
    try {
      const res = await fetch('/__studio_api__/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(studioState)
      });
      const json = await res.json();
      if (json && json.state) {
        studioState = json.state;
        renderHeaderAndSidebar();
      }
      canvasSyncVersion += 1;
      if (activeMode === 'canvas') syncCanvasIframe();
      $('#save-status-text').textContent = '四视图已同步';
    } catch {
      $('#save-status-text').textContent = '本地已保存';
    }
  }

  function setMode(mode) {
    activeMode = mode;
    $$('.mode-tab').forEach((btn) => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    ['assets', 'canvas', 'pipeline', 'splice'].forEach((m) => {
      const view = $(`#view-${m}`);
      if (view) view.hidden = m !== mode;
    });
    if (mode === 'canvas') {
      syncCanvasIframe();
      renderOmniPanel();
    } else if (mode === 'splice') {
      renderSpliceView();
    }
  }

  function syncCanvasIframe() {
    const ep = getActiveEpisode();
    if (!ep) return;
    const iframe = $('#native-canvas-iframe');
    const syncKey = `${ep.projectId}@${canvasSyncVersion}`;
    const targetSrc = `/ai-tool/ai-canvas/${encodeURIComponent(ep.projectId)}?enter_from=create_new&from_page=canvas-home&sync=${canvasSyncVersion}`;
    if (iframe.getAttribute('data-loaded-sync') !== syncKey) {
      iframe.setAttribute('data-loaded-sync', syncKey);
      iframe.src = targetSrc;
    }
  }

  function renderHeaderAndSidebar() {
    const series = getActiveSeries();
    const ep = getActiveEpisode();
    if (!series || !ep) return;
    const epAssets = getEpisodeReferencedAssets(ep);

    document.title = `即梦短剧工坊 · 《${series.title}》四模式一体化创作台`;
    $('#header-episode-title').textContent = `${ep.title} · ${ep.subtitle}`;
    $('#header-node-count').textContent = `节点 ${ep.nodeCount || ep.shots.length * 2 + epAssets.length + 3}`;
    $('#header-credits').textContent = String(studioState.credits || 99999);
    $('#episode-total-badge').textContent = `${series.episodes.length}集`;

    // Series dropdown switcher
    const selectEl = $('#series-select');
    if (selectEl) {
      selectEl.innerHTML = '';
      (studioState.seriesList || []).forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `《${s.title}》（${s.episodes.length}集 · ${(s.sharedAssets || []).length}资产）`;
        opt.selected = s.id === series.id;
        selectEl.appendChild(opt);
      });
    }

    const listEl = $('#episode-list');
    listEl.innerHTML = '';
    series.episodes.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = 'ep-item' + (item.id === ep.id ? ' active' : '');
      btn.type = 'button';
      btn.innerHTML = `<span class="ep-num">${item.number}</span><span class="ep-name">第${item.number}集 · ${item.subtitle}</span>`;
      btn.addEventListener('click', () => {
        series.activeEpisodeId = item.id;
        spliceActiveIdx = 0;
        spliceAutoPlaying = false;
        renderAll();
        persistState();
      });
      listEl.appendChild(btn);
    });
  }

  /* ==================== MODE 1: 全剧共享 AI资产库 ==================== */
  function renderAssetsView() {
    const series = getActiveSeries();
    const ep = getActiveEpisode();
    if (!series || !ep) return;

    const allSeriesAssets = getSeriesSharedAssets();
    const epUsedAssets = getEpisodeReferencedAssets(ep);
    const scopeAssets = assetScope === 'episode' ? epUsedAssets : allSeriesAssets;

    const charCnt = scopeAssets.filter((a) => a.category === 'character').length;
    const sceneCnt = scopeAssets.filter((a) => a.category === 'scene').length;
    const propCnt = scopeAssets.filter((a) => a.category === 'prop').length;

    const cChar = $('[data-count="character"]');
    const cScene = $('[data-count="scene"]');
    const cProp = $('[data-count="prop"]');
    if (cChar) cChar.textContent = String(charCnt);
    if (cScene) cScene.textContent = String(sceneCnt);
    if (cProp) cProp.textContent = String(propCnt);
    $('#sub-count-all').textContent = String(scopeAssets.length);
    $('#sub-count-char').textContent = String(charCnt);
    $('#sub-count-scene').textContent = String(sceneCnt);
    $('#sub-count-prop').textContent = String(propCnt);

    const btnSeries = $('#btn-scope-series');
    const btnEp = $('#btn-scope-episode');
    if (btnSeries) {
      btnSeries.textContent = `🌐 全剧共享库 (${allSeriesAssets.length})`;
      btnSeries.classList.toggle('active', assetScope === 'series');
    }
    if (btnEp) {
      btnEp.textContent = `🎬 仅看本集引用 (${epUsedAssets.length})`;
      btnEp.classList.toggle('active', assetScope === 'episode');
    }

    const filtered =
      assetCategoryFilter === 'all'
        ? scopeAssets
        : scopeAssets.filter((a) => a.category === assetCategoryFilter);

    const container = $('#asset-cards-container');
    container.innerHTML = '';
    filtered.forEach((asset) => {
      const boundShotCount = (ep.shots || []).filter((s) => (s.assetIds || []).includes(asset.id)).length;
      const usageTag =
        boundShotCount > 0
          ? `<span class="shared-usage-tag">全剧共享 · 本集已绑定 ${boundShotCount} 镜</span>`
          : `<span class="shared-usage-tag unused">全剧共享 · 本集未出场</span>`;

      const row = document.createElement('div');
      row.className = 'asset-row-card';
      const candsHtml = (asset.candidates || [asset.image])
        .map(
          (src) =>
            `<button class="cand-thumb ${src === asset.image ? 'active' : ''}" data-src="${src}" type="button"><img src="${src}" alt="${asset.name}"/></button>`
        )
        .join('');

      row.innerHTML = `
        <div class="asset-visual-box">
          <div class="asset-box-top">
            <div class="tag-row">
              <span class="mini-tag bright">${asset.shotType || '远景'}</span>
              <span class="mini-tag">${asset.framing || '全身'}</span>
              ${usageTag}
            </div>
            <span class="mini-tag">⚙ 设置属性</span>
          </div>
          <div class="asset-img-stage">
            <img src="${asset.image}" alt="${asset.name}" />
          </div>
          <div class="asset-box-bottom">
            <div class="cand-strip">${candsHtml}</div>
            <span class="asset-caption">${asset.caption || asset.name}</span>
          </div>
        </div>
        <div class="asset-prompt-box">
          <div class="asset-prompt-head">
            <h3>${asset.name}</h3>
            <span>全剧共享资产提示词（修改同步全剧）</span>
          </div>
          <textarea class="asset-prompt-textarea">${asset.prompt || ''}</textarea>
          <div class="asset-prompt-hint">⚠ 参考强度：主体三视图已锁定角色一致性，修改提示词后点击右侧按钮重新生成</div>
          <div class="asset-prompt-foot">
            <div class="tag-row">
              <span class="param-pill">${asset.model || 'Seedance 2.0'}</span>
              <span class="param-pill">${asset.imageModel || 'Seedream 5.5'}</span>
              <span class="param-pill">${asset.resolution || '1K'}</span>
              <span class="param-pill">${asset.aspectRatio || '16:9'}</span>
            </div>
            <button class="gen-circle-btn" type="button" title="生成新候选图">↑</button>
          </div>
        </div>
      `;

      row.querySelectorAll('.cand-thumb').forEach((thumb) => {
        thumb.addEventListener('click', () => {
          asset.image = thumb.dataset.src;
          renderAssetsView();
          renderPipelineView();
          persistState();
        });
      });

      const ta = row.querySelector('.asset-prompt-textarea');
      ta.addEventListener('change', () => {
        asset.prompt = ta.value;
        persistState();
      });

      row.querySelector('.gen-circle-btn').addEventListener('click', () => {
        showToast(`正在使用 ${asset.imageModel || 'Seedream 5.5'} 生成「${asset.name}」新候选图...`);
        setTimeout(() => {
          const pool = [
            '/__mock_media__/drama/char-linshen.jpg',
            '/__mock_media__/drama/char-suwan.jpg',
            '/__mock_media__/drama/shot-01.jpg',
            '/__mock_media__/drama/shot-02.jpg',
            '/__mock_media__/drama/shot-03.jpg',
            '/__mock_media__/drama/shot-04.jpg'
          ];
          const next = asset.candidates[(asset.candidates.length) % asset.candidates.length] || pool[0];
          if (!asset.candidates.includes(next)) asset.candidates.push(next);
          asset.image = next;
          showToast(`「${asset.name}」资产图已生成并同步至分镜流水线`);
          renderAssetsView();
          renderPipelineView();
          persistState();
        }, 700);
      });

      container.appendChild(row);
    });
  }

  /* ==================== MODE 2: 全能参考面板 ==================== */
  function renderOmniPanel() {
    const ep = getActiveEpisode();
    if (!ep) return;
    const assets = getEpisodeReferencedAssets(ep);
    const strip = $('#omni-ref-strip');
    strip.innerHTML = '';
    assets.forEach((a) => {
      const chip = document.createElement('button');
      chip.className = 'omni-ref-chip';
      chip.type = 'button';
      chip.innerHTML = `<img src="${a.image}" alt="${a.name}"/><span>@${a.name}</span>`;
      chip.addEventListener('click', () => {
        const ta = $('#omni-prompt-input');
        ta.value = `@${a.name} ` + ta.value;
        ta.focus();
      });
      strip.appendChild(chip);
    });

    const lines = [];
    assets.forEach((a) => lines.push(`@${a.name} ${(a.prompt || '').slice(0, 32)}`));
    lines.push('');
    (ep.shots || []).forEach((s) => lines.push(`#分镜${s.index} 画面描述：${s.description}`));
    $('#omni-prompt-input').value = lines.join('\n');
  }

  /* ==================== MODE 3: 分镜流水线 ==================== */
  function renderPipelineView() {
    const series = getActiveSeries();
    const ep = getActiveEpisode();
    if (!series || !ep) return;
    $('#pipeline-drama-title').textContent = `剧名：${series.title} · ${ep.title}《${ep.subtitle}》`;
    $('#pipeline-synopsis').textContent = `梗概：${ep.synopsis}`;

    const assets = getEpisodeReferencedAssets(ep);
    const shots = ep.shots || [];
    $('#col-count-assets').textContent = `${assets.length}/${(series.sharedAssets || []).length}`;
    $('#col-count-prompts').textContent = `${shots.length}/12`;
    $('#col-count-videos').textContent = `${shots.length}/12`;

    // Col 1: 角色卡
    const assetsCol = $('#pipeline-assets-col');
    assetsCol.innerHTML = '';
    assets.forEach((a) => {
      const card = document.createElement('div');
      card.className = 'pipe-asset-card';
      card.innerHTML = `
        <img src="${a.image}" alt="${a.name}" />
        <div class="pipe-card-foot">
          <span>${a.caption || a.name}</span>
          <span class="meta-chip">${a.aspectRatio || '16:9'}</span>
        </div>
      `;
      assetsCol.appendChild(card);
    });

    // Col 2 & Col 3 Paired Rows: 分镜提示词 ↔ 分镜成片 (strict 1:1 height & alignment)
    const shotRows = $('#pipeline-shot-rows');
    shotRows.innerHTML = '';
    shots.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'pipe-shot-row';

      const boundNames = (s.assetIds || [])
        .map((aid) => assets.find((a) => a.id === aid)?.name)
        .filter(Boolean);
      const boundHtml = boundNames.length
        ? `<div class="bound-assets-row">${boundNames.map((n) => `<span class="bound-chip">🔗 @${n}</span>`).join('')}</div>`
        : '';

      const promptCard = document.createElement('div');
      promptCard.className = 'pipe-prompt-card';
      promptCard.innerHTML = `
        <div class="pipe-prompt-top">
          <span class="pipe-prompt-title">≡ ${s.title}</span>
          <button class="subtle-btn regen-shot-btn" type="button">↻ 重生成</button>
        </div>
        ${boundHtml}
        <div class="pipe-prompt-desc"><b>画面描述：</b>${s.description}</div>
        <div class="pipe-kv"><b>主体：</b>${s.subject}</div>
        <div class="pipe-kv"><b>运镜：</b>${s.camera}</div>
        <div class="pipe-prompt-meta">
          <span>◎ 画幅 ${s.aspectRatio || '16:9'} · ⏱ ${s.durationSec || 4}秒</span>
          <span>Seedance 2.0</span>
        </div>
      `;
      promptCard.querySelector('.regen-shot-btn').addEventListener('click', () => {
        showToast(`正在基于提示词重新渲染「${s.videoTitle}」...`);
        setTimeout(() => showToast(`「${s.videoTitle}」已完成更新！`), 800);
      });

      const videoCard = document.createElement('div');
      videoCard.className = 'pipe-video-card';
      videoCard.innerHTML = `
        <div class="pipe-video-wrap">
          <video src="${s.videoUrl}" poster="${s.poster}" muted loop playsinline preload="metadata"></video>
          <div class="play-overlay"><div class="play-circle">▶</div></div>
        </div>
        <div class="pipe-card-foot">
          <span>${s.videoTitle}</span>
          <span class="meta-chip">${s.timecode}</span>
        </div>
      `;
      const wrap = videoCard.querySelector('.pipe-video-wrap');
      const vid = videoCard.querySelector('video');
      videoCard.addEventListener('click', () => {
        if (vid.paused) {
          vid.play().catch(() => {});
          wrap.classList.add('playing');
        } else {
          vid.pause();
          wrap.classList.remove('playing');
        }
      });

      row.appendChild(promptCard);
      row.appendChild(videoCard);
      shotRows.appendChild(row);
    });
  }

  /* ==================== MODE 4: 分镜视频拼接 ==================== */
  function renderSpliceView() {
    const ep = getActiveEpisode();
    if (!ep) return;
    const shots = ep.shots || [];
    if (!shots.length) return;
    if (spliceActiveIdx >= shots.length) spliceActiveIdx = 0;

    const totalSec = shots.reduce((acc, s) => acc + (s.durationSec || 4), 0);
    const fmtMinSec = (sec) =>
      `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    $('#splice-total-time').textContent = `总时长 ${fmtMinSec(totalSec)} · ${shots.length} 镜`;
    const audioBar = $('.audio-wave-block');
    if (audioBar) {
      audioBar.textContent = `${ep.title} 原声对白与环境音轨 · 00:00 - ${fmtMinSec(totalSec)}`;
    }

    const videoEl = $('#splice-video');
    const cur = shots[spliceActiveIdx];
    $('#splice-shot-badge').textContent = `分镜 #${cur.index} / ${shots.length} · ${cur.timecode}`;
    $('#splice-subtitle').textContent = cur.dialogue || cur.subject;
    if (videoEl.getAttribute('data-shot-id') !== cur.id) {
      videoEl.setAttribute('data-shot-id', cur.id);
      videoEl.src = cur.videoUrl;
      videoEl.poster = cur.poster;
    }

    const vTrack = $('#splice-video-track');
    vTrack.innerHTML = '';
    shots.forEach((s, idx) => {
      const clip = document.createElement('div');
      clip.className = 'tclip-card' + (idx === spliceActiveIdx ? ' active' : '');
      clip.innerHTML = `
        <img src="${s.poster}" alt="${s.videoTitle}" />
        <div class="tclip-label"><span>#${s.index} ${s.subject.slice(0, 10)}</span><span>${s.durationSec || 4}s</span></div>
      `;
      clip.addEventListener('click', () => {
        spliceActiveIdx = idx;
        renderSpliceView();
        videoEl.play().catch(() => {});
      });
      vTrack.appendChild(clip);
    });

    const sTrack = $('#splice-sub-track');
    sTrack.innerHTML = '';
    shots.forEach((s) => {
      const pill = document.createElement('div');
      pill.className = 'tsub-pill';
      pill.textContent = `#${s.index} ${s.dialogue || s.subject}`;
      sTrack.appendChild(pill);
    });
  }

  function renderAll() {
    renderHeaderAndSidebar();
    renderAssetsView();
    renderPipelineView();
    if (activeMode === 'canvas') {
      syncCanvasIframe();
      renderOmniPanel();
    }
    if (activeMode === 'splice') {
      renderSpliceView();
    }
  }

  function wireEvents() {
    $$('.mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // Series switcher
    const seriesSelect = $('#series-select');
    if (seriesSelect) {
      seriesSelect.addEventListener('change', () => {
        studioState.activeSeriesId = seriesSelect.value;
        spliceActiveIdx = 0;
        spliceAutoPlaying = false;
        renderAll();
        persistState();
      });
    }

    // Asset scope toggle (全剧共享库 vs 仅看本集引用)
    $$('.scope-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        assetScope = btn.dataset.scope || 'series';
        renderAssetsView();
      });
    });

    // Asset filters
    $$('#asset-category-pills .filter-pill, .assets-subnav .subnav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        assetCategoryFilter = btn.dataset.cat || 'all';
        $$('#asset-category-pills .filter-pill').forEach((b) =>
          b.classList.toggle('active', b.dataset.cat === assetCategoryFilter)
        );
        $$('.assets-subnav .subnav-item').forEach((b) =>
          b.classList.toggle('active', b.dataset.cat === assetCategoryFilter)
        );
        renderAssetsView();
      });
    });

    $('#btn-batch-prompts').addEventListener('click', () => {
      showToast('⚡ 已为当前剧集全部角色、场景与道具优化 AI 资产提示词！');
    });
    $('#btn-sync-subjects').addEventListener('click', () => {
      showToast('已将全部角色三视图与道具同步至节点画布主体库');
    });
    $('#btn-go-pipeline-from-assets').addEventListener('click', () => setMode('pipeline'));
    $('#btn-jump-canvas').addEventListener('click', () => setMode('canvas'));
    $('#btn-jump-splice').addEventListener('click', () => setMode('splice'));
    $('#btn-open-native-canvas').addEventListener('click', () => {
      const ep = getActiveEpisode();
      if (ep) window.open(`/ai-tool/ai-canvas/${encodeURIComponent(ep.projectId)}`, '_blank');
    });
    $('#btn-share').addEventListener('click', () => showToast('已复制当前短剧工坊分享链接'));

    // Add new episode inside active series (reuses series.sharedAssets by ID!)
    $('#btn-add-episode').addEventListener('click', () => {
      const series = getActiveSeries();
      if (!series) return;
      const maxNum = series.episodes.reduce((m, e) => Math.max(m, e.number || 0), 0);
      const nextNum = maxNum + 1;
      const shared = series.sharedAssets || [];
      const leadIds = shared.slice(0, Math.min(3, shared.length)).map((a) => a.id);
      const refEp = series.episodes[series.episodes.length - 1];
      const sampleShot = refEp?.shots?.[0];
      const newEp = {
        id: `${series.id}-ep-${nextNum}`,
        number: nextNum,
        title: `${series.title}-第${nextNum}集`,
        subtitle: '续集新篇章（复用全剧资产）',
        projectId: `${series.id}-ep-${nextNum}`,
        nodeCount: 2 + leadIds.length + 2 + 1,
        synopsis: `《${series.title}》第${nextNum}集续篇：直接复用全剧共享资产库中的角色三视图与核心场景，保证跨集人物形象 100% 统一不串脸。`,
        shots: [
          {
            id: `${series.id}-ep${nextNum}-shot-1`,
            index: 1,
            title: '分镜提示词 #1',
            videoTitle: '分镜成片 #1',
            description: `《${series.title}》第${nextNum}集开场镜：延续上一集悬念，直接绑定全剧共享主角与核心场景资产。`,
            subject: `第${nextNum}集开场衔接镜`,
            camera: '中景推进 · 保持全剧统一光影与人物形象',
            aspectRatio: sampleShot?.aspectRatio || '9:16',
            durationSec: sampleShot?.durationSec || 5,
            timecode: '00:00 - 00:05 · 5s',
            poster: sampleShot?.poster || '/__mock_media__/drama/shot-01.jpg',
            videoUrl: sampleShot?.videoUrl || '/__mock_media__/drama/video-shot-01.mp4',
            assetIds: leadIds,
            dialogue: `（第${nextNum}集开场，已自动复用全剧共享资产）`
          }
        ]
      };
      series.episodes.push(newEp);
      series.activeEpisodeId = newEp.id;
      renderAll();
      persistState();
      showToast(`已新建《${series.title}》第${nextNum}集，自动复用全剧 ${leadIds.length} 项共享资产！`);
    });

    // + 生成分镜
    $('#btn-generate-shot').addEventListener('click', () => {
      const ep = getActiveEpisode();
      if (!ep) return;
      const idx = ep.shots.length + 1;
      const startSec = ep.shots.reduce((a, b) => a + (b.durationSec || 4), 0);
      const endSec = startSec + 4;
      const fmt = (n) => `00:${String(n).padStart(2, '0')}`;
      const posters = [
        ['/__mock_media__/drama/shot-01.jpg', '/__mock_media__/drama/video-shot-01.mp4'],
        ['/__mock_media__/drama/shot-02.jpg', '/__mock_media__/drama/video-shot-02.mp4'],
        ['/__mock_media__/drama/shot-03.jpg', '/__mock_media__/drama/video-shot-03.mp4'],
        ['/__mock_media__/drama/shot-04.jpg', '/__mock_media__/drama/video-shot-04.mp4']
      ];
      const [poster, videoUrl] = posters[(idx - 1) % posters.length];
      ep.shots.push({
        id: `${ep.id}-shot-${idx}-${Date.now()}`,
        index: idx,
        title: `分镜提示词 #${idx}`,
        videoTitle: `分镜成片 #${idx}`,
        description: `新增悬疑推进镜 #${idx}：冷青霓虹雨夜下镜头缓缓推近主角眼神特写，情绪张力拉满，衔接下一场高能反转。`,
        subject: `第${ep.number}集新增分镜 #${idx}`,
        camera: '近景特写 · 缓慢推镜',
        aspectRatio: '16:9',
        durationSec: 4,
        timecode: `${fmt(startSec)} - ${fmt(endSec)} · 4s`,
        poster,
        videoUrl,
        dialogue: `【分镜 #${idx}】真相正在浮出水面……`
      });
      renderPipelineView();
      persistState();
      showToast(`已自动生成「分镜 #${idx}」提示词与成片`);
    });

    // Canvas floating toolbar & Omni panel
    $('#btn-toggle-omni').addEventListener('click', () => {
      const panel = $('#omni-panel');
      panel.classList.toggle('collapsed');
      $('#btn-toggle-omni').classList.toggle('active', !panel.classList.contains('collapsed'));
    });
    $('#btn-close-omni').addEventListener('click', () => {
      $('#omni-panel').classList.add('collapsed');
      $('#btn-toggle-omni').classList.remove('active');
    });
    $$('.omni-tab').forEach((t) => {
      t.addEventListener('click', () => {
        $$('.omni-tab').forEach((x) => x.classList.toggle('active', x === t));
      });
    });
    $('#btn-omni-generate').addEventListener('click', () => {
      showToast('✦ 已按全能参考提示词提交本地模拟生成，成片已同步至「分镜流水线」');
    });
    $$('.cbar-btn[data-caction]').forEach((b) => {
      b.addEventListener('click', () => showToast(`已执行画布工具：${b.textContent.trim()}`));
    });

    // Splice player controls
    const videoEl = $('#splice-video');
    videoEl.addEventListener('ended', () => {
      const ep = getActiveEpisode();
      if (!ep || !spliceAutoPlaying) return;
      if (spliceActiveIdx + 1 < ep.shots.length) {
        spliceActiveIdx += 1;
        renderSpliceView();
        videoEl.play().catch(() => {});
      } else {
        spliceAutoPlaying = false;
        $('#btn-splice-play').textContent = '▶ 连播整集成片';
        showToast('整集分镜连播完成！');
      }
    });
    $('#btn-splice-play').addEventListener('click', () => {
      if (videoEl.paused) {
        spliceAutoPlaying = true;
        videoEl.play().catch(() => {});
        $('#btn-splice-play').textContent = '⏸ 暂停连播';
      } else {
        spliceAutoPlaying = false;
        videoEl.pause();
        $('#btn-splice-play').textContent = '▶ 连播整集成片';
      }
    });
    $('#btn-splice-prev').addEventListener('click', () => {
      const ep = getActiveEpisode();
      if (!ep) return;
      spliceActiveIdx = Math.max(0, spliceActiveIdx - 1);
      renderSpliceView();
      videoEl.play().catch(() => {});
    });
    $('#btn-splice-next').addEventListener('click', () => {
      const ep = getActiveEpisode();
      if (!ep) return;
      spliceActiveIdx = Math.min(ep.shots.length - 1, spliceActiveIdx + 1);
      renderSpliceView();
      videoEl.play().catch(() => {});
    });
    $('#btn-splice-export').addEventListener('click', () => {
      const ep = getActiveEpisode();
      showToast(`🎬 正在导出《${ep?.title || '第1集'}》全集拼接成片 (1080P MP4)...`);
    });
  }

  async function init() {
    wireEvents();
    const res = await fetch('/__studio_api__/state');
    studioState = await res.json();
    renderAll();
    const initialMode = new URLSearchParams(window.location.search).get('mode') || 'assets';
    setMode(['assets', 'canvas', 'pipeline', 'splice'].includes(initialMode) ? initialMode : 'assets');
  }

  init();
})();
