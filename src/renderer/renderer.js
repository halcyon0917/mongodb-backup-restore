'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  activeJobId: null,
  settings: { prefs: {}, profiles: [], encryptionAvailable: false },
  inspection: null,
  rows: new Map(),
  planTotal: 0,
  planDone: 0,
  currentFraction: 0,
  lastBackupFolder: null,
  logLines: [],
  combos: { backup: null, restore: null },
  // Guards the auto-load of the backup collection list: `key` is the
  // uri+database already shown, `token` fences out superseded responses.
  collections: { key: null, token: 0 },
  // Fences out a slow profile connection when another profile is picked.
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

/** Unwrap the { ok, data, error } envelope every IPC handler returns. */
function unwrap(result) {
  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'The operation failed.');
  }
  return result.data;
}

/* ─────────────────────────────── logging ────────────────────────────── */

function log(level, message) {
  const time = new Date().toLocaleTimeString();
  state.logLines.push(`[${time}] ${level.toUpperCase()}: ${message}`);

  const line = document.createElement('div');
  line.className = `log-line ${level}`;

  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  timeEl.textContent = time;

  const messageEl = document.createElement('span');
  messageEl.className = 'msg';
  messageEl.textContent = message;

  line.append(timeEl, messageEl);

  const logEl = $('log');
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(title, detail = '') {
  $('statusTitle').textContent = title;
  $('statusDetail').textContent = detail;
}

/**
 * The progress table and log stay collapsed until there is something in them —
 * an empty "no job has run yet" table is not worth a third of the window.
 */
function setStatusOpen(open) {
  document.body.classList.toggle('status-open', open);
  $('statusToggle').setAttribute('aria-expanded', String(open));
}

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  $('progressFill').style.width = `${clamped}%`;
}

/* ────────────────────────── progress table ─────────────────────────── */

function makeRow(item) {
  const row = document.createElement('tr');
  const cells = {
    name: document.createElement('td'),
    docs: document.createElement('td'),
    size: document.createElement('td'),
    idx: document.createElement('td'),
    status: document.createElement('td'),
  };

  cells.docs.className = 'num';
  cells.size.className = 'num';
  cells.idx.className = 'num';

  cells.name.textContent = item.type === 'view' ? `${item.name} (view)` : item.name;
  cells.name.title = item.name;
  cells.docs.textContent =
    typeof item.estimatedDocuments === 'number'
      ? `0 / ${formatNumber(item.estimatedDocuments)}`
      : '0';
  cells.size.textContent = item.bytes ? formatBytes(item.bytes) : '—';
  cells.idx.textContent = '—';

  const badge = document.createElement('span');
  badge.className = 'badge pending';
  badge.textContent = 'queued';
  cells.status.appendChild(badge);

  row.append(cells.name, cells.docs, cells.size, cells.idx, cells.status);
  row.cells_ = cells;
  return row;
}

