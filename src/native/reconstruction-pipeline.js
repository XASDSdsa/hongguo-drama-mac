'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const {
  emptyManifest,
  normalizeManifest,
  updateStage,
  validateManifest,
  writeManifestAtomic,
  readManifest,
} = require('./reconstruction-manifest');
const {
  runProcess,
  fileSha256,
  probeMedia,
  normalizeMedia,
  mediaNeedsNormalization,
  frameToUs,
} = require('./reconstruction-media');
const { detectAdaptiveCuts, buildShotsFromCuts } = require('./adaptive-detector');
const qwen = require('./qwen-omni');
const { writeSubtitleExport, writeEngineeringHtml } = require('./reconstruction-outputs');

function safeName(value) {
  return String(value || '项目').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '项目';
}

function concurrency(settings) {
  const value = Number(settings.reconstruction_concurrency || settings.quchong_jobs || 2);
  return Number.isInteger(value) ? Math.max(1, Math.min(8, value)) : 2;
}

function progressValue(stage, done, total) {
  return { stage, progress: total ? Math.min(100, Math.round(done * 100 / total)) : 0, done, total };
}

function stageInputFingerprint(job, name, configSnapshot) {
  const manifest = job.manifest || {};
  const coreShots = (manifest.shots || []).map(shot => ({
    shot_id: shot.shot_id,
    order: shot.order,
    start_frame: shot.start_frame,
    end_frame_exclusive: shot.end_frame_exclusive,
    start_us: shot.start_us,
    end_us: shot.end_us,
    duration_us: shot.duration_us,
    representative_frame: shot.representative_frame,
  }));
  const payload = {
    stage: name,
    project_id: job.projectId,
    source_sha256: job.inputSha256 || manifest.media?.source_sha256 || null,
    input_file: job.inputPath || manifest.media?.original_file || null,
    working_file: manifest.media?.working_file || null,
    config: configSnapshot || null,
  };
  if (name === 'shot_detection') payload.media = manifest.media || null;
  else if (name === 'source_assets') payload.shots = coreShots;
  else if (name === 'qwen_global') {
    payload.shots = coreShots;
    payload.shot_assets = (manifest.assets || []).filter(asset => ['shot_preview', 'video_clip'].includes(asset.kind)).map(asset => ({ asset_id: asset.asset_id, kind: asset.kind, path: asset.path, status: asset.status }));
  }
  else if (name === 'qwen_shots') {
    payload.shots = coreShots;
    payload.styles = manifest.styles || [];
    payload.characters = manifest.characters || [];
    payload.scenes = manifest.scenes || [];
    payload.assets = (manifest.assets || []).filter(asset => ['shot_preview', 'video_clip', 'character_ref', 'scene_ref'].includes(asset.kind)).map(asset => ({ asset_id: asset.asset_id, kind: asset.kind, path: asset.path, status: asset.status }));
  } else if (name === 'background_audio') payload.media = manifest.media || null;
  else if (name === 'manifest_validation') {
    payload.media = manifest.media || null;
    payload.shots = manifest.shots || [];
    payload.styles = manifest.styles || [];
    payload.characters = manifest.characters || [];
    payload.scenes = manifest.scenes || [];
    payload.assets = manifest.assets || [];
    payload.subtitle_cues = manifest.subtitle_cues || [];
    payload.audio_events = manifest.audio_events || [];
    payload.generation_tasks = manifest.generation_tasks || [];
    payload.timeline = manifest.timeline || null;
  } else if (name === 'subtitle_export') payload.subtitle_cues = manifest.subtitle_cues || [];
  else if (name === 'html_export') {
    payload.media = manifest.media || null;
    payload.shots = manifest.shots || [];
    payload.styles = manifest.styles || [];
    payload.characters = manifest.characters || [];
    payload.scenes = manifest.scenes || [];
    payload.assets = manifest.assets || [];
    payload.subtitle_cues = manifest.subtitle_cues || [];
    payload.audio_events = manifest.audio_events || [];
    payload.generation_tasks = manifest.generation_tasks || [];
    payload.timeline = manifest.timeline || null;
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function uniqueIds(items, key, prefix) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const value = item && typeof item === 'object' ? { ...item } : {};
    let id = String(value[key] || '').trim();
    if (!id || seen.has(id)) id = `${prefix}_${String(index + 1).padStart(3, '0')}`;
    while (seen.has(id)) id = `${prefix}_${randomUUID().slice(0, 8)}`;
    seen.add(id);
    value[key] = id;
    return value;
  });
}

function mergeGlobal(manifest, data) {
  const global = data && typeof data === 'object' ? data : {};
  const styles = uniqueIds(global.styles, 'style_id', 'style');
  const characters = uniqueIds(global.characters, 'character_id', 'char');
  const scenes = uniqueIds(global.scenes, 'scene_id', 'scene');
  const audio = uniqueIds(global.audio_events, 'audio_event_id', 'audio');
  const subtitles = uniqueIds(global.subtitle_cues, 'subtitle_id', 'subtitle');
  const shotIds = new Set(manifest.shots.map(item => item.shot_id));
  const cleanShotRefs = (ids) => (Array.isArray(ids) ? ids.map(String).filter(id => shotIds.has(id)) : []);
  for (const item of audio) item.shot_ids = cleanShotRefs(item.shot_ids);
  for (const item of subtitles) {
    item.shot_ids = cleanShotRefs(item.shot_ids);
    const start = Number(item.start_us);
    const end = Number(item.end_us);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= Number(manifest.media?.duration_us || Infinity)) {
      item.start_us = start; item.end_us = end; item.timing_method = item.timing_method || 'qwen_estimate';
    } else {
      manifest.review_items.push({ review_id: `review_${randomUUID()}`, kind: 'invalid_subtitle_timing', target_id: item.subtitle_id, reason: '千问返回的字幕时间无效或超出视频范围，已保留待复核' });
      item.start_us = null; item.end_us = null;
    }
  }
  return {
    ...manifest,
    styles,
    characters,
    scenes,
    audio_events: audio,
    subtitle_cues: subtitles,
    review_items: [...manifest.review_items, ...(Array.isArray(global.review_items) ? global.review_items : [])],
  };
}

