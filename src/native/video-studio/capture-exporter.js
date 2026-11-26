'use strict';
/**
 * Electron BrowserWindow Auto-Screenshot & Operation Walkthrough Video Exporter
 * Generates:
 *   1. <剧名>AI资产图.png           (Mode 1 full shared asset library screenshot)
 *   2. <剧名>第<数字>集.png         (Mode 3 storyboard pipeline screenshot per selected episode)
 *   3. <剧名>操作视频.mp4           (Smooth animated walkthrough across AI资产图 -> 节点画布 + 生成面板 -> 分镜流水线)
 *
 * Uses Chromium DevTools Protocol `Page.startScreencast` piped into bundled ffmpeg so it works
 * headlessly on BOTH Windows and macOS with ZERO OS screen-recording permission prompts!
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { BrowserWindow } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toFileUrl(p) {
  if (!p) return '';
  if (/^(https?|data|file):/i.test(p)) return p;
  return pathToFileURL(path.resolve(p)).href;
}

function serializeStudioDataForRenderer(studioResult) {
  return {
    seriesTitle: studioResult.seriesTitle,
    sharedAssets: (studioResult.sharedAssets || []).map((a) => ({
      ...a,
      imageUrl: toFileUrl(a.imagePath),
    })),
    episodes: (studioResult.episodes || []).map((ep) => ({
      ...ep,
      shots: (ep.shots || []).map((s) => ({
        ...s,
        posterUrl: toFileUrl(s.posterPath),
        videoUrl: toFileUrl(s.videoPath),
      })),
    })),
  };
}

async function captureWindowPng(win, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outPath, img.toPNG());
  return outPath;
}

/**
 * Record an automated walkthrough MP4 via CDP Page.startScreencast -> bundled ffmpeg.
 */
