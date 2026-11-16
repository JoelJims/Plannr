# Step 1.4: storage plan

Status: **plan only, nothing built.** Written 2026-11-16. No code starts until the owner says OK.
Nothing in this plan moves the owner's real data. That needs a separate OK, after the real-phone
check in §5.4 passes.

## 0. How this fits the main plan

- In `docs/cross-platform-plan.md`, step 1.4 is only `core/host.js` and one `backup-crypto.js`.
  The storage work is that plan's Phases 2 and 3. The desktop file is part of its step 4.1.
- This document joins them into one "step 1.4" track with four stages:
  - **A.** Host services and the backup code. Storage does not change.
  - **B.** The async database interface. The phone stays on `localStorage`.
  - **C.** The Android database file and the move.
  - **D.** The desktop file adapter.
- Steps 1.5 and later in the main plan keep their numbers.
- The design follows §4 of the main plan. Where this plan differs, it says so. There are two such
  places:
  - how the new file is written (§2.1);
  - the safety snapshots in Auto Backup (§3.1).

---

## 1. The adapters

### 1.1 One interface (as in main plan §4.1)

```
get(sql, params)   all(sql, params)   run(sql, params) -> { changes, lastInsertRowid }
exec(sql)          transaction(async fn)               exportBytes()   replaceWith(bytes)
info() -> { engine, path, sizeBytes }                  close()
```

- **The core never touches an engine directly.** Every route gets the adapter as `ctx.db`, and the
  platform services as `ctx.host`.
- **One request at a time.** The core runs requests through one queue, so two async requests can
  never mix inside one transaction.
- **Stage B is done one file at a time.** While it runs, the adapters also keep synchronous
  methods, so files not yet converted still work. Those methods are removed when stage B ends.

### 1.2 Android: `@capacitor-community/sqlite` 8.1.1

- **The version is pinned exactly:** `"@capacitor-community/sqlite": "8.1.1"`, with no `^`.
  - This new dependency was approved in main plan §9.
  - It bundles SQLCipher, so the APK grows. The spike (part C1) measures by how much.
- **The file:** `/data/data/com.plannr.app/databases/plannrSQLite.db`. The database name is
  `plannr`; the plugin adds `SQLite.db`.
  - It sits in the app's private folder, which other apps cannot read.
  - On the phone it is not encrypted, the same as today. The encrypted backup protects copies that
    leave the phone.
