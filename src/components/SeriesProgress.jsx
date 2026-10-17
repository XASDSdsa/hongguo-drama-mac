import React, { useEffect, useMemo, useRef, useState } from 'react';
import './SeriesActivity.css';
import { Folder, RefreshCw } from './icons';

const LOG_STEP = 100;

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
  const mainLogs = useMemo(() => logs.filter((line) => line.channel !== 'side'), [logs]);
  const sideLogs = useMemo(() => logs.filter((line) => line.channel === 'side'), [logs]);
  const overall = overallProgress(batches);
  const activeBatches = batches.filter(isActiveBatch);

  const act = async (fn) => {
    setError('');
    const result = await fn();
    if (result && result.success === false) setError(result.error || '操作失败');
    onChanged?.();
  };

  if (!activity) return null;

  let statusText = '还没有处理过。选好集后点下面的「开始处理」，进度和日志都会显示在这里。';
  if (overall) {
    const tail = `${overall.failed ? `，失败 ${overall.failed} 集` : ''}${overall.stopped ? `，已停止 ${overall.stopped} 集` : ''}`;
    statusText = overall.active
      ? `正在处理：已完成 ${overall.done}/${overall.total} 集 · ${overall.progress}%${tail}`
      : `上一批：完成 ${overall.done}/${overall.total} 集${tail}`;
  }

  return (
    <section className="act-panel" aria-label="处理进度">
      <div className="act-head">
        <strong>处理进度</strong>
        <span className="act-head-btns">
          {activeBatches.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() =>
                act(async () => {
                  let last = { success: true };
                  for (const batch of activeBatches) last = await window.electronAPI.quchongCancel(batch.id);
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
        <LogBox title="支线任务日志（海报、下载等）" lines={sideLogs} empty="暂无日志。" />
      </div>
    </section>
  );
}
