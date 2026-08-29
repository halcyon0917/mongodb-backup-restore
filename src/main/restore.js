'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { BSON, EJSON } = require('bson');

const { decodeCollectionFileName, readBsonDocuments } = require('./bsonio');
const { CancelledError, describeError, throttle } = require('./util');
const { validateDatabaseName, validateUri, withClient } = require('./mongo');

const MANIFEST_FILE = 'backup-manifest.json';

// Keep every BSON type exactly as it was dumped: no int->double coercion, no
// Long->Number narrowing, no Binary->Buffer flattening. The driver re-encodes
// these wrappers to the identical bytes on insert.
const DESERIALIZE_OPTIONS = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
};

// Collection options that no longer exist server-side and must not be replayed.
const UNSUPPORTED_COLLECTION_OPTIONS = new Set(['autoIndexId', 'flags', 'uuid']);
// Index fields the server rejects or ignores when replaying createIndexes.
const STRIPPED_INDEX_FIELDS = new Set(['ns', 'v', 'background']);

const MAX_BATCH_BYTES = 16 * 1024 * 1024;

/** Read our own plain-JSON manifest. */
async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a collection's metadata.json.
 *
 * mongodump writes these as canonical Extended JSON, so an index key arrives as
 * {"label":{"$numberInt":"1"}}. Plain JSON.parse leaves that as a nested object
 * and the server rejects the index with "key pattern cannot be of type object".
 * EJSON.parse in relaxed mode turns it back into a plain 1, and still reads the
 * plain JSON that older dumps may contain.
 */
