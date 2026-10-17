import React, { useEffect, useRef, useState } from 'react';
import './Reconstruction.css';
import { Film, Folder, Play, Square, RefreshCw } from './icons';
const STAGES = [
  ['media', '视频信息', [], '逐帧时间戳、音轨偏移、帧率类型'],
  ['audio', '提取整集音频', ['media'], 'original_audio.wav · 保留时间映射'],
  ['shots', '检测视觉分镜', ['media'], '视觉候选边界 · 结构复核 · 最短 2 秒'],
  ['separation', '分离人声与背景', ['audio'], '整集 UVR 分离 · vocals / background'],
  ['transcript', '识别台词', ['media', 'separation'], '中文识别 · 音频真实停顿分段 · 人声字幕同步'],
  ['alignment', '关联台词与分镜', ['shots', 'transcript'], '保留视觉切点 · 连续说话可跨镜头 · 不移动时间'],
  ['clips', '导出最终分镜', ['media', 'alignment'], '按原视觉切点导出 · 校验帧数和时间戳'],
  ['export', '导出字幕与文件清单', ['alignment', 'clips', 'transcript'], '全局 SRT · 分镜文件清单'],
  ['jianying', '生成剪映草稿', ['media', 'audio', 'shots', 'clips', 'separation', 'transcript', 'alignment', 'export'], '配音 / 整集背景 / 分镜特效 / 隐藏字幕 / 水印'],
];
const STATUS = { idle: '等待开始', queued: '排队中', running: '处理中', stopping: '正在停止', completed: '全部完成', partial: '部分完成', succeeded: '完成', failed: '失败', blocked: '缺少依赖', stale: '需要重跑', interrupted: '上次任务中断', stopped: '已停止' };
const SEPARATION_STAGES = ['模型启动', '推理完成', '音轨写入', '人声校验', '背景校验', '结果保存'];
const basename = file => String(file || '').replaceAll(String.fromCharCode(92), '/').split('/').pop() || '';
export default function Reconstruction({ active = true }) {
  const [inputPath, setInputPath] = useState('');
  const [outputRoot, setOutputRoot] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState([]);
  const [job, setJob] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const selected = useRef(projectId);
  selected.current = projectId;
  const busy = ['running', 'queued', 'stopping'].includes(job?.status);
  const stages = job?.modules || {};
  const completedCount = STAGES.filter(([id]) => stages[id]?.status === 'succeeded').length;
  const awaitingDraft = STAGES.slice(0, -1).every(([id]) => stages[id]?.status === 'succeeded') && stages.jianying?.status !== 'succeeded';
  const displayStatus = job?.status === 'completed' && completedCount < STAGES.length ? 'partial' : job?.status;
  const refresh = async (id = projectId) => {
    if (!id) return;
    try {
      const result = await window.electronAPI.getReconstructionStatus(id);
      if (selected.current !== id) return;
      if (!result?.success) throw new Error(result?.error || '读取失败');
      setJob(result);
      if (result.inputPath) setInputPath(result.inputPath);
    } catch (error) { setNotice(error.message); }
  };
  useEffect(() => {
    window.electronAPI.getStructureProjects().then(setProjects).catch(e => setNotice(e.message));
    window.electronAPI.getStructureRuntime().then(setRuntime).catch(e => setRuntime({ ready: false, error: e.message }));
    return window.electronAPI.onReconstructionProgress(data => {
      if (data.projectId === selected.current) setJob(data);
      if (['completed', 'partial', 'failed', 'blocked', 'stopped'].includes(data.status)) window.electronAPI.getStructureProjects().then(setProjects).catch(() => {});
    });
  }, []);
  useEffect(() => { if (active && projectId) refresh(); }, [active, projectId]);
  useEffect(() => {
    if (!active || !busy) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, busy]);
  const choose = async () => {
    try { const file = await window.electronAPI.reconstructionSelectVideo(); if (!file) return; selected.current = ''; setInputPath(file); setProjectId(''); setJob(null); setNotice(''); }
    catch (error) { setNotice(error.message); }
  };
  const start = async module => {
    setLoading(true); setNotice('');
    try {
      const result = await window.electronAPI.startReconstruction({ inputPath, projectId: projectId || undefined, outputRoot: outputRoot || undefined, module, force: !!module });
      if (!result?.success) throw new Error(result?.error || '启动失败');
      selected.current = result.projectId; setProjectId(result.projectId); setJob(result);
    } catch (error) { setNotice(error.message); }
    finally { setLoading(false); }
  };
  const cancel = async () => {
    try { const result = await window.electronAPI.cancelReconstruction(projectId); if (!result.success) throw new Error(result.error); await refresh(); }
    catch (error) { setNotice(error.message); }
  };
  const chooseOutput = async () => { try { const folder = await window.electronAPI.selectFolder(); if (folder) setOutputRoot(folder); } catch (error) { setNotice(error.message); } };
  if (!active) return null;
  return <div className="reconstruction-container">
    <div className="reconstruction-header"><div><h2><Film size={25} /> 视频结构化拆解</h2><p>整集本地处理 · 分镜视频 / 人声 / 背景声 / 台词 / 字幕 / 剪映草稿</p></div><span className={'reconstruction-status ' + (busy ? 'is-running' : '')}>{displayStatus === 'partial' && awaitingDraft ? '待生成剪映草稿' : STATUS[displayStatus] || '等待开始'}</span></div>
    <section className="reconstruction-card">
      <div className="reconstruction-card-title">单集输入</div>
      {!!projects.length && <div className="reconstruction-row"><label htmlFor="structure-project">已有项目</label><select id="structure-project" className="input-field" value={projectId} disabled={busy || loading} onChange={e => { const id = e.target.value; selected.current = id; setProjectId(id); setJob(null); setInputPath(projects.find(p => p.projectId === id)?.inputPath || ''); }}><option value="">新建项目</option>{projects.map(p => <option key={p.projectId} value={p.projectId}>{basename(p.inputPath)} · {p.projectId}</option>)}</select></div>}
      <div className="reconstruction-row"><label htmlFor="structure-input">输入视频</label><input id="structure-input" className="input-field" readOnly value={inputPath} placeholder="选择需要拆解的单集视频" /><button className="btn" disabled={busy || loading} onClick={choose}><Film size={14} /> 选择</button></div>
      {!projectId && <div className="reconstruction-row"><label htmlFor="structure-output">结果目录</label><input id="structure-output" className="input-field" value={outputRoot} onChange={e => setOutputRoot(e.target.value)} placeholder="默认：视频所在目录 / 结构化拆解" disabled={busy || loading} /><button className="btn" onClick={chooseOutput} disabled={busy || loading}><Folder size={14} /> 选择</button></div>}
      <div className="structure-toolbar"><button className="btn btn-primary" disabled={!inputPath || loading || busy} onClick={() => start(awaitingDraft ? 'jianying' : undefined)}><Play size={15} />{loading ? '启动中…' : awaitingDraft ? '生成剪映草稿' : job ? '继续完整流程' : '开始完整流程'}</button><button className="btn" onClick={cancel} disabled={!busy || job?.status === 'stopping'}><Square size={14} />停止</button>{job?.manifestPath && <button className="btn" onClick={() => window.electronAPI.showInFolder(job.manifestPath)}><Folder size={14} />查看结果</button>}<button className="btn" disabled={!projectId || loading} onClick={() => refresh()}><RefreshCw size={14} />刷新</button></div>
      <p className="reconstruction-hint">保留画面切点，人声按音频真实停顿分段，字幕与人声同步；连续说话可跨镜头，不因识别标点切断人声，不为了台词合并视频。完整流程复用未变化的结果；单步运行只执行该模块。</p>
      <details className="structure-runtime"><summary>{!runtime ? '正在检查本地运行时…' : runtime.ready ? '本地运行时就绪' : '运行时需要检查'}</summary>{runtime?.error && <p>{runtime.error}</p>}{Object.entries(runtime?.modules || {}).map(([id, item]) => <p key={id}>{STAGES.find(s => s[0] === id)?.[1]}：{item.ready ? '文件就绪' : item.error}</p>)}<button className="btn btn-sm" onClick={() => window.electronAPI.getStructureRuntime().then(setRuntime).catch(e => setNotice(e.message))}>重新检查</button></details>
    </section>
    <section className="reconstruction-card">
      <div className="reconstruction-card-title"><span>处理步骤</span><span>{completedCount} / {STAGES.length} 完成</span></div>
      <div className="structure-modules">{STAGES.map(([id, label, deps, description], index) => {
        const stage = stages[id] || {};
        const ready = deps.every(dep => stages[dep]?.status === 'succeeded');
        const elapsed = stage.status === 'running' ? Math.max(0, (now - Date.parse(stage.started_at)) / 1000) : stage.elapsed_seconds;
        const count = stage.summary?.shot_count ?? stage.summary?.utterance_count ?? stage.summary?.frame_count;
        const progress = Number.isFinite(stage.progress) ? Math.min(100, Math.max(0, stage.progress)) : null;
        const stageProgress = stage.progress_unit === 'stages';
        const stageTotal = Number.isInteger(stage.progress_total) && stage.progress_total > 0 ? stage.progress_total : null;
        const stageDone = stageTotal != null && Number.isInteger(stage.progress_completed) ? Math.min(stageTotal, Math.max(0, stage.progress_completed)) : null;
        const progressText = stageProgress ? stageDone == null ? '等待阶段进度' : `阶段 ${stageDone}/${stageTotal}` : progress == null ? '等待进度数据' : Math.floor(progress) + '%';
        return <div className={'structure-module is-' + (stage.status || 'idle')} key={id}>
          <div className="structure-module-top"><span className="structure-number">{index + 1}</span><strong>{label}</strong><span className="structure-module-status">{stage.reused ? '已复用' : STATUS[stage.status] || '等待'}</span><button className="btn btn-sm" disabled={!inputPath || busy || loading || !ready} title={!ready ? '请先完成前置步骤' : undefined} onClick={() => start(id)}>{stage.status === 'succeeded' ? '重跑' : stage.status === 'failed' ? '重试' : '运行'}</button></div>
          <p>{description}</p>
          {id === 'alignment' && Number.isInteger(stage.summary?.raw_shot_count) && <small>保留视觉分镜 {stage.summary.shot_count} 个 · 台词分段 {stage.summary.association_count || 0} 条 · 人声字幕同步，允许跨镜头</small>}
          {stage.status === 'stale' && stage.message && <p className="reconstruction-hint">{stage.message}</p>}
          {stage.status === 'running' && <div className="structure-stage-progress"><progress max={stageProgress ? stageTotal ?? 1 : 100} value={(stageProgress ? stageDone : progress) ?? undefined} aria-label={label + '进度'} aria-valuetext={progressText} /><div className="structure-progress-label"><span>{stage.message || '处理中'}</span><strong>{progressText}</strong></div></div>}
          {id === 'separation' && stageProgress && <ol className="structure-phase-list" aria-label="音轨分离阶段">{SEPARATION_STAGES.map((name, phase) => <li key={name} className={stageDone != null && phase < stageDone ? 'is-done' : stageDone === phase && stage.status === 'running' ? 'is-active' : ''} aria-current={stageDone === phase && stage.status === 'running' ? 'step' : undefined}><span>{stageDone != null && phase < stageDone ? '✓' : phase + 1}</span>{name}</li>)}</ol>}
          {Number.isFinite(elapsed) && <small className={'structure-elapsed' + (stage.status === 'running' ? ' is-running' : '')}>{stage.status === 'running' ? '已运行' : '耗时'} {Math.floor(elapsed)} 秒{count != null ? ' · 结果 ' + count + ' 项' : ''}{stage.summary?.warning_count > 0 ? ' · ' + stage.summary.warning_count + ' 项待检查' : ''}</small>}
          {stage.error && <pre className="reconstruction-error">{stage.error}</pre>}
          {stage.summary?.draft_path ? <button className="structure-result" onClick={() => window.electronAPI.showInFolder(stage.summary.draft_path)}>打开草稿文件夹</button> : stage.result_path ? <button className="structure-result" onClick={() => window.electronAPI.showInFolder(job.projectDir + '/' + stage.result_path)}>查看结果文件</button> : stage.status === 'stale' && stage.legacy_result_path && <button className="structure-result" onClick={() => window.electronAPI.showInFolder(job.projectDir + '/' + stage.legacy_result_path)}>查看旧结果（待更新）</button>}
        </div>;
      })}</div>
      {job?.error && <pre className="reconstruction-error" role="alert">{job.error}</pre>}
    </section>
    {notice && <p className="alert alert-error" role="alert">{notice}</p>}
  </div>;
}
