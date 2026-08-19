'use strict';

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');

const mongo = require('./mongo');
const settings = require('./settings');
const { runBackup } = require('./backup');
const { inspectBackup, runRestore } = require('./restore');
const { describeError } = require('./util');

// Safe to read at runtime, unlike build.appId: electron-builder keeps the
// standard "version" field in the package.json it packages. It also beats
// app.getVersion(), which reports Electron's own version when Electron is
// launched with a script path rather than the app directory.
const { version: APP_VERSION } = require('../../package.json');

// Must match build.appId in package.json, which scripts/ui-check.js asserts.
// It cannot be read from there at runtime: electron-builder strips the "build"
// section out of the package.json it packages, so the lookup would be undefined
// in the shipped app and crash on startup.
const APP_ID = 'com.adriandelacruz.mongodb-backup-restore';

/** Active jobs, so the renderer can cancel them. */
const jobs = new Map();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 900,
    minHeight: 660,
    // Match the stylesheet's --bg for the active OS theme, so there is no
    // flash of the wrong colour before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0d11' : '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    title: 'MongoDB Backup and Restore',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Send a job event to the renderer, if the window is still around. */
function emit(jobId, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('job:event', { jobId, ...payload });
}

/**
 * Run a backup/restore engine with a context that streams progress to the UI.
 * Returns a plain result object rather than throwing, so the renderer can show
 * failures inline instead of dealing with IPC rejections.
 */
async function runJob(kind, request, engine) {
  const jobId = crypto.randomUUID();
  const job = { id: jobId, kind, cancelled: false };
  jobs.set(jobId, job);

  const ctx = {
    isCancelled: () => job.cancelled,
    log: (level, message) =>
      emit(jobId, { kind: 'log', level, message, ts: new Date().toISOString() }),
    plan: (collections) => emit(jobId, { kind: 'plan', collections }),
    collection: (payload) => emit(jobId, { kind: 'collection', ...payload }),
    progress: (payload) => emit(jobId, { kind: 'progress', ...payload }),
  };

  emit(jobId, { kind: 'started', job: kind });

  try {
    const summary = await engine(request, ctx);
    emit(jobId, { kind: 'done', summary });
    return { ok: true, jobId, summary };
  } catch (error) {
    if (error && error.cancelled) {
      ctx.log('warn', 'Cancelled. Data written before cancelling was left in place.');
      emit(jobId, { kind: 'cancelled' });
      return { ok: false, jobId, cancelled: true, error: 'Cancelled by user.' };
    }
    const message = describeError(error);
    ctx.log('error', message);
    emit(jobId, { kind: 'failed', error: message });
    return { ok: false, jobId, error: message };
  } finally {
    jobs.delete(jobId);
  }
}

/** Wrap an IPC handler so errors come back as { ok: false, error }. */
function handle(channel, handler) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });
}

function registerHandlers() {
  handle('app:info', async () => ({
    version: APP_VERSION,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    userData: app.getPath('userData'),
    defaultBackupDir: path.join(app.getPath('documents'), 'MongoDB Backups'),
  }));

  handle('dialog:selectFolder', async (options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select folder',
      defaultPath: options.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('dialog:confirm', async (options = {}) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: options.type || 'warning',
      title: options.title || 'Please confirm',
      message: options.message || 'Are you sure?',
      detail: options.detail,
      buttons: [options.confirmLabel || 'Continue', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  });

  handle('dialog:saveLog', async (text) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save activity log',
      defaultPath: `mongodb-backup-restore-log.txt`,
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, String(text ?? ''), 'utf8');
    return result.filePath;
  });

  handle('shell:openPath', async (targetPath) => {
    if (!targetPath) throw new Error('No path to open.');
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
    return true;
  });

  handle('mongo:test', (uri) => mongo.testConnection(uri));
  handle('mongo:listDatabases', (uri) => mongo.listDatabases(uri));
  handle('mongo:survey', (uri) => mongo.surveyConnection(uri));
  handle('mongo:listCollections', ({ uri, database }) => mongo.listCollections(uri, database));
  handle('restore:inspect', (folder) => inspectBackup(folder));

  handle('settings:get', async () => settings.getSettings());
  handle('settings:savePrefs', (prefs) => settings.savePrefs(prefs));
  handle('settings:saveProfile', (profile) => settings.saveProfile(profile));
  handle('settings:deleteProfile', (id) => settings.deleteProfile(id));

  // Job starters resolve with their own ok/error shape, so they bypass handle().
  ipcMain.handle('backup:start', (_event, request) => runJob('backup', request, runBackup));
  ipcMain.handle('restore:start', (_event, request) => runJob('restore', request, runRestore));

  ipcMain.handle('job:cancel', (_event, jobId) => {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, error: 'That job has already finished.' };
    job.cancelled = true;
    return { ok: true };
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    registerHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
