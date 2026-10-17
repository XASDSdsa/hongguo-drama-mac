import React, { useEffect, useMemo, useRef, useState } from 'react';
import './SeriesActivity.css';
import { Folder, RefreshCw } from './icons';
import Pager from './Pager';
import { clampPage, slicePage } from './pagination';

const STAGE_TEXT = {
  queued: '排队中',
  pending: '排队中',
  processing: '处理中',
  running: '处理中',
  probing: '读取视频',
  encoding: '编码中',
  finalizing: '写入 MP4 索引',
  validating: '校验输出',
  saving: '保存文件',
};
const BATCH_STATE = {
  running: '处理中',
  queued: '排队中',
  completed: '已完成',
  failed: '有失败',
  stopped: '已停止',
};
const TASK_PAGE_SIZES = [10, 20, 50];
const LOG_STEP = 60;

export const isActiveBatch = (batch) => batch.status === 'running' || batch.status === 'queued';

export function formatClock(value, withDate = false) {
  const date = new Date(Number(value) || 0);
  const pad = (part) => String(part).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withDate ? `${date.getMonth() + 1}-${date.getDate()} ${time}` : time;
}

export function taskText(task) {
  if (task.status === 'completed') return '完成';
  if (task.status === 'failed') return `失败：${task.error || '未知原因'}`;
  if (task.status === 'stopped') return task.error ? `已停止（${task.error}）` : '已停止';
  const stage = STAGE_TEXT[task.stage] || '处理中';
  return task.stage === 'encoding' ? `${stage} ${Math.round(task.progress || 0)}%` : stage;
}

function BatchCard({ batch, open, onToggle, onCancel }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const active = isActiveBatch(batch);
  const current = clampPage(page, batch.tasks.length, pageSize);
  const visible = slicePage(batch.tasks, current, pageSize);
  const created = new Date(batch.createdAt);
  return (
    <div className={`act-batch is-${batch.status}`}>
      <div className="act-batch-head">
        <button className="act-toggle" onClick={onToggle} aria-expanded={open}>
          {open ? '▾' : '▸'}
        </button>
        <div className="act-batch-title">
          <strong>
            {created.getMonth() + 1}月{created.getDate()}日 {formatClock(batch.createdAt).slice(0, 5)}
          </strong>
          <span>
            {batch.modeText || '去重'} · 共 {batch.total} 集
          </span>
          <b className={`act-chip is-${batch.status}`}>{BATCH_STATE[batch.status] || batch.status}</b>
        </div>
        <div className="act-batch-side">
          <span>
            {batch.done}/{batch.total} 集 · {batch.progress}%
          </span>
          {active && (
            <button className="btn btn-sm" onClick={() => onCancel(batch)}>
              取消
            </button>
          )}
        </div>
      </div>
      <div className="act-bar" aria-hidden="true">
        <i style={{ width: `${batch.progress}%` }} />
      </div>
      {open && (
        <>
          <ul className="act-tasks">
            {visible.map((task) => (
              <li key={task.id} className={`is-${task.status}`}>
                <span className="act-task-name" title={task.dst}>
                  {task.name}
                </span>
                <span className="act-task-from">
                  {task.episodes?.length ? `原第 ${task.episodes.join('、')} 集` : ''}
                </span>
                <span className="act-task-state" title={task.error || ''}>
                  {taskText(task)}
                </span>
                <span className="act-mini" aria-hidden="true">
                  <i style={{ width: `${task.status === 'completed' ? 100 : task.progress || 0}%` }} />
                </span>
              </li>
            ))}
          </ul>
          <Pager
            total={batch.tasks.length}
            page={current}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            sizes={TASK_PAGE_SIZES}
            unit="集"
          />
        </>
      )}
    </div>
  );
}

/** 一部剧的处理进度和日志。数据来自主进程，页面切走再回来、重启应用后都还在。 */
export default function SeriesProgress({ dir, activity, onChanged }) {
  const [openMap, setOpenMap] = useState({});
  const [logLimit, setLogLimit] = useState(LOG_STEP);
  const [error, setError] = useState('');
  const logRef = useRef(null);
  const stick = useRef(true);

  const batches = activity?.batches || [];
  const jobs = (activity?.jobs || []).filter((job) => ['waiting', 'starting', 'failed'].includes(job.status));
  const planning = activity?.planning;
  const logs = activity?.logs || [];
  const shownLogs = useMemo(() => logs.slice(-logLimit), [logs, logLimit]);

  useEffect(() => {
    const box = logRef.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [shownLogs.length, logs[logs.length - 1]?.t]);

  const act = async (fn) => {
    setError('');
    const result = await fn();
    if (result && result.success === false) setError(result.error || '操作失败');
    onChanged?.();
  };

  if (!activity) return null;
  if (!batches.length && !jobs.length && !planning && !logs.length) {
    return (
      <section className="act-panel" aria-label="处理进度">
        <div className="act-head">
          <strong>处理进度</strong>
        </div>
        <p className="act-empty">还没有处理过。选好集后点下面的「开始处理」，进度和日志都会显示在这里。</p>
      </section>
    );
  }

  return (
    <section className="act-panel" aria-label="处理进度">
      <div className="act-head">
        <strong>处理进度</strong>
        <span className="act-head-btns">
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
          <span className="act-bar act-bar-inline" aria-hidden="true">
            <i style={{ width: `${planning.total ? Math.round((planning.done / planning.total) * 100) : 0}%` }} />
          </span>
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

      {batches.map((batch, index) => (
        <BatchCard
          key={batch.id}
          batch={batch}
          open={openMap[batch.id] ?? (isActiveBatch(batch) || index === 0)}
          onToggle={() =>
            setOpenMap((map) => ({ ...map, [batch.id]: !(map[batch.id] ?? (isActiveBatch(batch) || index === 0)) }))
          }
          onCancel={(target) => act(() => window.electronAPI.quchongCancel(target.id))}
        />
      ))}
      {error && <p className="act-error">{error}</p>}

      <div className="act-log-head">
        <strong>日志</strong>
        {logs.length > 0 && (
          <button className="lib-link" onClick={() => act(() => window.electronAPI.libraryActivityClear(dir))}>
            清空
          </button>
        )}
      </div>
      {logs.length > shownLogs.length && (
        <button className="lib-link act-more" onClick={() => setLogLimit((value) => value + LOG_STEP)}>
          显示更早的（还有 {logs.length - shownLogs.length} 条）
        </button>
      )}
      <div
        className="act-log"
        ref={logRef}
        role="log"
        aria-live="off"
        onScroll={(event) => {
          const box = event.currentTarget;
          stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        }}
      >
        {shownLogs.length === 0 && <p className="act-empty">暂无日志。</p>}
        {shownLogs.map((line, index) => (
          <div key={`${line.t}-${index}`} className={`act-line is-${line.level}`}>
            <time>{formatClock(line.t, new Date(line.t).toDateString() !== new Date().toDateString())}</time>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
