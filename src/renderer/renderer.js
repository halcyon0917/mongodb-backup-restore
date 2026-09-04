'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  view: 'backup',
  theme: 'dark',
  maximized: false,

  activeJobId: null,
  running: null, // 'backup' | 'restore' while a job is in flight
  // How the last run ended, so the action bar reports it instead of
  // silently returning to "Ready" as though nothing had happened.
  outcome: null, // { kind, status: 'done'|'failed'|'cancelled', detail }

  settings: { prefs: {}, profiles: [], encryptionAvailable: false },
  activeProfileId: null,
  // uri -> { status, serverVersion, topology, error }, pushed by the main
  // process from the driver's own topology monitoring. The sidebar dot reads
  // from here, so it means "this server is reachable now" rather than "a
  // handshake succeeded at some point".
  connections: new Map(),

  // Databases chosen for the next backup. Empty until the user picks: nothing
  // is selected for them on connect.
  selectedDatabases: [],
  // 'none' | 'collections' | 'databases' — what the Collections card is listing.
  backupListMode: 'none',
  // name -> { open, loading, error, collections, selected }
  //   collections: null until the group is expanded and its list fetched
  //   selected:    null means "all of them", including any not yet loaded
  databaseGroups: new Map(),

  inspection: null,
  preview: null,
  history: [],
  openRun: null,
  // "<runId>/<database>" for each expanded database inside an open run.
  openRunDatabases: new Set(),

  lastBackupFolder: null,
  logLines: [],

  progress: { total: 0, done: 0, fraction: 0 },
  combos: { backup: null, restore: null },
  // Guards the auto-load of the backup collection list: `key` is the
  // uri+database already shown, `token` fences out superseded responses.
  collections: { key: null, token: 0 },
  // Fences out a slow connection when another one is picked meanwhile.
  connect: { token: 0 },
};

