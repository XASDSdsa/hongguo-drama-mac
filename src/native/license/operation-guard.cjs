'use strict';

const PROTECTED = new Set([
  'hongguo-download-batch', 'download-series-episodes', 'download-single-episode',
  'retry-task', 'retry-tasks', 'resume-all', 'merge-series', 'quchong-start', 'oneclick-start',
  'library-dedup', 'library-draft',
  'library-storyboards', 'library-storyboard-shot', 'library-storyboard-regenerate',
  'library-cost-report-file', 'library-cost-report-export-png',
  'publish-generate', 'publish-retitle', 'publish-save-poster-prompt',
  'ai-start-copies', 'ai-generate-episode-copy', 'ai-generate-cover',
  'start-series-transcription', 'start-series-analysis', 'start-reconstruction', 'start-series-workflow',
  'prepare-online-play', 'transcode-for-playback',
  'test-ai-text', 'test-ai-copy', 'test-ai-image', 'ark-test',
]);

async function checkOperation(channel, { authorized, trusted, session }) {
  if (!PROTECTED.has(channel)) return null;
  if (!authorized || !trusted) return { success: false, error: '请从已授权的软件主窗口操作。' };
  if (!session) return { success: false, error: '联网授权尚未就绪，请重新打开软件。' };
  const state = await session.ensure();
  return state.allowed ? null : { success: false, error: state.error, licenseRequired: true };
}

module.exports = { checkOperation, PROTECTED };
