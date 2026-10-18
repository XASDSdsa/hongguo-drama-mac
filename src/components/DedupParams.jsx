import React, { useEffect, useState } from 'react';
import './DedupParams.css';

// 去重参数面板：「一键处理」和「管理剧集」共用，参数名与主进程 quchong.validateOptions 一致。
// 常用的画面参数：每集在「最小值 ~ 最大值」之间随机取一个，都是很便宜的调色和锐化。
export const RANGE_PARAMS = [
  ['亮度', 'brightness_min', 'brightness_max', 0.01, -0.5, 0.5],
  ['对比度', 'contrast_min', 'contrast_max', 0.01, 0.5, 1.5],
  ['Gamma', 'gamma_min', 'gamma_max', 0.01, 0.5, 2],
  ['饱和度', 'saturation_min', 'saturation_max', 0.01, 0.3, 2],
  ['色相', 'hue_min', 'hue_max', 0.1, -30, 30],
  ['unsharp 锐化（负数为轻微模糊）', 'unsharp_min', 'unsharp_max', 0.01, -2, 2],
];

export const BASIC_PARAMS = [
  ['crop_ratio', '裁切比例', 0.01, 0.85, 1],
  ['center_exclude', '中心排除比例（%）', 1, 0, 90],
  ['speed_min', '变速下限', 0.01, 1, 1.3],
  ['speed_max', '变速上限', 0.01, 1, 1.3],
  ['orig_volume', '原声音量', 0.05, 0.1, 1],
  ['bgm_volume', 'BGM 音量', 0.05, 0, 0.5],
];

// 下面这些都比较吃时间（处理一集要多花好几倍），默认全部关闭，需要时再手动打开。
export const HEAVY_PARAMS = [
  ['rotation_max', '最大旋转（0 = 关）', 0.001, 0, 0.02],
  ['rgb_shift', 'RGB 偏移（0 = 关）', 1, 0, 5],
  ['noise_min', '噪点下限（0 = 关）', 1, 0, 15],
  ['noise_max', '噪点上限', 1, 0, 15],
  ['pitch_min', '音调下限（1 = 不变）', 0.01, 1, 1.1],
  ['pitch_max', '音调上限', 0.01, 1, 1.1],
];

const FLAGS = [
  ['vignette', '暗角（较慢）'],
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
    title: '新集编号',
    fields: [['split', 'start_number', '从第几集开始', 1, 1, 9999]],
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
 * 数字输入框：输入过程中允许临时为空或不完整（比如刚删掉、正在输入负号）；
 * 只有合法且在范围内的数才交给上层。离开输入框时，空的恢复成原值，超出范围的拉回到边界。
 * 这样不会把 0、NaN 或越界的值存下来，后台也就不会因为参数无效拒绝处理。
 */
function NumberField({ value, step, min, max, disabled, onCommit, ariaLabel }) {
  const [text, setText] = useState(value ?? '');
  const parse = (raw) => (String(raw).trim() === '' ? NaN : Number(raw));
  // 外面改了值（比如「恢复默认值」）才同步进来；正在输入「1.」这种半截数字时不打断。
  useEffect(() => {
    setText((current) => (parse(current) === value ? current : (value ?? '')));
  }, [value]);
  return (
    <input
      className="input-field"
      type="number"
      step={step}
      min={min}
      max={max}
      aria-label={ariaLabel}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const next = parse(e.target.value);
        if (Number.isFinite(next) && next >= min && next <= max) onCommit(next);
      }}
      onBlur={() => {
        const next = parse(text);
        if (!Number.isFinite(next)) return setText(value ?? '');
        const clamped = Math.min(max, Math.max(min, next));
        setText(clamped);
        if (clamped !== value) onCommit(clamped);
      }}
    />
  );
}

/** 最小值大于最大值的成对参数，返回提示文字。 */
export function rangeProblems(opts = {}, split = null) {
  const problems = [];
  for (const [label, minKey, maxKey] of RANGE_PARAMS)
    if (Number(opts[minKey]) > Number(opts[maxKey])) problems.push(`${label}的最小值大于最大值`);
  if (Number(opts.speed_min) > Number(opts.speed_max)) problems.push('最小倍速大于最大倍速');
  if (Number(opts.noise_min) > Number(opts.noise_max)) problems.push('噪点下限大于上限');
  if (Number(opts.pitch_min) > Number(opts.pitch_max)) problems.push('音调下限大于上限');
  if (split && Number(split.max_len) - Number(split.min_len) < 1) problems.push('成品时长的最长要比最短至少多 1 秒');
  return problems;
}

/**
 * 去重参数面板。传入 split 时分成「时间与速度 / 画面参数」两页（重新拆分用）；
 * 不传 split 时只有画面参数（含变速范围），和以前一样。
 */
export default function DedupParams({ opts, onChange, disabled = false, split = null, onSplitChange, onReset }) {
  const [tab, setTab] = useState('time');
  const tabbed = !!split;
  const basic = BASIC_PARAMS.filter(([key]) => !tabbed || !['speed_min', 'speed_max'].includes(key));
  const number = (target, key, label, step, min, max) => {
    const source = target === 'split' ? split : opts;
    const change = target === 'split' ? onSplitChange : onChange;
    return (
      <label key={key}>
        {label}
        <NumberField
          value={source[key]}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onCommit={(value) => change(key, value)}
        />
      </label>
    );
  };
  const problems = rangeProblems(opts, split);
  return (
    <div className="dedup-params">
      {problems.length > 0 && (
        <p className="dedup-problem" role="alert">
          参数需要调整：{problems.join('；')}
        </p>
      )}
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
        <>
          <div className="dedup-range">
            <span className="dedup-range-head">参数</span>
            <span className="dedup-range-head">最小值</span>
            <span className="dedup-range-head">最大值</span>
            {RANGE_PARAMS.map(([label, minKey, maxKey, step, min, max]) => (
              <React.Fragment key={minKey}>
                <span className="dedup-range-name">{label}</span>
                {[minKey, maxKey].map((key) => (
                  <NumberField
                    key={key}
                    ariaLabel={`${label}${key === minKey ? '最小值' : '最大值'}`}
                    value={opts[key]}
                    step={step}
                    min={min}
                    max={max}
                    disabled={disabled}
                    onCommit={(value) => onChange(key, value)}
                  />
                ))}
              </React.Fragment>
            ))}
          </div>
          <div className="dedup-grid">
            <label>
              画质
              <select
                className="input-field"
                value={opts.quality}
                onChange={(e) => onChange('quality', e.target.value)}
                disabled={disabled}
              >
                <option value="standard">标准</option>
                <option value="lean">精简</option>
              </select>
            </label>
            {basic.map(([key, label, step, min, max]) => number('opts', key, label, step, min, max))}
          </div>
          <details className="dedup-heavy">
            <summary>更多效果（较慢，默认关闭）</summary>
            <div className="dedup-grid">
              {HEAVY_PARAMS.map(([key, label, step, min, max]) => number('opts', key, label, step, min, max))}
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
          </details>
        </>
      )}
    </div>
  );
}
