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

**B4 (2026-11-17, after your OK, with your five conditions).** Before it: a new bundle of B1–B3,
`D:\Backups\plannr\plannr-phase2-2026-11-16-0e7b70b.bundle` (verified; the older one kept).

- **`db.js`:** `transaction(fn)` and `dbAdapter()`, the async interface (`core/db-adapter.js`)
  over `db.js`'s own handle. Only `get`, `all`, `run`, `exec` and `transaction` work through it
  yet; `exportBytes`, `replaceWith`, `info` and `close` say "stage B5".
  - `runMigrations(adapter, list)` is async. A step is `{ version, name, async up(tx) }`; each step
    and its version stamp run in one adapter transaction. If the step fails and the rollback
    fails too, the error says so and points to the safety snapshot, instead of "your data is
    unchanged".
  - `init()` is async: snapshot, then `legacyInit()` (the v2 baseline, unchanged), then the
    numbered steps. A refusal is a rejection.
  - `initSync()` is for `server.js`, `reset-db.js` and `seed-demo.js` until they can await (B17).
    It refuses, before changing anything, a database that needs a numbered step (there are none
    yet), so a new step cannot be skipped by them quietly.
  - The phone awaits it: `public/local-bootstrap.js` and `public/local-snapshot.js`.
- **One fix, a change of behaviour:** a v2 database from an older app that has not had one of
  the one-off clean-ups yet (its settings marker missing) ran them, the destructive ones
  included, **without a safety snapshot**. `migrationPlan()` now counts them, so `init()` takes
  the snapshot first. The old runner did not.
- **Condition 2, old and new runner give the same database** (`test/migration-equivalence.test.js`,
  `npm test`, 20 tests, about 5 s). `test/fixtures/schema-history/`: 8 databases, one for every
  distinct schema the 16 historical versions of `db.js` built (3 at user_version 1, 5 at 2), each
  with made-up rows in every table, stored as SQL with a checksum; the old runner is `db.js` and
  `ledgers.js` byte for byte as at 0e7b70b. Each fixture, with and without the approvals, is
  upgraded by the old `init()`, the new `await init()` and `initSync()`, each in its own process:
  same outcome, same schema and user_version, same sha256 of every table, same integrity and
  foreign-key checks; every snapshot is the database before the upgrade. The numbered-step
  runner is compared too (old sync steps v3–v5 against the new async ones, and with v4 failing).
  Known positive: two bugs put into `db.js` on purpose gave 12 failures.
- **Condition 3, a failure at every step** (`test/migration-faults.test.js`, `npm test`, about
  12 s; `test/slow/migration-faults-v1.test.js`, `npm run test:slow`, about 30 s).
  - Numbered steps (a test chain v3–v5, every fixture): a failing step leaves the database exactly
    as before that step, the snapshot is the database before the upgrade, and the next start
    finishes. Known positive: a rollback turned into a commit fails it.
  - The v2 baseline, every write: each fixture is upgraded once while every write is recorded,
    then once per write (the first time each statement runs, and every BEGIN/COMMIT) with that
    write failing, then started again. At every point: the failure is reported, user_version is
    not raised, the snapshot holds the database exactly as it was, no row is missing and no
    value is anything but its old or new value, the file is sound. For the v2 fixtures the next
    start always finishes with exactly the uninterrupted result. Known positive: no snapshot
    fails it.
