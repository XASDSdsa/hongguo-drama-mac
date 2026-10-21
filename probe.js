// 红果：同一集，官网直链和 App 接口各给的是什么分辨率（不下载整集，只读文件头）
const { execFileSync } = require('child_process');
const axios = require('axios');
const catalog = require('./app/src/native/catalog');
const hg = require('./app/src/native/hongguo');
const appSource = require('./app/src/native/app-source');
const out = [];
const note = (level, title, text) => console.log(`::${level} title=${title}::${String(text).replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
function probe(url) {
  try {
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-user_agent', hg.UA || 'Mozilla/5.0', '-headers', `Referer: ${hg.VIDEO_REFERER || 'https://hongguoduanju.com/'}\r\n`, '-show_entries', 'stream=codec_type,codec_name,width,height,bit_rate:format=bit_rate,duration', '-of', 'json', url], { timeout: 40000 }).toString());
    const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
    return `${v.width}x${v.height} ${v.codec_name} ${Math.round((j.format?.bit_rate || 0) / 1000)}kbps`;
  } catch (e) { return 'ffprobe失败:' + String(e.stderr || e.message).slice(0, 80).replace(/\s+/g, ' '); }
}
(async () => {
  const items = [];
  for (const rank of catalog.RANKS.slice(0, 2)) {
    const url = `https://hongguoduanju.com/rank/${rank.path}`;
    const html = (await axios.get(url, { responseType: 'text', timeout: 20000 })).data;
    for (const it of catalog.parseRank(html, rank, 1, url).results.slice(0, 10)) items.push(it);
  }
  for (const it of items) {
    let line = `${it.series_title}(${it.series_id})`;
    try {
      const list = await hg.fetchEpisodeList(it.series_id);
      const vid = list.episodes[0].vid;
      const page = (await axios.get(`https://hongguoduanju.com/player/${it.series_id}/${vid}`, { responseType: 'text', timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0 Safari/537.36' } })).data;
      const urls = [...page.matchAll(/"main_url"\s*:\s*"([^"]+)"/g)].length;
      const defs = [...new Set([...page.matchAll(/"(?:definition|quality_desc|vheight|vwidth|height|width)"\s*:\s*"?([^",}]+)/g)].map((m) => m[0].replace(/"/g, '')))].slice(0, 12).join(' ');
      const web = await hg.fetchPlayUrlFromWeb(vid, it.series_id);
      line += ` | 官网: ${web?.url ? probe(web.url) : '无'} (页面里 ${urls} 个 main_url; ${defs || '无清晰度字段'})`;
      try {
        const a = await appSource.fetchAppPlayUrl(vid);
        line += ` | App: ${a.quality} ${probe(a.url)}${a.contentKey ? ' 加密' : ''}`;
      } catch (e) { line += ` | App: 失败 ${e.message.slice(0, 60)}`; }
    } catch (e) { line += ` | 错误 ${e.message.slice(0, 80)}`; }
    out.push(line);
    console.log(line);
  }
  note('notice', '红果分辨率 1', out.slice(0, 10).join('\n'));
  note('notice', '红果分辨率 2', out.slice(10).join('\n'));
})().catch((e) => { note('error', 'probe', e.stack); process.exit(1); });
