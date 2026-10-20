'use strict';
// 「一键处理」：选一个输入目录和一个输出目录，批量去重，并在旁边并行跑支线任务（目前只有 AI 海报）。
// 完全独立：自己的任务状态和 IPC 事件，不读写下载记录、剧集档案或其他页面的队列。
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');

const VIDEO_EXT = /\.(mp4|mov|mkv|m4v|avi|flv|ts|webm)$/i;
const DEDUP_OUTPUT = /_去重(?:_\d+)?\.[^.]+$/i;
const LOG_LIMIT = 300;

const DEFAULT_POSTER_PROMPT = [
  '把这张短剧画面重绘成一张竖版短剧宣传海报。',
  '保留画面里主要人物的外貌、服装和关系，让构图更有戏剧张力，光影更有电影感，色调统一、主体突出。',
  '画面里如果需要文字，只允许出现片名《{标题}》，不要出现其他文字、水印或二维码。',
].join('\n');

const collator = new Intl.Collator('zh-CN', { numeric: true });

function safeName(value) {
  return (
    String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+/, '')
      .trim() || '未命名'
  );
}

/** 只看输入目录这一层的视频，跳过隐藏文件和已经去重过的成品，按集数自然排序。 */
function scanVideos(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || !VIDEO_EXT.test(entry.name) || DEDUP_OUTPUT.test(entry.name))
      continue;
    const file = path.join(dir, entry.name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (_) {}
    files.push({ path: file, name: entry.name, size });
  }
  return files.sort((a, b) => collator.compare(a.name, b.name));
}

function imageExtension(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('webp')) return '.webp';
  return '.png';
}

function execute(file, args, signal, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
    signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}

