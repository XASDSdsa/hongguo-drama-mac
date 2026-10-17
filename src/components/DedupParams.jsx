import React from 'react';
import './DedupParams.css';

// 去重参数面板：「一键处理」和「管理剧集」共用，参数名与主进程 quchong.validateOptions 一致。
export const NUMBER_PARAMS = [
  ['crop_ratio', '裁切比例', 0.01, 0.85, 1],
  ['speed_min', '变速下限', 0.01, 1, 1.1],
  ['speed_max', '变速上限', 0.01, 1, 1.1],
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

export default function DedupParams({ opts, onChange, disabled = false }) {
  return (
    <div className="dedup-params">
      <label>
        分辨率
        <select value={opts.resolution} onChange={(e) => onChange('resolution', e.target.value)} disabled={disabled}>
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
      {NUMBER_PARAMS.map(([key, label, step, min, max]) => (
        <label key={key}>
          {label}
          <input
            className="input-field"
            type="number"
            step={step}
            min={min}
            max={max}
            value={opts[key] ?? ''}
            onChange={(e) => onChange(key, Number(e.target.value))}
            disabled={disabled}
          />
        </label>
      ))}
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
  );
}
