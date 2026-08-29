'use strict';

const dnsPromises = require('dns').promises;
const { MongoClient } = require('mongodb');

const URI_SCHEME = /^mongodb(\+srv)?:\/\//i;

// mongodb+srv://[credentials@]hostname[/database][?options]
const SRV_URI_RE = /^mongodb\+srv:\/\/(?:([^@/]*)@)?([^/?,]+)(\/[^?]*)?(\?.*)?$/i;

// Resolvers to fall back to when the system DNS will not answer SRV queries.
const FALLBACK_DNS_SERVERS = [
  ['1.1.1.1', '1.0.0.1'],
  ['8.8.8.8', '8.8.4.4'],
];

// A TXT record may only carry these options, per the connection-string spec.
const ALLOWED_TXT_OPTIONS = new Set(['authsource', 'replicaset', 'loadbalanced']);

const DNS_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEOUT',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ESERVFAIL',
  'EREFUSED',
  'ENODATA',
  'EAI_AGAIN',
]);

/** True when a failure came from the SRV/TXT lookup rather than from MongoDB. */
function isSrvLookupError(error) {
  if (!error) return false;
  if (/querySrv|queryTxt/i.test(error.message || '')) return true;
  return DNS_ERROR_CODES.has(error.code);
}

function describeDnsError(error) {
  if (!error) return 'unknown DNS error';
  return error.code || error.message || String(error);
}

/** "cluster0.abc123.mongodb.net" -> "abc123.mongodb.net" */
function parentDomain(hostname) {
  return hostname.split('.').slice(1).join('.');
}

/**
 * Assemble a seed-list URI from resolved SRV records — the same connection the
 * driver would have built for itself. Pure, so it can be tested without DNS.
 *
 * @param parts       {credentials, hostname, databasePath, query} from the URI
 * @param records     SRV answers ({ name, port })
 * @param txtOptions  raw TXT payload, e.g. "authSource=admin&replicaSet=rs0"
 */
function composeSeedListUri(parts, records, txtOptions = '') {
  const { credentials, hostname, databasePath, query } = parts;
  if (!records || records.length === 0) throw new Error('no SRV records returned');

  // The same rule the driver enforces: every host must sit inside the cluster's
  // own parent domain, so a hostile resolver cannot redirect us to a server it
  // controls and harvest the credentials we are about to send.
  const domain = parentDomain(hostname).toLowerCase();
  const hosts = records.map((record) => {
    const host = String(record.name).replace(/\.$/, '');
    const lower = host.toLowerCase();
    if (lower !== domain && !lower.endsWith(`.${domain}`)) {
      throw new Error(`SRV record "${host}" points outside ${domain}`);
    }
    return `${host}:${record.port}`;
  });

  const parameters = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(txtOptions || '')) {
    // A TXT record is only trusted for these three options.
    if (ALLOWED_TXT_OPTIONS.has(key.toLowerCase())) parameters.set(key, value);
  }

  // Options written in the URI win over the TXT defaults.
  for (const [key, value] of new URLSearchParams((query || '').replace(/^\?/, ''))) {
    parameters.set(key, value);
  }

  // "mongodb+srv" implies TLS, which a plain "mongodb" URI does not.
  const present = [...parameters.keys()].map((key) => key.toLowerCase());
  if (!present.includes('tls') && !present.includes('ssl')) {
    parameters.set('tls', 'true');
  }

  const search = parameters.toString();
  return (
    `mongodb://${credentials ? `${credentials}@` : ''}${hosts.join(',')}` +
    `${databasePath || '/'}${search ? `?${search}` : ''}`
  );
}

/**
 * Resolve an Atlas-style SRV URI into a plain seed-list URI using explicit
 * resolvers, for networks whose DNS refuses SRV queries — a common failure on
 * consumer routers, captive portals, and locked-down corporate DNS.
 */
