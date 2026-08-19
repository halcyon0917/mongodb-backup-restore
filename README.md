# MongoDB Backup and Restore

A Windows desktop app for backing up and restoring MongoDB databases. Paste a
connection string, name a database, click a button.

- **Backup** — MongoDB URI + source database → a folder on disk.
- **Restore** — MongoDB URI + a backup folder → target database.

No `mongodump.exe` or `mongorestore.exe` required. The app talks to MongoDB
directly through the official Node.js driver, but writes the **same directory
format mongodump uses**, so backups stay usable with the standard CLI tools and
dumps produced by those tools can be restored here.

Works with local servers, replica sets, sharded clusters, and MongoDB Atlas
(`mongodb://` and `mongodb+srv://`).

---

## Running it

```bash
npm install
```

```bash
npm start
```

### Building a Windows executable

```bash
npm run dist
```

Outputs to `release/`:

- `MongoDB Backup and Restore Setup <version>.exe` — installer (choose install
  location, adds a Start Menu shortcut).
- `MongoDB-Backup-Restore-<version>-portable.exe` — single file, no install.

Both are unsigned, so Windows SmartScreen will warn on first run
("More info" → "Run anyway"). Add a code-signing certificate to
`build.win.certificateFile` in `package.json` to remove that.

### The app icon

`build/icon.ico` is generated from `build/icon.svg` — the MongoDB leaf framed by
a backup/restore cycle. Edit the SVG and regenerate:

```bash
npm run icon
```

That rasterises 16/20/24/32/40/48/64/128/256px and packs them into the `.ico`.
Sizes up to 48px use `build/icon-small.svg` instead, which drops the cycle arcs
— at taskbar size they render as grey fuzz, so the leaf gets the space. Both
SVGs carry their geometry in a comment so the arcs stay editable.

Rasterising is done by Chromium and the `.ico` container is written directly, so
no image libraries are needed. The generator validates what it wrote and fails
loudly rather than shipping a malformed icon.

---

## Telling the two modes apart

The costly mistake this app can make is running a restore while you believe you
are running a backup — the forms look alike, and in the safe restore mode the
damage is invisible until it isn't. So each mode carries its own identity:

| | Backup | Restore |
| --- | --- | --- |
| Accent | green | amber |
| Banner | `MongoDB → folder on disk` | `folder on disk → MongoDB` |
| States | "Nothing in your databases changes" | "The target database is modified" |
| Primary button | plain ink | amber, turning **red** for Replace and Drop database |

The tab underline, the banner along the top of the panel, and the rule above the
action bar all take the mode's colour, so the mode is readable from the corner of
your eye rather than only from the heading.

**Both actions confirm before running.** The dialog names the direction
explicitly — a restore says *"This writes into the database. It does not create a
backup."* — which is the sentence that catches the mistake. It also names the
target database, the server host (credentials stripped), and what the chosen
restore mode will do to existing data.

---

## Backing up

1. Paste the **MongoDB URI**. Click **Test connection** to confirm it works —
   the app reports the server version and whether it is a standalone, replica
   set, or sharded cluster.
2. Enter the **database** to back up. **Load** lists what the account can see in
   a picker you can type into to filter — servers with dozens of similarly named
   databases stay navigable. Opening the picker always shows every database, with
   the current one ticked; filtering happens only while you type, so a chosen
   name never hides the rest of the list.
3. Choose where to save it. Every run creates its own timestamped subfolder
   (`my_database_2026-08-18_18-30-00`), so a backup never overwrites an earlier
   one.
4. **Start backup.**

The **Advanced** column on the right holds gzip compression and the collection
picker — always visible, nothing hidden behind a disclosure. Choosing a database
loads its collections there automatically; **Load collection list** re-reads them
if the database has changed underneath you.

### What a backup folder contains

```
my_database_2026-08-18_18-30-00/
├── users.bson                  ← documents, raw BSON
├── users.metadata.json         ← indexes + collection options
├── orders.bson
├── orders.metadata.json
└── backup-manifest.json        ← run summary (this app only)
```

Documents are copied as the exact BSON bytes the server sent — nothing is
decoded and re-encoded on the way out. Numeric types, `Decimal128`, `Binary`
subtypes, `Timestamp`, and field order all survive unchanged.

