import { contextBridge, ipcRenderer } from 'electron';
import type { NoteApi } from '../shared/types';

const api: NoteApi = {
  load: () => ipcRenderer.invoke('load'),
  saveBoard: (board) => ipcRenderer.invoke('save-board', board),
  saveTab: (itemId, tabId, text) => ipcRenderer.invoke('save-tab', itemId, tabId, text),
  removeItem: (item) => ipcRenderer.invoke('remove-item', item),
  removeTab: (itemId, tab) => ipcRenderer.invoke('remove-tab', itemId, tab),
  restoreItem: (trashName, itemId) => ipcRenderer.invoke('restore-item', trashName, itemId),
  restoreTab: (trashName, itemId, tabId) => ipcRenderer.invoke('restore-tab', trashName, itemId, tabId),
  createBackup: () => ipcRenderer.invoke('create-backup'),
  saveImage: (ext, data) => ipcRenderer.invoke('save-image', ext, data),
  readImage: (file) => ipcRenderer.invoke('read-image', file),
  removeImage: (image) => ipcRenderer.invoke('remove-image', image),
  restoreImage: (trashName, file) => ipcRenderer.invoke('restore-image', trashName, file),
  listTrash: () => ipcRenderer.invoke('list-trash'),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),
  restoreTrash: (trashName) => ipcRenderer.invoke('restore-trash', trashName),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  restoreBackup: (name) => ipcRenderer.invoke('restore-backup', name),
  exportArchive: () => ipcRenderer.invoke('export-archive'),
  importArchive: () => ipcRenderer.invoke('import-archive'),
  exportAllText: () => ipcRenderer.invoke('export-all-text'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  openManual: () => ipcRenderer.invoke('open-manual'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  copyImage: (file) => ipcRenderer.invoke('copy-image', file),
  exportText: (title, text) => ipcRenderer.invoke('export-text', title, text),
  openDetached: (itemId) => ipcRenderer.invoke('open-detached', itemId),
  loadDetached: (itemId) => ipcRenderer.invoke('load-detached', itemId),
  saveDetachedItem: (item) => ipcRenderer.invoke('save-detached-item', item),
  returnDetached: (itemId) => ipcRenderer.invoke('return-detached', itemId),
  setDetachedAlwaysOnTop: (itemId, value) => ipcRenderer.invoke('set-detached-always-on-top', itemId, value),
  onDetachedItemUpdated: (cb) => {
    ipcRenderer.on('detached-item-updated', (_event, item) => cb(item));
  },
  onDetachedReturned: (cb) => {
    ipcRenderer.on('detached-returned', (_event, itemId) => cb(itemId));
  },
  onDetachedFlushRequest: (cb) => {
    ipcRenderer.on('detached-flush-request', async () => {
      try {
        await cb();
      } finally {
        ipcRenderer.send('detached-flush-done');
      }
    });
  },
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