- **Found by the failure tests, then fixed (options 1 and 2, your OK of 2026-11-17): a v1 database
  whose upgrade fails part-way.** The v1 part of `legacyInit()` is several transactions and was not
  safe to run again once partly done. For a failure in the last 52 of about 115 failure points (per
  v1 fixture, after its first table rebuild commits, up to the final version stamp), the data was
  all there right after the failure (condition 3 held), but:
  - every next start refused, and before refusing **dropped `contract_services` with all its
    rows**: the old-shape check at the top of `legacyInit()` ("user_version below 2 and no
    `tenant_id` column") mistook the rebuilt table for the pre-Phase-5 one;
  - each refused start took another snapshot, so after three more the good one was rotated out.
  - Who could reach it: only a database made before 2026-08-23 that is upgraded now, and only if
    that upgrade fails part-way (a crash, a full disk). Phone installs were made at v2. Both
    runners, old and new, behaved the same.
  - **Fix 1 (`db.js`, `legacyInit()`):** a `contract_services` with the Services-phase columns is
    never taken for the old one, whatever the version. An unrecognised old table that still holds
    rows is never dropped: it is renamed to `contract_services_pre_phase5` with its rows (a new
    empty table is made as before; an empty old one is still dropped).
  - **Fix 2 (`db.js` on the desktop, `public/safety-snapshots.js` and `local-bootstrap.js` on the
    phone):** the snapshot taken before an upgrade is kept until an upgrade finishes. The first
    snapshot of an upgrade is recorded in `safety-snapshots/plannr-upgrade-pending.json`; while that
    record names a snapshot that is there, no clean-up deletes it (it counts as one of the 3). The
    record is removed once `init()` (or `initSync()`) completes. If it cannot be read, nothing is
    deleted.
  - **Result:** no failure point loses anything any more. 105 of 115 per v1 fixture now finish on
    the next start with exactly the uninterrupted upgrade. The other 10 (the last steps, up to the
    version stamp) refuse once ("no such column: contract_allowance_id") and finish on the start
    after that, again exactly as uninterrupted; the snapshot from before the upgrade is there
    throughout. `npm run test:slow` pins both numbers.
  - **Tests:** `test/upgrade-retry.test.js` (`npm test`, 6 tests): a half-upgraded v1 table keeps
    every row and the start finishes as if never interrupted; an old table with rows is set aside,
    an empty one dropped; five failed starts in a row keep the first snapshot, never more than 3,
    and it rotates out once an upgrade finishes; `initSync()` clears the record; an unreadable
    record deletes nothing. `test/safety-snapshots.test.js` gained 7 phone cases. Undoing each
    part of either fix (6 ways) fails these tests.
  - **Full suite after the fix:** all passes; `npm test` 444 tests (13 new), 0 failures; the phone
    pass is unchanged (182 of 199, the same 17 known differences); `npm run test:slow` passes.
    No slowdown: the UI suites take the same time on the code before and after the fix.
  - **Still open (option 3, not asked for):** make those last v1 steps safe to run again, so even
    the one refused start does not happen.
- **Test isolation:** each test file now gets its own temp folder (`test/helpers.js`), and the four
  spawned guard fixtures make their own. They used to share the system temp folder, where an
  upgrade's safety snapshots were left behind.
- **Condition 4, emulator `plannr-test`:** the 0e7b70b build was installed and filled through the
  app's own API with the made-up full dataset (`test/fixtures/full-dataset.js`: a row in every
  table), every row and the Overview figures recorded; then the B4 build was installed over it.
  - The install over it succeeded; every row of every table (13 tables, 590 rows), the
    AUTOINCREMENT counters and user_version 2 are unchanged; no upgrade step ran, so no new
    snapshot; no startup error.
  - Every Overview figure is the same as before. (The category names on the Overview now show
    the renamed ones in the database; the old build had them cached from before the test data
    was written straight into the database. Days remaining moved by one: a day had passed.)
  - The app works: a new entry saves and is listed, delete moves it to the Recycle Bin and
    restore brings it back, the JSON backup exports, all 9 pages open, no console errors.
    (Three of these checks first failed because the test script read the wrong response
    fields and opened a page name that does not exist; fixed in the script, then passed.)
- **Full suite:** all passes. `npm test` 431 tests (409 before; the 22 new ones), 0 failures; the
  phone pass is unchanged: 182 of 199, the same 17 known differences. `npm run test:slow` passes.
  Timing: `npm test` went from about 15 s to about 27 s, all of it the new equivalence and fault
  tests (they start up to 8 processes); the UI suites take the same time as before.
- **Stopped before B5** (switching the queue on), as asked. Nothing pushed.

**B5 (2026-11-17, after your OK): the request queue is switched on, and the first part of `db.js`
is awaited.** Before it: B4 and its fix were already saved as
`D:\Backups\plannr\plannr-phase2-2026-11-17-d5f68a9.bundle` (verified; the older ones kept).

- **The queue is on, on both sides.** `core/request-queue.js` gained `queuedRoutes(app, queue)`:
  a route registered through it runs its handler (the last function) inside the queue; anything
  before it (`auth`) runs as before.
  - `server.js` makes one queue and registers every `/api` route through `api` (the core route
    files and its own four `/api` routes); pages and static files stay on `app`.
  - `public/local-api.js` does the same: every route goes through `localApp`, now queued.
  - An error thrown in a route still gets the same answer: on the dev server it is passed to
    Express's error handler with `next` (Express 4 does not catch a rejected promise itself), on the
    phone the dispatcher catches it as before.
  - **The one exception is the Overview PDF** (`outsideQueue()`): its page is built from the
    database inside the queue (`ctx.exclusive`), and the render (Playwright, or the phone's print
    adapter; seconds, no database) runs outside it, so a PDF does not hold up the next request. The
    dev server's own limit of 2 renders at once is unchanged.
  - **Found while writing the test:** the phone's encrypted restore decrypts first (scrypt, which is
    async), so even before B5 a write sent during a restore could run in between, be answered
    "saved", and then be wiped by the restore. With the queue it waits and is kept.
