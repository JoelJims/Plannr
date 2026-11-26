// Q10 (review 2026-11-21), decided by the owner: "safe sums (integer paise or equivalent, no
// precision loss) plus a per-entry cap of ₹1 crore, with a clear message". One amount may be at most
// ₹1,00,00,000.00 = 1,000,000,000 paise (MAX_AMOUNT_PAISE in core/parsers.js). Every route that saves
// a typed amount refuses more with a 400 and AMOUNT_CAP_MESSAGE. Totals stay exact: amounts are
// integer paise, and with every amount at most the cap, a total of fewer than 9,007,199 amounts is
// still an exact integer in a JavaScript number. Runs on both test passes (desktop and phone code).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let P; // core/parsers.js (an ES module)
before(async () => { await H.startApp(); H.seedLoggedIn(); P = await import('../core/parsers.js'); });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.clearLedger(); });

const CAP = 1000000000;            // ₹1,00,00,000.00 in paise
const AT_CAP = '1,00,00,000.00';   // exactly the cap: allowed
const OVER = '10000000.01';        // one paisa over: refused
const HUGE = '99999999999999999999'; // well-formed, too large to hold exactly: refused as over the cap
const MSG = 'An amount can be at most ₹1,00,00,000 (₹1 crore).';

const cashOutBody = (amountRupees) => ({ amountRupees, txDate: '2026-07-12', byType: 'custom', byLabel: 'Site', ledgerCode: '1.0', contractScope: 'extra' });

function refused(r, what) {
  assert.strictEqual(r.status, 400, `${what}: status ${r.status} ${JSON.stringify(r.json)}`);
  assert.strictEqual(r.json.error, MSG, `${what}: the cap message`);
}

test('Q10: one named constant and one message, in step with each other', () => {
  assert.strictEqual(P.MAX_AMOUNT_PAISE, CAP);
  assert.strictEqual(P.AMOUNT_CAP_MESSAGE, MSG);
  assert.strictEqual(P.fmtRs(P.MAX_AMOUNT_PAISE), '₹1,00,00,000.00', 'the message names the constant\'s value');
  assert.deepStrictEqual(P.parseAmountToSave(AT_CAP, 'bad'), { paise: CAP });
  assert.deepStrictEqual(P.parseAmountToSave(OVER, 'bad'), { error: MSG });
  assert.deepStrictEqual(P.parseAmountToSave(HUGE, 'bad'), { error: MSG });
  for (const v of ['', '0', '0.00', '-5', 'abc', '1.234', null]) assert.deepStrictEqual(P.parseAmountToSave(v, 'bad'), { error: 'bad' }, `input ${JSON.stringify(v)}`);
});

test('Q10: cash in and cash out refuse an amount over the cap, and take one at the cap', async () => {
  refused(await H.post('/api/cash-in', { amountRupees: OVER, txDate: '2026-07-12', byType: 'relative' }), 'cash in');
  refused(await H.post('/api/cash-in', { amountRupees: HUGE, txDate: '2026-07-12', byType: 'relative' }), 'cash in, huge');
  const inOk = await H.post('/api/cash-in', { amountRupees: AT_CAP, txDate: '2026-07-12', byType: 'relative' });
  assert.strictEqual(inOk.status, 201); assert.strictEqual(inOk.json.entry.amountPaise, CAP);

  refused(await H.post('/api/cash-out', cashOutBody(OVER)), 'cash out');
  const outOk = await H.post('/api/cash-out', cashOutBody(AT_CAP));
  assert.strictEqual(outOk.status, 201); assert.strictEqual(outOk.json.entry.amountPaise, CAP);
  refused(await H.put(`/api/cash-out/${outOk.json.entry.id}`, cashOutBody(OVER)), 'cash out edit');

  // Save All (bulk edit): the over-cap row is held back with the message, the other row is saved.
  const id2 = H.seedCashOut({ amountPaise: 100 });
  const batch = await H.post('/api/cash-out/batch', { rows: [{ id: outOk.json.entry.id, ...cashOutBody(OVER) }, { id: id2, ...cashOutBody('500') }] });
  assert.strictEqual(batch.status, 200);
  assert.deepStrictEqual([batch.json.saved, batch.json.failed], [1, 1]);
  assert.strictEqual(batch.json.results[0].error, MSG);
  const kept = await H.get('/api/cash-out');
  assert.strictEqual(kept.json.entries.find((e) => e.id === outOk.json.entry.id).amountPaise, CAP, 'the refused row is unchanged');
});

