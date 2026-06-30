const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  switch: (id) => ipcRenderer.send('switch', id),
  reorder: (ids) => ipcRenderer.send('reorder', ids),
  reload: () => ipcRenderer.send('reload'),
  onState: (cb) => ipcRenderer.on('state', (_e, data) => cb(data)),
});
