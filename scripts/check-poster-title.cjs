// 海报标题渲染：版式选择、字号/对比度、八套样式都能画出来。需要 Chromium（没有就跳过）。
// 设置 SAMPLE_OUT=/path/sheet.jpg 会把样张拼成一张图保存下来，方便人工看效果。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { STYLES, STYLE_IDS, FONTS, resolveStyle, pickStyleByGenre } = require('../src/native/poster-styles');
const { createTitleRenderer } = require('../src/native/poster-title');
const { openBrowser, backgroundScript, FONTS_DIR } = require('./lib/poster-browser.cjs');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL ' + name + ': ' + (e.stack || e.message));
  }
}

const TITLES = {
  gold: ['总裁的契约新娘', '先婚后爱，霸总他沦陷了'],
  fire: ['重生后我成了首富', '十年磨一剑'],
  ink: ['凤临天下', '嫡女归来'],
  frost: ['午夜十二点的来电', '第七个证人'],
  candy: ['闪婚后他宠我上天', '甜蜜暴击'],
  blood: ['离婚后他跪求复合', '黑化之后'],
  royal: ['九天之上我称帝', '万界之主'],
  urban: ['我在大厂当牛马', '打工人逆袭记'],
};

(async () => {
  await check('style table is complete and every style names a bundled font', () => {
    assert.equal(STYLE_IDS.length, 8);
    for (const style of STYLES) {
      assert.ok(FONTS[style.font], style.id + ' font');
      assert.ok(style.fill.length >= 2 && style.strokes.length >= 1, style.id);
      const resolved = resolveStyle(style.id);
      assert.equal(resolved.fontFamily, FONTS[style.font].family);
    }
    assert.equal(resolveStyle('nope').id, 'urban');
  });

  await check('genre keywords choose a sensible style', () => {
    assert.equal(pickStyleByGenre('霸总 豪门 总裁'), 'gold');
    assert.equal(pickStyleByGenre('重生后逆袭打脸'), 'fire');
    assert.equal(pickStyleByGenre('宫斗 王妃 古风'), 'ink');
    assert.equal(pickStyleByGenre('甜宠 校园 暗恋'), 'candy');
    assert.equal(pickStyleByGenre('没有任何关键词'), 'urban');
  });

  if (!fs.existsSync(FONTS_DIR)) {
    console.log('SKIP rendering checks (run npm run setup:title-fonts first)');
    process.exitCode = failures ? 1 : 0;
    return;
  }
  const session = await openBrowser();
  if (!session) {
    console.log('SKIP rendering checks (no Chromium found)');
    process.exitCode = failures ? 1 : 0;
    return;
  }
  const renderer = createTitleRenderer({ fontsDir: FONTS_DIR, driver: session.driver });
  const backgrounds = {};
  for (const kind of ['dusk', 'night', 'bright']) {
    const url = await session.page.evaluate(backgroundScript(kind));
    backgrounds[kind] = Buffer.from(url.split(',')[1], 'base64');
  }
  const diffFraction = (plain, rendered, bbox) =>
    session.page.evaluate(
      async ([a, b, box]) => {
        const load = (src) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = src;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const c = document.createElement('canvas');
        c.width = ia.naturalWidth;
        c.height = ia.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(ia, 0, 0);
        const da = g.getImageData(box.x, box.y, box.w, box.h).data;
        g.drawImage(ib, 0, 0);
        const db = g.getImageData(box.x, box.y, box.w, box.h).data;
        let changed = 0;
        for (let i = 0; i < da.length; i += 4)
          if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 90)
            changed += 1;
        return changed / (da.length / 4);
      },
      [
        'data:image/jpeg;base64,' + plain.toString('base64'),
        'data:image/jpeg;base64,' + rendered.toString('base64'),
        { x: Math.round(bbox.x), y: Math.round(bbox.y), w: Math.round(bbox.w), h: Math.round(bbox.h) },
      ],
    );

  const sheet = [];
  const hashes = new Set();
  try {
    for (const style of STYLES) {
      await check(`style ${style.id}: title is drawn inside the poster, big and readable`, async () => {
        const title = TITLES[style.id][0];
        const out = await renderer.render({
          image: backgrounds.night,
          title,
          styleId: style.id,
          tagline: '全集已更新',
        });
        const { meta } = out;
        assert.equal(meta.width, 1024);
        assert.equal(meta.height, 1536);
        assert.ok(meta.fontSize >= 1024 * 0.07, 'font size ' + meta.fontSize);
        assert.ok(meta.bbox.x >= 0 && meta.bbox.y >= 0 && meta.bbox.y + meta.bbox.h <= 1536, JSON.stringify(meta.bbox));
        assert.ok(meta.contrast >= 2.5, 'contrast ' + meta.contrast);
        const changed = await diffFraction(backgrounds.night, out.buffer, meta.bbox);
        assert.ok(changed > 0.05, 'little text drawn: ' + changed);
        hashes.add(crypto.createHash('sha1').update(out.buffer).digest('hex'));
        sheet.push({ buffer: out.buffer, label: style.id });
      });
    }
    await check('the eight styles produce eight different images', () => assert.equal(hashes.size, 8));

    await check(
      'layout: empty lower area of a busy poster is used; a face at the bottom pushes the title up',
      async () => {
        const night = await renderer.render({ image: backgrounds.night, title: '午夜来电', styleId: 'frost' });
        assert.equal(night.meta.layout, 'bottom', JSON.stringify(night.meta.costs));
        const bright = await renderer.render({ image: backgrounds.bright, title: '甜蜜暴击', styleId: 'candy' });
        assert.equal(bright.meta.layout, 'top', JSON.stringify(bright.meta.costs));
      },
    );

    await check('layout: faces reported by a vision model are avoided', async () => {
      const plain = await renderer.render({ image: backgrounds.night, title: '午夜来电', styleId: 'frost' });
      const avoided = await renderer.render({
        image: backgrounds.night,
        title: '午夜来电',
        styleId: 'frost',
        faces: [{ x: 0.2, y: 0.62, w: 0.6, h: 0.3 }],
      });
      assert.equal(plain.meta.layout, 'bottom');
      assert.notEqual(avoided.meta.layout, 'bottom');
    });

    await check('an explicit layout is respected', async () => {
      const out = await renderer.render({
        image: backgrounds.night,
        title: '午夜来电',
        styleId: 'frost',
        layout: 'middle',
      });
      assert.equal(out.meta.layout, 'middle');
    });

    await check('a long title wraps to two lines and still fits', async () => {
      const out = await renderer.render({
        image: backgrounds.dusk,
        title: '先婚后爱，霸总他沦陷了',
        styleId: 'gold',
      });
      assert.equal(out.meta.lines.length, 2);
      assert.deepEqual(out.meta.lines, ['先婚后爱', '霸总他沦陷了']);
      assert.ok(out.meta.fontSize >= 1024 * 0.07);
      assert.ok(out.meta.bbox.y + out.meta.bbox.h <= 1536);
    });

    await check('bright backgrounds get a stronger scrim so the light title keeps its contrast', async () => {
      const out = await renderer.render({
        image: backgrounds.bright,
        title: '甜蜜暴击',
        styleId: 'urban',
        layout: 'top',
      });
      assert.ok(out.meta.contrast >= 2.5, 'contrast ' + out.meta.contrast);
      assert.ok(out.meta.scrim > 0.3, 'scrim ' + out.meta.scrim);
    });

    await check('bad input is rejected with a clear message', async () => {
      await assert.rejects(renderer.render({ image: backgrounds.night, title: '', styleId: 'gold' }), /缺少标题/);
      await assert.rejects(
        renderer.render({ image: Buffer.from('not an image'), title: '标题', styleId: 'gold' }),
        /底图/,
      );
    });

    if (process.env.SAMPLE_OUT) {
      for (const [bg, id, title] of [
        ['dusk', 'gold', '总裁的契约新娘'],
        ['dusk', 'fire', '重生后我成了首富'],
        ['bright', 'candy', '闪婚后他宠我上天'],
        ['bright', 'urban', '我在大厂当牛马'],
      ]) {
        const out = await renderer.render({ image: backgrounds[bg], title, styleId: id, tagline: '全集已更新' });
        sheet.push({ buffer: out.buffer, label: bg + id });
      }
      const dataUrls = sheet.map((item) => 'data:image/jpeg;base64,' + item.buffer.toString('base64'));
      const url = await session.page.evaluate(async (list) => {
        const load = (src) =>
          new Promise((resolve) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.src = src;
          });
        const imgs = await Promise.all(list.map(load));
        const w = 384,
          h = 576,
          cols = 4,
          rows = Math.ceil(imgs.length / cols);
        const c = document.createElement('canvas');
        c.width = cols * w;
        c.height = rows * h;
        const g = c.getContext('2d');
        imgs.forEach((img, i) => g.drawImage(img, (i % cols) * w, Math.floor(i / cols) * h, w, h));
        return c.toDataURL('image/jpeg', 0.9);
      }, dataUrls);
      fs.writeFileSync(process.env.SAMPLE_OUT, Buffer.from(url.split(',')[1], 'base64'));
      console.log('sample sheet → ' + process.env.SAMPLE_OUT);
    }
  } finally {
    await renderer.close();
    await session.close();
  }
  if (failures) process.exitCode = 1;
})();