function resetTable(plan) {
  const tbody = $('progressRows');
  tbody.textContent = '';
  state.rows.clear();
  state.planTotal = plan.length;
  state.planDone = 0;
  state.currentFraction = 0;

  if (plan.length === 0) {
    const row = document.createElement('tr');
    row.className = 'placeholder';
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'Preparing…';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  for (const item of plan) {
    const row = makeRow(item);
    tbody.appendChild(row);
    state.rows.set(item.name, row);
  }
}

function setBadge(row, status) {
  const map = {
    running: ['running', 'running'],
    done: ['done', 'done'],
    error: ['error', 'failed'],
  };
  const [className, label] = map[status] || ['pending', 'queued'];
  const badge = row.cells_.status.firstChild;
  badge.className = `badge ${className}`;
  badge.textContent = label;
}

function updateRow(name, payload) {
  const row = state.rows.get(name);
  if (!row) return;
  const { documents, estimatedTotal, bytes, indexes, status } = payload;

  if (typeof documents === 'number') {
    row.cells_.docs.textContent =
      typeof estimatedTotal === 'number' && estimatedTotal > 0
        ? `${formatNumber(documents)} / ${formatNumber(estimatedTotal)}`
        : formatNumber(documents);
  }
  if (typeof bytes === 'number' && bytes > 0) {
    row.cells_.size.textContent = formatBytes(bytes);
  }
  if (typeof indexes === 'number') {
    row.cells_.idx.textContent = indexes > 0 ? String(indexes) : '—';
  }
  if (status) {
    setBadge(row, status);
    if (status === 'running') row.scrollIntoView({ block: 'nearest' });
  }
}

function refreshOverallProgress() {
  if (state.planTotal === 0) return;
  const completed = state.planDone + Math.min(1, state.currentFraction);
  setProgress((completed / state.planTotal) * 100);
}

/* ──────────────────────────── job plumbing ─────────────────────────── */

function setRunning(running, label) {
  $('backupStart').disabled = running;
  $('restoreStart').disabled = running;
  $('jobCancel').classList.toggle('hidden', !running);
  if (running) {
    setStatus(label, '');
    setStatusOpen(true);
  }
}

function handleJobEvent(event) {
  if (state.activeJobId && event.jobId !== state.activeJobId) return;

  switch (event.kind) {
    case 'started':
      state.activeJobId = event.jobId;
      break;

    case 'log':
      log(event.level, event.message);
      break;

    case 'plan':
      resetTable(event.collections);
      break;

    case 'collection':
      if (event.status === 'running') {
        setStatus(
          $('statusTitle').textContent,
          `${event.name} (${event.index + 1} of ${event.total})`
        );
        state.currentFraction = 0;
      } else if (event.status === 'done') {
        state.planDone = event.index + 1;
        state.currentFraction = 0;
      }
      updateRow(event.name, event);
      refreshOverallProgress();
      break;

    case 'progress': {
      updateRow(event.collection, event);
      if (event.estimatedTotal > 0 && typeof event.documents === 'number') {
        state.currentFraction = event.documents / event.estimatedTotal;
      } else if (event.totalBytes > 0 && typeof event.bytes === 'number') {
        state.currentFraction = event.bytes / event.totalBytes;
      }
      refreshOverallProgress();
      break;
    }

    case 'done':
      setProgress(100);
      break;

    default:
      break;
  }
}

/* ─────────────────────────── inline prompt ─────────────────────────── */

function promptForName(anchor, { defaultValue = '', placeholder = 'Name' } = {}) {
  return new Promise((resolve) => {
    anchor.parentElement.querySelectorAll('.inline-prompt').forEach((node) => node.remove());

    const wrap = document.createElement('div');
    wrap.className = 'inline-prompt';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.value = defaultValue;

    const okButton = document.createElement('button');
    okButton.className = 'btn primary small';
    okButton.textContent = 'Save';

    const cancelButton = document.createElement('button');
    cancelButton.className = 'btn ghost small';
    cancelButton.textContent = 'Cancel';

    wrap.append(input, okButton, cancelButton);

    const finish = (value) => {
      wrap.remove();
      resolve(value);
    };

    okButton.addEventListener('click', () => finish(input.value.trim() || null));
    cancelButton.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key === 'Enter') finish(input.value.trim() || null);
      if (keyEvent.key === 'Escape') finish(null);
    });

    anchor.insertAdjacentElement('afterend', wrap);
    input.focus();
    input.select();
  });
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

/* ───────────────────────────── profiles ────────────────────────────── */

function renderProfiles() {
  for (const selectId of ['backupProfile', 'restoreProfile']) {
    const select = $(selectId);
    const previous = select.value;
    select.textContent = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.settings.profiles.length
      ? 'Saved connections…'
      : 'No saved connections';
    select.appendChild(placeholder);

    for (const profile of state.settings.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      select.appendChild(option);
    }
    if (state.settings.profiles.some((profile) => profile.id === previous)) {
      select.value = previous;
    }
  }
}

function guessProfileName(uri) {
  const match = /@([^/?,]+)/.exec(uri) || /:\/\/([^/?,]+)/.exec(uri);
  return match ? match[1] : 'New connection';
}

/**
 * Connect using a saved profile and populate the database list.
 *
 * Picking a saved connection means "use this server", so the app does the
 * connecting rather than making you press Test and then Load. One survey call
 * covers both, so this costs a single handshake.
 */