/* ───────────────────────────── formatting ───────────────────────────── */

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`;
}

const formatNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';

const plural = (count, word) => `${formatNumber(count)} ${word}${count === 1 ? '' : 's'}`;

/** The host part of a URI, with any credentials stripped. */
function hostFromUri(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(String(uri || '').trim());
  return match ? match[1] : '';
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/** Unwrap the { ok, data, error } envelope every IPC handler returns. */
function unwrap(result) {
  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'The operation failed.');
  }
  return result.data;
}

/** Build an element in one call; children may be nodes or strings. */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/* ─────────────────────────────── logging ────────────────────────────── */

function log(level, message) {
  const time = new Date().toLocaleTimeString();
  state.logLines.push(`[${time}] ${level.toUpperCase()}: ${message}`);

  const line = el('div', `log-line ${level}`);
  line.append(el('span', 'time', time), el('span', 'msg', message));

  const logEl = $('log');
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;

  // The collapsed dock shows only the newest line, so it is still worth
  // glancing at without expanding anything.
  $('logTail').textContent = `${time}  ${message}`;
}

function setLogOpen(open) {
  document.body.classList.toggle('log-open', open);
  $('logToggle').setAttribute('aria-expanded', String(open));
  if (open) {
    const logEl = $('log');
    logEl.scrollTop = logEl.scrollHeight;
  }
}

/* ───────────────────────────── theme ────────────────────────────────── */

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  $('themeDark').classList.toggle('is-active', state.theme === 'dark');
  $('themeLight').classList.toggle('is-active', state.theme === 'light');
}

/* ─────────────────────── connection, shared by both views ───────────── */

/**
 * The app talks to one server at a time.
 *
 * The sidebar lists connections for the whole app rather than per view, so the
 * two URI fields are two windows onto one value. Keeping them in step is also
 * the safer arrangement: the restore view always shows the server it is about
 * to write to, instead of quietly holding a stale one from an earlier session.
 */
function currentUri() {
  return $('backupUri').value.trim();
}

function setUri(value, { silent = false } = {}) {
  $('backupUri').value = value;
  $('restoreUri').value = value;
  if (!silent) {
    state.collections.key = null;
    refreshConnectionState();
    refreshFlow();
    refreshActionBar();
  }
}

/** The pooled state of a URI, defaulting to "never used". */
function connectionState(uri) {
  return (
    state.connections.get(uri) || {
      status: 'idle',
      serverVersion: null,
      topology: null,
      error: null,
    }
  );
}

/** True when the connection in the form is live right now. */
function isConnected() {
  const uri = currentUri();
  return Boolean(uri) && connectionState(uri).status === 'connected';
}

const CONNECTION_LABEL = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  lost: 'Disconnected',
};

function setConnectionState(stateName, text) {
  for (const id of ['backupConnState', 'restoreConnState']) {
    const badge = $(id);
    badge.dataset.state = stateName;
    badge.textContent = text;
  }
}

/** Repaint the two connection badges from the pooled state of the form's URI. */
function refreshConnectionState() {
  const uri = currentUri();
  if (!uri) {
    setConnectionState('idle', 'No connection');
    return;
  }
  const entry = connectionState(uri);
  if (entry.status === 'connected') {
    setConnectionState(
      'ok',
      entry.serverVersion ? `Connected · MongoDB ${entry.serverVersion}` : 'Connected'
    );
  } else if (entry.status === 'lost') {
    setConnectionState('error', 'Disconnected');
  } else if (entry.status === 'connecting') {
    setConnectionState('idle', 'Connecting…');
  } else {
    setConnectionState('idle', 'Not connected');
  }
}

/**
 * Apply a connection state pushed from the main process.
 *
 * These arrive unprompted — the driver notices a server going away or coming
 * back on its own — so everything that depends on being connected is refreshed
 * from here rather than only after a user action.
 */
function applyConnectionState(payload) {
  const previous = connectionState(payload.uri).status;
  state.connections.set(payload.uri, {
    status: payload.status,
    serverVersion: payload.serverVersion,
    topology: payload.topology,
    error: payload.error,
  });

  if (payload.uri === currentUri() && payload.status !== previous) {
    if (payload.status === 'lost') {
      log('warn', `Lost the connection to ${hostFromUri(payload.uri) || 'the server'}.`);
    } else if (payload.status === 'connected' && previous === 'lost') {
      log('success', `Reconnected to ${hostFromUri(payload.uri) || 'the server'}.`);
    }
  }

  renderConnections();
  renderConnectList();
  refreshConnectionState();
  refreshGate();
  refreshActionBar();
}

/* ───────────────────────────── navigation ───────────────────────────── */

/** Views that cannot show anything truthful without a live connection. */
const NEEDS_CONNECTION = new Set(['backup', 'restore']);

function setView(name) {
  // Asking for a view that needs a server without one lands on the gate, and
  // the nav highlight follows, so the app never claims to be somewhere it is
  // not.
  const target = NEEDS_CONNECTION.has(name) && !isConnected() ? 'connect' : name;
  state.view = target;

  for (const button of document.querySelectorAll('.nav')) {
    const active = button.dataset.view === target;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  }
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('is-active', view.id === `view-${target}`);
  }

  refreshFlow();
  refreshActionBar();
  // Only a real destination is worth remembering; the gate is a waiting room.
  if (target !== 'connect') savePrefs({ view: target });

  if (target === 'connect') renderConnectList();
  if (target === 'history') loadHistory();
}

/**
 * Open or close the gate as the connection comes and goes.
 *
 * Called whenever a connection changes state, so losing the server mid-session
 * puts the app back on the picker rather than leaving a form that cannot run.
 */
function refreshGate() {
  const connected = isConnected();

  for (const button of document.querySelectorAll('.nav')) {
    if (NEEDS_CONNECTION.has(button.dataset.view)) button.disabled = !connected;
  }

  if (!connected && NEEDS_CONNECTION.has(state.view)) {
    setView('connect');
  } else if (connected && state.view === 'connect') {
    setView(state.settings.prefs.view === 'restore' ? 'restore' : 'backup');
  } else if (state.view === 'connect') {
    renderConnectList();
  }
}

/** The saved connections, as the gate's own list. */
function renderConnectList() {
  const list = $('connectList');
  list.textContent = '';

  const profiles = state.settings.profiles;
  $('connectNote').textContent = profiles.length
    ? 'History stays readable without a connection.'
    : '';

  if (profiles.length === 0) {
    list.appendChild(
      el(
        'p',
        'connect-empty',
        state.settings.encryptionAvailable
          ? 'No connections saved yet. Add one to get started — the connection string is encrypted for your Windows account.'
          : 'Windows credential encryption is unavailable on this machine, so connections cannot be saved.'
      )
    );
    return;
  }

  for (const profile of profiles) {
    const entry = connectionState(profile.uri);
    const row = el('button', 'connect-row');
    row.type = 'button';
    row.dataset.status = entry.status;

    const body = el(
      'div',
      'connect-body',
      el('div', 'connect-name', profile.name),
      el('div', 'connect-host', hostFromUri(profile.uri) || 'no host')
    );

    row.append(
      el('span', 'conn-dot'),
      body,
      el('span', 'connect-state', CONNECTION_LABEL[entry.status] || '')
    );
    if (profile.production) row.append(el('span', 'conn-prod', 'PROD'));
    row.addEventListener('click', () => selectConnection(profile));
    list.appendChild(row);
  }
}

/** The strip that names which way the data is about to move. */
function refreshFlow() {
  const host = hostFromUri(currentUri());
  const strip = $('flowStrip');

  if (state.view === 'restore') {
    $('flowFrom').textContent = 'folder on disk';
    $('flowTo').textContent = 'MongoDB';
    const where = host ? ` on ${host}` : '';
    $('flowDesc').textContent = isProductionConnection()
      ? `Writes data in. This connection is marked production${where}.`
      : `Writes data in. The target database${where} is modified.`;
  } else if (state.view === 'history') {
    $('flowFrom').textContent = 'Past runs';
    $('flowTo').textContent = 'this machine';
    $('flowDesc').textContent = 'Everything this app has run, newest first.';
  } else if (state.view === 'connect') {
    $('flowFrom').textContent = 'No connection';
    $('flowTo').textContent = 'nothing to run';
    $('flowDesc').textContent = 'Choose a server before backing up or restoring.';
  } else {
    $('flowFrom').textContent = 'MongoDB';
    $('flowTo').textContent = 'folder on disk';
    $('flowDesc').textContent = 'Copies data out. Nothing in your databases changes.';
  }

  // The strip lives outside the views, so it has to be told which palette to
  // wear; inside the views the same variables come from the view itself.
  const view = $(`view-${state.view}`);
  const styles = getComputedStyle(view);
  strip.style.setProperty('--mode', styles.getPropertyValue('--mode'));
  strip.style.setProperty('--mode-soft', styles.getPropertyValue('--mode-soft'));
}

/* ──────────────────────── saved connections (rail) ──────────────────── */

/** A pencil, for the Edit button on each row. */
function editIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M11.3 2.4l2.3 2.3-8 8-3 .7.7-3 8-8z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function renderConnections() {
  const list = $('connectionList');
  list.textContent = '';

  if (state.settings.profiles.length === 0) {
    list.append(
      el(
        'p',
        'conn-empty',
        state.settings.encryptionAvailable
          ? 'None saved yet. Press + to add one.'
          : 'Windows credential encryption is unavailable, so connections cannot be saved.'
      )
    );
    return;
  }

  for (const profile of state.settings.profiles) {
    // A row is two controls, not one: choosing the connection and editing it
    // are different actions, and a button cannot legally contain a button.
    const entry = connectionState(profile.uri);
    const row = el('div', 'conn');
    row.dataset.status = entry.status;
    if (profile.id === state.activeProfileId) row.classList.add('is-active');
    if (profile.production) row.classList.add('is-production');

    const body = el(
      'div',
      'conn-body',
      el('div', 'conn-name', profile.name),
      el('div', 'conn-host', hostFromUri(profile.uri) || 'no host')
    );

    const main = el('button', 'conn-main', el('span', 'conn-dot'), body);
    main.type = 'button';
    main.title = `${CONNECTION_LABEL[entry.status] || ''} — ${profile.name}`;
    main.addEventListener('click', () => selectConnection(profile));
    if (profile.production) main.append(el('span', 'conn-prod', 'PROD'));

    const edit = el('button', 'conn-edit', editIcon());
    edit.type = 'button';
    edit.title = `Edit "${profile.name}"`;
    edit.setAttribute('aria-label', `Edit ${profile.name}`);
    edit.addEventListener('click', () => openConnectionDialog(profile));

    row.append(main, edit);
    list.appendChild(row);
  }
}

/**
 * Whether the connection in the form is one that was marked as production.
 *
 * Matched on the URI rather than on which row was last clicked, so pasting a
 * production connection string in by hand is treated the same as choosing it
 * from the sidebar.
 */
function isProductionConnection() {
  const uri = currentUri();
  return Boolean(uri) && state.settings.profiles.some((p) => p.production && p.uri === uri);
}

/**
 * Connect using a saved connection and populate the database list.
 *
 * Picking one means "use this server", so the app does the connecting rather
 * than making you press Test and then Load. One survey call covers both, so
 * this costs a single handshake.
 */
async function selectConnection(profile) {
  const uri = profile.uri || '';
  const alreadyLive = connectionState(uri).status === 'connected';

  state.activeProfileId = profile.id;
  setUri(uri, { silent: true });
  // A different server means a different set of databases; nothing carries over.
  clearDatabaseSelection();
  state.collections.key = null;

  renderConnections();
  renderConnectList();
  refreshConnectionState();
  refreshFlow();
  refreshDestructiveUi();

  // Going back to a connection that is still open costs nothing and must not
  // pretend to reconnect — that was the point of pooling them.
  if (alreadyLive) {
    log('system', `Switched to "${profile.name}" — still connected.`);
    await refreshDatabaseList();
    refreshGate();
    refreshActionBar();
    return;
  }

  log('system', `Connecting to "${profile.name}"…`);
  await connect({ label: profile.name });
  refreshGate();
}

/* ─────────────────────── add / edit connection ─────────────────────── */

/** Which profile the dialog is editing, or null when adding a new one. */
let editingConnection = null;

function setSheetStatus(message, kind) {
  const status = $('connectionStatus');
  status.className = `sheet-status${kind ? ` ${kind}` : ''}`;
  status.textContent = message;
}

/**
 * Open the connection dialog, filled in for `profile` or empty for a new one.
 *
 * Adding and editing are the same form. What separates them is the id carried
 * in `editingConnection`: without one the save creates a record. That is the
 * whole of the fix for "+" renaming the selected connection — it used to look
 * for a saved connection with the same URI and hand its id to the save, so
 * pressing + with a connection selected edited that connection instead of
 * adding a second.
 */
function openConnectionDialog(profile = null) {
  editingConnection = profile;

  $('connectionDialogTitle').textContent = profile ? 'Edit connection' : 'New connection';
  $('connectionDialogSub').textContent = profile
    ? 'Saved on this machine, encrypted for your Windows account.'
    : 'Saved on this machine, encrypted for your Windows account.';

  $('connectionName').value = profile ? profile.name : '';
  $('connectionProduction').checked = profile ? Boolean(profile.production) : false;

  // A new connection starts from whatever URI is in the form, but only when it
  // is not already saved — otherwise + would open pre-filled with the details
  // of the connection you have selected, which is what made it look like a
  // rename in the first place.
  if (profile) {
    $('connectionUri').value = profile.uri || '';
  } else {
    const typed = currentUri();
    const alreadySaved = state.settings.profiles.some((entry) => entry.uri === typed);
    $('connectionUri').value = alreadySaved ? '' : typed;
  }

  setRevealed(['connectionUri'], ['connectionUriReveal'], false);
  $('connectionDelete').classList.toggle('hidden', !profile);
  setSheetStatus(
    state.settings.encryptionAvailable
      ? ''
      : 'Windows credential encryption is unavailable, so this cannot be saved.',
    state.settings.encryptionAvailable ? null : 'error'
  );

  $('connectionDialog').showModal();
  $('connectionName').focus();
  $('connectionName').select();
}

async function saveConnectionFromDialog() {
  const name = $('connectionName').value.trim();
  const uri = $('connectionUri').value.trim();

  if (!name) return setSheetStatus('Give the connection a name.', 'error');
  if (!uri) return setSheetStatus('Enter the MongoDB URI.', 'error');
  if (!state.settings.encryptionAvailable) {
    return setSheetStatus(
      'Windows credential encryption is unavailable, so connections cannot be saved.',
      'error'
    );
  }

  const editing = editingConnection;
  $('connectionSave').disabled = true;

  try {
    state.settings = unwrap(
      await window.api.saveProfile({
        id: editing ? editing.id : undefined,
        name,
        uri,
        production: $('connectionProduction').checked,
      })
    );

    const saved = state.settings.profiles.find((entry) => entry.name === name);

    // Editing the connection currently in use has to move the form with it,
    // or the app would keep talking to the old server under the new name.
    if (editing && saved && state.activeProfileId === editing.id && saved.uri !== currentUri()) {
      // The URI changed under the connection in use: let go of the old socket
      // and start again rather than leaving a pooled client nothing points at.
      await window.api.disconnectConnection(editing.uri).catch(() => {});
      state.connections.delete(editing.uri);
      setUri(saved.uri, { silent: true });
      clearDatabaseSelection();
      state.collections.key = null;
    }
    if (saved && (!editing || state.activeProfileId === editing.id)) {
      state.activeProfileId = editing ? saved.id : state.activeProfileId;
    }

    renderConnections();
    refreshFlow();
    refreshDestructiveUi();
    $('connectionDialog').close();
    log(
      'success',
      editing
        ? `Updated the saved connection "${name}".`
        : `Saved "${name}". The connection string is encrypted for your Windows account.`
    );
  } catch (error) {
    setSheetStatus(error.message, 'error');
  } finally {
    $('connectionSave').disabled = false;
  }
}

/** Try the URI in the dialog without adopting it as the app's connection. */
async function testConnectionFromDialog() {
  const uri = $('connectionUri').value.trim();
  if (!uri) return setSheetStatus('Enter the MongoDB URI first.', 'error');

  $('connectionTest').disabled = true;
  setSheetStatus('Connecting…', null);
  try {
    const info = unwrap(await window.api.testConnection(uri));
    setSheetStatus(`Reached MongoDB ${info.serverVersion} — ${info.topology}.`, 'ok');
  } catch (error) {
    setSheetStatus(error.message, 'error');
  } finally {
    $('connectionTest').disabled = false;
  }
}

async function deleteConnectionFromDialog() {
  const editing = editingConnection;
  if (!editing) return;

  const confirmed = unwrap(
    await window.api.confirm({
      type: 'warning',
      title: 'Delete connection',
      message: `Forget the saved connection "${editing.name}"?`,
      detail:
        'Only the stored connection string is removed. No database is touched and no backup ' +
        'file is deleted.',
      confirmLabel: 'Delete',
    })
  );
  if (!confirmed) return;

  try {
    state.settings = unwrap(await window.api.deleteProfile(editing.id));
    // Nothing points at this server any more, so hand the socket back.
    await window.api.disconnectConnection(editing.uri).catch(() => {});
    state.connections.delete(editing.uri);
    if (state.activeProfileId === editing.id) state.activeProfileId = null;
    renderConnections();
    renderConnectList();
    refreshConnectionState();
    refreshGate();
    refreshFlow();
    refreshDestructiveUi();
    $('connectionDialog').close();
    log('system', `Deleted saved connection "${editing.name}".`);
  } catch (error) {
    setSheetStatus(error.message, 'error');
  }
}

function wireConnectionDialog() {
  const dialog = $('connectionDialog');

  $('connectionSave').addEventListener('click', saveConnectionFromDialog);
  $('connectionTest').addEventListener('click', testConnectionFromDialog);
  $('connectionDelete').addEventListener('click', deleteConnectionFromDialog);
  $('connectionCancel').addEventListener('click', () => dialog.close());

  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  // Enter saves from either text field, the way a small form should.
  for (const id of ['connectionName', 'connectionUri']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveConnectionFromDialog();
      }
    });
  }
}

/* ──────────────────────────── preferences ──────────────────────────── */

let prefSaveTimer = null;
function savePrefs(partial) {
  Object.assign(state.settings.prefs, partial);
  clearTimeout(prefSaveTimer);
  prefSaveTimer = setTimeout(() => {
    window.api.savePrefs(state.settings.prefs).catch(() => {});
  }, 400);
}

/* ─────────────────────────── database picker ───────────────────────── */

/**
 * A filterable, scrollable picker attached to a free-text input.
 *
 * This replaces a native <datalist>, which the browser draws itself: with more
 * than a screenful of databases that popup overflows the window and cannot be
 * scrolled, and it cannot be filtered at all. Servers with dozens of similarly
 * named databases made both limits unusable.
 *
 * The input stays free text — a name that is not in the list is still valid.
 */
function createCombobox(
  input,
  { emptyLabel = 'No matching database', multiple = false, onChange = null, anchor = null } = {}
) {
  // What the popup lines up with. In the multi-select field the typing box is a
  // narrow remnant beside the chips, so measuring it would size the list to
  // whatever room the chips happened to leave.
  const frame = anchor || input;
  const popup = el('div', 'combo-popup');
  popup.setAttribute('role', 'listbox');
  popup.hidden = true;
  // Anchored to the viewport and parented to <body>, so the scrolling form
  // cannot clip it.
  document.body.appendChild(popup);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  let items = [];
  let matches = [];
  let activeIndex = -1;
  let isOpen = false;
  // Filtering applies only while the user is typing a search. Opening the list
  // with a database already chosen shows everything, because otherwise the
  // committed name filters the list down to itself and there is no way to
  // browse to a different database without clearing the field first.
  let isSearching = false;

  // In multi-select the field is a filter, never a committed value, so what is
  // typed always narrows the list and what is chosen lives in chips instead.
  const chosenNames = () => (multiple ? state.selectedDatabases : [input.value.trim()]);

  function position() {
    const rect = frame.getBoundingClientRect();
    popup.style.left = `${Math.round(rect.left)}px`;
    popup.style.width = `${Math.round(rect.width)}px`;

    // Flip above the field if there is not enough room below it.
    const below = window.innerHeight - rect.bottom - 8;
    if (below < 160 && rect.top > below) {
      popup.style.top = 'auto';
      popup.style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`;
      popup.style.maxHeight = `${Math.round(rect.top - 12)}px`;
    } else {
      popup.style.bottom = 'auto';
      popup.style.top = `${Math.round(rect.bottom + 4)}px`;
      popup.style.maxHeight = `${Math.round(Math.min(288, below))}px`;
    }
  }

  function scrollActiveIntoView() {
    const active = popup.querySelector('.combo-option.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /** Offer a name the server did not list — a restricted account may still
   *  be able to read it even though it cannot enumerate databases. */
  function appendCustomOption() {
    const typed = input.value.trim();
    if (!multiple || !typed || items.some((item) => item.name === typed)) return;
    const custom = el('div', 'combo-option');
    custom.setAttribute('role', 'option');
    custom.dataset.custom = 'true';
    custom.append(el('span', 'combo-tick', ''), el('span', 'combo-name', `Use "${typed}"`));
    custom.addEventListener('mousedown', (event) => {
      event.preventDefault();
      toggleName(typed);
    });
    popup.appendChild(custom);
  }

  /**
   * Select or clear everything the filter is currently showing.
   *
   * Scoped to the matches rather than the whole list, so typing a term and
   * pressing Select all is how you take a related group in one go — which is
   * the thing that is unbearable to do one tick at a time.
   */
  function appendBulkActions() {
    if (!multiple || items.length === 0) return;

    const chosen = new Set(state.selectedDatabases);
    const filtered = matches.length !== items.length;
    const missing = matches.filter((item) => !chosen.has(item.name));
    const present = matches.filter((item) => chosen.has(item.name));

    const selectAll = el(
      'button',
      'link',
      filtered ? `Select these ${matches.length}` : `Select all ${items.length}`
    );
    selectAll.type = 'button';
    selectAll.disabled = missing.length === 0;
    selectAll.addEventListener('mousedown', (event) => {
      event.preventDefault();
      for (const item of missing) state.selectedDatabases.push(item.name);
      if (onChange) onChange();
      applyFilter();
      render();
    });

    // Unfiltered, "clear" means the whole selection — including any name typed
    // in by hand that the server never listed.
    const clear = el('button', 'link dim', filtered ? `Clear these ${present.length}` : 'Clear all');
    clear.type = 'button';
    clear.disabled = filtered ? present.length === 0 : state.selectedDatabases.length === 0;
    clear.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (filtered) {
        const drop = new Set(present.map((item) => item.name));
        state.selectedDatabases = state.selectedDatabases.filter((name) => !drop.has(name));
      } else {
        state.selectedDatabases = [];
      }
      if (onChange) onChange();
      applyFilter();
      render();
    });

    const count = el(
      'span',
      'combo-count',
      `${state.selectedDatabases.length} selected` +
        (filtered ? ` · ${matches.length} of ${items.length} shown` : '')
    );

    popup.appendChild(el('div', 'combo-actions', selectAll, clear, el('span', 'spacer'), count));
  }

  function render() {
    // Ticking rebuilds the list, and a list of forty databases that jumps back
    // to the top on every tick is unusable.
    const scrollTop = popup.scrollTop;
    popup.textContent = '';
    appendBulkActions();

    if (matches.length === 0) {
      popup.appendChild(el('div', 'combo-empty', emptyLabel));
      appendCustomOption();
      popup.scrollTop = scrollTop;
      return;
    }

    const chosen = new Set(chosenNames().map((name) => String(name).toLowerCase()));

    matches.forEach((item, index) => {
      const isChosen = chosen.has(item.name.toLowerCase());
      const option = el('div', 'combo-option');
      if (index === activeIndex) option.classList.add('is-active');
      if (isChosen) option.classList.add('is-chosen');
      option.setAttribute('role', 'option');
      // Names the row's database, which separates real entries from the
      // "use this anyway" row below.
      option.dataset.name = item.name;
      option.setAttribute('aria-selected', String(isChosen));

      // A fixed-width tick slot keeps every name on the same left edge.
      option.append(
        el('span', 'combo-tick', isChosen ? '✓' : ''),
        el('span', 'combo-name', item.name),
        el('span', 'combo-meta', item.sizeOnDisk ? formatBytes(item.sizeOnDisk) : '')
      );

      // mousedown, not click: preventDefault keeps focus in the input so the
      // blur handler does not close the popup before the choice lands.
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        choose(index);
      });
      popup.appendChild(option);
    });

    appendCustomOption();
    popup.scrollTop = scrollTop;
  }

  function applyFilter() {
    const value = input.value.trim().toLowerCase();
    matches =
      (multiple || isSearching) && value
        ? items.filter((item) => item.name.toLowerCase().includes(value))
        : items.slice();

    // Start on whatever is currently chosen, so opening the full list lands on
    // it and arrow keys continue from there rather than jumping to the top.
    const first = chosenNames()[0];
    const current = first
      ? matches.findIndex((item) => item.name.toLowerCase() === String(first).toLowerCase())
      : -1;
    activeIndex = current >= 0 ? current : matches.length > 0 ? 0 : -1;
  }

  function toggleName(name) {
    const at = state.selectedDatabases.indexOf(name);
    if (at >= 0) state.selectedDatabases.splice(at, 1);
    else state.selectedDatabases.push(name);
    if (onChange) onChange();
    applyFilter();
    render();
  }

  function open() {
    if (items.length === 0 && !(multiple && input.value.trim())) return;
    isOpen = true;
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    position();
    render();
    scrollActiveIntoView();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }

  function choose(index) {
    const item = matches[index];
    if (!item) return;
    if (multiple) {
      // Stay open: picking several in a row is the point.
      toggleName(item.name);
      return;
    }
    input.value = item.name;
    isSearching = false; // the value is committed; reopening browses again
    input.dispatchEvent(new Event('change'));
    close();
  }

  input.addEventListener('input', () => {
    isSearching = true;
    applyFilter();
    if (items.length > 0) open();
    render();
  });

  input.addEventListener('focus', () => {
    // Opening the list is a browse, not a search: show every database.
    isSearching = false;
    applyFilter();
    open();
  });

  if (multiple) {
    // Backspace on an empty filter takes the last chip off, as a tag field does.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Backspace' || input.value !== '') return;
      if (state.selectedDatabases.length === 0) return;
      state.selectedDatabases.pop();
      if (onChange) onChange();
      applyFilter();
      render();
    });
  }

  input.addEventListener('blur', () => close());

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) {
        applyFilter();
        open();
        return;
      }
      if (matches.length === 0) return;
      activeIndex =
        (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      render();
      scrollActiveIntoView();
    } else if (event.key === 'Enter' && isOpen && activeIndex >= 0) {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape' && isOpen) {
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  });

  // A viewport-anchored popup must not drift away from its field, so listen in
  // the capture phase to catch scroll from whichever element actually moved.
  const reposition = () => {
    if (!isOpen) return;
    const rect = frame.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) close();
    else position();
  };
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, { capture: true, passive: true });

  return {
    setItems(next) {
      items = Array.isArray(next) ? next : [];
      applyFilter();
      if (document.activeElement === input) open();
    },
    toggle() {
      if (isOpen) {
        close();
        return;
      }
      isSearching = false;
      applyFilter();
      input.focus();
      open();
    },
    refresh() {
      applyFilter();
      if (isOpen) render();
    },
    has(name) {
      const wanted = String(name).toLowerCase();
      return items.some((item) => item.name.toLowerCase() === wanted);
    },
    find(name) {
      const wanted = String(name).toLowerCase();
      return items.find((item) => item.name.toLowerCase() === wanted) || null;
    },
    get count() {
      return items.length;
    },
  };
}