async function buildSeedListUri(uri) {
  const match = SRV_URI_RE.exec(uri);
  if (!match) throw new Error('the connection string could not be parsed');

  const [, credentials, hostname, databasePath, query] = match;
  let lastError = null;

  for (const servers of FALLBACK_DNS_SERVERS) {
    try {
      const resolver = new dnsPromises.Resolver({ timeout: 5000, tries: 2 });
      resolver.setServers(servers);

      const records = await resolver.resolveSrv(`_mongodb._tcp.${hostname}`);

      let txtOptions = '';
      try {
        const txt = await resolver.resolveTxt(hostname);
        txtOptions = txt.map((chunks) => chunks.join('')).join('&');
      } catch {
        // The TXT record is optional; its options only carry defaults.
      }

      return {
        uri: composeSeedListUri({ credentials, hostname, databasePath, query }, records, txtOptions),
        hostCount: records.length,
        resolver: servers[0],
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('SRV lookup failed');
}

function srvHelpMessage(hostname, systemError, fallbackError) {
  return (
    `Could not look up the SRV record for ${hostname}. Your network's DNS reported ` +
    `${describeDnsError(systemError)}, and retrying through public DNS also failed ` +
    `(${describeDnsError(fallbackError)}). This is a DNS problem on this network, not a ` +
    `MongoDB problem — "mongodb+srv://" needs an SRV lookup before it can connect. ` +
    `Workaround: in Atlas open Connect → Drivers and switch the driver version to ` +
    `"Node.js 2.2.12 or later" to copy the standard "mongodb://" string, which lists the ` +
    `cluster hosts directly and needs no SRV lookup.`
  );
}

const DEFAULT_CLIENT_OPTIONS = {
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
  // Long-running dumps/restores must not be killed by a socket timeout.
  socketTimeoutMS: 0,
};

/** Validate and normalise a connection string. Throws with a readable message. */
function validateUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new Error('MongoDB URI is required.');
  }
  const trimmed = uri.trim();
  if (!URI_SCHEME.test(trimmed)) {
    throw new Error('MongoDB URI must start with "mongodb://" or "mongodb+srv://".');
  }
  return trimmed;
}

/** Validate a database name against the server's naming rules. */
function validateDatabaseName(name, label = 'Database') {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${label} name is required.`);
  }
  const trimmed = name.trim();
  if (trimmed.length > 63) {
    throw new Error(`${label} name must be 63 characters or fewer.`);
  }
  const invalid = /[/\\. "$*<>:|?\x00]/.exec(trimmed);
  if (invalid) {
    throw new Error(`${label} name contains an invalid character: ${JSON.stringify(invalid[0])}`);
  }
  return trimmed;
}

/** Pull the default database out of a URI path, if one is present. */
function databaseFromUri(uri) {
  try {
    const withoutScheme = String(uri).replace(URI_SCHEME, '');
    const slash = withoutScheme.indexOf('/');
    if (slash === -1) return '';
    const afterHost = withoutScheme.slice(slash + 1);
    const dbPart = afterHost.split('?')[0];
    return dbPart ? decodeURIComponent(dbPart) : '';
  } catch {
    return '';
  }
}

async function runWithUri(uri, fn) {
  const client = new MongoClient(uri, DEFAULT_CLIENT_OPTIONS);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Open a client, hand it to `fn`, and always close it again.
 *
 * If an Atlas-style "mongodb+srv://" connection fails in the DNS lookup rather
 * than in MongoDB itself, retry once by resolving the cluster through public DNS
 * and connecting to the hosts directly. Flaky consumer routers refuse SRV
 * queries intermittently, and the raw driver error ("querySrv ECONNREFUSED")
 * gives no hint that DNS is the problem.
 */
async function withClient(uri, fn, { onNotice = () => {} } = {}) {
  const validated = validateUri(uri);

  try {
    return await runWithUri(validated, fn);
  } catch (error) {
    const isSrv = /^mongodb\+srv:/i.test(validated);
    if (!isSrv || !isSrvLookupError(error)) throw error;

    const hostname = (SRV_URI_RE.exec(validated) || [])[2] || 'the cluster';
    onNotice(
      `DNS lookup for ${hostname} failed (${describeDnsError(error)}). ` +
        'Retrying through public DNS…'
    );

    let fallback;
    try {
      fallback = await buildSeedListUri(validated);
    } catch (dnsError) {
      throw new Error(srvHelpMessage(hostname, error, dnsError));
    }

    onNotice(
      `Resolved ${fallback.hostCount} cluster host(s) via ${fallback.resolver}; ` +
        'connecting to them directly.'
    );
    return runWithUri(fallback.uri, fn);
  }
}

/** What server is on the other end of an open client. */
async function describeServer(client, uri) {
  const admin = client.db('admin');
  const [buildInfo, helloResult] = await Promise.all([
    admin.command({ buildInfo: 1 }).catch(() => ({})),
    admin.command({ hello: 1 }).catch(() => ({})),
  ]);

  let topology = 'standalone';
  if (helloResult.msg === 'isdbgrid') topology = 'sharded cluster';
  else if (helloResult.setName) topology = `replica set "${helloResult.setName}"`;

  return {
    ok: true,
    serverVersion: buildInfo.version || 'unknown',
    topology,
    defaultDatabase: databaseFromUri(uri),
  };
}

/** Databases visible to an open client, minus the server's own bookkeeping. */
async function readDatabases(client, uri) {
  try {
    const result = await client.db('admin').admin().listDatabases({ nameOnly: false });
    return (result.databases || [])
      .filter((db) => !['admin', 'local', 'config'].includes(db.name))
      .map((db) => ({ name: db.name, sizeOnDisk: db.sizeOnDisk || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    // Users scoped to a single database cannot run listDatabases.
    const fallback = databaseFromUri(uri);
    if (fallback) return [{ name: fallback, sizeOnDisk: 0, restricted: true }];
    throw new Error(
      `Unable to list databases (${error.message}). Enter the database name manually.`
    );
  }
}

/** Ping the server and report what we are connected to. */
async function testConnection(uri) {
  const notices = [];
  const result = await withClient(uri, (client) => describeServer(client, uri), {
    onNotice: (message) => notices.push(message),
  });

  return { ...result, notices };
}

/**
 * Identify the server and list its databases over a single connection.
 *
 * Selecting a saved connection wants both answers at once; doing it with one
 * client rather than calling testConnection and listDatabases in turn halves the
 * wait, which is very visible against Atlas where each connect carries an SRV
 * lookup and a TLS handshake.
 */
async function surveyConnection(uri) {
  const notices = [];
  const result = await withClient(
    uri,
    async (client) => {
      const server = await describeServer(client, uri);
      const databases = await readDatabases(client, uri).catch(() => []);
      return { ...server, databases };
    },
    { onNotice: (message) => notices.push(message) }
  );

  return { ...result, notices };
}

/** List databases the credentials can see. Falls back gracefully on restricted users. */
async function listDatabases(uri) {
  return withClient(uri, (client) => readDatabases(client, uri));
}

/** List collections plus fast estimated counts, used to size up a backup. */
async function listCollections(uri, database) {
  const dbName = validateDatabaseName(database);
  return withClient(uri, async (client) => {
    const db = client.db(dbName);
    const infos = await db.listCollections({}, { nameOnly: false }).toArray();

    const visible = infos.filter((info) => !info.name.startsWith('system.'));
    const results = await Promise.all(
      visible.map(async (info) => {
        let documents = null;
        let bytes = null;

        if (info.type !== 'view') {
          // $collStats answers both questions in one round trip, so knowing the
          // size costs nothing over knowing the count. It is not universally
          // available though — some shared Atlas tiers and restricted roles
          // refuse it — so a failure falls back to the count alone rather than
          // leaving the collection unlisted.
          const stats = await db
            .collection(info.name)
            .aggregate([{ $collStats: { storageStats: {} } }])
            .next()
            .catch(() => null);

          if (stats && stats.storageStats) {
            documents = Number(stats.storageStats.count);
            bytes = Number(stats.storageStats.size);
            if (!Number.isFinite(documents)) documents = null;
            if (!Number.isFinite(bytes)) bytes = null;
          } else {
            documents = await db
              .collection(info.name)
              .estimatedDocumentCount()
              .catch(() => null);
          }
        }

        return {
          name: info.name,
          type: info.type || 'collection',
          documents,
          bytes,
        };
      })
    );

    return results.sort((a, b) => a.name.localeCompare(b.name));
  });
}

module.exports = {
  DEFAULT_CLIENT_OPTIONS,
  buildSeedListUri,
  composeSeedListUri,
  databaseFromUri,
  isSrvLookupError,
  listCollections,
  listDatabases,
  surveyConnection,
  testConnection,
  validateDatabaseName,
  validateUri,
  withClient,
};