async function connectSavedProfile(prefix, profile) {
  const uri = profile.uri || '';
  if (!uri) return;

  const statusEl = $(`${prefix}ConnStatus`);
  const token = state.connect.token + 1;
  state.connect.token = token;

  statusEl.className = 'hint';
  statusEl.textContent = 'Connecting…';

  try {
    const info = unwrap(await window.api.surveyConnection(uri));
    if (token !== state.connect.token) return; // another profile was picked

    for (const notice of info.notices || []) log('warn', notice);

    statusEl.className = 'hint ok';
    statusEl.textContent = `Connected — MongoDB ${info.serverVersion}, ${info.topology}.`;

    const combo = prefix === 'backup' ? state.combos.backup : state.combos.restore;
    combo.setItems(info.databases);

    log(
      'success',
      `Connected to MongoDB ${info.serverVersion} (${info.topology}) — ` +
        `${info.databases.length} database(s) available.`
    );

    // With a server confirmed, fill the collection list if a database is named.
    if (prefix === 'backup') loadBackupCollections();
  } catch (error) {
    if (token !== state.connect.token) return;
    statusEl.className = 'hint error';
    statusEl.textContent = error.message;
    log('error', `Could not connect using "${profile.name}" — ${error.message}`);
  }
}

function wireProfile(prefix, uriInput, databaseInput) {
  $(`${prefix}Profile`).addEventListener('change', (event) => {
    const profile = state.settings.profiles.find((entry) => entry.id === event.target.value);
    if (!profile) return;
    uriInput.value = profile.uri || '';
    if (profile.database && !databaseInput.value.trim()) databaseInput.value = profile.database;
    // A saved database belongs to this server, not the previous one.
    state.collections.key = null;
    log('system', `Loaded saved connection "${profile.name}".`);
    connectSavedProfile(prefix, profile);
  });

  $(`${prefix}SaveProfile`).addEventListener('click', async () => {
    const uri = uriInput.value.trim();
    if (!uri) {
      log('error', 'Enter a MongoDB URI before saving it.');
      return;
    }
    if (!state.settings.encryptionAvailable) {
      log('error', 'Windows credential encryption is unavailable, so connections cannot be saved.');
      return;
    }

    const selected = state.settings.profiles.find(
      (entry) => entry.id === $(`${prefix}Profile`).value
    );
    const name = await promptForName($(`${prefix}Profile`), {
      defaultValue: selected ? selected.name : guessProfileName(uri),
      placeholder: 'Connection name',
    });
    if (!name) return;

    try {
      state.settings = unwrap(
        await window.api.saveProfile({ name, uri, database: databaseInput.value.trim() })
      );
      renderProfiles();
      const saved = state.settings.profiles.find((entry) => entry.name === name);
      if (saved) $(`${prefix}Profile`).value = saved.id;
      log('success', `Saved "${name}". The connection string is encrypted for your Windows account.`);
    } catch (error) {
      log('error', error.message);
    }
  });

  $(`${prefix}DeleteProfile`).addEventListener('click', async () => {
    const id = $(`${prefix}Profile`).value;
    const profile = state.settings.profiles.find((entry) => entry.id === id);
    if (!profile) {
      log('error', 'Select a saved connection to delete.');
      return;
    }
    try {
      state.settings = unwrap(await window.api.deleteProfile(id));
      renderProfiles();
      log('system', `Deleted saved connection "${profile.name}".`);
    } catch (error) {
      log('error', error.message);
    }
  });
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
function createCombobox(input, { emptyLabel = 'No matching database' } = {}) {
  const popup = document.createElement('div');
  popup.className = 'combo-popup';
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

  function position() {
    const rect = input.getBoundingClientRect();
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

  function render() {
    popup.textContent = '';

    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'combo-empty';
      empty.textContent = emptyLabel;
      popup.appendChild(empty);
      return;
    }

    const chosen = input.value.trim().toLowerCase();

    matches.forEach((item, index) => {
      const isChosen = item.name.toLowerCase() === chosen;
      const option = document.createElement('div');
      option.className =
        'combo-option' + (index === activeIndex ? ' is-active' : '') + (isChosen ? ' is-chosen' : '');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(isChosen));

      // A fixed-width tick slot keeps every name on the same left edge.
      const tick = document.createElement('span');
      tick.className = 'combo-tick';
      tick.textContent = isChosen ? '✓' : '';

      const name = document.createElement('span');
      name.className = 'combo-name';
      name.textContent = item.name;

      const meta = document.createElement('span');
      meta.className = 'combo-meta';
      if (item.sizeOnDisk) meta.textContent = formatBytes(item.sizeOnDisk);

      option.append(tick, name, meta);
      // mousedown, not click: preventDefault keeps focus in the input so the
      // blur handler does not close the popup before the choice lands.
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        choose(index);
      });
      popup.appendChild(option);
    });
  }

  function applyFilter() {
    const value = input.value.trim().toLowerCase();
    matches =
      isSearching && value
        ? items.filter((item) => item.name.toLowerCase().includes(value))
        : items.slice();

    // Start on whatever is currently chosen, so opening the full list lands on
    // it and arrow keys continue from there rather than jumping to the top.
    const current = matches.findIndex((item) => item.name.toLowerCase() === value);
    activeIndex = current >= 0 ? current : matches.length > 0 ? 0 : -1;
  }

  function open() {
    if (items.length === 0) return;
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

  // A viewport-anchored popup must not drift away from its field. Scrolling now
  // happens inside the individual form columns, so listen in the capture phase
  // to catch scroll from whichever element actually moved.
  const reposition = () => {
    if (!isOpen) return;
    const rect = input.getBoundingClientRect();
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
    get count() {
      return items.length;
    },
  };
}

