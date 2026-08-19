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
async function runBackup(request, ctx) {
  const startedAt = Date.now();
  const uri = validateUri(request.uri);
  const database = validateDatabaseName(request.database, 'Source database');

  if (!request.outputDir || !String(request.outputDir).trim()) {
    throw new Error('Choose an output folder for the backup.');
  }

  const options = {
    gzip: Boolean(request.gzip),
    batchSize: Number(request.batchSize) > 0 ? Number(request.batchSize) : 1000,
    includeCollections: Array.isArray(request.includeCollections) ? request.includeCollections : null,
  };

  const runFolder = path.join(
    path.resolve(String(request.outputDir).trim()),
    `${database}_${timestampSlug(new Date(startedAt))}`
  );

  const onNotice = (message) => ctx.log('warn', message);

  return withClient(uri, async (client) => {
    const db = client.db(database);

    const buildInfo = await client.db('admin').command({ buildInfo: 1 }).catch(() => ({}));
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

    await fsp.mkdir(runFolder, { recursive: true });

    ctx.log('info', `Server ${buildInfo.version || 'unknown'} — backing up "${database}".`);
    ctx.log('info', `Destination: ${runFolder}`);
    ctx.log(
      'info',
      `${infos.length} collection(s) selected${options.gzip ? ', gzip compression on' : ''}.`
    );
    ctx.plan(
      infos.map((info) => ({
        name: info.name,
        type: info.type || 'collection',
        estimatedDocuments: info.estimatedDocuments,
      }))
    );

    const results = [];
    let totalDocuments = 0;
    let totalBytes = 0;

    for (let index = 0; index < infos.length; index += 1) {
      const info = infos[index];
      if (ctx.isCancelled()) throw new CancelledError();

      ctx.collection({ name: info.name, status: 'running', index, total: infos.length });

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
        path.join(runFolder, `${fileBase}.metadata.json`),
        EJSON.stringify(buildMetadata(info, indexes), { relaxed: false }),
        'utf8'
      );

      let stats = { documents: 0, bytes: 0 };
      if (isView) {
        ctx.log('info', `${info.name}: view definition saved (no documents to copy).`);
      } else {
        const dataFile = path.join(runFolder, `${fileBase}.bson${options.gzip ? '.gz' : ''}`);
        stats = await dumpCollectionData(db, info, dataFile, options, ctx);
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

      ctx.collection({
        ...result,
        status: 'done',
        index,
        total: infos.length,
      });
      ctx.log(
        'success',
        `${info.name}: ${stats.documents.toLocaleString()} document(s), ${formatBytes(stats.bytes)}` +
          `${indexes.length ? `, ${indexes.length} index definition(s)` : ''}.`
      );
    }

    const summary = {
      kind: 'backup',
      tool: TOOL_NAME,
      formatVersion: 1,
      format: 'mongodump-compatible-directory',
      createdAt: new Date(startedAt).toISOString(),
      serverVersion: buildInfo.version || null,
      sourceDatabase: database,
      gzip: options.gzip,
      outputFolder: runFolder,
      collections: results,
      totals: {
        collections: results.length,
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
      `Backup complete — ${results.length} collection(s), ${totalDocuments.toLocaleString()} ` +
        `document(s), ${formatBytes(totalBytes)} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`
    );

    return summary;
  }, { onNotice });
}

module.exports = { MANIFEST_FILE, runBackup };
