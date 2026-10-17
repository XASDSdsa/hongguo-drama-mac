'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function srtTime(value) {
  const ms = Math.max(0, Math.round(Number(value || 0) / 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function renderSrt(cues) {
  return (Array.isArray(cues) ? cues : [])
    .filter(cue => Number.isSafeInteger(Number(cue?.start_us)) && Number.isSafeInteger(Number(cue?.end_us)) && Number(cue.end_us) > Number(cue.start_us) && String(cue.display_text || cue.spoken_text || '').trim())
    .sort((a, b) => Number(a.start_us) - Number(b.start_us))
    .map((cue, index) => `${index + 1}\n${srtTime(cue.start_us)} --> ${srtTime(cue.end_us)}\n${String(cue.display_text || cue.spoken_text).trim()}\n`)
    .join('\n');
}

async function writeTextAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try { await fsp.writeFile(temporary, content, 'utf8'); await fsp.rename(temporary, filePath); }
  finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
}

async function writeSubtitleExport(manifest, filePath) {
  await writeTextAtomic(filePath, renderSrt(manifest.subtitle_cues));
  return filePath;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function displayTime(us) {
  const total = Math.max(0, Math.round(Number(us || 0) / 1000));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function frameOffsetTime(manifest, shot) {
  const offset = Math.max(0, Number(shot?.representative_frame) - Number(shot?.start_frame));
  const fpsNum = Number(manifest.media?.fps_num);
  const fpsDen = Number(manifest.media?.fps_den);
  if (Number.isSafeInteger(fpsNum) && Number.isSafeInteger(fpsDen) && fpsNum > 0 && fpsDen > 0) return Math.round(offset * fpsDen * 1_000_000 / fpsNum);
  return Math.round(offset * Number(shot?.duration_us || 0) / Math.max(1, Number(shot?.frame_count || 1)));
}

function listText(items, key, fallback = '待确认') {
  const values = (Array.isArray(items) ? items : []).map(item => item?.[key] || item?.name || item?.display_name || item?.render_type || item?.id).filter(Boolean);
  return values.length ? values.join('、') : fallback;
}

function relativeAsset(manifest, filePath) {
  return filePath ? path.relative(path.dirname(manifest.__html_path || ''), filePath).split(path.sep).join('/') : '';
}

function renderReferenceImages(manifest, ids, label) {
  const assets = (Array.isArray(ids) ? ids : [])
    .map(id => manifest.assets?.find(asset => String(asset.asset_id) === String(id)))
    .filter(asset => asset?.status === 'ready' && asset.path);
  if (!assets.length) return '';
  return `<div class="reference-strip"><span class="reference-label">${escapeHtml(label)}</span>${assets.map(asset => `<a href="${escapeHtml(relativeAsset(manifest, asset.path))}" target="_blank" rel="noreferrer"><img src="${escapeHtml(relativeAsset(manifest, asset.path))}" alt="${escapeHtml(asset.asset_id)}"><small>${escapeHtml(asset.asset_id)}</small></a>`).join('')}</div>`;
}

function renderPromptTimeline(shot) {
  const timeline = shot.prompt_parts?.timeline;
  if (!Array.isArray(timeline) || !timeline.length) return '';
  return `<details class="timeline"><summary>镜头内提示词时间线</summary><ol>${timeline.map(item => { const start = item.start_us ?? item.local_start_us; const end = item.end_us ?? item.local_end_us; return `<li><b>${escapeHtml(`${displayTime(start)}–${displayTime(end)}`)}</b><span>${escapeHtml(item.description || item.action || item.text || JSON.stringify(item))}</span></li>`; }).join('')}</ol></details>`;
}

function renderEngineeringHtml(manifest) {
  const cards = (manifest.shots || []).map(shot => {
    const preview = manifest.assets?.find(asset => asset.asset_id === shot.preview_asset_id);
    const clip = manifest.assets?.find(asset => asset.asset_id === shot.clip_asset_id);
    const relative = value => relativeAsset(manifest, value);
    const beats = (shot.action_beats || []).map(beat => `<li><b>${escapeHtml(`${displayTime(beat.local_start_us)}–${displayTime(beat.local_end_us)}`)}</b> ${escapeHtml(beat.description || beat.action || beat.text || '动作待确认')}</li>`).join('');
    const scene = manifest.scenes?.find(item => String(item.scene_id) === String(shot.scene_id));
    const characters = (shot.character_ids || []).map(id => manifest.characters?.find(item => String(item.character_id) === String(id))).filter(Boolean);
    const referenceIds = [...characters.flatMap(item => item.reference_asset_ids || []), ...(scene?.reference_asset_ids || [])];
    const subtitles = (shot.subtitle_ids || []).map(id => manifest.subtitle_cues?.find(item => String(item.subtitle_id) === String(id))).filter(Boolean);
    const audio = (shot.audio_event_ids || []).map(id => manifest.audio_events?.find(item => String(item.audio_event_id) === String(id))).filter(Boolean);
    const video = clip ? `<div class="media-title">成片参考片段</div><video controls preload="metadata" playsinline poster="${escapeHtml(preview ? relative(preview.path) : '')}" src="${escapeHtml(relative(clip.path))}"></video>` : '<div class="missing">暂无成片参考片段</div>';
    const subtitleText = subtitles.map(cue => `${displayTime(cue.start_us)}–${displayTime(cue.end_us)} ${cue.display_text || cue.spoken_text || ''}`).join('；');
    const audioText = audio.map(event => `${event.type || '声音'}：${event.description || event.text || ''}`).join('；');
    return `<article class="shot"><header><b>${escapeHtml(shot.shot_id)}</b><span>帧 ${escapeHtml(`${shot.start_frame}–${shot.end_frame_exclusive}`)} · ${escapeHtml(`${displayTime(shot.start_us)}–${displayTime(shot.end_us)}`)}</span></header><div class="media">${video}${preview ? `<a class="preview" href="${escapeHtml(relative(preview.path))}" target="_blank" rel="noreferrer"><img src="${escapeHtml(relative(preview.path))}" alt="${escapeHtml(shot.shot_id)} 代表帧"><span>代表帧 · ${escapeHtml(displayTime(frameOffsetTime(manifest, shot)))}</span></a>` : ''}</div><div class="copy"><h3>${escapeHtml(shot.visual_description || '待千问补充镜头描述')}</h3><p>景别：${escapeHtml(shot.shot_size || '待确认')} · 视角：${escapeHtml(shot.camera_angle || '待确认')} · 场景：${escapeHtml(scene?.name || shot.scene_id || '待确认')} · 角色：${escapeHtml(characters.map(item => item.display_name || item.character_id).join('、') || '待确认')}</p>${renderReferenceImages(manifest, referenceIds, '提示词参考')}${beats ? `<h4>动作与表演</h4><ol>${beats}</ol>` : ''}${subtitleText ? `<p><b>对白/字幕：</b>${escapeHtml(subtitleText)}</p>` : ''}${audioText ? `<p><b>声音：</b>${escapeHtml(audioText)}</p>` : ''}${renderPromptTimeline(shot)}${shot.prompt_text ? `<details><summary>复现提示词（推导方案）</summary><pre>${escapeHtml(shot.prompt_text)}</pre></details>` : ''}</div></article>`;
  }).join('\n');
  const styleSummary = listText(manifest.styles, 'name');
  const characterSummary = listText(manifest.characters, 'name');
  const sceneSummary = listText(manifest.scenes, 'name');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(manifest.project_id)} 工程图</title><style>body{margin:0;padding:24px;background:#0b0e14;color:#dce3ef;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}h1{font-size:22px}h2{font-size:15px;margin:24px 0 8px}h4{margin:13px 0 5px;color:#b5c5df}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;color:#a9b8cf}.meta div{padding:10px;border:1px solid #2b374d;border-radius:8px;background:#111620}.shot{display:grid;grid-template-columns:330px 1fr;gap:18px;padding:16px;margin:14px 0;border:1px solid #2b374d;border-radius:8px;background:#111620}.shot header{grid-column:1/-1;display:flex;justify-content:space-between;color:#9fb7e5}.media{display:flex;flex-direction:column;gap:8px}.media-title,.reference-label{color:#8fa6c8;font-size:12px}.media video{width:100%;max-height:620px;aspect-ratio:9/16;object-fit:contain;background:#05070b;border-radius:6px}.media .preview{display:flex;flex-direction:column;gap:4px;color:#8fa6c8;text-decoration:none}.media img{width:100%;max-height:260px;object-fit:contain;background:#0d141e;border-radius:6px}.copy h3{margin:0 0 8px;font-size:17px}.copy p{color:#a9b8cf}.copy ol{margin:8px 0 12px;padding-left:22px;color:#c2cde0}.copy li{margin:4px 0}.copy details{margin-top:12px}.copy pre{max-height:320px;overflow:auto;padding:10px;background:#0b0f16;border-radius:6px;color:#b9c9e5;white-space:pre-wrap}.reference-strip{display:flex;align-items:flex-start;flex-wrap:wrap;gap:8px;margin:10px 0}.reference-strip>a{display:flex;flex-direction:column;gap:2px;color:#8fa6c8;font-size:10px;text-decoration:none}.reference-strip img{width:72px;height:96px;object-fit:contain;background:#0d141e;border:1px solid #2c3b55;border-radius:5px}.timeline{border:1px solid #2c3b55;border-radius:5px;padding:7px 10px;background:#0e141e}.timeline summary{cursor:pointer;color:#a9bee1}.timeline ol{margin:8px 0 0;padding-left:24px}.timeline li{margin:4px 0;color:#c2cde0}.timeline li span{display:block;margin-top:2px}.missing{display:grid;place-items:center;aspect-ratio:9/16;border:1px dashed #394861;color:#7488aa}.hint{color:#8395b2}.blocked{color:#d9a56b}@media(max-width:760px){.shot{grid-template-columns:1fr}.meta{grid-template-columns:1fr}}</style><h1>${escapeHtml(manifest.project_id)} · 分镜工程图</h1><p class="hint">镜头边界、视频、代表帧、参考图、字幕和提示词均来自同一份 episode-manifest.json；视频控件支持播放、拖动和全屏。源视频片段标记为成片参考，未执行视频生成。</p><div class="meta"><div><b>风格</b><br>${escapeHtml(styleSummary)}</div><div><b>角色</b><br>${escapeHtml(characterSummary)}${renderReferenceImages(manifest, (manifest.characters || []).flatMap(item => item.reference_asset_ids || []), '角色参考')}</div><div><b>场景</b><br>${escapeHtml(sceneSummary)}${renderReferenceImages(manifest, (manifest.scenes || []).flatMap(item => item.reference_asset_ids || []), '场景参考')}</div></div><h2>连续镜头时间线（${escapeHtml(String((manifest.shots || []).length))} 个）</h2>${cards || '<p class="hint">暂无镜头。</p>'}</html>`;
}

async function writeEngineeringHtml(manifest, filePath) {
  const next = { ...manifest, __html_path: filePath };
  await writeTextAtomic(filePath, renderEngineeringHtml(next));
  return filePath;
}

module.exports = { renderSrt, writeSubtitleExport, renderEngineeringHtml, writeEngineeringHtml };
