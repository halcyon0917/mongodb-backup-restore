'use strict';

/**
 * Live MongoDB connections, kept open for the length of the session.
 *
 * Until v2.1 every operation opened a client, ran, and closed it again. That
 * made the sidebar's green dot a lie: it meant "a handshake succeeded at some
 * point", not "this server is reachable now", and switching back to a server
 * you had already used paid for a fresh handshake — an SRV lookup and a TLS
 * negotiation on Atlas.
 *
 * Connections are now cached by URI and left open. The driver's own topology
 * monitoring decides whether one is up, so a dot turns grey when the server
 * really goes away rather than when the app happens to stop using it, and it
 * turns green again by itself when the server comes back.
 */

const { MongoClient } = require('mongodb');

/** uri -> entry. Entries live until the app quits or the user disconnects. */
const entries = new Map();

/** Called with (uri, state) whenever a connection's reachability changes. */
let onStateChange = () => {};

function setStateListener(listener) {
  onStateChange = typeof listener === 'function' ? listener : () => {};
}

function publicState(entry) {
  return {
    status: entry.status,
    serverVersion: entry.serverVersion || null,
    topology: entry.topology || null,
    error: entry.lastError || null,
  };
}

function announce(entry) {
  onStateChange(entry.uri, publicState(entry));
}

/**
 * Watch a client's topology so `status` reflects the server, not our last call.
 *
 * `topologyDescriptionChanged` fires whenever the driver's view of the cluster
 * changes. A description with no reachable server means every host is down or
 * unreachable; anything else means at least one is answering.
 */
function monitor(entry) {
  const client = entry.client;

  const evaluate = (description) => {
    const servers = description && description.servers ? [...description.servers.values()] : [];
    const reachable = servers.some((server) => server.type && server.type !== 'Unknown');
    const next = reachable ? 'connected' : 'lost';
    if (next === entry.status) return;
    entry.status = next;
    if (next === 'connected') entry.lastError = null;
    announce(entry);
  };

  client.on('topologyDescriptionChanged', (event) => evaluate(event.newDescription));

  client.on('serverHeartbeatFailed', (event) => {
    // Keep the reason for the UI; the description change decides the status.
    entry.lastError = event && event.failure ? String(event.failure.message || event.failure) : null;
  });

  // A client that closes itself can never come back, so drop it and let the
  // next use build a fresh one.
  client.on('close', () => {
    if (entries.get(entry.uri) !== entry) return;
    entry.status = 'lost';
    announce(entry);
  });
}

/**
 * Connect and cache, or hand back the cached client.
 *
 * `connect` is the factory that produces a connected client for this URI; it
 * lives in mongo.js because it owns the SRV fallback. Two callers asking for
 * the same URI at once share one in-flight attempt rather than racing to build
 * two clients.
 */
async function acquire(uri, connect) {
  const existing = entries.get(uri);
  if (existing) {
    if (existing.pending) return existing.pending.then(() => existing.client);
    if (existing.status !== 'lost') return existing.client;
    // A lost connection is worth one more try: the driver reconnects on its
    // own, so this is usually already healthy again by the time it is asked for.
    const description = existing.client.topology && existing.client.topology.description;
    const servers = description && description.servers ? [...description.servers.values()] : [];
    if (servers.some((server) => server.type && server.type !== 'Unknown')) {
      existing.status = 'connected';
      announce(existing);
      return existing.client;
    }
    await close(uri);
  }

  const entry = {
    uri,
    client: null,
    status: 'connecting',
    serverVersion: null,
    topology: null,
    lastError: null,
    pending: null,
  };
  entries.set(uri, entry);
  announce(entry);

  entry.pending = (async () => {
    try {
      const { client, serverVersion, topology } = await connect();
      entry.client = client;
      entry.serverVersion = serverVersion || null;
      entry.topology = topology || null;
      entry.status = 'connected';
      monitor(entry);
      announce(entry);
    } catch (error) {
      entries.delete(uri);
      entry.status = 'lost';
      entry.lastError = error.message;
      announce(entry);
      throw error;
    } finally {
      entry.pending = null;
    }
  })();

  await entry.pending;
  return entry.client;
}

/** What the renderer needs to colour one connection's indicator. */
function statusOf(uri) {
  const entry = entries.get(uri);
  return entry ? publicState(entry) : { status: 'idle', serverVersion: null, topology: null, error: null };
}

function allStatuses() {
  return [...entries.values()].map((entry) => ({ uri: entry.uri, ...publicState(entry) }));
}

/** Record the server details discovered by a survey, so reuse can report them. */
function describe(uri, { serverVersion, topology }) {
  const entry = entries.get(uri);
  if (!entry) return;
  let changed = false;
  if (serverVersion && entry.serverVersion !== serverVersion) {
    entry.serverVersion = serverVersion;
    changed = true;
  }
  if (topology && entry.topology !== topology) {
    entry.topology = topology;
    changed = true;
  }
  if (changed) announce(entry);
}

async function close(uri) {
  const entry = entries.get(uri);
  if (!entry) return false;
  entries.delete(uri);
  if (entry.client) {
    entry.client.removeAllListeners();
    await entry.client.close().catch(() => {});
  }
  onStateChange(uri, { status: 'idle', serverVersion: null, topology: null, error: null });
  return true;
}

async function closeAll() {
  await Promise.all([...entries.keys()].map((uri) => close(uri)));
}

module.exports = { acquire, allStatuses, close, closeAll, describe, setStateListener, statusOf };
