'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose specific operations only. No generic IPC or filesystem access reaches
// the sandboxed page, and command subscribers never receive Electron events.
contextBridge.exposeInMainWorld('recorder', Object.freeze({
  getSources: () => ipcRenderer.invoke('recorder:getSources'),
  prepareCapture: (options) => ipcRenderer.invoke('recorder:prepareCapture', options),
  beginRecording: (options) => ipcRenderer.invoke('recorder:beginRecording', options),
  writeChunk: (id, data) => ipcRenderer.invoke('recorder:writeChunk', id, data),
  finishRecording: (id) => ipcRenderer.invoke('recorder:finishRecording', id),
  abandonRecording: (id) => ipcRenderer.invoke('recorder:abandonRecording', id),
  setActive: (state) => ipcRenderer.invoke('recorder:setActive', state),
  showFile: (filePath) => ipcRenderer.invoke('recorder:showFile', filePath),
  minimize: () => ipcRenderer.invoke('recorder:minimize'),
  onCommand: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('콜백 함수가 필요합니다.');
    const listener = (_event, command) => {
      if (command === 'pause' || command === 'stop') callback(command);
    };
    ipcRenderer.on('recorder:command', listener);
    return () => ipcRenderer.removeListener('recorder:command', listener);
  },
}));