function createOneclick({ quchong, openai, resolveFfmpeg, getSettings, send }) {
  let run = null;
  let lastEmit = 0;

  const aborted = () => !!run?.controller.signal.aborted;
  const log = (pane, line) => {
    const lines = run.logs[pane];
    lines.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
    if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
  };

  function snapshot() {
    if (!run)
      return {
        status: 'idle',
        files: [],
        poster: { status: 'off' },
        logs: { main: [], branch: [] },
        defaultPosterPrompt: DEFAULT_POSTER_PROMPT,
      };
    const files = run.files;
    const finished = files.filter((item) => ['completed', 'skipped', 'failed', 'stopped'].includes(item.status));
    const progress = files.length
      ? files.reduce((sum, item) => sum + (['completed', 'skipped'].includes(item.status) ? 100 : item.progress), 0) /
        files.length
      : run.status === 'running'
        ? 0
        : 100;
    return {
      id: run.id,
      defaultPosterPrompt: DEFAULT_POSTER_PROMPT,
      status: run.status,
      title: run.title,
      inputDir: run.inputDir,
      outputDir: run.outputDir,
      startedAt: run.startedAt,
      endedAt: run.endedAt || null,
      total: files.length,
      finished: finished.length,
      completed: files.filter((item) => item.status === 'completed').length,
      skipped: files.filter((item) => item.status === 'skipped').length,
      failed: files.filter((item) => item.status === 'failed').length,
      progress: Math.round(progress * 10) / 10,
      files: files.map(({ name, status, progress: value, stage, error }) => ({
        name,
        status,
        progress: value,
        stage,
        error,
      })),
      poster: { ...run.poster },
      logs: { main: [...run.logs.main], branch: [...run.logs.branch] },
    };
  }

  function emit(force = false) {
    const now = Date.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    send('oneclick-update', snapshot());
  }

  async function dedupFile(item, options) {
    const dst = path.join(run.outputDir, `${path.parse(item.path).name}_去重.mp4`);
    item.dst = dst;
    if (fs.existsSync(dst) && !run.overwrite) {
      item.status = 'skipped';
      item.progress = 100;
      log('main', `已存在，跳过：${item.name}`);
      return;
    }
    item.status = 'running';
    log('main', `开始去重：${item.name}`);
    emit(true);
    let backup = null;
    try {
      if (fs.existsSync(dst)) {
        // 覆盖：旧成品先改名保留，新成品成功后才删除，失败或停止会恢复，避免只剩半个结果。
        backup = `${dst}.old-${randomUUID().slice(0, 8)}`;
        await fsp.rename(dst, backup);
      }
      await quchong.runJob({
        ffmpegPath: run.ffmpegPath,
        ffprobePath: run.ffprobePath,
        src: item.path,
        dst,
        bgm: null,
        opts: options,
        signal: run.controller.signal,
        onStage: (stage) => {
          item.stage = stage;
          emit();
        },
        onProgress: (value) => {
          item.progress = value;
          emit();
        },
        onLog: () => {},
      });
      if (backup) await fsp.rm(backup, { force: true });
      item.status = 'completed';
      item.progress = 100;
      log('main', `完成：${item.name}`);
    } catch (error) {
      if (backup && !fs.existsSync(dst)) await fsp.rename(backup, dst).catch(() => {});
      item.status = aborted() ? 'stopped' : 'failed';
      item.progress = 0;
      item.error = error?.message || String(error);
      log('main', `${item.status === 'failed' ? '失败' : '已停止'}：${item.name}（${item.error}）`);
    }
    emit(true);
  }

  async function runDedup(options) {
    const queue = [...run.files];
    const workers = Array.from({ length: Math.min(options.jobs, queue.length) }, async () => {
      while (queue.length && !aborted()) await dedupFile(queue.shift(), options);
    });
    await Promise.all(workers);
    for (const item of queue) {
      item.status = 'stopped';
      item.error = '已取消';
    }
    const count = (status) => run.files.filter((item) => item.status === status).length;
    log(
      'main',
      `主任务结束：完成 ${count('completed')} 个，跳过 ${count('skipped')} 个，失败 ${count('failed')} 个${
        aborted() ? '（已停止）' : ''
      }`,
    );
  }

  async function posterSource(config) {
    if (config.sourceImage) {
      log('branch', `海报：使用指定原图 ${path.basename(config.sourceImage)}`);
      return { image: config.sourceImage, cleanup: async () => {} };
    }
    const video = run.sourceVideo;
    if (!video) throw new Error('没有指定海报原图，输入目录里也没有视频可以截取画面');
    const seconds = Number(
      (
        await execute(
          run.ffprobePath,
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video.path],
          run.controller.signal,
        )
      ).trim(),
    );
    const at = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.max(1, seconds * 0.3), seconds - 0.1) : 1;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-drama-oneclick-'));
    const file = path.join(dir, 'frame.png');
    await execute(
      run.ffmpegPath,
      ['-nostdin', '-y', '-v', 'error', '-ss', String(at), '-i', video.path, '-frames:v', '1', file],
      run.controller.signal,
      120000,
    );
    log('branch', `海报：截取 ${video.name} 的画面作为原图`);
    return { image: file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) };
  }

  async function runPoster(config) {
    const poster = run.poster;
    poster.status = 'running';
    poster.message = '准备原图';
    log('branch', '海报：开始');
    emit(true);
    let source;
    try {
      const existing = fs
        .readdirSync(run.outputDir)
        .find((name) => name.startsWith(`${safeName(run.title)}-海报.`) && /\.(png|jpe?g|webp)$/i.test(name));
      if (existing && !run.overwrite) {
        poster.status = 'skipped';
        poster.message = `已存在，跳过：${existing}`;
        log('branch', `海报：${poster.message}`);
        return;
      }
      source = await posterSource(config);
      poster.message = 'AI 重绘中';
      emit(true);
      const settings = getSettings();
      const prompt = String(config.prompt || '').trim() || DEFAULT_POSTER_PROMPT;
      const image = await openai.editImage(
        {
          image: source.image,
          prompt: prompt.replaceAll('{标题}', run.title),
          size: settings.ai_image_size,
          quality: settings.ai_image_quality,
          signal: run.controller.signal,
        },
        settings,
      );
      if (aborted()) throw new Error('已取消');
      const target = path.join(run.outputDir, `${safeName(run.title)}-海报${imageExtension(image.contentType)}`);
      const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
      await fsp.writeFile(temporary, image.buffer);
      if (existing && run.overwrite) await fsp.rm(path.join(run.outputDir, existing), { force: true });
      await fsp.rename(temporary, target);
      poster.status = 'completed';
      poster.path = target;
      poster.message = path.basename(target);
      log('branch', `海报：已保存 ${poster.message}`);
    } catch (error) {
      poster.status = aborted() ? 'stopped' : 'failed';
      poster.message = error?.message || String(error);
      log('branch', `海报：${poster.status === 'failed' ? '失败' : '已停止'}（${poster.message}）`);
    } finally {
      await source?.cleanup();
      emit(true);
    }
  }

  async function execute_(options, posterConfig) {
    const jobs = [];
    if (options) jobs.push(runDedup(options));
    if (posterConfig) jobs.push(runPoster(posterConfig));
    await Promise.allSettled(jobs);
    const failed = run.files.some((item) => item.status === 'failed') || run.poster.status === 'failed';
    run.status = aborted() ? 'stopped' : failed ? 'partial' : 'completed';
    run.endedAt = Date.now();
    log(
      'main',
      run.status === 'completed' ? '全部任务已结束' : run.status === 'stopped' ? '任务已停止' : '任务结束，有失败项',
    );
    emit(true);
  }

  function start(payload = {}) {
    if (run && ['running', 'stopping'].includes(run.status)) return { success: false, error: '已有任务正在运行' };
    const inputDir = String(payload.inputDir || '').trim();
    const outputDir = String(payload.outputDir || '').trim();
    if (!inputDir) return { success: false, error: '请先选择输入目录' };
    if (!outputDir) return { success: false, error: '请先选择输出目录' };
    let stat;
    try {
      stat = fs.statSync(inputDir);
    } catch (_) {}
    if (!stat?.isDirectory()) return { success: false, error: `找不到输入目录：${inputDir}` };
    const wantDedup = payload.dedup !== false;
    const wantPoster = !!payload.poster?.enabled;
    if (!wantDedup && !wantPoster) return { success: false, error: '请至少勾选一项任务' };
    const files = scanVideos(inputDir);
    if (!files.length) return { success: false, error: '输入目录里没有视频文件' };
    let options = null;
    if (wantDedup) {
      try {
        options = quchong.validateOptions({ ...(payload.opts || {}), jobs: Number(payload.jobs) || 2 });
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    const ffmpegPath = resolveFfmpeg('ffmpeg');
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到 FFmpeg/ffprobe，请先配置内置 FFmpeg' };
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      return { success: false, error: `无法创建输出目录：${error.message}` };
    }
    run = {
      id: randomUUID(),
      status: 'running',
      title: String(payload.title || '').trim() || path.basename(path.resolve(inputDir)),
      inputDir: path.resolve(inputDir),
      outputDir: path.resolve(outputDir),
      overwrite: !!payload.overwrite,
      startedAt: Date.now(),
      controller: new AbortController(),
      ffmpegPath,
      ffprobePath,
      sourceVideo: files[0],
      files: wantDedup ? files.map((item) => ({ ...item, status: 'pending', progress: 0, stage: '', error: '' })) : [],
      poster: { status: wantPoster ? 'pending' : 'off', message: '', path: null },
      logs: { main: [], branch: [] },
    };
    log('main', `输入目录：${run.inputDir}`);
    log('main', `输出目录：${run.outputDir}`);
    log('main', wantDedup ? `共 ${files.length} 个视频，并发 ${options.jobs}` : '本次不做去重');
    emit(true);
    execute_(options, wantPoster ? payload.poster : null);
    return { success: true, total: files.length, id: run.id };
  }

  function stop() {
    if (!run || run.status !== 'running') return { success: false, error: '没有正在运行的任务' };
    run.status = 'stopping';
    run.controller.abort();
    log('main', '正在停止…');
    emit(true);
    return { success: true };
  }

  return {
    scan(dir) {
      try {
        const folder = String(dir || '').trim();
        if (!folder) return { success: false, error: '请先选择输入目录' };
        return { success: true, files: scanVideos(folder) };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    start,
    stop,
    status: snapshot,
    clearLogs() {
      if (!run || ['running', 'stopping'].includes(run.status))
        return { success: false, error: '任务运行中，不能清空日志' };
      run.logs = { main: [], branch: [] };
      emit(true);
      return { success: true };
    },
  };
}

module.exports = { createOneclick, scanVideos, DEFAULT_POSTER_PROMPT, safeName };
