'use strict';

/**
 * Drives the real UI end to end under Electron:
 *
 *   npx electron scripts/ui-e2e.js [uri]
 *
 * Seeds a database, fills in the Back up view and clicks the button, waits for
 * the job to finish, previews a restore against the live target, then runs it
 * and verifies the data landed. This exercises the IPC job-event plumbing
 * (per-collection progress, the action bar, history) that the engine-level
 * smoke test cannot reach.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const fsp = require('fs/promises');
const { app, BrowserWindow, dialog } = require('electron');
const { MongoClient } = require('mongodb');

// Both actions sit behind a confirmation. Record what is asked and answer it
// automatically, so the run is unattended and the wording can be asserted.
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
// preferences and history. Without this it would pollute the real ones.
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-profile-'));
app.setPath('userData', PROFILE_DIR);

const URI =
  process.argv.find((argument) => argument.startsWith('mongodb://')) || 'mongodb://127.0.0.1:27017';
const SOURCE_DB = 'mbr_ui_source';
const TARGET_DB = 'mbr_ui_target';
const MULTI_DBS = ['mbr_ui_multi_a', 'mbr_ui_multi_b'];
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

    // Something already in the target, so the dry run has a real number to
    // report rather than an empty database that makes every mode look alike.
    await client.db(TARGET_DB).collection('alpha').insertMany(documents.slice(0, 25));

    for (const [index, name] of MULTI_DBS.entries()) {
      await client.db(name).dropDatabase();
      await client
        .db(name)
        .collection('rows')
        .insertMany(Array.from({ length: 5 + index * 3 }, (_, n) => ({ _id: n, from: name })));
      await client.db(name).collection('extras').insertMany([{ _id: 1, from: name }]);
    }
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
    for (const name of MULTI_DBS) await client.db(name).dropDatabase();
  } finally {
    await client.close();
  }
}

/**
 * A TCP passthrough to the real server, so the connection can be cut for real.
 *
 * Nothing else lets the suite prove the indicator tells the truth: stopping the
 * developer's mongod is not an option, and asserting against a state the test
 * injected itself would only prove the test can set a variable.
 */