- **`db.js`: `legacyInit()` is a generator.** Each converted database call is
  `yield q.get(sql, params)` (or `all`, `run`, `exec`) and gets its answer (or its error) back.
  - `init()` runs it with `runAwaited`: every call is awaited through the async interface, as the
    capacitor-sqlite adapter will need in stage C.
  - `initSync()` runs it with `runNow`: the same calls at once, through the adapter's transition
    methods, so `server.js`, `reset-db.js` and `seed-demo.js` still start synchronously until B17.
  - Why a generator: `initSync()` must stay synchronous until B17 (`server.js` and `repo.js`
    prepare statements as they load, and every test loads `server.js` synchronously), and an async
    function cannot be run synchronously. One generator with two runners keeps one copy of the
    frozen baseline instead of two. At B17, `yield q.x(` becomes `await tx.x(`.
  - **Converted in B5: 40 of the file's 180 direct calls**, everything from the top of
    `legacyInit()` to the end of the `cash_out` phase/subpart step (the owner row, the old
    `contract_services` check, the table creation, the category seed, the column additions and the
    phase/subpart rebuild). A marker line shows where B6 starts. The other 140 are B6–B9.
- **Tests (new):**
  - `test/request-queue.test.js` (+6): routes through `queuedRoutes` run one at a time and keep
    `auth`; errors reach Express (`next`) or the phone (a rejection); the PDF page waits for a request
    ahead of it, and a request is answered while a PDF renders. Known positives in the file: a
    do-nothing queue interleaves; a PDF route queued as a whole holds the next request until the
    render ends.
  - `test/request-queue-wiring.test.js` (3, both passes): every `/api` route of the code under test
    is queued except `GET /api/overview/pdf`; a request waits while the queue is held and is answered
    when it is released (on the dev server a page is answered meanwhile); an error in a queued route
    still answers "Something went wrong.".
  - `test/db-init-async.test.js` (2): `init()` lets other code run between its calls (at least 40
    times on a new database) while `initSync()` does not; both build the same database; a failing
    call rejects with its error, the category seed is rolled back, and the next start finishes.
  - `test/migration-equivalence.test.js`: every write is now recorded. For all 16 fixture runs, the
    old runner (0e7b70b), `await init()` and `initSync()` make exactly the same writes in the same
    order (the safety snapshot aside, which is checked separately).
  - `test/upgrade-retry.test.js` (+1, 1d): the two old `contract_services` shapes (no fixture has
    them) give the same writes and the same database through `initSync()` and `await init()`.
  - `test-ui/backup-roundtrip.js` (+2, phone code in Chromium): a write sent during an encrypted
    restore is answered after it and kept.
  - Guards updated: `test/core-routes.test.js` (route files register on `api`), `test/core-host.test.js`
    (the PDF page is built inside the queue).
