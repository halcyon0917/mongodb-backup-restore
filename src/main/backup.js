'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { BSON, EJSON } = require('bson');

const { encodeCollectionFileName, openBsonWriter } = require('./bsonio');
const { CancelledError, formatBytes, throttle, timestampSlug } = require('./util');
const { validateDatabaseName, validateUri, withClient } = require('./mongo');

const TOOL_NAME = 'MongoDB Backup and Restore';
const MANIFEST_FILE = 'backup-manifest.json';

/** Build the metadata.json payload mongorestore (and our own restore) reads. */
function buildMetadata(info, indexes) {
  const options = { ...(info.options || {}) };
  return {
    options,
    indexes: indexes.map((index) => {
      const { ns, ...rest } = index; // "ns" is legacy and rejected by newer servers
      return rest;
    }),
    uuid: info.info && info.info.uuid ? info.info.uuid.toString('hex') : undefined,
    collectionName: info.name,
    type: info.type || 'collection',
  };
}

/**
 * Dump one collection's documents to `<name>.bson[.gz]`.
 *
 * Documents are read with `raw: true`, so the driver hands back the exact BSON
 * bytes the server sent. Nothing is deserialised, which makes the dump
 * byte-faithful (every numeric type, Decimal128, Binary subtype and key order
 * survives) and avoids a pointless decode/encode round trip.
 */
async function dumpCollectionData(db, info, filePath, options, ctx) {
  const writer = openBsonWriter(filePath, { gzip: options.gzip });
  const collection = db.collection(info.name);

  let documents = 0;
  let bytes = 0;
  let fellBackToSerialize = false;

  const report = throttle(() => {
    ctx.progress({
      collection: info.name,
      documents,
      bytes,
      estimatedTotal: info.estimatedDocuments,
    });
  }, 200);

  // Natural order, like mongodump: for a capped collection that order is the
  // data's meaning, and sorting by _id would silently rearrange it.
  const cursor = collection.find({}, { raw: true, batchSize: options.batchSize });

  try {
    for await (const document of cursor) {
      if (ctx.isCancelled()) throw new CancelledError();

      let chunk = document;
      if (!Buffer.isBuffer(chunk)) {
        // Defensive: if a driver build ignores `raw`, re-encode the document.
        chunk = BSON.serialize(chunk);
        fellBackToSerialize = true;
      }

      await writer.write(chunk);
      documents += 1;
      bytes += chunk.length;
      report();
    }

    await writer.close();
  } catch (error) {
    await writer.abort();
    throw error;
  } finally {
    await cursor.close().catch(() => {});
    report.flush();
  }

  if (fellBackToSerialize) {
    ctx.log('warn', `${info.name}: raw BSON passthrough unavailable, documents were re-encoded.`);
  }

  return { documents, bytes };
}

/**
 * Back up a single database into `<outputDir>/<database>_<timestamp>/`.
 *
 * The layout is mongodump's directory format, so the result can also be
 * restored with: mongorestore --uri "..." --db target --dir "<folder>"
 */
/**
 * Dump every collection of one database into `folder`.
 *
 * `unit` decides who progress is reported against. Backing up a single database
 * reports per collection, which is what the Collections card shows. Backing up
 * several reports against the database as a whole, because the card then lists
 * databases rather than collections and there is nowhere to put a row per
 * collection — the log still names every one.
 */
