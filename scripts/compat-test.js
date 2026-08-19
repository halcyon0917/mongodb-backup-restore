'use strict';

/**
 * Cross-compatibility check against the official MongoDB Database Tools:
 *
 *   node scripts/compat-test.js [uri]
 *
 *   1. our backup   -> mongorestore  (our dumps stay usable without this app)
 *   2. mongodump    -> our restore   (we can read dumps made by the CLI)
 *
 * Index definitions are the interesting part: mongodump writes metadata.json as
 * canonical Extended JSON, so index keys arrive as {"field":{"$numberInt":"1"}}
 * and must be parsed as EJSON, not plain JSON.
 *
 * Skipped with a notice if mongodump/mongorestore are not on PATH.
 */

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { MongoClient, Int32 } = require('mongodb');

const { runBackup } = require('../src/main/backup');
const { runRestore, inspectBackup } = require('../src/main/restore');

const URI = process.argv[2] || 'mongodb://127.0.0.1:27017';
const SOURCE_DB = 'mbr_compat_source';
const VIA_CLI_DB = 'mbr_compat_via_mongorestore';
const VIA_APP_DB = 'mbr_compat_via_app';

const EXPECTED_INDEXES = ['_id_', 'compound_idx', 'label_idx', 'partial_idx'];
const DOC_COUNT = 120;

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const ctx = {
  isCancelled: () => false,
  log: (level, message) => {
    if (level === 'error' || level === 'warn') console.log(`        [${level}] ${message}`);
  },
  plan: () => {},
  collection: () => {},
  progress: () => {},
};

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}`, error });
    });
  });
}

async function toolAvailable(name) {
  const result = await run(name, ['--version']);
  return result.ok;
}

async function seed(client) {
  const db = client.db(SOURCE_DB);
  await db.dropDatabase();

  const documents = Array.from({ length: DOC_COUNT }, (_, index) => ({
    _id: index,
    n: new Int32(index),
    label: `widget ${index}`,
    when: new Date(Date.UTC(2026, 0, 1 + (index % 28))),
  }));
  await db.collection('widgets').insertMany(documents);

  await db.collection('widgets').createIndex({ label: 1 }, { name: 'label_idx' });
  await db.collection('widgets').createIndex({ n: -1, label: 1 }, { name: 'compound_idx' });
  await db
    .collection('widgets')
    .createIndex({ when: 1 }, { name: 'partial_idx', partialFilterExpression: { n: { $gt: 5 } } });
}

async function describe(client, database) {
  const db = client.db(database);
  const documents = await db.collection('widgets').countDocuments();
  const indexes = (await db.collection('widgets').listIndexes().toArray())
    .map((index) => index.name)
    .sort();
  const sample = await db.collection('widgets').findOne({ _id: 7 });
  return { documents, indexes, sample };
}

async function main() {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mbr-compat-'));
  console.log(`Server:  ${URI}`);
  console.log(`Scratch: ${workDir}`);

  const [hasDump, hasRestore] = await Promise.all([
    toolAvailable('mongodump'),
    toolAvailable('mongorestore'),
  ]);
  if (!hasDump || !hasRestore) {
    console.log('\nSKIPPED — mongodump/mongorestore not found on PATH.');
    console.log('The app does not need them; this test only proves format compatibility.');
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return process.exit(0);
  }

  const client = new MongoClient(URI);
  try {
    await client.connect();
    await seed(client);

    /* ── 1. our backup, restored by the official mongorestore ── */
    console.log('\n── our backup -> mongorestore ──');
    const backup = await runBackup(
      { uri: URI, database: SOURCE_DB, outputDir: workDir },
      ctx
    );

    await client.db(VIA_CLI_DB).dropDatabase();
    // --dir points at a single database's dump folder, so the namespace has no
    // database component for --nsFrom to match; --db names the target directly.
    const restored = await run('mongorestore', [
      `--uri=${URI}`,
      `--db=${VIA_CLI_DB}`,
      '--drop',
      `--dir=${backup.outputFolder}`,
    ]);
    check('mongorestore accepts our dump folder', restored.ok, restored.output.slice(-400));

    const viaCli = await describe(client, VIA_CLI_DB);
    check(
      `mongorestore loaded all ${DOC_COUNT} documents`,
      viaCli.documents === DOC_COUNT,
      `got ${viaCli.documents}`
    );
    check(
      'mongorestore rebuilt every index from our metadata',
      JSON.stringify(viaCli.indexes) === JSON.stringify(EXPECTED_INDEXES),
      `got [${viaCli.indexes}]`
    );
    check(
      'document types survived the trip through mongorestore',
      viaCli.sample && viaCli.sample.label === 'widget 7' && viaCli.sample.when instanceof Date,
      JSON.stringify(viaCli.sample)
    );

    /* ── 2. a real mongodump, restored by us ── */
    console.log('\n── mongodump -> our restore ──');
    const dumpRoot = path.join(workDir, 'cli-dump');
    const dumped = await run('mongodump', [
      `--uri=${URI}`,
      `--db=${SOURCE_DB}`,
      `--out=${dumpRoot}`,
    ]);
    check('mongodump produced a dump', dumped.ok, dumped.output.slice(-300));

    const inspection = await inspectBackup(dumpRoot);
    check(
      'we detect the database inside a mongodump root folder',
      inspection.databases.length === 1 && inspection.databases[0].name === SOURCE_DB,
      inspection.databases.map((database) => database.name).join(', ')
    );

    await client.db(VIA_APP_DB).dropDatabase();
    const summary = await runRestore(
      { uri: URI, sourceDir: dumpRoot, targetDatabase: VIA_APP_DB, drop: true },
      ctx
    );
    check(
      `we restored all ${DOC_COUNT} documents from the CLI dump`,
      summary.totals.documents === DOC_COUNT,
      `got ${summary.totals.documents}`
    );

    const viaApp = await describe(client, VIA_APP_DB);
    check(
      'we rebuilt every index from mongodump Extended JSON metadata',
      JSON.stringify(viaApp.indexes) === JSON.stringify(EXPECTED_INDEXES),
      `got [${viaApp.indexes}]`
    );
    check(
      'the partial index kept its filter expression',
      await client
        .db(VIA_APP_DB)
        .collection('widgets')
        .listIndexes()
        .toArray()
        .then((indexes) =>
          indexes.some(
            (index) => index.name === 'partial_idx' && index.partialFilterExpression
          )
        ),
      'partialFilterExpression missing'
    );
  } finally {
    for (const database of [SOURCE_DB, VIA_CLI_DB, VIA_APP_DB]) {
      await client.db(database).dropDatabase().catch(() => {});
    }
    await client.close().catch(() => {});
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures === 0 ? '\nCompatibility checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nCompatibility test crashed:', error);
  process.exit(1);
});
