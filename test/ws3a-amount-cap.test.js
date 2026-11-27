// Q10 (review 2026-11-21), decided by the owner: "safe sums (integer paise or equivalent, no
// precision loss) plus a per-entry cap of ₹1 crore, with a clear message"; on its scope (2026-11-27):
// "Single entries only". So core/parsers.js has two limits, both in integer paise:
//   · An ENTRY (cash in, cash out, a contractor payment) may be at most ₹1,00,00,000.00 (₹1 crore) =
//     1,000,000,000 paise (MAX_AMOUNT_PAISE). More is refused with a 400 and AMOUNT_CAP_MESSAGE.
//   · A TOTAL (the budget, a loan, the contract's reference amount, total, rate and rate x area, an
//     allowance's cap and rate) may be at most ₹10,00,00,00,000.00 (₹1,000 crore) =
//     1,000,000,000,000 paise (MAX_TOTAL_PAISE). More is refused with a 400 and TOTAL_LIMIT_MESSAGE.
// Sums stay exact: a sum of integer paise is an exact integer in a JavaScript number while it is at
// most Number.MAX_SAFE_INTEGER. That is over 9,000 totals at the totals limit, and over nine million
// entries at the entry cap. Runs on both test passes (desktop and phone code).
const H = require('./helpers');
const F = require('./fixtures/full-dataset');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let P; // core/parsers.js (an ES module)
before(async () => { await H.startApp(); H.seedLoggedIn(); P = await import('../core/parsers.js'); });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.clearLedger(); });

// The entry cap.
const CAP = 1000000000;            // ₹1,00,00,000.00 in paise
const AT_CAP = '1,00,00,000.00';   // exactly the cap: allowed
const OVER = '10000000.01';        // one paisa over: refused
const HUGE = '99999999999999999999'; // well-formed, too large to hold exactly: refused as over the limit
const MSG = 'An amount can be at most ₹1,00,00,000 (₹1 crore).';

// The totals limit.
const TOTAL = 1000000000000;             // ₹10,00,00,00,000.00 (₹1,000 crore) in paise
const AT_TOTAL = '10,00,00,00,000.00';   // exactly the limit: allowed
const OVER_TOTAL = '10000000000.01';     // one paisa over: refused
const BIG = '3,50,00,000';               // ₹3.5 crore: over the entry cap, an ordinary total
const BIG_PAISE = 3500000000;
const TOTAL_MSG = 'A total can be at most ₹10,00,00,00,000 (₹1,000 crore).';
const TOTALS_OK = [[BIG, BIG_PAISE], [AT_TOTAL, TOTAL]]; // [typed, saved paise]

const rupees = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
const cashOutBody = (amountRupees) => ({ amountRupees, txDate: '2026-07-12', byType: 'custom', byLabel: 'Site', ledgerCode: '1.0', contractScope: 'extra' });

function refused(r, what, msg = MSG) {
  assert.strictEqual(r.status, 400, `${what}: status ${r.status} ${JSON.stringify(r.json)}`);
  assert.strictEqual(r.json.error, msg, `${what}: the limit's message`);
}

test('Q10: the entry cap and the totals limit, each one named constant and one message', () => {
  assert.strictEqual(P.MAX_AMOUNT_PAISE, CAP);
  assert.strictEqual(P.AMOUNT_CAP_MESSAGE, MSG);
  assert.strictEqual(P.fmtRs(P.MAX_AMOUNT_PAISE), '₹1,00,00,000.00', 'the message names the constant\'s value');
  assert.deepStrictEqual(P.parseAmountToSave(AT_CAP, 'bad'), { paise: CAP });
  assert.deepStrictEqual(P.parseAmountToSave(OVER, 'bad'), { error: MSG });
  assert.deepStrictEqual(P.parseAmountToSave(BIG, 'bad'), { error: MSG }, 'an entry of ₹3.5 crore is still over the cap');
  assert.deepStrictEqual(P.parseAmountToSave(HUGE, 'bad'), { error: MSG });

  assert.strictEqual(P.MAX_TOTAL_PAISE, TOTAL);
  assert.strictEqual(P.TOTAL_LIMIT_MESSAGE, TOTAL_MSG);
  assert.strictEqual(P.fmtRs(P.MAX_TOTAL_PAISE), '₹10,00,00,00,000.00', 'the message names the constant\'s value');
  assert.deepStrictEqual(P.parseTotalToSave(BIG, 'bad'), { paise: BIG_PAISE });
  assert.deepStrictEqual(P.parseTotalToSave(AT_TOTAL, 'bad'), { paise: TOTAL });
  assert.deepStrictEqual(P.parseTotalToSave(OVER_TOTAL, 'bad'), { error: TOTAL_MSG });
  assert.deepStrictEqual(P.parseTotalToSave(HUGE, 'bad'), { error: TOTAL_MSG });

  for (const v of ['', '0', '0.00', '-5', 'abc', '1.234', null]) {
    assert.deepStrictEqual(P.parseAmountToSave(v, 'bad'), { error: 'bad' }, `entry input ${JSON.stringify(v)}`);
    assert.deepStrictEqual(P.parseTotalToSave(v, 'bad'), { error: 'bad' }, `total input ${JSON.stringify(v)}`);
  }
  // Why the totals limit is where it is: over 9,000 totals at the limit still add up exactly, and an
  // entry at the cap uses a thousandth of that room.
  assert.ok(Math.floor(Number.MAX_SAFE_INTEGER / TOTAL) >= 9000);
  assert.strictEqual(TOTAL / CAP, 1000);
});

