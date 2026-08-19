'use strict';

/**
 * Tests the SRV/DNS fallback that keeps "mongodb+srv://" working on networks
 * whose DNS refuses SRV queries (the "querySrv ECONNREFUSED" failure).
 *
 *   node scripts/srv-test.js [srv-hostname]
 *
 * The URI-composition checks are pure and always run. If a cluster hostname is
 * given (or MBR_SRV_HOST is set) the live checks also run: they point Node's
 * resolver at a black hole to force the system lookup to fail, then confirm the
 * fallback resolves the cluster anyway.
 */

const dns = require('dns');
const {
  composeSeedListUri,
  isSrvLookupError,
  buildSeedListUri,
} = require('../src/main/mongo');
const { describeError, redactUri } = require('../src/main/util');

const LIVE_HOST = process.argv[2] || process.env.MBR_SRV_HOST || '';

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

const RECORDS = [
  { name: 'shard-00-00.abc123.mongodb.net', port: 27017 },
  { name: 'shard-00-01.abc123.mongodb.net', port: 27017 },
  { name: 'shard-00-02.abc123.mongodb.net', port: 27017 },
];
const PARTS = {
  credentials: 'user:p%40ssword',
  hostname: 'cluster0.abc123.mongodb.net',
  databasePath: null,
  query: null,
};

console.log('── seed-list URI composition ──');

{
  const uri = composeSeedListUri(PARTS, RECORDS, 'authSource=admin&replicaSet=atlas-x-shard-0');
  check(
    'lists every SRV host with its port',
    RECORDS.every((record) => uri.includes(`${record.name}:27017`)) &&
      uri.startsWith('mongodb://user:p%40ssword@'),
    uri
  );
  check('keeps percent-encoded credentials untouched', uri.includes('user:p%40ssword@'), uri);
  check('carries the TXT options through', uri.includes('authSource=admin') && uri.includes('replicaSet=atlas-x-shard-0'), uri);
  check('adds tls=true, since +srv implies TLS', /[?&]tls=true/.test(uri), uri);
  check('is not an srv URI any more', uri.startsWith('mongodb://'), uri);
}

{
  // A TXT record may only supply authSource/replicaSet/loadBalanced. Anything
  // else it claims — notably tls=false — must be ignored.
  const uri = composeSeedListUri(PARTS, RECORDS, 'authSource=admin&tls=false&directConnection=true');
  check('ignores options a TXT record is not allowed to set', !uri.includes('directConnection'), uri);
  check('a TXT record cannot turn TLS off', /[?&]tls=true/.test(uri), uri);
}

{
  const uri = composeSeedListUri(
    { ...PARTS, query: '?authSource=$external&retryWrites=false' },
    RECORDS,
    'authSource=admin&replicaSet=rs0'
  );
  check(
    'options in the URI override the TXT defaults',
    uri.includes('authSource=%24external') && uri.includes('retryWrites=false'),
    uri
  );
  check('TXT options absent from the URI are still applied', uri.includes('replicaSet=rs0'), uri);
}

{
  const uri = composeSeedListUri({ ...PARTS, databasePath: '/analytics' }, RECORDS, '');
  check('preserves the database in the path', uri.includes('/analytics?'), uri);
}

{
  const uri = composeSeedListUri({ ...PARTS, query: '?ssl=true' }, RECORDS, '');
  check('does not add tls when ssl is already given', !uri.includes('tls='), uri);
}

{
  let message = null;
  try {
    composeSeedListUri(PARTS, [{ name: 'evil.attacker.example', port: 27017 }], '');
  } catch (error) {
    message = error.message;
  }
  check(
    'rejects an SRV host outside the cluster domain',
    Boolean(message) && /outside/.test(message),
    message || 'no error thrown'
  );
}

{
  let message = null;
  try {
    composeSeedListUri(PARTS, [], '');
  } catch (error) {
    message = error.message;
  }
  check('rejects an empty SRV answer', Boolean(message), message || 'no error thrown');
}

console.log('\n── DNS error classification ──');
check(
  'recognises the querySrv ECONNREFUSED failure',
  isSrvLookupError(
    Object.assign(new Error('querySrv ECONNREFUSED _mongodb._tcp.cluster0.x.mongodb.net'), {
      code: 'ECONNREFUSED',
    })
  )
);
check('recognises a DNS timeout', isSrvLookupError(Object.assign(new Error('x'), { code: 'ETIMEOUT' })));
check(
  'does not treat an auth failure as a DNS problem',
  !isSrvLookupError(Object.assign(new Error('Authentication failed.'), { code: 8000 }))
);
check('does not treat a plain error as a DNS problem', !isSrvLookupError(new Error('boom')));

console.log('');
console.log('── credential redaction ──');
{
  // The activity log can be saved and shared, so nothing that reaches it may
  // carry a password.
  const cases = [
    'mongodb+srv://adrian:HunTer2Secret@cluster0.abc.mongodb.net/',
    'connect failed: mongodb://root:p%40ssw0rd@10.0.0.5:27017/admin?tls=true',
    'two at once mongodb://a:SECRET1@h1/ and mongodb+srv://b:SECRET2@h2/',
  ];
  for (const raw of cases) {
    const clean = redactUri(raw);
    check(
      `password removed from: ${raw.slice(0, 34)}...`,
      !/HunTer2Secret|p%40ssw0rd|SECRET1|SECRET2/.test(clean) && clean.includes(':****@'),
      clean
    );
  }
  check(
    'the username and host survive redaction',
    redactUri(cases[0]) === 'mongodb+srv://adrian:****@cluster0.abc.mongodb.net/',
    redactUri(cases[0])
  );
  check(
    'errors surfaced to the UI are redacted too',
    !describeError(new Error(cases[0])).includes('HunTer2Secret'),
    describeError(new Error(cases[0]))
  );
  check('redaction leaves ordinary text alone', redactUri('nothing to see') === 'nothing to see');
}

if (!LIVE_HOST) {
  console.log('\n── live fallback ──');
  console.log('  SKIPPED — pass a cluster hostname or set MBR_SRV_HOST to run this.');
} else {
  const realServers = dns.getServers();
  (async () => {
    console.log('\n── live fallback ──');
    try {
      // Force the system lookup to fail exactly as it did on the user's router.
      dns.setServers(['127.0.0.1']);

      let systemError = null;
      try {
        await dns.promises.resolveSrv(`_mongodb._tcp.${LIVE_HOST}`);
      } catch (error) {
        systemError = error;
      }
      check(
        'system DNS now fails, reproducing the reported error',
        systemError !== null && isSrvLookupError(systemError),
        systemError ? systemError.code : 'lookup unexpectedly succeeded'
      );

      const fallback = await buildSeedListUri(`mongodb+srv://user:pw@${LIVE_HOST}/`);
      check(
        `fallback resolved ${fallback.hostCount} host(s) via ${fallback.resolver}`,
        fallback.hostCount > 0 && fallback.uri.startsWith('mongodb://'),
        fallback.uri.replace(/\/\/[^@]*@/, '//***@')
      );
      check(
        'fallback URI enables TLS',
        /[?&](tls=true|ssl=true)/.test(fallback.uri),
        fallback.uri.replace(/\/\/[^@]*@/, '//***@')
      );
    } catch (error) {
      check('live fallback ran', false, error.message);
    } finally {
      dns.setServers(realServers);
    }
    report();
  })();
  return;
}

report();

function report() {
  console.log(
    failures === 0 ? `\nAll ${checks} checks passed.` : `\n${failures} of ${checks} checks FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}
