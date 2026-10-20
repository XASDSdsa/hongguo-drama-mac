'use strict';
// 内置剪映运行时在中文 Windows 上必须按 UTF-8 输出：草稿目录名里有「剪映草稿」，乱码会让应用找不到刚写好的草稿。
// 用法（构建机，运行时已构建好）：node scripts/check-jianying-runtime-utf8.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/native/video-structure/io');

(async () => {
  const name = process.platform === 'win32' ? 'jianying-runtime.exe' : 'jianying-runtime';
  const exe = path.join(__dirname, '..', 'build', 'jianying', `${process.platform}-${process.arch}`, name);
  if (!fs.existsSync(exe)) {
    console.log(`SKIP 没有构建好的剪映运行时：${exe}`);
    return;
  }
  // 模拟用户电脑：没有 PYTHONUTF8 / PYTHONIOENCODING。
  delete process.env.PYTHONUTF8;
  delete process.env.PYTHONIOENCODING;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '剪映运行时-'));
  try {
    const script = path.join(dir, 'probe.py');
    fs.writeFileSync(
      script,
      'import json, sys\nprint(json.dumps({"draft_dir": "一路杀到公路尽头_第001集-剪映草稿-😀"}, ensure_ascii=False))\n',
      'utf8',
    );
    const { stdout } = await run(exe, [script], { cwd: dir, killProcessTree: true });
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    assert.equal(parsed.draft_dir, '一路杀到公路尽头_第001集-剪映草稿-😀');
    console.log('PASS bundled Jianying runtime prints UTF-8 without PYTHONUTF8 set');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