function startProxy(targetPort) {
  const sockets = new Set();
  const server = net.createServer((incoming) => {
    const outgoing = net.connect(targetPort, '127.0.0.1');
    sockets.add(incoming);
    sockets.add(outgoing);
    incoming.on('error', () => {});
    outgoing.on('error', () => {});
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        cut() {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/**
 * Poll the action bar until it reaches a terminal state for this job.
 *
 * Matching a specific finished title rather than "no longer in progress"
 * matters because a confirmation dialog sits between the click and the job
 * starting: sampling too early would otherwise read the previous job's title
 * and return straight away.
 */
async function waitForJob(window, terminal, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const status = await window.webContents.executeJavaScript(
      `({
        title: document.getElementById('actionTitle').textContent,
        detail: document.getElementById('actionDetail').textContent,
        rows: document.querySelectorAll('.view.is-active .collection').length,
        done: document.querySelectorAll('.view.is-active .collection-meta.is-done').length,
        failed: document.querySelectorAll('.view.is-active .collection-meta.is-error').length,
        bars: [...document.querySelectorAll('.view.is-active .collection-bar')].map((b) => b.style.width),
        groups: document.querySelectorAll('.view.is-active .dbgroup-head').length,
        groupsDone: document.querySelectorAll('.view.is-active .dbgroup-head .collection-meta.is-done').length,
        groupBars: [...document.querySelectorAll('.view.is-active .dbgroup-head .collection-bar')]
          .map((b) => b.style.width),
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

const BACKUP_DONE = /^Backup (complete|failed|stopped)/;
const RESTORE_DONE = /^Restore (complete|failed|stopped)/;

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
    const run = (script) => window.webContents.executeJavaScript(script, true);

    /* ── Nothing that needs a server is reachable before there is one ── */
    console.log('\n── the app opens on the connection gate ──');
    const gate = await run(
      `({
        view: state.view,
        activeView: (document.querySelector('.view.is-active') || {}).id,
        backupBlocked: document.querySelector('.nav[data-view="backup"]').disabled,
        restoreBlocked: document.querySelector('.nav[data-view="restore"]').disabled,
        historyOpen: !document.querySelector('.nav[data-view="history"]').disabled,
        barHidden: document.getElementById('actionBar').classList.contains('hidden'),
      })`
    );
    check(
      'it starts on the gate with Back up and Restore held back',
      gate.activeView === 'view-connect' && gate.backupBlocked && gate.restoreBlocked,
      JSON.stringify(gate)
    );
    check('History stays reachable without a connection', gate.historyOpen === true);
    check('the gate hides the action bar', gate.barHidden === true);

    /* ── Picking a saved connection in the sidebar connects on its own ── */
    console.log('\n── the sidebar connects without a second click ──');
    const sidebar = await run(
      `(async () => {
        if (!state.settings.encryptionAvailable) return { skipped: true };

        const saved = await window.api.saveProfile({
          name: 'e2e local', uri: ${JSON.stringify(URI)}, database: '',
        });
        if (!saved.ok) return { error: saved.error };
        state.settings = saved.data;
        renderConnections();

        const row = [...document.querySelectorAll('.conn')]
          .find((el) => el.textContent.includes('e2e local'));
        if (!row) return { error: 'the saved connection did not render in the sidebar' };
        // Nothing else is touched: the click alone must do the work.
        row.querySelector('.conn-main').click();

        for (let i = 0; i < 100; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (state.combos.backup.count > 0) break;
        }

        const badge = document.getElementById('backupConnState');
        return {
          backupUri: document.getElementById('backupUri').value,
          // One connection serves the whole app, so the restore view has to be
          // showing the same server rather than a stale one.
          restoreUri: document.getElementById('restoreUri').value,
          badge: badge.textContent,
          badgeState: badge.dataset.state,
          databases: state.combos.backup.count,
          restoreDatabases: state.combos.restore.count,
          dotLive: [...document.querySelectorAll('.conn')].some(
            (el) => el.dataset.status === 'connected'
          ),
          hasEdit: Boolean(row.querySelector('.conn-edit')),
          view: state.view,
          backupUnblocked: !document.querySelector('.nav[data-view="backup"]').disabled,
          selectedDatabases: [...state.selectedDatabases],
          placeholder: document.getElementById('backupDatabase').placeholder,
          collectionsHelp: document.getElementById('backupCollections').textContent.trim(),
        };
      })()`
    );

    if (sidebar.skipped) {
      console.log('  SKIPPED  credential encryption unavailable, cannot save a connection');
    } else if (sidebar.error) {
      check('the saved connection could be created', false, sidebar.error);
    } else {
      check('clicking a saved connection fills the URI', sidebar.backupUri === URI, sidebar.backupUri);
      check(
        'both views share that one connection',
        sidebar.restoreUri === URI,
        `backup="${sidebar.backupUri}" restore="${sidebar.restoreUri}"`
      );
      check(
        'it connects without pressing Test',
        sidebar.badgeState === 'ok' && /^Connected · MongoDB/.test(sidebar.badge || ''),
        `badge="${sidebar.badge}" state=${sidebar.badgeState}`
      );
      check(
        'it loads the database list for both views',
        sidebar.databases > 0 && sidebar.restoreDatabases === sidebar.databases,
        `backup=${sidebar.databases} restore=${sidebar.restoreDatabases}`
      );
      check('the sidebar marks the connection as reachable', sidebar.dotLive === true);
      check('each row offers an Edit control', sidebar.hasEdit === true);
      check(
        'connecting opens the gate onto Back up',
        sidebar.view === 'backup' && sidebar.backupUnblocked === true,
        `view=${sidebar.view} unblocked=${sidebar.backupUnblocked}`
      );
      check(
        'no database is selected for you on connect',
        sidebar.selectedDatabases.length === 0 && sidebar.placeholder === 'Select database',
        `selected=[${sidebar.selectedDatabases}] placeholder="${sidebar.placeholder}"`
      );
      check(
        'the Collections card says a database is needed first',
        /No database selected yet/.test(sidebar.collectionsHelp),
        sidebar.collectionsHelp.slice(0, 80)
      );
    }

    /* ── Choosing a database fills the Collections card ── */
    console.log('\n── choosing a database fills the Collections card ──');
    const autoLoaded = await run(
      `(async () => {
        const count = () => document.querySelectorAll('#backupCollections .collection').length;
        const before = count();

        // Exactly what a click in the picker does.
        const input = document.getElementById('backupDatabase');
        input.blur();
        input.focus();
        input.value = ${JSON.stringify(SOURCE_DB)};
        input.dispatchEvent(new Event('input'));
        const option = [...document.querySelectorAll('.combo-popup .combo-option[data-name]')]
          .find((el) => el.dataset.name === ${JSON.stringify(SOURCE_DB)});
        if (!option) return { error: 'the database was not offered by the picker' };
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        input.blur();

        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (count() > 0) break;
        }
        const rows = [...document.querySelectorAll('#backupCollections .collection')];
        return {
          before,
          chips: [...document.querySelectorAll('.chip-name')].map((el) => el.textContent),
          names: rows.map((el) => el.dataset.name).sort(),
          allChecked: rows.every((el) => el.querySelector('input').checked),
          footer: document.getElementById('backupCollectionsFooter').textContent,
          actionDetail: document.getElementById('actionDetail').textContent,
          primaryEnabled: !document.getElementById('actionPrimary').disabled,
          resolved: document.getElementById('backupResolved').textContent,
        };
      })()`
    );
    if (autoLoaded.error) check('the picker offered the seeded database', false, autoLoaded.error);

    check('the collection list starts empty', autoLoaded.before === 0, `found ${autoLoaded.before}`);
    check(
      'choosing a database adds it as a chip',
      JSON.stringify(autoLoaded.chips) === JSON.stringify([SOURCE_DB]),
      JSON.stringify(autoLoaded.chips)
    );
    check(
      'choosing a database auto-loads its collections',
      JSON.stringify(autoLoaded.names) === JSON.stringify(['alpha', 'beta']),
      `got [${autoLoaded.names}]`
    );
    check('auto-loaded collections all start selected', autoLoaded.allChecked === true);
    check(
      'the card footer counts the selection',
      /2 of 2 selected/.test(autoLoaded.footer),
      autoLoaded.footer
    );
    check(
      'the action bar unblocks and totals the documents',
      autoLoaded.primaryEnabled === true && autoLoaded.actionDetail.includes(String(DOC_COUNT + 10)),
      `enabled=${autoLoaded.primaryEnabled} detail="${autoLoaded.actionDetail}"`
    );

    /* ── Backup ── */
    console.log('\n── backup from the Back up view ──');
    await run(
      `(() => {
        document.getElementById('backupOutput').value = ${JSON.stringify(workDir)};
        document.getElementById('backupOutput').dispatchEvent(new Event('input'));
        document.getElementById('actionPrimary').click();
        return true;
      })()`
    );

    const backupStatus = await waitForJob(window, BACKUP_DONE);
    check(
      'backup finishes and reports completion',
      backupStatus.title === 'Backup complete',
      `title="${backupStatus.title}" log="${backupStatus.lastLog}"`
    );
    check(
      'every collection row reports done with a full bar',
      backupStatus.rows === 2 &&
        backupStatus.done === 2 &&
        backupStatus.failed === 0 &&
        backupStatus.bars.every((width) => width === '100%'),
      `rows=${backupStatus.rows} done=${backupStatus.done} bars=${backupStatus.bars}`
    );
    check(
      'the summary reports the document count and where it went',
      backupStatus.detail.includes(String(DOC_COUNT + 10)) && backupStatus.detail.includes(workDir),
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
      await run("document.getElementById('actionPrimary').click()");
      await sleep(900);
      return {
        asked: dialogs.length > seen,
        title: await run("document.getElementById('actionTitle').textContent"),
        lastLog: await run(
          "(document.querySelector('#log .log-line:last-child') || {}).textContent || ''"
        ),
      };
    })();
    check(
      'declining the confirmation cancels the backup',
      declined.asked && declined.title === 'Backup complete' && /cancelled/i.test(declined.lastLog),
      `title="${declined.title}" log="${declined.lastLog}"`
    );

    const uiState = await run(
      `({
        folder: state.lastBackupFolder,
        openEnabled: !document.getElementById('actionSecondary').disabled,
        secondaryLabel: document.getElementById('actionSecondary').textContent,
      })`
    );
    check(
      '"Open backup folder" became available',
      uiState.openEnabled === true && uiState.secondaryLabel === 'Open backup folder',
      `enabled=${uiState.openEnabled} label="${uiState.secondaryLabel}"`
    );
    check(
      'backup folder is a timestamped subfolder of the chosen output',
      typeof uiState.folder === 'string' && uiState.folder.startsWith(workDir),
      uiState.folder
    );

    /* ── Restore view picks the backup up ── */
    console.log('\n── restore from the Restore view ──');
    const inspected = await run(
      `(async () => {
        document.querySelector('.nav[data-view="restore"]').click();
        document.getElementById('restoreSource').value = state.lastBackupFolder;
        document.getElementById('restoreSource').dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 1200));
        return {
          activeView: (document.querySelector('.view.is-active') || {}).id,
          factsVisible: !document.getElementById('restoreFacts').classList.contains('hidden'),
          factDatabase: document.getElementById('factDatabase').textContent,
          factContents: document.getElementById('factContents').textContent,
          factTaken: document.getElementById('factTaken').textContent,
          provenance: document.getElementById('restoreSourceStatus').textContent,
          collections: [...document.querySelectorAll('#restoreCollections .collection')]
            .map((el) => el.dataset.name).sort(),
          targetPrefilled: document.getElementById('restoreTargetDatabase').value,
          targetState: document.getElementById('restoreTargetState').textContent,
        };
      })()`
    );

    check('clicking Restore switches views', inspected.activeView === 'view-restore', inspected.activeView);
    check(
      'the backup is summarised in the facts strip',
      inspected.factsVisible === true &&
        inspected.factDatabase === SOURCE_DB &&
        inspected.factContents.includes('2 collections') &&
        inspected.factTaken !== 'unknown',
      JSON.stringify(inspected)
    );
    check(
      'the source line reports where the backup came from',
      /Made by this app/.test(inspected.provenance),
      inspected.provenance
    );
    check(
      'both collections are listed for restore',
      JSON.stringify(inspected.collections) === JSON.stringify(['alpha', 'beta']),
      inspected.collections.join(', ')
    );
    check(
      'target database is pre-filled from the backup',
      inspected.targetPrefilled === SOURCE_DB,
      inspected.targetPrefilled
    );
    check(
      'the target is marked as one that already exists',
      inspected.targetState === 'exists',
      `"${inspected.targetState}"`
    );

    /* ── Dry run against the live target ── */
    console.log('\n── dry run reads the target without writing ──');
    const dry = await run(
      `(async () => {
        const field = document.getElementById('restoreTargetDatabase');
        field.value = ${JSON.stringify(TARGET_DB)};
        field.dispatchEvent(new Event('change'));
        document.getElementById('actionSecondary').click();
        for (let i = 0; i < 100; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (!document.getElementById('dryCard').classList.contains('hidden')) break;
        }
        const rows = [...document.querySelectorAll('.dry-row')].map((row) => ({
          name: row.querySelector('.dry-name').textContent,
          inBackup: row.querySelectorAll('.dry-count')[0].textContent,
          inTarget: row.querySelectorAll('.dry-count')[1].textContent,
          outcome: row.querySelector('.dry-outcome').textContent,
          tone: row.querySelector('.dry-outcome').dataset.tone,
        }));
        return {
          visible: !document.getElementById('dryCard').classList.contains('hidden'),
          rows,
          total: document.getElementById('dryTotal').textContent,
          secondaryLabel: document.getElementById('actionSecondary').textContent,
        };
      })()`
    );

    check('the secondary action is the dry run on this view', dry.secondaryLabel === 'Preview (dry run)', dry.secondaryLabel);
    check('the dry run renders a result table', dry.visible === true && dry.rows.length === 2, JSON.stringify(dry.rows));
    {
      const alpha = dry.rows.find((row) => row.name === 'alpha');
      check(
        'it counts what is really in the target right now',
        Boolean(alpha) && alpha.inTarget === '25' && alpha.inBackup === '400',
        JSON.stringify(alpha)
      );
      check(
        'it says the safe mode skips rather than overwrites',
        Boolean(alpha) && /skipping any of the 25/.test(alpha.outcome),
        alpha ? alpha.outcome : ''
      );
      const beta = dry.rows.find((row) => row.name === 'beta');
      check(
        'a collection missing from the target is a plain insert',
        Boolean(beta) && beta.inTarget === '—' && /^insert 10$/.test(beta.outcome) && beta.tone === 'safe',
        JSON.stringify(beta)
      );
    }
    check(
      'the summary promises nothing existing is deleted',
      /Nothing existing is deleted or changed/.test(dry.total),
      dry.total
    );

    const targetBefore = await verifyRestored();
    check(
      'the dry run really wrote nothing',
      targetBefore.alpha === 25 && targetBefore.beta === 0,
      `alpha=${targetBefore.alpha} beta=${targetBefore.beta}`
    );

    /* ── Restore, in the default non-destructive mode ── */
    await run("document.getElementById('actionPrimary').click()");

    const restoreStatus = await waitForJob(window, RESTORE_DONE);
    check(
      'restore finishes and reports completion',
      restoreStatus.title === 'Restore complete',
      `title="${restoreStatus.title}" log="${restoreStatus.lastLog}"`
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
    check('index was recreated in the target', restored.indexes.includes('name_idx'), restored.indexes.join(', '));

    /* ── History recorded both runs ── */
    console.log('\n── both runs land in History ──');
    const history = await run(
      `(async () => {
        document.querySelector('.nav[data-view="history"]').click();
        await new Promise((r) => setTimeout(r, 500));
        const cards = [...document.querySelectorAll('.run')];
        return {
          count: state.history.length,
          badge: document.getElementById('historyCount').textContent,
          barHidden: document.getElementById('actionBar').classList.contains('hidden'),
          kinds: state.history.map((h) => h.kind + ':' + h.status),
          databases: state.history.map((h) => h.database),
          hosts: state.history.map((h) => h.host),
          // Nothing on this screen may carry a password.
          text: cards.map((c) => c.textContent).join(' ').replace(/\\s+/g, ' '),
        };
      })()`
    );

    check(
      'both runs were recorded, newest first',
      history.count === 2 &&
        history.kinds[0] === 'restore:done' &&
        history.kinds[1] === 'backup:done',
      JSON.stringify(history.kinds)
    );
    check(
      'each run names its database',
      history.databases[0] === TARGET_DB && history.databases[1] === SOURCE_DB,
      JSON.stringify(history.databases)
    );
    check(
      'history keeps the host but never the connection string',
      history.hosts.every((host) => host === '127.0.0.1:27017') &&
        !history.text.includes('mongodb://'),
      JSON.stringify(history.hosts)
    );
    check('the History badge counts the runs', history.badge === '2', `badge="${history.badge}"`);
    check('the history view hides the action bar', history.barHidden === true);

    // Verify on disk, since the file outlives the session.
    const historyFile = path.join(PROFILE_DIR, 'history.json');
    const raw = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8') : '';
    check(
      'history is persisted without any connection string',
      raw.includes(SOURCE_DB) && !raw.includes('mongodb://') && !/"uri"/.test(raw),
      raw.slice(0, 200)
    );

    /* ── Several databases in one run, through the UI ── */
    console.log('\n── several databases in one run ──');
    const multi = await run(
      `(async () => {
        document.querySelector('.nav[data-view="backup"]').click();
        clearDatabaseSelection();

        const input = document.getElementById('backupDatabase');
        for (const name of ${JSON.stringify(MULTI_DBS)}) {
          input.blur();
          input.focus();
          input.value = name;
          input.dispatchEvent(new Event('input'));
          const option = [...document.querySelectorAll('.combo-popup .combo-option[data-name]')]
            .find((el) => el.dataset.name === name);
          if (!option) return { error: 'picker did not offer ' + name };
          option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        }
        input.blur();
        await new Promise((r) => setTimeout(r, 400));

        return {
          selected: [...state.selectedDatabases],
          mode: state.backupListMode,
          title: document.getElementById('backupCollectionsTitle').textContent,
          groups: [...document.querySelectorAll('#backupCollections .dbgroup')].map((el) => ({
            name: el.dataset.name,
            open: el.classList.contains('is-open'),
            summary: el.querySelector('.collection-docs').textContent,
            nested: el.querySelectorAll('.collection').length,
          })),
          footer: document.getElementById('backupCollectionsFooter').textContent.trim(),
          resolved: document.getElementById('backupResolved').textContent,
          detail: document.getElementById('actionDetail').textContent,
        };
      })()`
    );

    if (multi.error) {
      check('the picker offered both databases', false, multi.error);
    } else {
      check(
        'both databases end up selected',
        JSON.stringify(multi.selected.sort()) === JSON.stringify([...MULTI_DBS].sort()),
        JSON.stringify(multi.selected)
      );
      check(
        'the card becomes Databases, one collapsed group each',
        multi.mode === 'databases' &&
          multi.title === 'Databases' &&
          multi.groups.length === 2 &&
          multi.groups.every((group) => !group.open && group.nested === 0),
        JSON.stringify({ title: multi.title, groups: multi.groups })
      );
      check(
        'a collapsed group says the whole database is going',
        multi.groups.every((group) => /^all /.test(group.summary)),
        JSON.stringify(multi.groups.map((group) => group.summary))
      );
      check(
        'the footer explains each database is taken whole',
        /every collection in each one/.test(multi.footer),
        multi.footer
      );

      /* Expanding one group lists that database's collections, tickable. */
      const expanded = await run(
        `(async () => {
          const name = ${JSON.stringify('MULTI_FIRST')};
          document.querySelector('.dbgroup[data-name="' + name + '"] .dbgroup-toggle').click();
          for (let i = 0; i < 60; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            if (document.querySelectorAll('.dbgroup[data-name="' + name + '"] .collection').length) break;
          }
          const group = document.querySelector('.dbgroup[data-name="' + name + '"]');
          const other = document.querySelector('.dbgroup:not([data-name="' + name + '"])');
          const before = {
            open: group.classList.contains('is-open'),
            collections: [...group.querySelectorAll('.collection')].map((el) => ({
              name: el.dataset.name,
              database: el.dataset.database,
              checked: el.querySelector('input').checked,
            })),
            otherClosed: !other.classList.contains('is-open'),
            otherNested: other.querySelectorAll('.collection').length,
          };

          // Every tick rebuilds the list, so the group has to be looked up again
          // after each one rather than held across the click.
          const live = () => document.querySelector('.dbgroup[data-name="' + name + '"]');
          const tick = (collection) =>
            live().querySelector('.collection[data-name="' + collection + '"] input').click();

          // Untick one, and the run should carry only the rest for this database.
          tick('extras');
          const after = {
            summary: live().querySelector('.collection-docs').textContent,
            selections: JSON.parse(JSON.stringify(databaseSelections())),
            footer: document.getElementById('backupCollectionsFooter').textContent.trim(),
            blocked: document.getElementById('actionPrimary').disabled,
          };

          // Taking everything off that database has to block, naming it.
          [...live().querySelectorAll('.dbgroup-actions .link')]
            .find((b) => b.textContent === 'None')
            .click();
          const emptied = {
            blocked: document.getElementById('actionPrimary').disabled,
            detail: document.getElementById('actionDetail').textContent,
          };

          // Put it back to just "rows" for the run below.
          tick('rows');
          return { before, after, emptied, selections: JSON.parse(JSON.stringify(databaseSelections())) };
        })()`.replace('"MULTI_FIRST"', JSON.stringify(MULTI_DBS[0]))
      );

      check(
        'expanding a group loads that database\'s collections, all ticked',
        expanded.before.open === true &&
          expanded.before.collections.length === 2 &&
          expanded.before.collections.every(
            (item) => item.checked && item.database === MULTI_DBS[0]
          ),
        JSON.stringify(expanded.before)
      );
      check(
        'the other group stays collapsed and unread',
        expanded.before.otherClosed === true && expanded.before.otherNested === 0,
        JSON.stringify(expanded.before)
      );
      check(
        'unticking one narrows only that database',
        expanded.after.summary === '1 of 2 collections' &&
          JSON.stringify(expanded.after.selections[MULTI_DBS[0]]) === JSON.stringify(['rows']) &&
          expanded.after.selections[MULTI_DBS[1]] === null,
        JSON.stringify(expanded.after)
      );
      check(
        'the footer reports the narrowing',
        /narrowed to specific collections/.test(expanded.after.footer),
        expanded.after.footer
      );
      check(
        'emptying a database blocks the run and names it',
        expanded.emptied.blocked === true &&
          expanded.emptied.detail.includes(MULTI_DBS[0]),
        JSON.stringify(expanded.emptied)
      );
      check(
        'the run carries one collection list per database',
        JSON.stringify(expanded.selections[MULTI_DBS[0]]) === JSON.stringify(['rows']) &&
          expanded.selections[MULTI_DBS[1]] === null,
        JSON.stringify(expanded.selections)
      );
      check(
        'the destination preview shows one run folder holding both',
        /backup_<timestamp>/.test(multi.resolved) &&
          MULTI_DBS.every((name) => multi.resolved.includes(name)),
        multi.resolved
      );

      await run("document.getElementById('actionPrimary').click()");
      const multiStatus = await waitForJob(window, BACKUP_DONE);
      check(
        'the multi-database backup finishes',
        multiStatus.title === 'Backup complete',
        `title="${multiStatus.title}" log="${multiStatus.lastLog}"`
      );
      check(
        'each database group reports done with a full bar',
        multiStatus.groups === 2 &&
          multiStatus.groupsDone === 2 &&
          multiStatus.groupBars.every((w) => w === '100%'),
        `groups=${multiStatus.groups} done=${multiStatus.groupsDone} bars=${multiStatus.groupBars}`
      );

      // The narrowing has to reach disk, not just the form.
      const runFolder = await run('state.lastBackupFolder');
      const narrowedFiles = fs
        .readdirSync(path.join(runFolder, MULTI_DBS[0]))
        .filter((file) => file.endsWith('.bson'))
        .sort();
      const wholeFiles = fs
        .readdirSync(path.join(runFolder, MULTI_DBS[1]))
        .filter((file) => file.endsWith('.bson'))
        .sort();
      check(
        'the narrowed database wrote only the collection that was ticked',
        JSON.stringify(narrowedFiles) === JSON.stringify(['rows.bson']),
        narrowedFiles.join(' ')
      );
      check(
        'the untouched database still wrote everything',
        JSON.stringify(wholeFiles) === JSON.stringify(['extras.bson', 'rows.bson']),
        wholeFiles.join(' ')
      );
      check(
        'the summary counts the databases',
        /2 databases/.test(multiStatus.detail),
        multiStatus.detail
      );

      const entries = fs.readdirSync(runFolder).sort();
      check(
        'the run folder holds a subfolder per database plus a manifest',
        JSON.stringify(entries) ===
          JSON.stringify(['backup-manifest.json', ...[...MULTI_DBS].sort()]),
        entries.join(' ')
      );

      /* History has to describe the run the way the form did. */
      const recorded = await run(
        `(async () => {
          document.querySelector('.nav[data-view="history"]').click();
          await new Promise((r) => setTimeout(r, 500));
          const card = document.querySelector('.run');
          const head = {
            db: card.querySelector('.run-db').textContent,
            detail: card.querySelector('.run-detail').textContent,
          };
          card.querySelector('.run-head').click();
          const groups = [...document.querySelectorAll('.run-group')].map((el) => ({
            name: el.querySelector('.name').textContent,
            open: el.classList.contains('is-open'),
            nested: el.querySelectorAll('.run-row').length,
          }));
          // Open the narrowed one and read what it recorded.
          const target = [...document.querySelectorAll('.run-group')].find(
            (el) => el.querySelector('.name').textContent === ${JSON.stringify('MULTI_FIRST')}
          );
          target.querySelector('.run-group-head').click();
          const opened = [...document.querySelectorAll('.run-group')].find(
            (el) => el.querySelector('.name').textContent === ${JSON.stringify('MULTI_FIRST')}
          );
          const collections = [...opened.querySelectorAll('.run-row .name')].map((el) => el.textContent);
          const stored = (await window.api.listHistory()).data[0];
          return { head, groups, collections, stored };
        })()`.replace(/"MULTI_FIRST"/g, JSON.stringify(MULTI_DBS[0]))
      );

      check(
        'the history row counts the databases instead of naming just one',
        recorded.head.db === '2 databases' &&
          MULTI_DBS.every((name) => recorded.head.detail.includes(name)),
        JSON.stringify(recorded.head)
      );
      check(
        'expanding the run lists a collapsed row per database',
        recorded.groups.length === 2 &&
          recorded.groups.every((group) => !group.open && group.nested === 0) &&
          JSON.stringify(recorded.groups.map((group) => group.name).sort()) ===
            JSON.stringify([...MULTI_DBS].sort()),
        JSON.stringify(recorded.groups)
      );
      check(
        'opening a database shows only the collections that were actually backed up',
        JSON.stringify(recorded.collections) === JSON.stringify(['rows']),
        JSON.stringify(recorded.collections)
      );
      check(
        'the stored run keeps the per-database breakdown',
        Array.isArray(recorded.stored.databases) &&
          recorded.stored.databases.length === 2 &&
          recorded.stored.database === '',
        JSON.stringify({
          database: recorded.stored.database,
          databases: (recorded.stored.databases || []).map((entry) => entry.name),
        })
      );
    }

    /* ── The indicator has to tell the truth when a server really goes ── */
    console.log('\n── a server that really goes away ──');
    const proxy = await startProxy(Number(new URL(URI).port || 27017));
    const proxyUri = `mongodb://127.0.0.1:${proxy.port}`;

    const beforeCut = await run(
      `(async () => {
        if (!state.settings.encryptionAvailable) return { skipped: true };
        const saved = await window.api.saveProfile({ name: 'e2e proxy', uri: ${JSON.stringify('PROXY_URI')} });
        if (!saved.ok) return { error: saved.error };
        state.settings = saved.data;
        renderConnections();
        const row = [...document.querySelectorAll('.conn')]
          .find((el) => el.textContent.includes('e2e proxy'));
        row.querySelector('.conn-main').click();
        for (let i = 0; i < 150; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (isConnected()) break;
        }
        // Stand on Back up: that is the view losing the server has to take
        // away. History would rightly stay put, since it needs no connection.
        setView('backup');
        const el = [...document.querySelectorAll('.conn')]
          .find((node) => node.textContent.includes('e2e proxy'));
        return {
          connected: isConnected(),
          dot: el.dataset.status,
          view: state.view,
          backupOpen: !document.querySelector('.nav[data-view="backup"]').disabled,
        };
      })()`.replace('"PROXY_URI"', JSON.stringify(proxyUri))
    );

    if (beforeCut.skipped) {
      console.log('  SKIPPED  credential encryption unavailable, cannot test disconnection');
    } else if (beforeCut.error) {
      check('the proxied connection could be saved', false, beforeCut.error);
      await proxy.cut();
    } else {
      check(
        'connecting through the proxy turns the indicator green',
        beforeCut.connected === true &&
          beforeCut.dot === 'connected' &&
          beforeCut.backupOpen &&
          beforeCut.view === 'backup',
        JSON.stringify(beforeCut)
      );

      await proxy.cut();

      const afterCut = await (async () => {
        for (let i = 0; i < 60; i += 1) {
          const snapshot = await run(
            `(() => {
              const el = [...document.querySelectorAll('.conn')]
                .find((node) => node.textContent.includes('e2e proxy'));
              return {
                dot: el ? el.dataset.status : null,
                connected: isConnected(),
                view: state.view,
                backupBlocked: document.querySelector('.nav[data-view="backup"]').disabled,
                lastLog: (document.querySelector('#log .log-line:last-child') || {}).textContent || '',
              };
            })()`
          );
          if (snapshot.dot === 'lost') return snapshot;
          await sleep(500);
        }
        return run(
          `(() => {
            const el = [...document.querySelectorAll('.conn')]
              .find((node) => node.textContent.includes('e2e proxy'));
            return { dot: el ? el.dataset.status : null, connected: isConnected(), view: state.view,
                     backupBlocked: document.querySelector('.nav[data-view="backup"]').disabled,
                     lastLog: '' };
          })()`
        );
      })();

      check(
        'losing the server really does turn the indicator red',
        afterCut.dot === 'lost' && afterCut.connected === false,
        JSON.stringify(afterCut)
      );
      check(
        'and takes Back up away rather than leaving a form it cannot run',
        afterCut.view === 'connect' && afterCut.backupBlocked === true,
        `view=${afterCut.view} blocked=${afterCut.backupBlocked}`
      );
      check(
        'the log says the connection was lost',
        /Lost the connection/.test(afterCut.lastLog),
        afterCut.lastLog
      );
    }

    const finalState = await run(
      `({
        primaryEnabled: !document.getElementById('actionPrimary').disabled,
        errorLines: document.querySelectorAll('#log .log-line.error').length,
        errorText: [...document.querySelectorAll('#log .log-line.error')].map((l) => l.textContent).join(' | '),
      })`
    );
    check('no errors were logged', finalState.errorLines === 0, finalState.errorText);
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