function cleanActionBeats(shot, beats, manifest) {
  const duration = Number(shot.duration_us);
  const result = [];
  for (const beat of Array.isArray(beats) ? beats : []) {
    const start = Number(beat?.local_start_us);
    const end = Number(beat?.local_end_us);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= duration) {
      result.push({ ...beat, local_start_us: start, local_end_us: end, timing_method: beat.timing_method || 'qwen_estimate' });
    } else {
      manifest.review_items.push({ review_id: `review_${randomUUID()}`, kind: 'invalid_action_timing', target_id: shot.shot_id, reason: '千问返回的镜头内动作时间越界，已保留镜头边界并要求复核' });
    }
  }
  return result.sort((a, b) => a.local_start_us - b.local_start_us);
}

function normalizedCrop(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = numbers;
  if (x1 < 0 || y1 < 0 || x2 > 1 || y2 > 1 || x2 <= x1 || y2 <= y1) return null;
  return numbers;
}

function referenceFrame(entity, totalFrames) {
  const candidates = [
    ...(Array.isArray(entity?.reference_frame_indices) ? entity.reference_frame_indices : []),
    ...(Array.isArray(entity?.evidence_frame_indices) ? entity.evidence_frame_indices : []),
  ];
  return candidates.map(Number).find(frame => Number.isSafeInteger(frame) && frame >= 0 && frame < totalFrames);
}

function referenceCrop(entity) {
  return normalizedCrop(entity?.reference_crop_xyxy)
    || normalizedCrop(entity?.crop_xyxy)
    || normalizedCrop(entity?.reference_crop);
}

async function extractReferenceAssets({ ffmpegPath, media, manifest, outputDir, signal, concurrencyLimit }) {
  if (!ffmpegPath || !media?.working_file) throw new Error('缺少 FFmpeg/工作视频，无法提取参考素材');
  await fsp.mkdir(outputDir, { recursive: true });
  const oldReferenceIds = new Set();
  for (const entity of [...manifest.characters, ...manifest.scenes]) {
    for (const id of Array.isArray(entity.reference_asset_ids) ? entity.reference_asset_ids : []) oldReferenceIds.add(String(id));
    entity.reference_asset_ids = [];
  }
  manifest.assets = manifest.assets.filter(asset => !oldReferenceIds.has(String(asset.asset_id)) && !['character_ref', 'scene_ref'].includes(asset.kind));
  const jobs = [];
  const addJobs = (items, kind, prefix, label) => {
    for (const entity of items) {
      const frame = referenceFrame(entity, Number(media.total_frames));
      if (!Number.isSafeInteger(frame)) {
        manifest.review_items.push({ review_id: `review_${randomUUID()}`, kind: 'missing_reference_frame', target_id: entity.character_id || entity.scene_id, reason: `${label}没有可用的工作视频证据帧，未伪造参考图` });
        continue;
      }
      const crop = referenceCrop(entity);
      jobs.push({ entity, frame, crop, kind, prefix });
    }
  };
  addJobs(manifest.characters, 'character_ref', 'char', '角色');
  addJobs(manifest.scenes, 'scene_ref', 'scene', '场景');
  const outputPaths = [];
  await mapLimit(jobs, concurrencyLimit, async job => {
    const entityId = String(job.entity.character_id || job.entity.scene_id);
    const assetId = `asset_${job.prefix}_${entityId}_reference`;
    const outputPath = path.join(outputDir, `${assetId}.jpg`);
    const time = (frameToUs(job.frame, media.fps_num, media.fps_den) / 1_000_000).toFixed(6);
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', time, '-i', media.working_file, '-frames:v', '1'];
    if (job.crop) {
      const [x1, y1, x2, y2] = job.crop;
      const width = Math.max(2, Math.floor(Number(media.width) * (x2 - x1)));
      const height = Math.max(2, Math.floor(Number(media.height) * (y2 - y1)));
      const left = Math.max(0, Math.floor(Number(media.width) * x1));
      const top = Math.max(0, Math.floor(Number(media.height) * y1));
      args.push('-vf', `crop=${width}:${height}:${left}:${top}`);
    }
    args.push('-q:v', '2', outputPath);
    await runProcess(ffmpegPath, args, { signal });
    const asset = {
      asset_id: assetId,
      kind: job.kind,
      path: outputPath,
      origin: job.crop ? 'source_crop' : 'source_frame',
      source_frame_index: job.frame,
      crop_xyxy: job.crop,
      used_by_ids: [entityId],
      status: 'ready',
    };
    manifest.assets.push(asset);
    job.entity.reference_asset_ids = [assetId];
    outputPaths.push(outputPath);
  }, signal);
  return outputPaths;
}

