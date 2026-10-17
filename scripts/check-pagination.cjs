// 分页：页数、夹取、切片、页码窗口、跳转输入。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.resolve(__dirname, '../src/components/pagination.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', transformSync(source, { format: 'cjs' }).code)(mod, mod.exports);
const { pageCount, clampPage, slicePage, pageWindow, parseJump } = mod.exports;

assert.equal(pageCount(0, 30), 1, 'an empty list still has one page');
assert.equal(pageCount(30, 30), 1);
assert.equal(pageCount(31, 30), 2);
assert.equal(pageCount(250, 100), 3);

assert.equal(clampPage(0, 100, 30), 1);
assert.equal(clampPage(99, 100, 30), 4);
assert.equal(clampPage('abc', 100, 30), 1);
assert.equal(clampPage(2.7, 100, 30), 2);

const list = Array.from({ length: 65 }, (_, i) => i + 1);
assert.deepEqual(slicePage(list, 1, 30), list.slice(0, 30));
assert.deepEqual(slicePage(list, 3, 30), [61, 62, 63, 64, 65]);
assert.deepEqual(slicePage(list, 9, 30), [61, 62, 63, 64, 65], 'a page past the end falls back to the last page');
assert.deepEqual(slicePage([], 1, 30), []);

assert.deepEqual(pageWindow(1, 1), [1]);
assert.deepEqual(pageWindow(1, 5), [1, 2, 3, 4, 5]);
assert.deepEqual(pageWindow(1, 20), [1, 2, 3, null, 20]);
assert.deepEqual(pageWindow(6, 10), [1, null, 4, 5, 6, 7, 8, 9, 10], 'a gap of one page shows it, not an ellipsis');
assert.deepEqual(pageWindow(10, 20), [1, null, 8, 9, 10, 11, 12, null, 20]);
assert.deepEqual(pageWindow(20, 20), [1, null, 18, 19, 20]);

assert.equal(parseJump('5', 10), 5);
assert.equal(parseJump(' 7 ', 10), 7);
assert.equal(parseJump('99', 10), 10, 'beyond the last page goes to the last page');
assert.equal(parseJump('0', 10), 1);
assert.equal(parseJump('', 10), null);
assert.equal(parseJump('abc', 10), null);
assert.equal(parseJump('2.5', 10), null);
assert.equal(parseJump('-3', 10), null);
console.log('PASS pagination helpers');
