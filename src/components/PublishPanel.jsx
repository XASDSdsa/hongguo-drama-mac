import React, { useCallback, useEffect, useRef, useState } from 'react';
import './PublishPanel.css';
import { Image, RefreshCw, Sparkles, X } from './icons';

const STAGES = [
  ['copy', '改写简介和剧名'],
  ['art', '重绘海报底图'],
  ['poster', '排版标题'],
];

/** 一部剧的“AI 发布素材”：改写简介、改写剧名、重新生成海报。结果直接存进剧文件夹。 */
export default function PublishPanel({ dir, onResult, showPoster = true }) {
  const [state, setState] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [taglineDraft, setTaglineDraft] = useState('');
  const dirRef = useRef(dir);
  dirRef.current = dir;

  const load = useCallback(async () => {
    const res = await window.electronAPI.publishState(dir);
    if (dirRef.current !== dir) return;
    if (!res?.success) {
      setError(res?.error || '读取失败');
      return;
    }
    setState(res);
    setJob(res.job && res.job.status === 'running' ? res.job : null);
    setTitleDraft(res.result?.title || '');
    setTaglineDraft(res.result?.tagline || '');
  }, [dir]);

  useEffect(() => {
    setState(null);
    setJob(null);
    setError('');
    load();
  }, [load]);

  useEffect(() => {
    if (!window.electronAPI.onPublishUpdate) return undefined;
    return window.electronAPI.onPublishUpdate((update) => {
      if (!update || update.dir !== dirRef.current) return;
      if (update.status === 'running') setJob(update);
      else {
        setJob(null);
        if (update.status === 'failed') setError(update.error || '生成失败');
        load();
      }
    });
  }, [load]);

  // 把最新结果（海报、新剧名、新简介）交给页头显示。
  const latest = state ? state.result || null : undefined;
  useEffect(() => {
    if (latest !== undefined) onResult?.(latest);
  }, [latest, onResult]);

  const start = async (keepCopy) => {
    setError('');
    const res = await window.electronAPI.publishGenerate({ dir, keepCopy });
    if (!res?.success) setError(res?.error || '无法开始生成');
    else setJob({ status: 'running', stage: keepCopy ? 'art' : 'copy', message: '准备中' });
  };

  const retitle = async (patch) => {
    setBusy(true);
    setError('');
    try {
      const res = await window.electronAPI.publishRetitle({ dir, ...patch });
      if (!res?.success) throw new Error(res?.error || '排版失败');
      setState((prev) => ({ ...prev, result: res.result }));
      setTitleDraft(res.result.title);
      setTaglineDraft(res.result.tagline || '');
    } catch (e) {
      setError(e.message || '排版失败');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return error ? <div className="pub-panel pub-error">{error}</div> : null;
  const result = state.result;
  const running = !!job;
  const stageIndex = running ? STAGES.findIndex(([id]) => id === job.stage) : -1;

  return (
    <section className="pub-panel" aria-label="AI 发布素材">
      <div className="pub-head">
        <div className="pub-title">
          <Sparkles size={16} />
          <strong>AI 发布素材</strong>
          <span>改写简介 → 改写剧名 → 重绘海报（标题由程序排版，字不会错）</span>
        </div>
        <div className="pub-actions">
          {running ? (
            <button className="btn btn-sm" onClick={() => window.electronAPI.publishCancel(dir)}>
              <X size={14} /> 取消
            </button>
          ) : result ? (
            <>
              <button
                className="btn btn-sm"
                onClick={() => start(true)}
                disabled={busy}
                title="沿用现在的简介和剧名，只重画海报底图"
              >
                <Image size={14} /> 重画海报
              </button>
              <button
                className="btn btn-sm"
                onClick={() => start(false)}
                disabled={busy}
                title="从头改写简介和剧名，并重画海报"
              >
                <RefreshCw size={14} /> 全部重新生成
              </button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => start(false)}>
              <Sparkles size={14} /> 生成发布素材
            </button>
          )}
        </div>
      </div>

      {!result && !running && !error && (
        <p className="pub-hint">
          {state.hasCover ? '会以文件夹里的“封面”为参考重绘海报。' : '文件夹里没有“封面”图，海报会根据简介直接生成。'}
          结果保存为 发布剧名.txt、发布简介.txt、发布海报.jpg。
        </p>
      )}

      {running && (
        <div className="pub-progress" role="status">
          <ol>
            {STAGES.map(([id, label], index) => (
              <li key={id} className={index < stageIndex ? 'is-done' : index === stageIndex ? 'is-active' : ''}>
                {label}
              </li>
            ))}
          </ol>
          <div className="pub-message">
            <RefreshCw size={14} className="spin" /> {job.message || '处理中'}
          </div>
        </div>
      )}

      {error && (
        <div className="pub-error" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className="pub-result">
          {showPoster && (
            <div className="pub-poster">
              {result.posterUrl ? (
                <img src={result.posterUrl} alt={`《${result.title}》海报`} />
              ) : (
                <div className="pub-poster-empty">海报未生成</div>
              )}
            </div>
          )}
          <div className="pub-side">
            <label className="pub-field">
              <span>新剧名</span>
              <input
                className="input-field"
                value={titleDraft}
                maxLength={16}
                disabled={busy || running}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => titleDraft.trim() && titleDraft.trim() !== result.title && retitle({ title: titleDraft })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
            {result.candidates?.length > 1 && (
              <div className="pub-chips" aria-label="候选剧名">
                {result.candidates.map((candidate) => (
                  <button
                    key={candidate}
                    className={`pub-chip ${candidate === result.title ? 'is-active' : ''}`}
                    disabled={busy || running}
                    onClick={() => retitle({ title: candidate })}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            )}
            <div className="pub-field">
              <span>标题样式{result.genre ? `（题材：${result.genre}）` : ''}</span>
              <div className="pub-chips" aria-label="标题样式">
                {state.styles.map((style) => (
                  <button
                    key={style.id}
                    className={`pub-chip ${style.id === result.styleId ? 'is-active' : ''}`}
                    disabled={busy || running}
                    onClick={() => retitle({ styleId: style.id })}
                  >
                    {style.name}
                  </button>
                ))}
              </div>
            </div>
            <label className="pub-field">
              <span>角标（留空则不显示）</span>
              <input
                className="input-field"
                value={taglineDraft}
                maxLength={12}
                disabled={busy || running}
                onChange={(e) => setTaglineDraft(e.target.value)}
                onBlur={() => taglineDraft.trim() !== (result.tagline || '') && retitle({ tagline: taglineDraft })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
            <div className="pub-field">
              <span>新简介</span>
              <p className="pub-synopsis">{result.synopsis}</p>
            </div>
            {result.warnings?.length > 0 && (
              <ul className="pub-warnings">
                {result.warnings.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