function rebuildWorkflowGraph(manifest) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const addNode = node => {
    if (!node?.node_id || nodeIds.has(String(node.node_id))) return;
    nodeIds.add(String(node.node_id));
    nodes.push(node);
  };
  const addEdge = (fromNodeId, toNodeId, relation) => {
    if (!nodeIds.has(String(fromNodeId)) || !nodeIds.has(String(toNodeId))) return;
    edges.push({ from_node_id: String(fromNodeId), to_node_id: String(toNodeId), relation });
  };

  if (manifest.styles.length) addNode({ node_id: 'node_style', type: 'style', label: '统一风格', entity_ids: manifest.styles.map(item => item.style_id), status: 'analyzed' });
  if (manifest.characters.length) addNode({
    node_id: 'node_characters',
    type: 'character_reference',
    label: '角色参考',
    entity_ids: [...manifest.characters.map(item => item.character_id), ...manifest.characters.flatMap(item => item.reference_asset_ids || [])],
    status: manifest.characters.every(item => (item.reference_asset_ids || []).length > 0) ? 'extracted' : 'needs_review',
  });
  if (manifest.scenes.length) addNode({
    node_id: 'node_scenes',
    type: 'scene_reference',
    label: '场景参考',
    entity_ids: [...manifest.scenes.map(item => item.scene_id), ...manifest.scenes.flatMap(item => item.reference_asset_ids || [])],
    status: manifest.scenes.every(item => (item.reference_asset_ids || []).length > 0) ? 'extracted' : 'needs_review',
  });

  const taskByShot = new Map();
  for (const task of manifest.generation_tasks) for (const shotId of task.shot_ids || []) taskByShot.set(String(shotId), task);
  const orderedShots = [...manifest.shots].sort((a, b) => Number(a.order) - Number(b.order));
  for (const shot of orderedShots) {
    const shotNodeId = `node_${shot.shot_id}`;
    addNode({ node_id: shotNodeId, type: 'storyboard', label: `分镜 ${shot.order}`, entity_ids: [shot.shot_id], status: shot.visual_description ? 'analyzed' : 'needs_review' });
    const clipAsset = manifest.assets.find(asset => String(asset.asset_id) === String(shot.clip_asset_id));
    if (clipAsset) {
      const clipNodeId = `node_clip_${shot.shot_id}`;
      addNode({ node_id: clipNodeId, type: 'source_clip', label: `成片片段 ${shot.order}`, entity_ids: [clipAsset.asset_id], status: clipAsset.status === 'ready' ? 'extracted' : 'failed' });
      addEdge(clipNodeId, shotNodeId, 'analysis_evidence');
    }
    const task = taskByShot.get(String(shot.shot_id));
    if (task) {
      const taskNodeId = `node_gen_${task.task_id}`;
      addNode({ node_id: taskNodeId, type: 'video_generation_plan', label: `镜头 ${shot.order} 复现方案`, entity_ids: [task.task_id], status: task.status || 'planned' });
      addEdge('node_style', taskNodeId, 'plan_input');
      addEdge('node_characters', taskNodeId, 'plan_input');
      addEdge('node_scenes', taskNodeId, 'plan_input');
      addEdge(shotNodeId, taskNodeId, 'plan_input');
    }
    if (shot.continuity?.previous_shot_id) addEdge(`node_${shot.continuity.previous_shot_id}`, shotNodeId, 'sequence');
  }

  addNode({ node_id: 'node_edit', type: 'edit', label: '剪辑输出', entity_ids: ['track_video', 'track_background', 'track_subtitles', 'track_watermark'], status: 'planned' });
  for (const shot of orderedShots) {
    if (manifest.assets.some(asset => String(asset.asset_id) === String(shot.clip_asset_id))) addEdge(`node_clip_${shot.shot_id}`, 'node_edit', 'actual_media_input');
  }
  const backgroundId = manifest.timeline?.background?.asset_id;
  if (backgroundId) {
    const backgroundAsset = manifest.assets.find(asset => String(asset.asset_id) === String(backgroundId));
    if (backgroundAsset) {
      addNode({ node_id: 'node_background_audio', type: 'background_audio', label: '背景声音', entity_ids: [backgroundAsset.asset_id], status: backgroundAsset.status === 'ready' ? 'extracted' : 'failed' });
      addEdge('node_background_audio', 'node_edit', 'actual_media_input');
    }
  }
  if (manifest.subtitle_cues.length) {
    addNode({ node_id: 'node_subtitles', type: 'subtitles', label: '字幕轨', entity_ids: manifest.subtitle_cues.map(item => item.subtitle_id), status: 'planned' });
    addEdge('node_subtitles', 'node_edit', 'actual_media_input');
  }
  if (manifest.timeline?.watermark?.enabled && manifest.timeline.watermark.asset_id) {
    const watermarkAsset = manifest.assets.find(asset => String(asset.asset_id) === String(manifest.timeline.watermark.asset_id));
    if (watermarkAsset) {
      addNode({ node_id: 'node_watermark', type: 'watermark', label: '水印', entity_ids: [watermarkAsset.asset_id], status: watermarkAsset.status === 'ready' ? 'ready' : 'failed' });
      addEdge('node_watermark', 'node_edit', 'actual_media_input');
    }
  }
  manifest.workflow_nodes = nodes;
  manifest.workflow_edges = edges;
  return manifest;
}

function rebuildTimeline(manifest) {
  const clips = manifest.shots.map(shot => ({
    clip_id: `clip_${shot.shot_id}`,
    shot_id: shot.shot_id,
    asset_id: shot.clip_asset_id,
    timeline_start_us: Number(shot.start_us),
    duration_us: Number(shot.duration_us),
    source_start_us: 0,
    source_end_us: Number(shot.duration_us),
    status: 'ready',
  }));
  manifest.timeline = {
    ...manifest.timeline,
    video: { ...(manifest.timeline?.video || {}), track_id: 'track_video', volume: 1, clips },
  };
  rebuildWorkflowGraph(manifest);
  return manifest;
}

