'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Templates contain the user's assets and are kept only in the app's user data.
function createTemplateStore(userData, checkTemplate) {
  const directory = path.join(userData, 'cost-report-templates');
  const legacy = path.join(userData, 'cost-report-template.docx');
  const validId = id => id === 'legacy' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  function list() {
    const entries = [{ id: 'legacy', file: legacy }];
    if (fs.existsSync(directory)) {
      for (const name of fs.readdirSync(directory)) {
        const id = name.replace(/\.docx$/, '');
        if (name.endsWith('.docx') && validId(id) && id !== 'legacy') entries.push({ id, file: path.join(directory, name) });
      }
    }
    return entries.flatMap(({ id, file }) => {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) return [];
      let metadata = {};
      try { metadata = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')) || {}; } catch (_) {}
      return [{ id, ready: true, name: path.basename(String(metadata.name || '成本配置报告模板.docx')),
        importedAt: Number(metadata.importedAt) || Math.round(stat.mtimeMs) }];
    }).sort((a, b) => a.id === 'legacy' ? -1 : b.id === 'legacy' ? 1 : a.importedAt - b.importedAt || a.id.localeCompare(b.id));
  }
  function info(id = '') {
    return (id ? list().find(item => item.id === id) : list()[0]) || { ready: false, id: String(id || '') };
  }
  function file(id = '') {
    const selected = info(id);
    if (!selected.ready || !validId(selected.id)) throw new Error('所选报告模板不存在，请在「报告设置」中重新选择');
    return selected.id === 'legacy' ? legacy : path.join(directory, `${selected.id}.docx`);
  }
  async function add(sources) {
    const prepared = [];
    for (const source of sources) {
      const buffer = await fsp.readFile(source);
      const problems = checkTemplate(buffer);
      if (problems.length) throw new Error(`${path.basename(source)} 不能使用：${problems.join('；')}`);
      prepared.push({ id: randomUUID(), name: path.basename(source), importedAt: Date.now(), buffer });
    }
    if (!prepared.length) return [];
    await fsp.mkdir(directory, { recursive: true });
    const created = [];
    try {
      for (const item of prepared) {
        const destination = path.join(directory, `${item.id}.docx`);
        created.push(destination, `${destination}.json`);
        await fsp.writeFile(destination, item.buffer, { flag: 'wx' });
        await fsp.writeFile(`${destination}.json`, JSON.stringify({ name: item.name, importedAt: item.importedAt }), { flag: 'wx' });
      }
    } catch (error) {
      await Promise.all(created.map(name => fsp.rm(name, { force: true }).catch(() => {})));
      throw error;
    }
    return prepared.map(({ buffer, ...item }) => ({ ...item, ready: true }));
  }
  return { list, info, file, add };
}
module.exports = { createTemplateStore };
