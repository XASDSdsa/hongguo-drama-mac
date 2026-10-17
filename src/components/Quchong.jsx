import React, { useCallback, useEffect, useRef, useState } from 'react';
import './Quchong.css';
import { Film, Folder, Plus, X, Play, Square, Trash2 } from './icons';

const fallbackDefaults = {
  crop_ratio: 0.94,
  speed_min: 1.03,
  speed_max: 1.05,
  pitch_min: 1.04,
  pitch_max: 1.07,
  rotation_max: 0.008,
  rgb_shift: 2,
  noise_min: 4,
  noise_max: 7,
  contrast: 1.06,
  saturation: 1.25,
  hue_range: 12,
  vignette: true,
  black_intro: true,
  eq_enable: true,
  orig_volume: 0.5,
  bgm_volume: 0.15,
  encoder: 'auto',
  quality: 'standard',
  jobs: 2,
};

function fileName(file) {
  return (
    String(file || '')
      .split(/[\\/]/)
      .pop() || file
  );
}

const stageText = {
  queued: '排队中',
  processing: '处理中',
  completed: '完成',
  failed: '失败',
  stopped: '已停止',
  running: '处理中',
  pending: '排队中',
  probing: '读取视频',
  encoding: '编码中',
  finalizing: '写入 MP4 索引',
  validating: '校验输出',
  saving: '保存文件',
};

