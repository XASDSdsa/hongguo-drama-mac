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
  const testVersion = useRef(0);
  const savingRef = useRef(false);
  const savedTimer = useRef(null);

  const loadSettings = async () => {
    setLoadError('');
    try {
      const next = await window.electronAPI.getSettings();
      setSettings(next);
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

  const selectFolder = async () => {
    try {
      const dir = await window.electronAPI.selectFolder();
      if (dir) update('root', dir);
    } catch (error) {
      setSaveError(error.message || '文件夹选择失败，请重试');
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
        'name_format',
        'max_concurrent',
        'proxy_enabled',
        'proxy_mode',
        'proxy_host',
        'proxy_port',
        'proxy_username',
        'proxy_password',
        'ai_base_url',
        'ai_api_key',
        'ai_image_model',
        'ai_text_model',
        'ai_transcription_model',
        'ai_transcription_engine',
        'whisper_binary_path',
        'whisper_model_path',
        'whisper_language',
        'whisper_threads',
        'faster_whisper_python_path',
        'faster_whisper_script_path',
        'faster_whisper_model',
        'faster_whisper_device',
        'faster_whisper_compute_type',
        'faster_whisper_concurrency',
        'ai_concurrency',
        'structure_threads',
        'structure_device',
        'structure_sherpa_provider',
        'structure_clip_audio',
        'structure_punctuation_model',
        'jianying_python_path',
        'jianying_user_data_path',
        'workflow_require_dedup',
        'workflow_validate_draft',
      ];
      const submitted = { ...current };
      for (const key of editable) if (Object.hasOwn(next, key)) submitted[key] = next[key];
      const res = await window.electronAPI.saveSettings(submitted);
      if (!res?.success) throw new Error(res?.error || '设置未保存，请重试');
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
          <p className="page-description">让下载、保存和网络连接，按你的习惯运行。</p>
        </div>
      </div>

      <fieldset className="settings-card" disabled={saving}>
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
            <button className="btn btn-outline" onClick={selectFolder}>
              <Folder size={16} />
              选择文件夹
            </button>
          </div>
          <p className="settings-hint">
            文件将保存到 <code>下载目录/红果短剧/剧名/</code> 下
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
            className="input-field mt8"
            aria-label="文件命名规则"
            value={settings.name_format || ''}
            onChange={(e) => update('name_format', e.target.value)}
          />
          <p className="settings-hint">
            可用变量：<code>剧名</code> · <code>集数</code>（如 001）· <code>标题</code>
            。每集保留独立集号，避免同名覆盖。
          </p>
        </div>

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
          <p className="settings-hint">
            同时下载 <b>{settings.max_concurrent || 3}</b> 集（保存后立即生效）。 并发越高越快，但可能触发接口限流，建议
            3~5。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">完整字幕识别（faster-whisper）</label>
          <p className="settings-hint">已内置字幕引擎和 tiny 模型，无需安装 Python，离线即可识别。</p>
          <div className="preset-row mt8">
            <select
              className="input-field select-field"
              aria-label="faster-whisper 设备"
              value={settings.faster_whisper_device || 'auto'}
              onChange={(e) => update('faster_whisper_device', e.target.value)}
            >
              <option value="auto">自动检测（批次固定）</option>
              <option value="cpu">CPU</option>
              <option value="cuda">CUDA（未检测到时直接报错）</option>
            </select>
            <select
              className="input-field select-field"
              aria-label="字幕识别并发数"
              value={settings.faster_whisper_concurrency || 2}
              onChange={(e) => update('faster_whisper_concurrency', Number(e.target.value))}
            >
              {[1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value} 集并发
                </option>
              ))}
            </select>
          </div>
          <p className="settings-hint">
            只读取已去重视频，每批开始时固定处理设备。识别完成后，每集完整字幕保存在该剧目录的 <code>transcripts/</code>
            。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">视频结构化拆解（本地）</label>
          <p className="settings-hint">
            TransNet V2 分镜、FFmpeg 切片、sherpa-onnx 分离和 Paraformer 识别。第一版一次处理一集，重模型顺序运行。
          </p>
          <div className="settings-grid mt8">
            <label className="settings-field">
              <span>处理线程数（0 = 自动）</span>
              <input
                className="input-field"
                type="number"
                min="0"
                max="32"
                value={settings.structure_threads ?? 0}
                onChange={(e) => update('structure_threads', Number(e.target.value))}
              />
            </label>
            <label className="settings-field">
              <span>已确认分镜算法</span>
              <input className="input-field" readOnly value="单路 0.5 · 时间结构复核 · 最短 2 秒" />
            </label>
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
              <span>分离 / 识别设备</span>
              <select className="input-field" value="cpu" onChange={() => update('structure_sherpa_provider', 'cpu')}>
                <option value="cpu">CPU（本版内置，支持线程设置）</option>
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
            <label className="settings-field">
              <span>标点模型（可选覆盖）</span>
              <input
                className="input-field"
                value={settings.structure_punctuation_model || ''}
                onChange={(e) => update('structure_punctuation_model', e.target.value)}
                placeholder="留空使用内置中文标点模型"
              />
            </label>
          </div>
          <p className="settings-hint">
            设备在运行前固定，不自动切换。安装包使用内置工具。修改参数后，重跑会使受影响的下游结果失效。
          </p>
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
            本机有代理（Clash / V2rayN 等）时在这里填上，解析剧集与下载视频都会走该代理。保存后立即生效，无需重启。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">整集工作流</label>
          <p className="settings-hint">
            工作流按每集独立记录：输入 → 结构化拆解 → 剪映草稿。这里控制两个阶段门禁，不把规则固定在程序里。
          </p>
          <label className="proxy-switch-row">
            <input
              type="checkbox"
              checked={settings.workflow_require_dedup !== false}
              onChange={(e) => update('workflow_require_dedup', e.target.checked)}
            />
            <span className="proxy-switch-text">
              要求去重结果作为输入<em>关闭后允许使用已下载原视频进入结构化</em>
            </span>
          </label>
          <label className="proxy-switch-row">
            <input
              type="checkbox"
              checked={settings.workflow_validate_draft !== false}
              onChange={(e) => update('workflow_validate_draft', e.target.checked)}
            />
            <span className="proxy-switch-text">
              生成后校验剪映草稿<em>关闭后只检查生成进程，不运行结构校验器</em>
            </span>
          </label>
          <div className="settings-grid mt8">
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
              <span>剪映 User Data（可选）</span>
              <input
                className="input-field"
                value={settings.jianying_user_data_path || ''}
                onChange={(e) => update('jianying_user_data_path', e.target.value)}
                placeholder="留空使用默认目录"
              />
            </label>
          </div>
        </div>

        <div className="settings-footer">
          {dirty && (
            <span className="settings-hint" role="status">
              有未保存的修改
            </span>
          )}
          <button className="btn btn-primary" onClick={save}>
            {saving ? (
              '正在保存…'
            ) : saved ? (
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
