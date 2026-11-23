// Q14: a ledger entry and its custom-name write (cash_out's afterWrite) are one transaction. Before
// the fix they were two writes: if the custom-name write failed, the entry stayed saved while the
// answer was an error, so a retry saved it twice.
// The test database is a fresh temp file (test/helpers.js). Nothing opens data/plannr.db.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

before(async () => { await H.startApp(); H.clearLedger(); });
after(async () => { await H.stopApp(); });

const failCustoms = () => H.db.exec("CREATE TRIGGER q14_fail BEFORE INSERT ON ledger_customs BEGIN SELECT RAISE(ABORT, 'q14: custom name write failed'); END");
const allowCustoms = () => H.db.exec('DROP TRIGGER IF EXISTS q14_fail');
const count = () => H.db.prepare("SELECT COUNT(*) AS n FROM cash_out WHERE reason = 'Q14 entry'").get().n;
const body = (name) => ({ amountRupees: '150.00', txDate: '2026-03-05', byType: 'custom', byLabel: 'Site', ledgerCode: 'CUSTOM', ledgerCustomName: name, contractScope: 'extra', reason: 'Q14 entry' });

test('Q14: when the custom-name write fails, the new entry is not saved either; the retry saves it once', async () => {
  failCustoms();
  const r1 = await H.post('/api/cash-out', body('Scaffolding hire'));
  allowCustoms();
  assert.notStrictEqual(r1.status, 201, 'the failed write must not answer 201');
  assert.strictEqual(count(), 0, 'the entry was saved although the request failed');
  const r2 = await H.post('/api/cash-out', body('Scaffolding hire'));
  assert.strictEqual(r2.status, 201, JSON.stringify(r2.json));
  assert.strictEqual(count(), 1, 'the retry must leave exactly one entry');
});

test('Q14: when the custom-name write fails on an edit, the edit is rolled back', async () => {
  const id = H.db.prepare("SELECT id FROM cash_out WHERE reason = 'Q14 entry'").get().id;
  failCustoms();
  const r = await H.put(`/api/cash-out/${id}`, { ...body('Formwork hire'), amountRupees: '999.00' });
  allowCustoms();
  assert.notStrictEqual(r.status, 200);
  const row = H.db.prepare('SELECT amount_paise, ledger_custom_name FROM cash_out WHERE id = ?').get(id);
  assert.strictEqual(row.amount_paise, 15000, 'the amount changed although the edit failed');
  assert.strictEqual(row.ledger_custom_name, 'Scaffolding hire');
});