export default function Quchong({ active = true, target = null, onNavigate }) {
  const [files, setFiles] = useState([]);
  const [library, setLibrary] = useState([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [outputDir, setOutputDir] = useState('');
  const [bgm, setBgm] = useState('');
  const [opts, setOpts] = useState(fallbackDefaults);
  const [jobsSaving, setJobsSaving] = useState(false);
  const [batchId, setBatchId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [seriesContext, setSeriesContext] = useState(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const batchRef = useRef(null);

  const addFiles = useCallback((paths) => {
    const incoming = Array.isArray(paths) ? paths.filter(Boolean) : [];
    setFiles((previous) => [...previous, ...incoming.filter((file) => !previous.includes(file))]);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    let changed = false;
    const off = window.electronAPI.onQuchongConcurrencyChanged?.(({ jobs }) => {
      changed = true;
      if (alive) setOpts((previous) => ({ ...previous, jobs }));
    });
    window.electronAPI
      .quchongDefaults?.()
      .then((defaults) => {
        if (alive && !changed && defaults?.jobs) setOpts((previous) => ({ ...previous, jobs: defaults.jobs }));
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [active]);

  useEffect(() => {
    let alive = true;
    Promise.all([window.electronAPI.quchongDefaults?.(), window.electronAPI.getQuchongTasks?.()])
      .then(([defaults, savedHistory]) => {
        if (!alive) return;
        if (defaults) setOpts((value) => ({ ...value, ...defaults, jobs: value.jobs }));
        if (Array.isArray(savedHistory)) setHistory(savedHistory);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 从单剧详情进入时，自动带入该剧已下载且尚未去重的原视频，避免用户在全局列表里逐个找文件。
  useEffect(() => {
    if (!active || target?.seriesId) return;
    setSeriesContext(null);
    setFiles([]);
    setTasks([]);
    setLogs([]);
    setOutputDir('');
  }, [active, target?.seriesId]);

  useEffect(() => {
    if (!active || !target?.seriesId || typeof window.electronAPI.getSeriesEpisodes !== 'function') return undefined;
    let alive = true;
    batchRef.current = null;
    setBatchId(null);
    setTasks([]);
    setLogs([]);
    setFiles([]);
    setOutputDir('');
    setSeriesLoading(true);
    (async () => {
      try {
        const result = await window.electronAPI.getSeriesEpisodes(target.seriesId);
        if (!alive || !result?.success) return;
        const episodes = Array.isArray(result.data?.episodes) ? result.data.episodes : [];
        const pipeline = result.data?.pipeline || {};
        const records = Array.isArray(pipeline.episodes) ? pipeline.episodes : [];
        const recordMap = new Map(records.map((item) => [Number(item.episodeIndex || item.vid_index), item]));
        const candidates = episodes
          .filter((ep) => ep.status === 'completed' && ep.savePath)
          .filter(
            (ep) =>
              !['deduped', 'segmented', 'ready'].includes(String(recordMap.get(Number(ep.vid_index))?.status || '')),
          )
          .sort((a, b) => Number(a.vid_index) - Number(b.vid_index));
        setSeriesContext({
          seriesId: target.seriesId,
          title: result.data.series_title || target.title || '',
          count: candidates.length,
          total: episodes.length,
        });
        setFiles((previous) => {
          const existing = new Set(previous);
          return [...previous, ...candidates.map((ep) => ep.savePath).filter((path) => path && !existing.has(path))];
        });
      } catch (_) {
        if (alive) setNotice('读取当前剧集失败，请改用“添加文件”。');
      } finally {
        if (alive) setSeriesLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, target?.seriesId, target?.title]);

  const toggleLibrary = useCallback(async () => {
    if (libraryOpen) {
      setLibraryOpen(false);
      return;
    }
    setLibraryOpen(true);
    if (libraryLoaded) return;
    setLibraryLoading(true);
    try {
      const downloads = await window.electronAPI.getDownloadTasks?.({ completedOnly: true, limit: 50 });
      if (Array.isArray(downloads)) {
        setLibrary(downloads);
      }
      setLibraryLoaded(true);
    } catch (_) {
      setNotice('读取已下载视频失败，请改用“添加文件”选择视频。');
    } finally {
      setLibraryLoading(false);
    }
  }, [libraryLoaded, libraryOpen]);

  useEffect(() => {
    if (!active) return undefined;
    const api = window.electronAPI;
    const offTask = api.onQuchongTask?.((data) => {
      // 页面没有主动提交/恢复批次时，绝不自动认领其他页面或历史任务的事件。
      if (!batchRef.current || batchRef.current !== data.batchId) return;
      setBatchId(data.batchId);
      setTasks((previous) => {
        const index = previous.findIndex((task) => task.id === data.task?.id);
        if (index < 0) return [...previous, data.task];
        const next = [...previous];
        next[index] = { ...next[index], ...data.task };
        return next;
      });
    });
    const offProgress = api.onQuchongProgress?.((data) => {
      if (batchRef.current !== data.batchId) return;
      setTasks((previous) =>
        previous.map((task) =>
          task.id === data.taskId
            ? {
                ...task,
                progress: data.progress,
                stage: data.stage || task.stage,
                updatedAt: data.updatedAt || task.updatedAt,
              }
            : task,
        ),
      );
    });
    const offLog = api.onQuchongLog?.((data) => {
      if (!batchRef.current || batchRef.current !== data.batchId) return;
      setLogs((previous) => [...previous, data.line].slice(-160));
    });
    const offComplete = api.onQuchongComplete?.((data) => {
      if (batchRef.current !== data.batchId) return;
      setTasks(data.tasks || []);
      setRunning(false);
      setNotice(
        data.cancelled ? '处理已取消' : data.success ? '处理完成，输出文件已保存。' : '处理结束，其中部分文件失败。',
      );
      batchRef.current = null;
      setBatchId(null);
    });
    const offHistory = api.onQuchongHistoryChanged?.((data) => {
      if (Array.isArray(data?.tasks)) setHistory(data.tasks);
    });
    return () => [offTask, offProgress, offLog, offComplete, offHistory].forEach((off) => off?.());
  }, [active]);

  // 页面从隐藏状态回来时读取实时快照。仅刷新当前已选批次，不自动接管别的批次。
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const refreshSnapshot = async () => {
      try {
        const snapshots = await window.electronAPI.getQuchongTasks?.();
        if (!alive || !Array.isArray(snapshots)) return;
        setHistory(snapshots);
        const selectedId = batchRef.current;
        if (!selectedId) return;
        const snapshot = snapshots.find((item) => String(item.id) === String(selectedId));
        if (!snapshot) return;
        setTasks(snapshot.tasks || []);
        setBatchId(snapshot.id);
        setRunning(['queued', 'running'].includes(snapshot.status));
        if (!['queued', 'running'].includes(snapshot.status))
          setNotice(
            snapshot.status === 'completed'
              ? '处理完成，输出文件已保存。'
              : snapshot.status === 'stopped'
                ? '处理已停止'
                : '处理结束，其中部分文件失败。',
          );
      } catch (_) {}
    };
    refreshSnapshot();
    return () => {
      alive = false;
    };
  }, [active]);

  const restoreSnapshot = (snapshot) => {
    if (!snapshot) return;
    batchRef.current = String(snapshot.id);
    setBatchId(String(snapshot.id));
    setTasks(snapshot.tasks || []);
    setRunning(['queued', 'running'].includes(snapshot.status));
    setNotice(`已恢复任务快照：${snapshot.done || 0}/${snapshot.total || 0} 完成`);
  };

  const update = (key, value) => setOpts((previous) => ({ ...previous, [key]: value }));
  const changeJobs = async (value) => {
    const jobs = Number(value);
    setJobsSaving(true);
    try {
      const result = await window.electronAPI.quchongSetConcurrency(jobs);
      if (!result?.success) throw new Error(result?.error || '保存去重并发数失败');
      update('jobs', result.jobs);
    } catch (error) {
      setNotice(error.message || '保存去重并发数失败');
    } finally {
      setJobsSaving(false);
    }
  };
  const chooseOutput = async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) setOutputDir(folder);
  };
  const start = async () => {
    setNotice('');
    setLogs([]);
    setTasks([]);
    if (!files.length) return setNotice('请先添加视频文件。');
    setRunning(true);
    try {
      const result = await window.electronAPI.quchongStart({ sources: files, outputDir, bgm: bgm || null, opts });
      if (!result?.success) {
        setRunning(false);
        return setNotice(result?.error || '提交处理任务失败。');
      }
      batchRef.current = result.batchId;
      setBatchId(result.batchId);
      setTasks(result.tasks || []);
    } catch (error) {
      setRunning(false);
      setNotice(error?.message || '提交处理任务失败。');
    }
  };
  const cancel = async () => {
    if (!batchId) return;
    try {
      await window.electronAPI.quchongCancel(batchId);
    } catch (error) {
      setNotice(error?.message || '停止任务失败。');
    }
  };

  if (!active) return null;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const status = running ? `处理中 ${completed}/${tasks.length || files.length}` : notice || '等待开始';

  return (
    <div className="quchong-container">
      <div className="quchong-header">
        <div>
          <h2>
            <Film size={25} /> 视频处理
          </h2>
          <p>
            {seriesContext
              ? `当前短剧：${seriesContext.title} · 已自动带入 ${seriesContext.count} 集未处理视频`
              : '按本地版 quchong_app 的逻辑处理视频，输出到独立目录，不覆盖原文件。'}
          </p>
          <p className="qc-note">本地画面与音频扰动不能保证平台一定判定为新内容，请只处理你有权使用的素材。</p>
        </div>
        <span className={`quchong-status ${running ? 'is-running' : ''}`}>{status}</span>
      </div>

      {seriesContext && (
        <div className="qc-flow-note">
          <b>流程第 2 步：去重</b>
          <span>{seriesLoading ? '正在读取本剧已下载集…' : `已带入 ${files.length} 集。处理完成后返回本剧查看。`}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onNavigate?.('library', { seriesId: seriesContext.seriesId })}
          >
            返回本剧
          </button>
        </div>
      )}

      <section className="qc-card">
        <div className="qc-card-title">
          <span>输入视频</span>
          <div className="qc-actions">
            <button
              className="btn btn-sm"
              onClick={async () => addFiles(await window.electronAPI.quchongSelectVideos())}
              disabled={running}
            >
              <Plus size={14} /> 添加文件
            </button>
          </div>
        </div>
        {files.length ? (
          <div className="qc-file-list">
            {files.map((file) => (
              <div className="qc-file" key={file}>
                <Film size={15} />
                <span title={file}>{fileName(file)}</span>
                <button
                  className="icon-btn"
                  onClick={() => setFiles((old) => old.filter((item) => item !== file))}
                  disabled={running}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="qc-empty">可添加本地视频，或按需从已下载视频中选择。</div>
        )}
        <div className="qc-library-toggle">
          <button className="btn btn-sm" onClick={toggleLibrary} disabled={running || libraryLoading}>
            {libraryLoading ? '读取下载记录…' : libraryOpen ? '收起已下载视频' : '从已下载视频中选择'}
          </button>
          {!libraryOpen && <span className="qc-hint">默认不展开，避免下载记录过多影响页面。</span>}
        </div>
        {libraryOpen && (
          <div className="qc-library">
            <div className="qc-subtitle">已下载视频（最多显示最近 50 个）</div>
            {library.length ? (
              library.map((task) => (
                <div className="qc-library-row" key={task.id}>
                  <span title={task.savePath}>{fileName(task.savePath)}</span>
                  <button
                    className="btn btn-sm"
                    onClick={() => addFiles([task.savePath])}
                    disabled={running || files.includes(task.savePath)}
                  >
                    加入
                  </button>
                </div>
              ))
            ) : (
              <div className="qc-empty">没有找到已完成的本地视频，请使用“添加文件”。</div>
            )}
          </div>
        )}
      </section>

      <section className="qc-card">
        <div className="qc-card-title">
          <span>输出与音频</span>
        </div>
        <div className="qc-row">
          <label>输出目录</label>
          <input
            className="input-field"
            value={outputDir}
            onChange={(event) => setOutputDir(event.target.value)}
            placeholder="留空则使用设置里的「去重输出目录」"
          />
          <button className="btn btn-sm" onClick={chooseOutput}>
            <Folder size={14} /> 选择
          </button>
        </div>
        <div className="qc-row">
          <label>BGM（可选）</label>
          <input
            className="input-field"
            value={bgm}
            onChange={(event) => setBgm(event.target.value)}
            placeholder="不添加背景音乐"
          />
          <button
            className="btn btn-sm"
            onClick={async () => {
              const file = await window.electronAPI.quchongSelectAudio();
              if (file) setBgm(file);
            }}
          >
            <Folder size={14} /> 选择
          </button>
          {bgm && (
            <button className="icon-btn" onClick={() => setBgm('')}>
              <X size={15} />
            </button>
          )}
        </div>
      </section>

      <section className="qc-card">
        <div className="qc-card-title">
          <span>处理参数</span>
          <span className="qc-hint">默认值与本地版一致</span>
        </div>
        <div className="qc-options">
          <label>
            编码器
            <select value={opts.encoder} onChange={(event) => update('encoder', event.target.value)}>
              <option value="auto">自动识别一次并固定</option>
              <option value="cpu">CPU/libx264</option>
              <option value="videotoolbox">VideoToolbox（Mac）</option>
              <option value="nvenc">NVENC（NVIDIA）</option>
              <option value="amf">AMF（AMD）</option>
              <option value="qsv">QSV（Intel）</option>
            </select>
          </label>
          <label>
            画质
            <select value={opts.quality} onChange={(event) => update('quality', event.target.value)}>
              <option value="standard">标准</option>
              <option value="lean">省空间</option>
            </select>
          </label>
          <label>
            去重并发数
            <select
              aria-label="去重并发数"
              value={opts.jobs}
              disabled={jobsSaving}
              onChange={(event) => changeJobs(event.target.value)}
            >
              {Array.from({ length: 8 }, (_, i) => i + 1).map((jobs) => (
                <option key={jobs} value={jobs}>
                  {jobs}
                </option>
              ))}
            </select>
          </label>
          <label>
            裁剪比例
            <input
              type="number"
              min="0.85"
              max="1"
              step="0.01"
              value={opts.crop_ratio}
              onChange={(event) => update('crop_ratio', Number(event.target.value))}
            />
          </label>
          <label>
            速度下限
            <input
              type="number"
              min="1"
              max="1.1"
              step="0.01"
              value={opts.speed_min}
              onChange={(event) => update('speed_min', Number(event.target.value))}
            />
          </label>
          <label>
            速度上限
            <input
              type="number"
              min="1"
              max="1.1"
              step="0.01"
              value={opts.speed_max}
              onChange={(event) => update('speed_max', Number(event.target.value))}
            />
          </label>
          <label>
            音调下限
            <input
              type="number"
              min="1"
              max="1.1"
              step="0.01"
              value={opts.pitch_min}
              onChange={(event) => update('pitch_min', Number(event.target.value))}
            />
          </label>
          <label>
            音调上限
            <input
              type="number"
              min="1"
              max="1.1"
              step="0.01"
              value={opts.pitch_max}
              onChange={(event) => update('pitch_max', Number(event.target.value))}
            />
          </label>
          <label>
            噪声下限
            <input
              type="number"
              min="0"
              max="15"
              step="1"
              value={opts.noise_min}
              onChange={(event) => update('noise_min', Number(event.target.value))}
            />
          </label>
          <label>
            噪声上限
            <input
              type="number"
              min="0"
              max="15"
              step="1"
              value={opts.noise_max}
              onChange={(event) => update('noise_max', Number(event.target.value))}
            />
          </label>
          <label>
            旋转幅度
            <input
              type="number"
              min="0"
              max="0.02"
              step="0.001"
              value={opts.rotation_max}
              onChange={(event) => update('rotation_max', Number(event.target.value))}
            />
          </label>
          <label>
            RGB 偏移
            <input
              type="number"
              min="0"
              max="5"
              step="1"
              value={opts.rgb_shift}
              onChange={(event) => update('rgb_shift', Number(event.target.value))}
            />
          </label>
          <label>
            对比度
            <input
              type="number"
              min="0.9"
              max="1.3"
              step="0.01"
              value={opts.contrast}
              onChange={(event) => update('contrast', Number(event.target.value))}
            />
          </label>
          <label>
            饱和度
            <input
              type="number"
              min="0.8"
              max="1.6"
              step="0.01"
              value={opts.saturation}
              onChange={(event) => update('saturation', Number(event.target.value))}
            />
          </label>
          <label>
            色相范围
            <input
              type="number"
              min="0"
              max="30"
              step="1"
              value={opts.hue_range}
              onChange={(event) => update('hue_range', Number(event.target.value))}
            />
          </label>
          <label>
            原声音量
            <input
              type="number"
              min="0.1"
              max="1"
              step="0.05"
              value={opts.orig_volume}
              onChange={(event) => update('orig_volume', Number(event.target.value))}
            />
          </label>
          <label>
            BGM 音量
            <input
              type="number"
              min="0"
              max="0.5"
              step="0.05"
              value={opts.bgm_volume}
              onChange={(event) => update('bgm_volume', Number(event.target.value))}
            />
          </label>
        </div>
        <div className="qc-checks">
          <label>
            <input
              type="checkbox"
              checked={opts.black_intro}
              onChange={(event) => update('black_intro', event.target.checked)}
            />{' '}
            黑片头
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.vignette}
              onChange={(event) => update('vignette', event.target.checked)}
            />{' '}
            暗角
          </label>
          <label>
            <input
              type="checkbox"
              checked={opts.eq_enable}
              onChange={(event) => update('eq_enable', event.target.checked)}
            />{' '}
            音频均衡
          </label>
        </div>
      </section>

      <div className="qc-footer">
        <button className="btn btn-primary" onClick={start} disabled={running || jobsSaving}>
          <Play size={15} /> 开始处理
        </button>
        <button className="btn" onClick={cancel} disabled={!running}>
          <Square size={14} /> 停止
        </button>
        <button
          className="btn"
          onClick={() => {
            setFiles([]);
            setTasks([]);
            setLogs([]);
            setNotice('');
          }}
          disabled={running}
        >
          <Trash2 size={14} /> 清空
        </button>
      </div>
      {(tasks.length > 0 || logs.length > 0) && (
        <section className="qc-card qc-progress-card">
          <div className="qc-card-title">
            <span>任务进度</span>
            <span className="qc-hint">
              处理中 {tasks.filter((task) => ['running', 'processing'].includes(task.status)).length} · 等待{' '}
              {tasks.filter((task) => ['pending', 'queued'].includes(task.status)).length} · {completed}/{tasks.length}{' '}
              完成
            </span>
          </div>
          {tasks.map((task) => {
            const unfinished = ['failed', 'stopped'].includes(task.status);
            const stage = unfinished || task.status === 'completed' ? task.status : task.stage || task.status;
            const encoding = ['encoding', 'processing', 'running'].includes(stage);
            const label = encoding ? `编码约 ${Math.round(task.progress || 0)}%` : stageText[stage] || '等待';
            return (
              <div key={task.id}>
                <div className="qc-progress-row">
                  <span title={task.name}>{fileName(task.name)}</span>
                  {unfinished ? (
                    <span className="qc-hint">未生成成品</span>
                  ) : (
                    <div
                      className="qc-progress"
                      role="progressbar"
                      aria-label={task.name}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={encoding || stage === 'completed' ? task.progress || 0 : undefined}
                      aria-valuetext={label}
                    >
                      <i style={{ width: `${task.progress || 0}%` }} />
                    </div>
                  )}
                  <em>{label}</em>
                </div>
                {unfinished && (task.error || task.status === 'failed') && (
                  <pre className="qc-log" role="alert" aria-label={`${fileName(task.name)}：${label}原因`}>
                    {task.error || '未记录失败原因，请查看任务日志。'}
                  </pre>
                )}
              </div>
            );
          })}
          {logs.length > 0 && <pre className="qc-log">{logs.join('\n')}</pre>}
        </section>
      )}
      {!!history.length && (
        <section className="qc-card qc-history-card">
          <div className="qc-card-title">
            <span>处理任务快照</span>
            <span className="qc-hint">保留最近 {Math.min(history.length, 50)} 批</span>
          </div>
          {history.slice(0, 12).map((batch) => (
            <div className="qc-history-row" key={batch.id}>
              <div>
                <b>
                  {batch.status === 'completed'
                    ? '已完成'
                    : batch.status === 'stopped'
                      ? '已停止'
                      : batch.status === 'failed'
                        ? '部分失败'
                        : batch.status === 'running'
                          ? '处理中'
                          : '排队中'}
                </b>
                <span>
                  {batch.done || 0}/{batch.total || 0} 个视频 ·{' '}
                  {batch.createdAt ? new Date(batch.createdAt).toLocaleString() : '未知时间'}
                </span>
              </div>
              <button className="btn btn-sm" onClick={() => restoreSnapshot(batch)}>
                恢复查看
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
