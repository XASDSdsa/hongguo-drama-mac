import React, { useState } from 'react';
import './DedupParams.css';

// 去重参数面板：「一键处理」和「管理剧集」共用，参数名与主进程 quchong.validateOptions 一致。
export const NUMBER_PARAMS = [
  ['crop_ratio', '裁切比例', 0.01, 0.85, 1],
  ['speed_min', '变速下限', 0.01, 1, 1.3],
  ['speed_max', '变速上限', 0.01, 1, 1.3],
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

const FLAGS = [
  ['black_intro', '黑场开头'],
  ['vignette', '暗角'],
  ['eq_enable', '均衡器'],
];

const TIME_GROUPS = [
  {
    title: '成品时长（秒）',
    fields: [
      ['split', 'min_len', '最短', 1, 5, 600],
      ['split', 'max_len', '最长', 1, 5, 900],
    ],
  },
  {
    title: '源视频边缘裁剪（秒）',
    fields: [
      ['split', 'head_trim', '片头裁剪', 0.1, 0, 30],
      ['split', 'tail_trim', '片尾裁剪', 0.1, 0, 30],
    ],
  },
  {
    title: '视频变速范围',
    fields: [
      ['opts', 'speed_min', '最小倍速', 0.01, 1, 1.3],
      ['opts', 'speed_max', '最大倍速', 0.01, 1, 1.3],
    ],
  },
];

/**
 * 去重参数面板。传入 split 时分成「时间与速度 / 画面参数」两页（重新拆分用）；
 * 不传 split 时只有画面参数（含变速范围），和以前一样。
 */
export default function DedupParams({ opts, onChange, disabled = false, split = null, onSplitChange, onReset }) {
  const [tab, setTab] = useState('time');
  const tabbed = !!split;
  const picture = NUMBER_PARAMS.filter(([key]) => !tabbed || !['speed_min', 'speed_max'].includes(key));
  const number = (target, key, label, step, min, max) => {
    const source = target === 'split' ? split : opts;
    const change = target === 'split' ? onSplitChange : onChange;
    return (
      <label key={key}>
        {label}
        <input
          className="input-field"
          type="number"
          step={step}
          min={min}
          max={max}
          value={source[key] ?? ''}
          onChange={(e) => change(key, Number(e.target.value))}
          disabled={disabled}
        />
      </label>
    );
  };
  return (
    <div className="dedup-params">
      {tabbed && (
        <div className="dedup-tabs" role="tablist">
          {[
            ['time', '时间与速度'],
            ['picture', '画面参数'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`dedup-tab ${tab === id ? 'is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
          {onReset && (
            <button type="button" className="btn btn-sm dedup-reset" onClick={onReset} disabled={disabled}>
              恢复默认值
            </button>
          )}
        </div>
      )}
      {tabbed && tab === 'time' && (
        <div className="dedup-groups">
          {TIME_GROUPS.map((group) => (
            <fieldset key={group.title} className="dedup-group">
              <legend>{group.title}</legend>
              <div className="dedup-group-fields">{group.fields.map((field) => number(...field))}</div>
            </fieldset>
          ))}
        </div>
      )}
      {(!tabbed || tab === 'picture') && (
        <div className="dedup-grid">
          <label>
            分辨率
            <select
              value={opts.resolution}
              onChange={(e) => onChange('resolution', e.target.value)}
              disabled={disabled}
            >
              <option value="1080x1920">1080×1920</option>
              <option value="720x1280">720×1280</option>
            </select>
          </label>
          <label>
            画质
            <select value={opts.quality} onChange={(e) => onChange('quality', e.target.value)} disabled={disabled}>
              <option value="standard">标准</option>
              <option value="lean">精简</option>
            </select>
          </label>
          {picture.map(([key, label, step, min, max]) => number('opts', key, label, step, min, max))}
          {FLAGS.map(([key, label]) => (
            <label key={key} className="dedup-check">
              <input
                type="checkbox"
                checked={!!opts[key]}
                onChange={(e) => onChange(key, e.target.checked)}
                disabled={disabled}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
