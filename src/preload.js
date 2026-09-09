'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const uploadAvailable = process.platform === 'darwin';

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (value) => ipcRenderer.invoke('settings:save', value),
  connect: () => ipcRenderer.invoke('repo:connect'),
  list: (path) => ipcRenderer.invoke('repo:list', path),
  download: (item) => ipcRenderer.invoke('repo:download', item),
  onTransferProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('transfer:progress', listener);
    return () => ipcRenderer.removeListener('transfer:progress', listener);
  }
};

// Windows preload never exposes any upload function to renderer code.
if (uploadAvailable) {
  api.uploadFiles = (path) => ipcRenderer.invoke('repo:uploadFiles', path);
  api.uploadDirectory = (path) => ipcRenderer.invoke('repo:uploadDirectory', path);
}

contextBridge.exposeInMainWorld('repoDrive', Object.freeze(api));