async function dumpDatabase(client, database, folder, options, ctx, unit) {
  const db = client.db(database);
  const allInfos = await db.listCollections({}, { nameOnly: false }).toArray();

  let infos = allInfos.filter((info) => !info.name.startsWith('system.'));
  if (options.includeCollections && options.includeCollections.length > 0) {
    const wanted = new Set(options.includeCollections);
    infos = infos.filter((info) => wanted.has(info.name));

    const missing = options.includeCollections.filter(
      (name) => !infos.some((info) => info.name === name)
    );
    if (missing.length > 0) {
      throw new Error(`These collections do not exist in "${database}": ${missing.join(', ')}`);
    }
  }
  infos.sort((a, b) => a.name.localeCompare(b.name));

  if (infos.length === 0) {
    throw new Error(
      `Database "${database}" has no collections to back up. ` +
        'Check the database name — MongoDB does not report an error for a name that does not exist.'
    );
  }

  // Estimated counts drive the progress bars; they are cheap metadata reads.
  for (const info of infos) {
    info.estimatedDocuments =
      info.type === 'view'
        ? 0
        : await db.collection(info.name).estimatedDocumentCount().catch(() => null);
  }

  await fsp.mkdir(folder, { recursive: true });

  if (!unit) {
    ctx.plan(
      infos.map((info) => ({
        name: info.name,
        type: info.type || 'collection',
        estimatedDocuments: info.estimatedDocuments,
      }))
    );
  }

  // In unit mode the whole database is one bar, so its fraction comes from how
  // many of its documents have been written so far.
  const expected = infos.reduce((total, info) => total + (info.estimatedDocuments || 0), 0);

  const results = [];
  let totalDocuments = 0;
  let totalBytes = 0;

  for (let index = 0; index < infos.length; index += 1) {
    const info = infos[index];
    if (ctx.isCancelled()) throw new CancelledError();

    if (!unit) {
      ctx.collection({ name: info.name, status: 'running', index, total: infos.length });
    }

    const fileBase = encodeCollectionFileName(info.name);
    const isView = (info.type || 'collection') === 'view';

    let indexes = [];
    if (!isView) {
      indexes = await db
        .collection(info.name)
        .listIndexes()
        .toArray()
        .catch((error) => {
          ctx.log('warn', `${info.name}: could not read indexes (${error.message}).`);
          return [];
        });
    }

    // Canonical Extended JSON, byte-for-byte the dialect mongodump writes.
    // Plain JSON.stringify would flatten BSON types inside collection options
    // (a validator's Decimal128, a Long TTL) into meaningless objects.
    await fsp.writeFile(
      path.join(folder, `${fileBase}.metadata.json`),
      EJSON.stringify(buildMetadata(info, indexes), { relaxed: false }),
      'utf8'
    );

    let stats = { documents: 0, bytes: 0 };
    if (isView) {
      ctx.log('info', `${info.name}: view definition saved (no documents to copy).`);
    } else {
      const dataFile = path.join(folder, `${fileBase}.bson${options.gzip ? '.gz' : ''}`);
      stats = await dumpCollectionData(db, info, dataFile, options, unit ? {
        ...ctx,
        // Roll this collection's progress into the database's single bar.
        progress: (payload) =>
          ctx.progress({
            collection: unit.name,
            documents: totalDocuments + (payload.documents || 0),
            estimatedTotal: expected,
          }),
      } : ctx);
    }

    totalDocuments += stats.documents;
    totalBytes += stats.bytes;

    const result = {
      name: info.name,
      type: info.type || 'collection',
      file: isView ? null : `${fileBase}.bson${options.gzip ? '.gz' : ''}`,
      documents: stats.documents,
      bytes: stats.bytes,
      indexes: indexes.length,
    };
    results.push(result);

    if (!unit) {
      ctx.collection({ ...result, status: 'done', index, total: infos.length });
    }

    ctx.log(
      'success',
      `${info.name}: ${stats.documents.toLocaleString()} document(s), ${formatBytes(stats.bytes)}` +
        `${indexes.length ? `, ${indexes.length} index definition(s)` : ''}.`
    );
  }

  return { collections: results, documents: totalDocuments, bytes: totalBytes };
}

/**
 * A folder name nothing is using yet.
 *
 * The stamp is only accurate to the second, so two runs started in the same
 * second would otherwise share a folder: the second run's manifest would land
 * beside the first run's files and describe a backup that is not what is there.
 */
async function uniqueFolder(preferred) {
  let candidate = preferred;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const taken = await fsp
      .stat(candidate)
      .then(() => true)
      .catch(() => false);
    if (!taken) return candidate;
    candidate = `${preferred}-${suffix}`;
  }
  throw new Error(`Too many backups already exist at ${preferred}.`);
}

/** The databases a request asks for, tolerating the older single-name shape. */
function requestedDatabases(request) {
  const list = Array.isArray(request.databases) && request.databases.length > 0
    ? request.databases
    : [request.database];
  const names = list
    .map((name) => validateDatabaseName(name, 'Source database'))
    .filter((name, index, all) => all.indexOf(name) === index);
  if (names.length === 0) throw new Error('Choose at least one database to back up.');
  return names;
}

