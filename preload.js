const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 应用信息 / 官网链接
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // 红果解析与下载
  hongguoResolve: (input) => ipcRenderer.invoke('hongguo-resolve', input),
  hongguoDownloadBatch: (payload) => ipcRenderer.invoke('hongguo-download-batch', payload),

  // 搜索（内嵌浏览器嗅探）
  searchSeries: (keyword, options) => ipcRenderer.invoke('search-series', keyword, options),
  searchResolve: (seriesId) => ipcRenderer.invoke('search-resolve', seriesId),
  refreshAllSeries: () => ipcRenderer.invoke('refresh-all-series'),
  onSeriesRefreshProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('series-refresh-progress', listener);
    return () => ipcRenderer.removeListener('series-refresh-progress', listener);
  },
  searchWindowShow: (visible, sourceUrl) => ipcRenderer.invoke('search-window-show', visible, sourceUrl),
  getSeriesList: () => ipcRenderer.invoke('get-series-list'),
  removeSeries: (seriesId) => ipcRenderer.invoke('remove-series', seriesId),
  purgeEmptySeries: () => ipcRenderer.invoke('purge-empty-series'),
  restoreDismissedSeries: () => ipcRenderer.invoke('restore-dismissed-series'),
  dismissedCount: () => ipcRenderer.invoke('dismissed-count'),

  // 在线播放（内存缓存 + 自定义流协议，不落盘）
  prepareOnlinePlay: (payload) => ipcRenderer.invoke('prepare-online-play', payload),
  releaseOnlinePlay: (payload) => ipcRenderer.invoke('release-online-play', payload),
  onlineCacheStatus: () => ipcRenderer.invoke('online-cache-status'),
  clearOnlineCache: () => ipcRenderer.invoke('clear-online-cache'),
  onOnlinePlayProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('online-play-progress', listener);
    return () => ipcRenderer.removeListener('online-play-progress', listener);
  },

  // 兼容模式（HEVC -> H.264 转码，解决「黑屏有声」）
  transcodeForPlayback: (payload) => ipcRenderer.invoke('transcode-for-playback', payload),
  cancelTranscodeForPlayback: (payload) => ipcRenderer.invoke('cancel-transcode-for-playback', payload),
  compatCacheStatus: () => ipcRenderer.invoke('compat-cache-status'),
  clearCompatCache: () => ipcRenderer.invoke('clear-compat-cache'),
  decodeCapability: () => ipcRenderer.invoke('decode-capability'),
  onTranscodeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('transcode-progress', listener);
    return () => ipcRenderer.removeListener('transcode-progress', listener);
  },

  // 浏览（分类页）
  browseCategories: () => ipcRenderer.invoke('browse-categories'),
  browseList: (options) => ipcRenderer.invoke('browse-list', options),
  playSeries: (payload) => ipcRenderer.invoke('play-series', payload),
  onNavigate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },

  // 播放器
  getSeriesEpisodes: (seriesId) => ipcRenderer.invoke('get-series-episodes', seriesId),
  downloadSingleEpisode: (seriesId, vidIndex) => ipcRenderer.invoke('download-single-episode', seriesId, vidIndex),
  // AI 发布素材：独立于下载/合并任务，支持封面重绘与已下载分集文案生成
  getSeriesPipelineStatus: (seriesId) => ipcRenderer.invoke('get-series-pipeline-status', seriesId),
  getFasterWhisperStatus: () => ipcRenderer.invoke('get-faster-whisper-status'),
  getSeriesTranscription: (seriesId) => ipcRenderer.invoke('get-series-transcription', seriesId),
  startSeriesTranscription: (payload) => ipcRenderer.invoke('start-series-transcription', payload),
  cancelSeriesTranscription: (batchId) => ipcRenderer.invoke('cancel-series-transcription', batchId),
  onSeriesTranscriptionProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('series-transcription-progress', listener);
    return () => ipcRenderer.removeListener('series-transcription-progress', listener);
  },
  getSeriesAnalysis: (seriesId) => ipcRenderer.invoke('get-series-analysis', seriesId),
  startSeriesAnalysis: (payload) => ipcRenderer.invoke('start-series-analysis', payload),
  cancelSeriesAnalysis: (batchId) => ipcRenderer.invoke('cancel-series-analysis', batchId),
  onSeriesAnalysisProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('series-analysis-progress', listener);
    return () => ipcRenderer.removeListener('series-analysis-progress', listener);
  },
  // 本地结构化拆解：独立模块与显式编排
  getStructureRuntime: () => ipcRenderer.invoke('get-structure-runtime'),
  getStructureProjects: () => ipcRenderer.invoke('get-structure-projects'),
  reconstructionSelectVideo: () => ipcRenderer.invoke('reconstruction-select-video'),
  getReconstructionStatus: (projectId) => ipcRenderer.invoke('get-reconstruction-status', projectId),
  startReconstruction: (payload) => ipcRenderer.invoke('start-reconstruction', payload),
  cancelReconstruction: (projectId) => ipcRenderer.invoke('cancel-reconstruction', projectId),
  onReconstructionProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('reconstruction-progress', listener);
    return () => ipcRenderer.removeListener('reconstruction-progress', listener);
  },
  // 下载管理的一键工作流：只接收已完成去重的集，逐集完成结构化并校验剪映草稿。
  getSeriesWorkflowStatus: (seriesId) => ipcRenderer.invoke('get-series-workflow-status', seriesId),
  startSeriesWorkflow: (payload) => ipcRenderer.invoke('start-series-workflow', payload),
  cancelSeriesWorkflow: (batchId) => ipcRenderer.invoke('cancel-series-workflow', batchId),
  onEpisodeWorkflowProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('episode-workflow-progress', listener);
    return () => ipcRenderer.removeListener('episode-workflow-progress', listener);
  },
  aiGenerateCover: (payload) => ipcRenderer.invoke('ai-generate-cover', payload),
  aiStartCopies: (payload) => ipcRenderer.invoke('ai-start-copies', payload),
  aiGenerateEpisodeCopy: (payload) => ipcRenderer.invoke('ai-generate-episode-copy', payload),
  getAiMaterialTasks: (options) => ipcRenderer.invoke('get-ai-material-tasks', options),
  cancelAiMaterial: (id) => ipcRenderer.invoke('cancel-ai-material', id),
  openAiMaterial: (id) => ipcRenderer.invoke('open-ai-material', id),
  getWhisperStatus: () => ipcRenderer.invoke('get-whisper-status'),
  onAiMaterialProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('ai-material-progress', listener);
    return () => ipcRenderer.removeListener('ai-material-progress', listener);
  },
  savePlaybackPosition: (seriesId, vidIndex, currentTime) =>
    ipcRenderer.invoke('save-playback-position', seriesId, vidIndex, currentTime),
  getPlaybackPosition: (seriesId) => ipcRenderer.invoke('get-playback-position', seriesId),

  // 一键合并
  getFfmpegStatus: () => ipcRenderer.invoke('get-ffmpeg-status'),
  mergeSeries: (seriesId, outputName, options) => ipcRenderer.invoke('merge-series', seriesId, outputName, options),
  cancelMerge: (id) => ipcRenderer.invoke('cancel-merge', id),
  getMergeTasks: () => ipcRenderer.invoke('get-merge-tasks'),
  deleteMergeTask: (id) => ipcRenderer.invoke('delete-merge-task', id),
  onMergeProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-progress', listener);
    return () => ipcRenderer.removeListener('merge-progress', listener);
  },
  onMergeTaskAdded: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-task-added', listener);
    return () => ipcRenderer.removeListener('merge-task-added', listener);
  },
  onMergeCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-completed', listener);
    return () => ipcRenderer.removeListener('merge-completed', listener);
  },
  onMergeFailed: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('merge-failed', listener);
    return () => ipcRenderer.removeListener('merge-failed', listener);
  },

  // 设置
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onStorageError: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('storage-error', listener);
    return () => ipcRenderer.removeListener('storage-error', listener);
  },

  // 网络代理
  getProxyStatus: () => ipcRenderer.invoke('get-proxy-status'),
  testProxy: (draft) => ipcRenderer.invoke('test-proxy', draft),

  // 下载管理
  getDownloadTasks: (options) => ipcRenderer.invoke('get-download-tasks', options),
  deleteTask: (taskId) => ipcRenderer.invoke('delete-task', taskId),
  deleteTasks: (taskIds) => ipcRenderer.invoke('delete-tasks', taskIds),

  // 文件清理
  deleteTaskWithFiles: (taskId, deleteFiles) => ipcRenderer.invoke('delete-task', taskId, { deleteFiles }),
  deleteTasksWithFiles: (taskIds, deleteFiles) => ipcRenderer.invoke('delete-tasks', taskIds, { deleteFiles }),
  deleteSeriesFiles: (seriesId, options) => ipcRenderer.invoke('delete-series-files', seriesId, options),
  deleteEpisodeFile: (seriesId, vidIndex) => ipcRenderer.invoke('delete-episode-file', seriesId, vidIndex),
  getStorageUsage: () => ipcRenderer.invoke('get-storage-usage'),
  deleteAllDownloaded: () => ipcRenderer.invoke('delete-all-downloaded'),
  stopDownload: (taskId) => ipcRenderer.invoke('stop-download', taskId),
  retryTask: (taskId) => ipcRenderer.invoke('retry-task', taskId),
  retryTasks: (taskIds) => ipcRenderer.invoke('retry-tasks', taskIds),
  openFolder: (taskId) => ipcRenderer.invoke('open-folder', taskId),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),

  // 本地视频处理（去重）
  quchongDefaults: () => ipcRenderer.invoke('quchong-defaults'),
  quchongSetConcurrency: (jobs) => ipcRenderer.invoke('quchong-set-concurrency', jobs),
  getQuchongTasks: () => ipcRenderer.invoke('get-quchong-tasks'),
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryEpisodes: (dir) => ipcRenderer.invoke('library-episodes', dir),
  libraryImport: () => ipcRenderer.invoke('library-import'),
  libraryRemoveImport: (dir) => ipcRenderer.invoke('library-remove-import', dir),
  libraryDedup: (payload) => ipcRenderer.invoke('library-dedup', payload),
  libraryEstimate: (payload) => ipcRenderer.invoke('library-estimate', payload),
  libraryDraft: (payload) => ipcRenderer.invoke('library-draft', payload),
  libraryDraftCancel: (dir) => ipcRenderer.invoke('library-draft-cancel', dir),
  libraryRefreshRemote: (dir) => ipcRenderer.invoke('library-refresh-remote', dir),
  libraryJobs: () => ipcRenderer.invoke('library-jobs'),
  libraryJobCancel: (id) => ipcRenderer.invoke('library-job-cancel', id),
  libraryJobDismiss: (id) => ipcRenderer.invoke('library-job-dismiss', id),
  testAiText: (draft) => ipcRenderer.invoke('test-ai-text', draft),
  publishState: (dir) => ipcRenderer.invoke('publish-state', dir),
  publishGenerate: (payload) => ipcRenderer.invoke('publish-generate', payload),
  publishCancel: (dir) => ipcRenderer.invoke('publish-cancel', dir),
  publishRetitle: (payload) => ipcRenderer.invoke('publish-retitle', payload),
  publishSaveSynopsis: (payload) => ipcRenderer.invoke('publish-save-synopsis', payload),
  onPublishUpdate: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('publish-update', listener);
    return () => ipcRenderer.removeListener('publish-update', listener);
  },
  libraryActivity: (dir) => ipcRenderer.invoke('library-activity', dir),
  libraryOpenFolder: (dir, which) => ipcRenderer.invoke('library-open-folder', dir, which),
  libraryActivityClear: (dir) => ipcRenderer.invoke('library-activity-clear', dir),
  libraryOverview: () => ipcRenderer.invoke('library-overview'),
  onLibraryActivity: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('library-activity', listener);
    return () => ipcRenderer.removeListener('library-activity', listener);
  },
  onLibraryJobUpdate: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('library-job-update', listener);
    return () => ipcRenderer.removeListener('library-job-update', listener);
  },
  onLibraryPlanProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('library-plan-progress', listener);
    return () => ipcRenderer.removeListener('library-plan-progress', listener);
  },
  oneclickScan: (dir) => ipcRenderer.invoke('oneclick-scan', dir),
  oneclickStart: (payload) => ipcRenderer.invoke('oneclick-start', payload),
  oneclickStop: () => ipcRenderer.invoke('oneclick-stop'),
  oneclickStatus: () => ipcRenderer.invoke('oneclick-status'),
  oneclickClearLogs: () => ipcRenderer.invoke('oneclick-clear-logs'),
  oneclickSelectImage: () => ipcRenderer.invoke('oneclick-select-image'),
  onOneclickUpdate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('oneclick-update', listener);
    return () => ipcRenderer.removeListener('oneclick-update', listener);
  },
  quchongSelectVideos: () => ipcRenderer.invoke('quchong-select-videos'),
  quchongSelectAudio: () => ipcRenderer.invoke('quchong-select-audio'),
  quchongStart: (payload) => ipcRenderer.invoke('quchong-start', payload),
  quchongCancel: (batchId) => ipcRenderer.invoke('quchong-cancel', batchId),
  onQuchongTask: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('quchong-task', listener);
    return () => ipcRenderer.removeListener('quchong-task', listener);
  },
  onQuchongProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('quchong-progress', listener);
    return () => ipcRenderer.removeListener('quchong-progress', listener);
  },
  onQuchongLog: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('quchong-log', listener);
    return () => ipcRenderer.removeListener('quchong-log', listener);
  },
  onQuchongComplete: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('quchong-complete', listener);
    return () => ipcRenderer.removeListener('quchong-complete', listener);
  },
  onQuchongHistoryChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('quchong-history-changed', listener);
    return () => ipcRenderer.removeListener('quchong-history-changed', listener);
  },
  onQuchongConcurrencyChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('quchong-concurrency-changed', listener);
    return () => ipcRenderer.removeListener('quchong-concurrency-changed', listener);
  },

  // 一键启动 / 一键暂停 / 队列状态
  pauseAll: (taskIds) => ipcRenderer.invoke('pause-all', taskIds),
  resumeAll: (taskIds) => ipcRenderer.invoke('resume-all', taskIds),
  getQueueStatus: () => ipcRenderer.invoke('get-queue-status'),

  // 事件监听
  onDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onDownloadTaskAdded: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-task-added', listener);
    return () => ipcRenderer.removeListener('download-task-added', listener);
  },
  onDownloadCompleted: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-completed', listener);
    return () => ipcRenderer.removeListener('download-completed', listener);
  },
  onDownloadFailed: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-failed', listener);
    return () => ipcRenderer.removeListener('download-failed', listener);
  },
  onDownloadStopped: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-stopped', listener);
    return () => ipcRenderer.removeListener('download-stopped', listener);
  },
  onDownloadQueueChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('download-queue-changed', listener);
    return () => ipcRenderer.removeListener('download-queue-changed', listener);
  },
});
