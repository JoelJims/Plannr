// Spawned by ledger-rename.test.js (NOT a *.test.js file, so the runner skips it). db.js binds its
// single connection to PLANNR_DB at require time, so exercising the real init() migration chain needs
// a fresh process — same reason as the taxonomy / service-price guard fixtures.
//
// Proves the GENERIC-NAME migration ('_migrated_generic_ledger_names_v1' in db.js). Five seeded
// sub-ledger LABELS were copied out of one construction agreement, or named one region's utility;
// ledgers.js now seeds generic names instead. But the Phase 10b seed only ever runs against an EMPTY
// ledger_subs, so an installed database would keep the old labels forever — hence a rename in place.
//
// This is deliberately NOT guarded like the Phase 10a taxonomy cleanup: no row is deleted, no CODE
// changes, and "code IS the identity across a rename" is the taxonomy's own rule. The scenarios below
// are what make that claim checkable rather than merely asserted:
//   A) a fresh install seeds the generic names directly, and the marker is set
//   B) a pre-rename DB (old labels, marker absent) is renamed on the next boot, WITHOUT any approval
//      env var or settings key, and WITHOUT throwing
//   C) every cash_out row survives that boot untouched — same ids, same amounts, same codes — because
//      only ledger_subs.name changed
//   D) a label the OWNER already changed (via the Ledger List CSV round trip) is left exactly as they
//      left it: the UPDATE matches the old name as well as the code
//   E) with the marker already set, a deliberate rename BACK to an old label is not undone
// Throws (non-zero exit) on any failure; prints FIXTURE OK on success.
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const assert = require('node:assert');

const dbPath = path.join(os.tmpdir(), 'plannr-ledgerrename-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.db');
process.env.PLANNR_DB = dbPath;
process.env.PLANNR_TEST = '1';
// No approval hatch should ever be needed here; make sure one is not quietly in the environment.
delete process.env.PLANNR_ALLOW_TAXONOMY_WIPE;
const { db, init } = require('../db.js');

const MARKER = '_migrated_generic_ledger_names_v1';
const RENAMES = [
  ['20.1', 'Electricity connection (KSEB)', 'Electricity connection'],
  ['21.1', 'Equipment rental — mixer, JCB', 'Equipment rental — mixer, excavator'],
  ['23.4', 'Plastic waste — Harithakarmasena', 'Plastic waste handover'],
  ['24.2', 'Foundation depth beyond 2.5 ft', 'Additional foundation work'],
  ['24.3', 'Plinth height beyond 1.5 ft', 'Additional plinth work'],
];

const nameOf = (code) => db.prepare('SELECT name FROM ledger_subs WHERE code = ?').get(code).name;
const setName = (code, name) => db.prepare('UPDATE ledger_subs SET name = ? WHERE code = ?').run(name, code);
const hasMarker = () => !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MARKER);
const unmark = () => db.prepare('DELETE FROM settings WHERE key = ?').run(MARKER);
const subCount = () => db.prepare('SELECT COUNT(*) n FROM ledger_subs').get().n;
const outRows = () => db.prepare('SELECT id, amount_paise, ledger_code, subledger_code FROM cash_out ORDER BY id').all();

// ---- A) a fresh install seeds the generic names --------------------------------------------------
init();
for (const [code, oldName, newName] of RENAMES) {
  assert.strictEqual(nameOf(code), newName, 'A: ' + code + ' seeds as "' + newName + '"');
  assert.notStrictEqual(nameOf(code), oldName, 'A: ' + code + ' does not seed the contract-specific label');
}
assert.ok(hasMarker(), 'A: the marker is set after a fresh install');
const SUBS = subCount();
const ownerId = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get().id;

// ---- B/C) a pre-rename database: old labels, marker absent, real spend tagged to those codes ------
for (const [code, oldName] of RENAMES) setName(code, oldName);
unmark();
db.exec('DELETE FROM cash_out');
const insOut = db.prepare('INSERT INTO cash_out(amount_paise,tx_date,by_type,by_user_id,ledger_code,subledger_code,contract_scope) VALUES (?,?,?,?,?,?,?)');
insOut.run(150000, '2026-04-01', 'user', ownerId, '24.0', '24.2', 'extra');
insOut.run(275000, '2026-04-02', 'user', ownerId, '24.0', '24.3', 'extra');
insOut.run(90000, '2026-04-03', 'user', ownerId, '20.0', '20.1', 'extra');
const beforeRows = outRows();
assert.strictEqual(beforeRows.length, 3, 'B: precondition — three tagged debits');

init(); // must NOT throw, and must need no approval

for (const [code, , newName] of RENAMES) {
  assert.strictEqual(nameOf(code), newName, 'B: ' + code + ' was renamed in place on the next boot');
}
assert.ok(hasMarker(), 'B: the marker is set after the rename');
assert.strictEqual(subCount(), SUBS, 'C: no sub-ledger was added or removed — only labels changed');
assert.deepStrictEqual(outRows(), beforeRows, 'C: every debit survives with the SAME codes — a rename is not a re-coding');

// ---- D) a label the owner already changed is never stomped ----------------------------------------
setName('24.2', 'Extra digging we agreed in March');
unmark();
init();
assert.strictEqual(nameOf('24.2'), 'Extra digging we agreed in March', 'D: a label the owner edited is left alone');
assert.strictEqual(nameOf('24.3'), 'Additional plinth work', 'D: and the ones they did not touch stay generic');
assert.deepStrictEqual(outRows(), beforeRows, 'D: still no debit disturbed');

// ---- E) with the marker set, a deliberate rename back is not undone -------------------------------
assert.ok(hasMarker(), 'E: precondition — the marker was set by the previous run');
setName('24.3', 'Plinth height beyond 1.5 ft');
init();
assert.strictEqual(nameOf('24.3'), 'Plinth height beyond 1.5 ft', 'E: a marked DB is not re-renamed on every boot');

console.log('FIXTURE OK');
