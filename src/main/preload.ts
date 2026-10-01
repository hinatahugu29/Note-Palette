import { contextBridge, ipcRenderer } from 'electron';
import type { NoteApi } from '../shared/types';

const api: NoteApi = {
  load: () => ipcRenderer.invoke('load'),
  saveBoard: (board) => ipcRenderer.invoke('save-board', board),
  saveTab: (itemId, tabId, text) => ipcRenderer.invoke('save-tab', itemId, tabId, text),
  removeItem: (itemId) => ipcRenderer.invoke('remove-item', itemId),
  removeTab: (itemId, tabId) => ipcRenderer.invoke('remove-tab', itemId, tabId),
  saveImage: (ext, data) => ipcRenderer.invoke('save-image', ext, data),
  readImage: (file) => ipcRenderer.invoke('read-image', file),
  removeImage: (file) => ipcRenderer.invoke('remove-image', file),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  copyImage: (file) => ipcRenderer.invoke('copy-image', file),
  onFlushRequest: (cb) => {
    ipcRenderer.on('flush-request', async () => {
      try {
        await cb();
      } finally {
        ipcRenderer.send('flush-done');
      }
    });
  },
};

contextBridge.exposeInMainWorld('noteApi', api);
