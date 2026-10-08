// AgentDesk — preload: jembatan aman renderer <-> main
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentDesk', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  hasKey: () => ipcRenderer.invoke('config:hasKey'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  queueInfo: () => ipcRenderer.invoke('chat:queueInfo'),
  cancelAll: () => ipcRenderer.invoke('chat:cancelAll'),
  testConnection: () => ipcRenderer.invoke('conn:test'),
});
