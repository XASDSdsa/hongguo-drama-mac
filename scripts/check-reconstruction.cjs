'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emptyManifest, validateManifest, writeManifestAtomic, readManifest } = require('../src/native/reconstruction-manifest');
const { buildShotsFromCuts } = require('../src/native/adaptive-detector');
const { rebuildTimeline, mergeShotResults, createReconstructionPipeline } = require('../src/native/reconstruction-pipeline');
const { frameToUs, usToFrame } = require('../src/native/reconstruction-media');
const { requiredConfig } = require('../src/native/qwen-omni');

(async () => {
  const media = { original_file: '/tmp/input.mp4', working_file: '/tmp/input.mp4', width: 1080, height: 1920, fps_num: 25, fps_den: 1, total_frames: 100, duration_us: 4_000_000, has_audio: true, normalized: false };
  const manifest = emptyManifest({ projectId: 'check', media });
  manifest.shots = buildShotsFromCuts(media, [{ frame: 40, score: 1.2 }, { frame: 70, score: 1.1 }]);
  for (const shot of manifest.shots) {
    shot.start_us = frameToUs(shot.start_frame, 25, 1);
    shot.end_us = frameToUs(shot.end_frame_exclusive, 25, 1);
    shot.duration_us = shot.end_us - shot.start_us;
  }
  // Regression: a non-empty subtitle_ids response must be filtered against the
  // manifest without triggering a temporal-dead-zone self-reference.
  manifest.subtitle_cues = [{ subtitle_id: 'subtitle_001', start_us: 100_000, end_us: 200_000, shot_ids: [manifest.shots[0].shot_id] }];
  mergeShotResults(manifest, [{ shot_id: manifest.shots[0].shot_id, subtitle_ids: ['subtitle_001', 'subtitle_missing'], action_beats: [] }]);
  assert.deepEqual(manifest.shots[0].subtitle_ids, ['subtitle_001']);
  manifest.generation_tasks = manifest.shots.map(shot => ({
    task_id: `task_${shot.shot_id}`,
    shot_ids: [shot.shot_id],
    prompt_text: '测试提示词',
    prompt_parts: { subject: '角色', environment: '场景', composition: '中景', action_sequence: '动作', camera: '固定', dialogue: '无对白', audio: '环境声', style: '二维', continuity: '连续', exclusions: '无字幕', timeline: [{ start_us: 0, end_us: shot.duration_us, description: '镜头内连续动作' }] },
    target_duration_us: shot.duration_us,
    provenance: 'inferred_plan',
    execution: null,
    status: 'needs_review',
  }));
  let check = validateManifest(manifest, { checkFiles: false });
  assert.equal(check.valid, true, check.errors.join('\n'));
  assert.equal(usToFrame(frameToUs(40, 25, 1), 25, 1), 40);
  manifest.assets.push(...manifest.shots.map(shot => ({ asset_id: `asset_${shot.shot_id}`, status: 'ready', path: '/tmp/not-created', used_by_ids: [shot.shot_id] })));
  manifest.shots.forEach(shot => { shot.clip_asset_id = `asset_${shot.shot_id}`; });
  rebuildTimeline(manifest);
  assert.equal(manifest.timeline.video.clips.length, manifest.shots.length);
  check = validateManifest(manifest, { checkFiles: false });
  assert.equal(check.valid, true, check.errors.join('\n'));
  manifest.shots[1].start_frame = 41;
  check = validateManifest(manifest, { checkFiles: false });
  assert.equal(check.valid, false);
  assert.match(check.errors.join('\n'), /缺口或重叠/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-reconstruction-'));
  const file = path.join(dir, 'episode-manifest.json');
  const result = await writeManifestAtomic(file, emptyManifest({ projectId: 'atomic', media }), { checkFiles: false });
  assert.equal(result.manifest.project_id, 'atomic');
  assert.equal((await readManifest(file)).schema_version, '2.0');
  assert.throws(() => requiredConfig({ qwen_api_key: 'x' }), /接口地址/);
  const pipeline = createReconstructionPipeline({ getSettings: () => ({}) });
  assert.deepEqual(await pipeline.start({}), { success: false, error: '请选择已去重的视频' });
  const gated = createReconstructionPipeline({ getSettings: () => ({}), isDedupedInput: async () => false });
  assert.equal((await gated.start({ inputPath: __filename })).error, '该视频没有已完成去重标记；请先在视频处理完成去重，再进入 AI 漫剧重建');
  const persistedPath = path.join(dir, 'persisted', 'episode-manifest.json');
  const persisted = emptyManifest({ projectId: 'persisted', media });
  persisted.pipeline.stages.manifest_validation.status = 'succeeded';
  persisted.pipeline.stages.html_export.status = 'succeeded';
  await writeManifestAtomic(persistedPath, persisted, { checkFiles: false });
  const persistedPipeline = createReconstructionPipeline({ getSettings: () => ({}), getProjectRecord: () => ({ manifestPath: persistedPath }) });
  assert.equal(persistedPipeline.status('persisted').status, 'partial');
  console.log('reconstruction checks passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
