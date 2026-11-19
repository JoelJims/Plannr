# Contributing to Plannr

## The rule for database changes

**Any feature that changes the database must add a migration and a test.**

The phone keeps every user's data in its own database, and an app update must carry that data
forward. There is no server to fix it later.

### How the database is versioned

- The database stores its schema version in `PRAGMA user_version`.
- `db.js` holds the list of upgrade steps, `MIGRATIONS`. The same file runs on the phone (copied to
  `public/db.js` by `npm run sync:public-modules`) and in the desktop dev server, so they cannot drift.
- `await init()` runs at every start. It:
  1. refuses a database from a newer app version and changes nothing;
  2. makes a safety snapshot of the whole database before any step runs (phone:
     `Directory.Data/safety-snapshots/`; desktop: `safety-snapshots/` beside the database file),
     keeping the newest 3, and always the one from before an upgrade that has not finished
     (`plannr-upgrade-pending.json`);
  3. applies each missing step in order. Each step runs in its own transaction together with its
     version stamp, so a failing step rolls back completely.
- `init()` is async (step 1.4 B4). `server.js`, `reset-db.js` and `seed-demo.js` cannot wait yet and
  call `initSync()` until step B17. `initSync()` refuses a database that still needs a numbered step
  (only `init()` runs those), so a new step makes them fail loudly until then.
- `legacyInit()` is a generator (step 1.4 B5–B9): each of its database calls is
  `yield q.get(sql, params)` (or `all`, `run`, `exec`; parameters as an array). `init()` awaits each
  call through the async interface; `initSync()` makes the same calls at once. The upgrade plan is
  made the same way: `planMigrations()` (awaited: `init()` and the phone's start) and
  `migrationPlan()` (at once: `initSync()` and tests) run one generator.
  `test/migration-equivalence.test.js` and `test/migration-legacy-shapes.test.js` check that both
  make exactly the old runner's writes, in order. Yield nothing but a `q.*` call (a helper generator
  goes in with `yield*`; a callback such as `.filter()` cannot yield, so use a loop). From B17, when
  `initSync()` goes, `yield q.x(` becomes `await tx.x(`.
- `repo.js` reads and writes through the async interface (step 1.4 B10–B12): every function returns
  a Promise, so every call is awaited (or returned). `test/repo-async.test.js` fails on a repo call
  in `core/`, `server.js` or `public/local-api.js` that is not. A write of several rows goes inside
  `transaction(async (tx) => …)` from `db.js` (the core gets it as `ctx.transaction`), never its own
  `BEGIN`/`COMMIT`.
- Version 2 is the baseline: everything up to it is the older, hand-gated code in `legacyInit()`.
  Do not add new schema changes there. A v2 database made by an older app can still need some of its
  one-off clean-ups (gated on settings markers); `init()` takes the snapshot before those too.

### Adding a migration

1. Append one entry to `MIGRATIONS` in `db.js`. Its version is the previous one plus 1 (the first
   is 3):

   ```js
   { version: 3, name: 'add cash_out.receipt_note', async up(tx) {
       await tx.exec('ALTER TABLE cash_out ADD COLUMN receipt_note TEXT');
       await tx.run('UPDATE cash_out SET receipt_note = ? WHERE reason IS NULL', ['']);
   } },
   ```

   - `tx` is the async database interface (`core/db-adapter.js`): `get`, `all`, `run`, `exec`;
     parameters always as an array. Await every call.
   - Never edit, reorder or delete a step that has shipped.
   - `up()` already runs inside a transaction: no `BEGIN`/`COMMIT` (a nested `tx.transaction()` is
     refused), and no `PRAGMA foreign_keys` (it has no effect inside a transaction). A table rebuild
     that needs foreign keys off needs a different design; ask first.
   - Keep the data: copy rows across, never drop a table or column that still holds user data.
2. Keep the backups complete. If you add a table or column, add it to `BACKUP_TABLES` /
   `BACKUP_COLS` in `backup-format.js` and give it rows in `test/fixtures/full-dataset.js`. The
   round-trip tests fail if any table is left out of the fixture.
3. Add a test that builds a database at the previous version, with data, runs the migration and
   checks that every row and value is still there. `test/migrations.test.js` and
   `test/_versioned-migrate-fixture.js` show both styles (in-memory, and a real `init()` in a fresh
   process). `test/migration-equivalence.test.js` and `test/migration-faults.test.js` also run every
   step on a database from every past schema (`test/fixtures/schema-history/`), with a failure at
   each step and the starts after it; they pick up a new step without changes.
4. Run everything: `npm test` and every `npm run test:*` UI suite. Then try it on a phone: install
   the new build over the old one and check the data is still there (`docs/RELEASE.md`).

## Offline first

Plannr works fully offline. The Android app keeps the INTERNET permission (owner's decision,
2026-11-15), but nothing in the core of the app may need it: logging, editing, backups and PDF
creation work with no connection and make no network request.

Any future online feature must be:

1. **Optional.** Plannr works fully without it.
2. **Clearly labelled** as using the internet, where the user turns it on or uses it.
3. **Used only when the user uses it.** Nothing goes online in the background or on its own.
4. **Clear when offline.** With no connection it shows a plain message saying so, and nothing else
   breaks.
5. **Never needed for logging data.** Adding, editing and deleting entries, backups and PDFs never
   depend on it.

Two tests hold the core to this:

- `test/offline.test.js` runs in `npm test` against both the dev server and the phone code. It
  checks that no app file loads anything from outside, that the PDF page needs nothing from
  outside, and that the core actions work while every outside connection is refused.
- `npm run test:offline` opens every page in a real browser with no connection.

A new online feature needs its own test showing its offline message.

## Other rules

- Never open, change or delete a real database (`data/plannr.db`) in tests. Tests use temporary
  files only; `test/helpers.js` sets this up.
- Shared modules live at the project root. `public/` copies of them are generated; never edit them.
- Every `/api` route runs through the request queue (`core/request-queue.js`, step 1.4 B5): register it
  on `api` in `server.js` (never `app`) and on `localApp` in `public/local-api.js`. A route that skips
  the queue fails `test/request-queue-wiring.test.js`. Only a route marked `outsideQueue()` may call
  `ctx.exclusive(fn)`, for its database part (the Overview PDF); from a queued route it would wait for
  the queue that route already holds, for ever.