/* ──────────────────────── connection utilities ─────────────────────── */

/** Connect, then fill in everything a connection makes knowable. */
async function connect({ label = null } = {}) {
  const uri = currentUri();
  if (!uri) {
    log('error', 'Enter the MongoDB URI first.');
    return false;
  }

  const token = state.connect.token + 1;
  state.connect.token = token;
  setConnectionState('idle', 'Connecting…');
  $('backupTest').disabled = true;
  $('restoreTest').disabled = true;

  try {
    const info = unwrap(await window.api.surveyConnection(uri));
    if (token !== state.connect.token) return false; // superseded

    for (const notice of info.notices || []) log('warn', notice);

    setConnectionState('ok', `Connected · MongoDB ${info.serverVersion}`);
    $('backupConnStatus').className = 'hint ok';
    $('backupConnStatus').textContent = `${info.topology} · ${hostFromUri(uri)}`;
    $('restoreConnStatus').className = 'hint ok';
    $('restoreConnStatus').textContent = `${info.topology} · ${hostFromUri(uri)}`;

    state.combos.backup.setItems(info.databases);
    state.combos.restore.setItems(info.databases);
    $('backupDbHint').textContent = `${plural(info.databases.length, 'database')} on this server. Pick one or more.`;

    log(
      'success',
      `Connected to MongoDB ${info.serverVersion} (${info.topology}) — ` +
        `${plural(info.databases.length, 'database')} available.`
    );

    refreshFlow();
    refreshTargetState();
    await refreshBackupCollections();
    refreshGate();
    refreshActionBar();
    return true;
  } catch (error) {
    if (token !== state.connect.token) return false;
    setConnectionState('error', 'Not connected');
    for (const id of ['backupConnStatus', 'restoreConnStatus']) {
      $(id).className = 'hint error';
      $(id).textContent = error.message;
    }
    log('error', label ? `Could not connect using "${label}" — ${error.message}` : `Connection failed — ${error.message}`);
    renderConnections();
    renderConnectList();
    return false;
  } finally {
    $('backupTest').disabled = false;
    $('restoreTest').disabled = false;
  }
}

/**
 * Re-read the database list on a connection that is already open.
 *
 * Switching back to a pooled connection must not look like reconnecting, so
 * this is the cheap path: one listDatabases over the socket that is already
 * there, with no handshake and no "Connecting…".
 */
async function refreshDatabaseList() {
  const uri = currentUri();
  if (!uri) return;
  try {
    const databases = unwrap(await window.api.listDatabases(uri));
    state.combos.backup.setItems(databases);
    state.combos.restore.setItems(databases);
    $('backupDbHint').textContent = `${plural(databases.length, 'database')} on this server. Pick one or more.`;
    refreshTargetState();
    await refreshBackupCollections();
  } catch (error) {
    log('warn', `Could not list databases — ${error.message}`);
  }
}

/* ─────────────────────── database selection (backup) ───────────────── */

function clearDatabaseSelection() {
  state.selectedDatabases = [];
  $('backupDatabase').value = '';
  refreshDatabaseChips();
}

/**
 * How many chips are worth showing before the field becomes the problem.
 *
 * Selecting forty databases is a reasonable thing to do, and forty chips turn
 * the field into a wall that pushes the rest of the form off screen.
 */
const MAX_VISIBLE_CHIPS = 3;

/** The chips inside the Databases field: the first few, then a count. */
function refreshDatabaseChips() {
  const chips = $('backupDatabaseChips');
  chips.textContent = '';

  const names = state.selectedDatabases;
  const visible = names.slice(0, MAX_VISIBLE_CHIPS);
  const hidden = names.slice(MAX_VISIBLE_CHIPS);

  for (const name of visible) {
    const remove = el('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.title = `Remove ${name}`;
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.selectedDatabases = state.selectedDatabases.filter((entry) => entry !== name);
      onDatabaseSelectionChanged();
    });
    const chip = el('span', 'chip', el('span', 'chip-name', name), remove);
    chip.title = name;
    chips.appendChild(chip);
  }

  if (hidden.length > 0) {
    // The rest are unticked in the list, which is where they can be seen in
    // full anyway — so this opens it rather than carrying its own remove.
    const more = el('button', 'chip chip-more', `${hidden.length} more`);
    more.type = 'button';
    more.title = `Also selected:\n${hidden.join('\n')}`;
    more.setAttribute('aria-label', `${hidden.length} more selected. Open the list to change them.`);
    more.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.combos.backup) state.combos.backup.toggle();
    });
    chips.appendChild(more);
  }

  // The placeholder is the instruction, so it only belongs on an empty field.
  $('backupDatabase').placeholder = names.length ? 'Add another…' : 'Select database';
}

function onDatabaseSelectionChanged() {
  if (state.running) return; // the list is the progress display while a job runs
  refreshDatabaseChips();
  if (state.combos.backup) state.combos.backup.refresh();
  savePrefs({ backupDatabases: state.selectedDatabases });
  refreshResolvedPath();
  refreshBackupCollections();
  refreshActionBar();
}

/* ─────────────────────────── collection lists ──────────────────────── */

/** One row per collection, doubling as that collection's progress bar. */
function renderCollectionList(containerId, items, emptyMessage = 'No collections found.') {
  const container = $(containerId);
  container.textContent = '';

  if (items.length === 0) {
    container.appendChild(el('p', 'empty', emptyMessage));
    refreshCollectionFooter(containerId);
    return;
  }

  for (const item of items) {
    const row = el('label', 'collection');
    row.dataset.name = item.name;

    const box = el('input');
    box.type = 'checkbox';
    box.value = item.name;
    box.checked = true;
    box.addEventListener('change', () => {
      refreshCollectionFooter(containerId);
      if (containerId === 'restoreCollections') clearPreview();
      refreshActionBar();
    });

    const meta = el(
      'span',
      'collection-meta',
      item.bytes ? formatBytes(item.bytes) : item.type === 'view' ? 'view' : '—'
    );

    if (typeof item.documents === 'number') row.dataset.documents = String(item.documents);

    row.append(
      box,
      el('span', 'collection-name', item.type === 'view' ? `${item.name} (view)` : item.name),
      el(
        'span',
        'collection-docs',
        typeof item.documents === 'number' ? `${formatNumber(item.documents)} docs` : ''
      ),
      meta,
      el('span', 'collection-bar')
    );
    container.appendChild(row);
  }

  refreshCollectionFooter(containerId);
}

