# Changelog

Notable changes to Plannr. The phone app is the product; the desktop server (`server.js`) is a
development and test tool.

## Unreleased — Phase 2 (branch `plannr-phase2`)

### Backups and data safety
- **Complete backups.** The JSON backup (format v2) now holds everything needed to rebuild the app
  on a new phone: people, categories and saved custom names as well as all entries. Format v1 files
  still restore. The encrypted backup was already a whole-database copy.
- **Database versioning.** `db.js` has a migration runner on `PRAGMA user_version`, shared by the
  phone and the desktop server. Each upgrade step runs in its own transaction after a safety
  snapshot; data from a newer app version is refused, not misread. See `CONTRIBUTING.md`.
- **Storage limit.** The Data Backup page shows how much of the phone's app storage is used (about
  10 MB), warns at 70% and 90%, and a save that hits the limit says "Storage is full" instead of
  "Something went wrong".
- **Safety snapshots.** Kept in the app's private folder, newest 3 only, gzip-compressed; an
  encrypted restore now takes one first.
- **Android Auto Backup** is limited to the ledger and the safety snapshots, well under 25 MB.

### Safe updates
- `test/release-guards.test.js` fails if the app id (`com.plannr.app`) or the page origin
  (`https://localhost`: `server.androidScheme`, `server.hostname`) would change — either one
  would open an empty database after an update — or if the release key could be committed.
- `npm run release:android` runs every test, raises `versionCode`/`versionName`, runs
  `android:sync` and builds the signed release APK (`--dry-run` to preview).
- `docs/RELEASE.md`: back up the phone, build, install over the old app, check the data.
- `docs/PHONE-TEST-CHECKLIST.md`: the checks only a real phone can do — where the WebView keeps
  the data, the real storage limit, backups with categories, airplane mode, updating over the old
  version, Auto Backup (`bmgr backupnow`, uninstall, reinstall) and a test build without the
  INTERNET permission. All passed on an Android 16 emulator; still to repeat on the phone.

### Fixed (found on the emulator)
- Opening Home no longer pushes Android's "Alarms & reminders" settings screen over the app on
  every start (Android 14+, once notifications are allowed). Reminders use exact alarms only when
  Android already allows them; otherwise Home offers an "Allow on-time reminders" button, and the
  settings screen opens only when it is tapped. `test/notifications.test.js`.
- The Recycle Bin lists deleted items again. With even one item in it, it said "Network error
  loading the Recycle Bin." and showed nothing, so deleted entries could not be restored (a helper
  was defined in the page's other script block). `test-ui/backup-roundtrip.js` now checks it.

### Proposals (not implemented)
- `docs/storage-proposal.md`: moving the phone database off `localStorage` (native SQLite plugin
  or sqlite-wasm on OPFS), with a one-time migration plan, a safety snapshot and a way back.

### Desktop server is dev-only
- `server.js` prints `DEV MODE – not used by the phone app` on start, and marks its responses with
  `X-Plannr-Dev-Server`. Pages decide where `/api` goes with `public/runtime-mode.js`: inside the
  app always the in-app database (no probe at all), in a browser `server.js` only with that header.
  The old rule ("the page has an ETag") is gone.
- `express`, `playwright` and `@capacitor/cli` moved to `devDependencies`.

### Retired
- `plannr-start.cmd` — the Windows Task Scheduler launcher that ran `server.js` at logon (it also
  carried a stale comment about Gmail credentials in `.env` for the long-removed Daily Report
  email). The desktop server is no longer meant to run unattended; start it with `npm start` when
  developing.
- `stop-plannr.cmd` — stopped that unattended server. Not needed with `npm start` (Ctrl+C). The
  server still honours a `.plannr-stop` file in the project root.
- `backup-db.cmd` — **kept for now, retiring next.** A scheduled task on the maintainer's PC still
  runs it every night to back up the desktop database (`data/plannr.db`). It will be removed once
  that data has been moved to the phone (export a complete backup from the desktop, restore it on the
  phone) and the scheduled task is turned off. `backup-db.js` stays as a manual desktop tool.
