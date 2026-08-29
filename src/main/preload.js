'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer runs with contextIsolation on and no Node access; this is the
// entire surface it can reach.
contextBridge.exposeInMainWorld('api', {
  appInfo: () => ipcRenderer.invoke('app:info'),

  // The window has no OS frame, so its buttons are ordinary DOM and have to
  // reach the real window through here.
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  selectFolder: (options) => ipcRenderer.invoke('dialog:selectFolder', options),
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  saveLog: (text) => ipcRenderer.invoke('dialog:saveLog', text),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),

  testConnection: (uri) => ipcRenderer.invoke('mongo:test', uri),
  listDatabases: (uri) => ipcRenderer.invoke('mongo:listDatabases', uri),
  surveyConnection: (uri) => ipcRenderer.invoke('mongo:survey', uri),
  listCollections: (uri, database) =>
    ipcRenderer.invoke('mongo:listCollections', { uri, database }),

  inspectBackup: (folder) => ipcRenderer.invoke('restore:inspect', folder),
  previewRestore: (request) => ipcRenderer.invoke('restore:preview', request),
  startBackup: (request) => ipcRenderer.invoke('backup:start', request),
  startRestore: (request) => ipcRenderer.invoke('restore:start', request),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),

  listHistory: () => ipcRenderer.invoke('history:list'),
  removeHistory: (id) => ipcRenderer.invoke('history:remove', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  savePrefs: (prefs) => ipcRenderer.invoke('settings:savePrefs', prefs),
  saveProfile: (profile) => ipcRenderer.invoke('settings:saveProfile', profile),
  deleteProfile: (id) => ipcRenderer.invoke('settings:deleteProfile', id),

  onJobEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('job:event', handler);
    return () => ipcRenderer.removeListener('job:event', handler);
  },

  onWindowState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },
});
