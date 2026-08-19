'use strict';

/**
 * Drives the real UI end to end under Electron:
 *
 *   npx electron scripts/ui-e2e.js [uri]
 *
 * Seeds a database, fills in the Backup form and clicks the button, waits for
 * the job to finish, then does the same on the Restore tab and verifies the
 * data landed. This exercises the IPC job-event plumbing (progress table, bar,
 * status text) that the engine-level smoke test cannot reach.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { app, BrowserWindow, dialog } = require('electron');
const { MongoClient } = require('mongodb');

// Both actions now sit behind a confirmation. Record what is asked and answer
// it automatically, so the run is unattended and the wording can be asserted.
const dialogs = [];
let nextResponse = 0; // 0 = the confirm button, 1 = cancel
dialog.showMessageBox = async (...args) => {
  const options = args.length > 1 ? args[1] : args[0];
  dialogs.push(options);
  const response = nextResponse;
  nextResponse = 0;
  return { response };
};

// Throwaway profile: the run fills in form fields, which the app persists as
// preferences. Without this it would leave stale temp paths in real settings.
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-profile-'));
app.setPath('userData', PROFILE_DIR);

const URI = process.argv.find((argument) => argument.startsWith('mongodb://')) || 'mongodb://127.0.0.1:27017';
const SOURCE_DB = 'mbr_ui_source';
const TARGET_DB = 'mbr_ui_target';
const DOC_COUNT = 400;

const problems = [];
let target = null;

app.on('browser-window-created', (_event, window) => {
  target = target || window;
});

require('../src/main/main.js');

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    problems.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed() {
  const client = new MongoClient(URI);
  try {
    await client.connect();
    await client.db(SOURCE_DB).dropDatabase();
    await client.db(TARGET_DB).dropDatabase();

    const documents = Array.from({ length: DOC_COUNT }, (_, index) => ({
      _id: index,
      name: `row ${index}`,
    }));
    await client.db(SOURCE_DB).collection('alpha').insertMany(documents);
    await client.db(SOURCE_DB).collection('beta').insertMany(documents.slice(0, 10));
    await client.db(SOURCE_DB).collection('alpha').createIndex({ name: 1 }, { name: 'name_idx' });
  } finally {
    await client.close();
  }
}

async function verifyRestored() {
  const client = new MongoClient(URI);
  try {
    await client.connect();
    const db = client.db(TARGET_DB);
    const alpha = await db.collection('alpha').countDocuments();
    const beta = await db.collection('beta').countDocuments();
    const indexes = (await db.collection('alpha').listIndexes().toArray()).map((i) => i.name).sort();
    return { alpha, beta, indexes };
  } finally {
    await client.close();
  }
}

async function cleanup() {
  const client = new MongoClient(URI);
  try {
    await client.connect();
    await client.db(SOURCE_DB).dropDatabase();
    await client.db(TARGET_DB).dropDatabase();
  } finally {
    await client.close();
  }
}

/**
 * Poll the status heading until it reaches a terminal state for this job.
 *
 * Matching a specific finished title rather than "no longer in progress"
 * matters because a confirmation dialog now sits between the click and the job
 * starting: sampling too early would otherwise read the previous job's title
 * and return straight away.
 */
async function waitForJob(window, terminal, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const status = await window.webContents.executeJavaScript(
      `({
        title: document.getElementById('statusTitle').textContent,
        detail: document.getElementById('statusDetail').textContent,
        width: document.getElementById('progressFill').style.width,
        rows: document.querySelectorAll('#progressRows tr').length,
        done: document.querySelectorAll('#progressRows .badge.done').length,
        failed: document.querySelectorAll('#progressRows .badge.error').length,
        lastLog: (document.querySelector('#log .log-line:last-child') || {}).textContent || '',
      })`,
      true
    );
    last = status;
    if (terminal.test(status.title)) return status;
    await sleep(250);
  }
  return last || { title: 'TIMEOUT' };
}

const BACKUP_DONE = /^Backup (complete|failed|cancelled)/;
const RESTORE_DONE = /^Restore (complete|failed|cancelled)/;

