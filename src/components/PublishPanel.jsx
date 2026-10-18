import React, { useCallback, useEffect, useRef, useState } from 'react';
import './PublishPanel.css';
import { RefreshCw } from './icons';
import { isSubmitKey } from './episodeRange';

/** 一项内容的状态：没有 / 已保存 / 有改动还没保存。 */
function StatusBadge({ saved, dirty, emptyText = '还没有' }) {
  if (dirty) return <span className="pub-badge is-dirty">未保存</span>;
  if (!saved) return <span className="pub-badge is-empty">{emptyText}</span>;
  return <span className="pub-badge is-saved">已保存</span>;
}

/** 保存 / 还原：有改动才能点；没改动时按钮是灰的，一眼看出当前就是已保存的内容。 */
function SaveBar({ dirty, busy, onSave, onRevert, label = '保存' }) {
  return (
    <span className="pub-savebar">
      <button className="btn btn-sm" onClick={onRevert} disabled={!dirty || busy}>
        还原
      </button>
      <button className="btn btn-sm btn-primary" onClick={onSave} disabled={!dirty || busy}>
        {label}
      </button>
    </span>
  );
}

/**
 * 一部剧的“AI 发布素材”：剧名、简介、海报三件事各自独立。
 * AI 改写出来的内容只是「草稿」，放进编辑框并标成「未保存」；点「保存」才写进剧文件夹。
 * 每一项都标明当前是已保存还是未保存，并单独列出改写之前的原剧名/原简介。
 */
