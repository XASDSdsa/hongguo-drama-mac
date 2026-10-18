import React, { useCallback, useEffect, useRef, useState } from 'react';
import './PublishPanel.css';
import { RefreshCw } from './icons';

/**
 * 一部剧的“AI 发布素材”：剧名、简介、海报三件事各自独立，各有各的按钮。
 * 海报要先选定剧名（点一个候选，或直接填）。结果直接存进剧文件夹。
 */
export default function PublishPanel({ dir, onResult }) {
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

  // 把最新结果（海报、剧名）交给页头显示。
  const latest = state ? state.result || null : undefined;
  useEffect(() => {
    if (latest !== undefined) onResult?.(latest);
  }, [latest, onResult]);

  const start = async (task) => {
    setError('');
    const res = await window.electronAPI.publishGenerate({ dir, task });
    if (!res?.success) setError(res?.error || '无法开始');
    else setJob({ status: 'running', task, stage: task, message: '准备中' });
  };

  const retitle = async (patch) => {
    setBusy(true);
    setError('');
    try {
      const res = await window.electronAPI.publishRetitle({ dir, ...patch });
      if (!res?.success) throw new Error(res?.error || '保存失败');
      await load();
    } catch (e) {
      setError(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return error ? <div className="pub-panel pub-error">{error}</div> : null;
  const result = state.result;
  const running = !!job;
  const chosenTitle = result?.title || '';
  const frozen = busy || running;

  // 每件事自己的按钮：这件事在跑就显示进度和取消，别的事在跑时先等一等。
  const action = (task, label, { disabled = false, title } = {}) =>
    job?.task === task ? (
      <span className="pub-running">
        <RefreshCw size={13} className="spin" /> {job.message || '处理中'}
        <button className="btn btn-sm" onClick={() => window.electronAPI.publishCancel(dir)}>
          取消
        </button>
      </span>
    ) : (
      <button className="btn btn-sm" onClick={() => start(task)} disabled={frozen || disabled} title={title}>
        {label}
      </button>
    );

  return (
    <section className="pub-panel" aria-label="AI 发布素材">
      <h3>AI 发布素材</h3>

      <div className="pub-row">
        <div className="pub-row-head">
          <b>剧名</b>
          {action('titles', result?.candidates?.length ? '重新改写' : '改写剧名')}
        </div>
        <input
          className="input-field"
          value={titleDraft}
          maxLength={16}
          placeholder="点下面的候选，或直接填一个剧名"
          disabled={frozen}
          aria-label="选定的剧名"
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => titleDraft.trim() && titleDraft.trim() !== chosenTitle && retitle({ title: titleDraft })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {result?.candidates?.length > 0 && (
          <div className="pub-chips" aria-label="候选剧名">
            {result.candidates.map((candidate) => (
              <button
                key={candidate}
                className={`pub-chip ${candidate === chosenTitle ? 'is-active' : ''}`}
                disabled={frozen}
                onClick={() => retitle({ title: candidate })}
              >
                {candidate}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pub-row">
        <div className="pub-row-head">
          <b>简介</b>
          {action('synopsis', result?.synopsis ? '重新改写' : '改写简介')}
        </div>
        {result?.synopsis ? <p className="pub-synopsis">{result.synopsis}</p> : <p className="pub-empty">还没有改写</p>}
      </div>

      <div className="pub-row">
        <div className="pub-row-head">
          <b>海报</b>
          {action('poster', result?.hasPoster ? '重新生成' : '生成海报', {
            disabled: !chosenTitle,
            title: chosenTitle ? undefined : '先选定剧名',
          })}
        </div>
        {!chosenTitle ? (
          <p className="pub-empty">海报要先选定剧名：上面点一个候选，或直接填一个。</p>
        ) : (
          <>
            <p className="pub-empty">
              {state.hasCover ? '以文件夹里的“封面”为参考重绘，' : ''}标题由程序排版，字不会错。
            </p>
            <div className="pub-style-line">
              <div className="pub-chips" aria-label="标题样式">
                {state.styles.map((style) => (
                  <button
                    key={style.id}
                    className={`pub-chip ${style.id === result.styleId ? 'is-active' : ''}`}
                    disabled={frozen}
                    onClick={() => retitle({ styleId: style.id })}
                  >
                    {style.name}
                  </button>
                ))}
              </div>
              <input
                className="input-field pub-tagline"
                value={taglineDraft}
                maxLength={12}
                placeholder="角标（可不填）"
                disabled={frozen}
                aria-label="角标"
                onChange={(e) => setTaglineDraft(e.target.value)}
                onBlur={() => taglineDraft.trim() !== (result.tagline || '') && retitle({ tagline: taglineDraft })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </div>
          </>
        )}
        {result?.warnings?.length > 0 && (
          <ul className="pub-warnings">
            {result.warnings.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <div className="pub-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
