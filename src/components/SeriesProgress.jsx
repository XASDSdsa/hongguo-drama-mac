import React, { useEffect, useMemo, useRef, useState } from 'react';
import './SeriesActivity.css';
import { Folder, RefreshCw } from './icons';

const LOG_STEP = 100;

/** 当前步骤已经跑了多久：每秒走一格，让人看得出没卡住（有的步骤，例如检测分镜，本身要几十秒才有下一条日志）。 */
function useElapsed(since, active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, since]);
  if (!active || !since) return '';
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export const isActiveBatch = (batch) => batch.status === 'running' || batch.status === 'queued';

/** 2026-10-15 18:51:16 */
export function formatStamp(value) {
  const date = new Date(Number(value) || 0);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 总进度：有在跑/排队的批次就汇总它们，否则看最近一批。 */
export function overallProgress(batches) {
  const active = batches.filter(isActiveBatch);
  const used = active.length ? active : batches.slice(0, 1);
  const total = used.reduce((sum, batch) => sum + Number(batch.total || 0), 0);
  if (!total) return null;
  const done = used.reduce((sum, batch) => sum + Number(batch.done || 0), 0);
  const tasks = used.flatMap((batch) => batch.tasks || []);
  const count = (status) => tasks.filter((task) => task.status === status).length;
  const weighted = used.reduce((sum, batch) => sum + Number(batch.progress || 0) * Number(batch.total || 0), 0);
  return {
    active: active.length > 0,
    total,
    done,
    failed: count('failed'),
    stopped: count('stopped'),
    progress: done >= total ? 100 : Math.floor(weighted / total),
  };
}

/** 一个日志框：每行「[时间] 内容」，新日志来了自动滚到底，往上翻看旧的时不打扰。 */
function LogBox({ title, lines, empty }) {
  const [limit, setLimit] = useState(LOG_STEP);
  const boxRef = useRef(null);
  const stick = useRef(true);
  const shown = useMemo(() => lines.slice(-limit), [lines, limit]);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [shown.length, lines[lines.length - 1]?.t]);

  return (
    <div className="act-logcol">
      <div className="act-log-title">{title}</div>
      <div
        className="act-log"
        ref={boxRef}
        role="log"
        aria-label={title}
        aria-live="off"
        onScroll={(event) => {
          const box = event.currentTarget;
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        }}
      >
        {lines.length > shown.length && (
          <button className="lib-link act-more" onClick={() => setLimit((value) => value + LOG_STEP)}>
            显示更早的（还有 {lines.length - shown.length} 条）
          </button>
        )}
        {shown.length === 0 && <p className="act-empty">{empty}</p>}
        {shown.map((line, index) => (
          <div key={`${line.t}-${index}`} className={`act-line is-${line.level}`}>
            [{formatStamp(line.t)}] {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 一部剧的处理进度和日志，放在管理剧集页面的最下面：上面是要处理的集和参数，
 * 下面是进度条 + 主任务日志 + 支线任务日志。数据来自主进程，切页面、重启应用后都还在。
 */
export default function SeriesProgress({ dir, activity, onChanged }) {
  const [error, setError] = useState('');
  const batches = activity?.batches || [];
  const jobs = (activity?.jobs || []).filter((job) => ['waiting', 'starting', 'failed'].includes(job.status));
  const planning = activity?.planning;
  const logs = activity?.logs || [];
  const mainLogs = useMemo(() => logs.filter((line) => line.channel !== 'side' && line.channel !== 'storyboard'), [logs]);
  const sideLogs = useMemo(() => logs.filter((line) => line.channel === 'side'), [logs]);
  const storyboardLogs = useMemo(() => logs.filter((line) => line.channel === 'storyboard'), [logs]);
  const overall = overallProgress(batches);
  const activeBatches = batches.filter(isActiveBatch);
  const draft = activity?.draft;
  const draftRunning = draft?.status === 'running';
  // 剪映草稿和分镜工程图各算各的：草稿做完了、分镜工程图还在问方舟时，草稿那一行不再显示「正在做」
  const drafting = draftRunning && draft?.drafting !== false;
  const stepElapsed = useElapsed(draft?.stageStartedAt, drafting);
  const board = draft?.storyboard;
  const boardRunning = board?.status === 'running';
  const boardElapsed = useElapsed(board?.stageStartedAt, boardRunning);

  const act = async (fn) => {
    setError('');
    try {
      const result = await fn();
      if (result && result.success === false) setError(result.error || '操作失败');
    } catch (_) {
      setError('操作没有完成，请稍后再试');
    }
    onChanged?.();
  };

  if (!activity) return null;

  let statusText = '还没有处理过。在上面选好要做的事，点「开始处理」，进度和日志都会显示在这里。';
  if (overall) {
    const tail = `${overall.failed ? `，失败 ${overall.failed} 集` : ''}${overall.stopped ? `，已停止 ${overall.stopped} 集` : ''}`;
    statusText = overall.active
      ? `正在处理：已完成 ${overall.done}/${overall.total} 集 · ${overall.progress}%${tail}`
      : `上一批：完成 ${overall.done}/${overall.total} 集${tail}`;
  }

  return (
    <section className="act-panel" aria-label="处理进度">
      <div className="act-head">
        <h3>处理进度</h3>
        <span className="act-head-btns">
          {(activeBatches.length > 0 || draftRunning || planning) && (
            <button
              className="btn btn-sm"
              onClick={() =>
                act(async () => {
                  let last = { success: true };
                  if (planning) last = await window.electronAPI.libraryPlanCancel(dir);
                  for (const batch of activeBatches) last = await window.electronAPI.quchongCancel(batch.id);
                  if (draftRunning) last = await window.electronAPI.libraryDraftCancel(dir);
                  return last;
                })
              }
            >
              停止
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={() => act(() => window.electronAPI.libraryActivityClear(dir))}
            disabled={!logs.length}
          >
            清空日志
          </button>
          <button
            className="btn btn-sm"
            onClick={() => act(() => window.electronAPI.libraryOpenFolder(dir, 'output'))}
            title="打开这部剧的「去重」成品文件夹"
          >
            <Folder size={14} /> 打开成品文件夹
          </button>
        </span>
      </div>

      {planning && (
        <div className="act-planning" role="status">
          <RefreshCw size={14} className="spin" />
          正在分析切点{planning.total ? `：${planning.done}/${planning.total}` : '…'}
        </div>
      )}

      <div className={`act-bar act-bar-main${overall?.failed ? ' has-failed' : ''}`} aria-hidden="true">
        <i style={{ width: `${overall ? overall.progress : 0}%` }} />
      </div>
      <p className="act-status">{statusText}</p>

      {draft && (draftRunning || draft.status === 'failed') && (
        <div className={`act-draft is-${drafting ? 'running' : draft.failed ? 'failed' : 'completed'}`}>
          <div className="act-draft-line">
            <span>
              剪映草稿（{draft.modeText}）：{drafting ? '已完成' : '做完了'} {draft.done}/{draft.total} 集
              {draft.failed ? `，失败 ${draft.failed} 集` : ''}
              {drafting && draft.current ? ` · 正在做 ${draft.current}` : ''}
              {drafting && draft.message
                ? `（${draft.message}${draft.detail ? ` · ${draft.detail}` : ''}${stepElapsed ? ` · 已 ${stepElapsed}` : ''}）`
                : ''}
            </span>
          </div>
          {drafting && (
            <div className="act-bar is-live" aria-hidden="true">
              <i
                style={{
                  width: `${Math.floor(((draft.done + draft.progress / 100) / Math.max(1, draft.total)) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {board && (boardRunning || board.status === 'failed') && (
        <div className={`act-draft act-board is-${board.status}`}>
          <div className="act-draft-line">
            <span>
              分镜工程图：已完成 {board.done}/{board.total} 集
              {board.failed ? `，失败 ${board.failed} 集` : ''}
              {boardRunning && board.current ? ` · 正在做 ${board.current}` : ''}
              {boardRunning && board.message
                ? `（${board.message}${board.detail ? ` · ${board.detail}` : ''}${boardElapsed ? ` · 已 ${boardElapsed}` : ''}）`
                : ''}
              {boardRunning && board.queued ? ` · 还有 ${board.queued} 集排队` : ''}
            </span>
          </div>
          {boardRunning && (
            <div className="act-bar is-live" aria-hidden="true">
              <i
                style={{
                  width: `${Math.floor(((board.done + board.progress / 100) / Math.max(1, board.total)) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {jobs.map((job) => (
        <div key={job.id} className={`act-job is-${job.status}`}>
          <span>{job.message}</span>
          {job.status === 'waiting' && (
            <button className="btn btn-sm" onClick={() => act(() => window.electronAPI.libraryJobCancel(job.id))}>
              取消自动处理
            </button>
          )}
          {job.status === 'failed' && (
            <button className="btn btn-sm" onClick={() => act(() => window.electronAPI.libraryJobDismiss(job.id))}>
              知道了
            </button>
          )}
        </div>
      ))}
      {error && <p className="act-error">{error}</p>}

      <div className="act-logs">
        <LogBox title="主任务日志" lines={mainLogs} empty="暂无日志。" />
        <LogBox title="剪映草稿、海报日志" lines={sideLogs} empty="暂无日志。" />
        <LogBox title="分镜工程图日志" lines={storyboardLogs} empty="暂无日志。" />
      </div>
    </section>
  );
}
