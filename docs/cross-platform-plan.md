# Plan: one shared core, real SQLite files, and a desktop app

Status: **approved by the owner on 2026-11-15**, with the decisions recorded in §9. Work goes one
step at a time, starting with step 1.1 (§8); each step's report comes back to the owner before
the next. Written 2026-11-15 on branch `plannr-phase2`.

Progress: steps 1.1 and 1.2 done on 2026-11-15 (see the notes under the §8 table).

Plannr stays single-user and offline everywhere. Each person on Android, Windows, macOS or Linux
has their own separate data. There is no sync, no server and no network. Data moves between
devices only as a backup file the person saves and opens themselves.

**Rules for the whole plan**

- The Android app keeps working exactly as before at every step.
- The owner's real data is not moved to the new storage until the owner has passed the real-phone
  test **and** approved this plan.
- Every step is one commit and ends with the full suite: today 223 node tests and 11 UI suites,
  growing as steps add tests. Nothing goes on if anything fails.
- These never change: `appId`, `server.androidScheme` and `server.hostname` in
  `capacitor.config.json`, and the two backup formats (JSON v2 and the encrypted `.db.enc`).
  Older backup files must still open.
- Every new dependency is named, justified and pinned to an exact version (§9, decision 2).
- No real data is moved, on any device, until the owner reports back from the real-phone
  checklist.

---

## 1. Where things stand (measured on 2026-11-15)

**Two copies of the API.**

- The desktop dev server, `server.js` (2,469 lines), answers `/api/...` with Express on
  `node:sqlite`.
- The phone uses `public/local-api.js` (1,824 lines), a fetch shim that answers the same
  `/api/...` inside the WebView on sqlite-wasm. That database is stored in `localStorage`
  (kvvfs).

**Already shared.** These files are copied into `public/` by `sync-public-modules.js`:

- `db.js`: the schema, `legacyInit`, and the migration runner on `PRAGMA user_version`.
- `repo.js`, `ledgers.js` and `backup-format.js`.

**Written twice.** Every route group exists in both copies:

- people, the ledger list and its CSV, the generic CRUD and batch save;
- cash in and out, loans, contracts, contractor payments;
- the Recycle Bin, budget, overview, the PDF HTML and the backup reminder.

That is about 1,250 code lines on each side. Only 64 lines (server) and 45 lines (phone) of them
differ. The encryption code (`backup-crypto.js`: node:crypto on desktop, WebCrypto and scrypt-js
on the phone) and the safety snapshots are also written twice.

**Drift that exists today**, which is review finding H4:

| Where | Desktop (`server.js`) | Phone (`local-api.js`) |
|---|---|---|
| PDF total row | `colspan="4"`, correct (line 1938) | `colspan="5"` against a 7-column header (line 1484): the phone's PDF is the wrong one |
| PDF page | 14/12 mm margins, prints backgrounds | A4 only |
| Request bodies | size limits; malformed JSON gets a 400 | no limits; malformed JSON silently becomes `{}` |
| Unknown `/api` route | Express's HTML 404 | JSON 404 |
| Restoring an encrypted backup | not implemented (501) | works |
| Storage-full and PDF error wording | own messages | different messages |

**Tests.**

- 28 node test files drive `server.js` over HTTP through `test/helpers.js`.
- No node test runs `local-api.js`.
- 4 Playwright suites run the phone path in Chromium.
- No test sends the same request to both copies.

So a fix made in one copy is invisible to the tests of the other. That is H4.

---

## 2. The design in one picture

```
  The 9 pages in public/ (unchanged)  ──  fetch('/api/...')
                 │
     ┌───────────┼──────────────────────────────┐
     │ transport (thin, one per platform)        │
     │  Android:  fetch shim     public/local-api.js (~150 lines)
     │  Desktop:  Electron       protocol.handle on app://plannr (no port)
     │  Dev/test: Express        server.js (dev only, ~400 lines)
     └───────────┼──────────────────────────────┘
                 ▼
     core/  ONE copy: router, route handlers, overview, PDF HTML,
            backups (JSON + encrypted), schema and migrations
                 │
       ┌─────────┴───────────┐
       ▼                     ▼
  database adapter        host services
  (one async interface)   (snapshots, PDF rendering, storage size)
   - node-sqlite:       desktop app, dev server, node tests
   - capacitor-sqlite:  Android (new, a real SQLite file)
   - wasm-kvvfs:        Android today; kept for the move and the way back
```