test('Q10: cash in and cash out are entries: over the cap is refused, the cap is taken', async () => {
  refused(await H.post('/api/cash-in', { amountRupees: OVER, txDate: '2026-07-12', byType: 'relative' }), 'cash in');
  refused(await H.post('/api/cash-in', { amountRupees: BIG, txDate: '2026-07-12', byType: 'relative' }), 'cash in, ₹3.5 crore');
  refused(await H.post('/api/cash-in', { amountRupees: HUGE, txDate: '2026-07-12', byType: 'relative' }), 'cash in, huge');
  const inOk = await H.post('/api/cash-in', { amountRupees: AT_CAP, txDate: '2026-07-12', byType: 'relative' });
  assert.strictEqual(inOk.status, 201); assert.strictEqual(inOk.json.entry.amountPaise, CAP);
  refused(await H.put(`/api/cash-in/${inOk.json.entry.id}`, { amountRupees: OVER, txDate: '2026-07-12', byType: 'relative' }), 'cash in edit');

  refused(await H.post('/api/cash-out', cashOutBody(OVER)), 'cash out');
  refused(await H.post('/api/cash-out', cashOutBody(BIG)), 'cash out, ₹3.5 crore');
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

test('Q10: a contractor payment is an entry: over the cap is refused, the cap is taken', async () => {
  const contractId = H.seedContract();
  const pay = (amountRupees) => H.post('/api/contractor-payments', { contractId, payDate: '2026-07-10', amountRupees });
  refused(await pay(OVER), 'contractor payment');
  refused(await pay(BIG), 'contractor payment, ₹3.5 crore');
  refused(await pay(HUGE), 'contractor payment, huge');
  const ok = await pay(AT_CAP);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.payment.amountPaise, CAP);
});

test('Q10: the budget is a total: ₹3.5 crore and ₹1,000 crore save, one paisa more is refused', async () => {
  for (const [v, paise] of TOTALS_OK) {
    const b = await H.put('/api/budget', { budgetRupees: v });
    assert.strictEqual(b.status, 200, `budget ${v}: ${JSON.stringify(b.json)}`);
    assert.strictEqual(b.json.budgetPaise, paise);
  }
  refused(await H.put('/api/budget', { budgetRupees: OVER_TOTAL }), 'budget', TOTAL_MSG);
  refused(await H.put('/api/budget', { budgetRupees: HUGE }), 'budget, huge', TOTAL_MSG);
  assert.strictEqual((await H.get('/api/budget')).json.budgetPaise, TOTAL, 'the refused budget left the saved one');
});

test('Q10: a loan is a total, on add and on edit', async () => {
  const loan = (amountRupees) => ({ amountRupees, bankName: 'Example Bank' });
  let id = null;
  for (const [v, paise] of TOTALS_OK) {
    const r = await H.post('/api/loans', loan(v));
    assert.strictEqual(r.status, 201, `loan add ${v}: ${JSON.stringify(r.json)}`);
    assert.strictEqual(r.json.loan.amountPaise, paise);
    id = id || r.json.loan.id;
  }
  refused(await H.post('/api/loans', loan(OVER_TOTAL)), 'loan add', TOTAL_MSG);
  refused(await H.post('/api/loans', loan(HUGE)), 'loan add, huge', TOTAL_MSG);

  for (const [v, paise] of [...TOTALS_OK].reverse()) {
    const r = await H.put(`/api/loans/${id}`, loan(v));
    assert.strictEqual(r.status, 200, `loan edit ${v}: ${JSON.stringify(r.json)}`);
    assert.strictEqual(r.json.loan.amountPaise, paise);
  }
  refused(await H.put(`/api/loans/${id}`, loan(OVER_TOTAL)), 'loan edit', TOTAL_MSG);
  const list = await H.get('/api/loans');
  assert.strictEqual(list.json.loans.find((l) => l.id === id).amountPaise, BIG_PAISE, 'the refused edit left the loan unchanged');
});

test('Q10: the contract\'s reference amount, total and rate are totals, on add and on edit', async () => {
  const base = { contractorName: 'ACME', areaOfWork: 'Whole house', ledgerCode: '1.0' };
  const FIELDS = [['amountRupees', 'amountPaise'], ['statedAmountRupees', 'statedAmountPaise'], ['ratePerSqftRupees', 'ratePerSqftPaise']];
  for (const [field] of FIELDS) {
    refused(await H.post('/api/contracts', { ...base, [field]: OVER_TOTAL }), `${field} on a new contract`, TOTAL_MSG);
    refused(await H.post('/api/contracts', { ...base, [field]: HUGE }), `${field} on a new contract, huge`, TOTAL_MSG);
  }
  const created = await H.post('/api/contracts', { ...base, amountRupees: BIG, statedAmountRupees: BIG, ratePerSqftRupees: BIG });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  for (const [, key] of FIELDS) assert.strictEqual(created.json.contract[key], BIG_PAISE, key);

  const cid = created.json.contract.id;
  const edit = (body) => H.put(`/api/contracts/${cid}`, { ...base, ...body });
  for (const [field, key] of FIELDS) {
    for (const [v, paise] of TOTALS_OK) {
      const r = await edit({ [field]: v });
      assert.strictEqual(r.status, 200, `${field} ${v}: ${JSON.stringify(r.json)}`);
      assert.strictEqual(r.json.contract[key], paise, `${field} ${v}`);
    }
    refused(await edit({ [field]: OVER_TOTAL }), `${field} edit`, TOTAL_MSG);
  }
});

test('Q10: the price rate x area gives is a total: over ₹1,000 crore is refused with the figure', async () => {
  const base = { contractorName: 'ACME', areaOfWork: 'Whole house', ledgerCode: '1.0' };
  // ₹2,000 per sq ft x 17,500 sq ft = ₹3.5 crore; ₹2,00,000 per sq ft x 50,000 sq ft = ₹1,000 crore.
  const created = await H.post('/api/contracts', { ...base, ratePerSqftRupees: '2000', measuredAreaSqft: '17500' });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  assert.strictEqual(created.json.contract.statedAmountPaise, BIG_PAISE);
  const cid = created.json.contract.id;
  const atLimit = await H.put(`/api/contracts/${cid}`, { ...base, ratePerSqftRupees: '200000', measuredAreaSqft: '50000' });
  assert.strictEqual(atLimit.status, 200, JSON.stringify(atLimit.json));
  assert.strictEqual(atLimit.json.contract.statedAmountPaise, TOTAL, 'exactly the limit is allowed');

  // ₹2,00,000 per sq ft x 50,000.001 sq ft = ₹10,00,00,00,200: each figure is fine, the product is over.
  for (const product of [
    await H.put(`/api/contracts/${cid}`, { ...base, ratePerSqftRupees: '200000', measuredAreaSqft: '50000.001' }),
    await H.post('/api/contracts', { ...base, ratePerSqftRupees: '200000', measuredAreaSqft: '50000.001' }),
  ]) {
    assert.strictEqual(product.status, 400, JSON.stringify(product.json));
    assert.ok(product.json.error.startsWith(TOTAL_MSG), product.json.error);
    assert.match(product.json.error, /₹10,00,00,00,200\.00/, 'it says what the rate and area come to');
  }
  const kept = await H.get('/api/contracts');
  assert.strictEqual(kept.json.contracts[0].statedAmountPaise, TOTAL, 'the refused edit left the contract unchanged');
});

test('Q10: an allowance\'s cap and per-sqft rate are totals, on add and on edit', async () => {
  const cid = H.seedContract();
  const url = `/api/contracts/${cid}/allowances`;
  for (const [field, capKind, key] of [['capRupees', 'lump', 'capPaise'], ['capRatePerSqftRupees', 'per_sqft', 'capRatePerSqftPaise']]) {
    const body = (v) => ({ name: 'Tiles', capKind, [field]: v });
    let aid = null;
    for (const [v, paise] of TOTALS_OK) {
      const r = await H.post(url, body(v));
      assert.strictEqual(r.status, 201, `${field} ${v}: ${JSON.stringify(r.json)}`);
      assert.strictEqual(r.json.allowance[key], paise, `${field} ${v}`);
      aid = aid || r.json.allowance.id;
    }
    refused(await H.post(url, body(OVER_TOTAL)), `${field} add`, TOTAL_MSG);
    refused(await H.post(url, body(HUGE)), `${field} add, huge`, TOTAL_MSG);
    const edited = await H.put(`${url}/${aid}`, body(AT_TOTAL));
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.json));
    assert.strictEqual(edited.json.allowance[key], TOTAL);
    refused(await H.put(`${url}/${aid}`, body(OVER_TOTAL)), `${field} edit`, TOTAL_MSG);
  }
});