- **Known positives (each part undone on purpose, the tests run, then put back):** no queue at all
  (4 test files fail, including the phone's write being wiped in Chromium); `init()` not awaiting;
  the seed's rollback removed; the awaited runner swallowing a failed call; the immediate runner
  answering no row (all calls, or only the old-shape checks); the awaited runner giving back a stale
  answer. All 7 were caught. (The narrow "old-shape checks only" one was missed at first, because
  no fixture has the old table; test 1d was added for it.)
- **Full suite:** all passes. `npm test` 456 tests (444 before; the 12 new ones), 0 failures, the
  same 3 skipped; the phone pass is 185 of 202 (the 3 new wiring tests pass there too), the same 17
  known differences. All 13 UI suites pass. `npm run test:slow` passes.
- **Timing: no slowdown.** Measured against the code before B5 (d5f68a9) on this machine, in turn,
  at least twice each (old, then B5):
  - a new database's start: `init()` 220/228 ms, then 213/229 ms; `initSync()` 199/281 ms, then
    223/274 ms;
  - through `server.js`: 400 saves one after another 11.4/11.1 s, then 8.9/10.6 s; 400 Overviews
    7.5/6.6 s, then 6.4/7.0 s; 4 × 100 requests at once 5.3/5.6 s, then 5.7/5.7 s;
  - `npm test` (the server pass) 19.4/24.1 s, then 21.7/22.9 s, with the 12 new tests;
  - `npm run test:slow` varied from 49 to 220 s on the same code within the hour (old code 52-166
    s, B5 49-220 s; B5 was the faster one in 2 of 3 pairs): the machine's load, not B5.
- **Not done in B5:** no emulator check (the phone code ran in Node and in Chromium only); the
  other 140 calls (B6–B9).
- **Stopped after B5**, as asked. Nothing pushed.

**Finishing step 1.4 (from 2026-11-18, working on my own, after your written go-ahead).** The
choices made on the way are in the session report's DECISIONS list.

- **Before:** the full suite at 28f4927 passed (`npm test` 456 tests, 0 failures, 3 skipped; the
  phone pass 185 of 202, the same 17 known differences; 13 UI suites; `npm run test:slow`).
- **1a, the B4 tests again:** `migration-equivalence`, `migration-faults`, `upgrade-retry` and
  `db-init-async` are already permanent; run on their own: 31 of 31 pass, and `test:slow` 2 of 2.
  No new code was needed.
- **1b, emulator `plannr-test`, B5 over the B4 build (12a5c42, the build last on it):**
  - the B4 build was filled with the made-up full dataset plus 373 writes through the app's own API
    (13 tables, 590 rows); then the B5 build (28f4927) was installed over it;
  - every row, AUTOINCREMENT counter and user_version 2 unchanged; no upgrade snapshot; every
    Overview figure the same;
  - save, edit, delete, Recycle Bin and restore work; an encrypted export, then a restore with a
    cash-in sent during it: the restore ran first, the cash-in after it, and the cash-in was kept;
    still there after a restart; all 9 pages open;
  - the only console message is Capacitor's own "Error injecting safe area CSS", when a script
    switches pages very fast (its SystemBars plugin; not Plannr code).
- **B6 (2026-11-18): 25 more calls awaited**, from the `tx_date` columns to the Phase 5B
  `cash_out` rebuild (the counter restore, the foreign-key check, `contract_stated_paise`) and the
  old services index. The marker line moved down. 65 of 180 done.
  - **A gap found first.** Undoing two of these calls on purpose (the `cash_in` `tx_date` backfill;
    the `cash_out` counter restore) failed no test: the 8 schema-history fixtures all start at
    user_version 1 or 2, so they never reach the parts of `legacyInit()` written for older
    databases. A coverage run listed them: the `tx_date` backfills, the phase/subpart and Phase 5B
    rebuilds, adding `tenant_id` (by ALTER and by rebuild), the settings rebuild, the custom-name
    backfill, the owner row on an old database, and the approvals read from settings.
  - **New fixtures, `test/fixtures/legacy-shapes/`:** three made-up databases at user_version 0,
    built by `make-legacy-shapes.js` from schema-history fixture 01 (stored as SQL with a checksum;
    the dump is checked to load back to the same database):
    - `L1-pre-tenancy.sql`: before tenancy, `tx_date` and Phase 5B (`cash_out` keeps
      `contract_service_id` and `units_covered`); loans empty; old settings shape; the taxonomy move
      already done;
    - `L2-phase-custom.sql`: the old text phase/subpart design with the custom names; the service
      price drop approved in settings;
    - `L3-no-users.sql`: L1 with no users, before the taxonomy move, both approvals in settings (so
      the `cash_out` wipe runs).
  - With them, every pre-v1 branch runs except the "cannot happen" throws.
  - **`test/migration-legacy-shapes.test.js`** (`npm test`, 12 tests, about 20 s): each shape,
    with and without the approvals, through the old runner (0e7b70b), `await init()` and
    `initSync()`: the same outcome, the same writes in the same order, the same database, the
    snapshot is the database before. What each branch did is read back from the result (dates
    backfilled, every `cash_out` row, id and counter kept, the phase/subpart mapping, the owner row,
    the approved wipe, the refusal leaving the version unstamped). Then every COMMIT of each
    approved upgrade is made to fail in turn: the three runners give the same error, writes and
    database, and the file is sound.
  - **Known positives:** the two undone calls above now fail 6 tests each.
- **B7 (2026-11-18): 53 more calls awaited**, the Tenancy Phase 2 block (adding `tenant_id`: the
  per-table check, the ADD COLUMN or rebuild, the settings rebuild, the per-tenant contract index),
  the Services-phase columns, the Part E custom-name backfill and the Phase 6C indexes. The two
  helpers (`rebuildAddingTenant`, `addTenantId`) are generators run with `yield*`; the
  `TENANT_TABLES.filter(...)` callback became a loop (a callback cannot yield), with the same calls
  in the same order. 118 of 180 done.
  - **Known positives** (against `migration-legacy-shapes`): running `addTenantId` without `yield*`
    (10 of 12 fail), dropping the counter restore in the tenant rebuild (8 fail), backfilling custom
    names to the wrong owner (9 fail).
- **B8 (2026-11-18): 38 more calls awaited**, the Tenancy Step 2a collapse (the purge of other
  households' rows, the settings and per-table rebuilds dropping `tenant_id`, the index swap, the
  row-count guard and the foreign-key check). `rebuildDroppingTenant` is a generator run with
  `yield*`. 156 of 180 done.
  - **Another gap, closed the same way.** Making the purge count nothing (`deliberatelyRemoved += 0`)
    failed no test: no fixture had a second household's rows. Two more legacy shapes, built from
    fixture 01 as it is (user_version 1, `tenant_id` everywhere):
    - `L4-two-households.sql`: a second user owns a copy of one row in each tenant table and two
      settings rows (one under a key the first household also has). After the upgrade: exactly the
      first household's rows, its value for the shared key, and the other key kept.
    - `L5-two-households-cascade.sql`: L4, and the second household's contract has a payment date.
  - **Found with L5, not changed (the baseline is frozen):** the purge deletes that contract first,
    `ON DELETE CASCADE` takes its payment date with it, and the row-count guard does not count the
    cascade, so the first start refuses ("row-count guard failed for contract_payment_dates")
    before stamping the version. Nothing beyond the intended removal is lost and the snapshot is
    kept; the next start finishes. The old runner (0e7b70b) cannot finish that second start: it is
    the B4 bug (it drops the rebuilt `contract_services`), which the new runners do not have. Only
    test databases ever had a second household; phone installs were made at v2. The test pins all
    of this.
  - `migration-legacy-shapes` is now 18 tests (5 shapes).
  - **Known positives:** `rebuildDroppingTenant('cash_in')` without `yield*` (12 of 18 fail), the
    purge counting nothing (4 fail), the counter restore dropped (12 fail), the settings dedupe
    counted as 0 (2 fail).
  - **Full suite:** the first run had one failure, a flaky cleanup in `test/runtime-mode.test.js`
    (Windows refused to delete the test's temp database 300 ms after the spawned server was killed;
    the test passed alone 3 times out of 3). The cleanup now waits for the process to exit and
    retries the delete. `npm test` again: 474 tests, 0 failures, the same 3 skipped; phone pass
    185 of 202, the same 17 known differences. The 13 UI suites and `test:slow` passed in that run.
- **B9 (2026-11-18): the rest of `legacyInit()` is awaited** (24 calls: Contract Phase A, the
  service-price drop, the taxonomy wipe and its guard, the generic-name renames, the version stamp).
  The `rename` statement prepared once and run five times became five `yield q.run` of the same SQL
  (both runners still prepare it once). **Every database call in `legacyInit()` is now awaited by
  `init()`.**
  - **The upgrade plan too.** `migrationPlan()` read the database directly, and the phone's start
    called it before `init()`. It is now a generator like `legacyInit()`: `planMigrations(adapter)`
    awaits it (used by `init()` and by `public/local-bootstrap.js`), and `migrationPlan(handle)`
    runs it at once (`initSync()` and tests, until B17). So `init()` and the phone's start make no
    synchronous database call any more, except the desktop's own safety snapshot (`VACUUM INTO`,
    Node only; it moves to the adapter's `exportBytes` at D1).
  - **Tests:** `test/migrations.test.js` (+2): `planMigrations` gives `migrationPlan`'s answer for 8
    kinds of database (new, v1, v2 with and without settings and markers, current, newer), through
    an adapter that has only the async methods, each answering a tick later; `init()` and the
    phone's start plan through it.
  - **Known positives:** `planMigrations` run at once; the marker check never finding a missing
    marker; `init()` planning at once; the phone planning at once (also fails
    `npm run test:runtime-mode` in Chromium); the renames' parameters swapped (14 of 38 fail in
    the two equivalence files). All 5 caught.
  - **Full suite:** all passes. `npm test` 476 tests, 0 failures, the same 3 skipped; the phone pass
    187 of 204 (the 2 new tests pass there too), the same 17 known differences; 13 UI suites;
    `test:slow`.
