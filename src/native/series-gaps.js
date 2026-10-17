'use strict';
// 选中的集之间缺了哪几集，以及每一集为什么缺。
// 「平台无此集 / 已锁定」是来源本来就没有、下载不了，默认直接拼；
// 「没下载 / 下载中 / 下载失败」平台有、还能补，要让用户决定；
// 「未知」是导入的文件夹，软件不知道缺的集是平台没有还是没下载，也要让用户决定（可记住）。

const STATE_TEXT = {
  absent: '平台无此集',
  locked: '已锁定未解锁',
  notDownloaded: '没下载',
  downloading: '下载中',
  failed: '下载失败',
  unknown: '缺集（不确定原因）',
  confirmed: '已确认本来就缺',
};
const SPLICE_BY_DEFAULT = new Set(['absent', 'locked', 'confirmed']);
const DOWNLOADABLE = new Set(['notDownloaded', 'downloading', 'failed']);

/**
 * 1..upTo 里不在磁盘上的每一集，判断缺的原因。
 * remote 是平台的分集列表 [{ vid_index, locked }]，导入的文件夹没有，传 null。
 * tasks 是 index -> 'active' | 'failed'，来自下载记录。
 */
function classifyMissing({ onDisk, remote, tasks = new Map(), upTo }) {
  const byIndex = new Map((remote || []).map((episode) => [Number(episode.vid_index), episode]));
  const result = [];
  for (let index = 1; index <= upTo; index++) {
    if (onDisk.has(index)) continue;
    let state;
    if (!remote) state = 'unknown';
    else {
      const episode = byIndex.get(index);
      if (!episode) state = 'absent';
      else if (episode.locked) state = 'locked';
      else if (tasks.get(index) === 'active') state = 'downloading';
      else if (tasks.get(index) === 'failed') state = 'failed';
      else state = 'notDownloaded';
    }
    result.push({ index, state });
  }
  return result;
}

/**
 * 看选中的集之间的缺口。只看两个相邻选中集之间不在磁盘上的集；
 * 磁盘上有、但用户没选的集是用户自己的选择，不算缺口。
 * 返回 blocking（要用户决定）和 notes（直接拼，只提示）。
 */
function summarizeGaps({ selected, missing, confirmed = new Set() }) {
  const indices = [...new Set(selected.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  const stateOf = new Map(missing.map((item) => [item.index, item.state]));
  const blocking = [];
  const notes = [];
  for (let i = 1; i < indices.length; i++) {
    for (let index = indices[i - 1] + 1; index < indices[i]; index++) {
      let state = stateOf.get(index);
      if (!state) continue;
      if (state === 'unknown' && confirmed.has(index)) state = 'confirmed';
      (SPLICE_BY_DEFAULT.has(state) ? notes : blocking).push({ index, state });
    }
  }
  return { blocking, notes };
}

/** [3,4,5,9] -> "第 3–5、9 集" */
function describeIndices(list) {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return `第 ${parts.join('、')} 集`;
}

module.exports = { STATE_TEXT, DOWNLOADABLE, classifyMissing, summarizeGaps, describeIndices };
