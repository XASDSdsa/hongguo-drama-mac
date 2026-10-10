import React, { useCallback, useEffect, useRef, useState } from 'react';
import './Quchong.css';
import { Film, Folder, Plus, X, Play, Square, Trash2 } from './icons';

const fallbackDefaults = {
  crop_ratio: 0.94, speed_min: 1.03, speed_max: 1.05, pitch_min: 1.04, pitch_max: 1.07,
  rotation_max: 0.008, rgb_shift: 2, noise_min: 4, noise_max: 7, contrast: 1.06, saturation: 1.25, hue_range: 12,
  vignette: true, black_intro: true, eq_enable: true, orig_volume: 0.5, bgm_volume: 0.15,
  resolution: '1080x1920', encoder: 'auto', quality: 'standard', jobs: 1,
};

function fileName(file) {
  return String(file || '').split(/[\\/]/).pop() || file;
}

const stageText = {
  queued: '排队中', processing: '处理中', completed: '完成',
  failed: '失败', stopped: '已停止', running: '处理中', pending: '排队中',
};

export default function Quchong({ active = true }) {
  const [files, setFiles] = useState([]);
  const [library, setLibrary] = useState([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [outputDir, setOutputDir] = useState('');
  const [bgm, setBgm] = useState('');
  const [opts, setOpts] = useState(fallbackDefaults);
  const [batchId, setBatchId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [logs, setLogs] = useState([]);
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const batchRef = useRef(null);

  const addFiles = useCallback((paths) => {
    const incoming = Array.isArray(paths) ? paths.filter(Boolean) : [];
    setFiles((previous) => [...previous, ...incoming.filter((file) => !previous.includes(file))]);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      window.electronAPI.quchongDefaults?.(),
      window.electronAPI.getSettings?.(),
      window.electronAPI.getQuchongTasks?.(),
    ]).then(([defaults, settings, savedHistory]) => {
      if (!alive) return;
      if (defaults) setOpts((value) => ({ ...value, ...defaults }));
      if (settings?.root) setOutputDir(`${settings.root}/红果短剧/处理后`);
      if (Array.isArray(savedHistory)) setHistory(savedHistory);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

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
      if (!batchRef.current) batchRef.current = data.batchId;
      if (batchRef.current !== data.batchId) return;
      setBatchId(data.batchId);
      setTasks((previous) => {
        const index = previous.findIndex((task) => task.id === data.task?.id);
        if (index < 0) return [...previous, data.task];
        const next = [...previous]; next[index] = { ...next[index], ...data.task }; return next;
      });
    });
    const offProgress = api.onQuchongProgress?.((data) => {
      if (batchRef.current !== data.batchId) return;
      setTasks((previous) => previous.map((task) => task.id === data.taskId
        ? { ...task, progress: data.progress, stage: data.stage || task.stage, updatedAt: data.updatedAt || task.updatedAt }
        : task));
    });
    const offLog = api.onQuchongLog?.((data) => {
      if (batchRef.current && batchRef.current !== data.batchId) return;
      setLogs((previous) => [...previous, data.line].slice(-160));
    });
    const offComplete = api.onQuchongComplete?.((data) => {
      if (batchRef.current !== data.batchId) return;
      setTasks(data.tasks || []);
      setRunning(false);
      setNotice(data.cancelled ? '处理已取消' : data.success ? '处理完成，输出文件已保存。' : '处理结束，其中部分文件失败。');
      batchRef.current = null;
      setBatchId(null);
    });
    const offHistory = api.onQuchongHistoryChanged?.((data) => {
      if (Array.isArray(data?.tasks)) setHistory(data.tasks);
    });
    return () => [offTask, offProgress, offLog, offComplete, offHistory].forEach((off) => off?.());
  }, [active]);

  const restoreSnapshot = (snapshot) => {
    if (!snapshot) return;
    setTasks(snapshot.tasks || []);
    setRunning(false);
    setBatchId(null);
    setNotice(`已恢复任务快照：${snapshot.done || 0}/${snapshot.total || 0} 完成`);
  };

  const update = (key, value) => setOpts((previous) => ({ ...previous, [key]: value }));
  const chooseOutput = async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) setOutputDir(folder);
  };
  const start = async () => {
    setNotice(''); setLogs([]); setTasks([]);
    if (!files.length) return setNotice('请先添加视频文件。');
    if (!outputDir) return setNotice('请选择输出目录。');
    setRunning(true);
    try {
      const result = await window.electronAPI.quchongStart({ sources: files, outputDir, bgm: bgm || null, opts });
      if (!result?.success) { setRunning(false); return setNotice(result?.error || '提交处理任务失败。'); }
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
    try { await window.electronAPI.quchongCancel(batchId); } catch (error) { setNotice(error?.message || '停止任务失败。'); }
  };

  if (!active) return null;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const status = running ? `处理中 ${completed}/${tasks.length || files.length}` : notice || '等待开始';

  return (
    <div className="quchong-container">
      <div className="quchong-header">
        <div><h2><Film size={25} /> 视频处理</h2><p>按本地版 quchong_app 的逻辑处理视频，输出到独立目录，不覆盖原文件。</p><p className="qc-note">本地画面与音频扰动不能保证平台一定判定为新内容，请只处理你有权使用的素材。</p></div>
        <span className={`quchong-status ${running ? 'is-running' : ''}`}>{status}</span>
      </div>

      <section className="qc-card">
        <div className="qc-card-title"><span>输入视频</span><div className="qc-actions"><button className="btn btn-sm" onClick={async () => addFiles(await window.electronAPI.quchongSelectVideos())} disabled={running}><Plus size={14} /> 添加文件</button></div></div>
        {files.length ? <div className="qc-file-list">{files.map((file) => <div className="qc-file" key={file}><Film size={15} /><span title={file}>{fileName(file)}</span><button className="icon-btn" onClick={() => setFiles((old) => old.filter((item) => item !== file))} disabled={running}><X size={15} /></button></div>)}</div> : <div className="qc-empty">可添加本地视频，或按需从已下载视频中选择。</div>}
        <div className="qc-library-toggle">
          <button className="btn btn-sm" onClick={toggleLibrary} disabled={running || libraryLoading}>
            {libraryLoading ? '读取下载记录…' : libraryOpen ? '收起已下载视频' : '从已下载视频中选择'}
          </button>
          {!libraryOpen && <span className="qc-hint">默认不展开，避免下载记录过多影响页面。</span>}
        </div>
        {libraryOpen && <div className="qc-library">
          <div className="qc-subtitle">已下载视频（最多显示最近 50 个）</div>
          {library.length ? library.map((task) => <div className="qc-library-row" key={task.id}><span title={task.savePath}>{fileName(task.savePath)}</span><button className="btn btn-sm" onClick={() => addFiles([task.savePath])} disabled={running || files.includes(task.savePath)}>加入</button></div>) : <div className="qc-empty">没有找到已完成的本地视频，请使用“添加文件”。</div>}
        </div>}
      </section>

      <section className="qc-card">
        <div className="qc-card-title"><span>输出与音频</span></div>
        <div className="qc-row"><label>输出目录</label><input className="input-field" value={outputDir} onChange={(event) => setOutputDir(event.target.value)} placeholder="选择处理后视频的保存目录" /><button className="btn btn-sm" onClick={chooseOutput}><Folder size={14} /> 选择</button></div>
        <div className="qc-row"><label>BGM（可选）</label><input className="input-field" value={bgm} onChange={(event) => setBgm(event.target.value)} placeholder="不添加背景音乐" /><button className="btn btn-sm" onClick={async () => { const file = await window.electronAPI.quchongSelectAudio(); if (file) setBgm(file); }}><Folder size={14} /> 选择</button>{bgm && <button className="icon-btn" onClick={() => setBgm('')}><X size={15} /></button>}</div>
      </section>

      <section className="qc-card">
        <div className="qc-card-title"><span>处理参数</span><span className="qc-hint">默认值与本地版一致</span></div>
        <div className="qc-options">
          <label>分辨率<select value={opts.resolution} onChange={(event) => update('resolution', event.target.value)}><option value="1080x1920">1080 × 1920</option><option value="720x1280">720 × 1280</option></select></label>
          <label>编码器<select value={opts.encoder} onChange={(event) => update('encoder', event.target.value)}><option value="auto">自动（Mac 优先硬编）</option><option value="cpu">CPU</option><option value="videotoolbox">VideoToolbox</option><option value="nvenc">NVENC</option></select></label>
          <label>画质<select value={opts.quality} onChange={(event) => update('quality', event.target.value)}><option value="standard">标准</option><option value="lean">省空间</option></select></label>
          <label>并发数<input type="number" min="1" max="8" value={opts.jobs} onChange={(event) => update('jobs', Number(event.target.value))} /></label>
          <label>裁剪比例<input type="number" min="0.85" max="1" step="0.01" value={opts.crop_ratio} onChange={(event) => update('crop_ratio', Number(event.target.value))} /></label>
          <label>速度下限<input type="number" min="1" max="1.1" step="0.01" value={opts.speed_min} onChange={(event) => update('speed_min', Number(event.target.value))} /></label>
          <label>速度上限<input type="number" min="1" max="1.1" step="0.01" value={opts.speed_max} onChange={(event) => update('speed_max', Number(event.target.value))} /></label>
          <label>音调下限<input type="number" min="1" max="1.1" step="0.01" value={opts.pitch_min} onChange={(event) => update('pitch_min', Number(event.target.value))} /></label>
          <label>音调上限<input type="number" min="1" max="1.1" step="0.01" value={opts.pitch_max} onChange={(event) => update('pitch_max', Number(event.target.value))} /></label>
          <label>噪声下限<input type="number" min="0" max="15" step="1" value={opts.noise_min} onChange={(event) => update('noise_min', Number(event.target.value))} /></label>
          <label>噪声上限<input type="number" min="0" max="15" step="1" value={opts.noise_max} onChange={(event) => update('noise_max', Number(event.target.value))} /></label>
          <label>旋转幅度<input type="number" min="0" max="0.02" step="0.001" value={opts.rotation_max} onChange={(event) => update('rotation_max', Number(event.target.value))} /></label>
          <label>RGB 偏移<input type="number" min="0" max="5" step="1" value={opts.rgb_shift} onChange={(event) => update('rgb_shift', Number(event.target.value))} /></label>
          <label>对比度<input type="number" min="0.9" max="1.3" step="0.01" value={opts.contrast} onChange={(event) => update('contrast', Number(event.target.value))} /></label>
          <label>饱和度<input type="number" min="0.8" max="1.6" step="0.01" value={opts.saturation} onChange={(event) => update('saturation', Number(event.target.value))} /></label>
          <label>色相范围<input type="number" min="0" max="30" step="1" value={opts.hue_range} onChange={(event) => update('hue_range', Number(event.target.value))} /></label>
          <label>原声音量<input type="number" min="0.1" max="1" step="0.05" value={opts.orig_volume} onChange={(event) => update('orig_volume', Number(event.target.value))} /></label>
          <label>BGM 音量<input type="number" min="0" max="0.5" step="0.05" value={opts.bgm_volume} onChange={(event) => update('bgm_volume', Number(event.target.value))} /></label>
        </div>
        <div className="qc-checks"><label><input type="checkbox" checked={opts.black_intro} onChange={(event) => update('black_intro', event.target.checked)} /> 黑片头</label><label><input type="checkbox" checked={opts.vignette} onChange={(event) => update('vignette', event.target.checked)} /> 暗角</label><label><input type="checkbox" checked={opts.eq_enable} onChange={(event) => update('eq_enable', event.target.checked)} /> 音频均衡</label></div>
      </section>

      <div className="qc-footer"><button className="btn btn-primary" onClick={start} disabled={running}><Play size={15} /> 开始处理</button><button className="btn" onClick={cancel} disabled={!running}><Square size={14} /> 停止</button><button className="btn" onClick={() => { setFiles([]); setTasks([]); setLogs([]); setNotice(''); }} disabled={running}><Trash2 size={14} /> 清空</button></div>
      {(tasks.length > 0 || logs.length > 0) && <section className="qc-card qc-progress-card"><div className="qc-card-title"><span>任务进度</span><span className="qc-hint">{completed}/{tasks.length} 完成</span></div>{tasks.map((task) => { const stage = task.stage || task.status; const label = stage === 'processing' || stage === 'running' ? `${Math.round(task.progress || 0)}%` : stageText[stage] || '等待'; return <div className="qc-progress-row" key={task.id}><span title={task.name}>{fileName(task.name)}</span><div className="qc-progress"><i style={{ width: `${task.progress || 0}%` }} /></div><em>{label}</em></div>; })}{logs.length > 0 && <pre className="qc-log">{logs.join('\n')}</pre>}</section>}
      {!!history.length && <section className="qc-card qc-history-card"><div className="qc-card-title"><span>处理任务快照</span><span className="qc-hint">保留最近 {Math.min(history.length, 50)} 批</span></div>{history.slice(0, 12).map((batch) => <div className="qc-history-row" key={batch.id}><div><b>{batch.status === 'completed' ? '已完成' : batch.status === 'stopped' ? '已停止' : batch.status === 'failed' ? '部分失败' : '排队中'}</b><span>{batch.done || 0}/{batch.total || 0} 个视频 · {batch.createdAt ? new Date(batch.createdAt).toLocaleString() : '未知时间'}</span></div><button className="btn btn-sm" onClick={() => restoreSnapshot(batch)}>恢复查看</button></div>)}</section>}
    </div>
  );
}
