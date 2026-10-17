'use strict';

/**
 * Refine LLM semantic split points without inventing a boundary.  The caller
 * supplies measurements from FFmpeg (silence/speech energy and scene score).
 * A nearby point is accepted only when it is evidence-backed; otherwise the
 * semantic second is retained with `warn` for human review.
 */

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function candidateTime(candidate) {
  return numeric(candidate?.time ?? candidate?.at ?? candidate?.timestamp);
}

function isReliableCandidate(candidate, options = {}) {
  const speechThreshold = Number.isFinite(Number(options.speechEnergyThreshold))
    ? Number(options.speechEnergyThreshold)
    : 0.12;
  const sceneThreshold = Number.isFinite(Number(options.sceneChangeThreshold))
    ? Number(options.sceneChangeThreshold)
    : 0.4;
  const energy = numeric(candidate?.speechEnergy ?? candidate?.voiceEnergy ?? candidate?.rms);
  const scene = numeric(candidate?.sceneScore ?? candidate?.sceneChangeScore ?? candidate?.scene);
  const lowSpeech =
    candidate?.lowSpeech === true || candidate?.silence === true || (energy != null && energy <= speechThreshold);
  const shotChange = candidate?.sceneChange === true || (scene != null && scene >= sceneThreshold);
  return { reliable: lowSpeech || shotChange, lowSpeech, shotChange };
}

function refineCutPoint(semanticPoint, candidates = [], options = {}) {
  const semantic = numeric(semanticPoint);
  if (semantic == null || semantic < 0) throw new Error('语义切点必须是非负秒数');
  const window = Number.isFinite(Number(options.windowSeconds)) ? Math.max(0, Number(options.windowSeconds)) : 15;
  const inWindow = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const time = candidateTime(candidate);
      const evidence = isReliableCandidate(candidate, options);
      return time == null ? null : { ...candidate, time, distance: Math.abs(time - semantic), ...evidence };
    })
    .filter(
      (candidate) =>
        candidate && candidate.time >= semantic - window && candidate.time <= semantic + window && candidate.reliable,
    );
  if (!inWindow.length) {
    return { time: semantic, source: 'semantic', status: 'warn', reason: '切点附近没有可靠的静音或真实镜头切换证据' };
  }
  inWindow.sort((a, b) => {
    const evidenceA = Number(a.lowSpeech) + Number(a.shotChange);
    const evidenceB = Number(b.lowSpeech) + Number(b.shotChange);
    return (
      evidenceB - evidenceA ||
      (Number(b.confidence) || 0) - (Number(a.confidence) || 0) ||
      a.distance - b.distance ||
      a.time - b.time
    );
  });
  const chosen = inWindow[0];
  return {
    time: chosen.time,
    source: chosen.shotChange && chosen.lowSpeech ? 'silence+scene' : chosen.shotChange ? 'scene' : 'silence',
    status: 'ok',
    distance: chosen.distance,
    confidence: Number(chosen.confidence) || null,
    reason: chosen.reason || '',
  };
}

function refineSplitPoints(splitPoints = [], candidates = [], options = {}) {
  return (Array.isArray(splitPoints) ? splitPoints : []).map((point) => {
    const semantic = typeof point === 'number' ? point : point?.time;
    const refined = refineCutPoint(semantic, candidates, options);
    return { ...refined, semanticTime: numeric(semantic), reason: point?.reason || refined.reason || '' };
  });
}

module.exports = { isReliableCandidate, refineCutPoint, refineSplitPoints };
