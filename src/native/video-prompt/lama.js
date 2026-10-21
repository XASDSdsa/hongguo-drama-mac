'use strict';
// LaMa 补图（big-lama）：分镜工程图四宫格关键帧去字幕用。在本机跑，不联网、不花钱、不用 Key；
// 模型和 torch 都在内置的结构化分析运行时里（structure-worker inpaint）。
// 一个常驻的子进程：模型只加载一次，之后每张关键帧发一行任务、等一行回复；一次只做一张（CPU 已经吃满），
// 空闲一会儿自动退出，省内存。进程坏了下次用时重新拉起来。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

// 权重存成 float16（安装包小一半），加载时转回 float32 算
const MODEL_FILE = 'big-lama-fp16.pt';

// 任务行只用 ASCII（中文路径写成 \uXXXX）：Windows 上不管控制台是什么编码都不会读错
const asciiJson = (value) =>
  JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * command / prefix：运行时程序（打包后是 structure-worker，开发时是 python + runner.py）；model：big-lama.pt。
 * 返回 { start(), inpaint({ data, width, height, mask, signal }) → { data, seconds }, close() }。
 */
function createLamaWorker({
  command,
  prefix = [],
  model,
  threads = 4,
  idleMs = 60_000,
  startTimeoutMs = 180_000,
  jobTimeoutMs = 120_000,
  tempRoot = os.tmpdir(),
}) {
  let child = null;
  let ready = null;
  let tail = '';
  let nextId = 1;
  let idleTimer = null;
  let queue = Promise.resolve();
  let tempDir = null;
  const pending = new Map();

  function failAll(error) {
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  }

  function stop() {
    const proc = child;
    child = null;
    ready = null;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch (_) {}
    // 正常情况下关掉输入它自己就退出；两秒还没退就强制结束
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch (_) {}
    }, 2000);
    timer.unref?.();
    proc.once('exit', () => clearTimeout(timer));
  }

  function start() {
    if (ready) return ready;
    if (!command || !fs.existsSync(command)) return Promise.reject(new Error('内置分析运行时没装上（需要完整安装包）'));
    if (!model || !fs.existsSync(model)) return Promise.reject(new Error('LaMa 补图模型没装上（需要完整安装包）'));
    tail = '';
    const proc = spawn(command, [...prefix, 'inpaint', '--model', model, '--threads', String(threads)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    child = proc;
    const current = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`LaMa 补图模型 ${Math.round(startTimeoutMs / 1000)} 秒还没加载好（可能正被杀毒软件扫描）`));
        if (child === proc) stop();
      }, startTimeoutMs);
      const ended = (error) => {
        clearTimeout(timer);
        reject(error);
        failAll(error);
        if (child === proc) {
          child = null;
          ready = null;
        }
      };
      proc.on('error', (error) => ended(new Error(`LaMa 补图进程启动不了：${error.message}`)));
      proc.on('exit', (code, sig) => {
        const last = tail.trim().split(/\r?\n/).slice(-2).join(' ').slice(-300);
        ended(new Error(`LaMa 补图进程退出了（${code ?? sig}）${last ? `：${last}` : ''}`));
      });
      proc.stdin.on('error', () => {}); // 进程退出时写不进去：由 exit 统一报错
      proc.stderr.on('data', (chunk) => {
        tail = (tail + chunk.toString('utf8')).slice(-2000);
      });
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch (_) {
          return; // 不是回复（torch 的提示之类）
        }
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve(message);
          return;
        }
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id);
        if (message.type === 'done') job.resolve(message);
        else job.reject(new Error(message.message || 'LaMa 补图失败'));
      });
    });
    ready = current;
    current.catch(() => {});
    return current;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!pending.size) stop();
    }, idleMs);
    idleTimer.unref?.();
  }

  async function run({ data, width, height, mask, signal }) {
    signal?.throwIfAborted?.();
    if (data.length !== width * height * 3 || mask.length !== width * height) throw new Error('补图输入尺寸不对');
    clearTimeout(idleTimer);
    await start();
    tempDir ||= await fsp.mkdtemp(path.join(tempRoot, 'hongguo-lama-'));
    const id = nextId++;
    const files = ['in.rgb', 'mask.bin', 'out.rgb'].map((name) => path.join(tempDir, `${id}-${name}`));
    try {
      await fsp.writeFile(files[0], data);
      await fsp.writeFile(files[1], mask);
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`LaMa 补一张图超过 ${Math.round(jobTimeoutMs / 1000)} 秒`));
          stop(); // 卡住了：下次重新拉起
        }, jobTimeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          pending.delete(id);
          reject(signal.reason || new Error('已停止'));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        const done = (fn) => (value) => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          fn(value);
        };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        if (!child) {
          const entry = pending.get(id);
          pending.delete(id);
          return entry.reject(new Error('LaMa 补图进程不在了'));
        }
        child.stdin.write(`${asciiJson({ id, input: files[0], mask: files[1], output: files[2], width, height })}\n`);
      });
      const out = await fsp.readFile(files[2]);
      if (out.length !== width * height * 3) throw new Error('LaMa 补图输出尺寸不对');
      return { data: out, seconds: Number(reply.seconds) || 0 };
    } finally {
      await Promise.all(files.map((file) => fsp.rm(file, { force: true }).catch(() => {})));
      armIdle();
    }
  }

  return {
    start,
    /** 一次只做一张：排队。 */
    inpaint(job) {
      const result = queue.then(() => run(job));
      queue = result.catch(() => {});
      return result;
    },
    close() {
      clearTimeout(idleTimer);
      failAll(new Error('LaMa 补图已关闭'));
      stop();
      if (tempDir) fs.rm(tempDir, { recursive: true, force: true }, () => {});
      tempDir = null;
    },
    get running() {
      return !!child;
    },
  };
}

module.exports = { MODEL_FILE, createLamaWorker, asciiJson };
