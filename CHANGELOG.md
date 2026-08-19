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

[Unreleased]: https://github.com/halcyon0917/mongodb-backup-restore/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/halcyon0917/mongodb-backup-restore/releases/tag/v1.0.0
