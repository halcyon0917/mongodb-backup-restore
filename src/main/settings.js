'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

let settingsPath = null;
let cache = null;

const EMPTY = { prefs: {}, profiles: [] };

function filePath() {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
  }
  return settingsPath;
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Connection strings hold credentials, so they are encrypted at rest with
 * Electron's safeStorage (DPAPI on Windows — scoped to the current user).
 * If the OS keystore is unavailable we refuse to write the secret rather than
 * silently dropping it to disk in plain text.
 */
function encryptSecret(value) {
  if (!value) return null;
  if (!encryptionAvailable()) return null;
  return safeStorage.encryptString(String(value)).toString('base64');
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      prefs: parsed.prefs && typeof parsed.prefs === 'object' ? parsed.prefs : {},
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
    };
  } catch {
    cache = { ...EMPTY, prefs: {}, profiles: [] };
  }
  return cache;
}

async function persist() {
  const data = load();
  await fsp.mkdir(path.dirname(filePath()), { recursive: true });
  await fsp.writeFile(filePath(), JSON.stringify(data, null, 2), 'utf8');
}

/** Everything the renderer needs on startup. URIs are decrypted here. */
function getSettings() {
  const data = load();
  return {
    prefs: data.prefs,
    encryptionAvailable: encryptionAvailable(),
    profiles: data.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      database: profile.database || '',
      production: Boolean(profile.production),
      uri: decryptSecret(profile.uri),
    })),
  };
}

async function savePrefs(prefs) {
  const data = load();
  data.prefs = { ...data.prefs, ...(prefs || {}) };
  await persist();
  return data.prefs;
}

/**
 * Create a connection, or update the one whose id is given.
 *
 * Identity is the id and nothing else. This used to also match on the name,
 * which meant saving a *new* connection under a name already in use silently
 * replaced that one instead of adding to the list. A name collision is now
 * reported rather than resolved by overwriting, so nothing is ever lost to a
 * coincidence.
 */
async function saveProfile(profile) {
  if (!profile || !profile.name || !String(profile.name).trim()) {
    throw new Error('Give the connection a name before saving it.');
  }
  if (!profile.uri || !String(profile.uri).trim()) {
    throw new Error('Enter the MongoDB URI for this connection.');
  }
  if (!encryptionAvailable()) {
    throw new Error(
      'Windows credential encryption is unavailable, so the connection string cannot be saved securely.'
    );
  }

  const data = load();
  const name = String(profile.name).trim();
  const id = profile.id ? String(profile.id) : null;

  const existing = id ? data.profiles.find((candidate) => candidate.id === id) : null;
  if (id && !existing) {
    throw new Error('That saved connection no longer exists — it may have been deleted.');
  }

  const clash = data.profiles.find(
    (candidate) =>
      candidate.name.toLowerCase() === name.toLowerCase() &&
      candidate.id !== (existing && existing.id)
  );
  if (clash) {
    throw new Error(`A connection called "${name}" already exists. Pick a different name.`);
  }

  const record = {
    id: (existing && existing.id) || crypto.randomUUID(),
    name,
    database: profile.database ? String(profile.database).trim() : '',
    production: Boolean(profile.production),
    uri: encryptSecret(profile.uri),
  };

  if (existing) {
    Object.assign(existing, record);
  } else {
    data.profiles.push(record);
  }

  data.profiles.sort((a, b) => a.name.localeCompare(b.name));
  await persist();
  return getSettings();
}

async function deleteProfile(id) {
  const data = load();
  data.profiles = data.profiles.filter((profile) => profile.id !== id);
  await persist();
  return getSettings();
}

module.exports = { deleteProfile, getSettings, saveProfile, savePrefs };
