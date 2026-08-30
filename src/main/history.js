'use strict';

/**
 * A record of every run the app has made, kept between sessions.
 *
 * Lives in its own file rather than settings.json: this grows with use and is
 * disposable, while settings holds the encrypted connection strings and should
 * stay small and stable.
 *
 * Nothing secret is stored. A run keeps the host it talked to but never the
 * connection string, so a copy of this file cannot be used to reach a server.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/** Old runs are trimmed away; this is a history panel, not an audit log. */
const LIMIT = 60;

let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist() {
  const runs = load();
  await fsp.mkdir(path.dirname(filePath()), { recursive: true });
  await fsp.writeFile(filePath(), JSON.stringify({ runs }, null, 2), 'utf8');
}

/** The host of a URI with any credentials removed — never store the URI itself. */
function hostOf(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?,]+)/i.exec(String(uri || '').trim());
  return match ? match[1] : '';
}

function listRuns() {
  return load();
}

function normaliseCollections(list) {
  return Array.isArray(list)
    ? list.map((collection) => ({
        name: collection.name,
        type: collection.type || 'collection',
        documents: Number(collection.documents) || 0,
        bytes: Number(collection.bytes) || 0,
        indexes: Number(collection.indexes) || 0,
        status: collection.status || 'done',
      }))
    : [];
}

/**
 * Record a finished run.
 *
 * Called for failures and cancellations too: "why did last night's backup stop"
 * is exactly the question this panel exists to answer, and a list of successes
 * alone cannot answer it.
 */
async function addRun(entry) {
  const runs = load();
  const record = {
    id: crypto.randomUUID(),
    kind: entry.kind === 'restore' ? 'restore' : 'backup',
    status: entry.status || 'done', // done | failed | cancelled
    database: entry.database || '',
    host: hostOf(entry.uri),
    detail: entry.detail || '',
    folder: entry.folder || '',
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Number(entry.durationMs) || 0,
    error: entry.error || '',
    totals: entry.totals || { collections: 0, documents: 0, bytes: 0 },
    collections: normaliseCollections(entry.collections),
    // Present only for a run that covered more than one database, so History
    // can show it the way the form did: a row per database, each opening onto
    // its own collections.
    databases: Array.isArray(entry.databases)
      ? entry.databases.map((database) => ({
          name: database.name,
          status: database.status || 'done',
          totals: database.totals || { collections: 0, documents: 0, bytes: 0 },
          collections: normaliseCollections(database.collections),
        }))
      : [],
  };

  runs.unshift(record);
  runs.length = Math.min(runs.length, LIMIT);
  await persist();
  return record;
}

async function removeRun(id) {
  const runs = load();
  const index = runs.findIndex((run) => run.id === id);
  if (index >= 0) runs.splice(index, 1);
  await persist();
  return runs;
}

async function clearRuns() {
  cache = [];
  await persist();
  return cache;
}

module.exports = { addRun, clearRuns, hostOf, listRuns, removeRun };
