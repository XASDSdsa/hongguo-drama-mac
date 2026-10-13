const assert = require('node:assert/strict');
const { refineCutPoint, refineSplitPoints } = require('../src/native/cut-point-refiner');

const chosen = refineCutPoint(100, [
  { time: 92, speechEnergy: 0.3, sceneScore: 0.9 },
  { time: 104, speechEnergy: 0.05, confidence: 0.8 },
]);
assert.equal(chosen.time, 104);
assert.equal(chosen.status, 'ok');
assert.equal(chosen.source, 'silence');

const warning = refineCutPoint(100, [{ time: 98, speechEnergy: 0.6, sceneScore: 0.1 }]);
assert.equal(warning.time, 100);
assert.equal(warning.status, 'warn');

const points = refineSplitPoints([{ time: 20, reason: '话题转换' }], [{ time: 21, sceneChange: true }]);
assert.equal(points[0].time, 21);
assert.equal(points[0].semanticTime, 20);
console.log('PASS semantic cut-point refinement never forces an unsupported nearest boundary');
