'use strict';

/**
 * Boots the real app under Electron and asserts the window actually works:
 *
 *   npx electron scripts/ui-check.js
 *
 * Checks that the preload bridge is exposed, that renderer.js ran without
 * throwing, that the initial DOM is wired up, and that an IPC round trip
 * succeeds. Exits non-zero on any failure, so it can gate a release.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// Point the app at a throwaway profile before it starts, so a test run never
// reads or writes the real saved connections, preferences or history.
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-profile-'));
app.setPath('userData', PROFILE_DIR);

const problems = [];
const consoleErrors = [];

// Grab the window the moment the real main process creates it.
let target = null;
app.on('browser-window-created', (_event, window) => {
  target = target || window;

  window.webContents.on('console-message', (event) => {
    // Electron >= 36 passes an event object; older versions pass positional args.
    const level = event && event.level !== undefined ? event.level : arguments[1];
    const message = event && event.message !== undefined ? event.message : arguments[2];
    if (level === 'error' || level === 3) consoleErrors.push(String(message));
  });

  window.webContents.on('preload-error', (_e, preloadPath, error) => {
    problems.push(`preload failed (${preloadPath}): ${error.message}`);
  });

  window.webContents.on('render-process-gone', (_e, details) => {
    problems.push(`renderer process gone: ${details.reason}`);
  });
});

// Boot the actual application.
require('../src/main/main.js');

const PROBE = `(async () => {
  await document.fonts.ready;
  const ids = [
    'winMinimize', 'winMaximize', 'winClose', 'historyCount', 'connectionList',
    'connectionAdd', 'connectionDialog', 'connectionName', 'connectionUri',
    'connectionProduction', 'connectionStatus', 'connectionSave',
    'connectionTest', 'connectionDelete', 'connectionCancel',
    'themeDark', 'themeLight', 'appVersion', 'flowStrip',
    'backupUri', 'backupDatabase', 'backupOutput', 'backupResolved', 'backupGzip',
    'backupCollections', 'backupCollectionsFooter',
    'restoreUri', 'restoreSource', 'restoreTargetDatabase', 'restoreCollections',
    'restoreConfirmRow', 'restoreDropConfirm', 'dryCard', 'dryRows', 'dryTotal',
    'actionBar', 'actionPrimary', 'actionSecondary', 'actionTitle', 'actionDetail',
    'actionProgress', 'logDock', 'logToggle', 'log', 'logTail',
    'historyList', 'historySummary', 'historyClear', 'aboutDialog',
    'connectList', 'connectAdd', 'connectNote', 'backupDatabaseField', 'backupDatabaseChips',
  ];
  return {
    hasApi: typeof window.api === 'object' && window.api !== null,
    apiMethods: window.api ? Object.keys(window.api).sort() : [],
    missingIds: ids.filter((id) => !document.getElementById(id)),
    navCount: document.querySelectorAll('.nav').length,
    activeView: (document.querySelector('.view.is-active') || {}).id || null,
    gatedNavs: [...document.querySelectorAll('.nav')]
      .filter((nav) => nav.disabled)
      .map((nav) => nav.dataset.view),
    actionBarHidden: document.getElementById('actionBar').classList.contains('hidden'),
    connectEmpty: document.getElementById('connectList').textContent.trim(),
    databasePlaceholder: document.getElementById('backupDatabase').placeholder,
    collectionsHelp: document.getElementById('backupCollections').textContent.trim(),
    restoreModes: [...document.querySelectorAll('input[name="restoreMode"]')].map((el) => el.value),
    logLines: document.querySelectorAll('#log .log-line').length,
    versionPill: document.getElementById('appVersion').textContent,
    backupOutput: document.getElementById('backupOutput').value,
    resolved: document.getElementById('backupResolved').textContent,
    actionTitle: document.getElementById('actionTitle').textContent,
    primaryDisabled: document.getElementById('actionPrimary').disabled,
    bodyOverflows: document.body.scrollWidth > window.innerWidth + 1,
    // The window has no OS frame, so the app draws and drags its own.
    titlebarRegion: getComputedStyle(document.querySelector('.titlebar')).webkitAppRegion,
    controlsRegion: getComputedStyle(document.querySelector('.window-controls')).webkitAppRegion,
    windowButtons: document.querySelectorAll('.window-button').length,
    // A missing font file fails silently under CSP; this catches it.
    manrope: document.fonts.check('600 13px Manrope'),
    spaceMono: document.fonts.check('12px "Space Mono"'),
  };
})()`;

const EXPECTED_API = [
  'appInfo', 'cancelJob', 'clearHistory', 'closeWindow', 'confirm', 'deleteProfile',
  'getSettings', 'inspectBackup', 'listCollections', 'listDatabases', 'listHistory',
  'minimizeWindow', 'onJobEvent', 'onWindowState', 'openPath', 'previewRestore',
  'removeHistory', 'saveLog', 'savePrefs', 'saveProfile', 'selectFolder', 'startBackup',
  'startRestore', 'surveyConnection', 'testConnection', 'toggleMaximizeWindow',
];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// The Windows app id lives in two files and cannot be shared at runtime, so
// assert the copies agree rather than trusting them to stay in step.
function checkAppIdMatches() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const declared = (source.match(/const APP_ID = '([^']+)'/) || [])[1];
  check(
    'the app id in main.js matches package.json',
    Boolean(declared) && declared === pkg.build.appId,
    `main.js="${declared}" package.json="${pkg.build.appId}"`
  );
}

app.whenReady().then(async () => {
  checkAppIdMatches();

  // Give the real main process a tick to create its window.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const window = target || BrowserWindow.getAllWindows()[0];
  if (!window) {
    console.log('  FAIL  no BrowserWindow was created');
    problems.push('no BrowserWindow was created');
    return finish();
  }

  if (window.webContents.isLoading()) {
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  }
  // Let renderer init() finish its async IPC calls.
  await new Promise((resolve) => setTimeout(resolve, 900));

  const run = (script) => window.webContents.executeJavaScript(script, true);

  try {
    const probe = await run(PROBE);

    check('preload bridge is exposed on window.api', probe.hasApi);
    check(
      'every expected API method is present',
      EXPECTED_API.every((name) => probe.apiMethods.includes(name)),
      `missing: ${EXPECTED_API.filter((name) => !probe.apiMethods.includes(name)).join(', ')}`
    );
    check(
      'all referenced element ids exist',
      probe.missingIds.length === 0,
      `missing: ${probe.missingIds.join(', ')}`
    );
    // Nothing that needs a server may be reachable before there is one.
    check(
      'the app opens on the connection gate, not on a form it cannot run',
      probe.navCount === 3 && probe.activeView === 'view-connect',
      `navs=${probe.navCount} active=${probe.activeView}`
    );
    check(
      'Back up and Restore are held back, History is not',
      JSON.stringify(probe.gatedNavs.sort()) === JSON.stringify(['backup', 'restore']),
      probe.gatedNavs.join(', ')
    );
    check('the gate hides the action bar', probe.actionBarHidden === true);
    check(
      'with nothing saved, the gate says how to start',
      /Add one to get started|encryption is unavailable/.test(probe.connectEmpty),
      probe.connectEmpty.slice(0, 80)
    );
    check(
      'no database is chosen for you',
      probe.databasePlaceholder === 'Select database',
      probe.databasePlaceholder
    );
    check(
      'the Collections card says why it is empty',
      /No database selected yet/.test(probe.collectionsHelp),
      probe.collectionsHelp.slice(0, 80)
    );
    check(
      'all four restore modes render',
      probe.restoreModes.length === 4 && probe.restoreModes[0] === 'keep',
      probe.restoreModes.join(', ')
    );
    check('renderer init() ran (log has lines)', probe.logLines > 0, `lines=${probe.logLines}`);
    check(
      'appInfo IPC round trip populated the version',
      /^v\d+\.\d+\.\d+$/.test(probe.versionPill),
      `pill="${probe.versionPill}"`
    );
    {
      // The displayed version must be the app's, not Electron's.
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
      check(
        'the version shown is the app version from package.json',
        probe.versionPill === `v${pkg.version}`,
        `pill="${probe.versionPill}" package.json=${pkg.version}`
      );
    }
    check(
      'default backup folder was filled in',
      /MongoDB Backups$/.test(probe.backupOutput),
      probe.backupOutput
    );
    check(
      'the destination preview waits for a database rather than inventing one',
      /Select a database/.test(probe.resolved),
      probe.resolved
    );
    check('page does not scroll horizontally', probe.bodyOverflows === false);

    // Frameless window: without a drag region the window cannot be moved at
    // all, and without no-drag on the buttons they cannot be clicked.
    check(
      'the title bar is draggable',
      probe.titlebarRegion === 'drag',
      `app-region=${probe.titlebarRegion}`
    );
    check(
      'the window buttons are clickable, not part of the drag region',
      probe.controlsRegion === 'no-drag' && probe.windowButtons === 3,
      `app-region=${probe.controlsRegion} buttons=${probe.windowButtons}`
    );

    // The fonts are bundled and loaded under a CSP that allows font-src 'self'
    // only; a wrong path or a blocked request degrades silently to a fallback.
    check('the bundled Manrope loaded', probe.manrope === true);
    check('the bundled Space Mono loaded', probe.spaceMono === true);

    // Exercise a real IPC call that touches MongoDB error handling.
    const badConnection = await run("window.api.testConnection('not-a-uri')");
    check(
      'a bad URI comes back as a handled error, not a crash',
      badConnection && badConnection.ok === false && /mongodb:\/\//.test(badConnection.error),
      JSON.stringify(badConnection)
    );

    const settings = await run('window.api.getSettings()');
    check(
      'settings load and report credential-encryption support',
      settings && settings.ok === true && typeof settings.data.encryptionAvailable === 'boolean',
      JSON.stringify(settings && settings.data && { enc: settings.data.encryptionAvailable })
    );
  } catch (error) {
    check('probe executed', false, error.message);
  }

  // Everything below needs a working view, which needs a connection. The
  // connection is faked rather than made: this suite has to pass with no
  // server, and the state it injects is the same shape the main process sends.
  const FAKE_URI = 'mongodb://127.0.0.1:27017/';
  // Injected, not made: this suite has to pass with no server running, and the
  // payload is the same shape the main process pushes.
  const CONNECT = `
    setUri(${JSON.stringify('mongodb://127.0.0.1:27017/')}, { silent: true });
    applyConnectionState({
      uri: ${JSON.stringify('mongodb://127.0.0.1:27017/')},
      status: 'connected', serverVersion: '7.0.11', topology: 'Single', error: null,
    });
  `;

  try {
    const opened = await run(`(() => { ${CONNECT} setView('backup'); return state.view; })()`);
    check('a live connection opens the gate onto Back up', opened === 'backup', opened);
  } catch (error) {
    check('the gate could be opened for the remaining checks', false, error.message);
  }

  // A server with dozens of databases must still be pickable: the native
  // <datalist> this replaced grew past the window with no way to scroll. The
  // backup field takes several at once, so choosing keeps the list open and
  // what is typed stays a filter rather than becoming the answer.
  try {
    const combo = await run(
      `(() => {
        const names = Array.from({ length: 45 }, (_, i) => ({
          name: 'database-number-' + String(i).padStart(2, '0'),
          sizeOnDisk: (i + 1) * 1048576,
        }));
        ${CONNECT}
        state.combos.backup.setItems(names);
        clearDatabaseSelection();

        const input = document.getElementById('backupDatabase');
        input.blur();
        input.focus();
        const popup = document.querySelector('.combo-popup:not([hidden])');
        if (!popup) {
          return { opened: false, activeElement: document.activeElement && document.activeElement.id };
        }
        const realOptions = () =>
          document.querySelectorAll('.combo-popup:not([hidden]) .combo-option[data-name]').length;

        const rect = popup.getBoundingClientRect();
        const result = {
          opened: true,
          options: realOptions(),
          clientHeight: Math.round(popup.clientHeight),
          scrollHeight: Math.round(popup.scrollHeight),
          insideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
        };
        popup.scrollTop = 99999;
        result.scrolled = popup.scrollTop > 0;

        input.value = 'number-3';
        input.dispatchEvent(new Event('input'));
        result.filtered = realOptions();

        // Choosing one keeps the list open, so several can be picked in a row.
        const pick = (name) => {
          const option = [...document.querySelectorAll('.combo-popup .combo-option[data-name]')]
            .find((el) => el.dataset.name === name);
          option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        };
        pick('database-number-30');
        result.afterFirstPick = {
          selected: [...state.selectedDatabases],
          stillOpen: Boolean(document.querySelector('.combo-popup:not([hidden])')),
          chips: [...document.querySelectorAll('.chip-name')].map((el) => el.textContent),
          ticked: Boolean(
            document.querySelector('.combo-popup .combo-option[data-name="database-number-30"].is-chosen')
          ),
        };

        pick('database-number-31');
        result.afterSecondPick = [...state.selectedDatabases];

        // Clicking a chosen one again takes it off.
        pick('database-number-30');
        result.afterUnpick = [...state.selectedDatabases];

        // A name the server did not list is still offerable.
        input.value = 'not-in-the-list';
        input.dispatchEvent(new Event('input'));
        result.customOffered = Boolean(document.querySelector('.combo-popup .combo-option[data-custom]'));
        document
          .querySelector('.combo-popup .combo-option[data-custom]')
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        result.afterCustom = [...state.selectedDatabases];

        clearDatabaseSelection();
        input.blur();
        return result;
      })()`
    );

    check('database picker opens with all 45 entries', combo.opened && combo.options === 45, JSON.stringify(combo));
    check(
      'picker is height-capped rather than overflowing the window',
      combo.clientHeight < combo.scrollHeight && combo.insideViewport,
      `client=${combo.clientHeight} scroll=${combo.scrollHeight} inside=${combo.insideViewport}`
    );
    check('picker actually scrolls', combo.scrolled === true);
    check(
      'typing filters the list (45 -> 10 for "number-3")',
      combo.filtered === 10,
      `got ${combo.filtered}`
    );
    check(
      'choosing one adds a chip, ticks it, and leaves the list open',
      combo.afterFirstPick.stillOpen === true &&
        combo.afterFirstPick.ticked === true &&
        JSON.stringify(combo.afterFirstPick.selected) === JSON.stringify(['database-number-30']) &&
        JSON.stringify(combo.afterFirstPick.chips) === JSON.stringify(['database-number-30']),
      JSON.stringify(combo.afterFirstPick)
    );
    check(
      'a second database can be added to the same run',
      JSON.stringify(combo.afterSecondPick) ===
        JSON.stringify(['database-number-30', 'database-number-31']),
      JSON.stringify(combo.afterSecondPick)
    );
    check(
      'clicking a chosen database again removes it',
      JSON.stringify(combo.afterUnpick) === JSON.stringify(['database-number-31']),
      JSON.stringify(combo.afterUnpick)
    );
    check(
      'a database the server did not list can still be named',
      combo.customOffered === true && combo.afterCustom.includes('not-in-the-list'),
      JSON.stringify(combo.afterCustom)
    );
  } catch (error) {
    check('database picker probe ran', false, error.message);
  }

  // The restore target is still one database typed freely, so it keeps the
  // single-select behaviour: browsing shows everything, typing narrows.
  try {
    const single = await run(
      `(() => {
        const names = Array.from({ length: 45 }, (_, i) => ({
          name: 'database-number-' + String(i).padStart(2, '0'),
        }));
        ${CONNECT}
        state.combos.restore.setItems(names);
        // The field is in the Restore view, and a hidden element cannot take
        // focus, so the picker would never open.
        setView('restore');
        const input = document.getElementById('restoreTargetDatabase');
        const previous = input.value;
        const count = () =>
          document.querySelectorAll('.combo-popup:not([hidden]) .combo-option[data-name]').length;

        input.value = 'database-number-07';
        input.blur();
        input.focus();
        const all = count();
        const chosen = document.querySelector('.combo-popup:not([hidden]) .combo-option.is-chosen');
        const marked = Boolean(chosen) && chosen.dataset.name === 'database-number-07';
        const active = Boolean(chosen) && chosen.classList.contains('is-active');

        input.dispatchEvent(new Event('input'));
        const narrowed = count();

        input.value = previous;
        input.blur();
        setView('backup');
        return { all, marked, active, narrowed };
      })()`
    );

    check(
      'the restore target lists every database even with one chosen',
      single.all === 45,
      `got ${single.all}`
    );
    check(
      'the chosen target is ticked and pre-selected in the list',
      single.marked === true && single.active === true,
      `marked=${single.marked} active=${single.active}`
    );
    check(
      'typing in the restore target still searches (45 -> 1)',
      single.narrowed === 1,
      `got ${single.narrowed}`
    );
  } catch (error) {
    check('restore target picker probe ran', false, error.message);
  }

  // Clicking the version opens About, and it must carry the attribution.
  try {
    const about = await run(
      `(async () => {
        const dialog = document.getElementById('aboutDialog');
        const before = dialog.open === true;
        document.getElementById('appVersion').click();
        await new Promise((r) => setTimeout(r, 120));
        const text = dialog.textContent.replace(/[ ]+/g, ' ');
        const opened = dialog.open === true;
        document.getElementById('aboutClose').click();
        await new Promise((r) => setTimeout(r, 120));
        return { before, opened, closed: dialog.open !== true, text };
      })()`
    );

    check('the About dialog starts closed', about.before === false);
    check('clicking the version opens it', about.opened === true);
    check('the Close button dismisses it', about.closed === true);
    check(
      'it credits the developer and Versa Innovations Corp.',
      /Adrian Dela Cruz/.test(about.text) && /Versa Innovations Corp/.test(about.text),
      about.text.slice(0, 140)
    );
    check(
      'it reports the version and runtime for bug reports',
      /Version \d+\.\d+\.\d+/.test(about.text) && /Electron .+Chromium .+Node /.test(about.text),
      about.text.slice(0, 200)
    );
  } catch (error) {
    check('About dialog probe ran', false, error.message);
  }

  // Both working views split into a main column and a narrower side column,
  // with the action bar pinned between the scrolling form and the log dock.
  try {
    const layout = await run(
      `(() => {
        ${CONNECT}
        const read = (viewId) => {
          const view = document.getElementById(viewId);
          const wasActive = view.classList.contains('is-active');
          if (!wasActive) view.classList.add('is-active');
          const main = view.querySelector('.grid-main');
          const side = view.querySelector('.grid-side');
          const out = main && side
            ? {
                mainRight: Math.round(main.getBoundingClientRect().right),
                mainWidth: Math.round(main.getBoundingClientRect().width),
                sideLeft: Math.round(side.getBoundingClientRect().left),
                sideWidth: Math.round(side.getBoundingClientRect().width),
              }
            : null;
          if (!wasActive) view.classList.remove('is-active');
          return out;
        };

        ${CONNECT}
        const views = document.querySelector('.views');
        const bar = document.getElementById('actionBar');
        const dock = document.getElementById('logDock');
        const rail = document.querySelector('.rail');

        return {
          backup: read('view-backup'),
          restore: read('view-restore'),
          viewsScrolls: views.scrollHeight > views.clientHeight + 1,
          bodyScrolls: document.body.scrollHeight > document.body.clientHeight + 1,
          barBottom: Math.round(bar.getBoundingClientRect().bottom),
          dockTop: Math.round(dock.getBoundingClientRect().top),
          dockBottom: Math.round(dock.getBoundingClientRect().bottom),
          viewport: Math.round(window.innerHeight),
          railWidth: Math.round(rail.getBoundingClientRect().width),
        };
      })()`
    );

    for (const name of ['backup', 'restore']) {
      const view = layout[name];
      check(
        `${name} view splits into two side-by-side columns`,
        view !== null && view.sideLeft >= view.mainRight - 1 && view.mainWidth > 0 && view.sideWidth > 0,
        view ? `mainRight=${view.mainRight} sideLeft=${view.sideLeft}` : 'columns missing'
      );
      check(
        `${name} side column is narrower than the main column`,
        view !== null && view.sideWidth < view.mainWidth,
        view ? `main=${view.mainWidth} side=${view.sideWidth}` : 'columns missing'
      );
    }

    check('the sidebar holds its width', layout.railWidth === 218, `${layout.railWidth}px`);
    // Whether the form is long enough to overflow depends on what is loaded,
    // so only the invariant is asserted here: the page itself must never
    // scroll, because the action bar and log dock have to stay put. That the
    // form scrolls when it is long is covered by the pinned-bar probe below.
    check(
      'the page itself never scrolls',
      layout.bodyScrolls === false,
      `body scrollHeight exceeds clientHeight`
    );
    check(
      'the action bar sits directly on top of the log dock',
      Math.abs(layout.barBottom - layout.dockTop) <= 1,
      `barBottom=${layout.barBottom} dockTop=${layout.dockTop}`
    );
    check(
      'the log dock finishes at the bottom of the window',
      Math.abs(layout.dockBottom - layout.viewport) <= 1,
      `dockBottom=${layout.dockBottom} viewport=${layout.viewport}`
    );
  } catch (error) {
    check('layout probe ran', false, error.message);
  }

  // Scrolling the form must not move the action bar, which is the button the
  // whole window is aimed at.
  try {
    const pinned = await run(
      `(() => {
        const views = document.querySelector('.views');
        const bar = document.getElementById('actionBar');
        setView('restore');
        setLogOpen(true);
        const before = bar.getBoundingClientRect().top;
        const scrollable = views.scrollHeight > views.clientHeight + 1;
        views.scrollTop = views.scrollHeight;
        const scrolled = views.scrollTop;
        const after = bar.getBoundingClientRect().top;
        views.scrollTop = 0;
        setLogOpen(false);
        setView('backup');
        return { scrollable, scrolled, shift: Math.round(Math.abs(after - before)) };
      })()`
    );

    check(
      'a long form scrolls',
      pinned.scrollable && pinned.scrolled > 0,
      `scrollable=${pinned.scrollable} scrollTop=${pinned.scrolled}`
    );
    check('the action bar does not move when the form scrolls', pinned.shift === 0, `shifted ${pinned.shift}px`);
  } catch (error) {
    check('pinned action bar probe ran', false, error.message);
  }

  // The two working views must be tellable apart at a glance, and the restore
  // button must escalate to red for the modes that delete data.
  try {
    const modes = await run(
      `(() => {
        ${CONNECT}
        const accentOf = (el) => getComputedStyle(el).getPropertyValue('--mode').trim();
        const backup = document.getElementById('view-backup');
        const restore = document.getElementById('view-restore');
        const strip = document.getElementById('flowStrip');
        const primary = document.getElementById('actionPrimary');

        setView('backup');
        const backupFlow = strip.textContent.replace(/\\s+/g, ' ').trim();

        setView('restore');
        const restoreFlow = strip.textContent.replace(/\\s+/g, ' ').trim();

        // Enough of a backup for the restore form to consider itself runnable.
        state.inspection = {
          manifest: null,
          databases: [{ name: 'demo', path: 'C:\\\\demo', collections: [{ name: 'alpha', documents: 5, bytes: 100 }] }],
        };
        document.getElementById('restoreSource').value = 'C:\\\\demo';
        // The live connection is kept: pointing at a URI that is not
        // connected would close the gate and hide the view under test.
        renderInspection();

        const escalation = {};
        const confirmVisible = {};
        const blockedUntilTicked = {};
        for (const value of ['keep', 'merge', 'drop', 'dropDatabase']) {
          const radio = document.querySelector('input[name="restoreMode"][value="' + value + '"]');
          radio.checked = true;
          radio.dispatchEvent(new Event('change'));
          escalation[value] = primary.classList.contains('is-destructive');
          confirmVisible[value] = !document.getElementById('restoreConfirmRow').classList.contains('hidden');
          blockedUntilTicked[value] = primary.disabled;
        }

        // Ticking the confirmation must be what releases the button.
        document.getElementById('restoreDropConfirm').checked = true;
        document.getElementById('restoreDropConfirm').dispatchEvent(new Event('change'));
        const releasedAfterTick = !primary.disabled;
        const confirmLabel = document.getElementById('restoreConfirmLabel').textContent;

        const keep = document.querySelector('input[name="restoreMode"][value="keep"]');
        keep.checked = true;
        keep.dispatchEvent(new Event('change'));
        setView('backup');

        return {
          backupAccent: accentOf(backup),
          restoreAccent: accentOf(restore),
          backupFlow,
          restoreFlow,
          escalation,
          confirmVisible,
          blockedUntilTicked,
          releasedAfterTick,
          confirmLabel,
        };
      })()`
    );

    check(
      'each view carries its own accent colour',
      Boolean(modes.backupAccent) &&
        Boolean(modes.restoreAccent) &&
        modes.backupAccent !== modes.restoreAccent,
      `backup=${modes.backupAccent} restore=${modes.restoreAccent}`
    );
    check(
      'the backup strip states data flows out and nothing changes',
      /MongoDB/.test(modes.backupFlow) &&
        /folder on disk/.test(modes.backupFlow) &&
        /Nothing in your databases changes/.test(modes.backupFlow),
      modes.backupFlow
    );
    check(
      'the restore strip states data flows in and the database is modified',
      /target database.*is modified/.test(modes.restoreFlow),
      modes.restoreFlow
    );
    check(
      'the restore button turns red only for the destructive modes',
      modes.escalation.keep === false &&
        modes.escalation.merge === false &&
        modes.escalation.drop === true &&
        modes.escalation.dropDatabase === true,
      JSON.stringify(modes.escalation)
    );
    check(
      'the confirmation strip appears only for the destructive modes',
      modes.confirmVisible.keep === false &&
        modes.confirmVisible.merge === false &&
        modes.confirmVisible.drop === true &&
        modes.confirmVisible.dropDatabase === true,
      JSON.stringify(modes.confirmVisible)
    );
    check(
      'a destructive restore is blocked until the confirmation is ticked',
      modes.blockedUntilTicked.keep === false &&
        modes.blockedUntilTicked.drop === true &&
        modes.blockedUntilTicked.dropDatabase === true &&
        modes.releasedAfterTick === true,
      JSON.stringify(modes.blockedUntilTicked) + ` released=${modes.releasedAfterTick}`
    );
    check(
      'the confirmation names the database it is about to delete',
      /will be deleted first/.test(modes.confirmLabel),
      modes.confirmLabel
    );
  } catch (error) {
    check('mode identity probe ran', false, error.message);
  }

  // Theme is a real preference, not just a class name.
  try {
    const theme = await run(
      `(() => {
        const bg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        const titlebar = () =>
          getComputedStyle(document.querySelector('.titlebar')).backgroundColor;
        document.getElementById('themeLight').click();
        const light = { attr: document.documentElement.getAttribute('data-theme'), bg: bg(), titlebar: titlebar() };
        document.getElementById('themeDark').click();
        const dark = { attr: document.documentElement.getAttribute('data-theme'), bg: bg(), titlebar: titlebar() };
        return {
          light,
          dark,
          savedPref: state.settings.prefs.theme,
          activeButton: document.getElementById('themeDark').classList.contains('is-active'),
        };
      })()`
    );

    check(
      'the light and dark themes really repaint',
      theme.light.attr === 'light' &&
        theme.dark.attr === 'dark' &&
        theme.light.bg !== theme.dark.bg &&
        theme.light.titlebar !== theme.dark.titlebar,
      `light=${theme.light.bg}/${theme.light.titlebar} dark=${theme.dark.bg}/${theme.dark.titlebar}`
    );
    check(
      'the choice is remembered and shown on the button',
      theme.savedPref === 'dark' && theme.activeButton === true,
      `pref=${theme.savedPref} active=${theme.activeButton}`
    );
  } catch (error) {
    check('theme probe ran', false, error.message);
  }

  // The log dock collapses to a single line, and expanding it must reveal a
  // log with real height rather than a zero-height box.
  try {
    const dock = await run(
      `(() => {
        setLogOpen(false);
        const collapsed = {
          height: Math.round(document.getElementById('log').clientHeight),
          tail: document.getElementById('logTail').textContent,
        };
        document.getElementById('logToggle').click();
        const openHeight = Math.round(document.getElementById('log').clientHeight);
        const openClass = document.body.classList.contains('log-open');
        document.getElementById('logToggle').click();
        return { collapsed, openHeight, openClass, reclosed: Math.round(document.getElementById('log').clientHeight) };
      })()`
    );

    check('the log dock collapses to nothing', dock.collapsed.height === 0 && dock.reclosed === 0);
    check(
      'the collapsed dock still shows the newest line',
      dock.collapsed.tail.length > 0,
      dock.collapsed.tail
    );
    check(
      'expanding it reveals a readable log',
      dock.openClass === true && dock.openHeight > 100,
      `height=${dock.openHeight}`
    );
  } catch (error) {
    check('log dock probe ran', false, error.message);
  }

  // The history view is fed by the main process, and hides the action bar
  // because there is nothing on it to run.
  try {
    const history = await run(
      `(async () => {
        setView('history');
        await new Promise((r) => setTimeout(r, 200));
        const barHidden = document.getElementById('actionBar').classList.contains('hidden');
        const emptyText = document.getElementById('historyList').textContent;

        // Render a run the way a finished job would.
        state.history = [{
          id: 'test-run', kind: 'backup', status: 'done', database: 'demo',
          host: '127.0.0.1:27017', detail: 'gzip', folder: 'C:\\\\demo',
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          durationMs: 1200, error: '',
          totals: { collections: 1, documents: 5, bytes: 100 },
          collections: [{ name: 'alpha', documents: 5, bytes: 100, indexes: 1, status: 'done' }],
        }];
        renderHistory();
        const rows = document.querySelectorAll('.run').length;
        const collapsed = document.querySelectorAll('.run-row').length;
        document.querySelector('.run-head').click();
        const expanded = document.querySelectorAll('.run-row').length;
        const text = document.querySelector('.run').textContent.replace(/\\s+/g, ' ');
        // The same run, but over several databases: History has to describe it
        // the way the form did rather than naming one and listing the rest.
        state.history = [{
          id: 'multi-run', kind: 'backup', status: 'done', database: '',
          host: '127.0.0.1:27017', detail: '', folder: 'C:\\\\demo',
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          durationMs: 900, error: '',
          totals: { databases: 2, collections: 3, documents: 9, bytes: 300 },
          collections: [],
          databases: [
            { name: 'shop', status: 'done', totals: { collections: 2, documents: 7, bytes: 200 },
              collections: [
                { name: 'orders', documents: 5, bytes: 150, indexes: 1, status: 'done' },
                { name: 'users', documents: 2, bytes: 50, indexes: 0, status: 'done' } ] },
            { name: 'billing', status: 'done', totals: { collections: 1, documents: 2, bytes: 100 },
              collections: [
                { name: 'invoices', documents: 2, bytes: 100, indexes: 0, status: 'done' } ] },
          ],
        }];
        state.openRun = 'multi-run';
        renderHistory();
        const multi = {
          db: document.querySelector('.run-db').textContent,
          detail: document.querySelector('.run-detail').textContent,
          groups: [...document.querySelectorAll('.run-group')].map((el) => ({
            name: el.querySelector('.name').textContent,
            open: el.classList.contains('is-open'),
            nested: el.querySelectorAll('.run-row').length,
          })),
        };
        document.querySelectorAll('.run-group-head')[0].click();
        multi.afterOpen = [...document.querySelectorAll('.run-group')[0].querySelectorAll('.run-row .name')]
          .map((el) => el.textContent);
        // Collapsing the run must not leave its databases open underneath.
        document.querySelector('.run-head').click();
        multi.forgotten = state.openRunDatabases.size;

        state.history = [];
        state.openRun = null;
        state.openRunDatabases.clear();
        renderHistory();
        setView('backup');
        return { barHidden, emptyText, rows, collapsed, expanded, text, multi };
      })()`
    );

    check('the history view hides the action bar', history.barHidden === true);
    check(
      'an empty history explains itself',
      /recorded here/.test(history.emptyText),
      history.emptyText.slice(0, 90)
    );
    check('a recorded run renders as a row', history.rows === 1, `rows=${history.rows}`);
    check(
      'runs start collapsed and expand to per-collection detail',
      history.collapsed === 0 && history.expanded === 1,
      `collapsed=${history.collapsed} expanded=${history.expanded}`
    );
    check(
      'the row names the database, the host and the outcome',
      /demo/.test(history.text) && /127\.0\.0\.1/.test(history.text) && /Done/.test(history.text),
      history.text.slice(0, 120)
    );
    check(
      'a multi-database run counts its databases and names them in the detail',
      history.multi.db === '2 databases' &&
        /shop/.test(history.multi.detail) &&
        /billing/.test(history.multi.detail),
      JSON.stringify({ db: history.multi.db, detail: history.multi.detail })
    );
    check(
      'it opens onto a collapsed row per database, not a flat collection list',
      history.multi.groups.length === 2 &&
        history.multi.groups.every((group) => !group.open && group.nested === 0),
      JSON.stringify(history.multi.groups)
    );
    check(
      'opening one database shows that database\'s collections',
      JSON.stringify(history.multi.afterOpen) === JSON.stringify(['orders', 'users']),
      JSON.stringify(history.multi.afterOpen)
    );
    check(
      'collapsing the run forgets which of its databases were open',
      history.multi.forgotten === 0,
      `${history.multi.forgotten} left open`
    );
  } catch (error) {
    check('history probe ran', false, error.message);
  }

  // Adding and editing connections, including the bug where "+" edited the
  // selected connection instead of adding a second one.
  try {
    const conn = await run(
      `(async () => {
        if (!state.settings.encryptionAvailable) return { skipped: true };

        const dialog = document.getElementById('connectionDialog');
        const nameField = document.getElementById('connectionName');
        const uriField = document.getElementById('connectionUri');
        const deleteButton = document.getElementById('connectionDelete');
        const settle = () => new Promise((r) => setTimeout(r, 250));
        const snapshot = () => ({
          open: dialog.open === true,
          title: document.getElementById('connectionDialogTitle').textContent,
          name: nameField.value,
          uri: uriField.value,
          production: document.getElementById('connectionProduction').checked,
          deleteHidden: deleteButton.classList.contains('hidden'),
        });
        const save = async (name, uri, production) => {
          nameField.value = name;
          uriField.value = uri;
          document.getElementById('connectionProduction').checked = Boolean(production);
          document.getElementById('connectionSave').click();
          await settle();
        };

        // Start from an empty list so the counts below mean something.
        for (const profile of [...state.settings.profiles]) {
          const result = await window.api.deleteProfile(profile.id);
          if (result.ok) state.settings = result.data;
        }
        state.activeProfileId = null;
        renderConnections();

        const out = {};

        // Add the first one through the dialog.
        document.getElementById('connectionAdd').click();
        out.addFresh = snapshot();
        await save('Alpha', 'mongodb://127.0.0.1:27017/?alpha=1', false);
        out.afterFirst = state.settings.profiles.map((p) => p.name);

        // Select it — the state the bug needed — then press + again.
        const alpha = state.settings.profiles.find((p) => p.name === 'Alpha');
        state.activeProfileId = alpha.id;
        setUri(alpha.uri, { silent: true });
        renderConnections();

        document.getElementById('connectionAdd').click();
        out.addWithOneSelected = snapshot();
        await save('Beta', 'mongodb://127.0.0.1:27017/?beta=1', true);
        out.afterSecond = state.settings.profiles.map((p) => p.name).sort();
        out.alphaSurvived = state.settings.profiles.some(
          (p) => p.name === 'Alpha' && p.uri === 'mongodb://127.0.0.1:27017/?alpha=1'
        );

        // A duplicate name must be refused, not silently merged.
        document.getElementById('connectionAdd').click();
        await save('Alpha', 'mongodb://127.0.0.1:27017/?clash=1', false);
        out.duplicate = {
          stillOpen: dialog.open === true,
          message: document.getElementById('connectionStatus').textContent,
          count: state.settings.profiles.length,
        };
        document.getElementById('connectionCancel').click();
        await settle();

        // The row's Edit button opens the same dialog, filled in.
        const betaRow = [...document.querySelectorAll('.conn')].find((row) =>
          row.textContent.includes('Beta')
        );
        out.betaChip = Boolean(betaRow) && Boolean(betaRow.querySelector('.conn-prod'));
        out.betaFlagged = Boolean(betaRow) && betaRow.classList.contains('is-production');
        betaRow.querySelector('.conn-edit').click();
        out.editOpen = snapshot();
        await save('Beta renamed', 'mongodb://127.0.0.1:27017/?beta=1', true);
        out.afterEdit = state.settings.profiles.map((p) => p.name).sort();

        // A connection marked production forces the in-form confirmation even
        // in the safe restore mode.
        setUri('mongodb://127.0.0.1:27017/?beta=1', { silent: true });
        applyConnectionState({
          uri: 'mongodb://127.0.0.1:27017/?beta=1',
          status: 'connected', serverVersion: '7.0.11', topology: 'Single', error: null,
        });
        setView('restore');
        const keep = document.querySelector('input[name=\"restoreMode\"][value=\"keep\"]');
        keep.checked = true;
        keep.dispatchEvent(new Event('change'));
        out.production = {
          detected: isProductionConnection(),
          confirmShown: !document.getElementById('restoreConfirmRow').classList.contains('hidden'),
          label: document.getElementById('connectionStatus') && document.getElementById('restoreConfirmLabel').textContent,
          blocked: document.getElementById('actionPrimary').disabled,
        };

        // And not for an ordinary one.
        setUri('mongodb://127.0.0.1:27017/?alpha=1', { silent: true });
        applyConnectionState({
          uri: 'mongodb://127.0.0.1:27017/?alpha=1',
          status: 'connected', serverVersion: '7.0.11', topology: 'Single', error: null,
        });
        keep.dispatchEvent(new Event('change'));
        out.ordinary = {
          detected: isProductionConnection(),
          confirmShown: !document.getElementById('restoreConfirmRow').classList.contains('hidden'),
        };

        setView('backup');
        return out;
      })()`
    );

    if (conn.skipped) {
      console.log('  SKIPPED  credential encryption unavailable, cannot test connections');
    } else {
      check(
        'the + button opens an empty New connection dialog',
        conn.addFresh.open === true &&
          conn.addFresh.title === 'New connection' &&
          conn.addFresh.name === '' &&
          conn.addFresh.deleteHidden === true,
        JSON.stringify(conn.addFresh)
      );
      check(
        'saving from the dialog adds the connection',
        JSON.stringify(conn.afterFirst) === JSON.stringify(['Alpha']),
        JSON.stringify(conn.afterFirst)
      );
      // The reported bug: + with a connection selected renamed that one.
      check(
        '+ stays a New connection even with one selected, and does not pre-fill it',
        conn.addWithOneSelected.title === 'New connection' &&
          conn.addWithOneSelected.name === '' &&
          conn.addWithOneSelected.uri === '' &&
          conn.addWithOneSelected.deleteHidden === true,
        JSON.stringify(conn.addWithOneSelected)
      );
      check(
        '+ with one selected adds a second connection rather than renaming it',
        JSON.stringify(conn.afterSecond) === JSON.stringify(['Alpha', 'Beta']) &&
          conn.alphaSurvived === true,
        JSON.stringify(conn.afterSecond) + ` alphaIntact=${conn.alphaSurvived}`
      );
      check(
        'a duplicate name is refused instead of overwriting',
        conn.duplicate.stillOpen === true &&
          /already exists/.test(conn.duplicate.message) &&
          conn.duplicate.count === 2,
        JSON.stringify(conn.duplicate)
      );
      check(
        'the row Edit button opens the dialog filled in, with Delete offered',
        conn.editOpen.title === 'Edit connection' &&
          conn.editOpen.name === 'Beta' &&
          conn.editOpen.uri === 'mongodb://127.0.0.1:27017/?beta=1' &&
          conn.editOpen.production === true &&
          conn.editOpen.deleteHidden === false,
        JSON.stringify(conn.editOpen)
      );
      check(
        'editing renames in place rather than adding a third',
        JSON.stringify(conn.afterEdit) === JSON.stringify(['Alpha', 'Beta renamed']),
        JSON.stringify(conn.afterEdit)
      );
      check(
        'a production connection is flagged in the sidebar',
        conn.betaChip === true && conn.betaFlagged === true,
        `chip=${conn.betaChip} flagged=${conn.betaFlagged}`
      );
      check(
        'production forces the in-form confirmation even in the safe restore mode',
        conn.production.detected === true &&
          conn.production.confirmShown === true &&
          /marked production/.test(conn.production.label || '') &&
          conn.production.blocked === true,
        JSON.stringify(conn.production)
      );
      check(
        'an ordinary connection does not demand it',
        conn.ordinary.detected === false && conn.ordinary.confirmShown === false,
        JSON.stringify(conn.ordinary)
      );

      // Nothing that reaches disk may carry a connection string.
      const settingsFile = path.join(PROFILE_DIR, 'settings.json');
      const raw = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
      check(
        'saved connection strings are encrypted on disk, never plain text',
        raw.length > 0 && raw.includes('Alpha') && !raw.includes('127.0.0.1:27017'),
        raw.slice(0, 200)
      );
    }
  } catch (error) {
    check('connection dialog probe ran', false, error.message);
  }

  check(
    'no renderer console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ')
  );

  finish();
});

function finish() {
  const failed = problems.length;
  console.log(failed === 0 ? '\nUI check passed.' : `\nUI check FAILED (${failed} problem(s)).`);

  // Best-effort: Electron still holds handles inside userData on Windows, so a
  // failed delete must never stop us reaching app.exit() — that would hang.
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* the OS clears its temp folder eventually */
  }

  app.exit(failed === 0 ? 0 : 1);
}
