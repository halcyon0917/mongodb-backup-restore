'use strict';

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');

const mongo = require('./mongo');
const settings = require('./settings');
const history = require('./history');
const { runBackup } = require('./backup');
const { inspectBackup, previewRestore, runRestore } = require('./restore');
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

/** The stylesheet's --bg, so the window never flashes the wrong colour. */
const SHELL_BACKGROUND = { dark: '#12100F', light: '#F7F5F3' };

/** Whichever theme the renderer is about to apply: the saved one, else the OS. */
function startingTheme() {
  const saved = settings.getSettings().prefs.theme;
  if (saved === 'dark' || saved === 'light') return saved;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    // The layout is a fixed-width sidebar plus a two-column form; below this it
    // stops being usable rather than merely tight.
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: SHELL_BACKGROUND[startingTheme()],
    show: false,
    // The title bar is drawn by the renderer, so the app can carry its own
    // colours right to the top edge instead of a grey OS strip above them.
    frame: false,
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

  // The maximise button is a toggle, so the renderer has to be told when the
  // state changes by any other route — a double-click, Win+Up, or a snap.
  const sendWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  // External links open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Push one connection's reachability to the renderer as the driver sees it. */
function emitConnectionState(uri, state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('connection:state', { uri, ...state });
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

  const startedAt = new Date();
  // What each collection reached, so a run that fails halfway still records
  // which collections made it rather than recording nothing at all.
  const reached = new Map();

  const ctx = {
    isCancelled: () => job.cancelled,
    log: (level, message) =>
      emit(jobId, { kind: 'log', level, message, ts: new Date().toISOString() }),
    plan: (collections) => {
      for (const collection of collections) {
        reached.set(collection.name, {
          name: collection.name,
          type: collection.type || 'collection',
          documents: 0,
          bytes: 0,
          indexes: 0,
          status: 'pending',
        });
      }
      emit(jobId, { kind: 'plan', collections });
    },
    collection: (payload) => {
      const previous = reached.get(payload.name) || { name: payload.name };
      reached.set(payload.name, {
        ...previous,
        type: payload.type || previous.type || 'collection',
        documents: Number(payload.documents) || previous.documents || 0,
        bytes: Number(payload.bytes) || previous.bytes || 0,
        indexes: Number(payload.indexes) || previous.indexes || 0,
        status: payload.status || previous.status || 'pending',
      });
      emit(jobId, { kind: 'collection', ...payload });
    },
    progress: (payload) => emit(jobId, { kind: 'progress', ...payload }),
  };

  emit(jobId, { kind: 'started', job: kind });

  /** Write the run into the history panel. Never fails the job itself. */
  const record = async (status, summary, error) => {
    try {
      await history.addRun({
        kind,
        status,
        uri: request && request.uri,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        error: error || '',
        ...(kind === 'backup'
          ? {
              // A run over several databases has no single source name, so the
              // list is what gets recorded and `database` stays empty.
              database: (summary && summary.sourceDatabase) || singleDatabase(request) || '',
              databases: backupDatabases(summary, request, reached),
              folder: (summary && summary.outputFolder) || (request && request.outputDir) || '',
              detail: request && request.gzip ? 'gzip' : '',
            }
          : {
              database:
                (summary && summary.targetDatabase) || (request && request.targetDatabase) || '',
              folder: (summary && summary.sourceFolder) || (request && request.sourceDir) || '',
              detail: restoreModeLabel(request),
            }),
        totals: (summary && summary.totals) || {
          collections: [...reached.values()].filter((entry) => entry.status === 'done').length,
          documents: [...reached.values()].reduce((sum, entry) => sum + entry.documents, 0),
          bytes: [...reached.values()].reduce((sum, entry) => sum + entry.bytes, 0),
        },
        collections: (summary && summary.collections) || [...reached.values()],
      });
    } catch {
      /* a history write must never turn a finished job into a failed one */
    }
  };

  try {
    const summary = await engine(request, ctx);
    await record('done', summary);
    emit(jobId, { kind: 'done', summary });
    return { ok: true, jobId, summary };
  } catch (error) {
    if (error && error.cancelled) {
      ctx.log('warn', 'Cancelled. Data written before cancelling was left in place.');
      await record('cancelled', null, 'Cancelled by user.');
      emit(jobId, { kind: 'cancelled' });
      return { ok: false, jobId, cancelled: true, error: 'Cancelled by user.' };
    }
    const message = describeError(error);
    ctx.log('error', message);
    await record('failed', null, message);
    emit(jobId, { kind: 'failed', error: message });
    return { ok: false, jobId, error: message };
  } finally {
    jobs.delete(jobId);
  }
}

/** The one database a backup asked for, or null when it asked for several. */
function singleDatabase(request) {
  if (!request) return null;
  const names = Array.isArray(request.databases) && request.databases.length
    ? request.databases
    : [request.database].filter(Boolean);
  return names.length === 1 ? names[0] : null;
}

/**
 * The per-database breakdown of a backup, or [] for a single-database run.
 *
 * A run that failed part way has no summary, so what the job actually reached
 * is used instead — a half-finished run is exactly the one worth being able to
 * look at afterwards.
 */
function backupDatabases(summary, request, reached) {
  if (summary && Array.isArray(summary.databases)) return summary.databases;

  const names = request && Array.isArray(request.databases) ? request.databases : [];
  if (names.length < 2) return [];

  return names.map((name) => {
    const unit = reached.get(name);
    return {
      name,
      status: unit ? unit.status : 'pending',
      totals: {
        collections: 0,
        documents: unit ? unit.documents : 0,
        bytes: unit ? unit.bytes : 0,
      },
      collections: [],
    };
  });
}

/** How a restore treated existing data, for the one-line history summary. */
function restoreModeLabel(request) {
  if (!request) return '';
  if (request.dropDatabase) return 'dropped the database first';
  if (request.drop) return 'replaced each collection';
  if (request.writeMode === 'upsert') return 'merged on _id';
  return 'kept existing documents';
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
    maximized: Boolean(mainWindow && mainWindow.isMaximized()),
    systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
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

  handle('window:minimize', async () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  });

  handle('window:toggleMaximize', async () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  handle('window:close', async () => {
    if (mainWindow) mainWindow.close();
    return true;
  });

  handle('connection:status', async () => mongo.pool.allStatuses());
  handle('connection:disconnect', (uri) => mongo.disconnect(uri));

  handle('history:list', async () => history.listRuns());
  handle('history:remove', (id) => history.removeRun(id));
  handle('history:clear', async () => history.clearRuns());

  handle('mongo:test', (uri) => mongo.testConnection(uri));
  handle('mongo:listDatabases', (uri) => mongo.listDatabases(uri));
  handle('mongo:survey', (uri) => mongo.surveyConnection(uri));
  handle('mongo:listCollections', ({ uri, database }) => mongo.listCollections(uri, database));
  handle('restore:inspect', (folder) => inspectBackup(folder));
  handle('restore:preview', (request) => previewRestore(request));

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
    mongo.pool.setStateListener(emitConnectionState);
    registerHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Connections are pooled for the session, so they have to be handed back
  // rather than left for the process to drop.
  app.on('before-quit', () => {
    mongo.pool.closeAll().catch(() => {});
  });

  app.on('window-all-closed', () => app.quit());
}