---

## 3. Part B1: the shared core

### 3.1 What goes into `core/`

- **`core/router.js`**: a small router, about 60 lines, the same idea as the matcher already in
  `local-api.js`.
  - A request is `{ method, path, query, body }`.
  - A response is `{ status, headers, body }`, where the body is JSON, text or bytes.
- **`core/routes/*.js`**: one file per route group from §1, moved out of `local-api.js`.
  - The desktop copy is deleted.
  - Where the two differ, the better version is kept on purpose, and a test pins that choice.
- **`core/pdf-html.js`, `core/overview.js`, `core/parsers.js`**: the helpers both copies share
  today (`parsePaise`, the IST date helpers, `computeOverview`, the PDF table builder).
- **Moved under `core/` unchanged:** `db.js`, `repo.js`, `ledgers.js` and `backup-format.js`.
- **Request checks that today only the desktop has:** body size limits, a 400 for malformed
  JSON, and a JSON 404 for an unknown route. The phone gets them too.
- **One `backup-crypto.js`.**
  - Keep the async WebCrypto + scrypt-js version. Node 22+ has the same WebCrypto
    (`globalThis.crypto.subtle`), so the node:crypto copy can go.
  - Known-answer tests decrypt files made by both old versions, so every existing backup still
    opens.
- **`core/host.js`**: the short list of platform services the core may call. Each platform
  supplies its own:
  - `snapshot.write(bytes, name)`: safety snapshots.
  - `pdf.render(html, { pageSize, margins, printBackground })`, which returns bytes.
  - `storage.info()`: the database size and the relevant limit.
  - `now()`: the clock, so tests can fix the IST date.

### 3.2 How each platform uses it

- **Android.**
  - `public/local-api.js` shrinks to the fetch shim: it turns a `Request` into a core request,
    calls `core.handle`, and turns the answer into a `Response`.
  - The Capacitor-only services (Filesystem snapshots, the PDF plugin) move to
    `public/host-capacitor.js`.
  - The pages do not change.
- **Desktop app.** Electron's main process calls `core.handle` from its protocol handler (§5.1).
- **`server.js` becomes a thin dev-only wrapper**, about 400 lines instead of 2,469.
  - It turns Express's `req` into a core request and the answer back into `res`.
  - It keeps only dev things: the LAN/token gate, the static files, the Playwright PDF renderer
    (as its `pdf.render`), `/api/health` and shutdown.
  - README and SETUP will say plainly that it is a development tool, not a way to run Plannr.

### 3.3 How this fixes H4

- There is one copy of every route, so a fix lands on every platform at once. Drift cannot come
  back, because there is nothing to drift between.
- **A guard test** fails if route code appears outside `core/`. It checks that `server.js` and
  `local-api.js` define no `/api` handlers, and that names like `computeOverview` and
  `parsePaise` are defined only in `core/`.
- `core/` is copied to `public/core/` by the existing sync step.
  - A test checks the copy is byte-identical to its source.
  - Today `local-server.js` serves a stale `public/` copy before the real file, which can hide a
    missed sync.

### 3.4 How the existing tests cover it

1. **The parity harness comes first, before any code moves.**
   - `test/helpers.js` gains a second target, `PLANNR_TEST_TARGET=shim`. It calls the phone's
     dispatcher in-process, through the same transport function `local-api.js` uses, instead of
     calling Express over HTTP.
   - `run-tests.js` runs the 28 HTTP-based test files twice, once per target.
   - The known drifts then show up as failing tests, and each one is fixed with its own commit.
   - From then on, the phone path is covered by the same ~169 tests as the desktop.
