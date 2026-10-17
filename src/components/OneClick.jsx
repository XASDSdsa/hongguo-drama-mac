import React, { useEffect, useRef, useState } from 'react';
import './OneClick.css';
import { Folder, Play, Square, Sparkles } from './icons';

const STORAGE_KEY = 'oneclick-config';
const STATUS_TEXT = {
  idle: '等待开始',
  running: '处理中',
  stopping: '正在停止',
  completed: '全部完成',
  partial: '完成，有失败项',
  stopped: '已停止',
};
const ITEM_TEXT = {
  off: '未启用',
  pending: '等待',
  running: '处理中',
  completed: '完成',
  skipped: '已跳过',
  failed: '失败',
  stopped: '已停止',
};
const NUMBER_PARAMS = [
  ['crop_ratio', '裁切比例', 0.01, 0.85, 1],
  ['speed_min', '变速下限', 0.01, 1, 1.1],
  ['speed_max', '变速上限', 0.01, 1, 1.1],
  ['pitch_min', '音调下限', 0.01, 1, 1.1],
  ['pitch_max', '音调上限', 0.01, 1, 1.1],
  ['noise_min', '噪点下限', 1, 0, 15],
  ['noise_max', '噪点上限', 1, 0, 15],
  ['rotation_max', '最大旋转', 0.001, 0, 0.02],
  ['rgb_shift', 'RGB 偏移', 1, 0, 5],
  ['contrast', '对比度', 0.01, 0.9, 1.3],
  ['saturation', '饱和度', 0.01, 0.8, 1.6],
  ['hue_range', '色相范围', 1, 0, 30],
  ['orig_volume', '原声音量', 0.05, 0.1, 1],
  ['bgm_volume', 'BGM 音量', 0.05, 0, 0.5],
];
const RESERVED = [
  { id: 'cost', label: '自动生成成本配置报告', note: '预留：后续接入模板和填写规则' },
  {
    id: 'draft',
    label: '导出剪映草稿（多轨道）',
    note: '预留设置：将接入结构化拆解 + 多轨道剪映草稿导出，这是最复杂的一项',
  },
  { id: 'ai-storyboard', label: '自动生成 AI 分镜工程图', note: '预留：后续接入' },
];

