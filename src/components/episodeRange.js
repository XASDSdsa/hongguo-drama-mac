// Match whole tokens; clamp iteration to the actual episode count.
export function parseEpisodeRange(value, total) {
  const parts = String(value || '')
    .trim()
    .split(/[,，]/);
  const selected = new Set();
  for (const part of parts) {
    const match = part.trim().match(/^(\d+)(?:\s*[-~～]\s*(\d+))?$/);
    if (!match) throw new Error('集数格式不正确，请输入 1-30 或 1，5，10；原选择已保留。');
    const a = Number(match[1]),
      b = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) {
      throw new Error('集数必须是大于 0 的整数；原选择已保留。');
    }
    for (let n = Math.max(1, Math.min(a, b)); n <= Math.min(total, Math.max(a, b)); n++) selected.add(n);
  }
  if (!selected.size) throw new Error(`集数超出范围，请选择 1-${total} 集；原选择已保留。`);
  return selected;
}

export const isSubmitKey = (event) =>
  event.key === 'Enter' && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229;
