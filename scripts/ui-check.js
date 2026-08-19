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
// reads or writes the real saved connections and preferences.
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

const PROBE = `(() => {
  const ids = [
    'backupUri', 'backupDatabase', 'backupOutput', 'backupStart', 'backupGzip',
    'restoreUri', 'restoreSource', 'restoreTargetDatabase', 'restoreStart',
    'progressRows', 'log', 'statusTitle', 'progressFill', 'jobCancel',
  ];
  return {
    hasApi: typeof window.api === 'object' && window.api !== null,
    apiMethods: window.api ? Object.keys(window.api).sort() : [],
    missingIds: ids.filter((id) => !document.getElementById(id)),
    tabCount: document.querySelectorAll('.tab').length,
    activePanel: (document.querySelector('.panel.is-active') || {}).id || null,
    restoreModes: [...document.querySelectorAll('input[name="restoreMode"]')].map((el) => el.value),
    logLines: document.querySelectorAll('#log .log-line').length,
    statusTitle: document.getElementById('statusTitle').textContent,
    versionPill: document.getElementById('appVersion').textContent,
    backupOutput: document.getElementById('backupOutput').value,
    cancelHidden: document.getElementById('jobCancel').classList.contains('hidden'),
    bodyOverflows: document.body.scrollWidth > window.innerWidth + 1,
  };
})()`;