function mergeShotResults(manifest, results) {
  const byId = new Map((Array.isArray(results) ? results : []).map(item => [String(item?.shot_id || ''), item]));
  const sceneIds = new Set(manifest.scenes.map(item => String(item.scene_id)));
  const characterIds = new Set(manifest.characters.map(item => String(item.character_id)));
  const audioIds = new Set(manifest.audio_events.map(item => String(item.audio_event_id)));
  const subtitleIds = new Set(manifest.subtitle_cues.map(item => String(item.subtitle_id)));
  const assetIds = new Set(manifest.assets.map(item => String(item.asset_id)));
  const styleIds = new Set(manifest.styles.map(item => String(item.style_id)));
  const nextShots = manifest.shots.map(shot => {
    const value = byId.get(String(shot.shot_id));
    if (!value) {
      manifest.review_items.push({ review_id: `review_${randomUUID()}`, kind: 'missing_shot_analysis', target_id: shot.shot_id, reason: '千问没有返回该镜头的结构化分析' });
      return { ...shot, boundary_status: shot.boundary_status === 'detected' ? 'needs_review' : shot.boundary_status, uncertainty_codes: [...shot.uncertainty_codes, 'qwen_missing'] };
    }
    const sceneId = value.scene_id != null && sceneIds.has(String(value.scene_id)) ? String(value.scene_id) : null;
    const chars = Array.isArray(value.character_ids) ? value.character_ids.map(String).filter(id => characterIds.has(id)) : [];
    const subtitleRefs = Array.isArray(value.subtitle_ids) ? value.subtitle_ids.map(String).filter(id => subtitleIds.has(id)) : [];
    const audioEventIds = Array.isArray(value.audio_event_ids) ? value.audio_event_ids.map(String).filter(id => audioIds.has(id)) : [];
    const removedRefs = (Array.isArray(value.character_ids) ? value.character_ids.length : 0) !== chars.length || (value.scene_id != null && !sceneId);
    const next = {
      ...shot,
      ...value,
      shot_id: shot.shot_id,
      order: shot.order,
      start_frame: shot.start_frame,
      end_frame_exclusive: shot.end_frame_exclusive,
      frame_count: shot.frame_count,
      start_us: shot.start_us,
      end_us: shot.end_us,
      duration_us: shot.duration_us,
      scene_id: sceneId,
      character_ids: chars,
      subtitle_ids: subtitleRefs,
      audio_event_ids: audioEventIds,
      action_beats: cleanActionBeats(shot, value.action_beats, manifest),
      uncertainty_codes: [...new Set([...(Array.isArray(value.uncertainty_codes) ? value.uncertainty_codes : []), ...(removedRefs ? ['invalid_reference'] : [])])],
    };
    return next;
  });
  manifest.shots = nextShots;
  const tasks = [];
  for (const shot of nextShots) {
    const value = byId.get(shot.shot_id);
    if (!value?.prompt_text) continue;
    const suppliedBindings = Array.isArray(value.reference_bindings) ? value.reference_bindings.filter(binding => binding?.asset_id != null && assetIds.has(String(binding.asset_id))) : [];
    const defaults = [];
    for (const characterId of shot.character_ids) {
      const character = manifest.characters.find(item => String(item.character_id) === String(characterId));
      for (const assetId of character?.reference_asset_ids || []) if (assetIds.has(String(assetId))) defaults.push({ asset_id: assetId, purpose: 'character', entity_id: characterId, prompt_alias: character.display_name || characterId });
    }
    const scene = manifest.scenes.find(item => String(item.scene_id) === String(shot.scene_id));
    for (const assetId of scene?.reference_asset_ids || []) if (assetIds.has(String(assetId))) defaults.push({ asset_id: assetId, purpose: 'scene', entity_id: shot.scene_id, prompt_alias: scene.name || shot.scene_id });
    const bindingMap = new Map();
    for (const binding of [...defaults, ...suppliedBindings]) bindingMap.set(`${binding.purpose}:${binding.asset_id}`, binding);
    const referenceBindings = [...bindingMap.values()];
    if (Array.isArray(value.reference_bindings) && suppliedBindings.length !== value.reference_bindings.length) {
      manifest.review_items.push({ review_id: `review_${randomUUID()}`, kind: 'invalid_reference_binding', target_id: shot.shot_id, reason: '千问返回了不存在的参考素材 ID，已移除无效引用并要求复核' });
    }
    const styleId = value.style_id != null && styleIds.has(String(value.style_id)) ? String(value.style_id) : manifest.styles.length === 1 ? String(manifest.styles[0].style_id) : null;
    tasks.push({
      task_id: `task_${shot.shot_id}`,
      shot_ids: [shot.shot_id],
      target_model: value.target_model || value.model || null,
      style_id: styleId,
      model: value.model || value.target_model || null,
      mode: value.mode || 'reference_to_video',
      request_duration_s: value.request_duration_s == null ? null : Number(value.request_duration_s),
      target_duration_us: shot.duration_us,
      trim_range_us: Array.isArray(value.trim_range_us) ? value.trim_range_us : null,
      aspect_ratio: value.aspect_ratio || null,
      native_audio: value.native_audio !== false,
      reference_bindings: referenceBindings,
      prompt_parts: value.prompt_parts || null,
      prompt_text: String(value.prompt_text),
      avoid: Array.isArray(value.avoid) ? value.avoid : [],
      continuity_constraints: Array.isArray(value.continuity_constraints) ? value.continuity_constraints : [],
      provenance: 'inferred_plan',
      status: 'needs_review',
      execution: null,
    });
  }
  manifest.generation_tasks = tasks;
  return manifest;
}

async function mapLimit(items, limit, worker, signal, onProgress) {
  let cursor = 0;
  let done = 0;
  const run = async () => {
    while (true) {
      if (signal?.aborted) throw new Error('任务已取消');
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
      done += 1;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, run));
}

async function analyzeShotBatchWithRecovery({ batch, buildInputs, settings, signal }) {
  const pending = [batch];
  const data = [];
  const usage = [];
  while (pending.length) {
    const chunk = pending.shift();
    try {
      const result = await qwen.analyzeShots({ ...buildInputs(chunk), settings, signal });
      if (result.usage) usage.push(result.usage);
      const expected = new Set(chunk.map(shot => String(shot.shot_id)));
      const seen = new Set();
      (Array.isArray(result.data) ? result.data : []).filter(item => {
        const id = String(item?.shot_id || '');
        if (!expected.has(id) || seen.has(id)) return false;
        seen.add(id);
        data.push(item);
        return true;
      });
      const missing = chunk.filter(shot => !seen.has(String(shot.shot_id)));
      if (!missing.length) continue;
      if (chunk.length === 1) throw new Error(`千问逐镜头响应缺少 ${missing[0].shot_id}，无法继续缩小批次`);
      const midpoint = Math.max(1, Math.ceil(missing.length / 2));
      pending.unshift(...[missing.slice(0, midpoint), missing.slice(midpoint)].filter(items => items.length));
    } catch (error) {
      const message = String(error?.message || error || '');
      const recoverable = /返回内容不是|不是完整 JSON|不是有效 JSON|缺少 .*无法继续|响应.*截断|字段不完整/.test(message);
      if (!recoverable || chunk.length === 1) throw error;
      const midpoint = Math.max(1, Math.floor(chunk.length / 2));
      pending.unshift(...[chunk.slice(0, midpoint), chunk.slice(midpoint)].filter(items => items.length));
    }
  }
  return { data, usage };
}

