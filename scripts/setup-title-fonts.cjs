// 准备海报标题用的字体：从 @fontsource 包里拷出需要的字重，生成 build/title-fonts/fonts.css。
// 字体均为 SIL OFL 1.1，可商用并随应用分发；许可证文本一并拷贝。
const fs = require('node:fs');
const path = require('node:path');
const { FONTS } = require('../src/native/poster-styles');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'build', 'title-fonts');

function setup() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const css = ['/* 自动生成：npm run setup:title-fonts */'];
  let total = 0;
  for (const [id, font] of Object.entries(FONTS)) {
    const pkg = path.join(root, 'node_modules', '@fontsource', id);
    const source = path.join(pkg, `${font.weight}.css`);
    if (!fs.existsSync(source)) throw new Error(`缺少字体包 @fontsource/${id}（请先 npm ci）`);
    const dest = path.join(out, id);
    fs.mkdirSync(dest, { recursive: true });
    const files = fs
      .readdirSync(path.join(pkg, 'files'))
      .filter((name) => name.endsWith(`-${font.weight}-normal.woff2`));
    if (files.length < 20) throw new Error(`${id} 的字体切片数量异常（${files.length}）`);
    for (const name of files) {
      fs.copyFileSync(path.join(pkg, 'files', name), path.join(dest, name));
      total += fs.statSync(path.join(dest, name)).size;
    }
    fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(dest, 'LICENSE.txt'));
    // 只保留 woff2 来源，路径改成相对 fonts.css 的位置。
    const text = fs
      .readFileSync(source, 'utf8')
      .replace(
        /src:\s*url\(\.\/files\/([^)]+\.woff2)\)\s*format\('woff2'\)[^;]*;/g,
        (_, name) => `src: url(./${id}/${name}) format('woff2');`,
      );
    if (!text.includes(`./${id}/`)) throw new Error(`${id} 的样式表格式无法识别`);
    css.push(text);
  }
  fs.writeFileSync(path.join(out, 'fonts.css'), css.join('\n'));
  console.log(`标题字体已准备：${Object.keys(FONTS).length} 款，${(total / 1048576).toFixed(1)} MB → ${out}`);
}

if (require.main === module) setup();
module.exports = { setup, out };
