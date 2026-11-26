'use strict';
/**
 * Isolated child process runner for reverseSeriesEpisodes() so Electron's main
 * process and UI renderer NEVER block (0ms main-thread work for ffmpeg, base64,
 * JSON parsing, and pngjs alpha cutout).
 */

const { reverseSeriesEpisodes } = require('./reverse-engine');

const controller = new AbortController();

process.on('message', async (msg) => {
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
        onProgress: (ev) => {
          try {
            process.send?.({ type: 'progress', data: ev });
          } catch {}
        },
      });
      process.send?.({ type: 'done', result });
      process.exit(0);
    } catch (error) {
      process.send?.({ type: 'error', error: error?.message || String(error) });
      process.exit(1);
    }
  }
});
