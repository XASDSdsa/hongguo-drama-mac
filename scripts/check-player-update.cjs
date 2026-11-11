'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function verifyPlayerUpdate(stage, unpacked, scratch) {
  assert.equal(process.platform, 'win32');
  const install = path.join(scratch, '安装与回滚测试');
  fs.cpSync(unpacked, install, { recursive: true });
  fs.rmSync(path.join(install, 'resources/hongguo-player'), { recursive: true, force: true });
  const archive = path.join(install, 'resources/app.asar');
  fs.writeFileSync(archive, 'previous archive');
  const before = sha(archive);
  const injected = path.join(stage, 'update-failure-test.ps1');
  const script = fs.readFileSync(path.join(stage, 'update.ps1'), 'utf8');
  assert.ok(script.includes('$replaced += $name'));
  fs.writeFileSync(injected, script.replace('$replaced += $name', "$replaced += $name\n        if ($replaced.Count -eq 3) { throw 'Injected copy failure' }"));
  let rolledBack = false;
  try { execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', injected, '-InstallDir', install], { stdio: 'pipe', timeout: 60000 }); }
  catch (error) {
    assert.match(String(error.stdout), /Injected copy failure/, 'the test must reach the intentional mid-copy failure');
    rolledBack = true;
  }
  finally { fs.unlinkSync(injected); }
  assert.ok(rolledBack, 'injected failure must stop the update');
  assert.equal(sha(archive), before, 'old archive restored');
  assert.equal(fs.existsSync(path.join(install, 'resources/hongguo-player/player.jar')), false);
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(stage, 'update.ps1'), '-InstallDir', install], { stdio: 'inherit', timeout: 90000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json')));
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    const target = name === 'app.asar' ? path.join(install, 'resources', name)
      : name.startsWith('hongguo-player/') ? path.join(install, 'resources', name) : path.join(install, name);
    assert.equal(sha(target), expected, name);
  }
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(stage, 'update.ps1'), '-InstallDir', install], { stdio: 'pipe', timeout: 90000 });
  const java = path.join(install, 'resources/hongguo-player/runtime/bin/java.exe');
  execFileSync(java, ['-version'], { stdio: 'pipe', timeout: 20000 });
  console.log('PASS real Windows update in a Chinese path: rollback restores old files; successful update and repeat installation verify the native runtime');
}
module.exports = { verifyPlayerUpdate };
