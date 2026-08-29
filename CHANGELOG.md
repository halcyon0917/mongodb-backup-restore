# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this is a desktop app rather than a library, the version numbers are read
from the user's point of view:

- **MAJOR** — the backup file format changes in a way older versions cannot read,
  or a workflow is removed.
- **MINOR** — new capability: a new option, a new screen, a new restore mode.
- **PATCH** — fixes and refinements that change no behaviour you relied on.

## [Unreleased]

Nothing yet.

## [2.0.0] — 2026-08-29

A new interface, and two things the app could not do before: it remembers what
it has run, and it can tell you what a restore would do before you run it.

### Added

- **History**. Every run is recorded — including the ones that fail or are
  stopped, with how far they got. Expand a run for its per-collection detail,
  open its folder, load a backup straight into the restore form, or forget it.
  Kept in `history.json` beside the settings, capped at the last 60 runs.
- **Dry run** for restores. Reads the live target and reports, collection by
  collection, what the chosen mode would do — without writing anything. The
  destructive modes are exact, because everything present is deleted and the
  count is simply what is there now. The safe modes are given as bounds: how
  many of the backup's documents already exist depends on their `_id`s, which
  cannot be known without reading every one, and the preview says so rather
  than inventing precision it does not have.
- Restores that delete data now need a confirmation ticked in the form as well
  as the dialog, and the tick names the database it is about to empty.
- The target database is labelled **exists** or **will be created** as you type
  it, so cloning into a fresh name is visibly different from writing into a
  live one.
- The backup destination shows the exact folder the run will create, before it
  runs.
- A theme switch. It still starts from the Windows setting, but the choice is
  now yours and is remembered.
- **A dialog for adding and editing connections**, replacing the inline rename
  prompt. Name, URI, an optional default database, a **Test** button that tries
  the URI without adopting it as the app's connection, and **Delete** when
  editing. A name already in use is reported rather than silently taking over
  the connection that had it.
- Connections can be marked **production**. Those are flagged in red in the
  sidebar, and every restore into one has to be confirmed in the form — not
  only the modes that delete data. Writing to production is the case where
  "I thought I was pointed somewhere else" costs the most, safe mode or not.

### Fixed

- Saving a connection under a name already in use replaced that connection
  instead of adding a new one. A saved connection is now identified by its id
  and nothing else, and a duplicate name is refused with a message. (Present
  in 1.0.0, where the same collision could quietly overwrite a saved
  connection through the **Save** button.)

### Changed

- **The whole interface.** Views moved from tabs into a sidebar that also holds
  the saved connections; the window draws its own title bar; the palette is a
  warm dark and light pair, set in Manrope and Space Mono, both bundled so the
  app renders identically offline.
- **One connection for the whole app.** The URI on the Back up and Restore
  views is now the same connection, so a saved connection applies everywhere
  and one handshake serves both. The restore view states the host it is about
  to write to in three places — the connection card, the strip along the top,
  and the confirmation dialog.
- Progress moved onto the collection rows themselves: the row fills as its
  collection is copied. The separate progress table is gone.
- The activity log became a dock along the bottom, collapsed to a single line
  showing the newest entry and expanding over the form rather than beside it.
- Saved connections connect on a single click in the sidebar, as before, and
  can be removed from the same row.
- The minimum window is now 1120×700; below that the sidebar and the two form
  columns stop fitting.

### Removed

- Separate connections per view. Backing up from one server and restoring into
  another now means switching connection between the two — one click if it is
  saved — rather than keeping two URIs filled in at once.

### Security

- History stores the host it talked to but never the connection string, so the
  file cannot be used to reach a server. Verified by the test suite against the
  file on disk.

### Unchanged

- The backup format. Folders written by 1.0.0 restore here, folders written
  here restore in 1.0.0, and both directions still interoperate with
  `mongodump` and `mongorestore`.

## [1.0.0] — 2026-08-19

First release.

### Added

- **Backup**: connection string plus a database name writes a mongodump-compatible
  folder to disk. Documents are copied as the exact BSON bytes the server sent, so
  numeric types, `Decimal128`, `Binary` subtypes, `Timestamp` and field order all
  survive unchanged. Indexes, capped-collection settings, collation, validators and
  view definitions are captured alongside.
- **Restore** into any database name, with four modes for existing data: Keep,
  Merge, Replace, and Drop database. The two destructive modes are confirmed
  against the real target name before anything is deleted.
- Reads dumps produced by `mongodump`, and its own dumps are readable by
  `mongorestore` — verified in both directions by the test suite.
- Optional gzip compression, and per-collection selection on both sides.
- Saved connections, encrypted at rest with Windows DPAPI through Electron's
  `safeStorage`. Selecting one connects and lists its databases in a single
  handshake.
- A filterable database picker that keeps the whole list browsable after a choice
  is made, and loads the chosen database's collections automatically.
- Live progress: per-collection document counts, sizes and index counts, plus an
  activity log that can be copied or saved.
- Light and dark themes, following the Windows setting.
- About dialog on the version, with the runtime details a bug report needs.

### Security

- Every error surfaced to the UI or the activity log is stripped of connection-string
  passwords, so a saved log cannot leak credentials.
- The renderer runs with context isolation on, no Node integration, and a strict
  Content-Security-Policy; it reaches the main process only through named channels.
- SRV records resolved through the DNS fallback are checked to belong to the
  cluster's own domain, so a hostile resolver cannot redirect a connection.

### Known limitations

- A backup is not a point-in-time snapshot: collections are read one after another,
  so writes landing mid-run can leave related collections slightly out of step. Run
  against a secondary for a consistent copy of a live system.
- Users, roles and server configuration are not backed up — only collections,
  indexes and views.
- One database per run; whole-cluster backup is not implemented.
- The executables are unsigned, so Windows SmartScreen warns on first run.

[Unreleased]: https://github.com/halcyon0917/mongodb-backup-restore/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/halcyon0917/mongodb-backup-restore/releases/tag/v2.0.0
[1.0.0]: https://github.com/halcyon0917/mongodb-backup-restore/releases/tag/v1.0.0
