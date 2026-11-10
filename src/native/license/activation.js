'use strict';

const form = document.getElementById('activation-form');
const key = document.getElementById('license-key');
const button = document.getElementById('activate');
const status = document.getElementById('status');
const options = new URLSearchParams(location.search);
status.textContent = options.get('message') || '';
if (options.get('saved')) key.placeholder = '粘贴新激活码，或留空重试已保存授权';
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = '正在联网验证…';
  status.textContent = '';
  try {
    status.textContent = (await window.activation.submit(key.value)) || '';
  } catch {
    status.textContent = '激活失败，请稍后重试。';
  } finally {
    button.disabled = false;
    button.textContent = '激活';
  }
});