- **B10 (2026-11-18): `repo.js` starts on the async interface** (overview, ledger list, custom
  ledger names, `authoredCount`).
  - `core/db-adapter.js` gains `statementOn(adapter, sql)`: one SQL text with `get/all/run(...params)`
    returning Promises, so `repo.js` keeps its statement objects and each caller only gains an
    `await`. The adapter prepares each text once; it also finds the connection at call time, so
    converted statements need no open database at import.
  - `ledgers.replaceAll` uses `db.js` `transaction()` instead of its own `BEGIN`/`COMMIT`.
  - **The ledger index** (`core/ledger-index.js`) now reads through the interface, so its
    `refresh()` returns a Promise. Each backend runs the first `refresh()` as its request queue's
    first job, so no request can read the list before it is filled. Reading it before then throws
    instead of answering with no categories. `server.js` starts listening only after it (`app._ready`);
    the phone's start awaits it and shows the start-up error if it fails.
  - Callers now await: the ledger-list and custom-name routes, the backup import's refresh,
    `computeOverview` and the upcoming payments (async), the Overview PDF's page builder,
    `saveLedgerCustom`, and `afterWrite` in `core/ledger-crud.js`. `seed-demo.js` reads the list in
    an async `main()` (checked on a scratch database).
  - **Tests:** new `test/repo-async.test.js` (3): every converted function returns a Promise; a
    `replaceAll` that fails on its last row leaves the list as it was; the index cannot be read
    before its first refresh.
  - **Known positives:** an un-awaited loan total in the Overview; an un-awaited custom-name list;
    `replaceAll` without its transaction; the index starting as an empty list; the server not
    queueing the first refresh. All 5 caught.
  - **Full suite:** all passes. `npm test` 479 tests, 0 failures, the same 3 skipped; the phone pass
    190 of 207 (the 3 new tests pass there too), the same 17 known differences; 13 UI suites;
    `test:slow`.