async function extractShot(ffmpegPath, ffprobePath, inputPath, shot, outputDir, signal, fpsNum, fpsDen, media) {
  const name = String(shot.shot_id);
  const clipPath = path.join(outputDir, `${name}.mp4`);
  const previewPath = path.join(outputDir, `${name}.jpg`);
  const start = (Number(shot.start_us) / 1_000_000).toFixed(6);
  const duration = (Number(shot.duration_us) / 1_000_000).toFixed(6);
  await runProcess(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-ss', start, '-t', duration,
    '-map', '0:v:0', '-map', '0:a?', '-frames:v', String(shot.frame_count), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', clipPath,
  ], { signal });
  const probe = await runProcess(ffprobePath, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', clipPath], { signal });
  let frameCount = 0;
  let clipProbe = null;
  try { clipProbe = JSON.parse(probe.stdout); } catch (_) {}
  const videoStream = clipProbe?.streams?.find(stream => stream.codec_type === 'video');
  const audioStream = clipProbe?.streams?.find(stream => stream.codec_type === 'audio');
  try { frameCount = Number(videoStream?.nb_read_frames || 0); } catch (_) {}
  if (frameCount !== Number(shot.frame_count)) throw new Error(`${shot.shot_id} 切片帧数校验失败：计划 ${shot.frame_count}，实际 ${frameCount}`);
  if (Number(videoStream?.width) !== Number(media?.width) || Number(videoStream?.height) !== Number(media?.height)) throw new Error(`${shot.shot_id} 切片画面尺寸校验失败`);
  if (media?.has_audio && !audioStream) throw new Error(`${shot.shot_id} 切片缺少原声音轨`);
  const actualVideoDurationUs = Math.round(Number(videoStream?.duration || clipProbe?.format?.duration || 0) * 1_000_000);
  const frameToleranceUs = Math.max(100_000, frameToUs(2, Number(fpsNum), Number(fpsDen)));
  if (actualVideoDurationUs > 0 && Math.abs(actualVideoDurationUs - Number(shot.duration_us)) > frameToleranceUs) throw new Error(`${shot.shot_id} 切片视频时长校验失败：计划 ${shot.duration_us}us，实际 ${actualVideoDurationUs}us`);
  const frameOffset = Math.max(0, Number(shot.representative_frame) - Number(shot.start_frame));
  const frameTime = (frameToUs(frameOffset, Number(fpsNum), Number(fpsDen)) / 1_000_000).toFixed(6);
  await runProcess(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Number(shot.start_us) / 1_000_000),
    '-i', inputPath, '-ss', frameTime, '-frames:v', '1', '-q:v', '2', previewPath,
  ], { signal });
  return { clipPath, previewPath };
}

function stageError(error) { return String(error?.message || error || '阶段失败').slice(0, 4000); }

