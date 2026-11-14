'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const hash = data => createHash('sha256').update(data).digest('hex');

// Electron's code and fuses remain byte-for-byte unchanged. Only the PE header
// and resource section (product version, icon and ASAR integrity hash) may vary.
function rangesOf(exe) {
  assert.equal(exe.toString('ascii', 0, 2), 'MZ');
  const pe = exe.readUInt32LE(60);
  assert.equal(exe.toString('ascii', pe, pe + 4), 'PE\0\0');
  const count = exe.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const sections = optional + exe.readUInt16LE(pe + 20);
  const ranges = [{ offset: 0, size: exe.readUInt32LE(optional + 60) }];
  for (let i = 0; i < count; i++) {
    const section = sections + i * 40;
    if (exe.toString('ascii', section, section + 8).replace(/\0.*$/, '') === '.rsrc') {
      ranges.push({ offset: exe.readUInt32LE(section + 20), size: exe.readUInt32LE(section + 16) });
    }
  }
  assert.equal(ranges.length, 2, 'Expected exactly one PE resource section');
  assert.ok(ranges[0].size > 0 && ranges[0].size <= ranges[1].offset);
  assert.ok(ranges[1].size > 0 && ranges[1].offset + ranges[1].size <= exe.length);
  return ranges;
}

function invariantHash(exe, ranges) {
  const digest = createHash('sha256');
  let offset = 0;
  for (const range of ranges) {
    digest.update(exe.subarray(offset, range.offset));
    offset = range.offset + range.size;
  }
  return digest.update(exe.subarray(offset)).digest('hex');
}

function makePatch(base, target) {
  const ranges = rangesOf(target);
  assert.equal(base.length, target.length, 'Electron changed: a separate runtime upgrade is required');
  assert.deepEqual(rangesOf(base), ranges, 'PE layout changed: a separate runtime upgrade is required');
  const immutableSha256 = invariantHash(base, ranges);
  assert.equal(invariantHash(target, ranges), immutableSha256, 'Electron code/fuses changed: refuse a small patch');
  const rebuilt = Buffer.from(base);
  const parts = ranges.map((range, i) => {
    const data = target.subarray(range.offset, range.offset + range.size);
    data.copy(rebuilt, range.offset);
    return { ...range, file: `exe-part-${i}.bin`, sha256: hash(data), data };
  });
  assert.equal(hash(rebuilt), hash(target), 'Patch must reproduce the exact signed-off EXE');
  return { size: target.length, immutableSha256, sha256: hash(target), parts };
}
module.exports = { hash, rangesOf, invariantHash, makePatch };
