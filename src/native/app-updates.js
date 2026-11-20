'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const UPDATE_URL = 'https://license.91.200.243.95.sslip.io/updates/windows/';

function createAppUpdates({ app, updater, notify = () => {}, busy = () => false, platform = process.platform, installDir }) {
  const supported = platform === 'win32' && app.isPackaged;
  let state = { status: supported ? 'idle' : 'unsupported', currentVersion: app.getVersion(), version: '', percent: 0, error: '', notes: '' };
  let checking = null;
  let downloading = null;
  let installing = false;
  let revalidating = false;
  const snapshot = () => ({ ...state });
  const change = next => { state = { ...state, ...next }; notify(snapshot()); };
  const failed = error => change({ status: 'error', error: error?.message || String(error) });
  const result = () => ({ success: true, state: snapshot() });

  if (supported) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    if (installDir) updater.installDirectory = installDir;
    updater.logger = console;
    updater.on('checking-for-update', () => { if (!revalidating) change({ status: 'checking', error: '' }); });
    updater.on('update-available', info => {
      if (revalidating) return;
      const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : '';
      change({ status: 'available', version: info.version, notes, percent: 0, error: '' });
    });
    updater.on('update-not-available', () => { if (!revalidating) change({ status: 'current', version: '', notes: '', error: '' }); });
    updater.on('download-progress', progress => change({ status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)) }));
    updater.on('update-downloaded', info => change({ status: 'ready', version: info.version, percent: 100, error: '' }));
    updater.on('error', error => { if (!revalidating) failed(error); });
  }

  async function check() {
    if (!supported || installing || downloading || state.status === 'ready') return result();
    if (!checking) {
      checking = (async () => {
        try { await updater.checkForUpdates(); return result(); }
        catch (error) { failed(error); return { success: false, error: state.error, state: snapshot() }; }
        finally { checking = null; }
      })();
    }
    return checking;
  }

  async function download() {
    if (!supported) return { success: false, error: '当前平台暂不支持应用内更新' };
    if (downloading) return downloading;
    if (state.status === 'ready' || installing) return result();
    if (!state.version || !['available', 'error'].includes(state.status)) return { success: false, error: '请先检查更新' };
    downloading = (async () => {
      try {
        change({ status: 'downloading', percent: 0, error: '' });
        await updater.downloadUpdate();
        return result();
      } catch (error) {
        failed(error);
        return { success: false, error: state.error, state: snapshot() };
      } finally { downloading = null; }
    })();
    return downloading;
  }

  async function install() {
    if (installing) return result();
    if (!supported || state.status !== 'ready') return { success: false, error: '请先下载完整更新' };
    if (busy()) return { success: false, error: '还有下载或处理任务正在运行，请等任务完成后再重启更新' };
    installing = true;
    revalidating = true;
    try {
      // Recheck the feed so an administrator can withdraw a downloaded release.
      const latest = await updater.checkForUpdates();
      if (!latest || latest.updateInfo?.version !== state.version) {
        change({ status: 'idle', version: '', error: '这个更新已撤回或有更新版本，请重新检查更新' });
        return { success: false, error: state.error, state: snapshot() };
      }
      const expected = latest.updateInfo.files?.find(file => String(file.url).endsWith('.exe'))?.sha512;
      if (!expected || !updater.installerPath) throw new Error('下载的更新不完整，请重新下载');
      const hash = createHash('sha512');
      for await (const chunk of fs.createReadStream(updater.installerPath)) hash.update(chunk);
      if (hash.digest('base64') !== expected) {
        change({ status: 'available', error: '更新文件校验失败，请重新下载更新' });
        return { success: false, error: state.error, state: snapshot() };
      }
      if (busy()) return { success: false, error: '任务正在运行，请等任务完成后再重启更新' };
      change({ status: 'installing', error: '' });
      updater.quitAndInstall(true, true);
      return result();
    } catch (error) {
      change({ status: 'ready', error: `暂时无法验证更新，未安装：${error?.message || error}` });
      return { success: false, error: state.error, state: snapshot() };
    } finally {
      revalidating = false;
      if (state.status !== 'installing') installing = false;
    }
  }
  return { snapshot, check, download, install };
}

module.exports = { createAppUpdates, UPDATE_URL };
