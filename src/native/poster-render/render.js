/*
 * 海报标题渲染（运行在隐藏的 Chromium 页面里，不依赖 Electron / Node）。
 *
 * window.PosterTitle.render(spec) -> { dataUrl, meta }
 *   spec.image    背景图（data URL，必须是不带文字的画面）
 *   spec.title    标题（1–2 行，自动换行）
 *   spec.tagline  可选，一句短钩子
 *   spec.style    poster-styles.js 里 resolveStyle() 的结果
 *   spec.layout   'auto' | 'bottom' | 'top' | 'middle'
 *   spec.faces    可选，视觉模型给出的人脸框 [{x,y,w,h}]（0–1，相对整图）
 *
 * “字放哪里”由程序算：把底图缩成小图，量每个候选区域的画面复杂度、肤色占比和人脸重叠，
 * 选最“空”的一条带；再按底图亮度铺一层渐变暗角，保证字和背景的对比度够用。
 */
(function (root) {
  'use strict';

  const BANDS = {
    bottom: { y0: 0.64, y1: 0.93, bias: 0 },
    top: { y0: 0.06, y1: 0.31, bias: 0.05 },
    middle: { y0: 0.4, y1: 0.66, bias: 0.16 },
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const luminance = (r, g, b) => {
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return [255, 255, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('底图无法解码'));
      img.src = src;
    });
  }

  /** 把标题拆成最多两行：4–6 字一行；更长的在中间附近断开，优先在标点/空格处断。 */
  function splitTitle(title) {
    const chars = Array.from(String(title || '').trim());
    if (chars.length <= 6) return [chars.join('')];
    const mid = Math.ceil(chars.length / 2);
    let cut = mid;
    for (let d = 0; d <= 2; d += 1) {
      for (const at of [mid - d, mid + d]) {
        if (at > 1 && at < chars.length - 1 && /[\s，,：:！!？?、·]/.test(chars[at - 1])) {
          cut = at;
          d = 99;
          break;
        }
      }
    }
    const strip = (list) => list.join('').replace(/^[\s，,：:、·]+|[\s，,：:、·]+$/g, '');
    return [strip(chars.slice(0, cut)), strip(chars.slice(cut))].filter(Boolean);
  }

  /** 缩成小图，量每个候选条带的“忙碌程度”。 */
  function analyze(img, faces) {
    const w = 48;
    const h = Math.max(24, Math.round((w * img.naturalHeight) / img.naturalWidth));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    const skin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      skin[i] = r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 12 && r > g && g > b + 8 ? 1 : 0;
    }
    const costs = {};
    for (const [name, band] of Object.entries(BANDS)) {
      const y0 = Math.floor(band.y0 * h);
      const y1 = Math.ceil(band.y1 * h);
      let edge = 0;
      let skinCount = 0;
      let lum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = y * w + x;
          const dx = x + 1 < w ? Math.abs(gray[i + 1] - gray[i]) : 0;
          const dy = y + 1 < h ? Math.abs(gray[i + w] - gray[i]) : 0;
          edge += dx + dy;
          skinCount += skin[i];
          lum += gray[i];
          n += 1;
        }
      }
      let faceOverlap = 0;
      for (const f of faces || []) {
        const ox = Math.max(0, Math.min(1, f.x + f.w) - Math.max(0, f.x));
        const oy = Math.max(0, Math.min(band.y1, f.y + f.h) - Math.max(band.y0, f.y));
        faceOverlap += (ox * oy) / ((band.y1 - band.y0) * 1);
      }
      const edgeMean = edge / n;
      const skinFrac = skinCount / n;
      costs[name] = {
        cost: edgeMean * 4 + skinFrac * 2.2 + Math.min(1, faceOverlap) * 4 + band.bias,
        edge: edgeMean,
        skin: skinFrac,
        faceOverlap,
        luma: lum / n,
      };
    }
    return costs;
  }

  function chooseLayout(layout, costs) {
    if (layout && layout !== 'auto' && BANDS[layout]) return layout;
    return Object.keys(costs).sort((a, b) => costs[a].cost - costs[b].cost)[0];
  }

  function makeGradient(ctx, stops, y0, y1) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    for (const [at, color] of stops) g.addColorStop(clamp(at, 0, 1), color);
    return g;
  }

  /** 画一行标题（描边/挤出/发光/渐变/高光），坐标原点在行中心。 */
  function drawLine(ctx, text, fs, style, width) {
    const family = `"${style.fontFamily}", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
    const font = `${style.fontWeight || 400} ${fs}px ${family}`;
    const spacing = (style.letterSpacing || 0) * fs;
    const top = -fs * 0.62;
    const bottom = fs * 0.62;
    const strokes = [...(style.strokes || [])].sort((a, b) => b.width - a.width);
    const widest = strokes.length ? strokes[0].width * fs : 0;

    const prep = (target) => {
      target.font = font;
      target.textAlign = 'center';
      target.textBaseline = 'middle';
      target.lineJoin = 'round';
      target.miterLimit = 2;
      if ('letterSpacing' in target) target.letterSpacing = `${spacing}px`;
    };
    const shift = spacing / 2; // letterSpacing 会在末尾多留一个间距
    prep(ctx);

    if (style.shadow) {
      ctx.save();
      ctx.shadowColor = style.shadow.color;
      ctx.shadowBlur = style.shadow.blur * fs;
      ctx.shadowOffsetY = style.shadow.dy * fs;
      ctx.strokeStyle = strokes[0]?.color || '#000';
      ctx.lineWidth = widest || fs * 0.1;
      ctx.strokeText(text, shift, 0);
      ctx.restore();
    }
    if (style.extrude) {
      const depth = Math.max(1, Math.round(style.extrude.depth * fs));
      ctx.strokeStyle = style.extrude.color;
      ctx.lineWidth = widest || fs * 0.08;
      for (let i = depth; i >= 1; i -= 1) ctx.strokeText(text, shift, i);
    }
    if (style.glow) {
      ctx.save();
      ctx.shadowColor = style.glow.color;
      ctx.shadowBlur = style.glow.blur * fs;
      ctx.strokeStyle = style.glow.color;
      ctx.lineWidth = Math.max(widest * 0.6, fs * 0.05);
      for (let i = 0; i < 2; i += 1) ctx.strokeText(text, shift, 0);
      ctx.restore();
    }
    for (const stroke of strokes) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * fs;
      ctx.strokeText(text, shift, 0);
    }

    // 填充放在单独的画布里，这样高光只作用在字面上，不会盖到描边。
    const padX = Math.ceil(widest + fs * 0.4);
    const fw = Math.ceil(width + padX * 2);
    const fh = Math.ceil(fs * 1.4);
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = fw;
    fillCanvas.height = fh;
    const f = fillCanvas.getContext('2d');
    prep(f);
    f.translate(fw / 2, fh / 2);
    f.fillStyle = makeGradient(f, style.fill, top, bottom);
    f.fillText(text, shift, 0);
    if (style.sheen) {
      f.globalCompositeOperation = 'source-atop';
      const shine = f.createLinearGradient(0, top, 0, bottom);
      shine.addColorStop(0, `rgba(255,255,255,${style.sheen})`);
      shine.addColorStop(0.5, `rgba(255,255,255,${style.sheen * 0.15})`);
      shine.addColorStop(0.52, 'rgba(255,255,255,0)');
      shine.addColorStop(1, 'rgba(255,255,255,0)');
      f.fillStyle = shine;
      f.fillRect(-fw / 2, -fh / 2, fw, fh);
    }
    ctx.drawImage(fillCanvas, -fw / 2, -fh / 2);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 底图 + 沿字所在一侧铺的渐变暗角（强度由底图亮度决定）。 */
  function paintBackground(ctx, img, W, H, layoutName, scrim) {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    if (scrim <= 0) return;
    const band = BANDS[layoutName];
    const g =
      layoutName === 'top'
        ? ctx.createLinearGradient(0, 0, 0, H * (band.y1 + 0.12))
        : ctx.createLinearGradient(0, H * (band.y0 - 0.16), 0, layoutName === 'middle' ? H * (band.y1 + 0.16) : H);
    if (layoutName === 'top') {
      g.addColorStop(0, `rgba(0,0,0,${scrim})`);
      g.addColorStop(0.7, `rgba(0,0,0,${scrim * 0.7})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
    } else if (layoutName === 'middle') {
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, `rgba(0,0,0,${scrim * 0.8})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.45, `rgba(0,0,0,${scrim * 0.75})`);
      g.addColorStop(1, `rgba(0,0,0,${scrim})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** 标题块的几何：行高、总高、起始 y（整块向安全区内收，不贴边）。 */
  function blockGeometry(W, H, plan) {
    const { style, lines, fs, layoutName, tagline } = plan;
    const band = BANDS[layoutName];
    const lineH = fs * 1.12;
    const blockH = lineH * lines.length;
    const tagH = tagline ? plan.tagFs * 1.9 : 0;
    const gap = tagline ? fs * 0.22 : 0;
    const bar = style.accentBar ? fs * 0.3 : 0;
    const total = blockH + bar + (tagline ? tagH + gap : 0);
    const bandMid = ((band.y0 + band.y1) / 2) * H;
    const startY = clamp(bandMid - total / 2, H * 0.035, H * 0.965 - total);
    return { lineH, blockH, tagH, gap, bar, total, startY, bbox: { x: W * 0.04, y: startY, w: W * 0.92, h: total } };
  }

  function paintText(ctx, W, H, plan, geo) {
    const { style, lines, fs, tagline } = plan;
    ctx.save();
    ctx.translate(W / 2, geo.startY + geo.blockH / 2);
    ctx.rotate(((style.rotate || 0) * Math.PI) / 180);
    ctx.translate(0, -(geo.blockH / 2 - geo.lineH / 2));
    lines.forEach((text, i) => {
      ctx.save();
      ctx.translate(0, i * geo.lineH);
      drawLine(ctx, text, fs, style, plan.widths[i]);
      ctx.restore();
    });
    ctx.restore();

    let cursorY = geo.startY + geo.blockH;
    if (style.accentBar) {
      const barW = Math.min(plan.maxWidth, W * 0.3);
      ctx.fillStyle = style.accentBar;
      ctx.fillRect(W / 2 - barW / 2, cursorY + fs * 0.06, barW, Math.max(4, fs * 0.07));
      cursorY += geo.bar;
    }
    if (tagline) {
      const ts = style.tagline || {};
      const tFs = plan.tagFs;
      ctx.font = `900 ${tFs}px "Noto Sans SC", "PingFang SC", sans-serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${tFs * 0.12}px`;
      const tw = ctx.measureText(tagline).width;
      const bw = tw + tFs * 1.8;
      const bh = geo.tagH;
      const bx = W / 2 - bw / 2;
      const by = cursorY + geo.gap;
      roundRect(ctx, bx, by, bw, bh, bh / 2);
      ctx.fillStyle = ts.bg || '#000';
      ctx.fill();
      if (ts.border) {
        ctx.lineWidth = Math.max(2, tFs * 0.08);
        ctx.strokeStyle = ts.border;
        ctx.stroke();
      }
      ctx.fillStyle = ts.color || '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagline, W / 2 + tFs * 0.06, by + bh / 2 + tFs * 0.04);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
  }

  /** 度量字带位置里的底图平均亮度（画完暗角之后）。 */
  function bandLuma(ctx, W, H, bbox) {
    const x = Math.round(clamp(bbox.x, 0, W - 1));
    const y = Math.round(clamp(bbox.y, 0, H - 1));
    const w = Math.max(1, Math.round(Math.min(bbox.w, W - x)));
    const h = Math.max(1, Math.round(Math.min(bbox.h, H - y)));
    const data = ctx.getImageData(x, y, w, h).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4 * 17) {
      sum += luminance(data[i], data[i + 1], data[i + 2]);
      n += 1;
    }
    return sum / Math.max(1, n);
  }

  async function ensureFonts(style, texts) {
    if (!document.fonts || !document.fonts.load) return;
    const sample = Array.from(new Set(texts.join('')))
      .join('')
      .slice(0, 60);
    const jobs = [
      document.fonts.load(`${style.fontWeight || 400} 64px "${style.fontFamily}"`, sample),
      document.fonts.load('900 40px "Noto Sans SC"', sample),
    ];
    await Promise.all(jobs);
  }

  async function render(spec) {
    const style = spec.style;
    if (!style) throw new Error('缺少标题样式');
    const title = String(spec.title || '').trim();
    if (!title) throw new Error('缺少标题');
    const tagline = String(spec.tagline || '')
      .trim()
      .slice(0, 16);
    const img = await loadImage(spec.image);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (W < 200 || H < 200) throw new Error('底图太小');

    await ensureFonts(style, [title, tagline]);
    const missing =
      document.fonts && document.fonts.check
        ? !document.fonts.check(`${style.fontWeight} 40px "${style.fontFamily}"`, title)
        : false;
    if (missing) throw new Error(`字体未加载：${style.fontFamily}`);

    const costs = analyze(img, spec.faces);
    const layoutName = chooseLayout(spec.layout, costs);
    const band = BANDS[layoutName];
    const lines = splitTitle(title);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 字号：横向不超过 86% 宽，纵向不超过字带高度，单行最大 0.21 倍宽。
    const maxWidth = W * 0.86;
    const measure = document.createElement('canvas').getContext('2d');
    const family = `"${style.fontFamily}", "Noto Sans SC", sans-serif`;
    const probe = 100;
    measure.font = `${style.fontWeight || 400} ${probe}px ${family}`;
    if ('letterSpacing' in measure) measure.letterSpacing = `${(style.letterSpacing || 0) * probe}px`;
    const widest = Math.max(...lines.map((text) => measure.measureText(text).width)) / probe;
    const strokePad = Math.max(0, ...(style.strokes || []).map((s) => s.width)) + 0.1;
    let fs = Math.min(maxWidth / (widest + strokePad), W * (lines.length === 1 ? 0.21 : 0.17));
    const bandH = (band.y1 - band.y0) * H;
    const extra = (tagline ? 0.8 : 0) + (style.accentBar ? 0.3 : 0);
    fs = Math.min(fs, bandH / (lines.length * 1.12 + extra + 0.1));
    fs = Math.floor(fs);
    const widths = lines.map((text) => {
      measure.font = `${style.fontWeight || 400} ${fs}px ${family}`;
      if ('letterSpacing' in measure) measure.letterSpacing = `${(style.letterSpacing || 0) * fs}px`;
      return measure.measureText(text).width;
    });
    const tagFs = Math.round(fs * 0.3);

    // 暗角强度：底图越亮越重；画完再测一次，对比度不够就加重，最多三轮。
    const fillRgb = hexToRgb(style.fill[Math.floor(style.fill.length / 2)][1]);
    const fillLuma = luminance(...fillRgb);
    let scrim = clamp(0.2 + (costs[layoutName].luma - 0.35) * 1.1, 0.18, 0.62);
    const plan = { style, lines, fs, layoutName, tagline, tagFs, widths, maxWidth };
    const geo = blockGeometry(W, H, plan);
    let contrast = 0;
    for (let round = 0; round < 3; round += 1) {
      paintBackground(ctx, img, W, H, layoutName, scrim);
      const luma = bandLuma(ctx, W, H, geo.bbox);
      contrast = (fillLuma + 0.05) / (luma + 0.05);
      if (contrast >= 3.2 || scrim >= 0.7) break;
      scrim = Math.min(0.72, scrim + 0.14);
    }
    paintBackground(ctx, img, W, H, layoutName, scrim);
    paintText(ctx, W, H, plan, geo);
    const bbox = geo.bbox;

    return {
      dataUrl: canvas.toDataURL(spec.format === 'png' ? 'image/png' : 'image/jpeg', 0.93),
      meta: {
        width: W,
        height: H,
        layout: layoutName,
        lines,
        fontSize: fs,
        scrim: Number(scrim.toFixed(2)),
        contrast: Number(contrast.toFixed(2)),
        bbox,
        costs: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, Number(v.cost.toFixed(3))])),
      },
    };
  }

  /** 加载打包好的字体样式表（fonts.css）。 */
  function loadFontCss(href) {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = () => resolve(true);
      link.onerror = () => reject(new Error('标题字体样式表加载失败'));
      document.head.appendChild(link);
    });
  }

  root.PosterTitle = { render, loadFontCss, splitTitle };
})(window);
