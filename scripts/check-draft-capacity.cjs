// 剪映草稿同时做几集、每集几个线程。Mac 只按性能核算、每集至少 4 线程（苹果芯片的能效核慢，几路并行反而更慢）；
// Windows 维持原来的算法。
const assert = require('node:assert/strict');
const { draftCapacity } = require('../src/native/draft-capacity');

const lanes = ({ budget, minThreads }) => Math.max(1, Math.min(4, Math.floor(budget / minThreads)));
const each = ({ budget, minThreads }, n) => Math.max(Math.min(minThreads, budget), Math.floor(budget / n));
const plan = (options) => {
  const capacity = draftCapacity(options);
  const n = lanes(capacity);
  return `${n}×${each(capacity, n)}`;
};

// Mac：用户这台 8 核（4 性能 + 4 能效）以前算成 3 集×2 线程，实测更慢；现在一次一集、4 线程。
assert.equal(plan({ platform: 'darwin', cores: 8, perfCores: 4 }), '1×4');
assert.equal(plan({ platform: 'darwin', cores: 10, perfCores: 6 }), '1×6', 'M2 Pro 6P');
assert.equal(plan({ platform: 'darwin', cores: 12, perfCores: 8 }), '2×4', 'M3 Pro / M1 Pro 8P');
assert.equal(plan({ platform: 'darwin', cores: 16, perfCores: 12 }), '3×4', 'M3 Max 12P');
assert.equal(plan({ platform: 'darwin', cores: 8, perfCores: 0 }), '1×4', '读不到性能核时按一半核算');
assert.equal(plan({ platform: 'darwin', cores: 8, perfCores: 4, configuredThreads: 2 }), '1×2', '手动设了 2 线程就用 2');
assert.equal(plan({ platform: 'darwin', cores: 24, perfCores: 16 }), '3×4', '最多 12 线程');
console.log('PASS Mac counts only performance cores, at least 4 threads per episode');

// Windows：和以前一样。
assert.equal(plan({ platform: 'win32', cores: 16 }), '4×2');
assert.equal(plan({ platform: 'win32', cores: 6 }), '2×2');
assert.equal(plan({ platform: 'win32', cores: 4 }), '1×2');
assert.equal(plan({ platform: 'win32', cores: 16, configuredThreads: 12 }), '4×3');
console.log('PASS Windows keeps the old plan (cores − 2, up to 8 threads, 2 per episode)');

// 这台机器上真读一次（Mac 上读 sysctl），不能抛错。
const here = draftCapacity();
assert.ok(here.budget >= 2 && here.minThreads >= 2);
console.log(`PASS this machine (${process.platform}): ${lanes(here)} episodes × ${each(here, lanes(here))} threads`);
