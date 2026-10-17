import React, { useState } from 'react';
import './SeriesActivity.css';
import Pager from './Pager';
import { clampPage, slicePage } from './pagination';

const STATE_TEXT = {
  running: '处理中',
  queued: '排队中',
  completed: '处理完成',
  failed: '处理有失败',
  stopped: '处理已停止',
};
const SIZES = [5, 10, 20];

export const overviewBusy = (data) =>
  !!data && data.items.some((item) => item.planning || ['running', 'queued'].includes(item.processing?.state));

function Row({ item, onOpen, onDismissJob }) {
  const p = item.processing;
  const downloading = item.downloads.active + item.downloads.pending;
  return (
    <li className="ov-row">
      <button className="ov-name" onClick={() => onOpen(item)} title={item.dir}>
        {item.name}
      </button>
      <div className="ov-parts">
        {item.planning && (
          <span className="act-chip is-running">
            分析切点 {item.planning.done}/{item.planning.total}
          </span>
        )}
        {p && (
          <span className={`ov-proc is-${p.state}`}>
            <b className={`act-chip is-${p.state}`}>{STATE_TEXT[p.state]}</b>
            {p.done}/{p.total} 集
            {['running', 'queued'].includes(p.state) && (
              <span className="act-mini" aria-hidden="true">
                <i style={{ width: `${p.progress}%` }} />
              </span>
            )}
            {p.failed > 0 && <em>失败 {p.failed} 集</em>}
          </span>
        )}
        {downloading > 0 && <span className="act-chip is-running">下载中 {downloading} 集</span>}
        {item.downloads.failed > 0 && <span className="act-chip is-failed">下载失败 {item.downloads.failed} 集</span>}
        {item.downloads.stopped > 0 && <span className="act-chip is-stopped">已暂停 {item.downloads.stopped} 集</span>}
        {item.job && (
          <span className={`ov-job is-${item.job.status}`}>
            {item.job.message}
            {item.job.status === 'failed' && (
              <button className="lib-link" onClick={() => onDismissJob(item.job)}>
                知道了
              </button>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

/** 总任务：所有剧的处理、下载、补下载一眼看全；点一行进入那部剧。 */
export default function TaskOverview({ data, onOpen, onDismissJob }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  if (!data) return null;
  const { totals, items } = data;
  const current = clampPage(page, items.length, pageSize);
  const visible = slicePage(items, current, pageSize);
  const chips = [
    ['处理中', totals.processingRunning, 'running'],
    ['排队', totals.processingQueued, 'queued'],
    ['下载中', totals.downloadActive, 'running'],
    ['处理失败', totals.processingFailed, 'failed'],
    ['下载失败', totals.downloadFailed, 'failed'],
  ].filter(([, count]) => count > 0);

  return (
    <section className="ov-panel" aria-label="总任务">
      <div className="ov-head">
        <strong>总任务</strong>
        {chips.length ? (
          chips.map(([label, count, kind]) => (
            <span key={label} className={`act-chip is-${kind}`}>
              {label} {count} 集
            </span>
          ))
        ) : (
          <span className="ov-idle">现在没有在跑的任务</span>
        )}
        <span className="ov-count">{items.length ? `共 ${items.length} 部剧有记录` : ''}</span>
      </div>
      {items.length > 0 && (
        <>
          <ul className="ov-list">
            {visible.map((item) => (
              <Row key={item.dir} item={item} onOpen={onOpen} onDismissJob={onDismissJob} />
            ))}
          </ul>
          {items.length > SIZES[0] && (
            <Pager
              total={items.length}
              page={current}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              sizes={SIZES}
              unit="部"
            />
          )}
        </>
      )}
    </section>
  );
}