2. **Engines.**
   - Node tests use the `node-sqlite` adapter.
   - A small **adapter contract suite** runs the same checks against every adapter: transactions,
     rollback on error, `ON CONFLICT`, row ids, export and replace, and a migration step. It runs
     the `node-sqlite` adapter in Node, the `wasm-kvvfs` adapter in Chromium (Playwright), and
     the `capacitor-sqlite` adapter on the emulator (scripted the way the Phase 2 checks were).
3. **The 11 UI suites stay as they are.** They keep running the pages against both transports.

---

## 4. Part B2: storage adapters, all on a real SQLite file

### 4.1 One async interface

```
get(sql, params)   all(sql, params)   run(sql, params) -> { changes, lastInsertRowid }
exec(sql)          transaction(async fn)               exportBytes()   replaceWith(bytes)
info() -> { engine, path, sizeBytes }                  close()
```

- **Why async.** The Android native plugin answers only with Promises. On desktop, `node:sqlite`
  stays synchronous underneath; the adapter just returns resolved Promises, at no real cost.
- **One request at a time.** The core runs requests through one queue. Plannr has one user, so
  nothing is lost.
  - With async calls, two requests could otherwise interleave inside one transaction.
  - The queue also avoids the plugin's silent-rollback bug (§4.2).
  - A test fires two writes at once, makes one fail, and checks that the other is intact.
- **`transaction(fn)` replaces the hand-written `BEGIN`/`COMMIT`/`rollbackQuietly`** in `db.js`
  (8 places), `repo.js`, `backup-format.js` and the batch save.
  - `PRAGMA foreign_keys` stays outside the transaction, as `db.js:693` already requires.
- **About 300 call sites become `await`.** This is mechanical. It is done one file per commit,
  with the full suite after each.

### 4.2 Android: a native SQLite file (Option A in `docs/storage-proposal.md`)

**Why Option A.** It is the option that gives a real SQLite file:
`/data/data/com.plannr.app/databases/plannrSQLite.db` (the plugin adds `SQLite.db` to the name).
Option B keeps the database in the WebView's private file system, under the sqlite-wasm pool's
own file names, so it is not an ordinary file. Option A's main cost, an async database layer, is
paid once in §4.1.

**Plugin:** `@capacitor-community/sqlite`, pinned to exactly 8.1.1.

- Supports Capacitor 8 since 8.0.0; needs minSdk 24 and compileSdk 36.
- Actively maintained (Capawesome): 9 releases in the 12 months to 2026-11-15, the latest
  (8.1.1) on 2026-08-06.
- It is a new dependency. The alternatives for Capacitor 8 don't fit:
  - `@capawesome-team/capacitor-sqlite` needs a paid licence.
  - `@capgo/capacitor-fast-sql` runs a local HTTP server on the phone.

**Known plugin problems, and how the adapter avoids them:**

| Issue | Problem | What the adapter does |
|---|---|---|
| #700 (open) | A write with `transaction: true` while a transaction is open silently rolls that transaction back | Always passes `transaction: false` and runs `BEGIN`/`COMMIT` itself, behind the one queue |
| #671 | The multi-row `executeSet` path builds SQL with escaped strings and drops `\r\n` | Never uses `executeSet`; one `run` per statement, with bound values |
| #670 | The plugin's SQL parser fails on CTEs and `ON CONFLICT` | Plannr has **12** `ON CONFLICT` statements and no CTEs. The device check must prove they work; if not, rewrite them before going further |
| #685, #690 | `exportToJson` fails on some `CREATE TABLE` text | Never used; backups keep using `backup-format.js` |

**Other details:**

- **SQLCipher** is bundled even without encryption, so the APK grows; measure it. The database
  file itself is not encrypted, the same as today. The encrypted backup protects copies that
  leave the phone. The plugin's README mentions export-reporting duties for bundled encryption;
  read that before release.
- **Encrypted backup.**
  - Export: `VACUUM INTO` a file in the app's private folder, read it, delete it. This is what the
    desktop does today.
  - Restore: close the database, write the new file, reopen it, run `init()`.
  - Both are confirmed in the device check before any code depends on them.
- **Auto Backup rules:**
  - Add `domain="database" path="plannrSQLite.db"`.
  - Keep the old `localStorage` path while the old copy is kept.
  - Android skips the whole backup above 25 MB, so the storage meter warns at about 20 MB.