function collectionRows(containerId) {
  // Only top-level rows: collections nested inside a database group belong to
  // that group's own selection, not to this list.
  return [...$(containerId).querySelectorAll(':scope > .collection')];
}

/**
 * The rows a run reports progress against.
 *
 * One database means one row per collection. Several means one row per
 * database, which is the group's head — it carries the same data-name and
 * progress bar, so none of the job plumbing has to know the difference.
 */
function progressRows(containerId) {
  return [
    ...$(containerId).querySelectorAll(':scope > .collection, :scope > .dbgroup > .dbgroup-head'),
  ];
}

function checkedNames(containerId) {
  return collectionRows(containerId)
    .filter((row) => {
      // Database rows carry no checkbox: each is taken whole.
      const box = row.querySelector('input');
      return box ? box.checked : true;
    })
    .map((row) => row.dataset.name);
}

/** A collection list per database, or null where the whole database goes. */
function databaseSelections() {
  const selections = {};
  for (const name of state.selectedDatabases) {
    const group = groupFor(name);
    selections[name] = group.selected === null ? null : [...group.selected];
  }
  return selections;
}

/** Returns null when everything is selected, so the engine takes all of it. */
function selectedCollections(containerId) {
  // Several databases carry their choices per group instead.
  if (containerId === 'backupCollections' && state.backupListMode !== 'collections') return null;
  const rows = collectionRows(containerId);
  if (rows.length === 0) return null;
  const checked = checkedNames(containerId);
  return checked.length === rows.length ? null : checked;
}

function setAllChecked(containerId, checked) {
  if (containerId === 'backupCollections' && state.backupListMode === 'databases') {
    for (const name of state.selectedDatabases) {
      groupFor(name).selected = checked ? null : new Set();
    }
    renderDatabaseList(state.selectedDatabases);
    refreshActionBar();
    return;
  }
  for (const row of collectionRows(containerId)) {
    const box = row.querySelector('input');
    if (box) box.checked = checked;
  }
  refreshCollectionFooter(containerId);
  if (containerId === 'restoreCollections') clearPreview();
  refreshActionBar();
}

function refreshCollectionFooter(containerId) {
  if (containerId === 'backupCollections') {
    $('backupCollectionsTitle').textContent =
      state.backupListMode === 'databases' ? 'Databases' : 'Collections';
  }
  const rows =
    containerId === 'backupCollections' && state.backupListMode === 'databases'
      ? progressRows(containerId)
      : collectionRows(containerId);
  const selected = checkedNames(containerId).length;
  const footer = $(`${containerId}Footer`);

  if (containerId === 'backupCollections' && state.backupListMode === 'databases') {
    const names = state.selectedDatabases;
    const narrowed = names.filter((name) => groupFor(name).selected !== null);
    const empty = names.filter((name) => isGroupEmpty(name));
    footer.textContent = empty.length
      ? `Nothing selected in ${empty.map((name) => `"${name}"`).join(', ')}.`
      : `${plural(names.length, 'database')} into a single run folder` +
        (narrowed.length
          ? ` · ${narrowed.length} narrowed to specific collections.`
          : ' · every collection in each one.');
    return;
  }

  if (rows.length === 0) {
    footer.textContent =
      containerId === 'backupCollections'
        ? 'Everything in the database is backed up unless you narrow it down here.'
        : 'Nothing selected yet.';
    return;
  }

  footer.textContent =
    containerId === 'backupCollections'
      ? `${selected} of ${rows.length} selected · leave them all on to back up the whole database.`
      : `${selected} of ${rows.length} selected from this backup.`;
}

/** Move one collection row's progress bar and right-hand figure. */
function updateCollectionRow(containerId, name, payload) {
  const row = progressRows(containerId).find((entry) => entry.dataset.name === name);
  if (!row) return;

  const meta = row.querySelector('.collection-meta');
  const bar = row.querySelector('.collection-bar');
  const docs = row.querySelector('.collection-docs');

  if (typeof payload.documents === 'number') {
    docs.textContent = `${formatNumber(payload.documents)} docs`;
  }

  if (payload.status === 'running') {
    const percent = Math.round(Math.max(0, Math.min(1, payload.fraction || 0)) * 100);
    bar.style.width = `${percent}%`;
    bar.style.opacity = '1';
    meta.className = 'collection-meta';
    meta.textContent = `${percent}%`;
  } else if (payload.status === 'done') {
    bar.style.width = '100%';
    bar.style.opacity = '1';
    meta.className = 'collection-meta is-done';
    meta.textContent = payload.bytes ? formatBytes(payload.bytes) : 'done';
  } else if (payload.status === 'error') {
    bar.style.opacity = '0';
    meta.className = 'collection-meta is-error';
    meta.textContent = 'failed';
  }
}

function resetCollectionProgress(containerId) {
  for (const row of progressRows(containerId)) {
    const bar = row.querySelector('.collection-bar');
    bar.style.width = '0';
    bar.style.opacity = '0';
    row.querySelector('.collection-meta').className = 'collection-meta';
  }
}

function groupFor(name) {
  let group = state.databaseGroups.get(name);
  if (!group) {
    // A database starts fully included: opening it is how you narrow it down,
    // so nothing has to be fetched until someone wants to.
    group = { open: false, loading: false, error: null, collections: null, selected: null };
    state.databaseGroups.set(name, group);
  }
  return group;
}

/** Forget groups for databases that are no longer selected. */
function pruneDatabaseGroups(names) {
  const keep = new Set(names);
  for (const name of [...state.databaseGroups.keys()]) {
    if (!keep.has(name)) state.databaseGroups.delete(name);
  }
}

/** How many of a database's collections are going into the run. */
function groupSummary(name) {
  const group = groupFor(name);
  // "all" reads the same whether or not the list has been fetched, so a
  // collapsed group never looks like it is already narrowed.
  if (group.selected === null) {
    return group.collections
      ? `all ${plural(group.collections.length, 'collection')}`
      : 'all collections';
  }
  const total = group.collections ? group.collections.length : group.selected.size;
  return `${group.selected.size} of ${total} collections`;
}

function isGroupEmpty(name) {
  const group = groupFor(name);
  return group.selected !== null && group.selected.size === 0;
}

/** Read a database's collections, once, the first time it is opened. */
async function loadGroupCollections(name) {
  const group = groupFor(name);
  if (group.collections || group.loading) return;
  const uri = currentUri();
  if (!uri) return;

  group.loading = true;
  group.error = null;
  renderDatabaseList(state.selectedDatabases);

  try {
    group.collections = unwrap(await window.api.listCollections(uri, name));
  } catch (error) {
    group.error = error.message;
  } finally {
    group.loading = false;
    // The selection may have moved on while this was in flight.
    if (state.selectedDatabases.includes(name)) {
      renderDatabaseList(state.selectedDatabases);
      refreshActionBar();
    }
  }
}

function toggleGroupCollection(name, collection) {
  const group = groupFor(name);
  const all = (group.collections || []).map((entry) => entry.name);
  // "All" is stored as null; narrowing it turns it into a real set first.
  if (group.selected === null) group.selected = new Set(all);
  if (group.selected.has(collection)) group.selected.delete(collection);
  else group.selected.add(collection);
  // Back to everything is back to null, so collections added on the server
  // later are still included.
  if (all.length > 0 && group.selected.size === all.length) group.selected = null;
  renderDatabaseList(state.selectedDatabases);
  refreshActionBar();
}

function setGroupAll(name, on) {
  const group = groupFor(name);
  group.selected = on ? null : new Set();
  renderDatabaseList(state.selectedDatabases);
  refreshActionBar();
}

function chevronIcon(className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 10 6');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add(className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M1 1l4 4 4-4');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/**
 * One collapsible group per selected database.
 *
 * The head doubles as that database's progress bar during a run, which is why
 * it carries the same data-name and .collection-bar a single-database row does.
 */
