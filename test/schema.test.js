// Schema invariants — integer-paise money (no float drift), FK integrity, ownership-completeness guard.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

test('money is integer paise end to end — no float drift on amounts that round badly', async () => {
  // 0.29 as a float is 28.9999…; a float pipeline would store 28. The string parser stores 29.
  const cases = [['0.29', 29], ['0.10', 10], ['19.99', 1999], ['1234567.89', 123456789]];
  for (const [rupees, paise] of cases) {
    const r = await H.post('/api/cash-out', { amountRupees: rupees, txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '1.0', contractScope: 'extra' }, { cookie });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const stored = H.db.prepare('SELECT amount_paise FROM cash_out WHERE id = ?').get(r.json.entry.id).amount_paise;
    assert.strictEqual(stored, paise, `${rupees} must store exactly ${paise} paise (got ${stored})`);
    assert.strictEqual(Number.isInteger(stored), true, 'stored value is an integer');
  }
  // The Overview sum is exact integer arithmetic too (0.29+0.10+19.99+1234567.89 = 1234588.27).
  const ov = (await H.get('/api/overview', { cookie })).json;
  assert.strictEqual(ov.money.totalSpentPaise, 29 + 10 + 1999 + 123456789, 'summed paise is exact');
});

test('foreign_key_check is clean after a full seed-and-delete cycle', async () => {
  const cid = H.seedContract();
  const pid = H.seedPayment({ contractId: cid });
  H.seedCashOut({ byUserId: userId, contractScope: 'extra' });
  H.seedCashIn({ byUserId: userId });
  H.db.prepare('INSERT INTO loans (amount_paise, bank_name, tenant_id) VALUES (?, ?, (SELECT MIN(id) FROM users))').run(500000, 'Bank');
  // soft-delete some, hard-delete others
  await H.del('/api/contractor-payments/' + pid, { cookie }); // soft
  H.db.prepare('DELETE FROM cash_in').run();                    // hard
  const violations = H.db.prepare('PRAGMA foreign_key_check').all();
  assert.strictEqual(violations.length, 0, 'no FK violations: ' + JSON.stringify(violations));
});

test('assertImportOwnershipComplete() passes on the real schema', () => {
  assert.doesNotThrow(() => H.app._assertImportOwnershipComplete(), 'the shipped schema is ownership-complete');
});

test('assertImportOwnershipComplete() THROWS when a table with a FK into an owned table is not itself owned', () => {
  // Create a table with a foreign key INTO an owned table (cash_out) that is NOT in IMPORT_OWNED_TABLES.
  H.db.exec('CREATE TABLE zzz_fk_probe (id INTEGER PRIMARY KEY, co INTEGER REFERENCES cash_out(id))');
  try {
    assert.throws(() => H.app._assertImportOwnershipComplete(), /IMPORT_OWNED_TABLES is incomplete/);
  } finally {
    H.db.exec('DROP TABLE zzz_fk_probe');
  }
  assert.doesNotThrow(() => H.app._assertImportOwnershipComplete(), 'clean again after dropping the probe');
});
