'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = '2.0';
const STAGES = Object.freeze([
  'media_baseline',
  'shot_detection',
  'source_assets',
  'qwen_global',
  'qwen_shots',
  'background_audio',
  'manifest_validation',
  'subtitle_export',
  'html_export',
  'png_export',
  'jianying_draft',
]);

const ACTIVE_STATUSES = new Set(['planned', 'queued', 'running', 'needs_review', 'blocked', 'failed', 'succeeded']);

function now() { return Date.now(); }

function emptyStages() {
  return Object.fromEntries(STAGES.map(stage => [stage, {
    status: 'planned',
    run_id: null,
    input_fingerprint: null,
    config_snapshot: null,
    output_paths: [],
    error: null,
    review_items: [],
    started_at: null,
    finished_at: null,
  }]));
}

function emptyManifest({ projectId, media = null } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: String(projectId || `episode_${crypto.randomUUID()}`),
    media: media || null,
    styles: [],
    characters: [],
    scenes: [],
    assets: [],
    shots: [],
    subtitle_cues: [],
    audio_events: [],
    generation_tasks: [],
    workflow_nodes: [],
    workflow_edges: [],
    timeline: {
      video: { track_id: 'track_video', volume: 1, clips: [] },
      background: { track_id: 'track_background', asset_id: null, timeline_start_us: 0, duration_us: 0, volume: 0 },
      subtitles: { track_id: 'track_subtitles', cue_ids: [], visible: false },
      watermark: { track_id: 'track_watermark', enabled: false, asset_id: null },
    },
    review_items: [],
    usage: null,
    outputs: {},
    pipeline: { version: 1, stages: emptyStages(), updated_at: now() },
  };
}

function asArray(value) { return Array.isArray(value) ? value : []; }

function normalizeManifest(value, options = {}) {
  const base = emptyManifest({ projectId: options.projectId || value?.project_id, media: value?.media || null });
  const source = value && typeof value === 'object' ? value : {};
  const result = { ...base, ...source };
  for (const key of ['styles', 'characters', 'scenes', 'assets', 'shots', 'subtitle_cues', 'audio_events', 'generation_tasks', 'workflow_nodes', 'workflow_edges', 'review_items']) {
    result[key] = asArray(source[key]);
  }
  result.schema_version = String(source.schema_version || SCHEMA_VERSION);
  result.project_id = String(source.project_id || base.project_id);
  result.timeline = source.timeline && typeof source.timeline === 'object' ? source.timeline : base.timeline;
  result.outputs = source.outputs && typeof source.outputs === 'object' ? source.outputs : {};
  result.pipeline = source.pipeline && typeof source.pipeline === 'object' ? source.pipeline : base.pipeline;
  result.pipeline.stages = source.pipeline?.stages && typeof source.pipeline.stages === 'object'
    ? { ...emptyStages(), ...source.pipeline.stages }
    : emptyStages();
  result.pipeline.updated_at = Number(source.pipeline?.updated_at) || now();
  return result;
}

function stageRecord(manifest, stage) {
  if (!STAGES.includes(stage)) throw new Error(`未知重建阶段：${stage}`);
  const normalized = normalizeManifest(manifest);
  return normalized.pipeline.stages[stage];
}

function updateStage(manifest, stage, patch = {}) {
  const normalized = normalizeManifest(manifest);
  if (!STAGES.includes(stage)) throw new Error(`未知重建阶段：${stage}`);
  const status = patch.status || normalized.pipeline.stages[stage].status;
  if (!ACTIVE_STATUSES.has(status)) throw new Error(`无效阶段状态：${status}`);
  const previous = normalized.pipeline.stages[stage];
  const next = {
    ...previous,
    ...patch,
    status,
    output_paths: asArray(patch.output_paths ?? previous.output_paths),
    review_items: asArray(patch.review_items ?? previous.review_items),
  };
  if (status === 'running' && !next.started_at) next.started_at = now();
  if (['succeeded', 'failed', 'blocked', 'needs_review'].includes(status)) next.finished_at = patch.finished_at || now();
  normalized.pipeline = { ...normalized.pipeline, stages: { ...normalized.pipeline.stages, [stage]: next }, updated_at: now() };
  return normalized;
}