async function readMetadataIfPresent(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return EJSON.parse(text, { relaxed: true });
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

/** Collect the collections described by the dump files in a single folder. */
async function scanDumpFolder(folderPath) {
  let entries;
  try {
    entries = await fsp.readdir(folderPath, { withFileTypes: true });
  } catch {
    return { collections: [], subfolders: [] };
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const subfolders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  const bases = new Map();
  const baseOf = (fileName) => {
    if (fileName.endsWith('.metadata.json')) return fileName.slice(0, -'.metadata.json'.length);
    if (fileName.endsWith('.bson.gz')) return fileName.slice(0, -'.bson.gz'.length);
    if (fileName.endsWith('.bson')) return fileName.slice(0, -'.bson'.length);
    return null;
  };

  for (const fileName of files) {
    const base = baseOf(fileName);
    if (base === null) continue;
    const record = bases.get(base) || { base, dataFile: null, metadataFile: null, gzip: false };
    if (fileName.endsWith('.metadata.json')) {
      record.metadataFile = fileName;
    } else {
      record.dataFile = fileName;
      record.gzip = fileName.endsWith('.gz');
    }
    bases.set(base, record);
  }

  const collections = [];
  for (const record of bases.values()) {
    const metadata = record.metadataFile
      ? await readMetadataIfPresent(path.join(folderPath, record.metadataFile))
      : null;

    let bytes = 0;
    if (record.dataFile) {
      bytes = await fsp
        .stat(path.join(folderPath, record.dataFile))
        .then((stat) => stat.size)
        .catch(() => 0);
    }

    collections.push({
      name:
        (metadata && metadata.collectionName) || decodeCollectionFileName(record.base),
      type: (metadata && metadata.type) || (record.dataFile ? 'collection' : 'view'),
      dataFile: record.dataFile,
      metadataFile: record.metadataFile,
      gzip: record.gzip,
      bytes,
    });
  }

  collections.sort((a, b) => a.name.localeCompare(b.name));
  return { collections, subfolders };
}

/**
 * Work out what a folder the user picked actually contains.
 *
 * Handles three shapes: a folder of .bson files (one database), a mongodump
 * root with one subfolder per database, and our own timestamped run folders.
 */
async function inspectBackup(folderPath) {
  const root = path.resolve(String(folderPath || '').trim());
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Not a folder: ${root}`);
  }

  const manifest = await readJsonIfPresent(path.join(root, MANIFEST_FILE));
  const { collections, subfolders } = await scanDumpFolder(root);

  const documentCounts = new Map();
  if (manifest && Array.isArray(manifest.collections)) {
    for (const entry of manifest.collections) {
      documentCounts.set(entry.name, entry.documents);
    }
  }

  const databases = [];

  if (collections.length > 0) {
    databases.push({
      name: (manifest && manifest.sourceDatabase) || path.basename(root).replace(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/, ''),
      path: root,
      collections: collections.map((collection) => ({
        ...collection,
        documents: documentCounts.has(collection.name)
          ? documentCounts.get(collection.name)
          : null,
      })),
    });
  } else {
    // A mongodump root: each subfolder is a database.
    for (const subfolder of subfolders) {
      const subPath = path.join(root, subfolder);
      const nested = await scanDumpFolder(subPath);
      if (nested.collections.length === 0) continue;
      const nestedManifest = await readJsonIfPresent(path.join(subPath, MANIFEST_FILE));
      databases.push({
        name: (nestedManifest && nestedManifest.sourceDatabase) || subfolder,
        path: subPath,
        collections: nested.collections,
      });
    }
  }

  if (databases.length === 0) {
    throw new Error(
      'No MongoDB dump files found in that folder. Select the folder that directly contains ' +
        'the .bson files (or a mongodump root with one subfolder per database).'
    );
  }

  return {
    root,
    manifest,
    databases: databases.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Strip options the server will reject before replaying createCollection. */
function sanitiseCollectionOptions(options) {
  const cleaned = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (UNSUPPORTED_COLLECTION_OPTIONS.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function sanitiseIndexSpec(index) {
  const cleaned = {};
  for (const [key, value] of Object.entries(index)) {
    if (STRIPPED_INDEX_FIELDS.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/** Load documents from one .bson file into the target collection. */
async function loadCollectionData(db, collection, filePath, options, ctx) {
  const target = db.collection(collection.name);
  const batchSize = options.batchSize;

  let batch = [];
  let batchBytes = 0;
  let inserted = 0;
  let duplicates = 0;
  let failed = 0;
  let read = 0;
  let fileBytesRead = 0;

  const report = throttle(() => {
    ctx.progress({
      collection: collection.name,
      documents: inserted,
      bytes: fileBytesRead,
      estimatedTotal: collection.documents,
      totalBytes: collection.bytes,
    });
  }, 200);

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const pending = batch;
    batch = [];
    batchBytes = 0;

    try {
      if (options.writeMode === 'upsert') {
        const operations = pending.map((document) => ({
          replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true },
        }));
        const result = await target.bulkWrite(operations, {
          ordered: false,
          bypassDocumentValidation: options.bypassDocumentValidation,
        });
        // Count matched, not modified: a document already identical to the
        // backup reports modifiedCount 0 but was still restored correctly.
        inserted += (result.upsertedCount || 0) + (result.matchedCount || 0);
      } else {
        const result = await target.insertMany(pending, {
          ordered: false,
          bypassDocumentValidation: options.bypassDocumentValidation,
        });
        inserted += result.insertedCount || 0;
      }
    } catch (error) {
      const writeErrors = error.writeErrors || (error.result && error.result.writeErrors) || [];
      const errorList = Array.isArray(writeErrors) ? writeErrors : [writeErrors];
      const insertedCount =
        (error.result && typeof error.result.insertedCount === 'number'
          ? error.result.insertedCount
          : error.insertedCount) || 0;
      inserted += insertedCount;

      if (errorList.length === 0) throw error;

      for (const writeError of errorList) {
        const code = writeError.code || (writeError.err && writeError.err.code);
        if (code === 11000) duplicates += 1;
        else failed += 1;
      }

      if (failed > 0) {
        const first = errorList.find((writeError) => {
          const code = writeError.code || (writeError.err && writeError.err.code);
          return code !== 11000;
        });
        const message = first
          ? (first.errmsg || (first.err && first.err.errmsg) || describeError(first))
          : describeError(error);
        throw new Error(`${collection.name}: write failed — ${message}`);
      }
    }
  };

  for await (const { document, fileBytesRead: bytesSoFar } of readBsonDocuments(filePath, {
    gzip: collection.gzip,
  })) {
    if (ctx.isCancelled()) throw new CancelledError();

    fileBytesRead = bytesSoFar;
    read += 1;
    batch.push(BSON.deserialize(document, DESERIALIZE_OPTIONS));
    batchBytes += document.length;

    if (batch.length >= batchSize || batchBytes >= MAX_BATCH_BYTES) {
      await flushBatch();
      report();
    }
  }

  await flushBatch();
  report.flush();

  return { read, inserted, duplicates };
}

/** Replay the saved index definitions, skipping the implicit _id index. */
async function restoreIndexes(db, collection, metadata, ctx) {
  const indexes = ((metadata && metadata.indexes) || [])
    .filter((index) => index.name !== '_id_')
    .map(sanitiseIndexSpec);

  if (indexes.length === 0) return 0;

  try {
    await db.command({ createIndexes: collection.name, indexes });
    return indexes.length;
  } catch (error) {
    // 85/86 mean an equivalent index already exists under different options.
    if (error.code === 85 || error.code === 86) {
      ctx.log('warn', `${collection.name}: existing index kept — ${describeError(error)}`);
      return 0;
    }
    ctx.log('warn', `${collection.name}: index creation failed — ${describeError(error)}`);
    return 0;
  }
}

/** Restore one dumped database into the target database. */
/**
 * Resolve the collections a request will act on, shared by preview and restore.
 *
 * Views sort last: a view can reference collections that are in the same dump,
 * so the things it selects from have to exist before it is created.
 */
function planCollections(source, includeCollections) {
  let collections = source.collections;
  if (Array.isArray(includeCollections) && includeCollections.length > 0) {
    const wanted = new Set(includeCollections);
    collections = collections.filter((collection) => wanted.has(collection.name));
  }
  return [...collections].sort((a, b) => {
    const aView = a.type === 'view' ? 1 : 0;
    const bView = b.type === 'view' ? 1 : 0;
    return aView - bView || a.name.localeCompare(b.name);
  });
}

/**
 * Report what a restore would do, without writing anything.
 *
 * Only counts are gathered, so this is cheap and safe to run against a live
 * database. Where a number cannot be known without reading every document it is
 * reported as unknown rather than guessed: how many of the backup's documents
 * already exist in the target depends on their _ids, and pretending otherwise
 * would make a preview that lies about the safe modes.
 *
 * Exact for the destructive modes (everything present is deleted, so the
 * deletion count is simply what is there now) and bounded for the others.
 */
async function previewRestore(request) {
  const uri = validateUri(request.uri);
  const targetDatabase = validateDatabaseName(request.targetDatabase, 'Target database');

  const inspection = await inspectBackup(request.sourceDir);
  const sourceName = request.sourceDatabase || inspection.databases[0].name;
  const source =
    inspection.databases.find((database) => database.name === sourceName) ||
    inspection.databases[0];

  const collections = planCollections(source, request.includeCollections);
  if (collections.length === 0) {
    throw new Error('No collections selected to restore.');
  }

  const mode = request.dropDatabase
    ? 'dropDatabase'
    : request.drop
      ? 'drop'
      : request.writeMode === 'upsert'
        ? 'merge'
        : 'keep';

  return withClient(uri, async (client) => {
    const db = client.db(targetDatabase);

    const existingNames = await db
      .listCollections({}, { nameOnly: true })
      .toArray()
      .then((entries) => entries.map((entry) => entry.name))
      .catch(() => []);
    const existing = new Set(existingNames);

    const rows = [];
    for (const collection of collections) {
      const present = existing.has(collection.name);
      const inTarget = present
        ? await db.collection(collection.name).countDocuments().catch(() => null)
        : 0;
      rows.push({
        name: collection.name,
        type: collection.type || 'collection',
        inBackup: typeof collection.documents === 'number' ? collection.documents : null,
        inTarget,
        exists: present,
      });
    }

    // Only "drop the whole database" reaches collections the backup does not
    // mention, and those are the ones nobody expects to lose.
    const planned = new Set(collections.map((collection) => collection.name));
    const untouched = [];
    if (mode === 'dropDatabase') {
      for (const name of existingNames) {
        if (planned.has(name)) continue;
        const documents = await db.collection(name).countDocuments().catch(() => null);
        untouched.push({ name, inTarget: documents });
      }
    }

    return {
      mode,
      targetDatabase,
      sourceDatabase: source.name,
      sourceFolder: source.path,
      targetExists: existingNames.length > 0,
      rows,
      collateralCollections: untouched,
    };
  });
}

async function runRestore(request, ctx) {
  const startedAt = Date.now();
  const uri = validateUri(request.uri);
  const targetDatabase = validateDatabaseName(request.targetDatabase, 'Target database');

  const inspection = await inspectBackup(request.sourceDir);
  const sourceName = request.sourceDatabase || inspection.databases[0].name;
  const source =
    inspection.databases.find((database) => database.name === sourceName) ||
    inspection.databases[0];

  const options = {
    drop: Boolean(request.drop),
    dropDatabase: Boolean(request.dropDatabase),
    withIndexes: request.withIndexes !== false,
    writeMode: request.writeMode === 'upsert' ? 'upsert' : 'insert',
    bypassDocumentValidation: Boolean(request.bypassDocumentValidation),
    batchSize: Number(request.batchSize) > 0 ? Number(request.batchSize) : 1000,
    includeCollections: Array.isArray(request.includeCollections)
      ? request.includeCollections
      : null,
  };

  const collections = planCollections(source, options.includeCollections);
  if (collections.length === 0) {
    throw new Error('No collections selected to restore.');
  }

  const onNotice = (message) => ctx.log('warn', message);

  return withClient(uri, async (client) => {
    const db = client.db(targetDatabase);

    ctx.log('info', `Restoring "${source.name}" from ${source.path}`);
    ctx.log('info', `Target database: "${targetDatabase}" (${collections.length} collection(s)).`);
    if (options.writeMode === 'upsert') {
      ctx.log('info', 'Write mode: merge — existing documents with the same _id are replaced.');
    }

    ctx.plan(
      collections.map((collection) => ({
        name: collection.name,
        type: collection.type,
        estimatedDocuments: collection.documents,
        bytes: collection.bytes,
      }))
    );

    if (options.dropDatabase) {
      await db.dropDatabase();
      ctx.log('warn', `Dropped database "${targetDatabase}" before restoring.`);
    }

    const results = [];
    let totalInserted = 0;
    let totalDuplicates = 0;

    for (let index = 0; index < collections.length; index += 1) {
      const collection = collections[index];
      if (ctx.isCancelled()) throw new CancelledError();

      ctx.collection({ name: collection.name, status: 'running', index, total: collections.length });

      const metadata = collection.metadataFile
        ? await readMetadataIfPresent(path.join(source.path, collection.metadataFile))
        : null;
      const collectionOptions = sanitiseCollectionOptions(metadata && metadata.options);
      const isView = collection.type === 'view' || Boolean(collectionOptions.viewOn);

      if (options.drop && !options.dropDatabase) {
        const dropped = await db
          .collection(collection.name)
          .drop()
          .then(() => true)
          .catch((error) => {
            if (error.code === 26) return false; // NamespaceNotFound
            throw error;
          });
        if (dropped) ctx.log('info', `${collection.name}: dropped existing collection.`);
      }

      if (Object.keys(collectionOptions).length > 0) {
        try {
          await db.createCollection(collection.name, collectionOptions);
        } catch (error) {
          if (error.code !== 48) {
            // 48 = NamespaceExists, which is fine when merging into existing data.
            ctx.log(
              'warn',
              `${collection.name}: could not apply saved collection options — ${describeError(error)}`
            );
          }
        }
      }

      let stats = { read: 0, inserted: 0, duplicates: 0 };
      let indexCount = 0;

      if (isView) {
        ctx.log('info', `${collection.name}: view recreated.`);
      } else {
        if (collection.dataFile) {
          stats = await loadCollectionData(
            db,
            collection,
            path.join(source.path, collection.dataFile),
            options,
            ctx
          );
        } else {
          ctx.log('warn', `${collection.name}: no .bson data file found, metadata only.`);
        }

        if (options.withIndexes) {
          indexCount = await restoreIndexes(db, collection, metadata, ctx);
        }
      }

      totalInserted += stats.inserted;
      totalDuplicates += stats.duplicates;

      const result = {
        name: collection.name,
        type: collection.type,
        documentsRead: stats.read,
        documents: stats.inserted,
        duplicates: stats.duplicates,
        indexes: indexCount,
        bytes: collection.bytes,
      };
      results.push(result);

      ctx.collection({ ...result, status: 'done', index, total: collections.length });

      let message = `${collection.name}: ${stats.inserted.toLocaleString()} document(s) written`;
      if (indexCount > 0) message += `, ${indexCount} index(es) created`;
      if (stats.duplicates > 0) message += `, ${stats.duplicates.toLocaleString()} duplicate(s) skipped`;
      ctx.log(stats.duplicates > 0 ? 'warn' : 'success', `${message}.`);
    }

    if (totalDuplicates > 0) {
      ctx.log(
        'warn',
        `${totalDuplicates.toLocaleString()} document(s) already existed and were skipped. ` +
          'Use "Drop target collections" to replace, or "Merge" write mode to overwrite them.'
      );
    }

    const summary = {
      kind: 'restore',
      sourceDatabase: source.name,
      sourceFolder: source.path,
      targetDatabase,
      collections: results,
      totals: {
        collections: results.length,
        documents: totalInserted,
        duplicates: totalDuplicates,
        durationMs: Date.now() - startedAt,
      },
    };

    ctx.log(
      'success',
      `Restore complete — ${results.length} collection(s), ${totalInserted.toLocaleString()} ` +
        `document(s) into "${targetDatabase}" in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`
    );

    return summary;
  }, { onNotice });
}

module.exports = { inspectBackup, previewRestore, runRestore };
