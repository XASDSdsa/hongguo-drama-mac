import React, { useState, useEffect, useRef } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './Settings.css';
import { Settings, Folder, Check, Globe, X, RefreshCw, AlertCircle } from './icons';

const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
];

const PROXY_MODES = [
  { value: 'system', label: '跟随系统', desc: '使用系统 / 环境变量里已有的代理设置' },
  { value: 'custom', label: '手动指定', desc: '自己填写代理地址与端口（支持 HTTP/HTTPS 代理）' },
  { value: 'direct', label: '强制直连', desc: '忽略一切代理，直接连接' },
];

// 常见代理软件默认端口，方便一键填入
const PORT_PRESETS = [
  { label: 'Clash / Mihomo', port: 7890 },
  { label: 'V2rayN', port: 10809 },
  { label: 'Shadowsocks', port: 1080 },
  { label: 'Burp / 抓包', port: 8080 },
];

/** 已保存设置 -> 当前生效的代理描述 */
function describeProxy(settings) {
  if (!settings || settings.proxy_enabled !== true) {
    return { on: false, text: '未启用（所有请求直连）' };
  }
  const mode = settings.proxy_mode || 'system';
  if (mode === 'direct') {
    return { on: false, text: '已开启但模式为「强制直连」' };
  }
  if (mode === 'custom') {
    const host = (settings.proxy_host || '').trim();
    const port = (settings.proxy_port || '').toString().trim();
    if (!host) return { on: false, text: '已开启，但未填写代理地址' };
    return { on: true, text: `${host}${port ? ':' + port : ''}` };
  }
  return { on: true, text: '跟随系统 / 环境变量代理' };
}

const OUTPUT_DIRS = [
  {
    key: 'merge_output_dir',
    label: '整剧合并输出目录',
    hint: '在「我的剧库」里把整部剧合并成一个视频时，保存到这里。',
  },
];

