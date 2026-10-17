import React, { useEffect, useState } from 'react';
import './Pager.css';
import { pageCount, pageWindow, parseJump } from './pagination';

/** 分页条：共多少项、每页多少条、上一页/下一页/页码、跳转到第几页。 */
export default function Pager({ total, page, pageSize, onPage, onPageSize, sizes = [30, 60, 100, 200], unit = '项' }) {
  const count = pageCount(total, pageSize);
  const [jump, setJump] = useState('');
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setJump('');
    setBad(false);
  }, [page]);
  if (total <= 0) return null;

  const go = () => {
    const target = parseJump(jump, count);
    if (target == null) return setBad(true);
    setBad(false);
    onPage(target);
  };

  return (
    <nav className="pager" aria-label="分页">
      <span className="pager-total">
        共 {total} {unit}
      </span>
      <label className="pager-size">
        每页
        <select
          className="input-field"
          aria-label="每页条数"
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
        >
          {sizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        条
      </label>
      <div className="pager-pages">
        <button className="pager-btn" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="上一页">
          ‹
        </button>
        {pageWindow(page, count).map((item, index) =>
          item == null ? (
            <span key={`gap-${index}`} className="pager-gap">
              …
            </span>
          ) : (
            <button
              key={item}
              className={`pager-btn ${item === page ? 'is-current' : ''}`}
              onClick={() => onPage(item)}
              aria-current={item === page ? 'page' : undefined}
              aria-label={`第 ${item} 页`}
            >
              {item}
            </button>
          ),
        )}
        <button className="pager-btn" onClick={() => onPage(page + 1)} disabled={page >= count} aria-label="下一页">
          ›
        </button>
      </div>
      <span className="pager-jump">
        跳转到第
        <input
          className={`input-field ${bad ? 'is-bad' : ''}`}
          inputMode="numeric"
          aria-label="跳转页码"
          aria-invalid={bad}
          value={jump}
          placeholder={`1–${count}`}
          onChange={(e) => {
            setJump(e.target.value);
            setBad(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        页
        <button className="btn btn-sm" onClick={go}>
          跳转
        </button>
      </span>
    </nav>
  );
}
