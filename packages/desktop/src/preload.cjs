const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dreamcode', {
  getProviders: () => ipcRenderer.invoke('get-providers'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  runDemo: (prompt) => ipcRenderer.invoke('run-demo', prompt),
  onLog: (callback) => ipcRenderer.on('agent-log', (_event, entry) => callback(entry)),
});
