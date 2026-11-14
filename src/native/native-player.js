// SPDX-License-Identifier: GPL-3.0-only
// Runs the bundled N3urda/hongguoTV core. URLs and media keys stay in the main process.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function fetchNativePlayUrl(vid) {
  vid = String(vid || '');
  if (!/^\d{1,30}$/.test(vid)) return Promise.reject(new Error('分集编号无效'));
  const platform = `${process.platform}-${process.arch}`;
  const base = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar'))
    ? path.join(process.resourcesPath, 'hongguo-player')
    : path.join(__dirname, '../../build/hongguo-player', platform);
  const java = path.join(base, 'runtime', process.platform === 'win32' ? 'bin/java.exe' : 'Contents/Home/bin/java');
  if (!fs.existsSync(java) || !fs.existsSync(path.join(base, 'player.jar'))) {
    return Promise.reject(Object.assign(new Error('缺少新版取源组件，请安装完整的取源更新包'), { code: 'PLAYER_COMPONENT_MISSING' }));
  }
  const env = { ...process.env };
  for (const key of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) delete env[key];
  const classpath = [path.join(base, 'player.jar'), path.join(base, 'lib', '*')].join(path.delimiter);
  return new Promise((resolve, reject) => {
    execFile(java, ['-Xms16m', '-Xmx96m', '-cp', classpath, 'com.hongguotv.core.DesktopPlayerKt', vid], {
      timeout: 55000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env,
    }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error(error.killed ? '取源请求超时，请重试' : '取源组件运行失败，请重新安装更新包'), { code: error.killed ? 'ETIMEDOUT' : 'PLAYER_COMPONENT_FAILED' }));
      let result;
      try { result = JSON.parse(stdout.trim()); }
      catch (_) { return reject(new Error('取源组件返回数据异常')); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) return reject(new Error('取源组件返回数据异常'));
      if (result.ok !== true) return reject(Object.assign(new Error(result.error || '未取得本集高清片源'), { code: result.code }));
      try {
        const url = new URL(result.url);
        const allowed = ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'];
        if (result.vid !== vid || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
            !allowed.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) throw new Error('片源地址或分集编号校验失败');
        if (!['h264', 'avc', 'avc1', 'hevc', 'h265', 'hvc1', 'hev1', 'bytevc1'].includes(String(result.codec).toLowerCase())) throw new Error('本集没有可用的兼容片源');
        if (result.contentKey != null && !/^[0-9a-f]{32}$/i.test(result.contentKey)) throw new Error('片源解密信息异常');
        if (Number.parseInt(result.quality, 10) < 720 || !/^\d+p$/.test(result.quality)) throw new Error('本集没有可用的高清片源');
        resolve({ url: url.href, contentKey: result.contentKey || null, spadeA: null,
          codec: result.codec === 'bytevc1' ? 'hevc' : result.codec, quality: result.quality, source: 'app',
          userAgent: 'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)',
          referer: 'https://novel.snssdk.com/' });
      } catch (problem) { reject(problem); }
    });
  });
}
module.exports = { fetchNativePlayUrl };
