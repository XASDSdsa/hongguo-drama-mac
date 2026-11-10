'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('activation', {
  submit: (key) => ipcRenderer.invoke('online-license:activate', key),
});