/* ──────────────────────── connection utilities ─────────────────────── */

async function testConnection(prefix) {
  const uri = $(`${prefix}Uri`).value.trim();
  const statusEl = $(`${prefix}ConnStatus`);
  const button = $(`${prefix}Test`);

  statusEl.className = 'hint';
  statusEl.textContent = 'Connecting…';
  button.disabled = true;

  try {
    const info = unwrap(await window.api.testConnection(uri));
    statusEl.className = 'hint ok';
    statusEl.textContent = `Connected — MongoDB ${info.serverVersion}, ${info.topology}.`;

    // e.g. the SRV lookup was refused and we reconnected through public DNS.
    for (const notice of info.notices || []) log('warn', notice);
    log('success', `Connected to MongoDB ${info.serverVersion} (${info.topology}).`);

    const databaseInput = $(prefix === 'backup' ? 'backupDatabase' : 'restoreTargetDatabase');
    if (info.defaultDatabase && !databaseInput.value.trim()) {
      databaseInput.value = info.defaultDatabase;
    }

    // The connection is known good now, so this is a safe moment to populate
    // the collection list for whatever database is already named.
    if (prefix === 'backup') loadBackupCollections();
  } catch (error) {
    statusEl.className = 'hint error';
    statusEl.textContent = error.message;
    log('error', `Connection failed — ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function loadDatabases(prefix) {
  const uri = $(`${prefix}Uri`).value.trim();
  const button = $(`${prefix}LoadDatabases`);

  if (!uri) {
    log('error', 'Enter the MongoDB URI first.');
    return;
  }

  button.disabled = true;
  try {
    const databases = unwrap(await window.api.listDatabases(uri));
    const combo = prefix === 'backup' ? state.combos.backup : state.combos.restore;
    combo.setItems(databases);
    const field = $(prefix === 'backup' ? 'backupDatabase' : 'restoreTargetDatabase');
    field.focus();
    log(
      'info',
      `Found ${databases.length} database(s). Click the field and type to filter the list.`
    );
  } catch (error) {
    log('error', `Could not list databases — ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

/* ─────────────────────────── collection lists ──────────────────────── */

function renderChecklist(containerId, items, emptyMessage = 'No collections found.') {
  const container = $(containerId);
  container.textContent = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'check';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = item.name;
    input.checked = true;

    const text = document.createElement('span');
    text.textContent = item.type === 'view' ? `${item.name} (view)` : item.name;

    const count = document.createElement('span');
    count.className = 'count';
    if (typeof item.documents === 'number') {
      count.textContent = `${formatNumber(item.documents)} docs`;
    } else if (item.bytes) {
      count.textContent = formatBytes(item.bytes);
    }

    label.append(input, text, count);
    container.appendChild(label);
  }
}

/** Returns null when everything is selected, so the engine backs up all of it. */
function selectedCollections(containerId) {
  const inputs = [...$(containerId).querySelectorAll('input[type="checkbox"]')];
  if (inputs.length === 0) return null;
  const checked = inputs.filter((input) => input.checked).map((input) => input.value);
  return checked.length === inputs.length ? null : checked;
}

function setAllChecked(containerId, checked) {
  $(containerId)
    .querySelectorAll('input[type="checkbox"]')
    .forEach((input) => {
      input.checked = checked;
    });
}

/** The host part of a URI, with any credentials stripped, for confirmations. */
function hostFromUri(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(String(uri).trim());
  return match ? match[1] : 'the server';
}

/** Restore modes that delete data get a red button, not merely a warm one. */
function refreshRestoreDanger() {
  const selected = document.querySelector('input[name="restoreMode"]:checked');
  const mode = selected ? selected.value : 'keep';
  $('restoreStart').classList.toggle(
    'is-destructive',
    mode === 'drop' || mode === 'dropDatabase'
  );
}

/**
 * Fill the backup Advanced column with the chosen database's collections.
 *
 * Runs whenever a database is committed (picked from the list, typed and
 * blurred, or after a successful connection test) so the list is simply there,
 * rather than behind a button press. Repeats for the same database are skipped,
 * which also preserves any boxes the user has unticked.
 */
async function loadBackupCollections({ force = false } = {}) {
  const uri = $('backupUri').value.trim();
  const database = $('backupDatabase').value.trim();
  if (!uri || !database) return;

  const key = `${uri} ${database}`;
  if (!force && key === state.collections.key) return;
  state.collections.key = key;

  const token = state.collections.token + 1;
  state.collections.token = token;

  renderChecklist('backupCollections', [], `Loading collections in "${database}"…`);

  try {
    const collections = unwrap(await window.api.listCollections(uri, database));
    if (token !== state.collections.token) return; // a newer request won
    renderChecklist(
      'backupCollections',
      collections,
      `"${database}" has no collections to back up.`
    );
    log('info', `"${database}" has ${collections.length} collection(s).`);
  } catch (error) {
    if (token !== state.collections.token) return;
    // Clear the cache so changing back to this database retries.
    state.collections.key = null;
    renderChecklist(
      'backupCollections',
      [],
      'Could not list collections — use Load collection list to retry.'
    );
    log('warn', `Could not list collections for "${database}" — ${error.message}`);
  }
}

/* ───────────────────────────── backup flow ─────────────────────────── */

async function startBackup() {
  const request = {
    uri: $('backupUri').value.trim(),
    database: $('backupDatabase').value.trim(),
    outputDir: $('backupOutput').value.trim(),
    gzip: $('backupGzip').checked,
    includeCollections: selectedCollections('backupCollections'),
  };

  if (!request.uri) return log('error', 'Enter the MongoDB URI to back up from.');
  if (!request.database) return log('error', 'Enter the database to back up.');
  if (!request.outputDir) return log('error', 'Choose a folder to save the backup in.');

  // A checkpoint that names the direction: the two tabs look alike, and the
  // costly mistake is running one while believing you are on the other.
  const selected = request.includeCollections;
  const confirmed = unwrap(
    await window.api.confirm({
      type: 'question',
      title: 'Start backup',
      message: `Back up "${request.database}"?`,
      detail:
        `Reads from ${hostFromUri(request.uri)} and writes files into:
` +
        `${request.outputDir}

` +
        (selected ? `Only the ${selected.length} selected collection(s).

` : '') +
        'Nothing in the database is changed by a backup.',
      confirmLabel: 'Start backup',
    })
  );
  if (!confirmed) {
    log('system', 'Backup cancelled before it started.');
    return;
  }

  savePrefs({
    backupDatabase: request.database,
    backupOutput: request.outputDir,
    backupGzip: request.gzip,
  });

  setRunning(true, 'Backing up…');
  $('backupOpenFolder').disabled = true;
  resetTable([]);
  setProgress(0);
  log('system', `Backup started for "${request.database}".`);

  try {
    const result = await window.api.startBackup(request);

    if (result.ok) {
      const totals = result.summary.totals;
      state.lastBackupFolder = result.summary.outputFolder;
      $('backupOpenFolder').disabled = false;
      setStatus(
        'Backup complete',
        `${totals.collections} collection(s) · ${formatNumber(totals.documents)} document(s) · ${formatBytes(totals.bytes)}`
      );
    } else {
      setStatus(result.cancelled ? 'Backup cancelled' : 'Backup failed', result.error || '');
      if (!result.cancelled) setProgress(0);
    }
  } catch (error) {
    log('error', error.message);
    setStatus('Backup failed', error.message);
  } finally {
    state.activeJobId = null;
    setRunning(false);
  }
}

/* ──────────────────────────── restore flow ─────────────────────────── */

function currentSourceDatabase() {
  if (!state.inspection) return null;
  const selected = $('restoreSourceDb').value;
  return (
    state.inspection.databases.find((database) => database.name === selected) ||
    state.inspection.databases[0]
  );
}

function renderInspection() {
  const inspection = state.inspection;
  const statusEl = $('restoreSourceStatus');

  $('restoreSourceDbField').classList.toggle('hidden', inspection.databases.length < 2);

  const select = $('restoreSourceDb');
  if (select.options.length !== inspection.databases.length) {
    select.textContent = '';
    for (const database of inspection.databases) {
      const option = document.createElement('option');
      option.value = database.name;
      option.textContent = `${database.name} — ${database.collections.length} collection(s)`;
      select.appendChild(option);
    }
  }

  const source = currentSourceDatabase();
  const documents = source.collections.reduce(
    (total, collection) => total + (collection.documents || 0),
    0
  );
  const bytes = source.collections.reduce(
    (total, collection) => total + (collection.bytes || 0),
    0
  );

  const parts = [`Backup of "${source.name}"`, `${source.collections.length} collection(s)`];
  if (documents > 0) parts.push(`${formatNumber(documents)} document(s)`);
  parts.push(`${formatBytes(bytes)} on disk`);
  if (inspection.manifest && inspection.manifest.createdAt) {
    parts.push(`taken ${new Date(inspection.manifest.createdAt).toLocaleString()}`);
  }

  statusEl.className = 'hint ok';
  statusEl.textContent = parts.join(' · ');

  renderChecklist('restoreCollections', source.collections);
  if (!$('restoreTargetDatabase').value.trim()) {
    $('restoreTargetDatabase').value = source.name;
  }
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
    statusEl.className = 'hint error';
    statusEl.textContent = error.message;
    renderChecklist('restoreCollections', [], 'Choose a backup folder to list its collections.');
  }
}

async function startRestore() {
  const mode = document.querySelector('input[name="restoreMode"]:checked').value;
  const source = currentSourceDatabase();

  const request = {
    uri: $('restoreUri').value.trim(),
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

  if (!request.uri) return log('error', 'Enter the MongoDB URI to restore into.');
  if (!request.sourceDir) return log('error', 'Choose the backup folder to restore from.');
  if (!request.targetDatabase) return log('error', 'Enter the target database name.');

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
        `Writes ${count} collection(s) from:
${request.sourceDir}
` +
        `into "${request.targetDatabase}" on ${hostFromUri(request.uri)}.

` +
        `${MODE_DETAIL[mode]}

` +
        'This writes into the database. It does not create a backup.',
      confirmLabel: destructive ? 'Yes, overwrite data' : 'Start restore',
    })
  );
  if (!confirmed) {
    log('system', 'Restore cancelled before it started.');
    return;
  }

  savePrefs({ restoreTargetDatabase: request.targetDatabase, restoreSource: request.sourceDir });

  setRunning(true, 'Restoring…');
  resetTable([]);
  setProgress(0);
  log('system', `Restore started into "${request.targetDatabase}".`);

  try {
    const result = await window.api.startRestore(request);

    if (result.ok) {
      const totals = result.summary.totals;
      setStatus(
        'Restore complete',
        `${totals.collections} collection(s) · ${formatNumber(totals.documents)} document(s) → "${result.summary.targetDatabase}"`
      );
    } else {
      setStatus(result.cancelled ? 'Restore cancelled' : 'Restore failed', result.error || '');
      if (!result.cancelled) setProgress(0);
    }
  } catch (error) {
    log('error', error.message);
    setStatus('Restore failed', error.message);
  } finally {
    state.activeJobId = null;
    setRunning(false);
  }
}