function SettingsPage({ active = true }) {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [aiTest, setAiTest] = useState(null);
  const [aiTesting, setAiTesting] = useState(false);
  const testVersion = useRef(0);
  const savingRef = useRef(false);
  const savedTimer = useRef(null);

  const loadSettings = async () => {
    setLoadError('');
    try {
      const next = await window.electronAPI.getSettings();
      setSettings(next);
      setDirty(false);
      setSaveError('');
    } catch (error) {
      setLoadError(error.message || '设置加载失败，请重试');
    }
  };

  useEffect(() => {
    loadSettings();
    return () => {
      testVersion.current++;
      clearTimeout(savedTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      testVersion.current++;
      setTesting(false);
      setTestResult(null);
    }
  }, [active]);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setDirty(true);
    setSaveError('');
  };

  const selectFolder = async (key = 'root') => {
    try {
      const dir = await window.electronAPI.selectFolder();
      if (dir) update(key, dir);
    } catch (error) {
      setSaveError(error.message || '文件夹选择失败，请重试');
    }
  };

  // 用表单里当前填的值测一次文本接口（不需要先保存）。
  const testAi = async () => {
    setAiTesting(true);
    setAiTest(null);
    try {
      setAiTest(
        await window.electronAPI.testAiText({
          ai_base_url: settings.ai_base_url,
          ai_api_key: settings.ai_api_key,
          ai_text_model: settings.ai_text_model,
        }),
      );
    } catch (error) {
      setAiTest({ success: false, error: error.message || '测试失败' });
    } finally {
      setAiTesting(false);
    }
  };

  const persist = async (next, isProxy = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError('');
    try {
      // Playback options may change while this retained settings page is hidden.
      const current = await window.electronAPI.getSettings();
      const editable = [
        'root',
        'structure_output_dir',
        'merge_output_dir',
        'name_format',
        'max_concurrent',
        'quchong_jobs',
        'proxy_enabled',
        'proxy_mode',
        'proxy_host',
        'proxy_port',
        'proxy_username',
        'proxy_password',
        'ai_base_url',
        'ai_api_key',
        'ai_image_base_url',
        'ai_image_api_key',
        'ai_image_model',
        'ai_text_model',
        'structure_threads',
        'structure_cleanup',
        'structure_device',
        'structure_clip_audio',
        'structure_punctuation_model',
        'jianying_python_path',
        'jianying_user_data_path',
      ];
      const submitted = { ...current };
      for (const key of editable) if (Object.hasOwn(next, key)) submitted[key] = next[key];
      const res = await window.electronAPI.saveSettings(submitted);
      if (!res?.success) throw new Error(res?.error || '设置未保存，请重试');
      // 去重并发数要让正在跑的批次也跟着变，走专门的接口。
      if (Number(submitted.quchong_jobs || 2) !== Number(current.quchong_jobs || 2)) {
        const applied = await window.electronAPI.quchongSetConcurrency(Number(submitted.quchong_jobs));
        if (!applied?.success) throw new Error(applied?.error || '去重并发设置保存失败');
      }
      setSettings(submitted);
      if (isProxy) closeProxy();
      setDirty(false);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setSaveError(error.message || '设置保存失败，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const save = () => persist(settings);

  const closeProxy = () => {
    testVersion.current++;
    setTesting(false);
    setProxyOpen(false);
    setTestResult(null);
  };

  // ===== 代理弹窗 =====
  const openProxyModal = () => {
    testVersion.current++;
    setProxyDraft({
      proxy_enabled: settings.proxy_enabled === true,
      proxy_mode: settings.proxy_mode || 'system',
      proxy_host: settings.proxy_host || '127.0.0.1',
      proxy_port: settings.proxy_port || 7890,
      proxy_username: settings.proxy_username || '',
      proxy_password: settings.proxy_password || '',
    });
    setTestResult(null);
    setSaveError('');
    setProxyOpen(true);
  };

  const patchDraft = (key, value) => {
    testVersion.current++;
    setProxyDraft((prev) => ({ ...prev, [key]: value }));
    setTesting(false);
    setTestResult(null);
  };

  const runTest = async () => {
    const request = ++testVersion.current;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.electronAPI.testProxy(proxyDraft);
      if (request === testVersion.current) setTestResult(res);
    } catch (e) {
      if (request === testVersion.current) setTestResult({ success: false, error: e.message });
    } finally {
      if (request === testVersion.current) setTesting(false);
    }
  };

  const applyProxy = () => persist({ ...settings, ...proxyDraft }, true);

  useDialogKeyboard(
    active && proxyOpen,
    () => {
      if (!savingRef.current) closeProxy();
    },
    '.proxy-modal',
  );

  if (!settings) {
    return (
      <div className="settings-container">
        {loadError ? (
          <div role="alert">
            <p>{loadError}</p>
            <button className="btn btn-outline" onClick={loadSettings}>
              重新加载
            </button>
          </div>
        ) : (
          '加载中...'
        )}
      </div>
    );
  }

  const proxyInfo = describeProxy(settings);
  const mode = proxyDraft ? proxyDraft.proxy_mode : 'system';

  return (
    <div className="settings-container">
      <div className="settings-header">
        <Settings size={22} />
        <div>
          <h2>设置</h2>
          <p className="page-description">
            保存位置、下载、去重与剪映草稿、AI 素材。改完点最下面的「保存设置」才会生效。
          </p>
        </div>
      </div>

      <fieldset className="settings-form" disabled={saving}>
        <section className="settings-section" aria-label="保存位置">
          <header className="settings-section-head">
            <h3>保存位置</h3>
            <p>视频和成品放在哪里、怎么命名。</p>
          </header>
          <div className="settings-group">
            <label className="settings-label">下载目录</label>
            <div className="folder-row">
              <input
                type="text"
                className="input-field"
                aria-label="下载目录"
                value={settings.root || ''}
                onChange={(e) => update('root', e.target.value)}
                placeholder="选择下载保存目录"
              />
              <button className="btn btn-outline" onClick={() => selectFolder()}>
                <Folder size={16} />
                选择文件夹
              </button>
            </div>
            <p className="settings-hint">
              每部剧会在这里建一个以剧名命名的文件夹，视频保存在里面；去重成品、剪映草稿也放在这部剧自己的文件夹里。
            </p>
          </div>
          <div className="settings-group">
            <label className="settings-label">文件命名规则</label>
            <div className="preset-row">
              {FORMAT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`btn-chip ${settings.name_format === p.value ? 'btn-chip-primary' : ''}`}
                  onClick={() => update('name_format', p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="text"
              className="input-field"
              aria-label="文件命名规则"
              value={settings.name_format || ''}
              onChange={(e) => update('name_format', e.target.value)}
            />
            <p className="settings-hint">
              可用变量：<code>剧名</code> · <code>集数</code>（如 001）· <code>标题</code>
              。每集保留独立集号，避免同名覆盖。
            </p>
          </div>
          {OUTPUT_DIRS.map(({ key, label, hint }) => (
            <div className="settings-group" key={key}>
              <label className="settings-label">{label}</label>
              <div className="folder-row">
                <input
                  type="text"
                  className="input-field"
                  aria-label={label}
                  value={settings[key] || ''}
                  onChange={(e) => update(key, e.target.value)}
                  placeholder="未选择：用到时会提示先选择"
                />
                <button className="btn btn-outline" onClick={() => selectFolder(key)}>
                  <Folder size={16} />
                  选择文件夹
                </button>
              </div>
              <p className="settings-hint">{hint}</p>
            </div>
          ))}
        </section>

        <section className="settings-section" aria-label="下载与网络">
          <header className="settings-section-head">
            <h3>下载与网络</h3>
            <p>下载速度和代理。</p>
          </header>
          <div className="settings-group">
            <label className="settings-label">最大并发下载数</label>
            <select
              className="input-field select-field"
              aria-label="最大并发下载数"
              value={settings.max_concurrent || 3}
              onChange={(e) => update('max_concurrent', parseInt(e.target.value, 10))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n} 个同时下载
                </option>
              ))}
            </select>
            <p className="settings-hint">并发越高越快，但可能触发接口限流，建议 3~5。</p>
          </div>
          <div className="settings-group">
            <label className="settings-label">网络代理</label>
            <div className="proxy-status-row">
              <span className={`proxy-dot ${proxyInfo.on ? 'proxy-dot-on' : 'proxy-dot-off'}`} />
              <span className="proxy-status-text">
                {proxyInfo.on ? (
                  <>
                    已启用：<code>{proxyInfo.text}</code>
                  </>
                ) : (
                  proxyInfo.text
                )}
              </span>
              <button className="btn btn-outline btn-sm" onClick={openProxyModal}>
                <Globe size={15} />
                配置代理
              </button>
            </div>
            <p className="settings-hint">
              本机有代理（Clash / V2rayN
              等）时在这里填上，解析剧集与下载视频都会走该代理。代理在弹窗里单独保存，立即生效，无需重启。
            </p>
          </div>
        </section>

        <section className="settings-section" aria-label="去重与剪映草稿">
          <header className="settings-section-head">
            <h3>去重与剪映草稿</h3>
            <p>
              这部分在「管理剧集」里这部剧的页面使用：视频去重、本地结构化拆解（TransNet V2
              分镜、人声分离、台词识别）、生成剪映草稿。
            </p>
          </header>
          <div className="settings-grid">
            <label className="settings-field">
              <span>视频去重同时处理</span>
              <select
                className="input-field"
                aria-label="去重并发数"
                value={settings.quchong_jobs || 2}
                onChange={(e) => update('quchong_jobs', parseInt(e.target.value, 10))}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} 集同时处理
                  </option>
                ))}
              </select>
              <em>越多越快但更占电脑，一般 2~4；保存后立即生效，正在跑的批次也会跟着调整。</em>
            </label>
            <label className="settings-field">
              <span>草稿处理线程数</span>
              <input
                className="input-field"
                type="number"
                min="0"
                max="32"
                aria-label="处理线程数"
                value={settings.structure_threads ?? 0}
                onChange={(e) => update('structure_threads', Number(e.target.value))}
              />
              <em>0 = 自动。同时做几集由电脑的线程、内存和负载决定（最多 4 集），电脑忙时自动少开。</em>
            </label>
            <label className="settings-field settings-field-wide">
              <span>草稿生成后的分析中间文件</span>
              <select
                className="input-field"
                aria-label="分析中间文件清理"
                value={settings.structure_cleanup === false ? 'off' : 'on'}
                onChange={(e) => update('structure_cleanup', e.target.value === 'on')}
              >
                <option value="on">自动清理（省磁盘；之后重做草稿要重新分析）</option>
                <option value="off">保留（重做草稿更快，但每集占几百 MB 到几 GB）</option>
              </select>
              <em>只清理分析用的中间文件，去重成品、剪映草稿和原视频不会动。</em>
            </label>
            <label className="settings-field">
              <span>剪映 Python 路径（可选）</span>
              <input
                className="input-field"
                value={settings.jianying_python_path || ''}
                onChange={(e) => update('jianying_python_path', e.target.value)}
                placeholder="留空自动查找"
              />
            </label>
            <label className="settings-field">
              <span>剪映草稿目录（可选）</span>
              <input
                className="input-field"
                value={settings.jianying_user_data_path || ''}
                onChange={(e) => update('jianying_user_data_path', e.target.value)}
                placeholder="留空使用剪映默认目录"
              />
            </label>
          </div>
          <details className="settings-advanced">
            <summary>高级：拆解设备与模型</summary>
            <div className="settings-grid">
              <label className="settings-field">
                <span>TransNet V2 设备</span>
                <select
                  className="input-field"
                  value={settings.structure_device || 'cpu'}
                  onChange={(e) => update('structure_device', e.target.value)}
                >
                  <option value="cpu">CPU</option>
                  <option value="cuda">CUDA（需要兼容运行时）</option>
                  <option value="mps">Apple MPS（需要兼容运行时）</option>
                </select>
              </label>
              <label className="settings-field">
                <span>镜头视频音轨</span>
                <select
                  className="input-field"
                  value={settings.structure_clip_audio || 'original'}
                  onChange={(e) => update('structure_clip_audio', e.target.value)}
                >
                  <option value="original">保留原声</option>
                  <option value="mute">静音</option>
                </select>
              </label>
              <label className="settings-field settings-field-wide">
                <span>标点模型（可选覆盖）</span>
                <input
                  className="input-field"
                  value={settings.structure_punctuation_model || ''}
                  onChange={(e) => update('structure_punctuation_model', e.target.value)}
                  placeholder="留空使用内置中文标点模型"
                />
              </label>
              <label className="settings-field settings-field-wide">
                <span>分析中间文件目录（可选）</span>
                <div className="folder-row">
                  <input
                    type="text"
                    className="input-field"
                    aria-label="分析中间文件目录"
                    value={settings.structure_output_dir || ''}
                    onChange={(e) => update('structure_output_dir', e.target.value)}
                    placeholder="留空使用软件自己的数据目录"
                  />
                  <button
                    className="btn btn-outline"
                    type="button"
                    onClick={() => selectFolder('structure_output_dir')}
                  >
                    <Folder size={16} />
                    选择
                  </button>
                </div>
              </label>
            </div>
            <p className="settings-hint">
              分镜算法固定为「单路 0.5 · 时间结构复核 · 最短 2 秒」，人声分离和台词识别在本机 CPU
              上运行。设备在运行前固定，不自动切换；修改后重跑会让受影响的下游结果失效。
            </p>
          </details>
        </section>

        <section className="settings-section" aria-label="AI 发布素材">
          <header className="settings-section-head">
            <h3>AI 发布素材</h3>
            <p>
              改写剧名、简介和生成海报用。填写 OpenAI 兼容接口的中转地址（通常以 <code>/v1</code> 结尾）和
              Key；文本和作图可以走不同的中转站，作图那组留空就和文本共用。
            </p>
          </header>
          <div className="ai-settings-grid">
            <label className="ai-field ai-field-wide">
              <span>文本中转地址</span>
              <input
                className="input-field"
                aria-label="AI 文本中转地址"
                value={settings.ai_base_url || ''}
                onChange={(e) => update('ai_base_url', e.target.value)}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </label>
            <label className="ai-field ai-field-wide">
              <span>文本 API Key</span>
              <input
                className="input-field"
                type="password"
                autoComplete="off"
                aria-label="AI 文本 API Key"
                value={settings.ai_api_key || ''}
                onChange={(e) => update('ai_api_key', e.target.value)}
                placeholder="sk-…"
                spellCheck={false}
              />
            </label>
            <label className="ai-field">
              <span>文本模型（改写简介、剧名，检查画面）</span>
              <input
                className="input-field"
                aria-label="AI 文本模型"
                value={settings.ai_text_model || ''}
                onChange={(e) => update('ai_text_model', e.target.value)}
                placeholder="gpt-6.1-sol"
                spellCheck={false}
              />
              <em>要能看图（检查海报底图有没有文字、人脸在哪）；不支持看图时会跳过检查。</em>
            </label>
            <label className="ai-field">
              <span>图片模型（重绘海报底图）</span>
              <input
                className="input-field"
                aria-label="AI 图片模型"
                value={settings.ai_image_model || ''}
                onChange={(e) => update('ai_image_model', e.target.value)}
                placeholder="gpt-image-2.5"
                spellCheck={false}
              />
            </label>
            <label className="ai-field ai-field-wide">
              <span>作图中转地址（可选）</span>
              <input
                className="input-field"
                aria-label="AI 作图中转地址"
                value={settings.ai_image_base_url || ''}
                onChange={(e) => update('ai_image_base_url', e.target.value)}
                placeholder="留空 = 和文本共用"
                spellCheck={false}
              />
            </label>
            <label className="ai-field ai-field-wide">
              <span>作图 API Key（可选）</span>
              <input
                className="input-field"
                type="password"
                autoComplete="off"
                aria-label="AI 作图 API Key"
                value={settings.ai_image_api_key || ''}
                onChange={(e) => update('ai_image_api_key', e.target.value)}
                placeholder="留空 = 和文本共用"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="preset-row">
            <button className="btn btn-outline btn-sm" onClick={testAi} disabled={aiTesting}>
              {aiTesting ? '正在测试…' : '测试文本连接'}
            </button>
            {aiTest && (
              <span className={`settings-hint ${aiTest.success ? '' : 'alert-error'}`} role="status">
                {aiTest.success ? `连通正常（${aiTest.model}，${aiTest.elapsed} ms）` : aiTest.error}
              </span>
            )}
          </div>
        </section>

        <div className="settings-footer" role="group" aria-label="保存设置">
          <span className={`settings-state ${dirty ? 'is-dirty' : ''}`} role="status">
            {saving ? '正在保存…' : dirty ? '有未保存的修改' : saved ? '已保存' : '当前显示的都是已保存的设置'}
          </span>
          <button className="btn btn-outline" onClick={loadSettings} disabled={!dirty || saving}>
            还原
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? (
              '正在保存…'
            ) : saved && !dirty ? (
              <>
                <Check size={16} /> 已保存
              </>
            ) : (
              '保存设置'
            )}
          </button>
        </div>
        {saveError && !proxyOpen && (
          <p className="alert alert-error" role="alert">
            {saveError}
          </p>
        )}
      </fieldset>

      {proxyOpen && proxyDraft && (
        <div className="proxy-modal-mask" onClick={() => !saving && closeProxy()}>
          <div
            className="proxy-modal"
            role="dialog"
            aria-modal="true"
            aria-label="网络代理设置"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="proxy-modal-head">
              <div className="proxy-modal-title">
                <Globe size={18} />
                <span>网络代理设置</span>
              </div>
              <button className="icon-btn" title="关闭" disabled={saving} onClick={closeProxy}>
                <X size={16} />
              </button>
            </div>

            <fieldset className="proxy-modal-body" disabled={saving}>
              <label className="proxy-switch-row">
                <input
                  type="checkbox"
                  checked={proxyDraft.proxy_enabled}
                  onChange={(e) => patchDraft('proxy_enabled', e.target.checked)}
                />
                <span className="proxy-switch-text">
                  启用代理
                  <em>关闭时代理不生效，所有请求直连</em>
                </span>
              </label>

              <div className={`proxy-fields ${proxyDraft.proxy_enabled ? '' : 'proxy-fields-disabled'}`}>
                <div className="settings-group">
                  <label className="settings-label">代理模式</label>
                  <div className="proxy-mode-list">
                    {PROXY_MODES.map((m) => (
                      <label key={m.value} className={`proxy-mode-item ${mode === m.value ? 'active' : ''}`}>
                        <input
                          type="radio"
                          name="proxy_mode"
                          value={m.value}
                          checked={mode === m.value}
                          disabled={!proxyDraft.proxy_enabled}
                          onChange={() => patchDraft('proxy_mode', m.value)}
                        />
                        <span className="proxy-mode-body">
                          <b>{m.label}</b>
                          <em>{m.desc}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">代理地址</label>
                    <div className="proxy-host-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label="代理服务器地址"
                        placeholder="127.0.0.1"
                        value={proxyDraft.proxy_host}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_host', e.target.value)}
                      />
                      <span className="proxy-colon">:</span>
                      <input
                        type="number"
                        className="input-field proxy-port"
                        aria-label="代理端口"
                        placeholder="7890"
                        min="1"
                        max="65535"
                        value={proxyDraft.proxy_port}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_port', e.target.value)}
                      />
                    </div>
                    <div className="preset-row mt8">
                      {PORT_PRESETS.map((p) => (
                        <button
                          key={p.port}
                          type="button"
                          className="btn-chip"
                          disabled={!proxyDraft.proxy_enabled}
                          onClick={() => patchDraft('proxy_port', p.port)}
                        >
                          {p.label} {p.port}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">代理认证（可选）</label>
                    <div className="proxy-auth-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label="代理用户名"
                        placeholder="用户名"
                        autoComplete="off"
                        value={proxyDraft.proxy_username}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_username', e.target.value)}
                      />
                      <input
                        type="password"
                        className="input-field"
                        aria-label="代理密码"
                        placeholder="密码"
                        autoComplete="new-password"
                        value={proxyDraft.proxy_password}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_password', e.target.value)}
                      />
                    </div>
                    <p className="settings-hint">代理无需认证时留空即可</p>
                  </div>
                )}
              </div>

              {testResult && (
                <div className={`proxy-test-result ${testResult.success ? 'ok' : 'fail'}`}>
                  {testResult.success ? <Check size={15} /> : <AlertCircle size={15} />}
                  <span>
                    {testResult.success ? testResult.message : testResult.error}
                    {testResult.success && testResult.via ? ` · 经由 ${testResult.via}` : ''}
                  </span>
                </div>
              )}
              {saveError && (
                <p className="alert alert-error" role="alert">
                  {saveError}
                </p>
              )}
            </fieldset>

            <div className="proxy-modal-foot">
              <button className="btn btn-outline" onClick={runTest} disabled={testing || saving}>
                <RefreshCw size={15} />
                {testing ? '测试中...' : '测试连接'}
              </button>
              <div className="proxy-foot-right">
                <button className="btn btn-outline" disabled={saving} onClick={closeProxy}>
                  取消
                </button>
                <button className="btn btn-primary" disabled={saving} onClick={applyProxy}>
                  <Check size={15} />
                  {saving ? '正在保存…' : '保存并生效'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsPage;
