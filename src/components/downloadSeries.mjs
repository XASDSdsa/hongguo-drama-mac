const STATUS_PRIORITY = { completed: 0, downloading: 1, pending: 2, failed: 3, stopped: 4 };

const hasId = value => value != null && String(value).trim() !== '';

export function downloadSeriesKey(task) {
  const id = task.hongguoInfo?.series_id;
  return hasId(id) ? `series:${String(id)}` : `task:${task.id}`;
}

function episodeKey(info, fallback) {
  const index = Number(info?.vid_index);
  if (Number.isInteger(index) && index > 0) return `episode:${index}`;
  return hasId(info?.vid) ? `vid:${String(info.vid)}` : `task:${fallback}`;
}

export function groupDownloadSeries(tasks, seriesList) {
  const registry = new Map(seriesList.map(series => [String(series.series_id), series]));
  const groups = new Map();
  for (const task of tasks) {
    const key = downloadSeriesKey(task);
    let group = groups.get(key);
    if (!group) {
      const seriesId = hasId(task.hongguoInfo?.series_id) ? String(task.hongguoInfo.series_id) : null;
      const series = seriesId === null ? null : registry.get(seriesId);
      const metadataTotal = Number(series?.total);
      const episodeTotal = new Set((series?.episodes || []).map((episode, index) => episodeKey(episode, index))).size;
      group = {
        key, seriesId, title: series?.series_title || '', cover: series?.cover || '',
        total: series ? Math.max(Number.isInteger(metadataTotal) && metadataTotal > 0 ? metadataTotal : 0, episodeTotal) || null : null,
        completed: 0, downloading: 0, pending: 0, failed: 0, stopped: 0,
        count: 0, updatedAt: 0, episodes: new Map(),
      };
      groups.set(key, group);
    }
    group.title ||= task.hongguoInfo?.series_title || task.videoInfo?.author || task.title || '';
    group.cover ||= task.videoInfo?.cover || task.batchInfo?.avatar || '';
    const startTime = Number(task.startTime);
    if (Number.isFinite(startTime)) group.updatedAt = Math.max(group.updatedAt, startTime);
    const episode = episodeKey(task.hongguoInfo, task.id);
    const previous = group.episodes.get(episode);
    if (!previous || (STATUS_PRIORITY[task.status] ?? Infinity) < (STATUS_PRIORITY[previous.status] ?? Infinity)) {
      group.episodes.set(episode, task);
    }
  }
  return [...groups.values()].map(({ episodes, ...group }) => {
    group.title ||= '未命名短剧';
    group.count = episodes.size;
    if (group.total !== null) group.total = Math.max(group.total, group.count);
    for (const task of episodes.values()) {
      if (Object.hasOwn(STATUS_PRIORITY, task.status)) group[task.status]++;
    }
    return group;
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}
