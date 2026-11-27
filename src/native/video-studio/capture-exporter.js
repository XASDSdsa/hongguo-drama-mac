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

function serializeStudioDataForRenderer(studioResult, allEpisodes = null) {
  const processedList = (studioResult.episodes || []).map((ep) => ({
    ...ep,
    shots: (ep.shots || []).map((s) => ({
      ...s,
      posterUrl: toFileUrl(s.posterPath),
      videoUrl: toFileUrl(s.videoPath),
    })),
  }));
  const processedByNum = new Map(processedList.map((ep) => [Number(ep.number), ep]));

  // 左侧菜单填入整个文件夹的全部集数（仅菜单展示），已选择的集数保留完整反推内容
  const folderEps = Array.isArray(allEpisodes) && allEpisodes.length ? allEpisodes : processedList;
  const seenNums = new Set();
  const mergedEpisodes = [];
  for (const item of folderEps) {
    const num = Number(item?.number);
    if (!Number.isFinite(num) || seenNums.has(num)) continue;
    seenNums.add(num);
    if (processedByNum.has(num)) {
      mergedEpisodes.push(processedByNum.get(num));
    } else {
      mergedEpisodes.push({
        id: `ep-${num}`,
        number: num,
        title: `第${num}集`,
        fullTitle: `${studioResult.seriesTitle} · 第${num}集`,
        synopsis: '',
        shots: [],
        menuOnly: true,
      });
    }
  }
  for (const ep of processedList) {
    const num = Number(ep.number);
    if (!seenNums.has(num)) {
      seenNums.add(num);
      mergedEpisodes.push(ep);
    }
  }
  mergedEpisodes.sort((a, b) => Number(a.number) - Number(b.number));

  const processedIndices = [];
  const menuIndexByNumber = new Map();
  mergedEpisodes.forEach((ep, idx) => {
    menuIndexByNumber.set(Number(ep.number), idx);
    if (!ep.menuOnly) processedIndices.push(idx);
  });

  return {
    payload: {
      seriesTitle: studioResult.seriesTitle,
      activeEpisodeId: processedList[0]?.id || mergedEpisodes[0]?.id || 'ep-1',
      sharedAssets: (studioResult.sharedAssets || []).map((a) => ({
        ...a,
        imageUrl: toFileUrl(a.imagePath),
      })),
      episodes: mergedEpisodes,
    },
    processedIndices: processedIndices.length ? processedIndices : [0],
    menuIndexByNumber,
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
async function recordWalkthroughVideo({ win, ffmpegPath, outMp4Path, processedIndices, onProgress, signal }) {
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
  ffmpegProc.stdin?.on('error', () => {});

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
    const targetIndices = Array.isArray(processedIndices) && processedIndices.length ? processedIndices : [0];
    const epCount = targetIndices.length;

    // 1. 点击「AI资产图」→ 从顶部慢慢平滑滚动到最下面
    onProgress?.({ stage: 'record_video', percent: 84, message: '正在录制操作视频（1/3：查看 AI 资产图并平滑滚动到底部）...' });
    await runAction(`(() => { const p = window.__studio.getTabCenter('assets'); window.__studio.moveCursor(p.x, p.y); })()`);
    await sleep(450);
    await runAction(`window.__studio.selectEpisode(${targetIndices[0]}); window.__studio.setMode('assets'); window.__studio.scrollAssets(0);`);
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
    onProgress?.({ stage: 'record_video', percent: 89, message: `正在录制操作视频（2/3：节点画布逐集查看所选 ${epCount} 集）...` });
    await runAction(`(() => { const p = window.__studio.getTabCenter('canvas'); window.__studio.moveCursor(p.x, p.y); })()`);
    await sleep(450);
    await runAction(`window.__studio.setMode('canvas'); window.__studio.toggleOmni(false);`);
    await sleep(400);

    for (const menuIdx of targetIndices) {
      if (signal?.aborted) break;
      await runAction(`(() => { const p = window.__studio.getEpisodeButtonCenter(${menuIdx}); window.__studio.moveCursor(p.x, p.y); })()`);
      await sleep(400);
      await runAction(`window.__studio.selectEpisode(${menuIdx}); window.__studio.toggleOmni(false);`);
      await sleep(1600);
    }

    // 3. 点击「分镜流水线」→ 逐个点击所选的每一集并展示
    onProgress?.({ stage: 'record_video', percent: 94, message: `正在录制操作视频（3/3：分镜流水线逐集查看所选 ${epCount} 集）...` });
    await runAction(`(() => { const p = window.__studio.getTabCenter('pipeline'); window.__studio.moveCursor(p.x, p.y); })()`);
    await sleep(450);
    await runAction(`window.__studio.setMode('pipeline');`);
    await sleep(300);

    for (const menuIdx of targetIndices) {
      if (signal?.aborted) break;
      await runAction(`(() => { const p = window.__studio.getEpisodeButtonCenter(${menuIdx}); window.__studio.moveCursor(p.x, p.y); })()`);
      await sleep(400);
      await runAction(`window.__studio.selectEpisode(${menuIdx}); window.__studio.scrollPipeline(0);`);
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
  allEpisodes = null,
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
    const { payload, processedIndices, menuIndexByNumber } = serializeStudioDataForRenderer(studioResult, allEpisodes);
    const firstProcessedIdx = processedIndices[0] ?? 0;
    await win.webContents.executeJavaScript(`window.__studio.init(${JSON.stringify(payload)})`);
    await win.webContents.executeJavaScript(`window.__studio.waitForImages()`);
    await sleep(500);

    // 1. Capture <剧名>AI资产图.png
    onProgress({ stage: 'capture_assets', percent: 75, message: `正在导出「${path.basename(outputPaths.assetScreenshot)}」...` });
    await win.webContents.executeJavaScript(`window.__studio.selectEpisode(${firstProcessedIdx}); window.__studio.setMode('assets'); window.__studio.scrollAssets(0);`);
    await sleep(450);
    await captureWindowPng(win, outputPaths.assetScreenshot);

    // 2. Capture <剧名>节点画布.png (Mode 2 centered 4-column DAG canvas)
    if (outputPaths.canvasScreenshot) {
      onProgress({ stage: 'capture_canvas', percent: 77, message: `正在导出「${path.basename(outputPaths.canvasScreenshot)}」...` });
      await win.webContents.executeJavaScript(`window.__studio.selectEpisode(${firstProcessedIdx}); window.__studio.setMode('canvas'); window.__studio.toggleOmni(false);`);
      await win.webContents.executeJavaScript(`window.__studio.waitForImages()`);
      await sleep(550);
      await captureWindowPng(win, outputPaths.canvasScreenshot);
    }

    // 3. Capture <剧名>第N集.png for each selected episode (Mode 3 分镜流水线)
    const epOutputs = [];
    for (let i = 0; i < studioResult.episodes.length; i += 1) {
      const ep = studioResult.episodes[i];
      const target = outputPaths.episodeScreenshots.find((x) => x.number === ep.number);
      if (!target) continue;
      const menuIdx = menuIndexByNumber.get(Number(ep.number)) ?? i;
      onProgress({
        stage: 'capture_episode',
        percent: 78 + Math.round(((i + 1) / Math.max(1, studioResult.episodes.length)) * 5),
        message: `正在导出「${target.fileName}」...`,
      });
      await win.webContents.executeJavaScript(
        `window.__studio.selectEpisode(${menuIdx}); window.__studio.setMode('pipeline'); window.__studio.scrollPipeline(0);`,
      );
      await win.webContents.executeJavaScript(`window.__studio.waitForImages()`);
      await sleep(450);
      await captureWindowPng(win, target.filePath);
      epOutputs.push(target);
    }

    // 4. Record <剧名>操作视频.mp4
    await win.webContents.executeJavaScript(`window.__studio.selectEpisode(${firstProcessedIdx});`);
    await recordWalkthroughVideo({
      win,
      ffmpegPath,
      outMp4Path: outputPaths.operationVideo,
      processedIndices,
      onProgress,
      signal,
    });

    return {
      assetScreenshot: outputPaths.assetScreenshot,
      canvasScreenshot: outputPaths.canvasScreenshot || null,
      operationVideo: outputPaths.operationVideo,
      episodeScreenshots: epOutputs,
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { exportStudioMediaArtifacts };