app.whenReady().then(async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mbr-ui-'));
  console.log(`Server:  ${URI}`);
  console.log(`Scratch: ${workDir}`);

  try {
    await seed();
    await sleep(400);

    const window = target || BrowserWindow.getAllWindows()[0];
    if (window.webContents.isLoading()) {
      await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    }
    await sleep(900);

    /* ── Selecting a saved connection connects and lists databases ── */
    console.log('');
    console.log('── saved connection connects automatically ──');
    const profileResult = await window.webContents.executeJavaScript(
      `(async () => {
        if (!state.settings.encryptionAvailable) return { skipped: true };

        const saved = await window.api.saveProfile({
          name: 'e2e local',
          uri: ${JSON.stringify(URI)},
          database: '',
        });
        if (!saved.ok) return { error: saved.error };
        state.settings = saved.data;
        renderProfiles();

        const select = document.getElementById('backupProfile');
        const option = [...select.options].find((o) => o.textContent === 'e2e local');
        select.value = option.value;
        // Nothing else is touched: selection alone must do the work.
        select.dispatchEvent(new Event('change'));

        for (let i = 0; i < 100; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (state.combos.backup.count > 0) break;
        }

        const statusEl = document.getElementById('backupConnStatus');
        return {
          uriFilled: document.getElementById('backupUri').value.length > 0,
          status: statusEl.textContent,
          statusOk: statusEl.className.includes('ok'),
          databases: state.combos.backup.count,
        };
      })()`,
      true
    );

    if (profileResult.skipped) {
      console.log('  SKIPPED  credential encryption unavailable, cannot save a profile');
    } else {
      check(
        'selecting a saved connection fills the URI',
        profileResult.uriFilled === true,
        JSON.stringify(profileResult)
      );
      check(
        'it connects without pressing Test connection',
        profileResult.statusOk === true && /^Connected — MongoDB/.test(profileResult.status || ''),
        `status="${profileResult.status}"`
      );
      check(
        'it loads the database list without pressing Load',
        profileResult.databases > 0,
        `databases=${profileResult.databases}`
      );
    }

    /* ── Selecting a database auto-loads its collections ── */
    console.log('');
    console.log('── database selection fills the Advanced column ──');
    const autoLoaded = await window.webContents.executeJavaScript(
      `(async () => {
        const count = () => document.querySelectorAll('#backupCollections input').length;
        const before = count();
        document.getElementById('backupUri').value = ${JSON.stringify(URI)};
        const field = document.getElementById('backupDatabase');
        field.value = ${JSON.stringify(SOURCE_DB)};
        // Exactly what the picker does when you choose an entry.
        field.dispatchEvent(new Event('change'));
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (count() > 0) break;
        }
        const boxes = [...document.querySelectorAll('#backupCollections input')];
        return {
          before,
          names: boxes.map((el) => el.value).sort(),
          allChecked: boxes.every((el) => el.checked),
        };
      })()`,
      true
    );

    check(
      'the collection list starts empty',
      autoLoaded.before === 0,
      `found ${autoLoaded.before} before selecting`
    );
    check(
      'choosing a database auto-loads its collections',
      JSON.stringify(autoLoaded.names) === JSON.stringify(['alpha', 'beta']),
      `got [${autoLoaded.names}]`
    );
    check('auto-loaded collections all start selected', autoLoaded.allChecked === true);

    /* ── Backup through the UI ── */
    console.log('\n── backup via the Backup tab ──');
    await window.webContents.executeJavaScript(
      `(() => {
        document.getElementById('backupUri').value = ${JSON.stringify(URI)};
        document.getElementById('backupDatabase').value = ${JSON.stringify(SOURCE_DB)};
        document.getElementById('backupOutput').value = ${JSON.stringify(workDir)};
        document.getElementById('backupStart').click();
        return true;
      })()`,
      true
    );

    const backupStatus = await waitForJob(window, BACKUP_DONE);
    check(
      'backup finishes and reports completion',
      backupStatus.title === 'Backup complete',
      `status="${backupStatus.title}" log="${backupStatus.lastLog}"`
    );
    check(
      'progress table shows both collections as done',
      backupStatus.rows === 2 && backupStatus.done === 2 && backupStatus.failed === 0,
      `rows=${backupStatus.rows} done=${backupStatus.done} failed=${backupStatus.failed}`
    );
    check('progress bar reaches 100%', backupStatus.width === '100%', backupStatus.width);
    check(
      'summary line reports the document count',
      backupStatus.detail.includes(String(DOC_COUNT + 10)),
      backupStatus.detail
    );

    const backupDialog = dialogs[dialogs.length - 1];
    check(
      'backup asked for confirmation first',
      Boolean(backupDialog) && backupDialog.title === 'Start backup',
      backupDialog ? backupDialog.title : 'no dialog shown'
    );
    check(
      'backup confirmation says the database is not changed',
      Boolean(backupDialog) && /Nothing in the database is changed/.test(backupDialog.detail || ''),
      backupDialog ? backupDialog.detail : ''
    );
    check(
      'backup confirmation names the destination folder',
      Boolean(backupDialog) && (backupDialog.detail || '').includes(workDir),
      backupDialog ? backupDialog.detail : ''
    );

    // Declining must actually stop the job.
    const declined = await (async () => {
      const seen = dialogs.length;
      nextResponse = 1;
      await window.webContents.executeJavaScript(
        "document.getElementById('backupStart').click()",
        true
      );
      await sleep(900);
      return {
        asked: dialogs.length > seen,
        title: await window.webContents.executeJavaScript(
          "document.getElementById('statusTitle').textContent",
          true
        ),
        lastLog: await window.webContents.executeJavaScript(
          "(document.querySelector('#log .log-line:last-child') || {}).textContent || ''",
          true
        ),
      };
    })();
    check(
      'declining the confirmation cancels the backup',
      declined.asked && declined.title === 'Backup complete' && /cancelled/i.test(declined.lastLog),
      `title="${declined.title}" log="${declined.lastLog}"`
    );

    const uiState = await window.webContents.executeJavaScript(
      `({ folder: state.lastBackupFolder, openEnabled: !document.getElementById('backupOpenFolder').disabled })`,
      true
    );
    check('"Open backup folder" became available', uiState.openEnabled === true);
    check(
      'backup folder is a timestamped subfolder of the chosen output',
      typeof uiState.folder === 'string' && uiState.folder.startsWith(workDir),
      uiState.folder
    );

    /* ── Restore through the UI ── */
    console.log('\n── restore via the Restore tab ──');
    const inspected = await window.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('.tab[data-tab="restore"]').click();
        document.getElementById('restoreUri').value = ${JSON.stringify(URI)};
        document.getElementById('restoreSource').value = state.lastBackupFolder;
        document.getElementById('restoreSource').dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 1200));
        return {
          status: document.getElementById('restoreSourceStatus').textContent,
          statusClass: document.getElementById('restoreSourceStatus').className,
          collections: [...document.querySelectorAll('#restoreCollections input')].map((el) => el.value),
          targetPrefilled: document.getElementById('restoreTargetDatabase').value,
          activePanel: (document.querySelector('.panel.is-active') || {}).id,
        };
      })()`,
      true
    );

    check('clicking the Restore tab switches panels', inspected.activePanel === 'panel-restore', inspected.activePanel);
    check(
      'picking the folder auto-detects the backup',
      inspected.statusClass.includes('ok') && inspected.status.includes(SOURCE_DB),
      `"${inspected.status}"`
    );
    check(
      'both collections are listed for restore',
      JSON.stringify(inspected.collections.sort()) === JSON.stringify(['alpha', 'beta']),
      inspected.collections.join(', ')
    );
    check(
      'target database is pre-filled from the backup',
      inspected.targetPrefilled === SOURCE_DB,
      inspected.targetPrefilled
    );

    // Restore into a different database name, in the default non-destructive mode
    // (so no native confirmation dialog appears and blocks the run).
    await window.webContents.executeJavaScript(
      `(() => {
        document.getElementById('restoreTargetDatabase').value = ${JSON.stringify(TARGET_DB)};
        document.getElementById('restoreStart').click();
        return true;
      })()`,
      true
    );

    const restoreStatus = await waitForJob(window, RESTORE_DONE);
    check(
      'restore finishes and reports completion',
      restoreStatus.title === 'Restore complete',
      `status="${restoreStatus.title}" log="${restoreStatus.lastLog}"`
    );
    check(
      'restore summary names the target database',
      restoreStatus.detail.includes(TARGET_DB),
      restoreStatus.detail
    );

    const restoreDialog = dialogs[dialogs.length - 1];
    check(
      'restore asked for confirmation even in the safe mode',
      Boolean(restoreDialog) && (restoreDialog.message || '').includes(TARGET_DB),
      restoreDialog ? restoreDialog.message : 'no dialog shown'
    );
    check(
      'restore confirmation states it writes and is not a backup',
      Boolean(restoreDialog) &&
        /does not create a backup/.test(restoreDialog.detail || '') &&
        /kept and skipped/.test(restoreDialog.detail || ''),
      restoreDialog ? restoreDialog.detail : ''
    );

    const restored = await verifyRestored();
    check(
      `target database really holds the data (${DOC_COUNT} + 10 docs)`,
      restored.alpha === DOC_COUNT && restored.beta === 10,
      `alpha=${restored.alpha} beta=${restored.beta}`
    );
    check(
      'index was recreated in the target',
      restored.indexes.includes('name_idx'),
      restored.indexes.join(', ')
    );

    const finalState = await window.webContents.executeJavaScript(
      `({
        cancelHidden: document.getElementById('jobCancel').classList.contains('hidden'),
        backupEnabled: !document.getElementById('backupStart').disabled,
        restoreEnabled: !document.getElementById('restoreStart').disabled,
        errorLines: document.querySelectorAll('#log .log-line.error').length,
      })`,
      true
    );
    check('buttons re-enable after the job', finalState.backupEnabled && finalState.restoreEnabled);
    check('cancel button is hidden again', finalState.cancelHidden === true);
    check('no errors were logged', finalState.errorLines === 0, `${finalState.errorLines} error line(s)`);
  } catch (error) {
    check('e2e run completed without throwing', false, error.stack || error.message);
  } finally {
    await cleanup().catch(() => {});
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(
    problems.length === 0 ? '\nUI end-to-end passed.' : `\nUI end-to-end FAILED (${problems.length}).`
  );
  app.exit(problems.length === 0 ? 0 : 1);
});
