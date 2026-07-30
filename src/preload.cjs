const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  importKey: (privateKey, password) => ipcRenderer.invoke('key:import', { privateKey, password }),
  unlock: (password) => ipcRenderer.invoke('key:unlock', { password }),
  arm: (params) => ipcRenderer.invoke('snipe:arm', params),
  portfolio: () => ipcRenderer.invoke('portfolio:get'),
  sell: (token, percent, slippagePct, feeTier) => ipcRenderer.invoke('position:sell', { token, percent, slippagePct, feeTier }),
  onSold: (cb) => ipcRenderer.on('sold', (_e, d) => cb(d)),
  disarm: () => ipcRenderer.invoke('snipe:disarm'),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onState: (cb) => ipcRenderer.on('state', (_e, d) => cb(d)),
  onFired: (cb) => ipcRenderer.on('fired', (_e, d) => cb(d))
});