async function recordWalkthroughVideo({ win, ffmpegPath, outMp4Path, episodes, onProgress, signal }) {
  fs.mkdirSync(path.dirname(outMp4Path), { recursive: true });
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');

  const ffmpegProc = spawn(
    ffmpegPath,
    [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-r', '12',
      '-i', '-',
      '-vf', 'scale=1600:960:force_original_aspect_ratio=decrease,pad=1600:960:(ow-iw)/2:(oh-ih)/2:color=#070b13,fps=24',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outMp4Path,
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );

  let lastFrameBuf = null;
  let recording = true;

  const onMessage = (_event, method, params) => {
    if (method === 'Page.screencastFrame' && params?.data) {
      lastFrameBuf = Buffer.from(params.data, 'base64');
      dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }
  };
  dbg.on('message', onMessage);

  await dbg.sendCommand('Page.startScreencast', {
    format: 'jpeg',
    quality: 88,
    maxWidth: 1600,
    maxHeight: 960,
    everyNthFrame: 1,
  });

  // Steady 12fps frame pumper so even static pauses hold smooth constant frame rate
  const pumper = setInterval(() => {
    if (!recording || !lastFrameBuf || ffmpegProc.stdin.destroyed) return;
    try {
      ffmpegProc.stdin.write(lastFrameBuf);
    } catch {}
  }, Math.round(1000 / 12));

  const runAction = (js) => win.webContents.executeJavaScript(js).catch(() => {});

  try {
    const epCount = Math.max(1, episodes.length);

    // 1. 点击「AI资产图」→ 从顶部慢慢平滑滚动到最下面
    onProgress?.({ stage: 'record_video', percent: 84, message: '正在录制操作视频（1/3：查看 AI 资产图并平滑滚动到底部）...' });
    await runAction(`(() => { const p = window.__studio.getTabCenter('assets'); window.__studio.moveCursor(p.x, p.y); })()`);
    await sleep(450);
    await runAction(`window.__studio.selectEpisode(0); window.__studio.setMode('assets'); window.__studio.scrollAssets(0);`);
    await sleep(900);

    const maxAssetScroll = (await runAction(`window.__studio.getAssetsScrollMax()`)) || 0;
    if (maxAssetScroll > 40) {
      const steps = Math.min(8, Math.max(4, Math.ceil(maxAssetScroll / 380)));
      await runAction(`window.__studio.moveCursor(820, 480);`);
      for (let s = 1; s <= steps; s += 1) {
        if (signal?.aborted) break;
        const targetY = Math.round((maxAssetScroll * s) / steps);
        await runAction(`window.__studio.scrollAssets(${targetY});`);
        await sleep(850);
      }
      await sleep(700);
    } else {
      await sleep(1600);
    }

    // 2. 点击「节点画布 + 生成面板」→ 居中清晰展示 → 逐个点击所选的每一集
    onProgress?.({ stage: 'record_video', percent: 89, message: `正在录制操作视频（2/3：节点画布逐集查看全部 ${epCount} 集）...` });
    await runAction(`(() => { const p = window.__studio.getTabCenter('canvas'); window.__studio.moveCursor(p.x, p.y); })()`);
    await sleep(450);
    await runAction(`window.__studio.setMode('canvas'); window.__studio.toggleOmni(false);`);
    await sleep(400);

    for (let i = 0; i < epCount; i += 1) {
      if (signal?.aborted) break;
      await runAction(`(() => { const p = window.__studio.getEpisodeButtonCenter(${i}); window.__studio.moveCursor(p.x, p.y); })()`);
      await sleep(400);
      await runAction(`window.__studio.selectEpisode(${i}); window.__studio.toggleOmni(false);`);
      await sleep(1600);
    }

    // 3. 点击「分镜流水线」→ 逐个点击所选的每一集并展示
    onProgress?.({ stage: 'record_video', percent: 94, message: `正在录制操作视频（3/3：分镜流水线逐集查看全部 ${epCount} 集）...` });
    await runAction(`(() => { const p = window.__studio.getTabCenter('pipeline'); window.__studio.moveCursor(p.x, p.y); })()`);
    await sleep(450);
    await runAction(`window.__studio.setMode('pipeline');`);
    await sleep(300);

    for (let i = 0; i < epCount; i += 1) {
      if (signal?.aborted) break;
      await runAction(`(() => { const p = window.__studio.getEpisodeButtonCenter(${i}); window.__studio.moveCursor(p.x, p.y); })()`);
      await sleep(400);
      await runAction(`window.__studio.selectEpisode(${i}); window.__studio.scrollPipeline(0);`);
      await sleep(1200);
      await runAction(`window.__studio.scrollPipeline(420);`);
      await sleep(1000);
    }

    await runAction(`window.__studio.hideCursor();`);
    await sleep(450);
  } finally {
    recording = false;
    clearInterval(pumper);
    dbg.removeListener('message', onMessage);
    await dbg.sendCommand('Page.stopScreencast').catch(() => {});
    try { dbg.detach(); } catch {}
    await new Promise((resolve) => {
      ffmpegProc.on('close', resolve);
      ffmpegProc.on('error', resolve);
      try { ffmpegProc.stdin.end(); } catch { resolve(); }
    });
  }

  return outMp4Path;
}

async function exportStudioMediaArtifacts({
  ffmpegPath,
  studioResult,
  outputPaths,
  onProgress = () => {},
  signal = null,
}) {
  const htmlPath = path.join(__dirname, 'studio', 'index.html');
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    show: false,
    frame: false,
    backgroundColor: '#070b13',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

  try {
    await win.loadFile(htmlPath);
    const payload = serializeStudioDataForRenderer(studioResult);
    await win.webContents.executeJavaScript(`window.__studio.init(${JSON.stringify(payload)})`);
    await win.webContents.executeJavaScript(`window.__studio.waitForImages()`);
    await sleep(500);

    // 1. Capture <剧名>AI资产图.png
    onProgress({ stage: 'capture_assets', percent: 76, message: `正在导出「${path.basename(outputPaths.assetScreenshot)}」...` });
    await win.webContents.executeJavaScript(`window.__studio.setMode('assets'); window.__studio.scrollAssets(0);`);
    await sleep(450);
    await captureWindowPng(win, outputPaths.assetScreenshot);

    // 2. Capture <剧名>第N集.png for each selected episode (Mode 3 分镜流水线)
    const epOutputs = [];
    for (let i = 0; i < studioResult.episodes.length; i += 1) {
      const ep = studioResult.episodes[i];
      const target = outputPaths.episodeScreenshots.find((x) => x.number === ep.number);
      if (!target) continue;
      onProgress({
        stage: 'capture_episode',
        percent: 78 + Math.round(((i + 1) / Math.max(1, studioResult.episodes.length)) * 5),
        message: `正在导出「${target.fileName}」...`,
      });
      await win.webContents.executeJavaScript(
        `window.__studio.selectEpisode(${i}); window.__studio.setMode('pipeline'); window.__studio.scrollPipeline(0);`,
      );
      await win.webContents.executeJavaScript(`window.__studio.waitForImages()`);
      await sleep(450);
      await captureWindowPng(win, target.filePath);
      epOutputs.push(target);
    }

    // 3. Record <剧名>操作视频.mp4
    await win.webContents.executeJavaScript(`window.__studio.selectEpisode(0);`);
    await recordWalkthroughVideo({
      win,
      ffmpegPath,
      outMp4Path: outputPaths.operationVideo,
      episodes: studioResult.episodes,
      onProgress,
      signal,
    });

    return {
      assetScreenshot: outputPaths.assetScreenshot,
      operationVideo: outputPaths.operationVideo,
      episodeScreenshots: epOutputs,
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { exportStudioMediaArtifacts };
