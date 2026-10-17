'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { run, atomicJson, sha256 } = require('./io');
const { envelope, requireThat } = require('./contracts');

async function createJianyingDraft(ctx, options) {
  const { executable, createScript, checkScript, outputRoot, name, userData, validate = true } = options;
  requireThat(executable && createScript && checkScript, '缺少内置剪映运行时或草稿脚本，请安装完整版本');
  const args = [createScript, ctx.projectDir, '--name', name, '--output-root', outputRoot, '--ffmpeg', ctx.ffmpeg];
  if (userData) args.push('--jianying-user-data', userData);
  const output = [];
  ctx.onProgress?.({ progress: 0, message: '启动内置剪映运行时' });
  await run(executable, args, { signal: ctx.signal, cwd: ctx.projectDir, killProcessTree: true, onProgress: ctx.onProgress, onLine: line => {
    if (!/^\{"type":\s*"progress"/.test(line)) output.push(line);
  } });
  const created = JSON.parse(output.join('\n'));
  requireThat(created.success === true && typeof created.draft_dir === 'string', '剪映草稿没有返回有效输出目录');
  const draftPath = await fs.realpath(path.resolve(outputRoot, name));
  requireThat(await fs.realpath(created.draft_dir) === draftPath, '剪映草稿输出路径不一致');
  if (validate) {
    ctx.onProgress?.({ progress: 97, message: '校验视频、人声、背景声、特效声与字幕时间线' });
    await run(executable, [checkScript, draftPath], { signal: ctx.signal, cwd: ctx.projectDir, killProcessTree: true });
  }
  const controlFiles = [];
  for (const fileName of ['draft_info.json', 'draft_meta_info.json', 'hongguo-draft-manifest.json']) {
    const file = path.join(draftPath, fileName);
    requireThat((await fs.stat(file)).isFile(), `剪映草稿缺少 ${fileName}`);
    controlFiles.push({ path: file, sha256: await sha256(file, ctx.signal) });
  }
  const result = envelope(ctx.taskId, { draft_path: draftPath, validated: validate, control_files: controlFiles, shot_count: created.clip_count, utterance_count: created.subtitle_count });
  await atomicJson(path.join(ctx.dir, 'jianying.json'), result);
  return result;
}

module.exports = { createJianyingDraft };