Also captured: indexes (including partial, unique, TTL, and text indexes),
capped-collection settings, collation, validators, and view definitions.

Restoring the same folder with the official CLI:

```bash
mongorestore --uri "mongodb://..." --db target_name --dir "path\to\my_database_2026-08-18_18-30-00"
```

---

## Restoring

1. Paste the **MongoDB URI** for the destination. The account needs write
   access.
2. Choose the **backup folder**. The app reads it and reports what it found —
   source database, collection count, document count, and when it was taken.
3. Enter the **target database**. It defaults to the original name, but any name
   works — that is how you clone a database or restore into a staging copy.
4. Pick what should happen **if the target already has data**, then
   **Start restore**.

### The four restore modes

| Mode | What it does |
| --- | --- |
| **Keep** (default) | Inserts documents that are not there yet. Documents whose `_id` already exists are skipped and counted, never overwritten. Nothing is deleted. |
| **Merge** | Replaces documents that share an `_id`, inserts the rest. Use it to roll a database back to the backup's contents without dropping anything. |
| **Replace** | Drops each collection in the backup before restoring it. Collections *not* in the backup are left alone. |
| **Drop database** | Drops the entire target database first, including collections not in the backup. |

The two destructive modes ask for confirmation, naming the exact database, before
anything is deleted.

The **Advanced** column on the right holds index creation, document-validation
bypass, and the collection picker.

The restore also reads folders produced by `mongodump`, whether the folder
contains the `.bson` files directly or is a dump root with one subfolder per
database.

---

## Saved connections

Click **Save** next to the connection dropdown to store a URI under a name.
Selecting a saved connection afterwards connects straight away and fills the
database list — no need to press **Test connection** or **Load**. Both answers
come from a single handshake, which matters on Atlas where each connect carries
an SRV lookup and a TLS negotiation.

Connection strings contain credentials, so they are encrypted at rest with
Windows DPAPI via Electron's `safeStorage` — readable only by your Windows user
account. If the OS keystore is unavailable the app refuses to save rather than
writing credentials in plain text.

Everything is stored in `%APPDATA%\MongoDB Backup and Restore\settings.json`.
Delete that file to reset the app.

---

## About

Click the version in the title bar for the About dialog: app version, the
Electron/Chromium/Node build it is running on, and **Copy details** to put all of
that on the clipboard for a bug report.

Built by Adrian Dela Cruz for **Versa Innovations Corp.**, originally as an
internal tool for Versa systems, and released here under the MIT licence.

---

## Tests

```bash
npm test
```

Five suites, all run against a real MongoDB (`mongodb://127.0.0.1:27017` by
default; pass a URI as an argument to point elsewhere):

| Script | What it proves |
| --- | --- |
| `npm run test:engines` | Seeds a database covering every awkward BSON type, backs it up, restores it, and compares the **raw BSON bytes** of every document plus index definitions — plain and gzipped. Also covers duplicate handling, merge mode, renamed targets, filename escaping for collection names that are illegal as Windows filenames, capped collections, views, and input validation. |
| `npm run test:srv` | Covers the Atlas SRV/DNS fallback: seed-list URI composition, TXT-option precedence, the rule that a TXT record cannot downgrade TLS, rejection of SRV hosts outside the cluster domain, and DNS-error classification. Pass a cluster hostname (`npm run test:srv -- cluster0.xxx.mongodb.net`) to also run a live check that black-holes the system resolver and confirms the fallback still resolves the cluster. |
| `npm run test:compat` | Round-trips against the official tools: our backup → `mongorestore`, and `mongodump` → our restore. Skipped with a notice if the CLI tools are not on PATH. |
| `npm run test:ui` | Boots the real app under Electron and asserts the preload bridge, DOM wiring, and IPC round trips work, with no renderer console errors. Also checks the database picker stays height-capped, scrollable and filterable with 45 databases loaded; that both panels split into main/advanced columns sharing a full-height divider while the activity panel stays full width; and that the expanded activity panel fills its own height. |
| `npm run test:e2e` | Fills in the actual form fields and clicks the actual buttons, then verifies the data landed in MongoDB — covering the job-event plumbing behind the progress table and status bar. Also checks that committing a database name auto-loads its collections into the Advanced column, all selected. |

