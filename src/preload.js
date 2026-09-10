'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const uploadAvailable = process.platform === 'darwin' || process.platform === 'linux';

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (value) => ipcRenderer.invoke('settings:save', value),
  connect: () => ipcRenderer.invoke('repo:connect'),
  list: (path) => ipcRenderer.invoke('repo:list', path),
  download: (item) => ipcRenderer.invoke('repo:download', item),
  delete: (item) => ipcRenderer.invoke('repo:delete', item),
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
  api.getPathForFile = (file) => webUtils.getPathForFile(file);
  api.uploadDropped = (paths) => ipcRenderer.invoke('repo:uploadDropped', paths);
  api.rename = (item, newName) => ipcRenderer.invoke('repo:rename', item, newName);
}

contextBridge.exposeInMainWorld('repoDrive', Object.freeze(api));
