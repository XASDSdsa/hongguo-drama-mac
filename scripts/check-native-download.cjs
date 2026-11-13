'use strict';
// Execute the packaged app's actual download function against two complete public sample episodes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const asar = require('@electron/asar');
const axios = require('axios');
const stage = path.resolve(process.argv[2]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-download-中文-'));
const previousResources = process.resourcesPath;
(async () => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json')));
    assert.equal(manifest.version, '1.2.51');
    asar.extractAll(path.join(stage, 'app.asar'), directory);
    const resources = path.join(directory, 'resources');
    fs.mkdirSync(resources);
    fs.copyFileSync(path.join(stage, 'app.asar'), path.join(resources, 'app.asar'));
    fs.cpSync(path.join(stage, 'hongguo-player'), path.join(resources, 'hongguo-player'), { recursive: true });
    process.resourcesPath = resources;
    const hongguo = require(path.join(directory, 'src/native/hongguo'));
    const downloadErrors = require(path.join(directory, 'src/native/download-errors'));
    const source = fs.readFileSync(path.join(directory, 'main.js'), 'utf8');
    const functionSource = name => {
      const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
      assert.ok(start >= 0, name);
      return source.slice(start, source.indexOf('\n}', start) + 2);
    };
    const snippets = ['executeHongguoDownload', 'requestMedia', 'watchStall', 'decryptContentKeyFile'].map(functionSource).join('\n');
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const execute = vm.runInNewContext(snippets + '\nexecuteHongguoDownload', {
      require, fs, fsp, path, pipeline, URL, setTimeout, clearTimeout, axios, hongguo, downloadErrors,
      downloadRetryDelays: [2000], resolveFfmpeg: () => ffmpeg,
      seriesInfo: { ORIGINAL_DIR: '原剧', seriesDirOf: () => directory },
      markPipelineDownloaded() {}, scheduleSeriesRefresh() {}, sendToRenderer() {}, saveDownloadTasks() {},
      hasCompleteTaskFile: () => false, savePathIndex: null,
    });
    for (const [index, vid] of ['7696354284157291544', '7696354303719525400'].entries()) {
      const task = { id: vid, customDir: directory, filename: `第${index + 1}集.mp4`, hongguoInfo: { vid, series_id: '7696351358173072409' } };
      await execute(task);
      assert.equal(task.status, 'completed', task.error);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', task.savePath], { encoding: 'utf8', timeout: 30000 });
      assert.equal(probe.status, 0);
      const info = JSON.parse(probe.stdout);
      const video = info.streams.find(item => item.codec_type === 'video');
      assert.equal(Math.min(video.width, video.height), 1080);
      assert.ok(info.streams.some(item => item.codec_type === 'audio'));
      assert.ok(Number(info.format.duration) > 90, 'a preview must not count as a full episode');
      const decode = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', task.savePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 90000, windowsHide: true });
      assert.equal(decode.status, 0, 'full video/audio decode');
      assert.equal(fs.existsSync(task.savePath + '.enc.tmp'), false);
      console.log(JSON.stringify({ platform: process.platform, vid, bytes: fs.statSync(task.savePath).size, width: video.width, height: video.height, duration: info.format.duration, fullDecode: true }));
    }
  } finally {
    process.resourcesPath = previousResources;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