function createReconstructionPipeline({ getSettings, getFfmpegPath, getFfprobePath, getProjectRecord, saveProjectRecord, isDedupedInput, sendProgress }) {
  const jobs = new Map();

  function emit(payload) { try { sendProgress?.(payload); } catch (_) {} }

  function status(projectId) {
    const job = jobs.get(String(projectId));
    if (!job) {
      const record = getProjectRecord?.(String(projectId || ''));
      const manifestPath = record?.manifestPath;
      if (manifestPath && fs.existsSync(manifestPath)) {
        try {
          const manifest = normalizeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
          const stages = manifest.pipeline?.stages || {};
          const failed = Object.entries(stages).some(([name, stage]) => !['png_export', 'jianying_draft'].includes(name) && stage?.status === 'failed');
          const blocked = Object.entries(stages).some(([name, stage]) => !['png_export', 'jianying_draft'].includes(name) && stage?.status === 'blocked');
          const ready = stages.html_export?.status === 'succeeded' && stages.manifest_validation?.status === 'succeeded';
          return { success: true, projectId: String(projectId), status: failed ? 'failed' : ready || blocked ? 'partial' : 'idle', stage: null, manifestPath, manifest };
        } catch (_) { /* corrupted manifest is reported by the next explicit start */ }
      }
      return { success: true, projectId: String(projectId || ''), status: 'idle', manifestPath: null, manifest: null };
    }
    return { success: true, projectId: job.projectId, batchId: job.batchId, status: job.status, stage: job.stage, manifestPath: job.manifestPath, manifest: job.manifest };
  }

  async function save(job, options = {}) {
    const result = await writeManifestAtomic(job.manifestPath, job.manifest, { allowInvalid: options.allowInvalid !== false, checkFiles: options.checkFiles !== false });
    job.manifest = result.manifest;
    return result;
  }

  async function setStage(job, name, statusValue, patch = {}) {
    job.manifest = updateStage(job.manifest, name, { status: statusValue, ...patch });
    job.stage = name;
    // 阶段中间结果允许存在待复核字段；最终 manifest_validation 才是硬门禁。
    await save(job, { allowInvalid: true });
    emit({ type: 'stage', projectId: job.projectId, batchId: job.batchId, stage: name, status: statusValue, ...(patch.progress != null ? { progress: patch.progress } : {}) });
  }

  async function stage(job, name, fn, configSnapshot = null) {
    const runId = randomUUID();
    const inputFingerprint = stageInputFingerprint(job, name, configSnapshot);
    await setStage(job, name, 'running', { run_id: runId, input_fingerprint: inputFingerprint, error: null, progress: 0, config_snapshot: configSnapshot });
    try {
      const value = await fn();
      await setStage(job, name, 'succeeded', { progress: 100, output_paths: value?.output_paths || job.manifest.pipeline.stages[name].output_paths });
      return value;
    } catch (error) {
      const message = stageError(error);
      const blocked = /未配置|未找到|不存在|缺少|不能伪造|需要提供|ENOENT|Demucs/i.test(message);
      if (blocked && error && typeof error === 'object') error.code = 'RECONSTRUCTION_STAGE_BLOCKED';
      await setStage(job, name, blocked ? 'blocked' : 'failed', { error: message, progress: 0 });
      throw error;
    }
  }

  async function stageIfNeeded(job, name, canSkip, fn, configSnapshot = null) {
    const previous = job.manifest.pipeline?.stages?.[name];
    const sameConfig = configSnapshot == null || JSON.stringify(previous?.config_snapshot || null) === JSON.stringify(configSnapshot);
    const sameInput = previous?.input_fingerprint && previous.input_fingerprint === stageInputFingerprint(job, name, configSnapshot);
    if (previous?.status === 'succeeded' && sameConfig && sameInput && canSkip()) {
      job.changedStages[name] = false;
      job.stage = name;
      emit({ type: 'stage', projectId: job.projectId, batchId: job.batchId, stage: name, status: 'succeeded', skipped: true, progress: 100 });
      return { skipped: true, output_paths: job.manifest.pipeline.stages[name].output_paths || [] };
    }
    job.changedStages[name] = true;
    return stage(job, name, fn, configSnapshot);
  }

  async function start(payload = {}) {
    const rawInputPath = String(payload.inputPath || '').trim();
    if (!rawInputPath) return { success: false, error: '请选择已去重的视频' };
    const inputPath = path.resolve(rawInputPath);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) return { success: false, error: '输入视频不存在或不是文件' };
    if (isDedupedInput && !(await isDedupedInput(inputPath))) return { success: false, error: '该视频没有已完成去重标记；请先在视频处理完成去重，再进入 AI 漫剧重建' };
    const inputSha256 = await fileSha256(inputPath);
    const settings = { ...(getSettings?.() || {}), ...(payload.settings || {}) };
    const projectId = String(payload.projectId || `${safeName(path.parse(inputPath).name)}-${Date.now()}`);
    const current = jobs.get(projectId);
    if (current && ['queued', 'running'].includes(current.status)) return { success: false, error: '该项目正在处理', ...status(projectId) };
    const outputRoot = path.resolve(String(payload.outputRoot || path.join(path.dirname(inputPath), '重建工程')));
    const projectDir = path.join(outputRoot, safeName(projectId));
    const manifestPath = path.join(projectDir, 'episode-manifest.json');
    let savedManifest = null;
    if (payload.force !== true && fs.existsSync(manifestPath)) {
      try {
        const candidate = await readManifest(manifestPath);
        if (candidate.project_id === projectId && candidate.media?.original_file === inputPath && candidate.media?.source_sha256 === inputSha256) savedManifest = candidate;
      } catch (_) {}
    }
    const job = { projectId, batchId: randomUUID(), inputPath, inputSha256, outputRoot, projectDir, manifestPath, status: 'running', stage: null, manifest: savedManifest || emptyManifest({ projectId }), controller: new AbortController(), changedStages: {} };
    saveProjectRecord?.(projectId, { manifestPath, inputPath, outputRoot, projectDir });
    jobs.set(projectId, job);
    emit({ type: 'batch', projectId, batchId: job.batchId, status: 'running' });
    const signal = job.controller.signal;
    try {
      job.ffprobePath = payload.ffprobePath || getFfprobePath?.();
      job.ffmpegPath = payload.ffmpegPath || getFfmpegPath?.();
      await stageIfNeeded(job, 'media_baseline', () => {
        const media = job.manifest.media;
        return media?.original_file === inputPath && media?.source_sha256 === inputSha256 && media?.working_file && fs.existsSync(media.working_file);
      }, async () => {
        const ffprobePath = job.ffprobePath;
        const ffmpegPath = job.ffmpegPath;
        if (!ffprobePath || !ffmpegPath) throw new Error('未找到 FFmpeg/ffprobe，无法建立媒体基准');
        let media = await probeMedia(ffprobePath, inputPath, { signal });
        if (mediaNeedsNormalization(media)) {
          const workPath = path.join(projectDir, 'media', 'working.mp4');
          media = await normalizeMedia({ ffmpegPath, ffprobePath, media, outputPath: workPath, signal });
        }
        job.manifest.media = media;
        return { output_paths: media.working_file !== inputPath ? [media.working_file] : [] };
      });

      await stageIfNeeded(job, 'shot_detection', () => !job.changedStages.media_baseline && Array.isArray(job.manifest.shots) && job.manifest.shots.length > 0, async () => {
        const packaged = settings.isPackaged === true;
        const command = settings.scene_detector_command && typeof settings.scene_detector_command === 'object'
          ? settings.scene_detector_command
          : null;
        if (packaged && !command?.command) throw new Error('应用内置 AdaptiveDetector 缺失；请使用包含镜头检测运行时的完整安装包，不会调用系统 Python');
        const pythonPath = String(payload.pythonPath || settings.scene_detector_python || 'python3');
        const cuts = await detectAdaptiveCuts({ command: command?.command || null, commandArgs: command?.prefixArgs || [], pythonPath, inputPath: job.manifest.media.working_file, minSceneSeconds: Number(settings.scene_min_seconds) || 0.2, adaptiveThreshold: Number(settings.scene_adaptive_threshold) || 3, signal });
        const shots = buildShotsFromCuts(job.manifest.media, cuts);
        for (const shot of shots) {
          shot.start_us = frameToUs(shot.start_frame, job.manifest.media.fps_num, job.manifest.media.fps_den);
          shot.end_us = frameToUs(shot.end_frame_exclusive, job.manifest.media.fps_num, job.manifest.media.fps_den);
          shot.duration_us = shot.end_us - shot.start_us;
          if (shot.representative_frame < shot.start_frame || shot.representative_frame >= shot.end_frame_exclusive) shot.representative_frame = shot.start_frame;
        }
        job.manifest.shots = shots;
        return { output_paths: [] };
      }, { detector: 'AdaptiveDetector', min_scene_seconds: Number(settings.scene_min_seconds) || 0.2, adaptive_threshold: Number(settings.scene_adaptive_threshold) || 3 });

      await stageIfNeeded(job, 'source_assets', () => !job.changedStages.media_baseline && !job.changedStages.shot_detection && job.manifest.shots.length > 0 && job.manifest.shots.every(shot => shot.preview_asset_id && shot.clip_asset_id && job.manifest.assets.some(asset => asset.asset_id === shot.preview_asset_id && asset.status === 'ready' && fs.existsSync(asset.path)) && job.manifest.assets.some(asset => asset.asset_id === shot.clip_asset_id && asset.status === 'ready' && fs.existsSync(asset.path))), async () => {
        const assetDir = path.join(projectDir, 'assets', 'shots');
        await fsp.mkdir(assetDir, { recursive: true });
        const shotIds = new Set(job.manifest.shots.map(shot => shot.shot_id));
        job.manifest.assets = job.manifest.assets.filter(asset => !Array.isArray(asset.used_by_ids) || !asset.used_by_ids.some(id => shotIds.has(String(id))));
        for (const shot of job.manifest.shots) { shot.preview_asset_id = null; shot.clip_asset_id = null; }
        const outputPaths = [];
        await mapLimit(job.manifest.shots, concurrency(settings), async (shot) => {
          const files = await extractShot(job.ffmpegPath, job.ffprobePath, job.manifest.media.working_file, shot, assetDir, signal, job.manifest.media.fps_num, job.manifest.media.fps_den, job.manifest.media);
          const previewAssetId = `asset_${shot.shot_id}_preview`;
          const clipAssetId = `asset_${shot.shot_id}_clip`;
          job.manifest.assets.push(
            { asset_id: previewAssetId, kind: 'shot_preview', path: files.previewPath, origin: 'source_frame', source_frame_index: shot.representative_frame, crop_xyxy: null, used_by_ids: [shot.shot_id], status: 'ready' },
            { asset_id: clipAssetId, kind: 'video_clip', path: files.clipPath, origin: 'source_clip', source_frame_index: null, crop_xyxy: null, used_by_ids: [shot.shot_id], status: 'ready' },
          );
          shot.preview_asset_id = previewAssetId;
          shot.clip_asset_id = clipAssetId;
          outputPaths.push(files.previewPath, files.clipPath);
        }, signal, (done, total) => emit({ type: 'stage', projectId, batchId: job.batchId, stage: 'source_assets', status: 'running', ...progressValue('source_assets', done, total) }));
        rebuildTimeline(job.manifest);
        return { output_paths: outputPaths };
      });

      rebuildTimeline(job.manifest);
      job.manifest.outputs = { ...(job.manifest.outputs || {}), manifest_path: manifestPath };

      const frameInputs = job.manifest.shots.map(shot => ({ path: job.manifest.assets.find(asset => asset.asset_id === shot.preview_asset_id)?.path, label: `shot_id=${shot.shot_id}, representative_frame=${shot.representative_frame}` }));
      await stageIfNeeded(job, 'qwen_global', () => !job.changedStages.media_baseline && !job.changedStages.shot_detection && !job.changedStages.source_assets, async () => {
        const result = await qwen.analyzeGlobal({ videoPath: job.manifest.media.working_file, videoUrl: payload.qwenVideoUrl || settings.qwen_video_url, representativeFrames: frameInputs, metadata: { project_id: projectId, media: job.manifest.media, shots: job.manifest.shots.map(shot => ({ shot_id: shot.shot_id, representative_frame: shot.representative_frame })) }, settings, signal });
        job.manifest = mergeGlobal(job.manifest, result.data);
        job.manifest.usage = { ...(job.manifest.usage || {}), qwen_global: result.usage };
        const referencePaths = await extractReferenceAssets({
          ffmpegPath: job.ffmpegPath,
          media: job.manifest.media,
          manifest: job.manifest,
          outputDir: path.join(projectDir, 'assets', 'refs'),
          signal,
          concurrencyLimit: concurrency(settings),
        });
        return { output_paths: referencePaths };
      }, { model: settings.qwen_model, reasoning_effort: settings.qwen_reasoning_effort || 'none', base_url: settings.qwen_base_url, video_url: payload.qwenVideoUrl || settings.qwen_video_url || '', max_inline_bytes: settings.qwen_max_inline_bytes });

      await stageIfNeeded(job, 'qwen_shots', () => !job.changedStages.media_baseline && !job.changedStages.shot_detection && !job.changedStages.source_assets && !job.changedStages.qwen_global, async () => {
        const batchSize = Math.max(1, Math.min(8, Number(settings.qwen_batch_size) || 4));
        const allResults = [];
        const usage = [];
        for (let offset = 0; offset < job.manifest.shots.length; offset += batchSize) {
          const batch = job.manifest.shots.slice(offset, offset + batchSize);
          const result = await analyzeShotBatchWithRecovery({
            batch,
            settings,
            signal,
            buildInputs: currentBatch => ({
              videoPaths: currentBatch.map(shot => ({ path: job.manifest.assets.find(asset => asset.asset_id === shot.clip_asset_id)?.path, label: `shot_id=${shot.shot_id}, start_frame=${shot.start_frame}, end_frame_exclusive=${shot.end_frame_exclusive}` })).filter(item => item.path),
              shots: currentBatch,
              frames: currentBatch.map(shot => ({ path: job.manifest.assets.find(asset => asset.asset_id === shot.preview_asset_id)?.path, label: `shot_id=${shot.shot_id}, representative_frame=${shot.representative_frame}` })),
              dictionaries: { styles: job.manifest.styles, characters: job.manifest.characters, scenes: job.manifest.scenes },
              metadata: { project_id: projectId },
            }),
          });
          allResults.push(...result.data);
          usage.push(...result.usage);
          emit({ type: 'stage', projectId, batchId: job.batchId, stage: 'qwen_shots', status: 'running', ...progressValue('qwen_shots', Math.min(offset + batch.length, job.manifest.shots.length), job.manifest.shots.length) });
        }
        job.manifest = mergeShotResults(job.manifest, allResults);
        job.manifest.usage = { ...(job.manifest.usage || {}), qwen_shots: usage };
        return { output_paths: [] };
      }, { model: settings.qwen_model, reasoning_effort: settings.qwen_reasoning_effort || 'none', base_url: settings.qwen_base_url, batch_size: Number(settings.qwen_batch_size) || 4 });

      const optionalStageErrors = [];
      try {
        await stageIfNeeded(job, 'background_audio', () => !job.changedStages.media_baseline && (settings.reconstruction_background_audio === false || job.manifest.assets.some(asset => asset.kind === 'background_audio' && asset.status === 'ready' && fs.existsSync(asset.path))), async () => {
          if (settings.reconstruction_background_audio === false) return { output_paths: [] };
          const pythonPath = String(settings.demucs_python_path || 'python3');
          const outputDir = path.join(projectDir, 'assets', 'audio');
          await fsp.mkdir(outputDir, { recursive: true });
          await runProcess(pythonPath, ['-m', 'demucs.separate', '-n', String(settings.demucs_model || 'htdemucs'), '--two-stems=vocals', '-o', outputDir, job.manifest.media.working_file], { signal });
          const stem = path.parse(job.manifest.media.working_file).name;
          const candidate = path.join(outputDir, String(settings.demucs_model || 'htdemucs'), stem, 'no_vocals.wav');
          if (!fs.existsSync(candidate)) throw new Error('Demucs 未生成 no_vocals.wav');
          const assetId = 'asset_background_audio';
          job.manifest.assets.push({ asset_id: assetId, kind: 'background_audio', path: candidate, origin: 'separated_audio', source_frame_index: null, crop_xyxy: null, used_by_ids: [], status: 'ready' });
          job.manifest.timeline.background = { ...job.manifest.timeline.background, asset_id: assetId, duration_us: job.manifest.media.duration_us, volume: 0 };
          return { output_paths: [candidate] };
        }, { enabled: settings.reconstruction_background_audio !== false, python: settings.demucs_python_path || 'python3', model: settings.demucs_model || 'htdemucs' });
      } catch (error) {
        if (error?.code !== 'RECONSTRUCTION_STAGE_BLOCKED') throw error;
        optionalStageErrors.push(`背景音阶段已阻塞：${stageError(error)}`);
      }

      await stageIfNeeded(job, 'manifest_validation', () => !job.changedStages.media_baseline && !job.changedStages.shot_detection && !job.changedStages.source_assets && !job.changedStages.qwen_global && !job.changedStages.qwen_shots && !job.changedStages.background_audio, async () => {
        const check = validateManifest(job.manifest, { checkFiles: true });
        if (!check.valid) throw new Error(`manifest 校验失败：${check.errors.slice(0, 12).join('；')}`);
        return { output_paths: [manifestPath] };
      });
      await stageIfNeeded(job, 'subtitle_export', () => !job.changedStages.qwen_global && !job.changedStages.qwen_shots && !job.changedStages.manifest_validation && !!job.manifest.outputs?.srt_path && fs.existsSync(job.manifest.outputs.srt_path), async () => {
        const srtPath = path.join(projectDir, 'subtitles', `${safeName(projectId)}.srt`);
        await writeSubtitleExport(job.manifest, srtPath);
        job.manifest.outputs = { ...(job.manifest.outputs || {}), srt_path: srtPath };
        job.manifest.timeline.subtitles = { ...job.manifest.timeline.subtitles, cue_ids: job.manifest.subtitle_cues.map(cue => cue.subtitle_id) };
        return { output_paths: [srtPath] };
      });
      await stageIfNeeded(job, 'html_export', () => !job.changedStages.media_baseline && !job.changedStages.shot_detection && !job.changedStages.source_assets && !job.changedStages.qwen_global && !job.changedStages.qwen_shots && !job.changedStages.manifest_validation && !!job.manifest.outputs?.html_path && fs.existsSync(job.manifest.outputs.html_path), async () => {
        const htmlPath = path.join(projectDir, 'engineering', 'index.html');
        await writeEngineeringHtml(job.manifest, htmlPath);
        job.manifest.outputs = { ...(job.manifest.outputs || {}), html_path: htmlPath };
        return { output_paths: [htmlPath] };
      });
      // PNG 和剪映草稿需要用户提供的模板及已验证的剪映版本；这里明确阻塞，
      // 不能用截图或伪造草稿冒充完成。
      await setStage(job, 'png_export', 'blocked', { error: '尚未配置用户 HTML 模板的 PNG 导出器', output_paths: [] });
      await setStage(job, 'jianying_draft', 'blocked', { error: '尚未配置并验证目标剪映版本的草稿写入器', output_paths: [] });
      job.status = 'partial';
      job.error = ['manifest、独立镜头、SRT 和 HTML 已输出；PNG 与剪映草稿阶段等待模板/版本适配', ...optionalStageErrors].join('；');
      await save(job, { allowInvalid: true, checkFiles: true });
      emit({ type: 'batch', projectId, batchId: job.batchId, status: job.status, manifestPath });
      return { success: true, partial: true, ...status(projectId) };
    } catch (error) {
      job.status = job.controller.signal.aborted ? 'stopped' : error?.code === 'RECONSTRUCTION_STAGE_BLOCKED' ? 'partial' : 'failed';
      job.error = stageError(error);
      await save(job, { allowInvalid: true }).catch(() => {});
      emit({ type: 'batch', projectId, batchId: job.batchId, status: job.status, stage: job.stage, error: job.error, manifestPath });
      return { success: false, partial: job.status === 'partial', ...status(projectId), error: job.error };
    }
  }

  function cancel(projectId) {
    const job = jobs.get(String(projectId));
    if (!job || !['queued', 'running'].includes(job.status)) return { success: false, error: '项目不存在或已经结束' };
    job.controller.abort(new Error('任务已取消'));
    return { success: true };
  }

  return { start, cancel, status };
}

module.exports = { createReconstructionPipeline, mergeGlobal, mergeShotResults, cleanActionBeats, rebuildTimeline, rebuildWorkflowGraph };
