'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer runs with contextIsolation on and no Node access; this is the
// entire surface it can reach.
contextBridge.exposeInMainWorld('api', {
  appInfo: () => ipcRenderer.invoke('app:info'),

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
  startBackup: (request) => ipcRenderer.invoke('backup:start', request),
  startRestore: (request) => ipcRenderer.invoke('restore:start', request),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  savePrefs: (prefs) => ipcRenderer.invoke('settings:savePrefs', prefs),
  saveProfile: (profile) => ipcRenderer.invoke('settings:saveProfile', profile),
  deleteProfile: (id) => ipcRenderer.invoke('settings:deleteProfile', id),

  onJobEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('job:event', handler);
    return () => ipcRenderer.removeListener('job:event', handler);
  },
});
