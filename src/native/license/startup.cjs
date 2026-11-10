'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MAX_LICENSE_BYTES, deviceCode, verifyLicense } = require('./signed-license.cjs');
const exec = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function readDeviceCode(platform = process.platform, run = exec) {
  const options = { timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 };
  if (platform === 'win32') {
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)',
      "$guid = $base.OpenSubKey('SOFTWARE\\Microsoft\\Cryptography').GetValue('MachineGuid')",
      '$uuid = (Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID',
      '[Console]::WriteLine([string]$guid)',
      '[Console]::WriteLine([string]$uuid)',
    ].join('; ');
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], options);
    const [guid, uuid = ''] = stdout.trim().toLowerCase().split(/\r?\n/).map((line) => line.trim());
    if (!UUID.test(guid)) throw new Error('无法读取 Windows 设备标识');
    if (uuid && !UUID.test(uuid)) throw new Error('无法读取主板设备标识');
    return deviceCode(platform, [guid, uuid]);
  }
  if (platform === 'darwin') {
    const { stdout } = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options);
    const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1]?.toLowerCase();
    if (!UUID.test(uuid || '')) throw new Error('无法读取 Mac 设备标识');
    return deviceCode(platform, [uuid]);
  }
  throw new Error('这个系统不支持当前的设备授权');
}

async function readLicense(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_LICENSE_BYTES) throw new Error('授权文件无效');
  return fs.readFile(file);
}

/** 在创建主窗口之前校验。未授权时只打开系统授权对话框。 */
async function authorizeStartup({ app, dialog, clipboard, getDeviceCode = readDeviceCode, onActivationReady }) {
  try {
    const online = await fs.readFile(path.join(__dirname, 'online-config.json'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (online !== null) {
      const { authorizeOnlineStartup } = require('./online-startup.cjs');
      return await authorizeOnlineStartup({ app, config: JSON.parse(online), identifier: await getDeviceCode(), onActivationReady });
    }
    const publicKey = await fs.readFile(path.join(__dirname, 'public-key.pem')).catch((error) => {
      // A source checkout without an issuer can still be used for development.
      if (error.code === 'ENOENT' && !app.isPackaged && path.extname(app.getAppPath?.() || '') !== '.asar') return null;
      throw error;
    });
    if (!publicKey) return true;
    const code = await getDeviceCode();
    const target = path.join(app.getPath('userData'), 'device-license.json');
    let error = '';
    try {
      error = verifyLicense(await readLicense(target), code, publicKey);
      if (!error) return true;
    } catch (cause) {
      if (cause.code !== 'ENOENT') error = cause.message;
    }

    while (true) {
      const { response } = await dialog.showMessageBox({
        type: 'info', title: 'changeFileName授权',
        message: error || '请导入这台电脑的授权文件',
        detail: `把下方设备码发给授权管理员，拿到授权文件后导入。\n\n${code}`,
        buttons: ['导入授权', '复制设备码', '退出'],
        defaultId: 0, cancelId: 2, noLink: true,
      });
      if (response === 2) return false;
      if (response === 1) {
        clipboard.writeText(code);
        continue;
      }
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择授权文件', properties: ['openFile'],
        filters: [{ name: '授权文件', extensions: ['json'] }],
      });
      if (canceled || !filePaths[0]) continue;
      try {
        const license = await readLicense(filePaths[0]);
        error = verifyLicense(license, code, publicKey);
        if (error) continue;
        const temp = target + '.' + randomUUID() + '.tmp';
        try {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(temp, license, { mode: 0o600, flag: 'wx' });
          await fs.rename(temp, target);
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        return true;
      } catch (cause) {
        error = cause.message;
      }
    }
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title: 'changeFileName授权', message: '无法验证本机授权', detail: error.message });
    return false;
  }
}

module.exports = { authorizeStartup, readDeviceCode };
