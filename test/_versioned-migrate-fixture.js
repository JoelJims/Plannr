// Spawned by migrations.test.js (not a *.test.js file, so the runner skips it). db.js opens PLANNR_DB
// once, when it is first required, so running the REAL init() against an old database needs a fresh
// process.
//
// Builds an "old app" database by hand: user_version 0 (from before schema versioning), an older
// table shape (no categories tables, no contract_services/allowances, fewer contract columns), and
// rows in every table it has. Then boots it through the real init() and proves:
//   1) a safety snapshot of the ORIGINAL database is written first, beside the database file, in
//      safety-snapshots/, and holds exactly the original rows and version;
//   2) the newest 3 snapshots are kept (older ones deleted only after the new one is written);
//   3) user_version lands on SCHEMA_VERSION, and every original row and value is still there;
//   4) a second init() (a restart) changes nothing and writes no new snapshot;
//   5) a database stamped by a NEWER app version is refused, with nothing changed.
// Throws (non-zero exit) on any failure; prints FIXTURE OK on success.
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), fs = require('node:fs');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { dumpAll } = require('./fixtures/full-dataset');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `plannr-vermig-${process.pid}-${crypto.randomBytes(4).toString('hex')}-`));
const dbPath = path.join(tmpDir, 'plannr.db');
const snapDir = path.join(tmpDir, 'safety-snapshots');
const T = '2025-06-01 10:00:00';

