// validateBackup rejection branches (server.js ~2090-2183), exercised through POST /api/backup/import.
// validateBackup runs FIRST in the route and returns 400 BEFORE the auto-snapshot or any DB write, so
// a rejected import must both (a) carry the right message and (b) leave the ledger byte-for-byte
// unchanged. We start from a REAL export (guaranteed to pass validation), then mutate exactly ONE field
// per case so the asserted message is the one that field triggers.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let cookie, good, baseCashOut;
const clone = (o) => JSON.parse(JSON.stringify(o));

before(async () => {
  await H.startApp();
  cookie = H.seedLoggedIn().cookie;
  // Seed a contract + a contractor payment + a cash_out so the export has a row to mutate in each table.
  const cid = H.seedContract({ ledgerCode: '5.0' });
  H.seedPayment({ contractId: cid });
  H.seedCashOut({ ledgerCode: '1.0', contractScope: 'extra' });
  good = (await H.get('/api/backup/export?includeContacts=1', { cookie })).json;
  baseCashOut = H.db.prepare('SELECT COUNT(*) n FROM cash_out').get().n;
  // Guard: the pristine export must actually import cleanly, else every "reject" below is vacuous.
  assert.ok(good && good.tables && good.tables.cash_out.length >= 1, 'export has a cash_out row to mutate');
});
after(async () => { await H.stopApp(); });

// Mutate one field, POST, assert 400 + message substring + ledger unchanged.
async function rejects(mutate, needle) {
  const bad = clone(good);
  mutate(bad);
  const imp = await H.post('/api/backup/import', bad, { cookie });
  assert.strictEqual(imp.status, 400, `expected 400, got ${imp.status}: ${JSON.stringify(imp.json)}`);
  assert.ok(imp.json && typeof imp.json.error === 'string' && imp.json.error.includes(needle),
    `error should contain ${JSON.stringify(needle)}; got ${JSON.stringify(imp.json)}`);
  // Rejected before the snapshot/transaction -> data is untouched.
  assert.strictEqual(H.db.prepare('SELECT COUNT(*) n FROM cash_out').get().n, baseCashOut, 'ledger must be unchanged after a rejected import');
}

test('wrong schemaVersion is rejected', () => rejects((b) => { b.schemaVersion = 999; }, 'Unsupported backup version'));

test('cash_out.contract_stated_paise non-integer is rejected', () => rejects((b) => { b.tables.cash_out[0].contract_stated_paise = 12.5; }, 'contract_stated_paise must be an integer'));

test('cash_out.amount_paise <= 0 is rejected', () => rejects((b) => { b.tables.cash_out[0].amount_paise = 0; }, 'cash_out: amount_paise must be a positive integer'));

test('cash_out.by_type outside [user,contractor,custom] is rejected', () => rejects((b) => { b.tables.cash_out[0].by_type = 'relative'; }, 'cash_out: invalid by_type'));

test('cash_out unknown ledger_code is rejected', () => rejects((b) => { b.tables.cash_out[0].ledger_code = '9.9.9'; }, 'cash_out: unknown ledger_code'));

test('cash_out subledger_code not belonging to its ledger is rejected', () => rejects((b) => { b.tables.cash_out[0].ledger_code = '1.0'; b.tables.cash_out[0].subledger_code = '9.9.9'; }, 'does not belong to ledger'));

test('cash_out contract_service_id not present in the file is rejected', () => rejects((b) => { b.tables.cash_out[0].contract_service_id = 999999; }, "is not present in the backup's contract_services"));

test('contractor_payments.amount_paise <= 0 is rejected', () => {
  // Guard: there is a contractor_payments row to mutate.
  assert.ok(good.tables.contractor_payments && good.tables.contractor_payments.length >= 1, 'export has a contractor_payments row');
  return rejects((b) => { b.tables.contractor_payments[0].amount_paise = 0; }, 'contractor_payments: amount_paise must be a positive integer');
});