function collectIds(items, label, errors) {
  const result = new Set();
  for (const [index, item] of asArray(items).entries()) {
    const id = item?.[`${label}_id`] || item?.id || item?.asset_id || item?.shot_id || item?.subtitle_id || item?.audio_event_id || item?.task_id || item?.node_id;
    if (!id) errors.push(`${label}[${index}] 缺少唯一 ID`);
    else if (result.has(String(id))) errors.push(`${label} 重复 ID：${id}`);
    else result.add(String(id));
  }
  return result;
}

function validateFrameCoverage(shots, media, errors) {
  if (!media || !Number.isSafeInteger(Number(media.total_frames)) || media.total_frames < 0) return;
  const total = Number(media.total_frames);
  const ordered = asArray(shots).slice().sort((a, b) => Number(a?.start_frame) - Number(b?.start_frame));
  let cursor = 0;
  for (const shot of ordered) {
    const start = Number(shot?.start_frame);
    const end = Number(shot?.end_frame_exclusive);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > total) {
      errors.push(`镜头 ${shot?.shot_id || '(无 ID)'} 帧区间无效`);
      continue;
    }
    if (start !== cursor) errors.push(`镜头帧覆盖存在缺口或重叠：期望 ${cursor}，实际 ${start}`);
    if (Number(shot.frame_count) !== end - start) errors.push(`镜头 ${shot.shot_id} frame_count 与区间不一致`);
    cursor = end;
  }
  if (ordered.length && cursor !== total) errors.push(`镜头未覆盖到工作视频末帧：${cursor}/${total}`);
}

function validateLocalRanges(manifest, errors) {
  const durationByShot = new Map(asArray(manifest.shots).map(shot => [String(shot.shot_id), Number(shot.duration_us)]));
  for (const shot of asArray(manifest.shots)) {
    const duration = durationByShot.get(String(shot.shot_id));
    for (const [index, beat] of asArray(shot.action_beats).entries()) {
      const start = Number(beat?.local_start_us);
      const end = Number(beat?.local_end_us);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || (Number.isFinite(duration) && end > duration)) {
        errors.push(`镜头 ${shot.shot_id} action_beats[${index}] 越界或无效`);
      }
    }
  }
  const total = Number(manifest.media?.duration_us);
  for (const cue of asArray(manifest.subtitle_cues)) {
    const start = Number(cue?.start_us);
    const end = Number(cue?.end_us);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || (Number.isFinite(total) && end > total)) {
      errors.push(`字幕 ${cue?.subtitle_id || '(无 ID)'} 时间无效或越界`);
    }
  }
}

