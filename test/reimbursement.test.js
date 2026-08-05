// Reimbursement (Option C) + the cumulative-vs-range distinction + both reconciliation detections.
// The highest-value test in the suite: the worked example that Phase 5E was built around.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const ov = async (q = '') => (await H.get('/api/overview' + q, { cookie })).json;
async function seedWorkedExample() {
  const c = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', statedAmountRupees: '100000.00', dateSigned: '2026-07-01' }, { cookie });
  assert.strictEqual(c.status, 201, JSON.stringify(c.json));
  const cid = c.json.contract.id;
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: cid, amountRupees: '40000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  const deb = await H.post('/api/cash-out', { amountRupees: '32000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', subledgerCode: '', contractScope: 'included', contractStatedRupees: '40000.00' }, { cookie });
  assert.strictEqual(deb.status, 201, JSON.stringify(deb.json));
  assert.strictEqual(deb.json.entry.contractStatedPaise, 4000000);
  return cid;
}

test('worked example: contract 1,00,000 − 40,000 paid − 40,000 offset = owed 20,000', async () => {
  await seedWorkedExample();
  const m = (await ov()).money;
  assert.strictEqual(m.totalContractPaise, 10000000, 'A = contract stated');
  assert.strictEqual(m.paidToContractorsPaise, 4000000, 'B = paid');
  assert.strictEqual(m.spentBySelfPaise, 3200000, 'C = real ₹32,000 spent');
  assert.strictEqual(m.totalSpentPaise, 7200000, 'D includes the real ₹32,000');
  assert.strictEqual(m.owedToContractorsPaise, 2000000, 'F owed = ₹20,000');
});

test('owed is CUMULATIVE: a range excluding the debit leaves owed 20,000 while B and the pie change', async () => {
  await seedWorkedExample();
  const full = await ov();
  const excl = await ov('?start=2026-09-01&end=2026-09-30'); // Sept excludes the July debit + payment
  assert.strictEqual(excl.money.owedToContractorsPaise, 2000000, 'owed stays ₹20,000 (cumulative)');
  assert.strictEqual(excl.money.totalSpentPaise, 0, 'D drops in the excluding range');
  assert.strictEqual(excl.money.paidToContractorsPaise, 0, 'B drops in the excluding range');
  assert.ok(excl.ledgers.length < full.ledgers.length, 'the pie changes (fewer ledgers) in the excluding range');
});

test('owed is CUMULATIVE: a range excluding the payment still leaves owed 20,000', async () => {
  await seedWorkedExample();
  // A window covering the debit (Jul 12) but the payment (Jul 10) sits just outside it.
  const excl = await ov('?start=2026-07-11&end=2026-07-31');
  assert.strictEqual(excl.money.owedToContractorsPaise, 2000000, 'owed still ₹20,000 regardless of range');
});

test('contract_stated_paise: required + positive when scope=included, forced NULL when extra', async () => {
  await H.post('/api/contracts', { contractorName: 'X', areaOfWork: 'Y', ledgerCode: '5.0', statedAmountRupees: '100000.00', dateSigned: '2026-07-01' }, { cookie });
  const missing = await H.post('/api/cash-out', { amountRupees: '1000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included' }, { cookie });
  assert.strictEqual(missing.status, 400, 'included WITHOUT a stated amount must be 400');
  const zero = await H.post('/api/cash-out', { amountRupees: '1000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractStatedRupees: '0.00' }, { cookie });
  assert.strictEqual(zero.status, 400, 'included with a non-positive stated amount must be 400');
  const extra = await H.post('/api/cash-out', { amountRupees: '1000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '1.0', contractScope: 'extra', contractStatedRupees: '5000.00' }, { cookie });
  assert.strictEqual(extra.status, 201, 'extra scope accepts');
  assert.strictEqual(extra.json.entry.contractStatedPaise, null, 'extra scope forces contract_stated_paise to NULL');
});

test('reconciliation: missing-offset detection fires WITHOUT adjusting any figure', async () => {
  await seedWorkedExample();
  // An 'included' debit with NULL contract_stated_paise is only reachable via import/SQL — patch one.
  H.db.prepare("UPDATE cash_out SET contract_stated_paise = NULL WHERE contract_scope='included'").run();
  const o = await ov();
  assert.strictEqual(o.reconciliation.includedDebitsMissingOffset.count, 1, 'missing-offset count = 1');
  assert.strictEqual(o.reconciliation.ok, false, 'recon.ok false on missing offset');
  // owed is reported AS-IS (offset that does nothing): stated − paid − 0 = 100000 − 40000 = ₹60,000.
  assert.strictEqual(o.money.owedToContractorsPaise, 6000000, 'owed reported unadjusted, not silently corrected');
});

test('reconciliation: over-offset detection fires WITHOUT adjusting any figure', async () => {
  await seedWorkedExample();
  // Add another included debit whose offset pushes paid+offsets over the contract value.
  await H.post('/api/cash-out', { amountRupees: '5000.00', txDate: '2026-07-13', byType: 'user', byUserId: userId, ledgerCode: '5.0', subledgerCode: '', contractScope: 'included', contractStatedRupees: '80000.00' }, { cookie });
  const o = await ov();
  assert.strictEqual(o.reconciliation.overOffset.over, true, 'over-offset flagged');
  assert.strictEqual(o.reconciliation.overOffset.excessPaise, 6000000, 'excess = (40000+80000 offsets + 40000 paid) − 100000 = ₹60,000');
  assert.strictEqual(o.reconciliation.ok, false, 'recon.ok false on over-offset');
  // owed reported unclamped (negative = overpaid): 100000 − 40000 paid − 120000 offset = −₹60,000.
  assert.strictEqual(o.money.owedToContractorsPaise, -6000000, 'owed reported unclamped, not adjusted');
});
