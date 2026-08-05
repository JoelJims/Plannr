// Spawned by tenancy.test.js (NOT a *.test.js file, so the runner skips it). db.js binds its single
// connection to PLANNR_DB at require time, so the ONLY way to exercise the real pre->post-tenancy
// migration is in a fresh process. This builds a PRE-tenancy DB (no tenant_id anywhere, cash_out rows
// with an inflated sqlite_sequence), runs the real init() TWICE, and asserts the migration + its
// idempotency + sqlite_sequence survival. Throws (non-zero exit) on any failure; prints FIXTURE OK.
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), fs = require('node:fs');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(os.tmpdir(), `plannr-tenmig-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

// ---- build the PRE-tenancy shape (a trimmed but faithful old schema; no tenant_id) ----
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
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE edit_locks(scope TEXT PRIMARY KEY, holder_user_id INTEGER, holder_display_name TEXT, acquired_at TEXT, last_heartbeat_at TEXT);
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

// ---- run the REAL migration (init) twice ----
process.env.PLANNR_DB = dbPath;
process.env.PLANNR_TEST = '1';
const { db, init } = require('../db');
const SIX = ['cash_out', 'cash_in', 'loans', 'contract', 'contract_payment_dates', 'contractor_payments'];
const snapshot = () => JSON.stringify({
  counts: Object.fromEntries(['users', ...SIX, 'settings'].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n])),
  sum: db.prepare('SELECT COALESCE(SUM(amount_paise),0) s FROM cash_out').get().s,
  seq: Object.fromEntries(db.prepare('SELECT name,seq FROM sqlite_sequence').all().map((r) => [r.name, r.seq])),
  schema: SIX.map((t) => db.prepare(`SELECT sql FROM sqlite_master WHERE name='${t}'`).get().sql),
});

init();                              // pre -> tenancy
const afterFirst = snapshot();
init();                              // second boot
const afterSecond = snapshot();
assert.strictEqual(afterFirst, afterSecond, 'migration is IDEMPOTENT — a second init changes nothing');

for (const t of SIX) {
  const col = db.prepare(`PRAGMA table_info(${t})`).all().find((c) => c.name === 'tenant_id');
  assert.ok(col && col.notnull === 1, `${t}.tenant_id exists and is NOT NULL`);
}
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cash_out WHERE tenant_id = 1').get().n, 3, 'cash_out rows backfilled to tenant 1');
assert.strictEqual(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='cash_out'").get().seq, 17, 'sqlite_sequence SURVIVED the migration (still 17)');
assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'foreign_key_check clean');
// next insert lands past the high-water mark, not reusing a deleted id
db.prepare("INSERT INTO cash_out(amount_paise,tx_date,by_type,ledger_code,contract_scope,tenant_id) VALUES (1,'2025-01-01','user','4.0','extra',1)").run();
assert.strictEqual(db.prepare('SELECT MAX(id) m FROM cash_out').get().m, 18, 'next id is 18 (no reuse of deleted 12..17)');
// settings became composite + backfilled
const setPk = db.prepare('PRAGMA table_info(settings)').all().filter((c) => c.pk > 0).map((c) => c.name).sort();
assert.deepStrictEqual(setPk, ['key', 'tenant_id'], 'settings PK is composite (tenant_id, key)');
assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key='budget_paise' AND tenant_id=1").get().value, '4200000', 'settings backfilled to tenant 1');

db.close();
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
console.log('FIXTURE OK');
