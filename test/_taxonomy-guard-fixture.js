// Spawned by taxonomy-guard.test.js (NOT a *.test.js file, so the runner skips it). db.js binds its
// single connection to PLANNR_DB at require time, so exercising the real init() migration chain needs
// a fresh process.
//
// Proves the DATA-LOSS GUARD on the Phase 10a ledger-taxonomy cleanup (db.js). That block does
// `DELETE FROM cash_out` and is MARKER-gated, not version-gated — so a database already stamped at
// the current SCHEMA_VERSION still runs it on its first pass, and before the guard it wiped the
// entire Money Debited history with no warning. The scenarios below pin every path:
//   A) rows present + marker absent + no approval  -> init() THROWS, rows intact, marker still unset
//   B) ...the refusal REPEATS on the next boot (not a one-shot the user can miss)
//   C) settings-key approval ('_taxonomy_wipe_approved') -> proceeds; this is the ONLY escape hatch
//      the Android/browser build has, since it has no environment variables
//   D) env-var approval (PLANNR_ALLOW_TAXONOMY_WIPE=1) -> proceeds; the Node/desktop hatch
//   E) cash_out EMPTY + marker absent -> proceeds silently, marker set (fresh install: unaffected)
//   F) marker already set -> block skipped entirely; rows with any codes survive untouched
// Throws (non-zero exit) on any failure; prints FIXTURE OK on success.
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const assert = require('node:assert');

const dbPath = path.join(os.tmpdir(), `plannr-taxguard-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.PLANNR_DB = dbPath;
process.env.PLANNR_TEST = '1';
delete process.env.PLANNR_ALLOW_TAXONOMY_WIPE; // start from "not approved" regardless of the caller
const { db, init } = require('../db.js');

const MARKER = '_migrated_ledger_taxonomy_v1';
const APPROVAL = '_taxonomy_wipe_approved';

const rows = () => db.prepare('SELECT COUNT(*) n FROM cash_out').get().n;
const hasMarker = () => !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MARKER);
const userVersion = () => db.prepare('PRAGMA user_version').get().user_version;
const unmark = () => db.prepare('DELETE FROM settings WHERE key = ?').run(MARKER);
const unapprove = () => db.prepare('DELETE FROM settings WHERE key = ?').run(APPROVAL);
const approveViaSettings = () => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(APPROVAL, '1');

let ownerId;
function seed(n) {
  db.exec('DELETE FROM cash_out');
  for (let i = 1; i <= n; i++) {
    db.prepare('INSERT INTO cash_out(amount_paise,tx_date,by_type,by_user_id,ledger_code,contract_scope) VALUES (?,?,?,?,?,?)')
      .run(1000 * i, '2025-04-0' + i, 'user', ownerId, '4.0', 'extra');
  }
  assert.strictEqual(rows(), n, `seed: ${n} rows`);
}

// ---- build a CURRENT-schema database via the real init(), then reproduce the incident precondition:
// schema and user_version already current, but the taxonomy marker absent and cash_out non-empty.
// That is exactly a database that predates Phase 10a and is otherwise fully migrated.
init();
const SCHEMA_VERSION = userVersion();
assert.ok(SCHEMA_VERSION > 0, 'init() stamps user_version');
assert.ok(hasMarker(), 'a fresh empty DB completes the taxonomy cleanup normally (marker set)');
ownerId = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get().id;

// ---- A) rows present, marker absent, no approval -> refuse, lose nothing ------------------------
seed(3);
unmark(); unapprove();
assert.strictEqual(userVersion(), SCHEMA_VERSION, 'precondition: user_version is ALREADY current (gives no warning)');
assert.throws(() => init(), /Plannr stopped to protect your data/, 'A: init() must refuse rather than wipe');
assert.strictEqual(rows(), 3, 'A: all 3 rows survive the refusal — nothing deleted');
assert.strictEqual(hasMarker(), false, 'A: the marker stays UNSET so the refusal is not a one-shot');

// the message has to be actionable, not just a stack trace
let msg = '';
try { init(); } catch (e) { msg = e.message; }
assert.match(msg, /EXPORT A BACKUP FIRST/, 'A: the error tells the user to export a backup first');
assert.match(msg, /PLANNR_ALLOW_TAXONOMY_WIPE=1/, 'A: the error names the Node approval');
assert.match(msg, new RegExp(APPROVAL), 'A: the error names the settings-key approval (Android/browser)');
assert.match(msg, /There are 3 here/, 'A: the error states how many rows are at stake');

// ---- B) the refusal repeats on the next boot ----------------------------------------------------
assert.throws(() => init(), /Plannr stopped to protect your data/, 'B: a second boot refuses again');
assert.strictEqual(rows(), 3, 'B: still nothing deleted');

// ---- C) settings-key approval (the Android/browser hatch) ---------------------------------------
approveViaSettings();
init();
assert.strictEqual(rows(), 0, 'C: with settings approval the cleanup proceeds and wipes cash_out');
assert.ok(hasMarker(), 'C: marker set after an approved run');

// ---- D) env-var approval (the Node/desktop hatch) ------------------------------------------------
seed(2);
unmark(); unapprove();
assert.throws(() => init(), /Plannr stopped to protect your data/, 'D: precondition — refuses without approval');
process.env.PLANNR_ALLOW_TAXONOMY_WIPE = '1';
init();
assert.strictEqual(rows(), 0, 'D: with the env var the cleanup proceeds');
assert.ok(hasMarker(), 'D: marker set');
delete process.env.PLANNR_ALLOW_TAXONOMY_WIPE;

// ---- E) the ordinary path is untouched: empty cash_out, no marker -> proceeds silently -----------
db.exec('DELETE FROM cash_out');
unmark(); unapprove();
assert.strictEqual(rows(), 0, 'E: precondition — nothing to lose');
init(); // must NOT throw
assert.ok(hasMarker(), 'E: a fresh/empty DB still completes the cleanup with no approval needed');

// ---- F) an already-marked DB skips the block entirely -------------------------------------------
seed(4);
unapprove();
assert.ok(hasMarker(), 'F: precondition — marker already set');
init(); // must NOT throw and must NOT wipe
assert.strictEqual(rows(), 4, 'F: normal operation unaffected — a marked DB keeps its rows');
assert.strictEqual(userVersion(), SCHEMA_VERSION, 'F: user_version unchanged');

console.log('FIXTURE OK');