/* ──────────────────────────────── wiring ───────────────────────────── */

function wireTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        const active = other === tab;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-selected', String(active));
      }
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('is-active', panel.id === `panel-${tab.dataset.tab}`);
      }
    });
  }
}

function wireRevealToggle(buttonId, inputId) {
  $(buttonId).addEventListener('click', () => {
    const input = $(inputId);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $(buttonId).textContent = hidden ? 'Hide' : 'Show';
  });
}

/** The About dialog, opened from the version in the title bar. */
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
      `Developed by Adrian Dela Cruz for Versa Innovations Corp.`,
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
  wireTabs();
  wireRevealToggle('backupUriReveal', 'backupUri');
  wireRevealToggle('restoreUriReveal', 'restoreUri');

  try {
    const info = unwrap(await window.api.appInfo());
    $('appVersion').textContent = `v${info.version} · Electron ${info.electron}`;
    $('backupOutput').value = info.defaultBackupDir;
    wireAbout(info);
  } catch {
    $('appVersion').textContent = '';
  }

  try {
    state.settings = unwrap(await window.api.getSettings());
    renderProfiles();

    const prefs = state.settings.prefs || {};
    if (prefs.backupDatabase) $('backupDatabase').value = prefs.backupDatabase;
    if (prefs.backupOutput) $('backupOutput').value = prefs.backupOutput;
    if (prefs.backupGzip) $('backupGzip').checked = true;
    if (prefs.restoreSource) $('restoreSource').value = prefs.restoreSource;
    if (prefs.restoreTargetDatabase) {
      $('restoreTargetDatabase').value = prefs.restoreTargetDatabase;
    }

    if (!state.settings.encryptionAvailable) {
      log('warn', 'Windows credential encryption is unavailable; saving connections is disabled.');
    }
  } catch (error) {
    log('error', `Could not load settings — ${error.message}`);
  }

  state.combos.backup = createCombobox($('backupDatabase'));
  state.combos.restore = createCombobox($('restoreTargetDatabase'));

  wireProfile('backup', $('backupUri'), $('backupDatabase'));
  wireProfile('restore', $('restoreUri'), $('restoreTargetDatabase'));

  /* Backup panel */
  $('backupTest').addEventListener('click', () => testConnection('backup'));
  $('backupLoadDatabases').addEventListener('click', () => loadDatabases('backup'));
  $('backupStart').addEventListener('click', startBackup);

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
      }
    } catch (error) {
      log('error', error.message);
    }
  });

  $('backupLoadCollections').addEventListener('click', () => {
    if (!$('backupUri').value.trim() || !$('backupDatabase').value.trim()) {
      log('error', 'Enter the URI and the database name first.');
      return;
    }
    loadBackupCollections({ force: true });
  });

  $('backupSelectAll').addEventListener('click', () => setAllChecked('backupCollections', true));
  $('backupSelectNone').addEventListener('click', () => setAllChecked('backupCollections', false));

  $('backupOpenFolder').addEventListener('click', async () => {
    if (!state.lastBackupFolder) return;
    try {
      unwrap(await window.api.openPath(state.lastBackupFolder));
    } catch (error) {
      log('error', error.message);
    }
  });

  $('backupDatabase').addEventListener('change', (event) => {
    savePrefs({ backupDatabase: event.target.value.trim() });
    loadBackupCollections();
  });
  $('backupGzip').addEventListener('change', (event) =>
    savePrefs({ backupGzip: event.target.checked })
  );

  // A different server means the cached collection list no longer applies.
  $('backupUri').addEventListener('change', () => {
    state.collections.key = null;
  });

  /* Restore panel */
  $('restoreTest').addEventListener('click', () => testConnection('restore'));
  $('restoreLoadDatabases').addEventListener('click', () => loadDatabases('restore'));
  $('restoreStart').addEventListener('click', startRestore);

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

  $('restoreSource').addEventListener('change', (event) =>
    inspectSource(event.target.value.trim())
  );
  $('restoreSourceDb').addEventListener('change', () => {
    $('restoreTargetDatabase').value = '';
    renderInspection();
  });
  for (const radio of document.querySelectorAll('input[name="restoreMode"]')) {
    radio.addEventListener('change', refreshRestoreDanger);
  }
  refreshRestoreDanger();

  $('restoreSelectAll').addEventListener('click', () => setAllChecked('restoreCollections', true));
  $('restoreSelectNone').addEventListener('click', () =>
    setAllChecked('restoreCollections', false)
  );

  /* Status bar */
  $('jobCancel').addEventListener('click', async () => {
    if (!state.activeJobId) return;
    $('jobCancel').disabled = true;
    await window.api.cancelJob(state.activeJobId);
    log('warn', 'Cancelling — the current batch will finish first.');
    $('jobCancel').disabled = false;
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
  });

  $('statusToggle').addEventListener('click', () => {
    setStatusOpen(!document.body.classList.contains('status-open'));
  });

  window.api.onJobEvent(handleJobEvent);

  if ($('restoreSource').value.trim()) {
    inspectSource($('restoreSource').value.trim());
  }

  log('system', 'Ready. Enter a MongoDB URI and a database name to begin.');
}

window.addEventListener('DOMContentLoaded', init);