export default function PublishPanel({ dir, onResult }) {
  const [state, setState] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [taglineDraft, setTaglineDraft] = useState('');
  const [styleDraft, setStyleDraft] = useState('');
  const [synopsisDraft, setSynopsisDraft] = useState('');
  const dirRef = useRef(dir);
  dirRef.current = dir;
  // 上一次从磁盘读到的已保存值：编辑框和它一样就是“没动过”，可以安全地刷新；动过的不能被覆盖。
  const baseRef = useRef({ title: '', tagline: '', style: '', synopsis: '', proposal: '' });

  const apply = useCallback((res) => {
    const result = res.result || {};
    const next = {
      title: result.title || '',
      tagline: result.tagline || '',
      style: result.styleId || '',
      synopsis: result.synopsis || '',
      proposal: result.proposedSynopsis || '',
    };
    const prev = baseRef.current;
    // 没改过的编辑框跟着已保存的值走；改过的保留用户写的内容。
    setTitleDraft((cur) => (cur === prev.title ? next.title : cur));
    setTaglineDraft((cur) => (cur === prev.tagline ? next.tagline : cur));
    setStyleDraft((cur) => (cur === prev.style ? next.style : cur));
    // AI 新写了简介：用户刚点了“改写”，直接放进编辑框（未保存）；其余情况同上。
    setSynopsisDraft((cur) => {
      if (next.proposal && next.proposal !== prev.proposal) return next.proposal;
      return cur === prev.synopsis || cur === prev.proposal ? next.proposal || next.synopsis : cur;
    });
    baseRef.current = next;
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      const res = await window.electronAPI.publishState(dir);
      if (dirRef.current !== dir) return;
      if (!res?.success) {
        setError(res?.error || '读取失败');
        return;
      }
      if (fresh) {
        baseRef.current = { title: '', tagline: '', style: '', synopsis: '', proposal: '' };
        setTitleDraft('');
        setTaglineDraft('');
        setStyleDraft('');
        setSynopsisDraft('');
      }
      apply(res);
      setState(res);
      setJob(res.job && res.job.status === 'running' ? res.job : null);
    },
    [dir, apply],
  );

  useEffect(() => {
    setState(null);
    setJob(null);
    setError('');
    load(true);
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

  // 把最新已保存的结果（海报、剧名）交给页头显示。
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

  const save = async (call) => {
    setBusy(true);
    setError('');
    try {
      const res = await call();
      if (!res?.success) throw new Error(res?.error || '保存失败');
      await load();
    } catch (e) {
      setError(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return error ? <div className="pub-panel pub-error">{error}</div> : null;
  const result = state.result || {};
  const original = state.original || {};
  const running = !!job;
  const frozen = busy || running;
  const savedTitle = result.title || '';
  const savedTagline = result.tagline || '';
  const savedStyle = result.styleId || '';
  const savedSynopsis = result.synopsis || '';

  const cleanTitle = titleDraft.trim();
  const titleDirty = cleanTitle !== savedTitle;
  const posterDirty = styleDraft !== savedStyle || taglineDraft.trim() !== savedTagline;
  const synopsisDirty = synopsisDraft.trim() !== savedSynopsis;

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
      <p className="pub-hint">
        AI 改写出来的只是草稿，点「保存」才会生效；每一项旁边的标签告诉你当前是已保存还是未保存。
      </p>

      <div className="pub-row">
        <div className="pub-row-head">
          <b>剧名</b>
          <StatusBadge saved={savedTitle} dirty={titleDirty} emptyText="还没选定" />
          <span className="pub-row-actions">
            {action('titles', result.candidates?.length ? '重新改写' : 'AI 改写剧名')}
            <SaveBar
              dirty={titleDirty}
              busy={frozen}
              label="保存剧名"
              onRevert={() => setTitleDraft(savedTitle)}
              onSave={() => save(() => window.electronAPI.publishRetitle({ dir, title: cleanTitle }))}
            />
          </span>
        </div>
        <input
          className="input-field"
          value={titleDraft}
          maxLength={16}
          placeholder="点下面的候选，或直接填一个剧名，再点「保存剧名」"
          disabled={frozen}
          aria-label="新剧名"
          onChange={(e) => setTitleDraft(e.target.value)}
          onKeyDown={(e) =>
            // 输入法正在选字时按的回车只是确认拼音，不能当成「保存」。
            isSubmitKey(e) &&
            titleDirty &&
            cleanTitle &&
            save(() => window.electronAPI.publishRetitle({ dir, title: cleanTitle }))
          }
        />
        {result.candidates?.length > 0 && (
          <div className="pub-chips" aria-label="候选剧名">
            {result.candidates.map((candidate) => (
              <button
                key={candidate}
                className={`pub-chip ${candidate === cleanTitle ? 'is-active' : ''}`}
                disabled={frozen}
                onClick={() => setTitleDraft(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
        )}
        <p className="pub-meta">
          原剧名：{original.title || '—'}
          {savedTitle && titleDirty ? `　·　当前已保存：${savedTitle}` : ''}
        </p>
        {titleDirty && cleanTitle && savedTitle && result.hasPoster && (
          <p className="pub-meta">保存后海报会按新剧名重新排版，「去重」里的成品也会改成新名字。</p>
        )}
      </div>

      <div className="pub-row">
        <div className="pub-row-head">
          <b>简介</b>
          <StatusBadge saved={savedSynopsis} dirty={synopsisDirty} />
          <span className="pub-row-actions">
            {action('synopsis', savedSynopsis || result.proposedSynopsis ? '重新改写' : 'AI 改写简介')}
            <SaveBar
              dirty={synopsisDirty}
              busy={frozen}
              label="保存简介"
              onRevert={() => setSynopsisDraft(savedSynopsis)}
              onSave={() => save(() => window.electronAPI.publishSaveSynopsis({ dir, synopsis: synopsisDraft }))}
            />
          </span>
        </div>
        <textarea
          className="input-field pub-textarea"
          value={synopsisDraft}
          maxLength={600}
          rows={4}
          placeholder="还没有简介：点「AI 改写简介」，或直接在这里写，再点「保存简介」"
          disabled={frozen}
          aria-label="新简介"
          onChange={(e) => setSynopsisDraft(e.target.value)}
        />
        {synopsisDirty && result.proposedSynopsis && synopsisDraft === result.proposedSynopsis && (
          <p className="pub-meta is-dirty">这是 AI 刚写的新版本，还没保存。</p>
        )}
        {savedSynopsis && synopsisDirty && (
          <details className="pub-details">
            <summary>当前已保存的简介</summary>
            <p className="pub-synopsis">{savedSynopsis}</p>
          </details>
        )}
        {original.synopsis && (
          <details className="pub-details">
            <summary>原简介（改写之前）</summary>
            <p className="pub-synopsis">{original.synopsis}</p>
          </details>
        )}
      </div>

      <div className="pub-row">
        <div className="pub-row-head">
          <b>海报</b>
          <StatusBadge saved={result.hasPoster} dirty={posterDirty} emptyText="还没生成" />
          <span className="pub-row-actions">
            {action('poster', result.hasPoster ? '重新生成' : '生成海报', {
              disabled: !savedTitle || titleDirty,
              title: !savedTitle ? '先保存剧名' : titleDirty ? '剧名有改动，先保存' : undefined,
            })}
            {savedTitle && (
              <SaveBar
                dirty={posterDirty}
                busy={frozen}
                label="保存样式"
                onRevert={() => {
                  setStyleDraft(savedStyle);
                  setTaglineDraft(savedTagline);
                }}
                onSave={() =>
                  save(() => window.electronAPI.publishRetitle({ dir, styleId: styleDraft, tagline: taglineDraft }))
                }
              />
            )}
          </span>
        </div>
        {!savedTitle ? (
          <p className="pub-empty">海报要先保存剧名：上面选一个候选或直接填，再点「保存剧名」。</p>
        ) : (
          <>
            <p className="pub-empty">
              {state.hasCover ? '以文件夹里的“封面”为参考重绘，' : ''}标题由程序排版，字不会错。
              {titleDirty ? '　剧名有未保存的改动，海报现在用的还是已保存的剧名。' : ''}
            </p>
            <div className="pub-style-line">
              <div className="pub-chips" aria-label="标题样式">
                {state.styles.map((style) => (
                  <button
                    key={style.id}
                    className={`pub-chip ${style.id === styleDraft ? 'is-active' : ''}`}
                    disabled={frozen}
                    onClick={() => setStyleDraft(style.id)}
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
              />
            </div>
          </>
        )}
        {result.warnings?.length > 0 && (
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
