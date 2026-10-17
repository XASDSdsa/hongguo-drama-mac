// 打包前确认海报标题字体已准备好（build/title-fonts），缺了就让打包失败，而不是发出一个标题画不出来的安装包。
const fs = require('node:fs');
const path = require('node:path');
const { FONTS } = require('../src/native/poster-styles');

function verifyBundle(projectDir) {
  const dir = path.join(projectDir, 'build', 'title-fonts');
  const css = path.join(dir, 'fonts.css');
  if (!fs.existsSync(css)) throw new Error('缺少 build/title-fonts/fonts.css，请先运行 npm run setup:title-fonts');
  const text = fs.readFileSync(css, 'utf8');
  for (const [id, font] of Object.entries(FONTS)) {
    const files = fs.existsSync(path.join(dir, id))
      ? fs.readdirSync(path.join(dir, id)).filter((n) => n.endsWith('.woff2'))
      : [];
    if (files.length < 20) throw new Error(`标题字体 ${id} 不完整（${files.length} 个切片）`);
    if (!text.includes(`font-family: '${font.family}'`)) throw new Error(`fonts.css 里没有 ${font.family}`);
    if (!fs.existsSync(path.join(dir, id, 'LICENSE.txt'))) throw new Error(`标题字体 ${id} 缺少许可证文本`);
  }
}

if (require.main === module) {
  verifyBundle(path.resolve(__dirname, '..'));
  console.log('标题字体检查通过');
}
module.exports = { verifyBundle };