test('Q10: the test data\'s ₹3.5 crore loan, ₹1.25 crore contract and ₹4.2 crore budget save again', async () => {
  const loan = F.DATA.rows.loans[0];
  const contract = F.DATA.rows.contract[0];
  const budgetPaise = Number(F.DATA.settings.find((s) => s.key === 'budget_paise').value);
  assert.deepStrictEqual([loan.amount_paise, contract.price_of_contract_paise, budgetPaise], [3500000000, 1250000000, 4200000000]);

  const l = await H.post('/api/loans', { amountRupees: rupees(loan.amount_paise), bankName: loan.bank_name, interestRate: String(loan.interest_rate), tenure: loan.tenure });
  assert.strictEqual(l.status, 201, JSON.stringify(l.json));
  assert.strictEqual(l.json.loan.amountPaise, loan.amount_paise);

  const c = await H.post('/api/contracts', {
    contractorName: contract.contractor_name, areaOfWork: contract.area_of_work, ledgerCode: contract.ledger_code, subledgerCode: contract.subledger_code,
    amountRupees: rupees(contract.amount_paise), statedAmountRupees: rupees(contract.price_of_contract_paise), dateSigned: contract.date_signed,
  });
  assert.strictEqual(c.status, 201, JSON.stringify(c.json));
  assert.strictEqual(c.json.contract.amountPaise, contract.amount_paise);
  assert.strictEqual(c.json.contract.statedAmountPaise, contract.price_of_contract_paise);

  const b = await H.put('/api/budget', { budgetRupees: rupees(budgetPaise) });
  assert.strictEqual(b.status, 200, JSON.stringify(b.json));
  assert.strictEqual(b.json.budgetPaise, budgetPaise);
});

