'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('repoDrive', Object.freeze({
  getSettings:()=>ipcRenderer.invoke('settings:get'),
  saveSettings:(value)=>ipcRenderer.invoke('settings:save',value),
  connect:()=>ipcRenderer.invoke('repo:connect'),
  list:(remotePath)=>ipcRenderer.invoke('repo:list',remotePath),
  download:(item)=>ipcRenderer.invoke('repo:download',item),
  onProgress:(callback)=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('download:progress',listener);return()=>ipcRenderer.removeListener('download:progress',listener);}
}));
