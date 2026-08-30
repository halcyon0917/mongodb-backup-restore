'use strict';

/**
 * End-to-end check of the backup and restore engines against a real MongoDB.
 *
 *   node scripts/smoke-test.js [uri]
 *
 * Seeds a source database with awkward BSON types, backs it up, restores it into
 * a second database, then compares the raw BSON bytes of every document plus the
 * index definitions. Both databases are dropped afterwards.
 */

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const {
  Binary,
  BSONRegExp,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} = require('bson');

const { runBackup } = require('../src/main/backup');
const { inspectBackup, runRestore } = require('../src/main/restore');
const { withClient } = require('../src/main/mongo');

const URI = process.argv[2] || 'mongodb://127.0.0.1:27017';
const SOURCE_DB = 'mbr_smoke_source';
const TARGET_DB = 'mbr_smoke_target';
const BULK_DOCS = 2500;

// Collection name that is legal in MongoDB but illegal as a Windows filename,
// exercising the percent-encoding path. Skipped if the server rejects it.
const AWKWARD_NAME = 'odd:name*coll?';

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeContext(prefix) {
  return {
    isCancelled: () => false,
    log: (level, message) => {
      if (level === 'error' || level === 'warn') console.log(`        [${prefix}/${level}] ${message}`);
    },
    plan: () => {},
    collection: () => {},
    progress: () => {},
  };
}

const state = { dataCollections: [], awkwardCreated: false };

async function seed(client) {
  const db = client.db(SOURCE_DB);
  await db.dropDatabase();

  await db.collection('typed').insertMany([
    {
      _id: new ObjectId('64b7f9a2c3d4e5f6a7b8c9d0'),
      label: 'every-type',
      int32: new Int32(42),
      int64: Long.fromString('9007199254740993'), // > 2^53: must not degrade to Double
      double: new Double(3.5),
      wholeDouble: new Double(7), // must not silently become an Int32
      decimal: Decimal128.fromString('123.4567890123456789012345'),
      when: new Date('2026-01-02T03:04:05.678Z'),
      binary: new Binary(Buffer.from('hello world'), 0),
      uuidLike: new Binary(Buffer.alloc(16, 7), 4),
      pattern: new BSONRegExp('^a.*z$', 'im'),
      timestamp: new Timestamp({ t: 1700000000, i: 3 }),
      minKey: new MinKey(),
      maxKey: new MaxKey(),
      nothing: null,
      truthy: true,
      nested: { deep: { deeper: [1, 'two', { three: new Int32(3) }] } },
      emptyArray: [],
      emptyObject: {},
      unicode: 'ñ 中文 🍕 — em dash',
    },
    { _id: new ObjectId(), label: 'sparse-doc' },
  ]);
  await db.collection('typed').createIndex({ label: 1 }, { name: 'label_idx' });

  const bulk = Array.from({ length: BULK_DOCS }, (_, index) => ({
    _id: index,
    n: new Int32(index),
    text: `document number ${index}`,
    tags: ['a', 'b', index % 2 === 0 ? 'even' : 'odd'],
  }));
  await db.collection('items').insertMany(bulk);
  await db.collection('items').createIndex({ n: -1, text: 1 }, { name: 'compound_idx' });
  await db.collection('items').createIndex({ text: 1 }, { name: 'unique_text_idx', unique: true });
  await db
    .collection('items')
    .createIndex({ n: 1 }, { name: 'partial_idx', partialFilterExpression: { n: { $gt: 10 } } });

  await db.createCollection('capped_log', { capped: true, size: 8192, max: 50 });
  await db.collection('capped_log').insertMany([{ line: 'first' }, { line: 'second' }]);

  await db.collection('fs.chunks').insertOne({ _id: new ObjectId(), data: 'chunky' });

  await db.createCollection('even_items', {
    viewOn: 'items',
    pipeline: [{ $match: { tags: 'even' } }],
  });

  try {
    await db.collection(AWKWARD_NAME).insertOne({ _id: 1, note: 'needs filename escaping' });
    state.awkwardCreated = true;
  } catch (error) {
    console.log(`        [seed] server rejected "${AWKWARD_NAME}" (${error.message}); skipping.`);
  }

  state.dataCollections = ['typed', 'items', 'capped_log', 'fs.chunks'];
  if (state.awkwardCreated) state.dataCollections.push(AWKWARD_NAME);
}