- **Durability.** A native file is on disk before the save returns. This removes the measured
  ~1-second window in which a save could be lost.
- **What the tests can no longer do.** Chromium can't run the native plugin, so the UI suites test
  the shared core on sqlite-wasm, not the phone's exact engine. The adapter contract suite on the
  emulator covers the gap. It runs before every release and is scripted with Playwright's
  Android support, which is already a dev dependency.

### 4.3 The one-time move from `localStorage` to the file

**It is started by the user, not automatic.** A "Move to the new storage" button on the Data
Backup page appears only in the first version that has the plugin. The owner's real data is moved
only after the real-phone test passes and this plan is approved.

1. **Backup first.** The button first saves an encrypted backup through the share sheet. If the
   sheet is closed or the save fails, nothing happens. This is the same rule as the Ledger List
   import's safety backup.
2. **Safety snapshot.** Export the `localStorage` database bytes (`sqlite3_js_db_export`) and
   write a verified, gzipped snapshot to `safety-snapshots/`, using the existing code. If this
   fails, stop.
3. **Copy.** Write the bytes as the new database file and open it with the plugin.
   - The device check confirms the cleanest way to do this, either the plugin's
     `moveDatabasesAndAddSuffix` or writing the file where the plugin looks.
4. **Verify every row.** Using the core's own adapter on both copies, check:
   - `PRAGMA integrity_check` is `ok`;
   - `user_version` matches;
   - for **every table**, the row count and a SHA-256 hash of all rows (in rowid order) match.
5. **Switch.** Only now write the marker `plannr-storage = native-v1` in `localStorage`. That
   marker is the single switch. Until it is written, the app runs on `localStorage` exactly as
   before.
6. **On any failure in steps 3–4:** delete the partial file, keep `localStorage`, and show a short
   note. Nothing is lost, and the user can try again.

**The old data is kept.** The `localStorage` copy is never changed by the move, and is kept
read-only for at least two releases. A later release may delete it, but only after a fresh backup
and the owner's OK.

**The way back.**

- **Main route:** a "Move data back" action on the Data Backup page. It runs the same snapshot →
  copy → verify → switch steps in reverse, with the current data. It is allowed only if the
  database fits under 90% of the `localStorage` limit.
- **Fallback:** the encrypted backup from step 1 restores on either storage.
- An older APK can't be installed over a newer one without uninstalling, which deletes the data.
  That is why the way back is built into the new version.

**Tests:**

- **In Node and Chromium:**
  - a full fixture database is moved and verified;
  - a forced failure at each step (write fails, hash mismatch, app killed between copy and
    switch) leaves `localStorage` unchanged and the app working;
  - the marker survives a restart;
  - the way back works.
- **On the emulator:** the real plugin moves a large fixture, then the 7 phone checks run again.

### 4.4 Desktop: a SQLite file in Electron's userData folder

- **The file** is `app.getPath('userData')/plannr.db`:
  - Windows: `%APPDATA%\Plannr`
  - macOS: `~/Library/Application Support/Plannr`
  - Linux: `~/.config/Plannr`
- **Safety snapshots** go in `safety-snapshots/` next to it: newest 3, the same rule as now.
- **Engine:** `node:sqlite` inside Electron 45, which ships Node 24.22.
  - It has worked without a flag since Electron 35, and is "release candidate" status in Node
    24.15+.
  - It is the same engine as the dev server and the node tests, with no native module to rebuild
    for each OS.
  - A smoke test comes first. If it fails, the possible fallback is `better-sqlite3` 13, a native
    module, but that needs the owner's OK first (§9).
- **Single-instance lock:** `app.requestSingleInstanceLock()`, so two windows never open the same
  file.
- **The existing desktop data is untouched.** `data/plannr.db` is used by `server.js` and is never
  read by the desktop app. The desktop app starts empty and is filled by opening a backup file.

### 4.5 The same schema versioning on both

There is already one runner in `db.js`:

- `PRAGMA user_version` (baseline 2, `MIGRATIONS = []`);
- each step in its own transaction;
- a newer schema is refused;
- a snapshot is taken before an upgrade.

