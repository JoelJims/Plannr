# Changelog

Notable changes to Plannr. The phone app is the product; the desktop server (`server.js`) is a
development and test tool.

## In review — Phase 3 (branch `plannr-phase3`, pull request #3, not merged into `main`)

Fixes from the security and quality review of 2026-11-21
(`docs/security-quality-review-2026-11-21.md`; finding ids in brackets). Not released.

### Fixed
- **Restore is all or nothing (S3/Q6).** An encrypted restore that failed a check after the backup
  was copied in left the backup's data live while saying the restore had failed. Now the data from
  just before the restore is put back, and the message says "Nothing was changed: your data is as
  it was before." The safety copy is still written first.
- **Contracts (Q3).** A contract and its payment dates are saved together or not at all. Before, a
  date that failed to save left the contract saved with some dates missing.
- **CSV export on the phone (F2).** "Download CSV (for Excel)" saved nothing on the phone while
  saying it was downloading. The CSV files now go through the same path as every other file on the
  Data Backup page: written, checked, then one share sheet with all of them.
- **Overview figures (F3).** The figures no longer show ₹0.00 while loading or after a failed load
  (which read as "nothing spent"). They show "…" while loading and "—" with a message and the
  reason if the load fails.
- **Home (F5).** The "First login — welcome." line, left over from the removed login, is gone.

### Safety
- **Import refuses badly shaped ledger codes (F1).** A JSON backup whose category or sub-category
  codes are not in the `N.0` / `N.M` form, or whose sub-category sits under the wrong category, is
  refused before anything changes.
- **Android permissions (S7).** The APK no longer asks for the fingerprint and biometric
  permissions, which came from a plugin's dependency and were never used.

### Tools
- `scripts/phone-test.ps1` waits until Home has settled before its offline check, waits up to
  90 s for the PDF's share sheet and reports how long the PDF took.
