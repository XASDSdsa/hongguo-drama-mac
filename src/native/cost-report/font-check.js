'use strict';

// Localized family names and PostScript names can identify the same font.
// FangSong and the older GB2312 face are distinct entries.
function checkReportFonts(required, used) {
  // A WPS PDF can use subset names, glyph outlines or page images. Its embedded
  // glyph data is authoritative for the appearance the user sees in WPS.
  if (required.nativeWps) {
    if (used.some((font) => !font.embedded)) {
      throw new Error('WPS 输出中存在未嵌入的文字字形，无法保证 PNG 与 WPS 显示一致。');
    }
    return;
  }
  const aliases = {
    方正小标宋简体: ['FZXiaoBiaoSong-B05S', 'FZXiaoBiaoSong', 'FZXBSJW', 'FZXBSJW--GB1-0'],
    仿宋_GB2312: ['FangSong_GB2312', 'FangSong-GB2312', 'SimFang_GB2312'],
    仿宋: ['FangSong', 'SimFang'],
    宋体: ['SimSun'],
    黑体: ['SimHei'],
    楷体: ['KaiTi', 'SimKai'],
    楷体_GB2312: ['KaiTi_GB2312', 'SimKai_GB2312'],
    微软雅黑: ['MicrosoftYaHei'],
  };
  const normalize = (name) => String(name || '')
    .normalize('NFKC')
    .replace(/^[A-Z]{6}\+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/(?:bolditalic|boldoblique|bold|regular|italic|oblique|roman)(?:psmt|mt)?$|(?:psmt|mt)$/g, '');
  const match = (name, font) => font.embedded &&
    [name, ...(Object.hasOwn(aliases, name) ? aliases[name] : [])].some((candidate) => normalize(candidate) === normalize(font.name));

  const missing = required.fonts.filter((name) => !used.some((font) => match(name, font)));
  if (missing.length) {
    throw new Error(`无法用模板原字体导出：${missing.join('、')}。请确认原字体可用，或使用嵌入原字体的模板。`);
  }
  if (required.eastAsianFonts.length && used.some((font) => font.han &&
      !required.eastAsianFonts.some((name) => match(name, font)))) {
    throw new Error('报告转换时发生字体替换，请确认模板中的中文字体可用。');
  }
}

module.exports = { checkReportFonts };
