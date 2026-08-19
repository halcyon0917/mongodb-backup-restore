'use strict';

/**
 * Cuts a release: preflight checks, tests, build, tag, then a GitHub release.
 *
 *   npm run release -- --dry-run     # report what would happen, change nothing
 *   npm run release                  # do it
 *   npm run release -- --skip-tests  # when the suite was just run
 *
 * The version comes from package.json — bump it with `npm version` first, which
 * writes the file, commits and tags in one step.
 *
 * The GitHub step needs the `gh` CLI. Without it everything local still runs and
 * the exact manual steps are printed instead, rather than failing the release.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_TESTS = args.includes('--skip-tests');
const SKIP_BUILD = args.includes('--skip-build');

const problems = [];
const notes = [];

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** For probes where failure is a valid answer, e.g. "does this tag exist?". */
function tryGit(...a) {
  try {
    return execFileSync('git', a, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // git's own error text is not a finding
    }).trim();
  } catch {
    return null;
  }
}

function has(command) {
  const probe = spawnSync(command, ['--version'], { shell: true, encoding: 'utf8' });
  return probe.status === 0;
}

/**
 * Run a step, stopping the release if it fails.
 *
 * `shell` matters. With a shell the arguments are re-joined into a single
 * command line, so anything containing a space has to be quoted by hand — an
 * unquoted tag message once split in two and left the version number sitting
 * where git expected a commit. Executables we can invoke directly (git) take
 * shell:false and receive their arguments verbatim; only the .cmd shims on
 * Windows (npm, gh) need a shell, and their spaced arguments are quoted below.
 */
function run(label, command, commandArgs, { shell = false } = {}) {
  console.log(`\n> ${label}`);
  if (DRY_RUN) {
    console.log('  (dry run — skipped)');
    return true;
  }
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', shell });
  if (result.status !== 0) {
    console.error(`\n${label} failed. Release stopped; nothing was tagged or published.`);
    process.exit(1);
  }
  return true;
}

/** The section of CHANGELOG.md for this version, used as the release notes. */
function releaseNotes() {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  const text = fs.readFileSync(changelogPath, 'utf8');
  const heading = new RegExp(`^## \\[?${VERSION.replace(/\./g, '\\.')}\\]?.*$`, 'm');
  const start = text.search(heading);
  if (start === -1) return null;
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next + 1)).trim();
}

console.log(`Releasing ${pkg.name} ${TAG}${DRY_RUN ? '  (dry run)' : ''}\n`);
console.log('Preflight');

// Repository state
const branch = tryGit('branch', '--show-current');
const hasCommits = tryGit('rev-parse', 'HEAD') !== null;
const remote = tryGit('remote', 'get-url', 'origin');
const dirty = tryGit('status', '--porcelain');

if (!hasCommits) problems.push('no commits yet — commit the project before releasing');
else console.log('  ok    repository has commits');

if (branch && branch !== 'main' && branch !== 'master') {
  notes.push(`on branch "${branch}" rather than main — release from main unless deliberate`);
} else if (branch) {
  console.log(`  ok    on branch ${branch}`);
}

if (dirty) {
  problems.push(
    `working tree has uncommitted changes:\n${dirty
      .split('\n')
      .map((l) => '          ' + l)
      .join('\n')}`
  );
} else if (hasCommits) {
  console.log('  ok    working tree is clean');
}

if (!remote) problems.push('no "origin" remote — add the GitHub repository first');
else console.log(`  ok    origin is ${remote}`);

// Version and tag
if (!/^\d+\.\d+\.\d+/.test(VERSION)) problems.push(`version "${VERSION}" is not semver`);
else console.log(`  ok    version ${VERSION}`);

if (tryGit('rev-parse', TAG) !== null) {
  problems.push(`tag ${TAG} already exists — bump the version with "npm version <patch|minor|major>"`);
} else {
  console.log(`  ok    tag ${TAG} is free`);
}

// Release notes
const notesText = releaseNotes();
if (!notesText) problems.push(`CHANGELOG.md has no section for ${VERSION}`);
else console.log(`  ok    CHANGELOG has notes for ${VERSION} (${notesText.split('\n').length} lines)`);

// Optional tooling
const ghReady = has('gh');
if (!ghReady) {
  notes.push('the "gh" CLI is not installed — the GitHub release will have to be made by hand');
} else {
  const auth = spawnSync('gh', ['auth', 'status'], { shell: true, encoding: 'utf8' });
  if (auth.status !== 0) notes.push('"gh" is installed but not signed in — run: gh auth login');
  else console.log('  ok    gh is installed and signed in');
}

for (const note of notes) console.log(`  note  ${note}`);
for (const problem of problems) console.log(`  STOP  ${problem}`);

if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s) must be fixed before releasing.`);
  process.exit(1);
}

// ── Steps ────────────────────────────────────────────────────────────────────

if (!SKIP_TESTS) run('Running the test suite', 'npm', ['test'], { shell: true });
else console.log('\n> Tests skipped by --skip-tests');

if (!SKIP_BUILD) run('Building the Windows artifacts', 'npm', ['run', 'dist'], { shell: true });
else console.log('\n> Build skipped by --skip-build');

const artifacts = [
  `release/${pkg.build.productName} Setup ${VERSION}.exe`,
  `release/MongoDB-Backup-Restore-${VERSION}-portable.exe`,
].map((p) => path.join(ROOT, p));

const missing = artifacts.filter((file) => !fs.existsSync(file));
if (missing.length > 0 && !DRY_RUN) {
  console.error('\nExpected build artifacts are missing:');
  for (const file of missing) console.error('  ' + file);
  process.exit(1);
}

if (!DRY_RUN) {
  for (const file of artifacts) {
    const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(0);
    console.log(`  artifact  ${path.basename(file)}  ${mb} MB`);
  }
}

run(`Tagging ${TAG}`, 'git', ['tag', '-a', TAG, '-m', `${pkg.name} ${TAG}`]);
run(`Pushing ${TAG}`, 'git', ['push', 'origin', TAG]);

const notesFile = path.join(ROOT, 'release', 'RELEASE_NOTES.md');
if (!DRY_RUN) {
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, notesText + '\n', 'utf8');
}

if (ghReady) {
  run(
    'Creating the GitHub release',
    'gh',
    [
      'release',
      'create',
      TAG,
      // Quoted because this call does go through a shell: every one of these
      // paths and titles contains spaces.
      ...artifacts.map((file) => `"${file}"`),
      '--title',
      `"${pkg.build.productName} ${VERSION}"`,
      '--notes-file',
      `"${notesFile}"`,
    ],
    { shell: true }
  );
  console.log(`\nReleased ${TAG}.`);
} else {
  console.log('\nLocal release is ready. Finish on GitHub:');
  console.log(`  1. Open  <your repo>/releases/new?tag=${TAG}`);
  console.log(`  2. Title:  ${pkg.build.productName} ${VERSION}`);
  console.log(`  3. Paste the notes from  ${path.relative(ROOT, notesFile) || 'CHANGELOG.md'}`);
  console.log('  4. Attach these files:');
  for (const file of artifacts) console.log('       ' + file);
  console.log('\nOr install the CLI once and re-run to automate it:  winget install GitHub.cli');
}