- **The release key lives outside the project**, in `D:\Keys\plannr\` (`SETUP.md` §2).
  `keystore.properties` stays in the project root and points to it with a relative `storeFile`
  path. `npm run release:android` now also checks that the key file is there before it builds,
  shows its path on the "Signing:" line, and stops, naming the path, if it is missing. It reads
  only the `storeFile` line of `keystore.properties`. The key folder must be on the same drive
  as the project (`C:\Keys\plannr\` on a PC with only `C:`); an absolute `storeFile` line, or one
  that starts with a drive letter, is refused.
- **Version names (decided).** The first public `versionName` is `1.0.0`; `versionCode` keeps
  going up by 1 per published build. `npm run release:android` now turns `1.0` into `1.0.0`
  (before: `1.1`), then bumps the last number (`1.0.0` → `1.0.1`).

## Merged into `main` — Phase 2 (branch `plannr-phase2`, pull requests #1 and #2)

Merged on 2026-11-21. Not released: no public APK has been published yet. The items under "Added
since the first Phase 2 notes" came after the notes further down.

### Added since the first Phase 2 notes

#### Storage on the phone (step 1.4)
- **The phone's database can move to a file.** The Data Backup page has a "Where your data is
  kept" section with **Move to the new storage**: it saves an encrypted backup first, copies the
  data from the WebView's `localStorage` into a database file (the `@capacitor-community/sqlite`
  plugin, pinned at 8.1.1), checks the copy and only then switches. An interrupted move offers
  **Continue** or **Not now**. Afterwards **Move data back** returns to the old storage and
  **Delete the old copy** removes it (only after a backup made since the move).
- A move that runs out of space says so with both numbers (needed and free) and leaves the old
  data untouched.
- **Recovery screen.** If the database file is missing or damaged at start-up, Plannr stops on a
  recovery screen instead of opening empty: use the old copy, or restore an encrypted backup into a
  new file.
- **Android Auto Backup** now includes the database file and its marker. Safety snapshots are no
  longer included; they stay on the phone (this changes the Auto Backup note further down).
- The encrypted backup format is one shared implementation for the phone and the desktop; files
  from either restore on the other.
- A database whose first upgrade failed part-way no longer loses the contract services on the next
  start, and the snapshot from before the upgrade is kept until an upgrade finishes.

#### Fixes from the review (2026-11-21)
- **Old databases (Q1).** A database first made by the two oldest schemas starts again (the dev
  server refused it, and so did the phone after restoring an encrypted backup made from one).
- **Ledger codes (F1).** Ledger codes are escaped wherever they go into a page, so a crafted backup
  cannot put markup into the ledger lists.
- **Home backup banner.** The empty red "Back up now" banner no longer shows on every start when no
  backup is overdue.
- **Dev tools (R2).** A `PLANNR_DB` that is set but empty is refused instead of opening the real
  database. `.gitignore` also covers other key files, `.env` variants and exported data (S9).

#### Project
- The server routes moved into shared modules under `core/` (step 1.3) and the storage work above
  (step 1.4), so the phone and the dev server run the same code. Nothing visible changes.
- CI: GitHub Actions runs `npm test` on Ubuntu and Windows and the UI suites on Ubuntu.
- A short plain-English README with screenshots; technical detail moved to `docs/DEVELOPERS.md`.
- MIT license (`LICENSE`).
- `scripts/phone-test.ps1` runs the phone checks that can be automated over adb.
- `docs/share-and-reminder-pdf-plan.md`: a plan (not built) for sending the PDF to WhatsApp or
  e-mail, also from a reminder.


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
  settings screen opens only when it is tapped. Times saved earlier get the same note and button
  when Home opens. `test/notifications.test.js`.
- Saving a backup, a CSV or the PDF no longer says "✗ … timed out after 20s" while the share sheet
  is still open. The share sheet now waits for the user however long they take, so an encrypted
  backup saved after 20 s is now recorded as exported. Closing the sheet without choosing shows a
  plain "Not saved" note instead of a red error, and the Ledger List import says nothing was
  imported. `test/share-sheet.test.js`.
- The Recycle Bin lists deleted items again. With even one item in it, it said "Network error
  loading the Recycle Bin." and showed nothing, so deleted entries could not be restored (a helper
  was defined in the page's other script block). `test-ui/backup-roundtrip.js` now checks it.

### Phone and dev server answer alike (cross-platform plan, steps 1.1 and 1.2)
- `npm test` runs the HTTP test files a second time, against `public/local-api.js` (the phone's
  API code) instead of `server.js`. The tests that differ on the phone are listed with a reason in
  `test/phone-code-differences.json`. Only differences by design are left there: 16 tests of
  dev-server-only features and 1 per-platform answer (`/api/storage`).
- Shared request rules (`request-rules.js`, used by both):
  - Size limits per kind of request: 32 KB normal, 256 KB Save All, 20 MB backup restore. Each
    has its own message, so a long text no longer gets the "save fewer rows" batch message.
  - A body that is not valid JSON gets "Invalid request." on the phone too, instead of a
    misleading "Enter a valid amount".
  - An unknown `/api` request gets a JSON 404 on both.
- The phone's PDF: the Transactions total row was one column too wide. Fixed.
- The PDF and encrypted-backup tests now check the phone's own code in the second pass (through
  test stand-ins for the PDF plugin and the sqlite-wasm database copy).

### Offline first (owner's decision, 2026-11-15)
- The Android app keeps the INTERNET permission. The branch that removed it (`plannr-no-internet`)
  is kept as a reference, not merged; phone checklist check 7 is skipped.
- The core never needs the network, and two tests hold it to that:
  - `test/offline.test.js` runs on both the dev server and the phone code. It checks that no app
    file loads anything from outside and that the PDF page needs nothing from outside. Then it logs,
    edits and deletes entries, backs up and restores, and makes the PDF page while every outside
    connection is refused.
  - `npm run test:offline` opens every page in a real browser with no connection. It logs, edits
    and deletes an entry through the real form, downloads both backups and presses the PDF button,
    and fails on any request outside the app.
- The rule for any future online feature (optional, clearly labelled, used only when the user uses
  it, a clear message offline, never needed for logging data) is in `CONTRIBUTING.md` and the
  cross-platform plan.
- Privacy text (README): "Plannr works fully offline and your data stays on your device. Optional
  features use the internet only when you use them. Android's own Auto Backup may save a copy to
  your Google account."

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