const EXPECTED_API = [
  'appInfo', 'cancelJob', 'confirm', 'deleteProfile', 'getSettings', 'inspectBackup',
  'listCollections', 'listDatabases', 'onJobEvent', 'openPath', 'saveLog', 'savePrefs',
  'saveProfile', 'selectFolder', 'startBackup', 'startRestore', 'surveyConnection',
  'testConnection',
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

  try {
    const probe = await window.webContents.executeJavaScript(PROBE, true);

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
    check('two tabs render, Backup active', probe.tabCount === 2 && probe.activePanel === 'panel-backup', `tabs=${probe.tabCount} active=${probe.activePanel}`);
    check(
      'all four restore modes render',
      probe.restoreModes.length === 4 && probe.restoreModes[0] === 'keep',
      probe.restoreModes.join(', ')
    );
    check('renderer init() ran (log has lines)', probe.logLines > 0, `lines=${probe.logLines}`);
    check('status starts at Idle', probe.statusTitle === 'Idle', probe.statusTitle);
    check('cancel button starts hidden', probe.cancelHidden === true);
    check(
      'appInfo IPC round trip populated the version pill',
      /^v\d+\.\d+\.\d+ · Electron/.test(probe.versionPill),
      `pill="${probe.versionPill}"`
    );
    {
      // The displayed version must be the app's, not Electron's.
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
      check(
        'the version shown is the app version from package.json',
        probe.versionPill.startsWith(`v${pkg.version} ·`),
        `pill="${probe.versionPill}" package.json=${pkg.version}`
      );
    }
    check(
      'default backup folder was filled in',
      /MongoDB Backups$/.test(probe.backupOutput),
      probe.backupOutput
    );
    check('page does not scroll horizontally', probe.bodyOverflows === false);

    // Exercise a real IPC call that touches MongoDB error handling.
    const badConnection = await window.webContents.executeJavaScript(
      "window.api.testConnection('not-a-uri')",
      true
    );
    check(
      'a bad URI comes back as a handled error, not a crash',
      badConnection && badConnection.ok === false && /mongodb:\/\//.test(badConnection.error),
      JSON.stringify(badConnection)
    );

    const settings = await window.webContents.executeJavaScript('window.api.getSettings()', true);
    check(
      'settings load and report credential-encryption support',
      settings && settings.ok === true && typeof settings.data.encryptionAvailable === 'boolean',
      JSON.stringify(settings && settings.data && { enc: settings.data.encryptionAvailable })
    );
  } catch (error) {
    check('probe executed', false, error.message);
  }

  // A server with dozens of databases must still be pickable: the native
  // <datalist> this replaced grew past the window with no way to scroll.
  try {
    const combo = await window.webContents.executeJavaScript(
      `(() => {
        const names = Array.from({ length: 45 }, (_, i) => ({
          name: 'database-number-' + String(i).padStart(2, '0'),
          sizeOnDisk: (i + 1) * 1048576,
        }));
        state.combos.backup.setItems(names);
        const input = document.getElementById('backupDatabase');
        const previous = input.value;
        input.value = '';
        input.focus();
        const popup = document.querySelector('.combo-popup:not([hidden])');
        if (!popup) return { opened: false };
        const rect = popup.getBoundingClientRect();
        const result = {
          opened: true,
          options: popup.querySelectorAll('.combo-option').length,
          clientHeight: Math.round(popup.clientHeight),
          scrollHeight: Math.round(popup.scrollHeight),
          insideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
        };
        popup.scrollTop = 99999;
        result.scrolled = popup.scrollTop > 0;
        input.value = 'number-3';
        input.dispatchEvent(new Event('input'));
        result.filtered = document.querySelectorAll(
          '.combo-popup:not([hidden]) .combo-option'
        ).length;

        // With a database committed, reopening must show every database again
        // rather than filtering the list down to the chosen name alone.
        input.value = 'database-number-07';
        input.blur();
        input.focus();
        const reopened = document.querySelector('.combo-popup:not([hidden])');
        result.afterChoosing = reopened.querySelectorAll('.combo-option').length;
        const chosen = reopened.querySelector('.combo-option.is-chosen');
        result.chosenMarked = Boolean(chosen) && chosen.textContent.includes('database-number-07');
        result.chosenIsActive = Boolean(chosen) && chosen.classList.contains('is-active');

        // Typing again must still narrow the list.
        input.dispatchEvent(new Event('input'));
        result.searchStillWorks = reopened.querySelectorAll('.combo-option').length;

        input.value = previous;
        input.dispatchEvent(new Event('input'));
        input.blur();
        return result;
      })()`,
      true
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
      'reopening with a database chosen still lists all 45',
      combo.afterChoosing === 45,
      `got ${combo.afterChoosing}`
    );
    check(
      'the chosen database is ticked and pre-selected in the list',
      combo.chosenMarked === true && combo.chosenIsActive === true,
      `marked=${combo.chosenMarked} active=${combo.chosenIsActive}`
    );
    check(
      'typing after choosing still searches (45 -> 1)',
      combo.searchStillWorks === 1,
      `got ${combo.searchStillWorks}`
    );
  } catch (error) {
    check('database picker probe ran', false, error.message);
  }

  // Clicking the version opens About, and it must carry the attribution.
  try {
    const about = await window.webContents.executeJavaScript(
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
      })()`,
      true
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
      /Version \d+\.\d+\.\d+/.test(about.text) &&
        /Electron .+Chromium .+Node /.test(about.text),
      about.text.slice(0, 200)
    );
  } catch (error) {
    check('About dialog probe ran', false, error.message);
  }

  // Both panels split into main (left) and advanced (right); the activity panel
  // below must stay full width and unaffected by that split.
  try {
    const layout = await window.webContents.executeJavaScript(
      `(() => {
        const read = (panelId) => {
          const panel = document.getElementById(panelId);
          const wasActive = panel.classList.contains('is-active');
          if (!wasActive) panel.classList.add('is-active');
          const main = panel.querySelector('.col-main');
          const advanced = panel.querySelector('.col-advanced');
          const actions = panel.querySelector('.section-actions');
          const out = main && advanced
            ? {
                main: main.getBoundingClientRect(),
                advanced: advanced.getBoundingClientRect(),
                actions: actions ? actions.getBoundingClientRect().width : 0,
              }
            : null;
          if (!wasActive) panel.classList.remove('is-active');
          if (!out) return null;
          return {
            mainRight: Math.round(out.main.right),
            mainWidth: Math.round(out.main.width),
            mainHeight: Math.round(out.main.height),
            advLeft: Math.round(out.advanced.left),
            advWidth: Math.round(out.advanced.width),
            advHeight: Math.round(out.advanced.height),
            actionsWidth: Math.round(out.actions),
          };
        };
        return {
          backup: read('panel-backup'),
          restore: read('panel-restore'),
          statusWidth: Math.round(document.querySelector('.status').getBoundingClientRect().width),
          viewport: window.innerWidth,
        };
      })()`,
      true
    );

    for (const name of ['backup', 'restore']) {
      const panel = layout[name];
      check(
        `${name} panel splits into two side-by-side columns`,
        panel !== null &&
          panel.advLeft >= panel.mainRight - 1 &&
          panel.mainWidth > 0 &&
          panel.advWidth > 0,
        panel ? `mainRight=${panel.mainRight} advLeft=${panel.advLeft}` : 'columns missing'
      );
      check(
        `${name} advanced column is narrower than the main column`,
        panel !== null && panel.advWidth < panel.mainWidth,
        panel ? `main=${panel.mainWidth} advanced=${panel.advWidth}` : 'columns missing'
      );
      // Stretching is what lets the divider run the full height of the pair.
      check(
        `${name} columns share a full-height divider`,
        panel !== null && panel.advHeight === panel.mainHeight,
        panel ? `main=${panel.mainHeight} advanced=${panel.advHeight}` : 'columns missing'
      );
    }

    check(
      'activity panel still spans the full window width',
      Math.abs(layout.statusWidth - layout.viewport) <= 1,
      `status=${layout.statusWidth} viewport=${layout.viewport}`
    );
  } catch (error) {
    check('two-column layout probe ran', false, error.message);
  }

  // The two tabs must be tellable apart at a glance, and the restore button
  // must escalate to red for the modes that delete data.
  try {
    const modes = await window.webContents.executeJavaScript(
      `(() => {
        const accentOf = (el) => getComputedStyle(el).getPropertyValue('--mode').trim();
        const backup = document.getElementById('panel-backup');
        const restore = document.getElementById('panel-restore');
        const button = document.getElementById('restoreStart');

        const escalation = {};
        for (const value of ['keep', 'merge', 'drop', 'dropDatabase']) {
          const radio = document.querySelector('input[name="restoreMode"][value="' + value + '"]');
          radio.checked = true;
          radio.dispatchEvent(new Event('change'));
          escalation[value] = button.classList.contains('is-destructive');
        }
        const keep = document.querySelector('input[name="restoreMode"][value="keep"]');
        keep.checked = true;
        keep.dispatchEvent(new Event('change'));

        return {
          backupAccent: accentOf(backup),
          restoreAccent: accentOf(restore),
          backupBanner: (backup.querySelector('.mode-banner') || {}).textContent || '',
          restoreBanner: (restore.querySelector('.mode-banner') || {}).textContent || '',
          escalation,
        };
      })()`,
      true
    );

    check(
      'each panel carries its own accent colour',
      Boolean(modes.backupAccent) &&
        Boolean(modes.restoreAccent) &&
        modes.backupAccent !== modes.restoreAccent,
      `backup=${modes.backupAccent} restore=${modes.restoreAccent}`
    );
    check(
      'the backup banner states data flows out and nothing changes',
      /MongoDB/.test(modes.backupBanner) &&
        /folder on disk/.test(modes.backupBanner) &&
        /Nothing in your databases changes/.test(modes.backupBanner),
      modes.backupBanner.replace(/\s+/g, ' ').trim()
    );
    check(
      'the restore banner states data flows in and the database is modified',
      /target database is modified/.test(modes.restoreBanner),
      modes.restoreBanner.replace(/\s+/g, ' ').trim()
    );
    check(
      'the restore button turns red only for the destructive modes',
      modes.escalation.keep === false &&
        modes.escalation.merge === false &&
        modes.escalation.drop === true &&
        modes.escalation.dropDatabase === true,
      JSON.stringify(modes.escalation)
    );
  } catch (error) {
    check('mode identity probe ran', false, error.message);
  }

  // Each column scrolls on its own, and the primary action holds one position
  // directly above the activity panel no matter how far a column is scrolled.
  try {
    const pinned = await window.webContents.executeJavaScript(
      `(() => {
        const backup = document.getElementById('panel-backup');
        const panel = document.getElementById('panel-restore');
        backup.classList.remove('is-active');
        panel.classList.add('is-active');
        // Expanding the activity panel squeezes the form, guaranteeing overflow.
        document.body.classList.add('status-open');

        const main = panel.querySelector('.col-main');
        const advanced = panel.querySelector('.col-advanced');
        const actions = panel.querySelector('.section-actions');
        const status = document.querySelector('.status');
        const content = document.querySelector('.content');

        const before = actions.getBoundingClientRect();
        const scrollable = main.scrollHeight > main.clientHeight + 1;
        main.scrollTop = main.scrollHeight;
        const scrolled = main.scrollTop;
        const advUnmoved = advanced.scrollTop === 0;
        const after = actions.getBoundingClientRect();

        const result = {
          scrollable,
          scrolled,
          advUnmoved,
          actionsShift: Math.round(Math.abs(after.top - before.top)),
          actionsBottom: Math.round(after.bottom),
          statusTop: Math.round(status.getBoundingClientRect().top),
          outerScrolls: content.scrollHeight > content.clientHeight + 1,
          columnsSeparate: main !== advanced,
        };

        main.scrollTop = 0;
        document.body.classList.remove('status-open');
        panel.classList.remove('is-active');
        backup.classList.add('is-active');
        return result;
      })()`,
      true
    );

    check(
      'a long column scrolls on its own',
      pinned.scrollable && pinned.scrolled > 0,
      `scrollable=${pinned.scrollable} scrollTop=${pinned.scrolled}`
    );
    check(
      'scrolling one column leaves the other alone',
      pinned.advUnmoved === true && pinned.columnsSeparate
    );
    check(
      'the form frame itself never scrolls',
      pinned.outerScrolls === false,
      `content overflows=${pinned.outerScrolls}`
    );
    check(
      'the action bar does not move when a column scrolls',
      pinned.actionsShift === 0,
      `shifted ${pinned.actionsShift}px`
    );
    check(
      'the action bar sits directly on top of the activity panel',
      Math.abs(pinned.actionsBottom - pinned.statusTop) <= 1,
      `actionsBottom=${pinned.actionsBottom} statusTop=${pinned.statusTop}`
    );
  } catch (error) {
    check('pinned action bar probe ran', false, error.message);
  }

  // The expanded activity panel must fill its own height: the table and log are
  // flex children, and without flex-grow they stop at their content and leave
  // dead space under the last log line.
  try {
    const panel = await window.webContents.executeJavaScript(
      `(() => {
        document.body.classList.add('status-open');
        const status = document.querySelector('.status');
        const body = document.querySelector('.status-body');
        const head = document.querySelector('.status-head');
        const log = document.getElementById('log');
        const table = document.querySelector('.table-wrap');
        const r = {
          statusHeight: Math.round(status.clientHeight),
          bodyHeight: Math.round(body.clientHeight),
          headHeight: Math.round(head.clientHeight),
          logHeight: Math.round(log.clientHeight),
          tableHeight: Math.round(table.clientHeight),
          viewport: window.innerHeight,
        };
        document.body.classList.remove('status-open');
        return r;
      })()`,
      true
    );

    // status = head + 2px progress track + body, so the body should claim
    // everything the head does not.
    const expected = panel.statusHeight - panel.headHeight - 2;
    check(
      'expanded panel body fills the panel height',
      Math.abs(panel.bodyHeight - expected) <= 2,
      `body=${panel.bodyHeight} expected~${expected} (status=${panel.statusHeight} head=${panel.headHeight})`
    );
    check(
      'log and table both fill the body height',
      panel.logHeight === panel.bodyHeight && panel.tableHeight === panel.bodyHeight,
      `log=${panel.logHeight} table=${panel.tableHeight} body=${panel.bodyHeight}`
    );
    check(
      'panel takes a sane share of the window',
      panel.statusHeight > panel.viewport * 0.3 && panel.statusHeight < panel.viewport * 0.5,
      `status=${panel.statusHeight} viewport=${panel.viewport}`
    );
  } catch (error) {
    check('expanded panel probe ran', false, error.message);
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