async function runBackup(request, ctx) {
  const startedAt = Date.now();
  const uri = validateUri(request.uri);
  const databases = requestedDatabases(request);

  if (!request.outputDir || !String(request.outputDir).trim()) {
    throw new Error('Choose an output folder for the backup.');
  }

  const options = {
    gzip: Boolean(request.gzip),
    batchSize: Number(request.batchSize) > 0 ? Number(request.batchSize) : 1000,
    includeCollections: null,
  };

  /**
   * Which collections to take from one database.
   *
   * `selections` carries a list per database, so a run can take everything from
   * one and a handful from another. `includeCollections` is the older
   * single-database shape and still works on its own.
   */
  const includeFor = (database) => {
    if (request.selections && Object.prototype.hasOwnProperty.call(request.selections, database)) {
      const chosen = request.selections[database];
      return Array.isArray(chosen) ? chosen : null;
    }
    if (databases.length === 1 && Array.isArray(request.includeCollections)) {
      return request.includeCollections;
    }
    return null;
  };

  const stamp = timestampSlug(new Date(startedAt));
  const outputRoot = path.resolve(String(request.outputDir).trim());

  // One database keeps the layout it has always had. Several go into one run
  // folder with a subfolder each — which is exactly mongodump's own root
  // layout, so the whole set restores together, here and with mongorestore.
  const runFolder = await uniqueFolder(
    path.join(outputRoot, databases.length === 1 ? `${databases[0]}_${stamp}` : `backup_${stamp}`)
  );

  const onNotice = (message) => ctx.log('warn', message);

  return withClient(uri, async (client) => {
    const buildInfo = await client.db('admin').command({ buildInfo: 1 }).catch(() => ({}));

    ctx.log(
      'info',
      `Server ${buildInfo.version || 'unknown'} — backing up ` +
        (databases.length === 1
          ? `"${databases[0]}".`
          : `${databases.length} databases: ${databases.join(', ')}.`)
    );
    ctx.log('info', `Destination: ${runFolder}`);
    if (options.gzip) ctx.log('info', 'gzip compression on.');

    await fsp.mkdir(runFolder, { recursive: true });

    if (databases.length > 1) {
      ctx.plan(databases.map((name) => ({ name, type: 'database', estimatedDocuments: null })));
    }

    const perDatabase = [];
    let totalDocuments = 0;
    let totalBytes = 0;
    let totalCollections = 0;

    for (let index = 0; index < databases.length; index += 1) {
      const database = databases[index];
      if (ctx.isCancelled()) throw new CancelledError();

      const multi = databases.length > 1;
      const folder = multi ? path.join(runFolder, database) : runFolder;
      const unit = multi ? { name: database } : null;

      if (multi) {
        ctx.collection({ name: database, status: 'running', index, total: databases.length });
        ctx.log('info', `— ${database} —`);
      }

      const dumped = await dumpDatabase(
        client,
        database,
        folder,
        { ...options, includeCollections: includeFor(database) },
        ctx,
        unit
      );

      const summary = {
        kind: 'backup',
        tool: TOOL_NAME,
        formatVersion: 1,
        format: 'mongodump-compatible-directory',
        createdAt: new Date(startedAt).toISOString(),
        serverVersion: buildInfo.version || null,
        sourceDatabase: database,
        gzip: options.gzip,
        outputFolder: folder,
        collections: dumped.collections,
        totals: {
          collections: dumped.collections.length,
          documents: dumped.documents,
          bytes: dumped.bytes,
          durationMs: Date.now() - startedAt,
        },
      };

      // Every database folder carries its own manifest, so any one of them can
      // be restored on its own as well as as part of the set.
      await fsp.writeFile(
        path.join(folder, MANIFEST_FILE),
        JSON.stringify(summary, null, 2),
        'utf8'
      );

      perDatabase.push(summary);
      totalDocuments += dumped.documents;
      totalBytes += dumped.bytes;
      totalCollections += dumped.collections.length;

      if (multi) {
        ctx.collection({
          name: database,
          status: 'done',
          index,
          total: databases.length,
          documents: dumped.documents,
          bytes: dumped.bytes,
        });
        ctx.log(
          'success',
          `${database}: ${dumped.collections.length} collection(s), ` +
            `${dumped.documents.toLocaleString()} document(s), ${formatBytes(dumped.bytes)}.`
        );
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (databases.length === 1) {
      ctx.log(
        'success',
        `Backup complete — ${totalCollections} collection(s), ${totalDocuments.toLocaleString()} ` +
          `document(s), ${formatBytes(totalBytes)} in ${elapsed}s.`
      );
      return perDatabase[0];
    }

    const summary = {
      kind: 'backup',
      tool: TOOL_NAME,
      formatVersion: 1,
      format: 'mongodump-compatible-root',
      createdAt: new Date(startedAt).toISOString(),
      serverVersion: buildInfo.version || null,
      sourceDatabases: databases,
      gzip: options.gzip,
      outputFolder: runFolder,
      // Each database carries its own collections, so History can show the run
      // the same way the form did: a row per database, opening onto its own.
      databases: perDatabase.map((entry) => ({
        name: entry.sourceDatabase,
        folder: entry.outputFolder,
        totals: entry.totals,
        collections: entry.collections,
      })),
      // Flattened too: a run's units of work are its databases here, which is
      // what the progress display and the collapsed history row report against.
      collections: perDatabase.map((entry) => ({
        name: entry.sourceDatabase,
        type: 'database',
        documents: entry.totals.documents,
        bytes: entry.totals.bytes,
        indexes: 0,
        status: 'done',
      })),
      totals: {
        databases: databases.length,
        collections: totalCollections,
        documents: totalDocuments,
        bytes: totalBytes,
        durationMs: Date.now() - startedAt,
      },
    };

    await fsp.writeFile(
      path.join(runFolder, MANIFEST_FILE),
      JSON.stringify(summary, null, 2),
      'utf8'
    );

    ctx.log(
      'success',
      `Backup complete — ${databases.length} database(s), ${totalCollections} collection(s), ` +
        `${totalDocuments.toLocaleString()} document(s), ${formatBytes(totalBytes)} in ${elapsed}s.`
    );

    return summary;
  }, { onNotice });
}

module.exports = { MANIFEST_FILE, runBackup };
