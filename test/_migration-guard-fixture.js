// Spawned by migration-guard.test.js (NOT a *.test.js file, so the runner skips it). db.js binds its
// single connection to PLANNR_DB at require time, so exercising the real init() migration chain needs
// a fresh process. Proves the Phase-11B fix to the cash_out phase_custom_name rebuild guard (db.js):
//   A) a FUTURE re-add of phase_custom_name on an already-migrated DB (user_version=SCHEMA_VERSION) must
//      NOT trigger the destructive rebuild — the exact landmine that Phase-5B's contract_service_id
//      re-add caused.
//   B) a genuine PRE-MARKER DB carrying phase_custom_name (user_version=0) MUST still rebuild it away,
//      without losing any row — the original migration still works for real old databases.
// Throws (non-zero exit) on any failure; prints FIXTURE OK on success.
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), fs = require('node:fs');
const assert = require('node:assert');

const dbPath = path.join(os.tmpdir(), `plannr-guard-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.PLANNR_DB = dbPath;
process.env.PLANNR_TEST = '1';
const { db, init } = require('../db.js');

const fp = () => db.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM cash_out').get();
const hasCol = (c) => db.prepare('PRAGMA table_info(cash_out)').all().some((r) => r.name === c);
const userVersion = () => db.prepare('PRAGMA user_version').get().user_version;

// 1) Build the CURRENT schema via the REAL init(), then seed a user + 3 known cash_out rows.
init();
const SCHEMA_VERSION = userVersion();
assert.ok(SCHEMA_VERSION > 0, 'init() stamps the schema-version marker (user_version > 0)');
db.prepare("INSERT INTO users(id,username,display_name,password_hash) VALUES (1,'owner','Owner','h')").run();
for (let i = 1; i <= 3; i++) {
  db.prepare('INSERT INTO cash_out(amount_paise,tx_date,by_type,by_user_id,ledger_code,contract_scope) VALUES (?,?,?,?,?,?)')
    .run(1000 * i, '2025-04-0' + i, 'user', 1, '4.0', 'extra');
}
const base = fp();
assert.strictEqual(base.n, 3, 'seed: 3 rows'); assert.strictEqual(base.s, 6000, 'seed: sum 6000');

// 2) SCENARIO A — a re-add of phase_custom_name on a MARKED DB (user_version=SCHEMA_VERSION) must be left alone.
db.exec('ALTER TABLE cash_out ADD COLUMN phase_custom_name TEXT');
assert.ok(hasCol('phase_custom_name'), 'precondition: phase_custom_name re-added');
init(); // second boot
assert.ok(hasCol('phase_custom_name'), 'DEFUSED: re-added phase_custom_name survived — no destructive rebuild on a marked DB');
const a = fp();
assert.strictEqual(a.n, 3, 'A: no rows lost'); assert.strictEqual(a.s, 6000, 'A: amounts intact');

// 3) SCENARIO B — a genuine PRE-MARKER DB (user_version=0) carrying phase_custom_name MUST rebuild.
db.exec('PRAGMA user_version = 0'); // simulate a DB from before the marker existed
init();
assert.ok(!hasCol('phase_custom_name'), 'FIRES: pre-marker DB rebuilt phase_custom_name away');
const b = fp();
assert.strictEqual(b.n, 3, 'B: rebuild preserved every row'); assert.strictEqual(b.s, 6000, 'B: rebuild preserved amounts');
assert.strictEqual(userVersion(), SCHEMA_VERSION, 'B: marker re-stamped after the rebuild');

db.close();
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
console.log('FIXTURE OK');
