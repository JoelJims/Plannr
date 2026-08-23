// Spawned by tenancy-collapse.test.js (NOT a *.test.js file, so the runner skips it). db.js binds its
// single connection to PLANNR_DB at require time, so exercising the real init() migration chain needs
// a fresh process.
//
// This is the "someone restores a genuinely old backup" regression test. It builds a PRE-tenancy,
// PRE-Services-phase schema by hand (no tenant_id anywhere, an inflated sqlite_sequence simulating
// past deletes), boots it through the REAL init() migration chain, and proves:
//   1) the chain adds tenant_id (the old Tenancy Phase 2 block) and then immediately collapses it
//      back off (Step 2a) in that SAME first boot — every one of the 8 formerly-tenant tables ends
//      with NO tenant_id column, and settings ends on a plain `key` PK (not composite).
//   2) user_version lands at the current SCHEMA_VERSION.
//   3) sqlite_sequence survives the whole add-then-collapse round trip — no deleted id is reused.
//   4) a SECOND init() — a real restart against the SAME file — completes WITHOUT throwing and
//      changes NOTHING: schema (every table's SQL), row counts, and user_version are all identical.
//      This is the exact bug this fixture exists to catch: a prior version threw "no such column:
//      tenant_id" on this second call (the old Tenancy Phase 2 block and a stray base-schema index
//      statement were presence-gated, not version-gated, so they misread "already collapsed" as
//      "still pre-tenancy" and tried to rebuild against a column that no longer existed).
// Throws (non-zero exit) on any failure; prints FIXTURE OK on success.
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), fs = require('node:fs');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(os.tmpdir(), `plannr-tenmig-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

// ---- build the PRE-tenancy, PRE-Services-phase shape (a trimmed but faithful old schema) ----
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
    CREATE INDEX idx_cash_out_ledger_code ON cash_out(ledger_code);
    CREATE UNIQUE INDEX idx_contract_single_live ON contract((deleted_at IS NULL)) WHERE deleted_at IS NULL;
  `);
  d.prepare('INSERT INTO users(id,username,display_name,password_hash) VALUES (1,?,?,?)').run('owner', 'Owner', 'h');
  // 3 live cash_out rows, then bump sqlite_sequence to 17 (simulating 14 created + deleted) -> the reuse trap.
  for (let i = 0; i < 3; i++) d.prepare("INSERT INTO cash_out(amount_paise,tx_date,by_type,by_user_id,ledger_code,contract_scope) VALUES (?,?,?,?,?,?)").run(1000 * (i + 1), '2025-03-0' + (i + 1), 'user', 1, '4.0', 'extra');
  d.exec("UPDATE sqlite_sequence SET seq=17 WHERE name='cash_out'");
  d.prepare("INSERT INTO settings(key,value) VALUES ('budget_paise', ?)").run('4200000');
  d.close();
}

// ---- run the REAL migration (init) against this file ----
process.env.PLANNR_DB = dbPath;
process.env.PLANNR_TEST = '1';
const { db, init } = require('../db');

const TENANT_TABLES_8 = ['contract', 'contract_payment_dates', 'contractor_payments', 'contract_services', 'cash_in', 'cash_out', 'loans', 'ledger_customs'];
const ALL_TABLES = ['users', ...TENANT_TABLES_8, 'settings'];
const snapshot = () => JSON.stringify({
  counts: Object.fromEntries(ALL_TABLES.map((t) => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    return [t, exists ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : null];
  })),
  sum: db.prepare('SELECT COALESCE(SUM(amount_paise),0) s FROM cash_out').get().s,
  seq: Object.fromEntries(db.prepare('SELECT name,seq FROM sqlite_sequence').all().map((r) => [r.name, r.seq])),
  userVersion: db.prepare('PRAGMA user_version').get().user_version,
  schema: ALL_TABLES.map((t) => (db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(t) || {}).sql || null),
});

init(); // pre-tenancy -> the old Tenancy Phase 2 block adds tenant_id, Step 2a collapses it back off — one boot.

// 1) Every formerly-tenant table ends with NO tenant_id column.
for (const t of TENANT_TABLES_8) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(!cols.includes('tenant_id'), `${t}: tenant_id must be gone after the collapse (columns: ${cols.join(',')})`);
}
const settingsPk = db.prepare('PRAGMA table_info(settings)').all().filter((c) => c.pk > 0).map((c) => c.name);
assert.deepStrictEqual(settingsPk, ['key'], 'settings PK is a plain key (not composite) after the collapse');

// 2) user_version lands at the current SCHEMA_VERSION (read dynamically so this test never goes
// stale the next time SCHEMA_VERSION bumps — only that it landed somewhere >= 2, i.e. past collapse).
const SCHEMA_VERSION = db.prepare('PRAGMA user_version').get().user_version;
assert.ok(SCHEMA_VERSION >= 2, `user_version must be >= 2 after the collapse (got ${SCHEMA_VERSION})`);

// 3) sqlite_sequence survived the add-then-collapse round trip — still 17, so the next insert lands
// past the highest id ever used, never reusing deleted ids 4..17.
assert.strictEqual(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='cash_out'").get().seq, 17, 'sqlite_sequence SURVIVED the full add-then-collapse round trip (still 17)');
db.prepare("INSERT INTO cash_out(amount_paise,tx_date,by_type,ledger_code,contract_scope) VALUES (1,'2025-01-01','user','4.0','extra')").run();
assert.strictEqual(db.prepare('SELECT MAX(id) m FROM cash_out').get().m, 18, 'next id is 18 (no reuse of ids 4..17)');
const fp = db.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM cash_out').get();
assert.strictEqual(fp.n, 4, 'the original 3 rows survived the round trip, plus the one just inserted');

// 4) settings survived the round trip with its value intact.
assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='budget_paise'").get().value, '4200000', 'settings value survived the round trip');

assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'foreign_key_check clean after the first boot');

const afterFirst = snapshot();

// 5) THE BUG THIS FIXTURE EXISTS TO CATCH: a second boot (a real restart) against the SAME file must
// complete without throwing and must change NOTHING.
init(); // second boot
const afterSecond = snapshot();
assert.strictEqual(afterSecond, afterFirst, 'a second init() against the same file must be a complete no-op (same schema, counts, user_version)');

db.close();
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
console.log('FIXTURE OK');