The only changes:

- It becomes async.
- The pre-upgrade snapshot goes through `host.snapshot`: a `VACUUM INTO` file on desktop, the
  existing gzipped Filesystem snapshot on Android.

The existing migration fixture tests keep running on `node-sqlite`, and the contract suite runs
one migration on every adapter.

---

## 5. Part B3: the desktop app (Electron)

### 5.1 Security

| Setting | Value |
|---|---|
| `contextIsolation` / `nodeIntegration` / `sandbox` / `webSecurity` | on / **off** / on / on (Electron's defaults, set explicitly) |
| Where pages come from | `protocol.handle` on a privileged `app://plannr` scheme serving `public/`, with the path check from Electron's docs (reject `..` and absolute paths). No `file://`, no HTTP server, **no open port** |
| `/api/...` | Handled by the same protocol handler, which calls `core.handle` in the main process |
| Content Security Policy | Sent by the protocol handler, e.g. `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:` (adjusted to what the pages need) |
| Network | `session.webRequest.onBeforeRequest` cancels every request that is not `app:`. `spellcheck: false` (otherwise Electron downloads dictionaries). No auto-updater. The main process makes no `http`/`fetch` calls; a test checks the source |
| Navigation | `will-navigate` is blocked, `setWindowOpenHandler` denies, and the permission handler denies everything except notifications |
| Packaging hardening | `@electron/fuses`: `runAsNode` off, `nodeCliInspect` off |

### 5.2 A minimal preload API

The preload exposes one object, `window.plannrDesktop`, with three functions. Every IPC handler
checks that the message came from the app's own `app://plannr` window.

- **`saveFile(bytes, suggestedName)`**
  - The main process shows the system "Save as" dialog, writes the file and checks it on disk.
  - It returns `{ saved: true, path, size }` or `{ cancelled: true }`.
  - This is the same "proof, not trust" rule the phone follows with `Filesystem.stat`.
- **`notifications.setTimes(times)`**
- **`notifications.backupReminder(text)`**

Opening a backup file needs no API: `<input type="file">` already opens the system dialog in
Electron.

### 5.3 What replaces the phone features

| On the phone | On the desktop |
|---|---|
| Filesystem + share sheet | "Save as" dialog through `saveFile`; cancelling shows the same "Not saved" note |
| PDF plugin (`@capgo/capacitor-pdf-generator`) | `webContents.printToPDF` in a hidden window, `pageSize: 'A4'`, 14/12 mm margins, `printBackground: true` (the core's `pdf.render`) |
| Reminders scheduled by Android | `Notification` from the main process, on timers **only while Plannr is open** (owner's decision; no start-at-login or tray for now). **macOS shows no notifications from an unsigned app.** Windows needs the installed version (Start Menu shortcut and `setAppUserModelId`); the portable `.exe` may show none |
| Android Auto Backup | None. The backup-overdue reminder and the person's own backup files |

The pages already detect where they run (the `runtime-mode` suite). A `desktop` case is added, and
`saveFile` gets a desktop branch next to the Android and browser ones.

### 5.4 Backup files move freely between phone and desktop

- **Same files on every platform:** JSON v2 and the encrypted `.db.enc`, with one encryption
  implementation after §3.1. Restoring an encrypted backup starts working on desktop; today it
  returns 501.
- **Tests:**
  - A backup made on the phone path (sqlite-wasm in Chromium) restores on the desktop path
    (`node:sqlite`), and the reverse. Every table and counter matches.
  - A backup from a newer schema is refused on both.
  - Playwright can launch Electron (`_electron`, already a dev dependency). A desktop smoke suite
    opens every page, adds, edits and deletes entries, does a backup round trip, and fails if any
    network request is seen.

---

## 6. Part B4: packaging and release

**electron-builder 26** (v27 is still alpha).

- **Config:** `electron-builder.yml`. The desktop app id `com.plannr.app` is the macOS bundle id;
  it does not touch `capacitor.config.json`.
- **Targets:**
  - Windows: NSIS installer `.exe` and a portable `.exe` (x64; Electron 44+ has no 32-bit build).
  - macOS: `.dmg` for x64 and arm64.
  - Linux: AppImage and `.deb` (x64).
- **`package.json`:**
  - `electron` (exactly 45.3.2) and `electron-builder` (exactly 26.18.0) are added as dev
    dependencies with `--save-exact`. If a newer patch is out when the step starts, the commit
    records the exact version chosen and why.
  - Both are actively maintained: Electron published 313 versions in the 12 months to
    2026-11-15 (latest 45.3.2 on 2026-11-13; majors 43–45 supported), and electron-builder 54
    (latest stable 26.18.0 on 2026-10-20; 27.0.0-alpha.14 on 2026-10-29).
  - `npm start` stays the dev server; electron-builder's `extraMetadata.main` points the packaged
    app at `desktop/main.js`.

**GitHub Actions** (adding workflows needs a push, so it waits for the owner's OK):

- **`release.yml`:**
  - Runs on tags `v*`.
  - Uses a matrix of `windows-latest`, `macos-latest` and `ubuntu-latest`, on Node 24.
  - Each job runs `npm ci`, then the tests, then
    `npx electron-builder --publish always` (with `GITHUB_TOKEN` and `contents: write`).
  - The result is a **draft** release that the owner publishes by hand.
  - Signing is off; macOS gets an ad-hoc signature (`mac.identity: "-"`) so Apple Silicon Macs
    don't call the app "damaged".
- **`test.yml`:** on pull requests, the full suite on Linux.

**CI minutes.** The repository is **public**, so standard GitHub-hosted runners are **free**. If it
were private (prices from 2026-01-01; the allowance is now in dollars):

| Per release | Minutes | Cost |
|---|---|---|
| Linux | 10 | $0.06 |
| Windows | 15 | $0.15 |
| macOS | 15 | $0.93 |
| **Total** | 40 | **$1.14**, about 190 Linux-minute equivalents |

GitHub Free includes $12 a month (about 10 releases); Pro includes $18 (about 15). A PR test run
is about 5 Linux minutes ($0.03).

**What unsigned apps look like:**

| OS | What the user sees |
|---|---|
| Windows | "Windows protected your PC" → **More info → Run anyway**. Smart App Control (Windows 11, when on) can block unsigned apps outright |
| macOS 15+ | Blocked on first open. Right-click → Open no longer works. The user must go to **System Settings → Privacy & Security → Open Anyway** within about an hour and enter their password. No notifications while unsigned |
| Linux | AppImage needs `chmod +x` and FUSE 2 (`libfuse2t64` on Ubuntu 24.04). AppArmor on Ubuntu 24.04 can break the AppImage sandbox, so recommend the `.deb` there (`sudo apt install ./plannr.deb`). No signing exists or is needed |

**What signing costs:**

| Option | Cost | Notes |
|---|---|---|
| Apple Developer Program | $99 a year | Developer ID + notarization: no Gatekeeper block, and notifications work |
| Azure Artifact Signing (Windows) | from $9.99 a month | Individuals only in the US or Canada; check eligibility |
| OV code-signing certificate (Windows) | about $220–440 a year, plus a cloud key service (e.g. from $20 a month) | Keys must be on hardware or in a cloud HSM. EV no longer gives instant SmartScreen trust, so it is not worth the extra |
| SignPath Foundation (Windows) | free | For open-source projects under an OSI-approved licence, with conditions (MFA, builds made in CI, each release approved by hand) |

**Decided: signing later.** The first releases are unsigned, with clear install steps (§7).
Signing is decided again once real users exist.

---

## 7. Part B5: for other users

- **LICENSE: MIT** (decided). `LICENSE` becomes the MIT text with "Copyright (c) 2026 Joel
  Jims", and `package.json` says `"license": "MIT"` (today both say the Unlicense). Done in step
  5.3.
- **`PRIVACY.md`** (decided wording):
  > Plannr never sends your data anywhere. Android's own Auto Backup may save a copy to your
  > Google account; you can turn this off in Android settings.

  The README links to it. Install docs say where the data lives on each OS (§4.4).
- **Install steps for each OS**, in `INSTALL.md` and linked from README:
  - **Android:** download the APK and allow installs from that source once.
  - **Windows:** run the `.exe`, then click past SmartScreen.
  - **macOS:** open the `.dmg`, drag Plannr to Applications, then use Open Anyway.
  - **Linux:** `.deb` with `apt`, or AppImage with `chmod +x`.
  - Each OS section also says where the data lives and how to move it with a backup file.

---

## 8. Part B6: order of work

Every step is one commit and ends with the full suite. "Android unchanged" means the APK built
from that step behaves exactly as today. Phase ends are also checked on the emulator with the
Phase 2 scripts.

| Step | What | Tests added | Android |
|---|---|---|---|
| **Phase 1: shared core** | | | |
| 1.1 | Export the phone dispatcher so Node can load it; add `PLANNR_TEST_TARGET=shim`; run the 28 HTTP test files on both targets. The known drifts are listed as expected failures | parity runs (×2 the HTTP tests) | unchanged |
| 1.2 | Fix each drift (PDF total row and margins, body limits and malformed JSON, JSON 404, wording, encrypted restore on desktop), one commit each | one test per drift; the expected-failure list shrinks to zero | PDF total row fixed |
| 1.3 | Move route groups one at a time into `core/routes/`; both copies call the core for that group | parity stays green after each group | unchanged |
| 1.4 | `core/host.js`; one `backup-crypto.js` | known-answer tests on files made by both old versions | unchanged |
| 1.5 | `server.js` becomes the thin wrapper; guard test; sync check; SETUP/HANDOFF updated | guard + sync tests | unchanged |
| 1.6 | Emulator: the 7 phone checks | — | confirmed |
| **Phase 2: async database interface** (Android still on `localStorage`) | | | |
| 2.1 | Adapter interface; `node-sqlite` and `wasm-kvvfs` adapters | contract suite (Node + Chromium) | unchanged |
| 2.2 | `db.js`, `repo.js`, `backup-format.js` and the core become `await`, one file per commit; request queue; `transaction(fn)` | concurrency test; full suite after each file | unchanged |
| 2.3 | Emulator: timing of a full overview on a large fixture, before vs after | — | confirmed, no slower in practice |
| **Phase 3: Android native SQLite and the move** | | | |
| 3.1 | One-day device check on the emulator with the plugin: the 12 `ON CONFLICT` statements, transactions, `VACUUM INTO` export, replace and reopen, Auto Backup of `databases/`, speed, APK size. **Stop and report if anything blocks** | spike script (scratchpad) | test build only |
| 3.2 | `capacitor-sqlite` adapter | contract suite on the emulator | not yet used |
| 3.3 | The move and the way back (user-started), Auto Backup rules, storage meter | fault injection at every step; marker; way back | new button, off until pressed |
| 3.4 | Emulator: move a large fixture, then the 7 checks. Then the owner's real-phone test on a **copy** of the data. Real data only after approval | — | confirmed |
| **Phase 4: desktop app** | | | |
| 4.1 | `desktop/main.js`: secure window, `app://plannr`, core on `node:sqlite` in userData, single-instance lock | Electron smoke suite (`_electron`) | not affected |
| 4.2 | Preload `saveFile`; page branches; PDF with `printToPDF`; notifications | save, cancel, PDF and notification tests | not affected |
| 4.3 | Backup round trip phone ↔ desktop; no-network check | round-trip + no-network tests | not affected |
| **Phase 5: packaging and documents** | | | |
| 5.1 | `electron-builder.yml`; local Windows build | build smoke check | not affected |
| 5.2 | `release.yml` + `test.yml` (needs a push: ask first) | CI runs the suite | not affected |
| 5.3 | LICENSE → MIT (Joel Jims), `PRIVACY.md` (decided wording), `INSTALL.md`, README | doc link check | not affected |

**Done so far (2026-11-15):**

- **1.1:** `npm test` runs the HTTP test files a second time against `public/local-api.js`.
- **1.2:** the owner chose each behaviour. The shared rules live in `request-rules.js`, used by both:
  - size limits with one message per kind of request;
  - 400 "Invalid request." for malformed JSON;
  - a JSON 404 for unknown `/api` requests.

  Also in 1.2:
  - The phone's PDF total row now spans 4 columns, not 5.
  - The PDF and encrypted-export tests now reach the phone's own code.
  - Storage, encrypted restore and PDF creation stay per-platform services, as decided.
  - PDF margins were left as they are.

  `test/phone-code-differences.json` therefore does not shrink to zero. It keeps the 17
  differences that are by design: 16 tests of dev-server-only features, plus `/api/storage`.

**Rough effort:**

| Phase | Working days |
|---|---|
| 1 | 5–7 |
| 2 | 4–6 |
| 3 | 1 + 6–9 |
| 4 | 5–7 |
| 5 | 2–3 |
| **Total** | **about 23–33** |

**Main risks, and what limits them:**

- **The plugin's SQL parser or transaction bugs.**
  - Step 3.1 checks them before anything depends on the plugin.
  - If they block, the async core still accepts another engine, for example Option B (OPFS).
- **Mistakes during the async conversion:** one file per commit, the full suite after each, and
  the request queue.
- **`node:sqlite` in Electron:** smoke test first. If it fails, stop and ask (`better-sqlite3`
  is the likely fallback, not yet approved).
- **Unsigned apps put people off:** clear install steps; decide on signing later.

---

## 9. Decisions (made by the owner on 2026-11-15)

1. **The plan and its order are approved.** Only step 1.1 starts now. Its report (the differences
   between the phone and server code that the shared tests expose) goes to the owner before
   anything is fixed.
2. **New dependencies approved, each pinned to an exact version:**
   - `@capacitor-community/sqlite` 8.1.1 (Android: a real SQLite file).
   - `electron` 45.3.2 and `electron-builder` 26.18.0 (dev: the desktop app and its installers).
   - All three are actively maintained (release counts and dates in §4.2 and §6).
   - `better-sqlite3` is **not** approved. If `node:sqlite` fails in Electron, ask first.
3. **Licence: MIT**, copyright Joel Jims (step 5.3).
4. **Android Auto Backup stays on.** The privacy text says so, in the owner's wording (§7).
5. **Signing: later.**
6. **Desktop reminders: only while Plannr is open**, for now.

---

## Sources (checked 2026-11-15)

- Code facts: this repository at `3532343`. Line numbers are from `server.js`,
  `public/local-api.js` and `db.js` on that commit.
- Electron releases (45.3.3, Node 24.22, Chromium 156): https://releases.electronjs.org/
- `node:sqlite` status: https://nodejs.org/docs/latest-v24.x/api/sqlite.html;
  in Electron: https://github.com/electron/electron/issues/45532 and
  https://github.com/electron/electron/pull/47706
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security;
  protocol: https://www.electronjs.org/docs/latest/api/protocol;
  spellchecker downloads: https://www.electronjs.org/docs/latest/tutorial/spellchecker
- Dialog, Notification, printToPDF: https://www.electronjs.org/docs/latest/api/dialog,
  https://www.electronjs.org/docs/latest/api/notification,
  https://www.electronjs.org/docs/latest/api/web-contents
- electron-builder v26 and GitHub Actions: https://www.electron.build/v26/docs/features/github-actions,
  macOS signing: https://www.electron.build/v26/docs/mac
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions,
  https://docs.github.com/en/billing/reference/actions-runner-pricing,
  https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/
- SmartScreen: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation;
  Smart App Control: https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview
- macOS Gatekeeper change: https://developer.apple.com/news/?id=saqachfa;
  https://support.apple.com/guide/mac-help/mh40616/mac
- AppImage: https://docs.appimage.org/introduction/quickstart.html,
  https://docs.appimage.org/user-guide/troubleshooting/fuse.html
- Apple Developer Program: https://developer.apple.com/programs/whats-included/
- Azure Artifact Signing: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart,
  https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- SignPath Foundation: https://signpath.org/terms
- `@capacitor-community/sqlite`: https://github.com/capacitor-community/sqlite/releases,
  https://github.com/capacitor-community/sqlite/blob/master/docs/API.md
- Storage options and the earlier move plan: `docs/storage-proposal.md`
