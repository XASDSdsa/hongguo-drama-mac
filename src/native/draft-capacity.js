'use strict';
// 剪映草稿同时做几集、每集几个线程。
//
// 苹果芯片的 Mac 有性能核和能效核，os.cpus() 两种一起算：8 核的 M1 / M2 / M3（4 性能 + 4 能效）以前被当成
// 8 个核，算出「同时 3 集、每集 2 线程」——检测分镜和人声分离都是重 CPU 的活，分到能效核上、几路抢内存带宽，
// 实测一集检测分镜从 16 秒（一次一集、4 线程）变成 75 秒，三集并行加起来反而比一集一集做还慢。
// 所以 Mac 只按性能核算，而且每集至少 4 线程：4 个性能核的 Mac 一次做一集，8 个以上性能核才两集并行。
// Windows / Linux 的核基本一样快，维持原来的算法（留两个核给系统和界面，最多 8 线程，每集至少 2 线程）。
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let perfCoresCache;

/** Mac 的性能核个数（苹果芯片）；Intel Mac 用物理核数；读不到返回 0。 */
function macPerformanceCores() {
  if (perfCoresCache !== undefined) return perfCoresCache;
  perfCoresCache = 0;
  for (const key of ['hw.perflevel0.physicalcpu', 'hw.physicalcpu']) {
    try {
      const value = Number(execFileSync('sysctl', ['-n', key], { encoding: 'utf8', timeout: 2000 }).trim());
      if (Number.isInteger(value) && value > 0) {
        perfCoresCache = value;
        break;
      }
    } catch (_) {}
  }
  return perfCoresCache;
}

/**
 * @returns {{ budget: number, minThreads: number }} 草稿分析总共可用的线程数，和每集最少分到几个线程
 */
function draftCapacity({
  platform = process.platform,
  cores = os.availableParallelism?.() || os.cpus().length || 1,
  perfCores = platform === 'darwin' ? macPerformanceCores() : 0,
  configuredThreads = 0,
} = {}) {
  const configured = Number(configuredThreads) || 0;
  if (platform === 'darwin') {
    const fast = perfCores > 0 ? perfCores : Math.max(1, Math.floor(cores / 2));
    return { budget: configured > 0 ? configured : Math.max(2, Math.min(12, fast)), minThreads: 4 };
  }
  return { budget: configured > 0 ? configured : Math.max(2, Math.min(8, cores - 2)), minThreads: 2 };
}

module.exports = { draftCapacity, macPerformanceCores };
