// Dues maths + the cumulative-vs-range distinction + the two surviving reconciliation detections.
//
// HISTORY: this file used to assert the Phase 5E "Option C" reimbursement offset — the worked example
// "contract 1,00,000 − 40,000 paid − 40,000 offset = owed 20,000", plus the contract_stated_paise
// validation rules and the missing-offset reconciliation check. That offset has been REMOVED, all or
// nothing: cash_out.contract_stated_paise is no longer written by any code path, and NO 'included'
// debit reduces owed — not even a legacy row that still carries a stored value (proven below). The
// worked example is kept, re-based on the behaviour that replaced it: owed = stated − paid = 60,000.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const ov = async (q = '') => (await H.get('/api/overview' + q, { cookie })).json;

// The same shape as the old worked example — contract ₹1,00,000, ₹40,000 paid, and a ₹32,000
// 'included' debit — so the change in owed is directly comparable.
async function seedWorkedExample() {
  const c = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', statedAmountRupees: '100000.00', dateSigned: '2026-07-01' }, { cookie });
  assert.strictEqual(c.status, 201, JSON.stringify(c.json));
  const cid = c.json.contract.id;
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: cid, amountRupees: '40000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  const deb = await H.post('/api/cash-out', { amountRupees: '32000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', subledgerCode: '', contractScope: 'included' }, { cookie });
  assert.strictEqual(deb.status, 201, JSON.stringify(deb.json));
  assert.strictEqual(deb.json.entry.contractStatedPaise, null, 'no stated amount is written any more');
  return cid;
}

test('worked example: contract 1,00,000 − 40,000 paid = owed 60,000 (an included debit offsets nothing)', async () => {
  await seedWorkedExample();
  const m = (await ov()).money;
  assert.strictEqual(m.totalContractPaise, 10000000, 'A = contract stated');
  assert.strictEqual(m.paidToContractorsPaise, 4000000, 'B = paid');
  assert.strictEqual(m.spentBySelfPaise, 3200000, 'C = real ₹32,000 spent');
  assert.strictEqual(m.totalSpentPaise, 7200000, 'D includes the real ₹32,000');
  assert.strictEqual(m.owedToContractorsPaise, 6000000, 'F owed = ₹60,000 — the included debit does NOT reduce dues');
});

test('the offset is off for LEGACY rows too: a stored contract_stated_paise changes nothing', async () => {
  await seedWorkedExample();
  const before = (await ov()).money.owedToContractorsPaise;
  // Only reachable via a pre-change backup import or direct SQL now — exactly the legacy case.
  H.db.prepare("UPDATE cash_out SET contract_stated_paise = 4000000 WHERE contract_scope='included'").run();
  const after = (await ov()).money.owedToContractorsPaise;
  assert.strictEqual(before, 6000000);
  assert.strictEqual(after, 6000000, 'a legacy stated value must NOT come back as an offset (all-or-nothing)');
});

test('editing a legacy row PRESERVES its stored contract_stated_paise (the column is left alone)', async () => {
  await seedWorkedExample();
  const id = (await H.get('/api/cash-out', { cookie })).json.entries[0].id;
  H.db.prepare('UPDATE cash_out SET contract_stated_paise = 4000000 WHERE id = ?').run(id);
  const put = await H.put(`/api/cash-out/${id}`, { amountRupees: '35000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included' }, { cookie });
  assert.strictEqual(put.status, 200, JSON.stringify(put.json));
  const row = H.db.prepare('SELECT amount_paise, contract_stated_paise FROM cash_out WHERE id = ?').get(id);
  assert.strictEqual(row.amount_paise, 3500000, 'the edit applied');
  assert.strictEqual(row.contract_stated_paise, 4000000, 'the historical value survives the edit, not silently wiped');
});

test('owed is CUMULATIVE: a range excluding the debit leaves owed 60,000 while B and the pie change', async () => {
  await seedWorkedExample();
  const full = await ov();
  const excl = await ov('?start=2026-09-01&end=2026-09-30'); // Sept excludes the July debit + payment
  assert.strictEqual(excl.money.owedToContractorsPaise, 6000000, 'owed stays ₹60,000 (cumulative)');
  assert.strictEqual(excl.money.totalSpentPaise, 0, 'D drops in the excluding range');
  assert.strictEqual(excl.money.paidToContractorsPaise, 0, 'B drops in the excluding range');
  assert.ok(excl.ledgers.length < full.ledgers.length, 'the pie changes (fewer ledgers) in the excluding range');
});

