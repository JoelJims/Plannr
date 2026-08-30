// Spawned by service-price-guard.test.js (NOT a *.test.js file, so the runner skips it). db.js binds
// its single connection to PLANNR_DB at require time, so exercising the real init() migration chain
// needs a fresh process.
//
// Proves the DATA-LOSS GUARD on Contract Phase A's A3 step (db.js). That block does
// `ALTER TABLE contract_services DROP COLUMN price_paise` and is MARKER-gated, not version-gated —
// so a database already stamped at the current SCHEMA_VERSION still runs it on its first pass, and
// without the guard it would drop the owner's service prices with no warning. The scenarios below
// pin every path:
//   A) priced services + marker absent + no approval -> init() THROWS, prices intact, column intact,
//      marker still unset, and the message names the services and both approval hatches
//   B) ...the refusal REPEATS on the next boot (not a one-shot the user can miss)
//   C) settings-key approval ('_service_price_drop_approved') -> proceeds; the ONLY escape hatch the
//      Android/browser build has, since it has no environment variables. The prices are ARCHIVED
//      into settings first, so they survive in every future backup even though the column does not.
//   D) env-var approval (PLANNR_ALLOW_SERVICE_PRICE_DROP=1) -> proceeds; the Node/desktop hatch
//   E) the column exists but every service is UNPRICED -> proceeds silently, no approval needed
//   F) marker already set -> block skipped entirely, even with a re-added price_paise column
//      (a future re-add for a new purpose must NOT re-arm a destructive drop)
// Throws (non-zero exit) on any failure; prints FIXTURE OK on success.
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const assert = require('node:assert');