- **B11 (2026-11-18): `repo.contract.*` is on the async interface** (34 statements).
  - Every function returns a Promise. The contract's column-list `INSERT`/`UPDATE` now build SQL
    text only (the adapter prepares each text once), so `configure()` no longer prepares them.
    `writePayDates` is still not one transaction, as before; the request queue keeps other requests
    out in between.
  - Callers now await: every contract, service and allowance route; `contractRow` is async (it reads
    the contract's dates, services and allowances), and so are the Recycle Bin's list (one row at a
    time) and its restore and delete guards; the contractor-payment `validate` and the cash-out
    `finalize` (service and allowance links). `core/ledger-crud.js` awaits `validate` and
    `finalize` everywhere, the Save All loop included.
  - **Tests:** `test/repo-async.test.js` (+1): all 35 `repo.contract` functions return Promises, and
    what they wrote is read back. `test/contract.test.js` (+2) closes two gaps the known positives
    found: no test read a contract's payment dates, services and allowances back from the API, and
    none sent a payment for a contract that is deleted or does not exist.
  - **Known positives:** the payment dates not awaited (caught only after the new test); the
    payment's contract check not awaited (likewise); `finalize` not awaited on create; the Recycle
    Bin's single-contract guard not awaited; `liveCount` left synchronous. All 5 caught.
  - **Full suite:** all passes. `npm test` 482 tests, 0 failures, the same 3 skipped; the phone pass
    193 of 210, the same 17 known differences; 13 UI suites; `test:slow`.
- **B12 (2026-11-18): the rest of `repo.js`** (`crud`, `trash`, `backup`). `repo.js` now prepares
  nothing on the synchronous handle, and nothing at import.
  - Save All's batch write uses `db.js` `transaction()` (given to the core as `ctx.transaction`)
    instead of its own `BEGIN`/`COMMIT`. `configure()` has nothing left to prepare and is empty; the
    two backends still call it until B17.
  - Callers now await: every ledger list/add/edit/delete/Save All route in `core/ledger-crud.js`, and
    the Recycle Bin's list, restore and permanent delete.
  - **Tests:** `test/repo-async.test.js` (+1) reads the core, `server.js` and `public/local-api.js`
    and fails on any repo call (or async helper built on one) that is not awaited, returned or an
    arrow body. node:sqlite runs the SQL at call time, so no route test can see an un-awaited write
    whose answer is not read; this check can. `test/batch.test.js` (+2): a Save All whose last row
    fails in the database (a trigger) changes no row and leaves no transaction open; editing a
    deleted or missing row is a 404 alone and a held-back row in Save All (no test edited one).
  - **Known positives:** Save All without its transaction; the edit's existence check not awaited
    (caught by the guard); a service delete not awaited (guard); a Recycle Bin restore not awaited
    (guard); `existsLive` answering a Promise (caught only after the new test). All 5 caught.
  - **Full suite:** all passes. `npm test` 485 tests, 0 failures, the same 3 skipped; the phone pass
    196 of 213, the same 17 known differences; 13 UI suites; `test:slow`.
- **B13 (2026-11-19): `backup-format.js` is on the async interface.**
  - `buildBackup`, `applyBackup` and `assertImportOwnershipComplete` take the adapter and return
    Promises; the module's statement cache is gone (the adapter caches). `applyBackup` runs in
    `adapter.transaction()` with the same steps in the same order. `validateBackup` reads no
    database and stays synchronous.
  - The core's JSON backup routes await them and get the adapter as `ctx.adapter`. The import's
    ownership check (a table with a foreign key into an import-owned table must be owned too) now
    runs as a start job (`ctx.atStart`) in each backend's request queue, ahead of every request,
    with the ledger index's first refresh.
  - **Tests:** the ownership tests in `test/schema.test.js` await; `test/backup-routes.test.js`
    checks that the module asks for exactly one start job and runs it; the "every call is awaited"
    guard in `test/repo-async.test.js` now covers the three backup functions.
  - **Known positives:** the import without its transaction; the import's call not awaited (guard);
    the ownership check run directly instead of as a start job; the ownership check reading no
    tables. All 4 caught.
  - **Full suite:** all passes. `npm test` 485 tests, 0 failures, the same 3 skipped; the phone pass
    196 of 213, the same 17 known differences; 13 UI suites; `test:slow`.
- **B14 (2026-11-19): the settings routes are on the async interface** (the budget, the reminder
  times on Home, the backup reminder).
  - Each reads and writes its settings row through `ctx.adapter`. `getBudgetPaise()` answers with
    a Promise (the Overview and its PDF already await it); the backup reminder's helpers and every
    handler are async.
  - **Tests:** new `test/settings-routes.test.js` (2, both passes): the budget and the reminder
    times are written, read back through their own `GET`, refused when bad (nothing changes) and
    cleared. Until now no node test read either back. The fixed-clock reminder tests run over an
    in-memory `node-sqlite` adapter. The "every call is awaited" guard now also covers direct
    adapter calls (`adapter.`, `tx.`, `dbAdapter().`) and the settings helpers.
  - **Known positives:** the budget's `GET` not awaited; the budget clear not awaited (guard); the
    reminder times always reading as none (caught only by the new test); the backup reminder's
    upsert with its values swapped; the reminder times' save not awaited (guard). All 5 caught.
  - **Full suite:** `npm test` 487 tests, 0 failures, the same 3 skipped; the phone pass 198 of 215,
    the same 17 known differences; 13 UI suites. `test:slow` failed once on the timed PDF idle test
    (its 1.5 s idle window raced the test under load; nothing B14 touches), then passed twice when
    re-run; the test is fixed in the next commit.
- **B15 (2026-11-19): the people routes and the owner and user checks are on the async
  interface.**
  - `core/routes/people.js` reads the roster through `ctx.adapter`. `ctx.getOwner()` and
    `ctx.userExists()` answer with Promises in both backends; the cash-in and cash-out "By" checks
    (`resolveBy`, `resolveCashOutBy`) and their `validate` hooks are async.
  - The backends' `requireApiAuth` awaits the owner and passes a failure to `next()`. Nothing reads
    `req.user` today; the phone's shim never runs it (it runs only the last handler).
  - **Tests:** new `test/people-routes.test.js` (2, both passes): `/api/me` is the lowest-id user;
    `/api/users` lists only id and display name, by id (no test read it before); a "By" user that
    does not exist is refused on cash in and cash out and nothing is saved, and a real one is
    stored. The await guard covers the four helpers.
  - **Known positives:** the roster not awaited; the cash-in user check not awaited (an unknown user
    accepted); `userExists` always true on the dev server, and on the phone (phone pass); the owner
    read as the highest id. All 5 caught.
  - **Full suite:** all passes. `npm test` 489 tests, 0 failures, the same 3 skipped; the phone pass
    200 of 217, the same 17 known differences; 13 UI suites; `test:slow`.
- **B16 (2026-11-19): the core gets no synchronous database handle.**
  - After B13–B15 no file in `core/` used `ctx.db`, `.prepare(` or `rollbackQuietly`. Both backends
    now leave `db` and `rollbackQuietly` out of `coreContext`, so a core module that reached for them
    would fail at once.
  - **Tests:** `test/repo-async.test.js` (+1) reads every core file (except `core/db-adapter.js`, which
    implements the interface over an engine) and fails on `ctx.db`, a `db` destructured from `ctx`,
    `.prepare(`, `.execSync(` or `rollbackQuietly`; it also checks that neither backend's
    `coreContext` passes `db` or `rollbackQuietly`, and that both pass the adapter. CONTRIBUTING.md
    states the rule.
  - **Known positives:** a route destructuring `db` from `ctx`; `db` put back into the dev server's
    `coreContext`; `rollbackQuietly` put back into the phone's; a route preparing a statement on the
    adapter's transition method. All 4 caught.
  - **Full suite:** all passes. `npm test` 490 tests, 0 failures, the same 3 skipped; the phone pass
    201 of 218, the same 17 known differences; 13 UI suites; `test:slow`.
- **B17a (2026-11-19): `server.js`, `reset-db.js` and `seed-demo.js` start with the async
  `init()`.** B17 is done in three commits: this one, the phone's encrypted restore (B17b), then the
  removal of the synchronous methods (B17c).
  - `server.js` starts `init()` as it loads and makes it the first start job, so the ledger list's
    refresh, the ownership check and every request wait for it; the server listens only after all
    of them. A failure is reported as `[startup] could not start:` and the process exits 1.
  - `reset-db.js` counts and empties the tables once `init()` has finished; `seed-demo.js` awaits
    it first thing in `main()`, before its wipe. A seed of 1,800 rows made by the old and the new
    `seed-demo.js` on two new databases is identical (14 tables, `*_at` columns masked).
  - **Tests:** new `test/server-start.test.js`: a database saved by a newer Plannr stops the start
    with that message, nothing listens, and the file and its folder are unchanged.
    `test/reset-db.test.js` (+1): on a file that does not exist yet, the schema is made first (at
    the current version) and every table is reported empty. New `test/seed-demo.test.js`: a 60-row
    seed on a new database (no test ran `seed-demo.js` before).
  - **Tests wait for the start too.** Requiring `server.js` no longer sets the test database up, so
    `test/helpers.js` exports `H.ready` (= `app._ready`), its seed helpers fail with a clear message
    if called before it, and in the phone pass `startApp()` starts the phone's code only after it
    (the first full run showed two upgrades racing on one test file: 139 new phone failures).
    `backup-crypto.test.js` and `migrations.test.js`, which never started the app, await `H.ready`.
  - **Known positives:** `init()` not a start job (the start races it); its failure swallowed;
    `reset-db.js` without `init()`; `seed-demo.js` without `init()`; and for the test change:
    `backup-crypto.test.js` without `H.ready`, the phone's code started before it,
    `migrations.test.js` without it. All 7 caught.
  - **Full suite:** `npm test` 493 tests (490 pass, 3 skipped); phone pass 202 of 219, exactly the
    17 known differences; all 13 UI suites and `test:slow` pass.
- **B17b (2026-11-19): the phone's encrypted restore writes through the async interface.**
  `public/local-snapshot.js` rebuilds the live database through `dbAdapter()`: foreign keys off,
  then one `transaction()` that drops and recreates every table from the backup's own schema,
  copies the rows, the AUTOINCREMENT counters and `PRAGMA user_version`, then foreign keys on again
  (in a `finally`) and the foreign-key check. Only the platform parts stay on sqlite-wasm: exporting
  the live image and opening the incoming one. `rollbackQuietly` is no longer imported.
  - **Tests** (`test-ui/backup-roundtrip.js`, both new):
    - a restore whose last write fails half-way: the error is reported, the data is exactly as
      before, foreign keys are on again and the database is intact;
    - an encrypted backup made by an old Plannr (the schema-history fixture from 42ff006, schema v1
      with `tenant_id`) restores and comes back upgraded, with the same tables and row counts as the
      desktop's own `init()` makes of the same file (run in a child process).
  - **Known positives:** the rebuild outside a transaction; `user_version` not carried over (caught
    only by the new old-backup check); foreign keys left off; the AUTOINCREMENT counters not
    copied. All 4 caught.
  - **Found on the way, not fixed here (decision 11):** the two oldest schemas (v1, 7cfcf89 and
    2ebaf69) keep a legacy `sessions` table after their upgrade, and the start-up ownership check
    then refuses to start. Pre-existing; logged for the security and quality review.
  - **Full suite:** `npm test` 493 tests (490 pass, 3 skipped); phone pass 202 of 219, exactly the
    17 known differences; all 13 UI suites and `test:slow` pass.
- **B17c (2026-11-19): the synchronous transition code is gone.** Nothing called it after B17a and
  B17b, so `db.js` loses `initSync()`, `migrationPlan()` and `runNow()`; the adapter loses
  `prepare()`, `execSync()` and `TRANSITION_SYNC_METHODS`; `repo.js` loses its empty `configure()`
  and both backends stop calling it. `init()` is the only way to open the database.
  - The tests that compared `initSync()` with `await init()` keep comparing `await init()` with the
    old runner (0e7b70b), write for write, on all 8 schema fixtures; the plan tests keep
    `migrationPlan()`'s answers as known answers. `CONTRIBUTING.md` and `HANDOFF.md` say so.
  - **Tests:** new guard in `test/repo-async.test.js` ("B17: no synchronous start, plan or adapter
    method is left, and nothing calls one"): no module exports or defines a removed name, and no
    file outside the guard calls one; `test/db-adapter-node.test.js` checks the adapter has no
    synchronous method.
  - Two tests that only made sense with `initSync()` go: `upgrade-retry` 1d (a failed `initSync()`
    start) and 2b (the same through `initSync()`); their `await init()` twins stay.
  - **Known positives:** `initSync()` exported again; the adapter's `prepare()` back; a
    `repo.configure()` call left in `server.js`; the transition list exported again. All 4 caught.
  - **Full suite:** `npm test` 492 tests (489 pass, 3 skipped); phone pass 203 of 220, exactly the
    17 known differences; all 13 UI suites and `test:slow` pass.
- **B18 (2026-11-19): a full Overview on a large test fixture, before and after stage B (emulator
  `plannr-test`).** No code change.
  - **Data:** the full-dataset fixture plus 10,000 generated entries (10,004 cash-out, 503 cash-in
    rows; a 1.9 MB database in `localStorage`), put into the build from before stage B (9d7fd97, the
    same APK as the phone's, SHA-256 `7dc29db3…a2ef`). The stage B build (c8d9c2d) was then
    installed over it with `adb install -r`, then the old one again (`-r -d`) and the new one again,
    so each was timed twice on the same data.
  - **The same answer:** `/api/overview` gave byte-for-byte the same JSON (SHA-256 `9ab13bff…`) on
    every run of both builds, and no console errors.
  - **Speed** (median of 7 calls / 5 page loads; the PC was busy with other work):

    | | before stage B (9d7fd97) | after stage B (c8d9c2d) |
    |---|---|---|
    | `/api/overview`, ms | 199, 270 | 312, 199 |
    | Overview page until the figures show, s | 12.7, 9.3 | 11.4, 10.1 |

    So no slower in use: the differences between the two builds are smaller than between two runs of
    the same build. The page load (about 10 s with 10,000 entries, almost all of it the page's own
    work after the data arrives) is noted for the efficiency review.
  - **Desktop, same machine load** (`s18/bench.js`, alternating runs, A/B): a new database's
    `init()` 133/143 ms before (28f4927) and 181/183 ms after (+45 ms: every call is now awaited);
    400 saves 5,756/5,731 → 5,793/5,687 ms; 400 Overviews 5,391/5,570 → 5,425/5,498 ms; 4 × 100
    requests at once 1,439/1,602 → 1,259/1,437 ms. `npm test` 107 s (456 tests) → 121 s (492 tests).
