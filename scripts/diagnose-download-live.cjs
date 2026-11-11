'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');
const axios = require('axios');
const hg = require('../src/native/hongguo');
const { fetchAppPlayUrl } = require('../src/native/app-source');
const out = path.resolve('download-live-results');
fs.mkdirSync(out, { recursive: true });
const report = { platform: process.platform, node: process.version, results: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const samples = [
  ['妈咪受辱，大小姐回国掀翻全场', '7699003626647194649', 56],
  ['小镇是非多之同床异梦', '7703411040372919320', 6],
];
(async () => {
  for (const [title, vid, episode] of samples) {
    const item = { title, vid, episode, requests: [] };
    report.results.push(item);
    const intercept = axios.interceptors.response.use(response => {
      const url = new URL(response.config.url);
      if (/device_register|multi_video_model/.test(url.pathname)) {
        item.requests.push({ host: url.hostname, path: url.pathname, method: response.config.method,
          status: response.status, bytes: typeof response.data === 'string' ? Buffer.byteLength(response.data) : null });
      }
      return response;
    });
    const start = Date.now();
    try {
      const info = await fetchAppPlayUrl(vid);
      item.source = { quality: info.quality, codec: info.codec, encrypted: !!info.contentKey };
      const file = path.join(out, 'sample.enc');
      const response = await axios.get(info.url, {
        responseType: 'stream', timeout: 60000, maxContentLength: 256 * 1024 * 1024,
        headers: { 'User-Agent': info.userAgent || hg.UA, 'Accept-Encoding': 'identity' },
      });
      await pipeline(response.data, fs.createWriteStream(file));
      item.bytes = fs.statSync(file).size;
      if (!item.bytes || (response.headers['content-length'] && item.bytes !== Number(response.headers['content-length']))) throw Object.assign(new Error(), { code: 'INCOMPLETE_MEDIA' });
      const decoded = path.join(out, 'sample.mp4');
      const args = ['-v', 'error', '-y', ...(info.contentKey ? ['-decryption_key', info.contentKey] : []),
        '-i', file, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', decoded];
      const decrypt = spawnSync('ffmpeg', args, { timeout: 120000, encoding: 'utf8', windowsHide: true });
      item.ffmpeg = { status: decrypt.status, errorCode: decrypt.error?.code };
      if (decrypt.status === 0) {
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'format=duration,size', '-of', 'json', decoded], { timeout: 30000, encoding: 'utf8', windowsHide: true });
        if (probe.status === 0) item.media = JSON.parse(probe.stdout);
        const decode = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', decoded, '-f', 'null', '-'], { timeout: 120000, encoding: 'utf8', windowsHide: true });
        item.fullDecodePassed = decode.status === 0;
      }
      item.success = item.fullDecodePassed === true;
    } catch (error) {
      item.failure = { code: error.code, status: error.status || error.response?.status,
        message: /^[\u4e00-\u9fffA-Za-z0-9，。 、（）：；._-]+$/.test(error.message || '') ? error.message : 'Transfer/request failed',
        registrationFailure: error.registrationFailure };
      item.success = false;
    } finally {
      item.ms = Date.now() - start;
      axios.interceptors.response.eject(intercept);
      for (const file of ['sample.enc', 'sample.mp4']) fs.rmSync(path.join(out, file), { force: true });
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(item));
    }
    await sleep(15000);
  }
})().catch(error => { console.log('DIAGNOSTIC_FAILURE', error.code || 'UNKNOWN'); process.exitCode = 1; });