The UI suites run against a throwaway Electron profile, so they never touch your
saved connections or preferences.

---

## Releases and versioning

Versions follow [semver](https://semver.org), read from the user's point of view:
**major** for a backup format older versions cannot read or a workflow removed,
**minor** for new capability, **patch** for fixes that change nothing you relied
on. Every release is written up in [CHANGELOG.md](CHANGELOG.md).

Bump the version, which also commits and tags:

```bash
npm version patch
```

Then cut the release:

```bash
npm run release
```

That runs preflight checks (clean tree, tag free, changelog entry present), the
full test suite, and the Windows build; then tags, pushes, and publishes a GitHub
release with both executables attached and the changelog section as its notes.

Check what it would do without changing anything:

```bash
npm run release -- --dry-run
```

The GitHub step uses the [`gh` CLI](https://cli.github.com). Without it the local
steps still run and the manual instructions are printed instead — install it once
with `winget install GitHub.cli` to automate the last step.

The executables are not committed: at 94 MB each they belong on a release, not in
git history. `release/` is ignored for that reason.

---

## Troubleshooting

### `querySrv ECONNREFUSED` / `querySrv ETIMEOUT` on an Atlas URI

This is a **DNS failure, not a MongoDB failure**. An `mongodb+srv://` string
carries only the cluster name, so the client must first ask DNS for the cluster's
SRV record. If your DNS server refuses that query — common on consumer routers,
captive portals, VPNs, and locked-down corporate DNS — the connection fails
before MongoDB is ever contacted. It is often intermittent.

The app handles this itself: when an SRV lookup fails it re-resolves the cluster
through public DNS (1.1.1.1, then 8.8.8.8), converts the URI to a standard
seed-list connection, and retries. The activity log records when this happens.
Resolved hosts are checked to be inside the cluster's own domain, so a bad
resolver cannot redirect the connection somewhere else.

If both fail, the network is blocking DNS more thoroughly. Use the standard
connection string instead, which needs no SRV lookup: in Atlas open
**Connect → Drivers**, set the driver version to **"Node.js 2.2.12 or later"**,
and copy the `mongodb://` string it shows — it lists the cluster hosts directly.

To check DNS from the command line:

```bash
nslookup -type=SRV _mongodb._tcp.<your-cluster>.mongodb.net
```

### `Authentication failed`

The username or password is wrong, or the user is not authorised on the database
you named. Note that a password containing `@`, `:`, `/`, or `?` must be
percent-encoded in the URI (`@` becomes `%40`).

### Atlas connects from one network but not another

Atlas only accepts connections from IPs on its access list
(**Network Access → IP Access List**). A different office, home network, or VPN
exit means a different IP.

## Notes and limits

- **Point-in-time consistency.** Like `mongodump`, a backup is not a snapshot:
  collections are read one after another, so writes landing mid-run can leave
  related collections slightly out of step. For a consistent backup of a live
  system, run it against a secondary or during a quiet period.
- **Users, roles, and server config** are not backed up — only the database's
  collections, indexes, and views.
- **Cancelling** stops at the next document batch. Files already written are
  left in place, and a cancelled restore leaves partially written collections;
  re-run it in Replace mode for a clean result.
- **Large collections** stream through in batches and never load a whole
  collection into memory, so file size is bounded by disk, not RAM.

## Layout

```
src/main/       Electron main process
  main.js       window, IPC handlers, job lifecycle
  backup.js     backup engine
  restore.js    restore engine + backup-folder inspection
  bsonio.js     streaming BSON reader/writer, filename escaping
  mongo.js      connection handling, URI validation and redaction
  settings.js   preferences + encrypted connection storage
  preload.js    the only bridge exposed to the UI
src/renderer/   the window itself (plain HTML/CSS/JS, no build step)
scripts/        the four test suites
```

The renderer runs with `contextIsolation` on, no Node integration, and a strict
Content-Security-Policy; it reaches the outside world only through the named
channels in `preload.js`.
