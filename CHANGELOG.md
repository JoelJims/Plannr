# Changelog

Notable changes to Plannr. The phone app is the product; the desktop server (`server.js`) is a
development and test tool.

## 1.0.0 — first public release (in preparation, not released)

The first public release will be versionName `1.0.0`. `npm run release:android` sets it, with the
next versionCode, when the owner builds the release. User notes: `docs/release-notes-1.0.0.md`.

### Changed
- **Release signing passwords.** `keystore.properties` now holds only `storeFile` and `keyAlias`.
  The store and key passwords come from `PLANNR_STORE_PASSWORD` and `PLANNR_KEY_PASSWORD`, or
  `npm run release:android` asks for them without echo; they reach Gradle only through its
  environment. A `keystore.properties` that still has password lines stops the release
  (`SETUP.md` §2).

## In review — Phase 3 (branch `plannr-phase3`, pull request #3 into `main`, open)

Fixes from the security and quality review of 2026-11-21
(`docs/security-quality-review-2026-11-21.md`; finding ids in brackets). Pull requests #4 to #8
were merged into `plannr-phase3` on 2026-11-23. Pull request #3 (`plannr-phase3` into `main`) is
still open. Not released.

### Changed
- **Overview budget (F4, option (b), decided by the owner).** The budget bar, its "Spent" caption
  and its label now always use the whole project's spend, also when a date range is set. The label
  reads "₹X left of total budget · Budget ₹Y" or "₹X over total budget · Budget ₹Y" (before: "₹X
  left · Budget ₹Y" and "Over budget by ₹X"). With a range set, the caption says "Spent ₹X in
  total"; the range's own figures stay in the cards above. The PDF's budget line uses the same
  figure and words. Before, "left" compared the range's spend with the whole budget.

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
- **Phone start-up (Q13).** If the phone cannot open the database or plan its upgrade, the page
  says "Plannr could not open your data." and the reason. Before, it stayed blank.
- **Ledger entries (Q14).** An entry and its custom category name are saved in one transaction.
  Before, if the second write failed, the entry stayed saved while the answer was an error, so a
  retry saved it twice.
- **Backup check (Q9).** A JSON backup whose `sequences` names a table without an id column is
  refused with a clear message ("… has no id column, so it cannot have a sequence.") and nothing
  changes. Before, the restore failed with a 500.
- **Move data back (Q4).** The room check also counts the old copy, its rollback journal and the
  other `localStorage` keys. Before, a move back that "fit" could still run out of room (it was
  then rolled back, so nothing was lost).
- **Safety snapshots (Q12, partly).** A snapshot taken by the storage move no longer cuts the
  regular rotation from three snapshots to two. Move snapshots themselves are still never pruned,
  so they add up; whether to prune them is open.

### Safety
- **A warning about the old storage (Q2).** While the data is still in the WebView's
  `localStorage`, the Storage section of the Data Backup page says that the last few seconds of
  saves can be lost if Plannr is force-stopped or crashes, and to wait a few seconds before
  swiping Plannr away. The move panel says the new storage writes each save straight away.
- **Import refuses badly shaped ledger codes (F1).** A JSON backup whose category or sub-category
  codes are not in the `N.0` / `N.M` form, or whose sub-category sits under the wrong category, is
  refused before anything changes.
- **Android permissions (S7).** The APK no longer asks for the fingerprint and biometric
  permissions, which came from a plugin's dependency and were never used.

### Accessibility
- **Dialogs (F18).** While a confirm or choice dialog is open, Tab and Shift+Tab stay inside it.
  When it closes, keyboard focus goes back to the control that opened it.
- **The bulk-edit table** (Overview and Money Debited) gives every control a name for screen
  readers, for example "Amount, row 3". Nothing visible changes.

### Tools
- `scripts/phone-test.ps1` waits until Home has settled before its offline check, waits up to
  90 s for the PDF's share sheet and reports how long the PDF took.
- **The release key lives outside the project**, in `D:\Keys\plannr\` (`SETUP.md` §2).
  `keystore.properties` stays in the project root and points to it with a relative `storeFile`
  path. `npm run release:android` now also checks that the key file is there before it builds,
  and stops, naming the path, if it is missing. Its "Signing:" line shows the key's path only
  when the release can go ahead; otherwise it says "NOT ready" (or "NOT found" when there is no
  `keystore.properties`) and the reason follows. It reads
  only the `storeFile` line of `keystore.properties`. The key folder must be on the same drive
  as the project (`C:\Keys\plannr\` on a PC with only `C:`); an absolute `storeFile` line, or one
  that starts with a drive letter, is refused. A `keystore.properties` saved with a UTF-8
  byte-order mark is refused too, with its own message (Gradle cannot read the first entry of such
  a file), and so is one saved as UTF-16, which Windows PowerShell 5.1's plain `Out-File` and `>`
  write (Gradle cannot read any of it). A `--dry-run` that would stop now says so and lists no
  steps after the stop.
- **Release docs.** `SETUP.md` and `docs/RELEASE.md` now check the release APK's signature with
  `apksigner verify --print-certs` instead of `keytool -printcert -jarfile`, which can say "Not a
  signed jar file" for a correctly signed APK of this build. `SETUP.md` §8 names the real output,
  `Plannr.apk`. The key-generation command in `docs/release-plan.md` §1.1 writes the key straight
  into `D:\Keys\plannr\`.
- **Version names (decided).** The first public `versionName` is `1.0.0`; `versionCode` keeps
  going up by 1 per published build. `npm run release:android` now turns `1.0` into `1.0.0`
  (before: `1.1`), then bumps the last number (`1.0.0` → `1.0.1`).
- `test/release-guards.test.js` also fails if a `.p12` or `.pem` key file is tracked by git.

### Tests and CI
- CI also runs on pull requests into `plannr-phase3` (`.github/workflows/tests.yml`).
- `npm run test:modal-focus` (`test-ui/c-modal-focus.js`, the F18 check) is part of the full suite
  and of CI.
- **F7.** The `static-hosting` and `offline` UI suites ignore sqlite-wasm's own two-line fallback
  message, and only that, through one shared collector (`test-ui/_console-errors.js`).
  `static-hosting` also checks that every `.wasm` file is served as `application/wasm`.
- **F8 / F9 (partly).** `contract-phase-a` waits for what it reads next (at most 15 s) instead of
  sleeping a fixed time, and its waits let only a timeout pass. The other suites still use fixed
  ports and sleeps.

### Clean-up (nothing visible changes)
- One shared copy, used by both `server.js` and `public/local-api.js`, of the owner queries
  (`core/owner.js`), the IST date stamp (`core/ist-date.js`) and the start-up jobs helper
  (`createStartJobs` in `core/request-queue.js`). One copy of `parsePaise` for the contract pages
  (`PlannrUI.parsePaise` in `public/plannr-ui.js`).
- Two helpers nothing called are gone from `server.js`. `test/c-dead-code.test.js` checks that
  every top-level function in `server.js`, `local-server.js` and `public/local-api.js` is used.

### Docs
- `docs/release-plan.md` (new): what the first public release APK needs: the signing key, version
  numbers, moving from the debug build, the release notes and a checklist. Still a plan, apart
  from the key's new place, the release script's key checks and the version rule (all above).
- `docs/PHONE-TEST-CHECKLIST.md`: the owner's phone round as decided on 2026-11-22. A1: an
  encrypted and a JSON backup on the phone. A2: both copied to the laptop by cable. A3: both
  restored on the emulator and compared, and the install rehearsed there. A4: go only if all of it
  matches. B: `adb -d install -r`, never uninstall. C: the checks for this build. D: clear the data
  from the emulator.
- `docs/share-and-reminder-pdf-plan.md`: Send PDF goes on the existing daily report reminders (ids
  101–105); a payment reminder is a separate, later feature. Still a plan, not built.

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