function validateReferences(manifest, errors) {
  const ids = {
    styles: new Set(asArray(manifest.styles).map(item => String(item?.style_id || ''))),
    characters: new Set(asArray(manifest.characters).map(item => String(item?.character_id || ''))),
    scenes: new Set(asArray(manifest.scenes).map(item => String(item?.scene_id || ''))),
    assets: new Set(asArray(manifest.assets).map(item => String(item?.asset_id || ''))),
    shots: new Set(asArray(manifest.shots).map(item => String(item?.shot_id || ''))),
    subtitles: new Set(asArray(manifest.subtitle_cues).map(item => String(item?.subtitle_id || ''))),
    audio: new Set(asArray(manifest.audio_events).map(item => String(item?.audio_event_id || ''))),
    tasks: new Set(asArray(manifest.generation_tasks).map(item => String(item?.task_id || ''))),
    nodes: new Set(asArray(manifest.workflow_nodes).map(item => String(item?.node_id || ''))),
  };
  const check = (value, set, label) => {
    for (const id of asArray(value)) if (!set.has(String(id))) errors.push(`${label} 引用了不存在的 ID：${id}`);
  };
  for (const shot of manifest.shots) {
    if (shot.scene_id != null && !ids.scenes.has(String(shot.scene_id))) errors.push(`镜头 ${shot.shot_id} 引用了不存在的场景 ${shot.scene_id}`);
    check(shot.character_ids, ids.characters, `镜头 ${shot.shot_id} 角色`);
    check(shot.subtitle_ids, ids.subtitles, `镜头 ${shot.shot_id} 字幕`);
    check(shot.audio_event_ids, ids.audio, `镜头 ${shot.shot_id} 音频事件`);
    for (const key of ['preview_asset_id', 'clip_asset_id', 'representative_asset_id']) {
      if (shot[key] != null && !ids.assets.has(String(shot[key]))) errors.push(`镜头 ${shot.shot_id} 引用了不存在的素材 ${shot[key]}`);
    }
  }
  for (const style of manifest.styles) {
    if (style.evidence_frame_indices != null && !Array.isArray(style.evidence_frame_indices)) errors.push(`风格 ${style.style_id} evidence_frame_indices 必须是数组`);
  }
  for (const character of manifest.characters) {
    check(character.reference_asset_ids, ids.assets, `角色 ${character.character_id} 参考素材`);
    if (character.reference_crop_xyxy != null && (!Array.isArray(character.reference_crop_xyxy) || character.reference_crop_xyxy.length !== 4)) errors.push(`角色 ${character.character_id} reference_crop_xyxy 无效`);
  }
  for (const scene of manifest.scenes) {
    check(scene.reference_asset_ids, ids.assets, `场景 ${scene.scene_id} 参考素材`);
    if (scene.reference_crop_xyxy != null && (!Array.isArray(scene.reference_crop_xyxy) || scene.reference_crop_xyxy.length !== 4)) errors.push(`场景 ${scene.scene_id} reference_crop_xyxy 无效`);
  }
  for (const cue of manifest.subtitle_cues) check(cue.shot_ids, ids.shots, `字幕 ${cue.subtitle_id} 镜头`);
  for (const event of manifest.audio_events) check(event.shot_ids, ids.shots, `音频 ${event.audio_event_id} 镜头`);
  for (const task of manifest.generation_tasks) {
    check(task.shot_ids, ids.shots, `生成任务 ${task.task_id} 镜头`);
    if (task.style_id != null && !ids.styles.has(String(task.style_id))) errors.push(`生成任务 ${task.task_id} 引用了不存在的风格 ${task.style_id}`);
    for (const binding of asArray(task.reference_bindings)) if (!ids.assets.has(String(binding?.asset_id))) errors.push(`生成任务 ${task.task_id} 引用了不存在的参考素材 ${binding?.asset_id}`);
    if (task.execution != null && task.provenance === 'inferred_plan') errors.push(`推导任务 ${task.task_id} 不应填写 execution`);
  }
  for (const edge of manifest.workflow_edges) {
    if (!ids.nodes.has(String(edge?.from_node_id))) errors.push(`工作流边起点不存在：${edge?.from_node_id}`);
    if (!ids.nodes.has(String(edge?.to_node_id))) errors.push(`工作流边终点不存在：${edge?.to_node_id}`);
  }
  for (const clip of asArray(manifest.timeline?.video?.clips)) {
    if (!ids.shots.has(String(clip?.shot_id))) errors.push(`视频轨片段引用了不存在的镜头：${clip?.shot_id}`);
    if (!ids.assets.has(String(clip?.asset_id))) errors.push(`视频轨片段引用了不存在的素材：${clip?.asset_id}`);
  }
  if (manifest.timeline?.background?.asset_id != null && !ids.assets.has(String(manifest.timeline.background.asset_id))) {
    errors.push(`背景轨引用了不存在的素材：${manifest.timeline.background.asset_id}`);
  }
}

