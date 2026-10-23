// 剧卡片上的「最后处理」：今天 18:56 / 昨天 09:12 / 10-21 14:03 / 2025-12-01（没处理过返回空字符串）。
export function processedText(ms, now = new Date()) {
  if (!(Number(ms) > 0)) return '';
  const date = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