test('Q10: a sum of totals at the totals limit is exact', async () => {
  // 300 loans at ₹1,000 crore: ₹3,00,000 crore in all, still an exact integer number of paise.
  const N = 300;
  assert.ok(N * TOTAL <= Number.MAX_SAFE_INTEGER);
  const first = await H.post('/api/loans', { amountRupees: AT_TOTAL, bankName: 'Example Bank' });
  assert.strictEqual(first.status, 201, JSON.stringify(first.json));
  const insert = H.db.prepare('INSERT INTO loans (amount_paise, bank_name) VALUES (?, ?)');
  H.db.exec('BEGIN');
  try {
    for (let i = 1; i < N; i++) insert.run(TOTAL, 'Example Bank');
    H.db.exec('COMMIT');
  } catch (e) { H.db.exec('ROLLBACK'); throw e; }
  const r = await H.get('/api/overview');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.money.loanReceivedPaise, 300000000000000, 'the loans total is 300 x 10^12 paise exactly');
  assert.strictEqual(r.json.money.loanReceivedPaise, N * TOTAL);
  assert.ok(Number.isSafeInteger(r.json.money.loanReceivedPaise));
  const list = await H.get('/api/loans');
  assert.strictEqual(list.json.loans.length, N);
  assert.strictEqual(list.json.loans.reduce((a, l) => a + l.amountPaise, 0), N * TOTAL, 'the loan rows add up to the total');
});

test('Q10: totals of many entries at the cap are exact', async () => {
  // Every total the Overview shows is a sum of integer paise. With the cap, a sum stays exact while it
  // is at most Number.MAX_SAFE_INTEGER: that is over nine million entries at the cap.
  assert.ok(Math.floor(Number.MAX_SAFE_INTEGER / CAP) >= 9000000);
  const N = 3000; // per table: 6,000 entries at the cap, ₹6,000 crore in all
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