test('owed is CUMULATIVE: a range excluding the payment still leaves owed 60,000', async () => {
  await seedWorkedExample();
  // A window covering the debit (Jul 12) but the payment (Jul 10) sits just outside it.
  const excl = await ov('?start=2026-07-11&end=2026-07-31');
  assert.strictEqual(excl.money.owedToContractorsPaise, 6000000, 'owed still ₹60,000 regardless of range');
});

test("scope=included no longer needs (or accepts) a stated amount; contract_stated_paise stays NULL", async () => {
  await H.post('/api/contracts', { contractorName: 'X', areaOfWork: 'Y', ledgerCode: '5.0', statedAmountRupees: '100000.00', dateSigned: '2026-07-01' }, { cookie });
  const bare = await H.post('/api/cash-out', { amountRupees: '1000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included' }, { cookie });
  assert.strictEqual(bare.status, 201, 'included WITHOUT a stated amount is now the normal case');
  assert.strictEqual(bare.json.entry.contractStatedPaise, null, 'nothing is written to contract_stated_paise');
  // An older client / stale tab may still send contractStatedRupees: ignore it, never 400 on it.
  const legacyBody = await H.post('/api/cash-out', { amountRupees: '1000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractStatedRupees: '40000.00' }, { cookie });
  assert.strictEqual(legacyBody.status, 201, 'a stale body carrying contractStatedRupees still saves');
  assert.strictEqual(legacyBody.json.entry.contractStatedPaise, null, 'and the field is ignored, not stored');
  const extra = await H.post('/api/cash-out', { amountRupees: '1000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '1.0', contractScope: 'extra' }, { cookie });
  assert.strictEqual(extra.status, 201, 'extra scope accepts');
  assert.strictEqual(extra.json.entry.contractStatedPaise, null);
});

test('the missing-offset reconciliation check is GONE (it would fire on every ordinary entry)', async () => {
  await seedWorkedExample(); // one 'included' debit with a NULL stated amount — the normal case now
  const o = await ov();
  assert.strictEqual(o.reconciliation.includedDebitsMissingOffset, undefined, 'the check is removed from the payload');
  assert.strictEqual(o.reconciliation.ok, true, 'an ordinary included debit must NOT put the summary out of reconciliation');
});

test('reconciliation: over-offset detection fires WITHOUT adjusting any figure', async () => {
  const c = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', statedAmountRupees: '100000.00', dateSigned: '2026-07-01' }, { cookie });
  const cid = c.json.contract.id;
  // Retained check, now purely "payments exceed the contract value": ₹1,20,000 paid on ₹1,00,000.
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: cid, amountRupees: '40000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: cid, amountRupees: '80000.00', payDate: '2026-07-13' }, { cookie })).status, 201);
  const o = await ov();
  assert.strictEqual(o.reconciliation.overOffset.over, true, 'over-offset flagged');
  assert.strictEqual(o.reconciliation.overOffset.excessPaise, 2000000, 'excess = 120000 paid − 100000 contract = ₹20,000');
  assert.strictEqual(o.reconciliation.ok, false, 'recon.ok false on over-offset');
  // owed reported unclamped (negative = overpaid): 100000 − 120000 = −₹20,000.
  assert.strictEqual(o.money.owedToContractorsPaise, -2000000, 'owed reported unclamped, not adjusted');
});

test('reconciliation: the orphaned-contractor-payments check is unaffected', async () => {
  const c = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', statedAmountRupees: '100000.00', dateSigned: '2026-07-01' }, { cookie });
  const cid = c.json.contract.id;
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: cid, amountRupees: '40000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  H.db.prepare("UPDATE contract SET deleted_at = datetime('now') WHERE id = ?").run(cid); // orphan the payment
  const o = await ov();
  assert.strictEqual(o.reconciliation.orphanedContractorPayments.count, 1, 'the orphaned payment is still detected');
  assert.strictEqual(o.reconciliation.orphanedContractorPayments.amountPaise, 4000000);
  assert.strictEqual(o.reconciliation.ok, false, 'recon.ok false on an orphaned payment');
  assert.strictEqual(o.money.paidToContractorsPaise, 4000000, 'still counted in B — reported AS-IS, not adjusted');
});
