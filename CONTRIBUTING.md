# Contributing to Plannr

## The rule for database changes

**Any feature that changes the database must add a migration and a test.**

The phone keeps every user's data in its own database, and an app update must carry that data
forward. There is no server to fix it later.

### How the database is versioned

- The database stores its schema version in `PRAGMA user_version`.
- `db.js` holds the list of upgrade steps, `MIGRATIONS`. The same file runs on the phone (copied to
  `public/db.js` by `npm run sync:public-modules`) and in the desktop dev server, so they cannot drift.
- `init()` runs at every start. It:
  1. refuses a database from a newer app version and changes nothing;
  2. makes a safety snapshot of the whole database before any step runs (phone:
     `Directory.Data/safety-snapshots/`; desktop: `safety-snapshots/` beside the database file),
     keeping the newest 3;
  3. applies each missing step in order. Each step runs in its own transaction together with its
     version stamp, so a failing step rolls back completely.
- Version 2 is the baseline: everything up to it is the older, hand-gated code in `legacyInit()`.
  Do not add new schema changes there.

### Adding a migration

1. Append one entry to `MIGRATIONS` in `db.js`. Its version is the previous one plus 1 (the first
   is 3):

   ```js
   { version: 3, name: 'add cash_out.receipt_note', up(db) {
       db.exec('ALTER TABLE cash_out ADD COLUMN receipt_note TEXT');
   } },
   ```

   - Never edit, reorder or delete a step that has shipped.
   - `up()` already runs inside a transaction: no `BEGIN`/`COMMIT`, and no `PRAGMA foreign_keys`
     (it has no effect inside a transaction). A table rebuild that needs foreign keys off needs a
     different design; ask first.
   - Keep the data: copy rows across, never drop a table or column that still holds user data.
2. Keep the backups complete. If you add a table or column, add it to `BACKUP_TABLES` /
   `BACKUP_COLS` in `backup-format.js` and give it rows in `test/fixtures/full-dataset.js`. The
   round-trip tests fail if any table is left out of the fixture.
3. Add a test that builds a database at the previous version, with data, runs the migration and
   checks that every row and value is still there. `test/migrations.test.js` and
   `test/_versioned-migrate-fixture.js` show both styles (in-memory, and a real `init()` in a fresh
   process).
4. Run everything: `npm test` and every `npm run test:*` UI suite. Then try it on a phone: install
   the new build over the old one and check the data is still there (`docs/RELEASE.md`).

## Other rules

- Never open, change or delete a real database (`data/plannr.db`) in tests. Tests use temporary
  files only; `test/helpers.js` sets this up.
- Shared modules live at the project root. `public/` copies of them are generated; never edit them.
