const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cfg', {
  get: () => ipcRenderer.invoke('get-config'),
  save: (services) => ipcRenderer.send('save-config', services),
  cancel: () => ipcRenderer.send('close-settings'),
});
