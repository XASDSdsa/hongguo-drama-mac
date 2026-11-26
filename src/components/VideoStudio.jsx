import React, { useState, useEffect, useMemo } from 'react';
import { Folder, Film, Play, Check } from './icons';
import './VideoStudio.css';

export default function VideoStudio({ active }) {
  const [folderPath, setFolderPath] = useState('');
  const [seriesTitle, setSeriesTitle] = useState('');
  const [episodes, setEpisodes] = useState([]);
  const [selectedNums, setSelectedNums] = useState([]);
  const [outputDir, setOutputDir] = useState('');
  const [arkApiKey, setArkApiKey] = useState('');
  const [visionModel, setVisionModel] = useState('doubao-seed-2-0-mini-260428');
  const [imageModel, setImageModel] = useState('doubao-seedream-5-5-261028');

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, message: '' });
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    window.electronAPI?.getSettings?.().then((s) => {
      if (s?.ark_api_key) setArkApiKey((prev) => prev || s.ark_api_key);
    });
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onVideoStudioProgress) return undefined;
    return window.electronAPI.onVideoStudioProgress((ev) => {
      if (!ev) return;
      if (typeof ev.percent === 'number') {
        setProgress({ percent: ev.percent, message: ev.message || '' });
      }
      if (ev.message) {
        setLogs((prev) => [...prev.slice(-60), `${new Date().toLocaleTimeString()}  ${ev.message}`]);
      }
    });
  }, []);

  const handleSelectDramaFolder = async () => {
    setError('');
    const res = await window.electronAPI.videoStudioSelectFolder();
    if (!res || res.canceled) return;
    if (!res.success) {
      setError(res.error || '扫描剧集文件夹失败');
      return;
    }
    setFolderPath(res.folderPath);
    setSeriesTitle(res.seriesTitle || '');
    setEpisodes(res.episodes || []);
    // 默认勾选前 4 集
    setSelectedNums((res.episodes || []).slice(0, 4).map((e) => e.number));
    setOutputDir(res.folderPath);
    setResult(null);
  };

  const handleSelectOutputDir = async () => {
    const dir = await window.electronAPI.selectFolder();
    if (dir) setOutputDir(dir);
  };

  const toggleEpisode = (num) => {
    setSelectedNums((prev) => (prev.includes(num) ? prev.filter((n) => n !== num) : [...prev, num].sort((a, b) => a - b)));
  };

  const selectFirstFour = () => setSelectedNums(episodes.slice(0, 4).map((e) => e.number));
  const selectAll = () => setSelectedNums(episodes.map((e) => e.number));
  const clearSelection = () => setSelectedNums([]);

  const selectedEpisodes = useMemo(
    () => episodes.filter((e) => selectedNums.includes(e.number)).sort((a, b) => a.number - b.number),
    [episodes, selectedNums],
  );

  const previewNames = useMemo(() => {
    const title = (seriesTitle || '剧名').trim() || '剧名';
    return [
      `${title}AI资产图.png`,
      `${title}操作视频.mp4`,
      ...selectedEpisodes.map((e) => `${title}第${e.number}集.png`),
    ];
  }, [seriesTitle, selectedEpisodes]);

  const handleStart = async () => {
    if (!folderPath || selectedEpisodes.length === 0) {
      setError('请先选择剧集文件夹并至少勾选 1 集视频。');
      return;
    }
    setError('');
    setResult(null);
    setLogs([]);
    setRunning(true);
    setProgress({ percent: 1, message: '正在初始化视频反推与导出任务...' });

    try {
      const res = await window.electronAPI.videoStudioStart({
        folderPath,
        seriesTitle: seriesTitle.trim(),
        selectedEpisodes,
        outputDir: outputDir || folderPath,
        arkApiKey: arkApiKey.trim(),
        visionModel: visionModel.trim(),
        imageModel: imageModel.trim(),
      });
      if (!res?.success) {
        setError(res?.error || '处理失败');
      } else {
        setResult(res);
        setProgress({ percent: 100, message: '全部资产图、操作视频与分镜截图已生成完毕！' });
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const handleCancel = async () => {
    await window.electronAPI.videoStudioCancel?.();
  };

  if (!active) return null;

  return (
    <div className="vs-page">
      <div className="vs-header">
        <div>
          <h2>视频处理 · AI 资产图与分镜一键生成</h2>
          <p className="vs-sub">
            选择整部剧文件夹 → 勾选要处理的集数（默认 4 集）→ 自动反推全剧共享资产库、逐镜动态提示词，并导出资产图截图、操作视频与每集分镜截图。
          </p>
        </div>
      </div>

      {/* Step 1: Folder & Series Info */}
      <section className="vs-card">
        <div className="vs-card-title">1. 选择剧集文件夹与导出目录</div>
        <div className="vs-row">
          <button className="btn btn-primary" onClick={handleSelectDramaFolder} disabled={running}>
            <Folder size={16} /> 选择剧集文件夹
          </button>
          <span className="vs-path">{folderPath || '尚未选择剧集文件夹（文件夹名将自动识别为剧名）'}</span>
        </div>

        {folderPath && (
          <div className="vs-grid-2">
            <label className="vs-field">
              <span>剧名（用于输出文件命名）</span>
              <input
                type="text"
                value={seriesTitle}
                onChange={(e) => setSeriesTitle(e.target.value)}
                disabled={running}
                placeholder="例如：退役归来，这个保镖不好惹"
              />
            </label>
            <label className="vs-field">
              <span>输出目录</span>
              <div className="vs-inline">
                <input type="text" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} disabled={running} />
                <button className="btn btn-outline btn-sm" onClick={handleSelectOutputDir} disabled={running}>
                  更改
                </button>
              </div>
            </label>
          </div>
        )}
      </section>

      {/* Step 2: Select Episodes */}
      {episodes.length > 0 && (
        <section className="vs-card">
          <div className="vs-card-head">
            <div className="vs-card-title">
              2. 选择需要处理的集数（共识别 {episodes.length} 集，已选 {selectedNums.length} 集）
            </div>
            <div className="vs-actions">
              <button className="btn btn-outline btn-sm" onClick={selectFirstFour} disabled={running}>
                选前 4 集
              </button>
              <button className="btn btn-outline btn-sm" onClick={selectAll} disabled={running}>
                全选
              </button>
              <button className="btn btn-outline btn-sm" onClick={clearSelection} disabled={running}>
                清空
              </button>
            </div>
          </div>

          <div className="vs-ep-grid">
            {episodes.map((ep) => {
              const checked = selectedNums.includes(ep.number);
              return (
                <button
                  key={ep.filePath}
                  type="button"
                  className={`vs-ep-chip ${checked ? 'checked' : ''}`}
                  onClick={() => toggleEpisode(ep.number)}
                  disabled={running}
                  title={ep.fileName}
                >
                  <span className="vs-ep-check">{checked ? <Check size={13} /> : ''}</span>
                  <span className="vs-ep-label">第{ep.number}集</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Step 3: Ark Model Settings & Preview Output Names */}
      <section className="vs-card">
        <div className="vs-card-title">3. 火山方舟模型配置（AI 自动按剧情分析每集分镜数）</div>
        <div className="vs-grid-2">
          <label className="vs-field">
            <span>火山方舟 API Key</span>
            <input
              type="password"
              value={arkApiKey}
              onChange={(e) => setArkApiKey(e.target.value)}
              disabled={running}
              placeholder="ark-xxxx（自动读取「设置」中的方舟 Key）"
            />
          </label>
          <label className="vs-field">
            <span>视频反推模型 ID</span>
            <input
              type="text"
              value={visionModel}
              onChange={(e) => setVisionModel(e.target.value)}
              disabled={running}
            />
          </label>
        </div>

        <div className="vs-preview-box">
          <div className="vs-preview-label">预计输出文件（共 {previewNames.length} 个）：</div>
          <div className="vs-preview-tags">
            {previewNames.map((n) => (
              <span key={n} className="vs-file-tag">
                {n}
              </span>
            ))}
          </div>
        </div>

        <div className="vs-submit-row">
          <button
            className="btn btn-primary"
            onClick={handleStart}
            disabled={running || !folderPath || selectedEpisodes.length === 0}
          >
            <Play size={16} /> {running ? '正在处理中...' : `开始处理所选 ${selectedEpisodes.length} 集并导出`}
          </button>
          {running && (
            <button className="btn btn-outline" onClick={handleCancel}>
              取消任务
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className="vs-error" role="alert">
          {error}
        </div>
      )}

      {/* Progress & Logs */}
      {(running || logs.length > 0) && (
        <section className="vs-card">
          <div className="vs-card-title">处理进度（{progress.percent}%）</div>
          <div className="vs-bar-track">
            <div className="vs-bar-fill" style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
          </div>
          <div className="vs-progress-msg">{progress.message}</div>
          <div className="vs-log-box">
            {logs.map((line, i) => (
              <div key={i} className="vs-log-line">
                {line}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Exported Results */}
      {result && result.outputs && (
        <section className="vs-card vs-result-card">
          <div className="vs-card-head">
            <div className="vs-card-title">
              <Film size={16} /> 导出完成
              {result.stats && (
                <span className="vs-stat-pill">
                  Token: {result.stats.promptTokens + result.stats.completionTokens}（约 ¥{result.stats.estimatedVisionRmb}）· 新出资产图 {result.stats.imagesGenerated} 张
                </span>
              )}
            </div>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => window.electronAPI.videoStudioOpenPath(outputDir || folderPath)}
            >
              打开输出文件夹
            </button>
          </div>

          <div className="vs-out-list">
            <div className="vs-out-item">
              <span>🖼 AI 资产图截图</span>
              <code>{result.outputs.assetScreenshot}</code>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => window.electronAPI.videoStudioOpenPath(result.outputs.assetScreenshot)}
              >
                查看
              </button>
            </div>
            <div className="vs-out-item">
              <span>🎬 操作查看视频</span>
              <code>{result.outputs.operationVideo}</code>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => window.electronAPI.videoStudioOpenPath(result.outputs.operationVideo)}
              >
                播放
              </button>
            </div>
            {(result.outputs.episodeScreenshots || []).map((ep) => (
              <div className="vs-out-item" key={ep.filePath}>
                <span>📋 第{ep.number}集分镜截图</span>
                <code>{ep.filePath}</code>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => window.electronAPI.videoStudioOpenPath(ep.filePath)}
                >
                  查看
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
