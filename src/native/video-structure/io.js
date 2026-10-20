'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const readline = require('node:readline');
const fsp = fs.promises;
async function json(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}
/** 改名遇到 Windows 杀毒软件短暂占用（EPERM/EBUSY/EACCES）时稍等重试。 */
async function renameRetry(from, to) {
  const waits = [100, 250, 500, 1000, 2000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      if (attempt >= waits.length || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  }
}
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await renameRetry(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}
async function sha256(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
function run(exe, args, { signal, onLine, onStderrLine, cwd, onProgress, duration, killProcessTree = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('任务已停止'), { code: 'ABORT_ERR' }));
    const processGroup = killProcessTree && process.platform !== 'win32';
    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      // 内置的 Python 运行时（剪映草稿、结构化拆解）在中文 Windows 上默认按 GBK 输出，
      // 而这里按 UTF-8 读：路径里的「剪映草稿」会变成乱码，草稿明明写好了却报失败。统一要求 UTF-8。
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      detached: processGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timer,
      lineError,
      stderrLines,
      stopping = false,
      treeStopped;
    const terminate = (signalName) => {
      try {
        if (processGroup && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch (error) {
        if (error.code !== 'ESRCH') lineError ||= error;
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (killProcessTree && process.platform === 'win32' && child.pid) {
        // taskkill must see the live parent to discover its descendants.
        treeStopped = new Promise((resolve) => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('error', (error) => {
            lineError ||= error;
            child.kill();
            resolve();
          });
          killer.once('close', (code) => {
            if (code !== 0) child.kill();
            resolve();
          });
        });
        return;
      }
      terminate('SIGTERM');
      timer = setTimeout(() => terminate('SIGKILL'), 3000);
      timer.unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });
    // Some native tools report meaningful stage transitions on stderr rather
    // than stdout. Keep the existing bounded stderr capture while optionally
    // exposing complete lines to the caller (for example, sherpa's Started /
    // Done / Saved messages). Do not turn arbitrary stderr text into a
    // percentage: callers must provide an explicit stage mapping.
    if (onStderrLine) {
      stderrLines = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      stderrLines.on('line', (line) => {
        try {
          onStderrLine(line);
        } catch (error) {
          lineError = error;
          stop();
        }
      });
    }
    if (onLine || onProgress) {
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        try {
          onLine?.(line);
          if (line.startsWith('out_time_us=') && duration > 0)
            onProgress?.({ progress: Math.min(99, (Number(line.split('=')[1]) / 1000000 / duration) * 100) });
          if (/^\{"type":\s*"progress"/.test(line) && onProgress) {
            const event = JSON.parse(line);
            onProgress(event);
          }
        } catch (error) {
          lineError = error;
          stop();
        }
      });
    } else
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 32 * 1024 * 1024) {
          lineError = new Error('工具输出超过限制');
          stop();
        }
      });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.once('close', async (code) => {
      // A parent can exit while a child ignores SIGTERM and has no inherited
      // output pipe. Finish its isolated group before clearing escalation.
      if (processGroup && stopping) terminate('SIGKILL');
      if (treeStopped) await treeStopped;
      clearTimeout(timer);
      stderrLines?.close();
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(Object.assign(new Error('任务已停止'), { code: 'ABORT_ERR' }));
      else if (lineError) reject(lineError);
      else if (code !== 0) reject(toolError(exe, code, stderr));
      else resolve({ stdout, stderr });
    });
  });
}
/**
 * 工具失败时把最后几行（真正的报错一般在最后）放在最前面：日志只显示开头一段，
 * 以前开头是工具回显的整条命令，真正的原因被截掉了。完整输出接在后面，排查时还能看到。
 * Windows 上的 -1 会显示成 4294967295，换回 -1。
 */
function toolError(exe, code, stderr = '') {
  const signed = Number.isInteger(code) && code > 0x7fffffff ? code - 0x100000000 : code;
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-3).join(' | ');
  const error = new Error(
    `${path.basename(exe)} 退出码 ${signed}：${tail || '没有输出'}${lines.length > 3 ? `\n完整输出：\n${String(stderr).slice(-6000)}` : ''}`,
  );
  error.exitCode = signed;
  error.stderr = String(stderr);
  return error;
}
async function probe(ffprobe, input, args = [], options = {}) {
  const result = await run(ffprobe, ['-v', 'error', ...args, '-of', 'json', input], { signal: options.signal });
  return JSON.parse(result.stdout);
}
function blocked(message) {
  return Object.assign(new Error(message), { code: 'DEPENDENCY_MISSING' });
}
module.exports = {
  toolError,
  json,
  atomicJson,
  sha256,
  run,
  probe,
  blocked,
  renameRetry,
};
