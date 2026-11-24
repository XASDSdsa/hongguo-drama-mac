// Execute the app download/decrypt pipeline against complete real episodes.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const {pipeline} = require('node:stream/promises');
const axios = require('axios');
async function verifyDownloadV5Live(root = path.join(__dirname,'..')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'v5-download-中文-'));
  const evidence=[];
  try {
    const hongguo = require(path.join(root, 'src/native/hongguo'));
    const resolved = new Map();
    const tracedHongguo = { ...hongguo, fetchPlayUrlSingle: async (...args) => {
      const info = await hongguo.fetchPlayUrlSingle(...args);
      if (args[2]?.best) resolved.set(String(args[0]), { sourceProvider: info.sourceProvider, sourceRoute: info.sourceRoute, encrypted: !!info.contentKey });
      return info;
    } };
    const downloadErrors = require(path.join(root, 'src/native/download-errors'));
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    if (root.endsWith('.asar')) require('./protect-app.cjs').verifyProtectedArchive(root);
    const functionSource = name => {
      const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
      assert.ok(start >= 0,name);
      return source.slice(start,source.indexOf('\n}',start)+2);
    };
    const snippets = ['executeHongguoDownload', 'requestMedia', 'watchStall', 'decryptContentKeyFile'].map(functionSource).join('\n');
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const execute = vm.runInNewContext(snippets + '\nexecuteHongguoDownload', {
      require, fs, fsp, path, pipeline, URL, setTimeout, clearTimeout, axios, hongguo: tracedHongguo, downloadErrors,
      downloadRetryDelays: [2000], resolveFfmpeg: () => ffmpeg,
      seriesInfo: { ORIGINAL_DIR: '原剧', seriesDirOf: () => directory },
      markPipelineDownloaded() {}, scheduleSeriesRefresh() {}, sendToRenderer() {}, saveDownloadTasks() {},
      hasCompleteTaskFile: () => false, savePathIndex: null,
    });
    for (const [index, vid] of ['7696354284157291544', '7696354303719525400'].entries()) {
      const task = { id: vid, customDir: directory, filename: `第${index + 1}集.mp4`, hongguoInfo: { vid, series_id: '7696351358173072409' } };
      await execute(task);
      assert.equal(task.status, 'completed', task.error);
      const origin = resolved.get(vid);
      assert.equal(origin?.sourceProvider, 'official');
      assert.ok(['preload_current', 'video_tab', 'player_a', 'player_b', 'model_0', 'model_1'].includes(origin.sourceRoute));
      assert.ok(origin.encrypted, 'verify encrypted official media, not a public preview');
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', task.savePath], { encoding: 'utf8', timeout: 30000 });
      assert.equal(probe.status, 0);
      const info = JSON.parse(probe.stdout);
      const video = info.streams.find(item => item.codec_type === 'video');
      assert.ok(Math.min(video.width, video.height) >= 720);
      assert.ok(info.streams.some(item => item.codec_type === 'audio'));
      assert.ok(Number(info.format.duration) > 90, 'a preview must not count as a full episode');
      const decode = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', task.savePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 90000, windowsHide: true });
      assert.equal(decode.status, 0, 'full video/audio decode');
      assert.equal(fs.existsSync(task.savePath + '.enc.tmp'), false);
      evidence.push({ ...origin, platform: process.platform, vid, bytes: fs.statSync(task.savePath).size, width: video.width, height: video.height, duration: info.format.duration, fullDecode: true });
      console.log('PASS real complete download', JSON.stringify(evidence.at(-1)));
    }
    return evidence;
  } finally { fs.rmSync(directory,{recursive:true,force:true,maxRetries:3}); }
}
module.exports={verifyDownloadV5Live};
if(require.main===module)verifyDownloadV5Live(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1});