try {
  // ---- the old database ----
  {
    const d = new DatabaseSync(dbPath);
    d.exec('PRAGMA foreign_keys = ON');
    d.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE contract(id INTEGER PRIMARY KEY AUTOINCREMENT, contractor_name TEXT, area_of_work TEXT, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, amount_paise INTEGER, price_of_contract_paise INTEGER, contract_end_date TEXT, date_signed TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE TABLE contract_payment_dates(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE, pay_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE contractor_payments(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id), pay_date TEXT NOT NULL, amount_paise INTEGER NOT NULL, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, phase INTEGER, subpart TEXT, remarks TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE TABLE cash_in(id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, tx_date TEXT, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE TABLE cash_out(id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, tx_date TEXT, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, ledger_code TEXT NOT NULL, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, reason TEXT, contract_scope TEXT NOT NULL, contract_stated_paise INTEGER, phase INTEGER, subpart TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE TABLE loans(id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER, bank_name TEXT, interest_rate REAL, tenure TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    `);
    const run = (sql, ...p) => d.prepare(sql).run(...p);
    run('INSERT INTO users VALUES (1, ?, ?, ?, ?)', 'owner', 'Owner', 'local-single-user-no-auth', T);
    run('INSERT INTO users VALUES (2, ?, ?, ?, ?)', 'helper', 'Site helper', 'local-single-user-no-auth', T);
    run('INSERT INTO contract VALUES (1, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL)', 'Example Builders', 'Civil work', '22.0', '22.5', 900000000, 900000000, '2026-12-31', '2025-05-30', T, T);
    run('INSERT INTO contract_payment_dates VALUES (1, 1, ?, ?)', '2025-07-01', T);
    run('INSERT INTO contractor_payments VALUES (1, 1, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL)', '2025-07-02', 150000000, '22.0', 1, 'a', 'Advance — ₹1.5L', T, T);
    run('INSERT INTO cash_in VALUES (1, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)', 500000000, '2025-06-02', 'user', 2, 'Savings', T, T);
    run('INSERT INTO cash_out VALUES (1, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?, NULL)', 123456, '2025-06-03', 'user', 1, '22.0', '22.5', 'Stamp duty', 'extra', T, T);
    run('INSERT INTO cash_out VALUES (2, ?, NULL, ?, NULL, ?, ?, NULL, ?, NULL, NULL, ?, ?, 2, ?, ?, ?, ?)', 99, 'custom', 'Mason', 'CUSTOM', 'Pooja flowers', 'included', 98, 'b', T, T, T);
    run('INSERT INTO loans VALUES (1, ?, ?, ?, ?, ?, ?, NULL)', 2500000000, 'Example Bank', 8.4, '15 years', T, T);
    run("INSERT INTO settings VALUES ('budget_paise', '5000000000')");
    // This fixture is about versioning, not the (separately tested) ledger-taxonomy rewrite: mark that
    // one-off rewrite as already done, as it is on every real database that reached v2.
    run("INSERT INTO settings VALUES ('_migrated_ledger_taxonomy_v1', '1')");
    d.exec("UPDATE sqlite_sequence SET seq = 12 WHERE name = 'cash_out'"); // ids 3..12 were deleted once
    assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, 0);
    d.close();
  }
  const original = (() => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return dumpAll(d); } finally { d.close(); } })();

  // Three older snapshots already there (from earlier upgrades), oldest first.
  fs.mkdirSync(snapDir);
  const older = ['a', 'b', 'c'].map((x, i) => {
    const f = path.join(snapDir, `plannr-pre-migration-v0-to-v2-old-${x}.db`);
    fs.writeFileSync(f, 'older snapshot');
    const t = new Date(Date.UTC(2025, 0, 1 + i));
    fs.utimesSync(f, t, t);
    return path.basename(f);
  });
  fs.writeFileSync(path.join(snapDir, 'notes.txt'), 'not a snapshot: never touched');

  // ---- boot the real init() ----
  process.env.PLANNR_DB = dbPath;
  process.env.PLANNR_TEST = '1';
  const { db, init, migrationPlan, SCHEMA_VERSION } = require('../db');
  const plan = migrationPlan();
  assert.deepStrictEqual([plan.from, plan.to, plan.needsSnapshot, plan.tooNew], [0, SCHEMA_VERSION, true, false]);

  init();

  // 1) The snapshot holds the original database, exactly.
  const snaps = () => fs.readdirSync(snapDir).filter((f) => f.startsWith('plannr-pre-migration-')).sort();
  const fresh = snaps().filter((f) => !older.includes(f));
  assert.strictEqual(fresh.length, 1, `one new snapshot (got ${fresh.join(', ')})`);
  assert.match(fresh[0], new RegExp(`^plannr-pre-migration-v0-to-v${SCHEMA_VERSION}-\\d{4}-.*\\.db$`));
  const snapDb = new DatabaseSync(path.join(snapDir, fresh[0]), { readOnly: true });
  try { assert.deepStrictEqual(dumpAll(snapDb), original, 'the snapshot is the database as it was before the upgrade'); } finally { snapDb.close(); }

  // 2) Newest 3 kept: the new one plus the two newest older ones; other files untouched.
  assert.deepStrictEqual(snaps(), [...older.slice(1), fresh[0]].sort());
  assert.ok(fs.existsSync(path.join(snapDir, 'notes.txt')));

  // 3) Upgraded, nothing lost.
  assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  for (const [table, rows] of Object.entries(original.tables)) {
    const pk = table === 'settings' ? 'key' : 'id';
    for (const row of rows) {
      const now = db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(row[pk]);
      assert.ok(now, `${table} ${pk}=${row[pk]} survived the upgrade`);
      for (const [col, val] of Object.entries(row)) assert.strictEqual(now[col], val, `${table} ${pk}=${row[pk]}: ${col} unchanged`);
    }
  }
  assert.strictEqual(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'cash_out'").get().seq, 12, 'AUTOINCREMENT counter kept');
  for (const t of ['ledger_mains', 'ledger_subs', 'ledger_customs', 'contract_services', 'contract_allowances']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), `new table ${t} created`);
  }
  assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // 4) A restart changes nothing and needs no snapshot.
  const afterFirst = dumpAll(db);
  assert.strictEqual(migrationPlan().needsSnapshot, false);
  init();
  assert.deepStrictEqual(dumpAll(db), afterFirst, 'a second init() is a no-op');
  assert.strictEqual(snaps().length, 3, 'no new snapshot on a restart');

  // 5) A database from a newer app version is refused, untouched.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  const newer = dumpAll(db);
  assert.throws(() => init(), /newer version of the app.*Nothing was changed/s);
  assert.deepStrictEqual(dumpAll(db), newer, 'nothing changed');
  assert.strictEqual(snaps().length, 3, 'no snapshot for a refused database');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  db.close();
  console.log('FIXTURE OK');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