function readConfig() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}
function saveConfig(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (_) {
    /* 浏览器存储不可用时，只是不记住上次的选择。 */
  }
}
const baseName = (dir) =>
  String(dir || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || '';

export default function OneClick({ active = true }) {
  const saved = useRef(readConfig()).current;
  const [inputDir, setInputDir] = useState(saved.inputDir || '');
  const [outputDir, setOutputDir] = useState(saved.outputDir || '');
  const [title, setTitle] = useState(saved.title || '');
  const [overwrite, setOverwrite] = useState(!!saved.overwrite);
  const [jobs, setJobs] = useState(saved.jobs || 2);
  const [dedup, setDedup] = useState(saved.dedup !== false);
  const [opts, setOpts] = useState(saved.opts || null);
  const [showParams, setShowParams] = useState(false);
  const [poster, setPoster] = useState(saved.poster || { enabled: true, prompt: '', sourceImage: '' });
  const [showPoster, setShowPoster] = useState(false);
  const [videoCount, setVideoCount] = useState(null);
  const [notice, setNotice] = useState('');
  const [state, setState] = useState({
    status: 'idle',
    files: [],
    poster: { status: 'off' },
    logs: { main: [], branch: [] },
  });
  const mainLog = useRef(null);
  const branchLog = useRef(null);
  const busy = ['running', 'stopping'].includes(state.status);

  useEffect(() => {
    let alive = true;
    window.electronAPI.oneclickStatus().then((value) => alive && value && setState(value));
    const off = window.electronAPI.onOneclickUpdate((value) => setState(value));
    window.electronAPI.quchongDefaults?.().then((defaults) => {
      if (alive && defaults) setOpts((previous) => ({ ...defaults, ...(previous || {}) }));
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    saveConfig({ inputDir, outputDir, title, overwrite, jobs, dedup, opts, poster });
  }, [inputDir, outputDir, title, overwrite, jobs, dedup, opts, poster]);

  useEffect(() => {
    for (const ref of [mainLog, branchLog]) if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [state.logs]);

  useEffect(() => {
    if (!inputDir) return setVideoCount(null);
    let alive = true;
    window.electronAPI.oneclickScan(inputDir).then((result) => {
      if (alive) setVideoCount(result?.success ? result.files.length : null);
    });
    return () => {
      alive = false;
    };
  }, [inputDir, state.status]);

  const chooseInput = async () => {
    const dir = await window.electronAPI.selectFolder();
    if (!dir) return;
    setInputDir(dir);
    if (!title.trim()) setTitle(baseName(dir));
  };
  const chooseOutput = async () => {
    const dir = await window.electronAPI.selectFolder();
    if (dir) setOutputDir(dir);
  };
  const chooseImage = async () => {
    const file = await window.electronAPI.oneclickSelectImage();
    if (file) setPoster((value) => ({ ...value, sourceImage: file }));
  };
  const start = async () => {
    setNotice('');
    const result = await window.electronAPI.oneclickStart({
      inputDir,
      outputDir,
      title,
      overwrite,
      jobs,
      dedup,
      opts: dedup ? opts : undefined,
      poster: { enabled: poster.enabled, prompt: poster.prompt, sourceImage: poster.sourceImage },
    });
    if (!result?.success) setNotice(result?.error || '启动失败');
  };
  const stop = async () => {
    const result = await window.electronAPI.oneclickStop();
    if (!result?.success) setNotice(result?.error || '停止失败');
  };
  const setOpt = (key, value) => setOpts((previous) => ({ ...(previous || {}), [key]: value }));
  const posterState = state.poster?.status || 'off';

  return (
    <div className="oneclick-container" data-active={active}>
      <header className="oneclick-header">
        <h2>
          <Sparkles size={22} /> 一键处理
        </h2>
        <p>选好输入目录和输出目录，批量去重，并在旁边同时生成海报等配套素材。和其他页面互不影响。</p>
        <span className={`oneclick-status ${busy ? 'is-running' : ''}`}>
          {STATUS_TEXT[state.status] || state.status}
        </span>
      </header>

      <section className="oneclick-card">
        <div className="oneclick-row">
          <label htmlFor="oneclick-input">输入目录</label>
          <input
            id="oneclick-input"
            className="input-field"
            value={inputDir}
            onChange={(e) => setInputDir(e.target.value)}
            placeholder="放着整部剧视频的文件夹"
            disabled={busy}
          />
          <button className="btn" onClick={chooseInput} disabled={busy}>
            <Folder size={14} /> 选择
          </button>
        </div>
        {videoCount != null && (
          <p className="oneclick-hint">这个目录里有 {videoCount} 个视频（只看这一层，按集数排序）。</p>
        )}
        <div className="oneclick-row">
          <label htmlFor="oneclick-output">输出目录</label>
          <input
            id="oneclick-output"
            className="input-field"
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            placeholder="处理结果保存到这里"
            disabled={busy}
          />
          <button className="btn" onClick={chooseOutput} disabled={busy}>
            <Folder size={14} /> 选择
          </button>
        </div>
        <div className="oneclick-row">
          <label htmlFor="oneclick-title">标题</label>
          <input
            id="oneclick-title"
            className="input-field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="默认用输入目录的名字，用于海报命名和提示词"
            disabled={busy}
          />
        </div>
        <div className="oneclick-options">
          <label className="oneclick-check">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              disabled={busy}
            />
            覆盖输出目录中的同名文件
          </label>
          <label className="oneclick-inline">
            并发数
            <input
              className="input-field oneclick-number"
              type="number"
              min="1"
              max="8"
              value={jobs}
              onChange={(e) => setJobs(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
              disabled={busy}
            />
          </label>
        </div>
        <div className="oneclick-options">
          <label className="oneclick-check">
            <input type="checkbox" checked={dedup} onChange={(e) => setDedup(e.target.checked)} disabled={busy} />
            去重
          </label>
          <button className="btn btn-sm" onClick={() => setShowParams((value) => !value)} disabled={!dedup}>
            去重参数…
          </button>
        </div>
        {dedup && showParams && opts && (
          <div className="oneclick-params">
            <label>
              分辨率
              <select value={opts.resolution} onChange={(e) => setOpt('resolution', e.target.value)} disabled={busy}>
                <option value="1080x1920">1080×1920</option>
                <option value="720x1280">720×1280</option>
              </select>
            </label>
            <label>
              画质
              <select value={opts.quality} onChange={(e) => setOpt('quality', e.target.value)} disabled={busy}>
                <option value="standard">标准</option>
                <option value="lean">精简</option>
              </select>
            </label>
            {NUMBER_PARAMS.map(([key, label, step, min, max]) => (
              <label key={key}>
                {label}
                <input
                  className="input-field"
                  type="number"
                  step={step}
                  min={min}
                  max={max}
                  value={opts[key] ?? ''}
                  onChange={(e) => setOpt(key, Number(e.target.value))}
                  disabled={busy}
                />
              </label>
            ))}
            {[
              ['black_intro', '黑场开头'],
              ['vignette', '暗角'],
              ['eq_enable', '均衡器'],
            ].map(([key, label]) => (
              <label key={key} className="oneclick-check">
                <input
                  type="checkbox"
                  checked={!!opts[key]}
                  onChange={(e) => setOpt(key, e.target.checked)}
                  disabled={busy}
                />
                {label}
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="oneclick-card">
        <h3>支线任务</h3>
        <div className="oneclick-branch">
          <label className="oneclick-check">
            <input
              type="checkbox"
              checked={poster.enabled}
              onChange={(e) => setPoster((value) => ({ ...value, enabled: e.target.checked }))}
              disabled={busy}
            />
            生成海报（AI 大模型重绘）
          </label>
          <span className={`oneclick-badge is-${posterState}`}>
            {ITEM_TEXT[posterState]}
            {state.poster?.message && posterState !== 'off' ? `：${state.poster.message}` : ''}
          </span>
          <button className="btn btn-sm" onClick={() => setShowPoster((value) => !value)}>
            预设…
          </button>
        </div>
        {showPoster && (
          <div className="oneclick-poster">
            <label>
              重绘提示词预设（{'{标题}'} 会替换成上面的标题）
              <textarea
                className="input-field"
                rows={5}
                value={poster.prompt || state.defaultPosterPrompt || ''}
                onChange={(e) => setPoster((value) => ({ ...value, prompt: e.target.value }))}
                disabled={busy}
              />
            </label>
            <div className="oneclick-row">
              <label>原图</label>
              <input
                className="input-field"
                value={poster.sourceImage}
                onChange={(e) => setPoster((value) => ({ ...value, sourceImage: e.target.value }))}
                placeholder="留空：自动截取第一集的画面"
                disabled={busy}
              />
              <button className="btn" onClick={chooseImage} disabled={busy}>
                <Folder size={14} /> 选择
              </button>
            </div>
            <button
              className="btn btn-sm"
              onClick={() => setPoster((value) => ({ ...value, prompt: '' }))}
              disabled={busy}
            >
              恢复默认提示词
            </button>
            <p className="oneclick-hint">需要先在“设置”里填好 AI 接口地址、密钥和图片模型。</p>
          </div>
        )}
        {RESERVED.map((item) => (
          <div className="oneclick-branch is-reserved" key={item.id}>
            <label className="oneclick-check">
              <input type="checkbox" disabled />
              {item.label}
            </label>
            <span className="oneclick-badge is-reserved">{item.note}</span>
            {item.id === 'draft' && (
              <button className="btn btn-sm" disabled>
                设置…
              </button>
            )}
          </div>
        ))}
      </section>

      <div
        className="oneclick-progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={state.progress || 0}
      >
        <div style={{ width: `${state.progress || 0}%` }} />
      </div>
      <div className="oneclick-actions">
        <button className="btn btn-primary" onClick={start} disabled={busy}>
          <Play size={14} /> 开始处理
        </button>
        <button className="btn" onClick={stop} disabled={!busy || state.status === 'stopping'}>
          <Square size={14} /> 停止
        </button>
        <button className="btn" onClick={() => window.electronAPI.oneclickClearLogs()} disabled={busy}>
          清空日志
        </button>
        {state.total > 0 && (
          <span className="oneclick-hint">
            {state.finished}/{state.total} 个已处理 · 完成 {state.completed} · 跳过 {state.skipped} · 失败{' '}
            {state.failed}
          </span>
        )}
      </div>
      {notice && (
        <p className="oneclick-notice" role="alert">
          {notice}
        </p>
      )}

      <div className="oneclick-logs">
        <div>
          <h4>主任务日志</h4>
          <pre ref={mainLog}>{(state.logs?.main || []).join('\n')}</pre>
        </div>
        <div>
          <h4>支线任务日志</h4>
          <pre ref={branchLog}>{(state.logs?.branch || []).join('\n')}</pre>
        </div>
      </div>
    </div>
  );
}
