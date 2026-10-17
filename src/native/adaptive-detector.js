'use strict';

const path = require('node:path');
const { runProcess } = require('./reconstruction-media');

function buildShotsFromCuts(media, cuts = []) {
  const total = Number(media?.total_frames);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('工作视频总帧数无效，无法建立镜头清单');
  const points = [0, ...cuts.map(item => Number(item?.frame)).filter(frame => Number.isSafeInteger(frame) && frame > 0 && frame < total), total];
  const unique = [...new Set(points)].sort((a, b) => a - b);
  const shots = [];
  for (let index = 0; index < unique.length - 1; index += 1) {
    const start = unique[index];
    const end = unique[index + 1];
    const cut = cuts.find(item => Number(item?.frame) === start);
    shots.push({
      shot_id: `shot_${String(index + 1).padStart(3, '0')}`,
      order: index + 1,
      start_frame: start,
      end_frame_exclusive: end,
      frame_count: end - start,
      start_us: null,
      end_us: null,
      duration_us: null,
      boundary_kind: index === 0 ? 'start' : cut?.boundary_kind || 'hard_cut',
      boundary_status: cut?.boundary_status || 'detected',
      boundary_score: cut?.score ?? null,
      scene_id: null,
      character_ids: [],
      appearance_ids: [],
      shot_size: 'unknown',
      camera_angle: 'unknown',
      composition: '',
      camera_movement: [],
      start_state: '',
      action_beats: [],
      end_state: '',
      subtitle_ids: [],
      audio_event_ids: [],
      representative_frame: start + Math.max(0, Math.min(end - start - 1, Math.floor((end - start) / 2))),
      preview_asset_id: null,
      clip_asset_id: null,
      continuity: { previous_shot_id: index > 0 ? `shot_${String(index).padStart(3, '0')}` : null, next_shot_id: null, constraints: [] },
      visual_description: '',
      uncertainty_codes: [],
    });
  }
  for (let index = 0; index < shots.length; index += 1) shots[index].continuity.next_shot_id = shots[index + 1]?.shot_id || null;
  return shots;
}

async function detectAdaptiveCuts({ command = null, commandArgs = [], pythonPath = 'python3', scriptPath = path.join(__dirname, 'scenedetect_runner.py'), inputPath, minSceneSeconds = 0.2, adaptiveThreshold = 3, signal }) {
  if (!inputPath) throw new Error('缺少镜头检测输入视频');
  const args = command
    ? [...commandArgs, '--scene-detect', inputPath, '--min-scene-seconds', String(minSceneSeconds), '--adaptive-threshold', String(adaptiveThreshold)]
    : [scriptPath, inputPath, '--min-scene-seconds', String(minSceneSeconds), '--adaptive-threshold', String(adaptiveThreshold)];
  const result = await runProcess(command || pythonPath, args, { signal });
  let payload;
  try { payload = JSON.parse(result.stdout); } catch (_) { throw new Error(`AdaptiveDetector 返回的数据不是有效 JSON：${result.stdout.slice(-1000)}`); }
  if (!Array.isArray(payload.cuts)) throw new Error('AdaptiveDetector 未返回 cuts 数组');
  return payload.cuts.map(item => ({
    frame: Number(item.frame),
    score: item.score == null ? null : Number(item.score),
    reason: String(item.reason || 'AdaptiveDetector 镜头边界'),
    boundary_kind: item.boundary_kind || 'hard_cut',
    boundary_status: item.boundary_status || 'detected',
  })).filter(item => Number.isSafeInteger(item.frame) && item.frame > 0);
}

module.exports = { detectAdaptiveCuts, buildShotsFromCuts };