- **What the adapter always does:**
  - It sets `PRAGMA journal_mode = DELETE` and `PRAGMA foreign_keys = ON`, as `db.js` does today.
  - It passes `transaction: false` on every call and runs `BEGIN`/`COMMIT` itself, behind the one
    queue (plugin issue #700).
  - It never uses `executeSet` (#671) or `exportToJson` (#685, #690).
- **How the shared core uses it:**
  - `public/local-bootstrap.js` reads the storage marker (§2.2) and opens the right adapter.
  - It hands that adapter to the fetch shim and the core.
  - The pages do not change. They still call `fetch('/api/...')`.
- **`exportBytes()`:** `VACUUM INTO` a temporary file in the app's cache folder, read it, then
  delete it.
- **`replaceWith(bytes)`:**
  1. Close the database.
  2. Write the new file next to the old one and force it to disk (fsync).
  3. Rename it over the old file (one atomic step).
  4. Reopen it and run `init()`.
- **`info()`:** the real size of the file on disk (the main file, plus `-journal` if one exists)
  and the phone's free space.
- **A small helper of Plannr's own** in `android/app/src/main/java/...`:
  - About 60 lines of Java, with no new dependency.
  - It does what the plugin cannot do:
    - read free space (`StatFs`);
    - read real file sizes;
    - write a file, force it to disk, then rename it.
  - If the spike shows the plugin already does part of this (`moveDatabasesAndAddSuffix`), the
    plugin does that part instead. See decision D4.

### 1.3 Desktop: a SQLite file in Electron's userData folder

- **The file:** `app.getPath('userData')/plannr.db`.
  - Windows: `%APPDATA%\Plannr`
  - macOS: `~/Library/Application Support/Plannr`
  - Linux: `~/.config/Plannr`
- **The engine is `node:sqlite`.** The adapter is the same `node-sqlite` adapter that the tests and
  the dev server use, given a file path.
  - Stage D builds and tests it in Node now.
  - In Phase 4, Electron only passes in the path.
- **`exportBytes()`:** `VACUUM INTO`, which is today's `vacuumSnapshotBytes()`.
- **`replaceWith(bytes)`:** the same write, fsync, rename, reopen.
- **`info()`:** `fs.stat`.
- **Restoring an encrypted backup starts working on desktop.** Today it answers 501.
- **`data/plannr.db` (the dev server's file) is never opened by the desktop app.** The desktop app
  starts empty and is filled from a backup file.

### 1.4 The browser preview and the UI tests

- They keep the `wasm-kvvfs` adapter (`localStorage`).
- Chromium cannot run the plugin, so the UI suites test the shared core on sqlite-wasm. The adapter
  contract suite on the emulator covers the native adapter.

---

## 2. The one-time move from `localStorage` to the file

**You start the move, not the app.** A "Move to the new storage" button on the Data Backup page
starts it. The button appears only in the build that has the plugin. During the move the app shows
"Moving your data…" and accepts no edits.

### 2.1 The steps

| # | Step | Done when | If it fails |
|---|---|---|---|
| 0 | Space check | Free space ≥ 3 × the database size + 20 MB | Nothing starts. A message gives the numbers (§2.5). |
| 1 | Encrypted backup | Saved through the share sheet. Same rule as the Ledger List import's safety backup. | Nothing changed. |
| 2 | Safety snapshot | A gzipped copy of the database in `safety-snapshots/`, checked by `stat` and by reading it back | Stop. Nothing changed. |
| 3 | Write the new file | The exported bytes are written to `plannr-movingSQLite.db` and forced to disk | The partial file is deleted. |
| 4 | Check it | The §2.3 checks pass on the new file against `localStorage` | The file is deleted. |
| 5 | Put it in place | Renamed to `plannrSQLite.db` (one atomic step) | A rename either happens fully or not at all. |
| 6 | Switch | The marker file `files/plannr-storage.json` says `native-v1`, is forced to disk, and the `localStorage` key `plannr-storage` repeats it | Not switched. The app stays on `localStorage`. |

**Why the file is copied byte for byte.**

- Step 3 writes exactly the bytes that `sqlite3_js_db_export` returns. The encrypted backup already
  uses this export today.
- A byte-for-byte copy means no value can change type on the way. This matters because the schema
  has `REAL` columns (`interest_rate`, `supervision_rate_pct`).
- Main plan §4.3 left this open. This plan picks writing the file. A row-by-row copy is only the
  fallback, used if the spike shows the file cannot be placed.

**Why the marker is a file, not only a `localStorage` key.**

- `localStorage` reaches the disk about 1 second after a write (measured; see
  `docs/storage-proposal.md`).
- So a marker kept only in `localStorage` could be lost if Android kills the app right after the
  switch.
- A file written through Java is on disk when the call returns.

### 2.2 All or nothing, and able to continue after a kill

- **Until step 6, `localStorage` is the only real copy.** The app runs on it exactly as today. The
  new file is only a candidate.
- **At startup, before any page reads data, the app decides which copy to use:**

| Marker file | Database files | What the app does |
|---|---|---|
| none | none | Uses `localStorage`, as today. |
| none | `plannr-movingSQLite.db` or `plannrSQLite.db` present | The move was interrupted. The app deletes those candidate files and runs on `localStorage`. It shows "The move to the new storage was interrupted. [Continue] [Not now]". |
| `native-v1` | `plannrSQLite.db` opens and `PRAGMA quick_check` is `ok` | Uses the file. |
| `native-v1` | file missing, or fails the check | Shows a recovery screen and changes nothing. The choices are "Use the old copy as it was on <date>" (§2.4) and "Restore an encrypted backup". |
| `localstorage-v1` (after a move back) | any | Uses `localStorage`. The file is kept until you delete it. |

- **The progress record is only a hint.**
  - `plannr-storage-move` in `localStorage` records which steps finished, and the database's
    checksum at step 1.
  - Every step is checked again from the facts (is the file there, do the checks pass?). If the
    record is lost, the only cost is repeating a step.
- **"Continue" after an interruption:**
  - If the database's checksum still equals the one from step 1, the backup and the snapshot are
    still current, so they are not repeated. The move starts again at step 3.
  - Otherwise it starts again at step 1.
  - The copy takes seconds, so repeating it costs little.
- **If Android kills the app during a step:**
  - **Steps 0–2:** nothing changed.
  - **Steps 3–5:** the candidate is deleted at the next start.
  - **Step 6:** the marker file is either fully written or absent.
- **The move never writes to the `localStorage` copy.**

### 2.3 The checks after the copy, table by table

`core/storage-check.js` runs on both copies, through the same adapter code:

- `PRAGMA integrity_check` is `ok` on the new file.
- `PRAGMA user_version` is the same in both.
- The schema text in `sqlite_master` is the same, table by table and index by index.
- For every table, including `sqlite_sequence` (the AUTOINCREMENT counters):
  - the row count is the same;
  - a SHA-256 of all rows, in rowid order, is the same.
  - Each value is hashed together with its SQLite type (`typeof()`). So `1`, `1.0` and `'1'` count
    as different.
- **Any difference fails the step.** The candidate is deleted and nothing switches.
- **The result is kept and shown.** The per-table counts and hashes are saved in the marker file.
  After the move you see a summary in the form "All <n> tables match (<n> rows)".

### 2.4 The old data is kept until you confirm

- **After the switch, the `localStorage` copy is unchanged, unused and only read.**
- **The Data Backup page shows** "Old copy kept (from 16 Nov 2026, 2.6 MB)", with two actions:
  - **"Delete the old copy".**
    - It works only after you confirm in a dialog.
    - It also needs an encrypted backup saved since the move.
    - Nothing deletes the old copy automatically, ever.
  - **"Move data back" (the way back).**
    - It runs the same steps in reverse, with your current data: snapshot, write into
      `localStorage`, check, then set the marker to `localstorage-v1`.
    - It is allowed only if the database fits under 90% of the `localStorage` limit, because the
      old limit applies again.
    - It replaces the old copy with your current data. The dialog says so, and a snapshot of the
      old copy is taken first.
- **"Use the old copy as it was on <date>" is for emergencies only.**
  - It appears only when the file is missing or damaged.
  - It switches back without copying anything, so entries made since the move are not in it. The
    dialog says so.
  - The damaged file is renamed and kept, not deleted.
- **The encrypted backup from step 1 is the fallback for everything.** It restores on either kind of
  storage.
- **The way back has to be inside the new version.** An older APK cannot be installed over a newer
  one without uninstalling, and uninstalling deletes the data.

### 2.5 Low space on the phone

- **Before starting:**
  - Free space must be at least 3 × the database size + 20 MB. That covers the new file, its
    journal during the checks, the snapshot and the temporary backup file, plus a margin.
  - For a 2.8 MB database that is about 28 MB.
  - If there is less, nothing starts, and the message gives the numbers: "Plannr needs about 28 MB
    free to move your data. Your phone has 9 MB free. Free some space, then try again."
- **During the move:** a "disk full" or write error deletes the candidate. `localStorage` is not
  touched, and the same message appears. The old copy is never used to make room.
- **After the move, "Storage is full" needs new wording.**
  - Today's text says that freeing space on the phone would not help. That is true for
    `localStorage`.
  - For the file, the phone's own free space is what runs out, so the text depends on which storage
    is in use.
- **Android may empty an app's cache folder when space is low.** Plannr keeps nothing there longer
  than one call (the `VACUUM INTO` temporary file).

---

## 3. Android Auto Backup

### 3.1 The rules

There are two rule files:

- `backup_rules.xml` for Android 6–11;
- `data_extraction_rules.xml` for Android 12 and later, in both its `cloud-backup` and
  `device-transfer` sections.

The two stay identical:

```xml
<!-- The database file, its rollback journal if a write was in progress, and the marker. -->
<include domain="database" path="plannrSQLite.db" />
<include domain="database" path="plannrSQLite.db-journal" />
<include domain="file" path="plannr-storage.json" />
<!-- The old localStorage copy, only while it is kept (decision D3). -->
<include domain="root" path="app_webview/Default/Local Storage/" />
<include domain="root" path="app_webview/Local Storage/" />
```

- **With `<include>` rules, only what is listed is backed up.** So these stay out:
  - the cache folders, which Android never backs up anyway;
  - the candidate `plannr-movingSQLite.db`;
  - the WebView's other folders;
  - `safety-snapshots/`.
- **This is a change from today (decision D2).**
  - `safety-snapshots/` is backed up today (Phase 2 Step 5). Check 6 confirmed that the 3
    snapshots come back after a reinstall.
  - You asked for snapshots to be left out, so this plan removes that line.
  - The effect: after a phone is restored from Google, the snapshots are gone. The data itself is
    not affected.
- **Why the journal is included.**
  - With `journal_mode = DELETE`, the main file is complete whenever no write is in progress.
  - If Android copies the files during a write, the journal travels with them, and SQLite repairs
    the file the next time it opens.
  - Emulator test E5 checks a restore.
- **The two `localStorage` lines are removed** in the release after you delete the old copy.

### 3.2 Expected size against the 25 MB limit

If the data is over 25 MB, Android skips the whole cloud backup.

| | Today | Right after the move (old copy kept) | After you delete the old copy |
|---|---|---|---|
| Database | Inside `localStorage`, which takes at most about 10 MB on disk | The file, the same size as today's database: at most about 2.8 MB (the most `localStorage` could hold) | The file |
| Old `localStorage` copy | — | At most about 10 MB | 0 |
| Safety snapshots | At most about 1.3 MB (3 gzipped) | 0 (left out) | 0 |
| Marker file | — | Under 1 KB | Under 1 KB |
| **Worst case** | **At most about 12 MB** (the storage-limit suite checks it stays ≤ 15 MB) | **At most about 13 MB** | **The file alone** |
| Room to grow | None: `localStorage` is full at about 2.8 MB of data | The file can reach about 15 MB before the total hits 25 MB | About 25 MB, roughly 120,000 typical entries (estimate below) |

- **The estimate:** about 200 bytes per entry, measured in `localStorage`. Emulator test E2 measures
  it again on the file.
- **What Android reported on the emulator:**
  - 280,064 bytes for a 0.55 MB database plus 3 snapshots;
  - 110,080 bytes in the second run.

  Both are far below the limit. The table shows worst cases.
- **The storage meter shows the Google backup estimate against 25 MB.** The estimate is the
  database file, plus the old copy while it is kept.
  - It warns from 20 MB and warns strongly from 23 MB (decision D5).
  - It says what to do: delete the old copy, or empty the Recycle Bin.

---

## 4. Backup, restore and `/api/storage` in the shared core

Two new files hold these routes: `core/routes/backup.js` and `core/routes/storage.js`.
`core/host.js` lists what each platform must supply.

| Route | Done in the core | Supplied by the adapter or the platform |
|---|---|---|
| `GET /api/backup/export` | `buildBackup` (`backup-format.js`) | — |
| `POST /api/backup/import` | Check the file, take a snapshot, then `applyBackup` inside `db.transaction` | `host.snapshot.writeJson` |
| `POST /api/backup/export-encrypted` | Passphrase checks, then `encrypt` (`core/backup-crypto.js`) | `db.exportBytes()` |
| `POST /api/backup/import-encrypted` | Decrypt, check it is SQLite, take a snapshot, replace, `init()`, refresh the category list | `host.snapshot.writeDatabase`, `db.replaceWith(bytes)` |
| `GET`/`PUT /api/backup/reminder`, `POST /api/backup/mark-exported` | As today | `host.now()` |
| `GET /api/storage` | Levels and messages | `db.info()`, `host.storage.info()` |
| `GET /api/overview/pdf` | Also moves to the core | `host.pdf.render` |

- **`/api/storage` gives the same answer shape on every platform:**
  `{ mode, databaseBytes, backupBytes, backupLimitBytes, freeBytes, fraction, level }`.
  - On Android and desktop, `databaseBytes` is the real file size on disk (main file plus journal).
  - In the browser preview it stays the `localStorage` measurement.
- **The encrypted backup format does not change** (`PLBK` version 1).
- **There will be one `core/backup-crypto.js`:**
  - AES-256-GCM through WebCrypto, which Node 22 also has.
  - scrypt with N=16384, r=8, p=1, supplied by the platform: `scrypt-js` on the phone (as today)
    and `node:crypto` on desktop. Both give the same output; `node:crypto` is faster.
  - First, encrypted files made by both of today's versions are committed as known-answer files.
    They must still open after the change.
- **`backup-crypto.js` in the project root is not deleted** (standing rule). It becomes a thin
  wrapper over the core file, so `backup-db.js` and `backup-db.cmd` keep working. They are tested
  only on a copy of a test fixture, never on `data/plannr.db`.

---

## 5. Tests

### 5.1 Unit tests (Node, part of `npm test`)

- **Adapter contract suite.** It runs on `node-sqlite`, later on `wasm-kvvfs` in Chromium and on
  `capacitor-sqlite` on the emulator. It checks:
  - transactions and rollback on error;
  - `ON CONFLICT` and row ids;
  - `exportBytes` and `replaceWith`;
  - one migration step;
  - two writes at once where one fails.
- **`storage-check`.**
  - Identical copies pass.
  - Each of these must fail: one changed value, a missing row, an extra row, `1` against `1.0`, a
    changed schema line, a different `user_version`.
- **`storage-move`.** Two `node-sqlite` files stand in for `localStorage` and the phone's file.
  - A full test fixture moves and passes its checks.
  - **A forced failure** at every step, and in the middle of writing the file:
    - `localStorage` is unchanged;
    - the candidate is removed;
    - the app is back where it was before.
  - **A simulated kill.**
    - A child process runs the move and is killed, a real process kill rather than a thrown error.
      This happens at 20 points spread over steps 2–6.
    - A fresh process then starts.
    - The startup table (§2.2) must give the right answer, "Continue" must finish, and the final
      checks must pass.
    - No run may end with both copies unusable, or with both claiming to be in use.
  - **Low space.**
    - The free-space check refuses, with the right numbers.
    - A write that runs out of room midway (simulated with SQLite's `max_page_count`) cleans up.
  - **Every row of the startup table in §2.2.**
  - **The rules for "Move data back" and "Delete the old copy":** the 90% limit, a backup since the
    move, and the confirmation.
- **Known-answer tests for `backup-crypto`.**

### 5.2 Chromium (UI suites)

- The move from the real `localStorage` database to a stand-in target, with a page reload in the
  middle. The move must continue correctly.
- The Data Backup page:
  - the move button and its progress;
  - the "interrupted" prompt;
  - the old-copy panel;
  - the storage meter's text.

### 5.3 Emulator

These tests are scripted. `scripts/phone-test.ps1` gets a "storage move" check.

- **E1: update over the current version.**
  1. Install a copy of the APK your phone has now (the 9d7fd97 build, SHA-256 `7dc29db3…a2ef`).
  2. Add realistic test data: the full test fixture plus about 1,000 typical entries.
  3. Install the new build with `adb install -r`.

  Then:
  - the data is still there (an update, not a reinstall);
  - the move runs and its checks pass;
  - the 7 phone checks pass.
- **E2: near the old limit.** The same as E1, but with `localStorage` filled to about 95% of its
  limit (about 12,000 entries). Measure how long the move takes.
- **E3: kills.**
  - Force-stop the app inside each step. A test-only slow-down makes each kill land in the right
    step.
  - Reopen it. "Continue" must finish and pass the checks, or "Not now" must leave the app working
    on `localStorage`.
- **E4: low space.** Fill the emulator's storage with a large file until less than the needed space
  is free. The move must refuse with the message and change nothing.
- **E5: Auto Backup.**
  1. Using the local transport, run `bmgr backupnow` and note the size against 25 MB.
  2. Uninstall and reinstall the app (emulator only).

  Then:
  - the database file, the marker and the old copy are restored;
  - the app opens on the file;
  - the snapshots are not restored, as decided.
- **E6: the way back.** Move the data back, then move it again, then delete the old copy.

### 5.4 Real phone, later, with test data only

- **Only after E1–E6 pass.**
- **Only on a Plannr install with no real data in it.** `phone-test.ps1` stops if Plannr is already
  installed, unless you tell it otherwise.
- **It covers:** the same as E1, plus E5 with Google's own backup transport.
- **Your real data moves only after this passes and you approve.** That is a separate step.

---

## 6. Build order

About 30 minutes per part. Each part is one commit, followed by the full suite (node tests in both
passes and all UI suites). The UI suites are listed only where a part adds or changes one.

**Stage A: host services and backup code. Storage does not change.**

| Part | What | Tests |
|---|---|---|
| A1 | Known-answer files: encrypt test bytes with today's Node version and today's browser version, and commit both files | Each file opens with both versions |
| A2 | `core/backup-crypto.js` (WebCrypto, scrypt supplied by the platform). The phone switches to it | Known-answer tests; `test:backup-crypto`; round-trip suite |
| A3 | `server.js`, `backup-db.js` and `decrypt-db.js` switch to it. The root `backup-crypto.js` becomes a wrapper | Backup tests in both passes; `backup-db.js` run against a copy of a test fixture |
| A4 | `core/host.js`: the list of platform services, `checkHost()`, and one host object per platform | Each host passes `checkHost`; a fixed `now()` in tests |
| A5 | The PDF route moves into the core and calls `host.pdf.render` | PDF tests in both passes; guard test |
| A6 | The backup reminder routes move into the core | Reminder tests in both passes; a fixed-clock "days since" test |
| A7 | JSON export and import move into the core (`host.snapshot.writeJson`) | Backup tests in both passes; round-trip suite |

**Stop point: report.** Stage A can be pushed on its own (with your OK).

**Stage B: the async database interface. The phone stays on `localStorage`.**

| Part | What | Tests |
|---|---|---|
| B1 | The adapter interface and the `node-sqlite` adapter | Contract suite (Node) |
| B2 | The `wasm-kvvfs` adapter | Contract suite in Chromium |
| B3 | The request queue in the core | Two writes at once, one failing |
| B4 | `transaction(fn)`; the migration runner becomes async | Migration fixture tests |
| B5–B9 | `db.js` becomes async: 179 call sites, about 36 per part | Full suite after each part |
| B10–B12 | `repo.js` becomes async: 76 call sites | Full suite after each part |
| B13 | `backup-format.js` becomes async | Backup tests in both passes |
| B14–B16 | `core/` (ledger CRUD, the Overview PDF and the 9 route files) becomes async | Full suite after each part |
| B17 | `server.js`, `local-api.js` and `local-snapshot.js` become async; the synchronous methods are removed | Full suite; guard test |
| B18 | Emulator: time a full Overview on a large test fixture, before and after | Should be no slower in use |

**Stage C: the Android database file and the move.**

| Part | What | Tests |
|---|---|---|
| C1 (2 parts) | **Spike, in a test build, not committed.** Install the plugin and check on the emulator: the 12 `ON CONFLICT` statements, transactions, `journal_mode`, `VACUUM INTO`, replace and reopen, how to place a file, the file's path, the APK size, and speed with 12,000 rows | Spike script (scratchpad). **Stop and report** |
| C2 | Plannr's own Java helper: free space, file sizes, write + fsync + rename | Emulator script |
| C3 | The `capacitor-sqlite` adapter (the plugin is added to `package.json` here, pinned) | Contract suite on the emulator |
| C4 | `core/storage-check.js` | The §5.1 storage-check tests |
| C5 | `core/storage-move.js`: the steps, the progress record, the startup table | Every row of the §2.2 table |
| C6 | A forced failure at every step; real process kills at 20 points | §5.1 kill tests |
| C7 | Low space: the check before the move, and running out of space midway | §5.1 low-space tests |
| C8 | The way back, the emergency path to the old copy, and deleting the old copy | §5.1 rules tests |
| C9 | Startup: choose the storage from the marker; the recovery screen | Chromium test with a stand-in native adapter |
| C10 | Data Backup page: the move button, progress, the "interrupted" prompt, the old-copy panel | New UI suite |
| C11 | Encrypted export and restore, and `/api/storage`, move into the core: real file size, new meter levels and texts, "Storage is full" text for each kind of storage | Both passes; storage-limit suite updated |
| C12 | Auto Backup rules (§3.1) | Storage-limit budget check updated |
| C13 | Emulator E1 (update over the current version) | Script |
| C14 | Emulator E2 (near the old limit) | Script |
| C15 (2 parts) | Emulator E3–E6 (kills, low space, Auto Backup, the way back) | Script |
| C16 | Checklist and plan documents | Doc review |

**Stop point: your OK before the real-phone check (§5.4), and a separate OK before your real data
moves.**

**Stage D: the desktop file adapter (Electron itself comes in Phase 4).**

| Part | What | Tests |
|---|---|---|
| D1 | `node-sqlite` adapter on a file path, with `exportBytes`, `replaceWith` and `info`; encrypted restore works on desktop | Restore tests in both passes; the 501 test is replaced |
| D2 | `userData` path per operating system (a plain function, wired in at Phase 4) | Path tests for Windows, macOS and Linux |

**Size of the work.**

- About 45 parts, so roughly 22–23 hours of work.
- The spike, the emulator parts and the `db.js` parts are the ones most likely to run over.
- The main plan's estimate for this work (11–16 working days) allowed for that.

---

## 7. Decisions needed before starting

- **D1. Numbering.** This "step 1.4" covers:
  - main plan step 1.4;
  - main plan Phases 2 and 3;
  - the desktop adapter from main plan step 4.1.

  The main plan gets a pointer to this file.
- **D2. Safety snapshots leave Auto Backup.**
  - They are backed up today. You asked for them to be left out, and this plan does that.
  - After a phone is restored from Google, the snapshots are gone. The data itself is not
    affected.
- **D3. The old `localStorage` copy stays in Auto Backup while it is kept.** That way a restored
  phone still has the way back. It uses up to about 10 MB of the 25 MB.
- **D4. Plannr's own Java helper** (about 60 lines, no new dependency) handles free space, real file
  sizes, and the write + fsync + rename.
- **D5. The meter's thresholds.**
  - It warns when the backup estimate reaches 20 MB, and warns strongly at 23 MB.
  - Low free space on the phone also warns, below 100 MB.
- **D6. The plugin is installed in a test build first (C1).** It is added to `package.json` only at
  C3, after the spike report.
- **D7. No files are deleted.** The root `backup-crypto.js` stays, as a wrapper.

---

## 8. Progress

The owner approved this plan and decisions D1–D7 on 2026-11-16.

- **A1 (2026-11-16):** the known-answer files are in `test/fixtures/backup-kat/`.
  - Two files hold the same 2,048 test bytes. They were encrypted once by each version in use
    before step 1.4:
    - `node-v1.plbk`, made by `backup-crypto.js` in Node;
    - `browser-v1.plbk`, made by `public/backup-crypto.js` in Chromium.
  - `manifest.json` records the passphrase, the SHA-256 of each file, and how each was made.
  - **The checks:**
    - `test/backup-kat.test.js` opens both files with both versions and rejects a wrong passphrase.
    - It also rebuilds each file byte for byte from its own salt and IV using `node:crypto` alone,
      which pins the format independently of both versions.
    - `test-ui/backup-crypto.js` opens both files in Chromium.
  - **Why `.plbk`:** the files end in `.plbk`, not `.db.enc`, so the `.gitignore` rule that keeps
    real encrypted backups out of git stays as it is.
  - **Line endings:** `.gitattributes` marks the files as binary, so git never changes their line
    endings.
- **A2 (2026-11-16):** there is now one encryption, `core/backup-crypto.js`.
  - It uses WebCrypto AES-256-GCM. The platform supplies scrypt through
    `createBackupCrypto({ scrypt })`.
  - The format is unchanged: the A1 files open with it, and every file it writes is rebuilt byte
    for byte by the layout check.
  - **The phone uses it now.** `public/backup-crypto.js` only supplies scrypt-js (`window.scrypt`)
    and re-exports the rest. Its API is unchanged, so `local-api.js` needed no edit. A test checks
    that it has no encryption code of its own.
  - **The desktop still has its own code** (`backup-crypto.js`, `node:crypto`) until A3.
  - **Tests:** the core file, with scrypt-js and with `node:crypto`, opens both A1 files. Both
    scrypt functions derive the same key. The desktop version opens the core's files.
- **A3 (2026-11-16):** the desktop uses `core/backup-crypto.js` too, and its own encryption code
  is gone (owner's approval, 2026-11-16).
  - **What `backup-crypto.js` is now:** a thin entry point. It supplies `node:crypto`'s scrypt,
    which gives the same key as scrypt-js, and gives Node callers Buffers. The file is kept so
    `backup-db.js`, `decrypt-db.js` and `backup-db.cmd` keep working.
  - **`encrypt()` and `decrypt()` now return Promises.** The export route in `server.js`,
    `backup-db.js`, `decrypt-db.js` and the tests now wait for them.
  - **Tests:**
    - Both golden files open through both platforms' entry points, and a wrong passphrase is
      rejected.
    - Neither entry point has encryption code of its own.
    - The golden files' passphrase is labelled a test value in `manifest.json`, and no other file
      contains it.
    - `test/backup-cli.test.js` runs `backup-db.js` and `decrypt-db.js` as real processes, only on a
      throwaway database in the temp folder. It checks the snapshot is encrypted and verified, the
      passphrase is never printed, the source is unchanged, a wrong passphrase is refused and
      nothing is written, and both golden files decrypt.
- **A4 (2026-11-16):** `core/host.js` lists the platform services the core may call.
  - `checkHost()` runs when each platform starts, so a missing service fails at startup.
  - `hostError(status, message)` lets a platform refusal reach the page exactly as worded.
  - **Two services so far:**
    - `pdf.render(html, { part })`: Playwright, with its render slots, on the dev server; the
      print-adapter plugin on the phone.
    - `snapshot.writeJson(backup)`: a file beside the database on the dev server;
      `safety-snapshots.js` on the phone.
  - **Both platforms build their host and pass it to the core as `ctx.host`.** Their PDF route and
    JSON import now call it.
  - **The answers are unchanged:** 503 "busy" and 503 "unavailable" on the server; 503 "needs the
    Android app", 500 plugin missing, and 500 unexpected result on the phone. Plain refusals are not
    logged, as before.
  - **Tests:** `test/core-host.test.js`.
- **A5 (2026-11-16):** the Overview PDF route is in the core (`core/routes/pdf.js`).
  - The route checks the query, builds the page (`core/overview-pdf.js`), renders it through
    `host.pdf.render`, sets the file name with the IST date, and passes a `hostError` on with its
    own status and message.
  - Each platform now keeps only its renderer.
  - The guard test checks that neither copy still defines the route. The old copies were confirmed
    to be flagged before the move.
- **A6 (2026-11-16):** the backup reminder routes are in the core (`core/routes/backup-reminder.js`):
  `GET`/`PUT /api/backup/reminder` and `POST /api/backup/mark-exported`.
  - `now` joins the host services. Both platforms give `now: () => new Date()`.
  - `mark-exported` stamps `host.now()` in the same `YYYY-MM-DD HH:MM:SS` UTC shape as before, instead
    of SQLite's `datetime('now')`. The answers are unchanged.
  - **Tests:** `test/backup-reminder.test.js`, in both passes. Over HTTP: never exported, a stamp,
    off, the limits 1 and 365, refusals, and a bad stored value. With a fixed clock: 6 days 23:59:59
    reads as 6, exactly the threshold is not overdue, the next day is, and a clock set back reads 0.
- **A7 (2026-11-16):** the JSON export and import are in the core (`core/routes/backup.js`).
  - The import keeps its order: check the file, save the safety copy through
    `host.snapshot.writeJson`, then replace in one transaction (`backup-format.js`). The answers are
    unchanged. The dev server still names the download; the phone ignores the header.
  - Neither platform keeps its own `buildBackup` or `validateBackup`. The startup drift guard runs
    when the core route registers.
  - The encrypted backup routes stay with each platform until stage B gives the adapter
    `exportBytes` and `replaceWith`.
  - **Tests:** `test/backup-routes.test.js`, in both passes: the download name, a refused file makes
    no safety copy, a failed safety copy changes nothing, and the copy is taken before the replace.
- **Stage A is done.** Nothing in it changed where or how data is stored.

**Stage B (started 2026-11-16 after your OK of stage A; B1–B3 only, then stop before B4).**
Before it: the branch was saved as a git bundle in `D:\Backups\plannr\`.

- **B1 (2026-11-16):** the adapter interface and the `node-sqlite` adapter.
  - `core/db-adapter.js`: the method list, `checkAdapter()`, and `createSyncEngineAdapter()`, which
    builds the async interface over any handle with the `DatabaseSync` surface (`node:sqlite` now,
    sqlite-wasm in B2). Prepared statements are cached per handle and dropped when the database is
    replaced. `params` is always an array. The transition methods are `prepare(sql)` and
    `execSync(sql)`; they go in B17.
  - `db-adapter-node.js` (Node only, not copied to `public/`): `exportBytes` (`VACUUM INTO` a temp
    file), `replaceWith` (SQLite header and `integrity_check` first, then write + fsync + rename,
    refused while a `-journal` or `-wal` is beside the file), `info` (size on disk).
  - Nothing uses them yet: `db.js` still opens its own handle until B5.
  - **Tests:** `test/adapter-contract.mjs` (13 cases, no Node imports, so B2 can run it in
    Chromium) and `test/db-adapter-node.test.js` (the cases on a file and in memory, plus the
    file-only checks). The suite was checked against 5 deliberately broken adapters; each was
    caught.
- **B2 (2026-11-16):** the `wasm-kvvfs` adapter, `public/db-adapter-kvvfs.js` (the phone and the
  browser preview; not used by the app yet).
  - `exportBytes`: `sqlite3_js_db_export`. `info`: page count × page size.
  - `replaceWith`: kvvfs has no file to swap, so the new image is opened in memory and checked
    (SQLite header, `integrity_check`, `foreign_key_check`) before anything is touched, then copied
    over the live database in one transaction: tables and rows, the AUTOINCREMENT sequences,
    `user_version`, then indexes, triggers and views. A failure rolls back and leaves the data as
    it was. (`local-snapshot.js` keeps its own copy of this until C11 moves the encrypted restore
    into the core.)
  - **Tests:** `npm run test:db-adapter-kvvfs` (new UI suite): the 13 contract cases in Chromium,
    a replaced database is what the next open sees, and a refused replace leaves every
    `localStorage` record byte for byte as it was. It caught one real bug on the way (the size
    read through `PRAGMA page_size` came back empty on sqlite-wasm).
- **B3 (2026-11-16):** the request queue, `core/request-queue.js`: `createRequestQueue().run(fn)`
  runs one request at a time, in order, passes back each result or error, and never lets an error
  stop the requests after it.
  - **Not wired into `server.js` or `local-api.js` yet.** While every database call is synchronous,
    a request cannot be interrupted between two of them. It is wired in with the first async
    database call (B5). Then the slow part of a PDF (rendering finished HTML, no database) should
    run outside the queue, so a PDF does not hold up the next request.
  - **Tests:** `test/request-queue.test.js` (order, errors, size; two writes at once with one
    failing, through the queue and, as the known positive, without it: B's write is silently
    rolled back with A's, or B's transaction is refused). The contract suite gained the same case
    (now 14), so it runs on `node-sqlite` and in Chromium on `wasm-kvvfs`; with a do-nothing queue
    it fails.
- **Stopped before B4** (`transaction(fn)` in `db.js` and the async migration runner), as asked.
