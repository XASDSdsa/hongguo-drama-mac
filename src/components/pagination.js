// 分页的纯计算：页数、当前页夹取、切片、页码窗口、跳转输入解析。

export const pageCount = (total, pageSize) => Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));

export const clampPage = (page, total, pageSize) =>
  Math.min(Math.max(1, Math.floor(Number(page)) || 1), pageCount(total, pageSize));

export function slicePage(list, page, pageSize) {
  const current = clampPage(page, list.length, pageSize);
  return list.slice((current - 1) * pageSize, current * pageSize);
}

/** 页码按钮：首页、末页、当前页前后各 2 页，中间用 null 表示省略号。 */
export function pageWindow(current, count, around = 2) {
  const wanted = new Set([1, count]);
  for (let page = current - around; page <= current + around; page++) if (page >= 1 && page <= count) wanted.add(page);
  const sorted = [...wanted].sort((a, b) => a - b);
  const result = [];
  sorted.forEach((page, index) => {
    const gap = index ? page - sorted[index - 1] : 0;
    if (gap === 2)
      result.push(page - 1); // 只隔一页时直接显示，不用省略号
    else if (gap > 2) result.push(null);
    result.push(page);
  });
  return result;
}

/** 跳转框里输入的内容 -> 合法页码；空、非数字、小数返回 null，超范围夹到首/末页。 */
export function parseJump(text, count) {
  const value = String(text ?? '').trim();
  if (!/^\d+$/.test(value)) return null;
  return Math.min(Math.max(1, Number(value)), count);
}