const dbPath = path.join(os.tmpdir(), `plannr-svcprice-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.PLANNR_DB = dbPath;
process.env.PLANNR_TEST = '1';
delete process.env.PLANNR_ALLOW_SERVICE_PRICE_DROP; // start from "not approved" regardless of the caller
const { db, init } = require('../db.js');

const MARKER = '_migrated_service_price_removed_v1';
const APPROVAL = '_service_price_drop_approved';
const ARCHIVE = '_archived_service_prices_v1';

const cols = () => db.prepare('PRAGMA table_info(contract_services)').all().map((c) => c.name);
const hasPriceCol = () => cols().includes('price_paise');
const setting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
const hasMarker = () => setting(MARKER) != null;
const userVersion = () => db.prepare('PRAGMA user_version').get().user_version;
const unmark = () => db.prepare('DELETE FROM settings WHERE key = ?').run(MARKER);
const unapprove = () => db.prepare('DELETE FROM settings WHERE key = ?').run(APPROVAL);
const unarchive = () => db.prepare('DELETE FROM settings WHERE key = ?').run(ARCHIVE);
const approveViaSettings = () => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(APPROVAL, '1');

// Reproduce a PRE-Phase-A database: the column back, populated, and the marker cleared. Everything
// else about the schema stays current — which is the point, since user_version gives no warning.
function makePrePhaseA(services) {
  db.exec('DELETE FROM contract_services');
  db.exec('DELETE FROM contract');
  if (hasPriceCol()) db.exec('ALTER TABLE contract_services DROP COLUMN price_paise');
  db.exec('ALTER TABLE contract_services ADD COLUMN price_paise INTEGER');
  const cid = Number(db.prepare("INSERT INTO contract (contractor_name, area_of_work, ledger_code, date_signed) VALUES ('ACME','Foundation','5.0','2026-07-01')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO contract_services (contract_id, name, price_paise) VALUES (?, ?, ?)');
  for (const s of services) ins.run(cid, s.name, s.price_paise);
  unmark(); unapprove(); unarchive();
  assert.strictEqual(hasPriceCol(), true, 'precondition: the column is present again');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM contract_services').get().n, services.length);
}

const PRICED = [
  { name: 'Electrical', price_paise: 4000000 },
  { name: 'Plumbing', price_paise: 1250000 },
  { name: 'Consultation', price_paise: null },
];

// ---- baseline: a fresh database completes the change with nothing to lose ------------------------
init();
const SCHEMA_VERSION = userVersion();
assert.ok(SCHEMA_VERSION > 0, 'init() stamps user_version');
assert.ok(hasMarker(), 'a fresh DB completes the Phase A service-price removal normally (marker set)');
assert.strictEqual(hasPriceCol(), false, 'and a fresh DB never has the column at all');

// ---- A) priced services, marker absent, no approval -> refuse, lose nothing ----------------------
makePrePhaseA(PRICED);
assert.strictEqual(userVersion(), SCHEMA_VERSION, 'precondition: user_version is ALREADY current (gives no warning)');
assert.throws(() => init(), /Plannr stopped to protect your data/, 'A: init() must refuse rather than drop');
assert.strictEqual(hasPriceCol(), true, 'A: the column survives the refusal');
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM contract_services WHERE price_paise IS NOT NULL').get().n, 2, 'A: both priced rows still hold their price');
assert.strictEqual(hasMarker(), false, 'A: the marker stays UNSET so the refusal is not a one-shot');

// the message has to be actionable, and has to carry the numbers it is about to destroy
let msg = '';
try { init(); } catch (e) { msg = e.message; }
assert.match(msg, /2 services have a price stored here/, 'A: the error states how many prices are at stake');
assert.match(msg, /Electrical: ₹40000\.00/, 'A: and lists them, so the owner can read them off the refusal itself');
assert.match(msg, /Plumbing: ₹12500\.00/);
assert.doesNotMatch(msg, /Consultation/, 'A: an unpriced service is not listed — it has nothing to lose');
assert.match(msg, /EXPORT A BACKUP/, 'A: the error tells the user to export a backup first');
assert.match(msg, /PLANNR_ALLOW_SERVICE_PRICE_DROP=1/, 'A: the error names the Node approval');
assert.match(msg, new RegExp(APPROVAL), 'A: the error names the settings-key approval (Android/browser)');

// ---- B) the refusal repeats on the next boot ------------------------------------------------------
assert.throws(() => init(), /Plannr stopped to protect your data/, 'B: a second boot refuses again');
assert.strictEqual(hasPriceCol(), true, 'B: still nothing dropped');

// ---- C) settings-key approval (the Android/browser hatch), and the archive ------------------------
approveViaSettings();
init();
assert.strictEqual(hasPriceCol(), false, 'C: with settings approval the column is dropped');
assert.ok(hasMarker(), 'C: marker set after an approved run');
const archived = JSON.parse(setting(ARCHIVE));
assert.strictEqual(archived.length, 2, 'C: the two prices are archived into settings, not simply lost');
assert.deepStrictEqual(archived.map((r) => [r.name, r.price_paise]), [['Electrical', 4000000], ['Plumbing', 1250000]]);
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM contract_services').get().n, 3, 'C: the service ROWS survive — only the price column goes');

// ---- D) env-var approval (the Node/desktop hatch) --------------------------------------------------
makePrePhaseA([{ name: 'Tiling', price_paise: 900000 }]);
assert.throws(() => init(), /Plannr stopped to protect your data/, 'D: precondition — refuses without approval');
process.env.PLANNR_ALLOW_SERVICE_PRICE_DROP = '1';
init();
assert.strictEqual(hasPriceCol(), false, 'D: with the env var the drop proceeds');
assert.ok(hasMarker(), 'D: marker set');
delete process.env.PLANNR_ALLOW_SERVICE_PRICE_DROP;

// ---- E) the ordinary path: the column is there but nothing is priced -> no approval needed --------
makePrePhaseA([{ name: 'Scope item A', price_paise: null }, { name: 'Scope item B', price_paise: null }]);
init(); // must NOT throw
assert.strictEqual(hasPriceCol(), false, 'E: an all-unpriced database drops the column silently');
assert.ok(hasMarker(), 'E: marker set');
assert.strictEqual(setting(ARCHIVE), null, 'E: nothing to archive, so nothing is written');
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM contract_services').get().n, 2, 'E: the rows are untouched');

// ---- F) an already-marked DB skips the block entirely, even with the column re-added ---------------
// This is the Phase 5B landmine in the abstract: a presence-only guard would see price_paise and
// re-run a DESTRUCTIVE drop on a column re-added for some future purpose. The marker prevents it.
db.exec('ALTER TABLE contract_services ADD COLUMN price_paise INTEGER');
db.exec('UPDATE contract_services SET price_paise = 777');
unapprove();
assert.ok(hasMarker(), 'F: precondition — marker already set');
init(); // must NOT throw and must NOT drop
assert.strictEqual(hasPriceCol(), true, 'F: a re-added column is left alone on a marked database');
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM contract_services WHERE price_paise = 777').get().n, 2, 'F: and its values survive');
assert.strictEqual(userVersion(), SCHEMA_VERSION, 'F: user_version unchanged');

console.log('FIXTURE OK');
