# Proposal: moving the phone database off localStorage

Status: **proposal only, nothing implemented.** Phase 2, Step 8. Needs a decision (see the end).

## The problem

On the phone the database lives in the WebView's `localStorage`. `@sqlite.org/sqlite-wasm`'s
kvvfs stores one `localStorage` entry per 8 KB database page (`db-engine.js`). `localStorage` has a
fixed size per origin:

| Measured (Playwright Chromium, Phase 2 Step 3) | |
|---|---|
| `localStorage` limit | 5,242,880 characters (about 10 MiB) |
| Largest database that fits | about 2.76 MB, about 12,000–13,000 entries |
| Fresh install | about 0.3 MB database |
| What happens at the limit | the write fails, SQLite rolls it back, the app says "Storage is full" (Step 3) |

On the Android emulator (Android 16, WebView 133; Phase 2 Step 9) the limit measured 5,242,866
characters, the same. Not yet measured on the user's phone. The Data Backup page warns at 70% and
90%. Nothing is lost at the limit, but nothing more can be saved either. How soon that happens
depends on how many entries the user adds per year, which is not known yet (check the meter after
the desktop data moves to the phone).

A second, smaller weakness, also measured on the emulator: the WebView writes `localStorage` to
disk about one second after a change. An entry saved and then killed by Android **within about a
second** was lost (force-stop after 0.2 s and 0.5 s: lost; after 1, 3, 6 and 12 s: kept; going to
Home or Back and being killed 1 s later: kept). The database stayed consistent every time: the
lost save was simply not there, never half-written. In normal use a save is followed by more than a
second of the app staying open, so this is unlikely, but neither option below has it: native SQLite
and OPFS both write to disk before the save returns.

## What must stay the same

- The SQL schema, `db.js`, `repo.js`, migrations (`PRAGMA user_version`) and both backup formats.
- The desktop dev server (`node:sqlite` on a file) — it is not affected by either option.
- UI tests run in Chromium against the same engine the phone uses.
- No network access.

`db.js`, `repo.js`, `backup-format.js`, `public/local-api.js` and `public/local-snapshot.js` call
the database **synchronously** (`prepare(...).get()`, `exec()`): about 170 `prepare` and 130
`exec` call sites. This matters more than anything else below.

## Option A — native SQLite through a Capacitor plugin

For example `@capacitor-community/sqlite` (an 8.x line exists; check its Capacitor 8 peer range
before choosing). The database becomes a normal SQLite file in the app's private `databases/`
folder, opened by Android's own SQLite.

| | |
|---|---|
| Size limit removed | The `localStorage` limit entirely. The database is limited only by free space on the phone. |
| Pros | Most durable: a plain file, never cleared by the WebView, easy to back up (`domain="database"` in the Auto Backup rules). One native connection shared by all 9 pages, so no lock handover between pages. Fast. |
| Cons | **A new dependency** (native code in the APK). Every call goes over the Capacitor bridge and returns a Promise, so all ~300 synchronous call sites in `db.js`/`repo.js`/`local-api.js` become `await` — and those files are shared with `server.js`, which uses `node:sqlite` synchronously, so they would have to work both ways. In a browser the plugin uses a different engine (jeep-sqlite/sql.js), so Playwright would no longer test what the phone runs. Plugin upgrades must follow Capacitor upgrades. |
| Effort | High: about 8–12 days, plus the migration (below). |

## Option B — sqlite-wasm with OPFS storage (`opfs-sahpool`)

Keep `@sqlite.org/sqlite-wasm` (already installed, 3.53.0; it includes `installOpfsSAHPoolVfs` and
`pauseVfs`/`unpauseVfs`) but store the database in the Origin Private File System instead of
`localStorage`. The `opfs-sahpool` VFS needs no SharedArrayBuffer and no special headers (the plain
`opfs` VFS needs both, which the app's WebView setup does not provide, so it is not practical
here). It only runs in a **dedicated worker**.

The key point: the page already talks to the database through `fetch('/api/...')`, which
`local-api.js` intercepts — an asynchronous boundary already exists. So the whole local API
(`local-api.js` handlers + `db.js` + `repo.js`) can move into one worker, where it keeps calling
the database synchronously. The page's `fetch` shim forwards each request to the worker and waits
for the answer. `db.js` and `repo.js` do not change. The few things that need the Capacitor bridge
(PDF export, writing safety snapshots, Share) stay on the page: the worker sends the bytes back and
the page does the native call.

