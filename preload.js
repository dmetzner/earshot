const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  switch: (id) => ipcRenderer.send('switch', id),
  menu: (id) => ipcRenderer.send('service-menu', id),
  reorder: (ids) => ipcRenderer.send('reorder', ids),
  reload: () => ipcRenderer.send('reload'),
  back: () => ipcRenderer.send('back'),
  forward: () => ipcRenderer.send('forward'),
  home: () => ipcRenderer.send('home'),
  onState: (cb) => ipcRenderer.on('state', (_e, data) => cb(data)),
});