test('Q10: loans, contractor payments and the budget refuse an amount over the cap', async () => {
  refused(await H.post('/api/loans', { amountRupees: OVER, bankName: 'Example Bank' }), 'loan');
  assert.strictEqual((await H.post('/api/loans', { amountRupees: AT_CAP, bankName: 'Example Bank' })).status, 201);

  const contractId = H.seedContract();
  const pay = (amountRupees) => H.post('/api/contractor-payments', { contractId, payDate: '2026-07-10', amountRupees });
  refused(await pay(OVER), 'contractor payment');
  assert.strictEqual((await pay(AT_CAP)).status, 201);

  refused(await H.put('/api/budget', { budgetRupees: OVER }), 'budget');
  const b = await H.put('/api/budget', { budgetRupees: AT_CAP });
  assert.strictEqual(b.status, 200); assert.strictEqual(b.json.budgetPaise, CAP);
});

test('Q10: the contract and its allowances refuse an amount over the cap, typed or rate x area', async () => {
  const base = { contractorName: 'ACME', areaOfWork: 'Whole house', ledgerCode: '1.0' };
  refused(await H.post('/api/contracts', { ...base, statedAmountRupees: OVER }), 'contract total');
  refused(await H.post('/api/contracts', { ...base, amountRupees: OVER }), 'contract reference amount');
  refused(await H.post('/api/contracts', { ...base, ratePerSqftRupees: OVER }), 'contract rate');
  // ₹2,000 per sq ft x 5,000.001 sq ft = ₹1,00,00,002: each figure is fine, the product is over the cap.
  const product = await H.post('/api/contracts', { ...base, ratePerSqftRupees: '2000', measuredAreaSqft: '5000.001' });
  assert.strictEqual(product.status, 400, JSON.stringify(product.json));
  assert.ok(product.json.error.startsWith(MSG), product.json.error);
  assert.match(product.json.error, /₹1,00,00,002\.00/, 'it says what the rate and area come to');

  const ok = await H.post('/api/contracts', { ...base, ratePerSqftRupees: '2000', measuredAreaSqft: '5000' });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.contract.statedAmountPaise, CAP, 'exactly the cap is allowed');
  const cid = ok.json.contract.id;
  refused(await H.post(`/api/contracts/${cid}/allowances`, { name: 'Tiles', capKind: 'lump', capRupees: OVER }), 'allowance cap');
  refused(await H.post(`/api/contracts/${cid}/allowances`, { name: 'Tiles', capKind: 'per_sqft', capRatePerSqftRupees: OVER }), 'allowance rate');
  assert.strictEqual((await H.post(`/api/contracts/${cid}/allowances`, { name: 'Tiles', capKind: 'lump', capRupees: AT_CAP })).status, 201);
});

test('Q10: totals of many amounts at the cap are exact', async () => {
  // Every total the Overview shows is a sum of integer paise. With the cap, a sum stays exact while it
  // is at most Number.MAX_SAFE_INTEGER: that is over nine million amounts at the cap.
  assert.ok(Math.floor(Number.MAX_SAFE_INTEGER / CAP) >= 9000000);
  const N = 3000; // per table: 6,000 amounts at the cap, ₹6,000 crore in all
  const cid = H.seedContract({ pricePaise: CAP });
  H.db.exec('BEGIN');
  try {
    for (let i = 0; i < N; i++) {
      H.seedCashOut({ amountPaise: CAP, ledgerCode: i % 2 ? '1.0' : '2.0', byType: i % 3 ? 'user' : 'custom', byLabel: 'Site' });
      H.seedPayment({ contractId: cid, amountPaise: CAP });
    }
    H.db.exec('COMMIT');
  } catch (e) { H.db.exec('ROLLBACK'); throw e; }
  const r = await H.get('/api/overview');
  assert.strictEqual(r.status, 200);
  const m = r.json.money;
  assert.strictEqual(m.spentBySelfPaise, N * CAP);
  assert.strictEqual(m.paidToContractorsPaise, N * CAP);
  assert.strictEqual(m.totalSpentPaise, 2 * N * CAP);
  assert.strictEqual(m.wholeProjectSpentPaise, 2 * N * CAP);
  assert.strictEqual(m.owedToContractorsPaise, CAP - N * CAP);
  assert.ok(Number.isSafeInteger(m.totalSpentPaise));
  assert.strictEqual(r.json.ledgers.reduce((a, L) => a + L.totalPaise, 0), 2 * N * CAP, 'the ledger rows add up to the total');
  // The same total on a date range (summed row by row) and on the whole project (summed in SQL).
  const ranged = await H.get('/api/overview?start=2026-07-01&end=2026-07-31');
  assert.strictEqual(ranged.json.money.totalSpentPaise, 2 * N * CAP);
  assert.strictEqual(ranged.json.money.wholeProjectSpentPaise, 2 * N * CAP);
});