function renderDatabaseList(names) {
  const container = $('backupCollections');

  // The list is rebuilt on every tick, which would otherwise drop keyboard
  // focus on the box that was just clicked and leave the user's place lost.
  const focused = document.activeElement;
  const restore =
    focused && container.contains(focused) && focused.closest('.collection')
      ? {
          database: focused.closest('.collection').dataset.database,
          name: focused.closest('.collection').dataset.name,
        }
      : null;

  container.textContent = '';

  for (const name of names) {
    const group = groupFor(name);
    const known = state.combos.backup ? state.combos.backup.find(name) : null;

    const block = el('div', 'dbgroup');
    if (group.open) block.classList.add('is-open');
    block.dataset.name = name;

    const toggle = el('button', 'dbgroup-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(group.open));
    toggle.append(chevronIcon('dbgroup-chevron'), el('span', 'collection-name', name));
    toggle.addEventListener('click', () => {
      group.open = !group.open;
      renderDatabaseList(names);
      if (group.open) loadGroupCollections(name);
    });

    const head = el('div', 'dbgroup-head');
    head.dataset.name = name;
    head.append(
      toggle,
      el('span', 'collection-docs', groupSummary(name)),
      el('span', 'collection-meta', known && known.sizeOnDisk ? formatBytes(known.sizeOnDisk) : '—'),
      el('span', 'collection-bar')
    );
    block.appendChild(head);

    const body = el('div', 'dbgroup-body');

    if (group.loading) {
      body.appendChild(el('p', 'dbgroup-note', 'Reading collections…'));
    } else if (group.error) {
      body.appendChild(el('p', 'dbgroup-note error', group.error));
    } else if (group.collections && group.collections.length === 0) {
      body.appendChild(el('p', 'dbgroup-note', `"${name}" has no collections to back up.`));
    } else if (group.collections) {
      const actions = el('div', 'dbgroup-actions');
      const all = el('button', 'link', 'All');
      all.type = 'button';
      all.addEventListener('click', () => setGroupAll(name, true));
      const none = el('button', 'link dim', 'None');
      none.type = 'button';
      none.addEventListener('click', () => setGroupAll(name, false));
      actions.append(all, none);

      for (const item of group.collections) {
        const included = group.selected === null || group.selected.has(item.name);
        const row = el('label', 'collection');
        row.dataset.name = item.name;
        row.dataset.database = name;

        const box = el('input');
        box.type = 'checkbox';
        box.checked = included;
        box.addEventListener('change', () => toggleGroupCollection(name, item.name));

        row.append(
          box,
          el('span', 'collection-name', item.type === 'view' ? `${item.name} (view)` : item.name),
          el(
            'span',
            'collection-docs',
            typeof item.documents === 'number' ? `${formatNumber(item.documents)} docs` : ''
          ),
          el('span', 'collection-meta', item.bytes ? formatBytes(item.bytes) : '—')
        );
        body.appendChild(row);
      }

      if (isGroupEmpty(name)) {
        body.appendChild(
          el('p', 'dbgroup-note error', `Nothing selected in "${name}" — it would be skipped.`)
        );
      }
      body.appendChild(actions);
    }

    block.appendChild(body);
    container.appendChild(block);
  }

  if (restore) {
    const again = container.querySelector(
      `.collection[data-database="${CSS.escape(restore.database)}"][data-name="${CSS.escape(restore.name)}"] input`
    );
    if (again) again.focus();
  }

  refreshCollectionFooter('backupCollections');
}

/**
 * Fill the backup Collections card for whatever is selected.
 *
 * Nothing selected says so rather than showing an empty list. One database
 * lists its collections, all ticked. Several list the databases themselves —
 * each is taken whole, so there is nothing to tick and nowhere sensible to put
 * a row per collection.
 */
async function refreshBackupCollections({ force = false } = {}) {
  const uri = currentUri();
  const names = state.selectedDatabases;

  // Leaving collections mode has to invalidate any listCollections still in
  // flight. Picking a second database while the first one's collections are
  // loading would otherwise let that late reply paint collection rows over the
  // database rows — the card and the footer would disagree.
  if (names.length !== 1) {
    state.collections.token += 1;
    state.collections.key = null;
  }

  if (names.length === 0) {
    state.backupListMode = 'none';
    pruneDatabaseGroups(names);
    renderCollectionList(
      'backupCollections',
      [],
      'No database selected yet — pick one above to list its collections.'
    );
    refreshActionBar();
    return;
  }

  if (names.length > 1) {
    state.backupListMode = 'databases';
    pruneDatabaseGroups(names);
    renderDatabaseList(names);
    refreshActionBar();
    return;
  }

  const database = names[0];
  if (!uri) return;

  const key = `${uri} ${database}`;
  if (!force && state.backupListMode === 'collections' && key === state.collections.key) return;
  state.backupListMode = 'collections';
  state.collections.key = key;

  const token = state.collections.token + 1;
  state.collections.token = token;

  renderCollectionList('backupCollections', [], `Loading collections in "${database}"…`);

  try {
    const collections = unwrap(await window.api.listCollections(uri, database));
    if (token !== state.collections.token) return; // a newer request won
    renderCollectionList('backupCollections', collections, `"${database}" has no collections to back up.`);
    log('info', `"${database}" has ${plural(collections.length, 'collection')}.`);
  } catch (error) {
    if (token !== state.collections.token) return;
    // Clear the cache so changing back to this database retries.
    state.collections.key = null;
    renderCollectionList('backupCollections', [], `Could not list collections — ${error.message}`);
    log('warn', `Could not list collections for "${database}" — ${error.message}`);
  } finally {
    refreshActionBar();
  }
}

/* ───────────────────────────── backup view ─────────────────────────── */

function refreshResolvedPath() {
  const folder = $('backupOutput').value.trim();
  const names = state.selectedDatabases;
  const separator = folder.endsWith('\\') || folder.endsWith('/') ? '' : '\\';
  const suffix = $('backupGzip').checked ? '  (.bson.gz)' : '';

  if (!folder) {
    $('backupResolved').textContent = 'Choose a folder above.';
    return;
  }

  // Several databases go into one run folder with a subfolder each, so the
  // preview has to show that rather than implying a folder per database.
  if (names.length > 1) {
    $('backupResolved').textContent =
      `${folder}${separator}backup_<timestamp>\\{ ${names.join(', ')} }${suffix}`;
    return;
  }

  if (names.length === 0) {
    $('backupResolved').textContent = 'Select a database to see the folder this run will create.';
    return;
  }

  $('backupResolved').textContent = `${folder}${separator}${names[0]}_<timestamp>${suffix}`;
}

/* ───────────────────────────── restore view ────────────────────────── */

function currentSourceDatabase() {
  if (!state.inspection) return null;
  const selected = $('restoreSourceDb').value;
  return (
    state.inspection.databases.find((database) => database.name === selected) ||
    state.inspection.databases[0]
  );
}

function currentRestoreMode() {
  const selected = document.querySelector('input[name="restoreMode"]:checked');
  return selected ? selected.value : 'keep';
}

function renderInspection() {
  const inspection = state.inspection;
  const statusEl = $('restoreSourceStatus');

  $('restoreSourceDbField').classList.toggle('hidden', inspection.databases.length < 2);

  const select = $('restoreSourceDb');
  if (select.options.length !== inspection.databases.length) {
    select.textContent = '';
    for (const database of inspection.databases) {
      const option = el('option', null, `${database.name} — ${plural(database.collections.length, 'collection')}`);
      option.value = database.name;
      select.appendChild(option);
    }
  }

  const source = currentSourceDatabase();
  const documents = source.collections.reduce((total, item) => total + (item.documents || 0), 0);
  const bytes = source.collections.reduce((total, item) => total + (item.bytes || 0), 0);

  $('restoreFacts').classList.remove('hidden');
  $('factDatabase').textContent = source.name;
  $('factContents').textContent =
    `${plural(source.collections.length, 'collection')} · ` +
    (documents > 0 ? `${formatNumber(documents)} docs · ` : '') +
    formatBytes(bytes);
  $('factTaken').textContent =
    state.inspection.manifest && state.inspection.manifest.createdAt
      ? formatWhen(state.inspection.manifest.createdAt)
      : 'unknown';

  // The folder is already in the field above, so this line says where the
  // backup came from instead of repeating it.
  const manifest = state.inspection.manifest;
  statusEl.className = 'hint';
  statusEl.textContent = manifest
    ? `Made by this app` +
      (manifest.serverVersion ? ` from MongoDB ${manifest.serverVersion}` : '') +
      (manifest.gzip ? ' · gzip' : '')
    : 'A mongodump folder — no manifest, so sizes are read from the files themselves.';

  renderCollectionList('restoreCollections', source.collections);
  if (!$('restoreTargetDatabase').value.trim()) {
    $('restoreTargetDatabase').value = source.name;
  }
  refreshTargetState();
  clearPreview();
  refreshActionBar();
}

async function inspectSource(folder) {
  if (!folder) return;
  const statusEl = $('restoreSourceStatus');
  statusEl.className = 'hint';
  statusEl.textContent = 'Reading backup folder…';

  try {
    state.inspection = unwrap(await window.api.inspectBackup(folder));
    renderInspection();
    savePrefs({ restoreSource: folder });
  } catch (error) {
    state.inspection = null;
    $('restoreFacts').classList.add('hidden');
    statusEl.className = 'hint error';
    statusEl.textContent = error.message;
    renderCollectionList('restoreCollections', [], 'Choose a backup folder to list its collections.');
    refreshActionBar();
  }
}

/**
 * Say whether the target is a database that already exists on this server.
 *
 * Answered from the list the connection already returned, so it costs nothing
 * and stays accurate for as long as that list does.
 */
function refreshTargetState() {
  const name = $('restoreTargetDatabase').value.trim();
  const stateEl = $('restoreTargetState');
  const hintEl = $('restoreTargetHint');

  if (!name || state.combos.restore.count === 0) {
    stateEl.textContent = '';
    stateEl.removeAttribute('data-state');
    hintEl.textContent = 'Any name works — use a new one to clone into a staging copy.';
    return;
  }

  const match = state.combos.restore.find(name);
  if (match) {
    stateEl.textContent = 'exists';
    stateEl.dataset.state = 'exists';
    hintEl.textContent = match.sizeOnDisk
      ? `Already on this server, ${formatBytes(match.sizeOnDisk)} on disk. Choose carefully below.`
      : 'Already on this server. Choose carefully below.';
  } else {
    stateEl.textContent = 'will be created';
    stateEl.dataset.state = 'new';
    hintEl.textContent = 'Nothing of this name is on the server yet, so nothing can be overwritten.';
  }
}

/**
 * Whether this restore has to be confirmed in the form as well as the dialog.
 *
 * True for the modes that delete data, and for every mode when the connection
 * was marked as production — writing into production is the case where "I
 * thought I was pointed somewhere else" costs the most, safe mode or not.
 */
function confirmationRequired() {
  const mode = currentRestoreMode();
  return mode === 'drop' || mode === 'dropDatabase' || isProductionConnection();
}

function refreshDestructiveUi() {
  const mode = currentRestoreMode();
  const target = $('restoreTargetDatabase').value.trim() || 'the target';
  const row = $('restoreConfirmRow');
  const needed = confirmationRequired();

  row.classList.toggle('hidden', !needed);
  if (!needed) $('restoreDropConfirm').checked = false;

  if (mode === 'dropDatabase') {
    $('restoreConfirmLabel').textContent = `I understand "${target}" will be deleted first`;
  } else if (mode === 'drop') {
    const count = checkedNames('restoreCollections').length;
    $('restoreConfirmLabel').textContent =
      `I understand ${count > 0 ? plural(count, 'collection') : 'these collections'} will be ` +
      `dropped from "${target}" first`;
  } else {
    $('restoreConfirmLabel').textContent =
      `I understand this writes into "${target}" on a connection marked production`;
  }

  clearPreview();
  refreshActionBar();
}

/* ─────────────────────────────── dry run ───────────────────────────── */

function clearPreview() {
  state.preview = null;
  $('dryCard').classList.add('hidden');
}

/**
 * Turn one preview row into words.
 *
 * The destructive modes are exact: everything present is deleted, so the count
 * to report is simply what is there now. The safe modes are not — how many of
 * the backup's documents already exist depends on their _ids, which cannot be
 * known without reading every one of them. Those are phrased as bounds rather
 * than dressed up as precision the check does not have.
 */
function describeOutcome(row, mode) {
  const inBackup = typeof row.inBackup === 'number' ? row.inBackup : null;
  const inTarget = typeof row.inTarget === 'number' ? row.inTarget : null;

  // A mongodump folder made by another tool carries no document count, so the
  // backup side is described rather than given a number it does not have.
  const incoming = inBackup === null ? 'everything in the backup' : formatNumber(inBackup);

  if (mode === 'dropDatabase' || mode === 'drop') {
    if (!inTarget) return { text: `insert ${incoming}`, tone: 'safe' };
    return {
      text: `delete ${formatNumber(inTarget)}, then insert ${incoming}`,
      tone: 'danger',
    };
  }

  if (mode === 'merge') {
    if (!inTarget) return { text: `insert ${incoming}`, tone: 'safe' };
    return {
      text: `overwrite the ones matching on _id, insert the rest of ${incoming}`,
      tone: 'warn',
    };
  }

  if (!inTarget) return { text: `insert ${incoming}`, tone: 'safe' };
  return {
    text: `insert up to ${incoming}, skipping any of the ${formatNumber(inTarget)} already there`,
    tone: 'dim',
  };
}

function summarisePreview(preview) {
  const target = preview.targetDatabase;
  const backupDocs = preview.rows.reduce((total, row) => total + (row.inBackup || 0), 0);
  const targetDocs = preview.rows.reduce((total, row) => total + (row.inTarget || 0), 0);
  const collateral = preview.collateralCollections.reduce(
    (total, row) => total + (row.inTarget || 0),
    0
  );

  if (preview.mode === 'dropDatabase') {
    const extra = preview.collateralCollections.length;
    return (
      `Deletes the whole "${target}" database — ${formatNumber(targetDocs + collateral)} document(s) ` +
      `across ${preview.rows.length + extra} collection(s)` +
      (extra > 0
        ? `, including ${extra} not in this backup (${preview.collateralCollections
            .map((row) => row.name)
            .join(', ')})`
        : '') +
      ` — then writes ${formatNumber(backupDocs)}.`
    );
  }
  if (preview.mode === 'drop') {
    return (
      `Deletes ${formatNumber(targetDocs)} existing document(s) in ${preview.rows.length} ` +
      `collection(s) of "${target}", then writes ${formatNumber(backupDocs)}. Collections not in ` +
      'this backup are left alone.'
    );
  }
  if (preview.mode === 'merge') {
    return (
      `Writes ${formatNumber(backupDocs)} document(s) into "${target}". The ` +
      `${formatNumber(targetDocs)} already there are overwritten only where an _id matches.`
    );
  }
  return (
    `Writes at most ${formatNumber(backupDocs)} document(s) into "${target}". Nothing existing ` +
    `is deleted or changed; the ${formatNumber(targetDocs)} already there are skipped.`
  );
}

function renderPreview(preview) {
  const rows = $('dryRows');
  rows.textContent = '';

  for (const row of preview.rows) {
    const outcome = describeOutcome(row, preview.mode);
    const outcomeEl = el('span', 'dry-outcome', outcome.text);
    outcomeEl.dataset.tone = outcome.tone;

    rows.appendChild(
      el(
        'div',
        'dry-row',
        el('span', 'dry-name', row.name),
        el('span', 'dry-count', typeof row.inBackup === 'number' ? formatNumber(row.inBackup) : '—'),
        el('span', `dry-count${row.inTarget ? '' : ' dim'}`, row.inTarget ? formatNumber(row.inTarget) : '—'),
        outcomeEl
      )
    );
  }

  $('dryTotal').textContent = summarisePreview(preview);
  $('dryCard').classList.remove('hidden');
}

async function runDryRun() {
  const request = buildRestoreRequest();
  const problem = restoreBlocker(request, { requireConfirm: false });
  if (problem) {
    log('error', problem);
    return;
  }

  $('actionSecondary').disabled = true;
  log('accent', `Dry run against "${request.targetDatabase}" — nothing will be written.`);

  try {
    state.preview = unwrap(await window.api.previewRestore(request));
    renderPreview(state.preview);
    $('dryCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    log('accent', summarisePreview(state.preview));
  } catch (error) {
    clearPreview();
    log('error', `Dry run failed — ${error.message}`);
  } finally {
    $('actionSecondary').disabled = false;
  }
}

/* ──────────────────────────── job plumbing ─────────────────────────── */

function activeListId() {
  return state.running === 'restore' ? 'restoreCollections' : 'backupCollections';
}

function setProgress(fraction) {
  const bar = $('actionProgress');
  const percent = Math.max(0, Math.min(100, fraction * 100));
  bar.style.width = `${percent}%`;
  bar.style.opacity = state.running ? '1' : '0';
}

function overallFraction() {
  if (state.progress.total === 0) return 0;
  return (state.progress.done + Math.min(1, state.progress.fraction)) / state.progress.total;
}

function handleJobEvent(event) {
  if (state.activeJobId && event.jobId !== state.activeJobId) return;
  const listId = activeListId();

  switch (event.kind) {
    case 'started':
      state.activeJobId = event.jobId;
      break;

    case 'log':
      log(event.level, event.message);
      break;

    case 'plan':
      state.progress = { total: event.collections.length, done: 0, fraction: 0 };
      // The engine may have narrowed the plan (views last, filters applied), so
      // only the collections actually in it should show progress.
      for (const row of progressRows(listId)) {
        const inPlan = event.collections.some((item) => item.name === row.dataset.name);
        row.style.opacity = inPlan ? '' : '0.45';
      }
      refreshActionBar();
      break;

    case 'collection':
      if (event.status === 'running') {
        state.progress.fraction = 0;
      } else if (event.status === 'done') {
        state.progress.done = event.index + 1;
        state.progress.fraction = 0;
      }
      updateCollectionRow(listId, event.name, { ...event, fraction: 0 });
      setProgress(overallFraction());
      refreshActionBar();
      break;

    case 'progress': {
      if (event.estimatedTotal > 0 && typeof event.documents === 'number') {
        state.progress.fraction = event.documents / event.estimatedTotal;
      } else if (event.totalBytes > 0 && typeof event.bytes === 'number') {
        state.progress.fraction = event.bytes / event.totalBytes;
      }
      updateCollectionRow(listId, event.collection, {
        ...event,
        status: 'running',
        fraction: state.progress.fraction,
      });
      setProgress(overallFraction());
      break;
    }

    case 'done':
      state.progress.done = state.progress.total;
      state.progress.fraction = 1;
      setProgress(1);
      break;

    default:
      break;
  }
}

function setRunning(kind) {
  state.running = kind;
  document.body.classList.toggle('is-running', Boolean(kind));
  if (kind) {
    state.outcome = null;
    setLogOpen(true);
  }
  refreshActionBar();
}

/* ─────────────────────────── the action bar ────────────────────────── */

// Reached for two different reasons — a destructive mode, or a connection
// marked production — so it names where the checkbox is rather than guessing
// at why it is being asked for.
const CONFIRM_BLOCKER =
  'Tick the confirmation under "If the target already has data" to continue.';

/** Why the primary button cannot run yet, or null when it can. */
function backupBlocker() {
  if (!currentUri()) return 'Enter the MongoDB URI to back up from.';
  if (state.selectedDatabases.length === 0) return 'Select at least one database to back up.';
  if (!$('backupOutput').value.trim()) return 'Choose a folder to save the backup in.';
  if (
    state.backupListMode === 'collections' &&
    collectionRows('backupCollections').length > 0 &&
    checkedNames('backupCollections').length === 0
  ) {
    return 'Pick at least one collection.';
  }
  if (state.backupListMode === 'databases') {
    const empty = state.selectedDatabases.filter((name) => isGroupEmpty(name));
    if (empty.length > 0) {
      return `Pick at least one collection in ${empty.map((name) => `"${name}"`).join(', ')}.`;
    }
  }
  return null;
}

function restoreBlocker(request, { requireConfirm = true } = {}) {
  if (!request.uri) return 'Enter the MongoDB URI to restore into.';
  if (!request.sourceDir) return 'Choose the backup folder to restore from.';
  if (!request.targetDatabase) return 'Enter the target database name.';
  if (collectionRows('restoreCollections').length === 0) return 'Choose a backup folder first.';
  if (checkedNames('restoreCollections').length === 0) return 'Pick at least one collection.';
  if (requireConfirm && confirmationRequired() && !$('restoreDropConfirm').checked) {
    return CONFIRM_BLOCKER;
  }
  return null;
}

/**
 * Show how the last run ended, until the form is touched again.
 *
 * Returns true when it has written the title and detail, so the caller leaves
 * them alone: a finished run's result is more useful than "Ready to back up",
 * and a failure that quietly reverts to Ready reads as though it never ran.
 */
function applyOutcome(kind, title, detail) {
  const outcome = state.outcome;
  if (!outcome || outcome.kind !== kind) return false;

  const label = kind === 'backup' ? 'Backup' : 'Restore';
  if (outcome.status === 'done') {
    title.textContent = `${label} complete`;
    title.classList.add('is-ok');
  } else if (outcome.status === 'cancelled') {
    title.textContent = `${label} stopped`;
    title.classList.add('is-warn');
  } else {
    title.textContent = `${label} failed`;
    title.classList.add('is-danger');
  }
  detail.textContent = outcome.detail;
  return true;
}

function refreshActionBar() {
  const bar = $('actionBar');
  const title = $('actionTitle');
  const detail = $('actionDetail');
  const primary = $('actionPrimary');
  const secondary = $('actionSecondary');

  // Neither of these views has anything to run.
  if (state.view === 'history' || state.view === 'connect') {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  title.className = 'actionbar-title';
  primary.className = 'btn primary';
  primary.disabled = false;
  secondary.classList.remove('hidden');
  secondary.disabled = false;

  if (state.running) {
    const isBackup = state.running === 'backup';
    const name = isBackup
      ? state.selectedDatabases.join(', ') || 'the database'
      : $('restoreTargetDatabase').value.trim();
    title.textContent = `${isBackup ? 'Backing up' : 'Restoring into'} ${name}…`;
    detail.textContent =
      `${Math.round(overallFraction() * 100)}% · ` +
      `${state.progress.done} of ${state.progress.total} collection(s)`;
    primary.textContent = 'Cancel';
    primary.className = 'btn is-cancel';
    secondary.classList.add('hidden');
    return;
  }

  if (state.view === 'backup') {
    const blocker = backupBlocker();
    const selected = checkedNames('backupCollections').length;
    const rows = collectionRows('backupCollections');
    // Database rows carry no checkbox, so this asks for the ticked names
    // rather than assuming every row has one.
    const ticked = new Set(checkedNames('backupCollections'));
    const documents = rows
      .filter((row) => ticked.has(row.dataset.name))
      .reduce((total, row) => total + (Number(row.dataset.documents) || 0), 0);

    const finished = applyOutcome('backup', title, detail);
    if (!finished) {
      title.textContent = 'Ready to back up';
      if (blocker) detail.textContent = blocker;
      else if (state.backupListMode === 'databases') {
        const narrowed = state.selectedDatabases.filter(
          (name) => groupFor(name).selected !== null
        ).length;
        detail.textContent =
          `${plural(state.selectedDatabases.length, 'database')} · ` +
          (narrowed ? `${narrowed} narrowed to specific collections` : 'every collection in each');
      } else if (rows.length > 0) {
        detail.textContent =
          `${selected} of ${rows.length} collection(s) · ${formatNumber(documents)} document(s)`;
      } else {
        detail.textContent = `Writes into ${$('backupOutput').value.trim()}`;
      }
    }

    primary.textContent = 'Start backup';
    primary.disabled = Boolean(blocker);
    secondary.textContent = 'Open backup folder';
    secondary.disabled = !state.lastBackupFolder;
    return;
  }

  const request = buildRestoreRequest();
  const blocker = restoreBlocker(request);
  const mode = currentRestoreMode();
  const destructive = mode === 'drop' || mode === 'dropDatabase';
  const target = request.targetDatabase || 'the target';
  const selected = checkedNames('restoreCollections').length;

  const finished = applyOutcome('restore', title, detail);
  if (finished) {
    primary.textContent = 'Start restore';
    primary.disabled = Boolean(blocker);
    if (destructive) primary.classList.add('is-destructive');
    secondary.textContent = 'Preview (dry run)';
    secondary.disabled = Boolean(blocker) && blocker !== CONFIRM_BLOCKER;
    return;
  }

  if (destructive) {
    title.textContent = 'This will delete data';
    title.classList.add('is-danger');
  } else {
    title.textContent = 'Ready to restore';
  }

  if (blocker) {
    detail.textContent = blocker;
  } else if (mode === 'dropDatabase') {
    detail.textContent = `Drops "${target}" entirely, then writes ${plural(selected, 'collection')}`;
  } else if (mode === 'drop') {
    detail.textContent = `Drops ${plural(selected, 'collection')} in "${target}", then rewrites them`;
  } else if (mode === 'merge') {
    detail.textContent = `Writes ${plural(selected, 'collection')} into "${target}", overwriting matches on _id`;
  } else {
    detail.textContent = `Inserts new documents into "${target}" · existing ones are skipped`;
  }

  primary.textContent = 'Start restore';
  primary.disabled = Boolean(blocker);
  if (destructive) primary.classList.add('is-destructive');
  secondary.textContent = 'Preview (dry run)';
  secondary.disabled = Boolean(blocker) && blocker !== CONFIRM_BLOCKER;
}

/* ───────────────────────────── backup flow ─────────────────────────── */

async function startBackup() {
  const databases = [...state.selectedDatabases];
  const request = {
    uri: currentUri(),
    databases,
    // Kept for anything still reading the older single-database shape.
    database: databases[0],
    outputDir: $('backupOutput').value.trim(),
    gzip: $('backupGzip').checked,
    includeCollections: selectedCollections('backupCollections'),
    // One list per database, so each can contribute a different set.
    selections: state.backupListMode === 'databases' ? databaseSelections() : undefined,
  };

  const blocker = backupBlocker();
  if (blocker) return log('error', blocker);

  // A checkpoint that names the direction: the two views are the same shape,
  // and the costly mistake is running one while believing you are on the other.
  const selected = request.includeCollections;
  const confirmed = unwrap(
    await window.api.confirm({
      type: 'question',
      title: 'Start backup',
      message:
        databases.length === 1
          ? `Back up "${databases[0]}"?`
          : `Back up ${databases.length} databases?`,
      detail:
        (databases.length > 1
          ? `${databases
              .map((name) => {
                const group = groupFor(name);
                return group.selected === null
                  ? `${name} (all collections)`
                  : `${name} (${plural(group.selected.size, 'collection')})`;
              })
              .join('\n')}\n\n`
          : '') +
        `Reads from ${hostFromUri(request.uri) || 'the server'} and writes files into:\n` +
        `${request.outputDir}\n\n` +
        (selected ? `Only the ${selected.length} selected collection(s).\n\n` : '') +
        (databases.length > 1
          ? 'Each database gets its own subfolder inside one run folder.\n\n'
          : '') +
        'Nothing in the database is changed by a backup.',
      confirmLabel: 'Start backup',
    })
  );
  if (!confirmed) {
    log('system', 'Backup cancelled before it started.');
    return;
  }

  savePrefs({
    backupDatabases: databases,
    backupOutput: request.outputDir,
    backupGzip: request.gzip,
  });

  setRunning('backup');
  resetCollectionProgress('backupCollections');
  state.progress = { total: 0, done: 0, fraction: 0 };
  setProgress(0);
  log(
    'system',
    databases.length === 1
      ? `Backup started for "${databases[0]}".`
      : `Backup started for ${databases.length} databases.`
  );

  try {
    const result = await window.api.startBackup(request);

    if (result.ok) {
      const totals = result.summary.totals;
      state.lastBackupFolder = result.summary.outputFolder;
      state.outcome = {
        kind: 'backup',
        status: 'done',
        detail:
          (totals.databases ? `${plural(totals.databases, 'database')} · ` : '') +
          `${plural(totals.collections, 'collection')} · ` +
          `${formatNumber(totals.documents)} document(s) · ${formatBytes(totals.bytes)} → ` +
          result.summary.outputFolder,
      };
    } else {
      state.outcome = {
        kind: 'backup',
        status: result.cancelled ? 'cancelled' : 'failed',
        detail: result.error || '',
      };
      if (!result.cancelled) setProgress(0);
    }
  } catch (error) {
    log('error', error.message);
    state.outcome = { kind: 'backup', status: 'failed', detail: error.message };
  } finally {
    state.activeJobId = null;
    setRunning(null);
    setProgress(0);
    for (const row of progressRows('backupCollections')) row.style.opacity = '';
    loadHistory();
  }
}

/* ──────────────────────────── restore flow ─────────────────────────── */

function buildRestoreRequest() {
  const mode = currentRestoreMode();
  const source = currentSourceDatabase();
  return {
    uri: currentUri(),
    sourceDir: $('restoreSource').value.trim(),
    sourceDatabase: source ? source.name : undefined,
    targetDatabase: $('restoreTargetDatabase').value.trim(),
    drop: mode === 'drop',
    dropDatabase: mode === 'dropDatabase',
    writeMode: mode === 'merge' ? 'upsert' : 'insert',
    withIndexes: $('restoreIndexes').checked,
    bypassDocumentValidation: $('restoreBypassValidation').checked,
    includeCollections: selectedCollections('restoreCollections'),
  };
}

async function startRestore() {
  const request = buildRestoreRequest();
  const blocker = restoreBlocker(request);
  if (blocker) return log('error', blocker);

  const mode = currentRestoreMode();
  const source = currentSourceDatabase();

  // Every restore is confirmed, not just the destructive ones: the mistake
  // worth catching is running a restore while believing it is a backup, and
  // that mistake looks harmless in the safe modes right up until it is not.
  const MODE_DETAIL = {
    keep: 'Documents that already exist are kept and skipped. Only new documents are inserted.',
    merge: 'Documents sharing an _id are overwritten. Others are inserted.',
    drop: 'Each collection in this backup is DROPPED from the target first. This cannot be undone.',
    dropDatabase:
      'The ENTIRE target database is dropped first, including collections that are not in this ' +
      'backup. This cannot be undone.',
  };
  const destructive = mode === 'drop' || mode === 'dropDatabase';
  const count = request.includeCollections
    ? request.includeCollections.length
    : (source && source.collections.length) || 0;

  const confirmed = unwrap(
    await window.api.confirm({
      type: destructive ? 'warning' : 'question',
      title: destructive ? 'Confirm destructive restore' : 'Start restore',
      message: `Restore into the database "${request.targetDatabase}"?`,
      detail:
        `Writes ${count} collection(s) from:\n${request.sourceDir}\n` +
        `into "${request.targetDatabase}" on ${hostFromUri(request.uri) || 'the server'}.\n\n` +
        `${MODE_DETAIL[mode]}\n\n` +
        'This writes into the database. It does not create a backup.',
      confirmLabel: destructive ? 'Yes, overwrite data' : 'Start restore',
    })
  );
  if (!confirmed) {
    log('system', 'Restore cancelled before it started.');
    return;
  }

  savePrefs({ restoreTargetDatabase: request.targetDatabase, restoreSource: request.sourceDir });

  setRunning('restore');
  clearPreview();
  resetCollectionProgress('restoreCollections');
  state.progress = { total: 0, done: 0, fraction: 0 };
  setProgress(0);
  log('system', `Restore started into "${request.targetDatabase}".`);

  try {
    const result = await window.api.startRestore(request);
    if (result.ok) {
      const totals = result.summary.totals;
      state.outcome = {
        kind: 'restore',
        status: 'done',
        detail:
          `${plural(totals.collections, 'collection')} · ` +
          `${formatNumber(totals.documents)} document(s) written into ` +
          `"${result.summary.targetDatabase}"` +
          (totals.duplicates > 0 ? ` · ${formatNumber(totals.duplicates)} already there` : ''),
      };
    } else {
      state.outcome = {
        kind: 'restore',
        status: result.cancelled ? 'cancelled' : 'failed',
        detail: result.error || '',
      };
      if (!result.cancelled) setProgress(0);
    }
  } catch (error) {
    log('error', error.message);
    state.outcome = { kind: 'restore', status: 'failed', detail: error.message };
  } finally {
    state.activeJobId = null;
    setRunning(null);
    setProgress(0);
    for (const row of collectionRows('restoreCollections')) row.style.opacity = '';
    loadHistory();
  }
}

/* ───────────────────────────── history view ────────────────────────── */

async function loadHistory() {
  try {
    state.history = unwrap(await window.api.listHistory());
  } catch {
    state.history = [];
  }
  $('historyCount').textContent = state.history.length ? String(state.history.length) : '';
  if (state.view === 'history') renderHistory();
}

const RUN_STATUS_LABEL = { done: 'Done', failed: 'Failed', cancelled: 'Stopped' };

function renderHistory() {
  const list = $('historyList');
  list.textContent = '';

  $('historySummary').textContent = state.history.length
    ? `${plural(state.history.length, 'run')} recorded on this machine.`
    : 'No runs recorded yet.';
  $('historyClear').classList.toggle('hidden', state.history.length === 0);

  if (state.history.length === 0) {
    list.appendChild(
      el(
        'p',
        'history-empty',
        'Every backup and restore is recorded here — including the ones that fail, so you can see how far they got.'
      )
    );
    return;
  }

  for (const run of state.history) {
    list.appendChild(renderRun(run));
  }
}

function renderRun(run) {
  const card = el('div', `run is-${run.kind}`);
  if (run.status !== 'done') card.classList.add(`is-${run.status}`);
  const open = state.openRun === run.id;
  if (open) card.classList.add('is-open');

  const chevron = chevronIcon('run-chevron');

  // A run over several databases has no single name to show, so the count
  // goes in the name column and the names themselves go in the detail.
  const databases = Array.isArray(run.databases) ? run.databases : [];
  const isMulti = databases.length > 1;
  const title = isMulti ? plural(databases.length, 'database') : run.database || '—';
  const detail = [
    run.host,
    isMulti ? databases.map((database) => database.name).join(', ') : '',
    run.detail,
  ]
    .filter(Boolean)
    .join(' · ');

  const head = el(
    'button',
    'run-head',
    el('span', 'run-kind', run.kind === 'backup' ? 'Backup' : 'Restore'),
    el('span', 'run-db', title),
    el('span', 'run-when', formatWhen(run.finishedAt)),
    el('span', 'run-detail', detail),
    el('span', 'run-size', run.totals && run.totals.bytes ? formatBytes(run.totals.bytes) : '—'),
    el('span', 'run-status', RUN_STATUS_LABEL[run.status] || run.status),
    chevron
  );
  head.type = 'button';
  head.addEventListener('click', () => {
    const closing = state.openRun === run.id;
    state.openRun = closing ? null : run.id;
    if (closing) {
      for (const key of [...state.openRunDatabases]) {
        if (key.startsWith(`${run.id}/`)) state.openRunDatabases.delete(key);
      }
    }
    renderHistory();
  });
  card.appendChild(head);

  if (!open) return card;

  const body = el('div', 'run-body');

  /** One line: a collection, or a database inside a multi-database run. */
  const detailRow = (item, extra) => {
    const stateEl = el('span', 'state', item.status === 'done' ? 'done' : item.status);
    if (item.status !== 'done') stateEl.classList.add('is-pending');
    const row = el(
      'div',
      'run-row',
      el('span', 'name', item.name),
      el('span', 'num', extra || `${formatNumber(item.documents)} docs`),
      el('span', 'num', item.bytes ? formatBytes(item.bytes) : '—'),
      stateEl
    );
    return row;
  };

  if (isMulti) {
    // The same shape the form had: a row per database, opening onto its own
    // collections, rather than a flat list that hides which database each
    // collection came from.
    for (const database of databases) {
      const key = `${run.id}/${database.name}`;
      const open = state.openRunDatabases.has(key);
      const totals = database.totals || {};

      const group = el('div', `run-group${open ? ' is-open' : ''}`);
      const toggle = el('button', 'run-group-head');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.append(
        chevronIcon('run-group-chevron'),
        el('span', 'name', database.name),
        el(
          'span',
          'num',
          totals.collections ? plural(totals.collections, 'collection') : '—'
        ),
        el('span', 'num', `${formatNumber(totals.documents || 0)} docs`),
        el('span', 'num', totals.bytes ? formatBytes(totals.bytes) : '—'),
        el('span', `state${database.status === 'done' ? '' : ' is-pending'}`, database.status)
      );
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (open) state.openRunDatabases.delete(key);
        else state.openRunDatabases.add(key);
        renderHistory();
      });
      group.appendChild(toggle);

      if (open) {
        const inner = el('div', 'run-group-body');
        if (database.collections.length === 0) {
          inner.appendChild(
            el('p', 'run-group-note', 'No per-collection detail was recorded for this database.')
          );
        } else {
          for (const collection of database.collections) inner.appendChild(detailRow(collection));
        }
        group.appendChild(inner);
      }

      body.appendChild(group);
    }
  } else {
    for (const collection of run.collections) body.appendChild(detailRow(collection));
  }

  if (run.error) body.appendChild(el('div', 'run-error', run.error));

  const actions = el('div', 'run-actions');

  if (run.folder) {
    const openFolder = el('button', 'btn', 'Open folder');
    openFolder.type = 'button';
    openFolder.addEventListener('click', async () => {
      try {
        unwrap(await window.api.openPath(run.folder));
      } catch (error) {
        log('error', error.message);
      }
    });
    actions.appendChild(openFolder);
  }

  if (run.kind === 'backup' && run.folder && run.status === 'done') {
    // The restore form reads a dump root as easily as a single database
    // folder, so a multi-database run loads whole and its picker chooses.
    const restoreThis = el('button', 'btn', isMulti ? 'Restore from this' : 'Restore this');
    restoreThis.type = 'button';
    restoreThis.addEventListener('click', async () => {
      $('restoreSource').value = run.folder;
      setView('restore');
      await inspectSource(run.folder);
      log(
        'system',
        isMulti
          ? `Loaded ${plural(databases.length, 'database')} from ${run.folder} into the restore form.`
          : `Loaded "${run.database}" from ${run.folder} into the restore form.`
      );
    });
    actions.appendChild(restoreThis);
  }

  const forget = el('button', 'btn', 'Remove');
  forget.type = 'button';
  forget.addEventListener('click', async () => {
    try {
      state.history = unwrap(await window.api.removeHistory(run.id));
      $('historyCount').textContent = state.history.length ? String(state.history.length) : '';
      renderHistory();
    } catch (error) {
      log('error', error.message);
    }
  });
  actions.appendChild(forget);

  actions.append(el('span', 'spacer'), el('span', 'run-path', run.folder || ''));
  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

/* ──────────────────────────────── wiring ───────────────────────────── */

function wireWindowControls(info) {
  $('winMinimize').addEventListener('click', () => window.api.minimizeWindow());
  $('winClose').addEventListener('click', () => window.api.closeWindow());
  $('winMaximize').addEventListener('click', async () => {
    const result = await window.api.toggleMaximizeWindow();
    if (result && result.ok) setMaximized(Boolean(result.data));
  });

  window.api.onWindowState((payload) => setMaximized(Boolean(payload.maximized)));
  setMaximized(Boolean(info && info.maximized));
}

function setMaximized(maximized) {
  state.maximized = maximized;
  document.body.classList.toggle('is-maximized', maximized);
  $('winMaximize').title = maximized ? 'Restore down' : 'Maximise';
}

/** Show or hide a group of URI fields together, and label their buttons. */
function setRevealed(inputIds, buttonIds, revealed) {
  for (const id of inputIds) $(id).type = revealed ? 'text' : 'password';
  for (const id of buttonIds) $(id).textContent = revealed ? 'Hide' : 'Show';
}

function wireRevealToggle(buttonIds, inputIds) {
  for (const buttonId of buttonIds) {
    $(buttonId).addEventListener('click', () => {
      setRevealed(inputIds, buttonIds, $(inputIds[0]).type === 'password');
    });
  }
}

/** The About dialog, opened from the version in the sidebar. */
function wireAbout(info) {
  const dialog = $('aboutDialog');
  const runtime = `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`;

  $('aboutVersion').textContent = `Version ${info.version} · ${info.platform}`;
  $('aboutRuntime').textContent = runtime;

  $('appVersion').addEventListener('click', () => dialog.showModal());
  $('aboutClose').addEventListener('click', () => dialog.close());

  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  $('aboutCopy').addEventListener('click', async () => {
    const details = [
      `MongoDB Backup and Restore ${info.version}`,
      'Developed by Adrian Dela Cruz for Versa Innovations Corp.',
      runtime,
      `Platform: ${info.platform}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(details);
      log('system', 'App details copied to the clipboard.');
    } catch {
      log('error', 'Could not access the clipboard.');
    }
  });
}

async function init() {
  /* Shell */
  for (const button of document.querySelectorAll('.nav')) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }
  $('themeDark').addEventListener('click', () => {
    applyTheme('dark');
    savePrefs({ theme: 'dark' });
  });
  $('themeLight').addEventListener('click', () => {
    applyTheme('light');
    savePrefs({ theme: 'light' });
  });

  // The two working views show one connection, so revealing it reveals both.
  wireRevealToggle(['backupUriReveal', 'restoreUriReveal'], ['backupUri', 'restoreUri']);
  wireRevealToggle(['connectionUriReveal'], ['connectionUri']);
  wireConnectionDialog();

  let appInfo = null;
  try {
    appInfo = unwrap(await window.api.appInfo());
    $('appVersion').textContent = `v${appInfo.version}`;
    $('appVersion').title = `About — version ${appInfo.version}, Electron ${appInfo.electron}`;
    $('backupOutput').value = appInfo.defaultBackupDir;
    wireAbout(appInfo);
    wireWindowControls(appInfo);
  } catch {
    $('appVersion').textContent = '';
  }

  /* Settings */
  try {
    state.settings = unwrap(await window.api.getSettings());
    const prefs = state.settings.prefs || {};

    applyTheme(prefs.theme || (appInfo && appInfo.systemTheme) || 'dark');

    // Databases are not restored from preferences: which ones exist depends on
    // the server, and nothing should be selected before one is connected.
    if (prefs.backupOutput) $('backupOutput').value = prefs.backupOutput;
    if (prefs.backupGzip) $('backupGzip').checked = true;
    if (prefs.restoreSource) $('restoreSource').value = prefs.restoreSource;
    if (prefs.restoreTargetDatabase) $('restoreTargetDatabase').value = prefs.restoreTargetDatabase;
    if (prefs.logOpen) setLogOpen(true);

    renderConnections();

    if (!state.settings.encryptionAvailable) {
      log('warn', 'Windows credential encryption is unavailable; saving connections is disabled.');
    }
  } catch (error) {
    applyTheme((appInfo && appInfo.systemTheme) || 'dark');
    log('error', `Could not load settings — ${error.message}`);
  }

  state.combos.backup = createCombobox($('backupDatabase'), {
    multiple: true,
    onChange: onDatabaseSelectionChanged,
    anchor: $('backupDatabaseField'),
  });
  state.combos.restore = createCombobox($('restoreTargetDatabase'));
  refreshDatabaseChips();

  // Clicking the field itself should reach the input, so the picker opens
  // wherever in the chip area you happen to click.
  $('backupDatabaseField').addEventListener('mousedown', (event) => {
    if (event.target === $('backupDatabaseField') || event.target === $('backupDatabaseChips')) {
      event.preventDefault();
      $('backupDatabase').focus();
    }
  });

  /* Sidebar connections */
  $('connectionAdd').addEventListener('click', () => openConnectionDialog(null));
  $('connectAdd').addEventListener('click', () => openConnectionDialog(null));

  /* Backup view */
  $('backupTest').addEventListener('click', () => connect());
  $('backupBrowseDb').addEventListener('click', () => {
    if (state.combos.backup.count === 0) {
      log('error', 'Connect first — the list of databases comes from the server.');
      return;
    }
    state.combos.backup.toggle();
  });
  $('backupBrowse').addEventListener('click', async () => {
    try {
      const folder = unwrap(
        await window.api.selectFolder({
          title: 'Choose a folder for backups',
          defaultPath: $('backupOutput').value.trim() || undefined,
        })
      );
      if (folder) {
        $('backupOutput').value = folder;
        savePrefs({ backupOutput: folder });
        refreshResolvedPath();
        refreshActionBar();
      }
    } catch (error) {
      log('error', error.message);
    }
  });
  $('backupOutput').addEventListener('input', () => {
    refreshResolvedPath();
    refreshActionBar();
  });

  $('backupGzip').addEventListener('change', (event) => {
    savePrefs({ backupGzip: event.target.checked });
    refreshResolvedPath();
  });
  $('backupUri').addEventListener('input', (event) => {
    setUri(event.target.value.trim(), { silent: true });
    state.collections.key = null;
    state.activeProfileId = null;
    refreshConnectionState();
    refreshActionBar();
  });
  $('backupUri').addEventListener('change', () => {
    refreshFlow();
    renderConnections();
  });
  $('backupSelectAll').addEventListener('click', () => setAllChecked('backupCollections', true));
  $('backupSelectNone').addEventListener('click', () => setAllChecked('backupCollections', false));

  /* Restore view */
  $('restoreTest').addEventListener('click', () => connect());
  $('restoreUri').addEventListener('input', (event) => {
    $('backupUri').value = event.target.value.trim();
    state.collections.key = null;
    state.activeProfileId = null;
    refreshConnectionState();
    refreshActionBar();
  });
  $('restoreUri').addEventListener('change', () => {
    refreshFlow();
    renderConnections();
  });
  $('restoreBrowseDb').addEventListener('click', () => {
    if (state.combos.restore.count === 0) {
      log('error', 'Connect first — the list of databases comes from the server.');
      return;
    }
    state.combos.restore.toggle();
  });
  $('restoreBrowse').addEventListener('click', async () => {
    try {
      const folder = unwrap(
        await window.api.selectFolder({
          title: 'Choose the backup folder to restore',
          defaultPath: $('restoreSource').value.trim() || undefined,
        })
      );
      if (folder) {
        $('restoreSource').value = folder;
        await inspectSource(folder);
      }
    } catch (error) {
      log('error', error.message);
    }
  });
  $('restoreSource').addEventListener('change', (event) => inspectSource(event.target.value.trim()));
  $('restoreSourceDb').addEventListener('change', () => {
    $('restoreTargetDatabase').value = '';
    renderInspection();
  });
  $('restoreTargetDatabase').addEventListener('input', () => {
    refreshTargetState();
    refreshDestructiveUi();
  });
  $('restoreTargetDatabase').addEventListener('change', (event) => {
    savePrefs({ restoreTargetDatabase: event.target.value.trim() });
    refreshTargetState();
    refreshDestructiveUi();
  });
  for (const radio of document.querySelectorAll('input[name="restoreMode"]')) {
    radio.addEventListener('change', refreshDestructiveUi);
  }
  $('restoreDropConfirm').addEventListener('change', refreshActionBar);
  $('restoreSelectAll').addEventListener('click', () => setAllChecked('restoreCollections', true));
  $('restoreSelectNone').addEventListener('click', () => setAllChecked('restoreCollections', false));
  $('dryDismiss').addEventListener('click', clearPreview);
  for (const id of ['restoreIndexes', 'restoreBypassValidation']) {
    $(id).addEventListener('change', clearPreview);
  }

  /* Action bar */
  $('actionPrimary').addEventListener('click', async () => {
    if (state.running) {
      if (!state.activeJobId) return;
      $('actionPrimary').disabled = true;
      await window.api.cancelJob(state.activeJobId);
      log('warn', 'Cancelling — the current batch will finish first.');
      $('actionPrimary').disabled = false;
      return;
    }
    if (state.view === 'backup') await startBackup();
    else await startRestore();
  });

  $('actionSecondary').addEventListener('click', async () => {
    if (state.view === 'backup') {
      if (!state.lastBackupFolder) return;
      try {
        unwrap(await window.api.openPath(state.lastBackupFolder));
      } catch (error) {
        log('error', error.message);
      }
    } else {
      await runDryRun();
    }
  });

  /* History */
  $('historyClear').addEventListener('click', async () => {
    const confirmed = unwrap(
      await window.api.confirm({
        type: 'question',
        title: 'Clear history',
        message: 'Forget every recorded run?',
        detail: 'Only this list is cleared. No backup files on disk are touched.',
        confirmLabel: 'Clear history',
      })
    );
    if (!confirmed) return;
    try {
      state.history = unwrap(await window.api.clearHistory());
      state.openRun = null;
      state.openRunDatabases.clear();
      $('historyCount').textContent = '';
      renderHistory();
      log('system', 'History cleared.');
    } catch (error) {
      log('error', error.message);
    }
  });

  /* Log dock */
  $('logToggle').addEventListener('click', () => {
    const open = !document.body.classList.contains('log-open');
    setLogOpen(open);
    savePrefs({ logOpen: open });
  });
  $('logCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.logLines.join('\r\n'));
      log('system', 'Log copied to the clipboard.');
    } catch {
      log('error', 'Could not access the clipboard.');
    }
  });
  $('logSave').addEventListener('click', async () => {
    try {
      const saved = unwrap(await window.api.saveLog(state.logLines.join('\r\n')));
      if (saved) log('system', `Log saved to ${saved}`);
    } catch (error) {
      log('error', error.message);
    }
  });
  $('logClear').addEventListener('click', () => {
    state.logLines = [];
    $('log').textContent = '';
    $('logTail').textContent = '';
  });

  window.api.onJobEvent(handleJobEvent);
  window.api.onConnectionState(applyConnectionState);

  // Connections outlive a reload of the page but not the process, so pick up
  // whatever the main process is already holding.
  try {
    for (const entry of unwrap(await window.api.connectionStatus())) {
      state.connections.set(entry.uri, {
        status: entry.status,
        serverVersion: entry.serverVersion,
        topology: entry.topology,
        error: entry.error,
      });
    }
  } catch {
    /* nothing pooled yet */
  }

  refreshResolvedPath();
  refreshConnectionState();
  refreshDestructiveUi();
  await loadHistory();
  renderConnectList();
  refreshGate();
  setView(isConnected() ? (state.settings.prefs && state.settings.prefs.view) || 'backup' : 'connect');

  if ($('restoreSource').value.trim()) {
    await inspectSource($('restoreSource').value.trim());
  }

  log(
    'system',
    state.settings.profiles.length
      ? 'Ready. Choose a connection to begin.'
      : 'Ready. Add a connection to begin.'
  );
  refreshActionBar();
}

window.addEventListener('DOMContentLoaded', init);