async function collectionNames(db) {
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  return infos
    .map((info) => info.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();
}

async function rawDocuments(db, name) {
  const documents = await db
    .collection(name)
    .find({}, { raw: true, sort: { _id: 1 } })
    .toArray();
  return documents.map((document) => Buffer.from(document).toString('base64'));
}

async function indexNames(db, name) {
  const indexes = await db.collection(name).listIndexes().toArray();
  return indexes.map((index) => index.name).sort();
}

async function totalDocuments(db) {
  let total = 0;
  for (const name of state.dataCollections) {
    total += await db.collection(name).countDocuments();
  }
  return total;
}

/** Every document in a database, whatever its collections are called. */
async function countEverything(db) {
  let total = 0;
  for (const name of await collectionNames(db)) {
    total += await db.collection(name).countDocuments();
  }
  return total;
}

async function compare(client, label) {
  const source = client.db(SOURCE_DB);
  const target = client.db(TARGET_DB);

  const [sourceNames, targetNames] = await Promise.all([
    collectionNames(source),
    collectionNames(target),
  ]);
  check(
    `${label}: same collections and views restored`,
    JSON.stringify(sourceNames) === JSON.stringify(targetNames),
    `source=[${sourceNames}] target=[${targetNames}]`
  );

  for (const name of state.dataCollections) {
    const [sourceDocs, targetDocs] = await Promise.all([
      rawDocuments(source, name),
      rawDocuments(target, name),
    ]);
    const mismatch = sourceDocs.findIndex((document, index) => document !== targetDocs[index]);
    check(
      `${label}: "${name}" — ${sourceDocs.length} document(s), byte-identical`,
      sourceDocs.length === targetDocs.length && mismatch === -1,
      `source=${sourceDocs.length} target=${targetDocs.length} firstMismatchIndex=${mismatch}`
    );

    const [sourceIndexes, targetIndexes] = await Promise.all([
      indexNames(source, name),
      indexNames(target, name),
    ]);
    check(
      `${label}: "${name}" indexes [${sourceIndexes}]`,
      JSON.stringify(sourceIndexes) === JSON.stringify(targetIndexes),
      `source=[${sourceIndexes}] target=[${targetIndexes}]`
    );
  }

  const cappedInfo = await target.listCollections({ name: 'capped_log' }).toArray();
  check(
    `${label}: capped_log kept its capped options`,
    Boolean(cappedInfo[0] && cappedInfo[0].options && cappedInfo[0].options.capped),
    JSON.stringify(cappedInfo[0] && cappedInfo[0].options)
  );

  const viewCount = await target.collection('even_items').countDocuments();
  check(
    `${label}: even_items view resolves to ${BULK_DOCS / 2} rows`,
    viewCount === BULK_DOCS / 2,
    `got ${viewCount}`
  );
}

async function runScenario(client, workDir, { gzip }) {
  const label = gzip ? 'gzip' : 'plain';
  console.log(`\n── ${label} round trip ──`);

  const expectedCollections = (await collectionNames(client.db(SOURCE_DB))).length;
  const expectedDocuments = await totalDocuments(client.db(SOURCE_DB));

  const summary = await runBackup(
    { uri: URI, database: SOURCE_DB, outputDir: workDir, gzip },
    makeContext('backup')
  );
  check(
    `${label}: backed up ${expectedCollections} collection(s)`,
    summary.totals.collections === expectedCollections,
    `got ${summary.totals.collections}`
  );
  check(
    `${label}: backed up ${expectedDocuments} document(s)`,
    summary.totals.documents === expectedDocuments,
    `got ${summary.totals.documents}`
  );

  const files = await fsp.readdir(summary.outputFolder);
  check(
    `${label}: data files end in .bson${gzip ? '.gz' : ''}`,
    files.some((file) => file.endsWith(gzip ? '.bson.gz' : '.bson')) &&
      (gzip || !files.some((file) => file.endsWith('.gz'))),
    files.join(', ')
  );

  await client.db(TARGET_DB).dropDatabase();
  const restoreSummary = await runRestore(
    { uri: URI, sourceDir: summary.outputFolder, targetDatabase: TARGET_DB, drop: true },
    makeContext('restore')
  );
  check(
    `${label}: restored ${expectedDocuments} document(s)`,
    restoreSummary.totals.documents === expectedDocuments,
    `got ${restoreSummary.totals.documents}`
  );

  await compare(client, label);
  return summary.outputFolder;
}

async function testRerunModes(client, folder) {
  console.log('\n── restoring over existing data ──');
  const target = client.db(TARGET_DB);
  const expectedDocuments = await totalDocuments(client.db(SOURCE_DB));

  const keep = await runRestore(
    { uri: URI, sourceDir: folder, targetDatabase: TARGET_DB },
    makeContext('restore')
  );
  check(
    'keep mode skips duplicates rather than failing',
    keep.totals.duplicates === expectedDocuments && keep.totals.documents === 0,
    `written=${keep.totals.documents} duplicates=${keep.totals.duplicates}`
  );

  await target.collection('items').updateOne({ _id: 1 }, { $set: { text: 'tampered' } });
  const merge = await runRestore(
    { uri: URI, sourceDir: folder, targetDatabase: TARGET_DB, writeMode: 'upsert' },
    makeContext('restore')
  );
  const repaired = await target.collection('items').findOne({ _id: 1 });
  check(
    'merge mode overwrites an edited document',
    repaired.text === 'document number 1',
    `text="${repaired.text}" written=${merge.totals.documents}`
  );
  check(
    'merge mode did not duplicate rows',
    (await target.collection('items').countDocuments()) === BULK_DOCS,
    `got ${await target.collection('items').countDocuments()}`
  );
}

async function testTargets(client, folder) {
  console.log('\n── selective + renamed restore ──');
  const renamed = 'mbr_smoke_renamed';
  await client.db(renamed).dropDatabase();

  const summary = await runRestore(
    {
      uri: URI,
      sourceDir: folder,
      targetDatabase: renamed,
      includeCollections: ['typed'],
    },
    makeContext('restore')
  );
  const names = await collectionNames(client.db(renamed));
  check(
    'restoring into a different database name copies only the chosen collection',
    summary.totals.collections === 1 && JSON.stringify(names) === JSON.stringify(['typed']),
    `collections=[${names}]`
  );

  const [sourceDocs, renamedDocs] = await Promise.all([
    rawDocuments(client.db(SOURCE_DB), 'typed'),
    rawDocuments(client.db(renamed), 'typed'),
  ]);
  check(
    'renamed-database documents are byte-identical',
    JSON.stringify(sourceDocs) === JSON.stringify(renamedDocs)
  );

  await client.db(renamed).dropDatabase();
}

/**
 * Backing up several databases in one run.
 *
 * The set goes into a single timestamped folder with a subfolder per database,
 * which is mongodump's own root layout — so the whole set has to come back
 * through our own restore, and each database has to be usable on its own too.
 */
async function testMultiDatabase(client, workDir) {
  console.log('\n── multiple databases in one run ──');

  const names = ['mbr_multi_a', 'mbr_multi_b', 'mbr_multi_c'];
  const expected = {};

  for (const [index, name] of names.entries()) {
    await client.db(name).dropDatabase();
    const count = 20 + index * 10;
    await client
      .db(name)
      .collection('items')
      .insertMany(Array.from({ length: count }, (_, n) => ({ _id: n, from: name })));
    await client.db(name).collection('notes').insertMany([{ _id: 1, of: name }]);
    expected[name] = count + 1;
  }

  // Progress is reported per database when there is more than one, because the
  // UI lists databases rather than collections in that mode.
  const units = [];
  const progressUnits = new Set();
  const context = {
    ...makeContext('multi'),
    plan: (entries) => units.push(...entries.map((entry) => entry.name)),
    progress: (payload) => progressUnits.add(payload.collection),
  };

  const summary = await runBackup(
    { uri: URI, databases: names, outputDir: workDir },
    context
  );

  check(
    'a multi-database run reports one unit of work per database',
    JSON.stringify(units) === JSON.stringify(names),
    units.join(', ')
  );
  check(
    'progress is reported against the databases, not their collections',
    [...progressUnits].every((name) => names.includes(name)),
    [...progressUnits].join(', ')
  );
  check(
    'the run folder is one timestamped folder, not one per database',
    path.basename(summary.outputFolder).startsWith('backup_'),
    path.basename(summary.outputFolder)
  );
  check(
    'the summary totals every database',
    summary.totals.databases === 3 &&
      summary.totals.collections === 6 &&
      summary.totals.documents === expected[names[0]] + expected[names[1]] + expected[names[2]],
    JSON.stringify(summary.totals)
  );

  const entries = await fsp.readdir(summary.outputFolder, { withFileTypes: true });
  const subfolders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  check(
    'each database gets its own subfolder',
    JSON.stringify(subfolders) === JSON.stringify(names),
    subfolders.join(', ')
  );

  const perDatabaseFiles = await fsp.readdir(path.join(summary.outputFolder, names[0]));
  check(
    'a subfolder holds that database dump and its own manifest',
    perDatabaseFiles.includes('items.bson') &&
      perDatabaseFiles.includes('items.metadata.json') &&
      perDatabaseFiles.includes('backup-manifest.json'),
    perDatabaseFiles.join(' ')
  );

  // Read back as a set.
  const inspection = await inspectBackup(summary.outputFolder);
  check(
    'the run reads back as one dump root holding every database',
    inspection.databases.length === 3 &&
      JSON.stringify(inspection.databases.map((entry) => entry.name).sort()) ===
        JSON.stringify(names),
    inspection.databases.map((entry) => entry.name).join(', ')
  );

  // And each database restores from it, into a renamed target.
  for (const name of names) {
    const target = `${name}_restored`;
    await client.db(target).dropDatabase();
    await runRestore(
      {
        uri: URI,
        sourceDir: summary.outputFolder,
        sourceDatabase: name,
        targetDatabase: target,
      },
      makeContext('multi-restore')
    );
    // Counted over whatever the target actually holds: the shared
    // totalDocuments() helper walks the main fixture's collection list, which
    // does not include these databases' collections.
    const restored = await countEverything(client.db(target));
    check(
      `"${name}" restores out of the set with all ${expected[name]} documents`,
      restored === expected[name],
      `got ${restored}`
    );
    await client.db(target).dropDatabase();
  }

  // A subfolder on its own is still a complete, restorable backup.
  const alone = await inspectBackup(path.join(summary.outputFolder, names[1]));
  check(
    'one database subfolder still stands alone as a backup',
    alone.databases.length === 1 && alone.databases[0].name === names[1],
    JSON.stringify(alone.databases.map((entry) => entry.name))
  );

  // Selecting collections applies to a single database only; asking for both
  // must not quietly drop collections from the other databases.
  const filtered = await runBackup(
    { uri: URI, databases: names, outputDir: workDir, includeCollections: ['items'] },
    makeContext('multi')
  );
  check(
    'a flat collection filter is ignored for a multi-database run rather than half-applied',
    filtered.totals.collections === 6,
    `got ${filtered.totals.collections} collection(s)`
  );

  // Per-database selection: one collection from the first, everything from the
  // second, and the third left out of the run entirely.
  const picked = await runBackup(
    {
      uri: URI,
      databases: [names[0], names[1]],
      outputDir: workDir,
      selections: { [names[0]]: ['items'], [names[1]]: null },
    },
    makeContext('multi')
  );
  const pickedFolders = await fsp.readdir(picked.outputFolder, { withFileTypes: true });
  const first = await fsp.readdir(path.join(picked.outputFolder, names[0]));

  check(
    'each database can contribute a different set of collections',
    picked.totals.databases === 2 && picked.totals.collections === 3,
    JSON.stringify(picked.totals)
  );
  check(
    'the narrowed database holds only the collection that was asked for',
    first.includes('items.bson') && !first.includes('notes.bson'),
    first.join(' ')
  );
  check(
    'a database left out of the selection is left out of the run',
    pickedFolders
      .filter((entry) => entry.isDirectory())
      .every((entry) => entry.name !== names[2]),
    pickedFolders.map((entry) => entry.name).join(' ')
  );

  // Two runs in the same second must not share a folder, or the second run's
  // manifest would sit beside the first run's files.
  const back = await runBackup({ uri: URI, databases: names, outputDir: workDir }, makeContext('multi'));
  const toBack = await runBackup({ uri: URI, databases: names, outputDir: workDir }, makeContext('multi'));
  check(
    'a second run started in the same second gets its own folder',
    back.outputFolder !== toBack.outputFolder,
    `${path.basename(back.outputFolder)} vs ${path.basename(toBack.outputFolder)}`
  );

  for (const name of names) await client.db(name).dropDatabase();
}

async function testErrors() {
  console.log('\n── error handling ──');

  const cases = [
    ['rejects a non-mongodb URI', { uri: 'http://localhost', database: 'x', outputDir: '.' }],
    ['rejects a missing database name', { uri: URI, database: '', outputDir: '.' }],
    ['rejects a database name with a dot', { uri: URI, database: 'a.b', outputDir: '.' }],
    ['rejects a database that has no collections', { uri: URI, database: 'mbr_no_such_db', outputDir: '.' }],
  ];

  for (const [label, request] of cases) {
    let message = null;
    try {
      await runBackup(request, makeContext('backup'));
    } catch (error) {
      message = error.message;
    }
    check(label, Boolean(message), message ? `message: ${message}` : 'no error thrown');
  }

  let restoreError = null;
  try {
    await runRestore(
      { uri: URI, sourceDir: os.tmpdir(), targetDatabase: 'mbr_smoke_target' },
      makeContext('restore')
    );
  } catch (error) {
    restoreError = error.message;
  }
  check('rejects a folder with no dump files', Boolean(restoreError), restoreError || 'no error');
}

async function main() {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mbr-smoke-'));
  console.log(`Server:  ${URI}`);
  console.log(`Scratch: ${workDir}`);

  try {
    await withClient(URI, async (client) => {
      await seed(client);
      const plainFolder = await runScenario(client, workDir, { gzip: false });
      await runScenario(client, workDir, { gzip: true });
      await testRerunModes(client, plainFolder);
      await testTargets(client, plainFolder);
      await testMultiDatabase(client, workDir);
      await testErrors();

      await client.db(SOURCE_DB).dropDatabase();
      await client.db(TARGET_DB).dropDatabase();
    });
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(
    failures === 0
      ? `\nAll ${checks} checks passed.`
      : `\n${failures} of ${checks} checks FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
