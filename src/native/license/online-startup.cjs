'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, ipcMain, net, safeStorage } = require('electron');
const { checkOnlineLicense } = require('./keygate.cjs');

async function authorizeOnlineStartup({ app, config, identifier, onActivationReady }) {
  if (!/^https:\/\//.test(config.endpoint) || !/^[0-9a-f]{64}$/.test(config.publicKey) || !config.productId) {
    throw new Error('联网授权配置无效');
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，请用平时的系统账号重新打开软件。');
  const file = path.join(app.getPath('userData'), 'online-license.key');
  const saved = await fs.readFile(file).then((data) => safeStorage.decryptString(data)).catch(() => '');
  const check = (key, activate) => checkOnlineLicense(config, {
    key, identifier, activate, fetcher: (...args) => net.fetch(...args),
  });
  const message = saved ? await check(saved, false) : '';
  if (saved && !message) return true;

  const window = new BrowserWindow({
    title: '激活 changeFileName',
    width: 470, height: 365, resizable: false, maximizable: false,
    autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'activation-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  return new Promise((resolve, reject) => {
    let authorized = false;
    let checking = false;
    ipcMain.handle('online-license:activate', async (event, input) => {
      if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        return '激活窗口已关闭。';
      }
      if (checking) return '正在验证，请稍等。';
      if (typeof input !== 'string' || input.length > 160) return '请输入完整的激活码。';
      const entered = input.trim();
      const key = entered || saved;
      if (!key) return '请先粘贴管理员发给你的激活码。';
      checking = true;
      try {
        const error = await check(key, Boolean(entered));
        if (error || window.isDestroyed()) return error;
        if (entered) {
          const temp = file + '.' + randomUUID() + '.tmp';
          try {
            await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await fs.writeFile(temp, safeStorage.encryptString(key), { flag: 'wx', mode: 0o600 });
            await fs.rename(temp, file);
          } finally {
            await fs.rm(temp, { force: true }).catch(() => {});
          }
        }
        authorized = true;
        setImmediate(() => { if (!window.isDestroyed()) window.destroy(); });
        return '';
      } catch {
        return '无法保存授权，请检查这台电脑的存储权限后重试。';
      } finally {
        checking = false;
      }
    });
    window.once('closed', () => {
      ipcMain.removeHandler('online-license:activate');
      resolve(authorized);
    });
    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return;
      window.show();
      onActivationReady?.();
    });
    window.loadFile(path.join(__dirname, 'activation.html'), { query: { message, saved: saved ? '1' : '' } }).catch((error) => {
      reject(error);
      if (!window.isDestroyed()) window.destroy();
    });
  });
}

module.exports = { authorizeOnlineStartup };