| | |
|---|---|
| Size limit removed | The `localStorage` limit. OPFS counts against the browser's storage quota for the origin, which in Chromium is a share of free disk (far above 10 MiB). The exact quota inside the Android WebView, and whether it can ever be evicted when the phone is low on space, must be checked on a device (`navigator.storage.estimate()`, `navigator.storage.persist()`). |
| Pros | **No new dependency.** Same engine and SQL as today; Playwright's Chromium supports OPFS, so tests still run what the phone runs. `db.js`/`repo.js` stay synchronous and shared with `server.js`. |
| Cons | Only one connection can hold the database at a time. Plannr is 9 separate pages, so each navigation must hand the database from the old page's worker to the new one (`pauseVfs` on `pagehide`, retry on open); the back/forward cache can keep an old page alive. The data sits inside the WebView's profile folder, so the Auto Backup rules need the new path (to find on a device). Worker plumbing to write and test. Whether the phone's WebView supports OPFS sync access handles must be confirmed first. |
| Effort | Medium: about 1 day of device checks first, then 4–6 days, plus the migration (below). |

## Option 0 — stay on localStorage for now

Costs nothing, and the warnings at 70%/90% plus "Storage is full" already protect the data. Fine
while the meter stays low. It only postpones the decision.

## Comparison

| | A: native plugin | B: OPFS in a worker | 0: stay |
|---|---|---|---|
| New dependency | yes | no | no |
| `db.js`/`repo.js` change | all calls become async | no | no |
| Tests run the phone's engine | no | yes | yes |
| Size limit | free disk | browser quota (large; measure on phone) | ~2.76 MB database |
| Durability | best | good (check eviction on phone) | good, except a save in the last ~1 s before Android kills the app (measured) |
| Effort (without migration) | 8–12 days | 1 + 4–6 days | 0 |

**Recommendation:** B, after a one-day device check (OPFS sync access handles in the phone's
WebView, the quota, the folder for Auto Backup, the page-to-page handover). If the check fails, A.

## One-time migration plan (either option)

The new version contains both stores. The old `localStorage` copy is never changed by the move.

1. **Before installing**: export an encrypted and a JSON backup off the phone (`docs/RELEASE.md`
   step 1).
2. **On first start of the new version** (in `local-bootstrap.js`, before any page code can call
   `/api`, so nothing writes during the move):
   1. If the marker `plannr-storage` in `localStorage` already says the new store, open it and stop.
   2. **Snapshot**: export the kvvfs database bytes (`sqlite3_js_db_export`), write a verified,
      gzipped safety snapshot `plannr-pre-storage-move-<time>.db.gz` (as Step 4 does). If that
      fails, stop and keep using `localStorage`.
   3. **Copy** the bytes into the new store (`importDb` for B; a file write for A).
   4. **Verify** the copy: `PRAGMA integrity_check` is `ok`, `user_version` matches, and every
      table has the same row count and the same content hash as the original.
   5. **Switch**: only now write the marker. The marker is the single switch; until it is written
      the app keeps running on `localStorage` exactly as before.
   6. On any failure in 3–4: delete the partial copy, keep `localStorage`, show a short notice, try
      again on the next start. Nothing is lost.
3. **Keep the old copy** in `localStorage` (read-only, not deleted) for at least two releases.
4. **The way back**, built into the new version (an older APK cannot be installed over a newer
   one without uninstalling, which deletes the data): a "Move data back" action that runs the same
   snapshot → copy → verify → switch steps in reverse, allowed only if the database fits in
   `localStorage` (below 90% of the limit). After the marker is switched, the old copy is stale, so
   the way back always copies the current data, never the old copy.
5. **Later**, in a release after the move has worked on the phone: delete the old `localStorage`
   copy, after a fresh backup.

Also needed in the same change:
- Auto Backup rules (`backup_rules.xml`, `data_extraction_rules.xml`) for the new location. Android
  skips the whole app's backup above 25 MB, which becomes the next limit: warn when the database
  approaches about 20 MB, and leave the safety snapshots out of Auto Backup if needed.
- The storage meter: database file size against the new limit (the quota for B, free disk for A).
- Tests: a full fixture database moved and verified; a forced failure at each step leaves
  `localStorage` unchanged and the app working; the way back; the marker surviving a restart.

## Decisions needed

1. Which option (A, B or 0 for now), and when.
2. Permission to run the one-day device check for B (needs a phone or an emulator image download).

## Sources

- SQLite WASM persistence options (kvvfs, `opfs`, `opfs-sahpool`):
  https://sqlite.org/wasm/doc/trunk/persistence.md
- `opfs-sahpool` pause/unpause: https://sqlite.org/wasm/doc/tip/news.md
- `@capacitor-community/sqlite` 8.x README:
  https://cdn.jsdelivr.net/npm/@capacitor-community/sqlite@8.1.0/README.md
