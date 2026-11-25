// SPDX-License-Identifier: GPL-3.0-only
// openhongguo-first download routing adapted from jackotom/hongguo-drama 8.3,
// a1b69da5562b9063f3442f3284c3347358f26090. Keep the accepted official fallback.
'use strict';
function createDownloadRouter(provider, sdk = async () => null) {
  return async function resolve(vid, official) {
    if (!/^\d{1,30}$/.test(String(vid || ''))) throw new Error('分集编号无效');
    try {
      const result = await provider(String(vid), {quality:'720p', allowLowerQuality:false});
      const rows = (result.candidates || [result]).filter(row =>
        row.format === 'mp4' && String(row.vid) === String(vid) && Math.min(row.width, row.height) >= 720);
      if (rows.length) {
        rows.sort((a,b) => Math.min(b.width,b.height)-Math.min(a.width,a.height));
        const selected = rows[0];
        return {...selected, backupUrls: rows.filter(row => row !== selected && row.codec === selected.codec && row.contentKey === selected.contentKey && row.width === selected.width && row.height === selected.height).map(row=>row.url).filter(url=>url!==selected.url).slice(0,2)};
      }
    } catch(error) {
      if (error.code === 'ERR_CANCELED') throw error;
    }
    const sdkResult = await sdk(String(vid));
    if (sdkResult?.url) return sdkResult;
    return official();
  };
}
const resolveDownloadSource = createDownloadRouter((...args) => require('./openhongguo-source').fetchPlayUrlSingle(...args), vid => require('./app-source').fetchSdkPlayUrl(vid));
module.exports = {createDownloadRouter, resolveDownloadSource};
