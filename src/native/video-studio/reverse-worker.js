'use strict';
/**
 * Isolated child process runner for reverseSeriesEpisodes() so Electron's main
 * process and UI renderer NEVER block (0ms main-thread work for ffmpeg, base64,
 * JSON parsing, and pngjs alpha cutout).
 */

const { reverseSeriesEpisodes } = require('./reverse-engine');

const controller = new AbortController();
const parentPort = process.parentPort || null;

function sendToParent(payload) {
  try {
    if (parentPort) parentPort.postMessage(payload);
    else process.send?.(payload);
  } catch {}
}

async function handleMessage(msg) {
  if (!msg) return;
  if (msg.type === 'cancel') {
    controller.abort();
    return;
  }
  if (msg.type === 'start') {
    try {
      const result = await reverseSeriesEpisodes({
        ...msg.options,
        signal: controller.signal,
        onProgress: (ev) => sendToParent({ type: 'progress', data: ev }),
      });
      sendToParent({ type: 'done', result });
      process.exit(0);
    } catch (error) {
      sendToParent({ type: 'error', error: error?.message || String(error) });
      process.exit(1);
    }
  }
}

if (parentPort) {
  parentPort.on('message', (event) => handleMessage(event?.data));
} else {
  process.on('message', handleMessage);
}
