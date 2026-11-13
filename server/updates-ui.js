'use strict';
const element = id => document.getElementById(id);
let token = '';
let activeVersion = '';
let uploadedVersion = '';
let busy = false;
function message(text, error = false) { element('message').textContent = text; element('message').className = error ? 'error' : ''; }
function lock(value) {
  busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
  element('files').disabled = value;
  element('publish').disabled = value || !uploadedVersion;
}
async function request(route, body) {
  const response = await fetch('/admin/updates/api/' + route, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body),
  } : {});
  if (response.status === 401) throw new Error('登录已过期，请刷新页面重新登录');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
async function refresh() {
  const state = await request('state');
  token = state.csrf;
  activeVersion = state.active?.version || '';
  element('active').textContent = activeVersion ? 'Windows：v' + activeVersion : '当前没有发布更新';
  element('withdraw').hidden = !activeVersion;
  element('versions').replaceChildren();
  for (const release of state.versions) {
    const row = document.createElement('tr');
    const version = document.createElement('td'); version.textContent = release.version;
    const notes = document.createElement('td'); notes.className = 'notes'; notes.textContent = release.releaseNotes || '—';
    const actions = document.createElement('td'); const button = document.createElement('button');
    button.textContent = release.version === activeVersion ? '已发布' : '发布此版本';
    button.disabled = release.version === activeVersion;
    button.onclick = () => publish(release.version);
    actions.append(button); row.append(version, notes, actions); element('versions').append(row);
  }
}
async function publish(version) {
  if (busy) return;
  lock(true);
  try {
    message('正在校验并发布，请稍候…');
    await request('publish', { version });
    uploadedVersion = '';
    await refresh(); message('已发布 v' + version + '，软件检查更新时即可收到。');
  } catch (error) { message(error.message, true); }
  finally { lock(false); }
}
function upload(file, offset, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/admin/updates/upload/' + encodeURIComponent(file.name));
    xhr.setRequestHeader('X-CSRF-Token', token);
    xhr.upload.onprogress = event => {
      element('progress').value = (offset + event.loaded) / total * 100;
      message('正在上传 ' + file.name + '（' + Math.round((offset + event.loaded) / total * 100) + '%）');
    };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status !== 200) throw new Error(result.error || '上传失败');
        resolve(result);
      } catch (error) { reject(error); }
    };
    xhr.onerror = () => reject(new Error('上传连接中断，请重试'));
    xhr.send(file);
  });
}
element('upload').onclick = async () => {
  if (busy) return;
  const files = Array.from(element('files').files);
  const manifest = files.find(file => /^release-\d+\.\d+\.\d+\.json$/.test(file.name));
  if (files.length !== 3 || !manifest) { message('请选择同一版本的三个更新文件', true); return; }
  const version = manifest.name.slice(8, -5);
  const expected = ['changeFileName-Setup-' + version + '.exe', 'changeFileName-Setup-' + version + '.exe.blockmap', manifest.name];
  if (!expected.every(name => files.some(file => file.name === name))) { message('三个文件的版本号必须一致', true); return; }
  uploadedVersion = '';
  lock(true); element('progress').hidden = false;
  try {
    let offset = 0;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) { await upload(file, offset, total); offset += file.size; }
    uploadedVersion = version;
    message('v' + version + ' 上传完成。点击「发布上传的版本」进行最终校验并发布。');
  } catch (error) { message(error.message, true); }
  finally { element('progress').hidden = true; lock(false); }
};
element('publish').onclick = () => publish(uploadedVersion);
element('withdraw').onclick = async () => {
  if (busy) return;
  lock(true);
  try { await request('withdraw', { version: activeVersion }); await refresh(); message('已撤回更新'); }
  catch (error) { message(error.message, true); }
  finally { lock(false); }
};
refresh().catch(error => message(error.message, true));
