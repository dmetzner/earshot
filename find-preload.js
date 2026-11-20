const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('finder', {
  find: (text, forward) => ipcRenderer.send('find', text, forward),
  close: () => ipcRenderer.send('find-close'),
  onOpen: (cb) => ipcRenderer.on('find-open', () => cb()),
  onFound: (cb) => ipcRenderer.on('found', (_e, at, of) => cb(at, of)),
});