function validateManifest(value, options = {}) {
  const manifest = normalizeManifest(value);
  const errors = [];
  const warnings = [];
  if (manifest.schema_version !== SCHEMA_VERSION) warnings.push(`schema_version=${manifest.schema_version}，当前实现目标为 ${SCHEMA_VERSION}`);
  const media = manifest.media;
  if (!media || typeof media !== 'object') errors.push('缺少媒体基准 media');
  else {
    for (const key of ['width', 'height', 'fps_num', 'fps_den', 'total_frames', 'duration_us']) {
      if (!Number.isSafeInteger(Number(media[key])) || Number(media[key]) < 0) errors.push(`媒体基准 ${key} 无效`);
    }
    if (Number(media.width) <= 0 || Number(media.height) <= 0) errors.push('媒体基准画面尺寸无效');
    if (Number(media.fps_num) <= 0 || Number(media.fps_den) <= 0) errors.push('媒体基准帧率无效');
    if (Number(media.total_frames) <= 0) errors.push('媒体基准总帧数无效');
    if (Number(media.duration_us) <= 0) errors.push('媒体基准时长无效');
    if (!String(media.original_file || '').trim() || !String(media.working_file || '').trim()) errors.push('媒体基准缺少原文件或工作文件路径');
    if (options.checkFiles !== false) {
      if (!media.original_file || !fs.existsSync(media.original_file)) errors.push('原视频文件不存在');
      if (!media.working_file || !fs.existsSync(media.working_file)) errors.push('工作视频文件不存在');
    }
  }
  for (const [key, label] of [['styles', 'style'], ['characters', 'character'], ['scenes', 'scene'], ['assets', 'asset'], ['shots', 'shot'], ['subtitle_cues', 'subtitle'], ['audio_events', 'audio_event'], ['generation_tasks', 'task'], ['workflow_nodes', 'node']]) collectIds(manifest[key], label, errors);
  validateFrameCoverage(manifest.shots, manifest.media, errors);
  validateLocalRanges(manifest, errors);
  validateReferences(manifest, errors);
  for (const asset of manifest.assets) {
    if (asset.status === 'ready' && options.checkFiles !== false && (!asset.path || !fs.existsSync(asset.path))) errors.push(`ready 素材文件不存在：${asset.asset_id}`);
    if (asset.crop_xyxy != null) {
      const crop = asset.crop_xyxy;
      if (!Array.isArray(crop) || crop.length !== 4 || crop.some(number => !Number.isFinite(Number(number))) || Number(crop[0]) < 0 || Number(crop[1]) < 0 || Number(crop[2]) > 1 || Number(crop[3]) > 1 || Number(crop[2]) <= Number(crop[0]) || Number(crop[3]) <= Number(crop[1])) {
        errors.push(`素材 ${asset.asset_id} crop_xyxy 无效`);
      }
    }
  }
  for (const task of manifest.generation_tasks) {
    const requiredPromptParts = ['subject', 'environment', 'composition', 'action_sequence', 'camera', 'dialogue', 'audio', 'style', 'continuity', 'exclusions'];
    if (!task.prompt_text || !task.prompt_parts || requiredPromptParts.some(key => task.prompt_parts[key] == null)) errors.push(`生成任务 ${task.task_id} 缺少完整提示词字段`);
    if (!Array.isArray(task.prompt_parts?.timeline) || !task.prompt_parts.timeline.length) errors.push(`生成任务 ${task.task_id} 缺少镜头内提示词时间线`);
    if (task.request_duration_s == null && task.status === 'ready_to_run') errors.push(`生成任务 ${task.task_id} 尚未核对 request_duration_s`);
    const parts = task.prompt_parts;
    if (Array.isArray(parts?.timeline) && parts.timeline.length) {
      let end = 0;
      for (const item of asArray(parts.timeline)) {
        const start = Number(item?.start_us ?? item?.local_start_us);
        const finish = Number(item?.end_us ?? item?.local_end_us);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish) || start !== end || finish <= start) errors.push(`生成任务 ${task.task_id} 内部提示词时间线不连续`);
        end = finish;
      }
      if (Number.isSafeInteger(Number(task.target_duration_us)) && end !== Number(task.target_duration_us)) errors.push(`生成任务 ${task.task_id} 内部时间线未覆盖目标时长`);
    }
  }
  const taskShotIds = new Set(manifest.generation_tasks.flatMap(task => asArray(task.shot_ids).map(String)));
  for (const shot of manifest.shots) if (!taskShotIds.has(String(shot.shot_id))) errors.push(`镜头 ${shot.shot_id} 缺少对应的生成方案任务`);
  return { valid: errors.length === 0, errors, warnings, manifest };
}

async function writeManifestAtomic(filePath, value, options = {}) {
  const normalized = normalizeManifest(value);
  const check = validateManifest(normalized, { checkFiles: options.checkFiles !== false });
  if (!check.valid && options.allowInvalid !== true) throw new Error(`manifest 校验失败：${check.errors.slice(0, 6).join('；')}`);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return { ...check, manifest: normalized, path: filePath };
}

async function readManifest(filePath) {
  const data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  return normalizeManifest(data);
}

module.exports = {
  SCHEMA_VERSION,
  STAGES,
  emptyManifest,
  normalizeManifest,
  stageRecord,
  updateStage,
  validateManifest,
  writeManifestAtomic,
  readManifest,
};
