// Contract Phase A — allowance caps.
//
// The allowance schedule is the only place this contract attaches rupee figures to named items.
// Everything here is optional: a contract with no allowances behaves exactly as it did before the
// table existed. What this file pins down:
//   · a contract with no allowances is normal, and the ten standard caps are OPT-IN only
//   · a 'lump' cap has a rupee ceiling; a 'per_sqft' cap has a RATE ceiling and only acquires a
//     rupee position once an area is recorded — with no area it reports none rather than inventing one
//   · running spend is DERIVED from live cash_out rows tagged with the allowance, never typed
//   · the position is SIGNED (over/under) and DISPLAYED — no settlement is automated, and no
//     allowance figure touches owed, Total contract, or any Overview total
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const mkContract = async (extra = {}) => {
  const r = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', statedAmountRupees: '2500000.00', dateSigned: '2026-07-01', ...extra }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.contract;
};
const getContract = async () => (await H.get('/api/contracts', { cookie })).json.contracts[0];
const addAllowance = async (cid, body) => {
  const r = await H.post(`/api/contracts/${cid}/allowances`, body, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.allowance;
};
const spend = async (cid, allowanceId, rupees, date = '2026-07-12') => {
  const r = await H.post('/api/cash-out', {
    amountRupees: rupees, txDate: date, byType: 'user', byUserId: userId,
    ledgerCode: '5.0', contractScope: 'included', contractAllowanceId: allowanceId,
  }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.entry;
};
const byName = (c, name) => c.allowances.find((a) => a.name === name);

// ── optional by default ───────────────────────────────────────────────────────────────────────────
test('a contract with no allowances works normally and reports an empty list', async () => {
  await mkContract();
  const c = await getContract();
  assert.deepStrictEqual(c.allowances, []);
  const money = (await H.get('/api/overview', { cookie })).json.money;
  assert.strictEqual(money.totalContractPaise, 250000000, 'nothing about allowances changes figure A');
});

// ── the ten standard caps ─────────────────────────────────────────────────────────────────────────
test('the ten standard caps are OPT-IN, seed in contract order, and carry the contract figures', async () => {
  const c0 = await mkContract();
  assert.deepStrictEqual((await getContract()).allowances, [], 'nothing is seeded automatically');

  const r = await H.post(`/api/contracts/${c0.id}/allowances/defaults`, {}, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const c = await getContract();
  assert.strictEqual(c.allowances.length, 10);
  assert.deepStrictEqual(c.allowances.map((a) => a.name), [
    'Attached bathroom CP and sanitary', 'Common and outside bathrooms', 'Kitchen sink and wash area',
    'Main entry steel door', 'Other exterior steel doors', 'Interior doors', 'Stair handrail',
    'Flooring tiles', 'Bathroom tiles', 'Granite',
  ], 'seeded in contract order');

  // the seven rupee caps
  assert.strictEqual(byName(c, 'Attached bathroom CP and sanitary').capPaise, 3500000); // ₹35,000
  assert.strictEqual(byName(c, 'Common and outside bathrooms').capPaise, 1000000);      // ₹10,000
  assert.strictEqual(byName(c, 'Kitchen sink and wash area').capPaise, 1000000);        // ₹10,000
  assert.strictEqual(byName(c, 'Main entry steel door').capPaise, 5000000);             // ₹50,000
  assert.strictEqual(byName(c, 'Other exterior steel doors').capPaise, 2100000);        // ₹21,000
  assert.strictEqual(byName(c, 'Interior doors').capPaise, 1150000);                    // ₹11,500
  assert.strictEqual(byName(c, 'Stair handrail').capPaise, 2500000);                    // ₹25,000
  // the three per-square-foot ceilings
  assert.strictEqual(byName(c, 'Flooring tiles').capRatePerSqftPaise, 7500);            // ₹75/sqft
  assert.strictEqual(byName(c, 'Bathroom tiles').capRatePerSqftPaise, 5000);            // ₹50/sqft
  assert.strictEqual(byName(c, 'Granite').capRatePerSqftPaise, 15000);                  // ₹150/sqft
  assert.strictEqual(c.allowances.filter((a) => a.capKind === 'lump').length, 7);
  assert.strictEqual(c.allowances.filter((a) => a.capKind === 'per_sqft').length, 3);
});

test('seeding the standard set refuses on a contract that already has allowances', async () => {
  const c = await mkContract();
  await addAllowance(c.id, { name: 'Mine', capKind: 'lump', capRupees: '5000' });
  const r = await H.post(`/api/contracts/${c.id}/allowances/defaults`, {}, { cookie });
  assert.strictEqual(r.status, 409, 'no silent merge, no duplicate set');
  assert.match(r.json.error, /already has 1 allowance/);
  assert.strictEqual((await getContract()).allowances.length, 1, 'the existing row is untouched');
});

// ── the two cap kinds ─────────────────────────────────────────────────────────────────────────────
test('a lump cap reports a rupee ceiling and a position from the first rupee spent', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Interior doors', capKind: 'lump', capRupees: '11500' });
  assert.strictEqual(a.capPaise, 1150000);
  assert.strictEqual(a.effectiveCapPaise, 1150000);
  assert.strictEqual(a.spentPaise, 0);
  assert.strictEqual(a.positionPaise, 1150000, 'nothing spent yet -> the whole cap is under');
});

test('a per-sqft ceiling with NO area reports the rate and declines to state a position', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Flooring tiles', capKind: 'per_sqft', capRatePerSqftRupees: '75' });
  assert.strictEqual(a.capRatePerSqftPaise, 7500);
  assert.strictEqual(a.areaMilliSqft, null);
  assert.strictEqual(a.effectiveCapPaise, null, 'a rate ceiling is not a rupee cap until an area exists');
  assert.strictEqual(a.positionPaise, null, 'and no over/under is invented to fill the gap');
  // spend is still tracked — it is real spend, it just cannot be measured against a cap yet
  await spend(c.id, a.id, '30000.00');
  const after = byName(await getContract(), 'Flooring tiles');
  assert.strictEqual(after.spentPaise, 3000000, 'spend is recorded');
  assert.strictEqual(after.positionPaise, null, 'still no position, because there is still no cap');
});

test('recording the area turns a per-sqft ceiling into a rupee cap and a real position', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Granite', capKind: 'per_sqft', capRatePerSqftRupees: '150' });
  await spend(c.id, a.id, '20000.00');
  const r = await H.put(`/api/contracts/${c.id}/allowances/${a.id}`, { name: 'Granite', capKind: 'per_sqft', capRatePerSqftRupees: '150', areaSqft: '120.5' }, { cookie });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.allowance.areaMilliSqft, 120500);
  assert.strictEqual(r.json.allowance.effectiveCapPaise, 1807500, '₹150 × 120.5 sqft = ₹18,075');
  assert.strictEqual(r.json.allowance.spentPaise, 2000000, '₹20,000 spent');
  assert.strictEqual(r.json.allowance.positionPaise, -192500, 'over by ₹1,925');
});

test('each cap kind requires its own figure', async () => {
  const c = await mkContract();
  assert.strictEqual((await H.post(`/api/contracts/${c.id}/allowances`, { name: 'X', capKind: 'lump' }, { cookie })).status, 400, 'a lump cap needs an amount');
  assert.strictEqual((await H.post(`/api/contracts/${c.id}/allowances`, { name: 'X', capKind: 'per_sqft' }, { cookie })).status, 400, 'a per-sqft cap needs a rate');
  assert.strictEqual((await H.post(`/api/contracts/${c.id}/allowances`, { name: '', capKind: 'lump', capRupees: '100' }, { cookie })).status, 400, 'a name is required');
  assert.strictEqual((await H.post(`/api/contracts/${c.id}/allowances`, { name: 'X', capKind: 'nonsense', capRupees: '100' }, { cookie })).status, 400, 'unknown kind rejected');
});

// ── running spend ─────────────────────────────────────────────────────────────────────────────────
test('spend is the SUM of live tagged debits, and soft-deleting one releases its draw', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Main entry steel door', capKind: 'lump', capRupees: '50000' });
  const e1 = await spend(c.id, a.id, '30000.00', '2026-07-12');
  await spend(c.id, a.id, '25000.00', '2026-07-20');

  let row = byName(await getContract(), 'Main entry steel door');
  assert.strictEqual(row.spentPaise, 5500000, 'MANY debits draw against one cap — no uniqueness rule');
  assert.strictEqual(row.entryCount, 2);
  assert.strictEqual(row.positionPaise, -500000, 'over the ₹50,000 cap by ₹5,000');

  assert.strictEqual((await H.del('/api/cash-out/' + e1.id, { cookie })).status, 200);
  row = byName(await getContract(), 'Main entry steel door');
  assert.strictEqual(row.spentPaise, 2500000, 'a soft-deleted debit stops counting');
  assert.strictEqual(row.entryCount, 1);
  assert.strictEqual(row.positionPaise, 2500000, 'back under by ₹25,000');
});

test('an untagged debit draws against nothing', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Stair handrail', capKind: 'lump', capRupees: '25000' });
  const r = await H.post('/api/cash-out', { amountRupees: '9000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included' }, { cookie });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.entry.contractAllowanceId, null);
  assert.strictEqual(byName(await getContract(), 'Stair handrail').spentPaise, 0);
});

test('scope=extra clears the allowance link, and an unknown allowance is rejected', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Interior doors', capKind: 'lump', capRupees: '11500' });
  const extra = await H.post('/api/cash-out', { amountRupees: '100.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '1.0', contractScope: 'extra', contractAllowanceId: a.id }, { cookie });
  assert.strictEqual(extra.status, 201);
  assert.strictEqual(extra.json.entry.contractAllowanceId, null, 'an out-of-contract debit draws against no allowance');
  const bad = await H.post('/api/cash-out', { amountRupees: '100.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractAllowanceId: a.id + 9999 }, { cookie });
  assert.strictEqual(bad.status, 400);
});

test('editing a tagged debit WITHOUT sending contractAllowanceId preserves the draw', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Granite', capKind: 'lump', capRupees: '100000' });
  const e = await spend(c.id, a.id, '30000.00');
  const put = await H.put('/api/cash-out/' + e.id, { amountRupees: '35000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included' }, { cookie });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.json.entry.contractAllowanceId, a.id, 'the editable table omits the key; the link survives');
  assert.strictEqual(byName(await getContract(), 'Granite').spentPaise, 3500000, 'and the running total follows the edit');
});

// ── displayed, never settled ──────────────────────────────────────────────────────────────────────
test('an overrun changes NO Overview figure — the position is reported, not settled', async () => {
  const c = await mkContract(); // stated ₹25,00,000
  const a = await addAllowance(c.id, { name: 'Interior doors', capKind: 'lump', capRupees: '11500' });
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: c.id, amountRupees: '500000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  await spend(c.id, a.id, '20000.00'); // ₹8,500 over the ₹11,500 cap

  const row = byName(await getContract(), 'Interior doors');
  assert.strictEqual(row.positionPaise, -850000, 'over by ₹8,500 — displayed');

  const o = (await H.get('/api/overview', { cookie })).json;
  assert.strictEqual(o.money.totalContractPaise, 250000000, 'A unchanged by the overrun');
  assert.strictEqual(o.money.owedToContractorsPaise, 200000000, 'owed is still stated − paid; the overrun is NOT added to it');
  assert.strictEqual(o.money.spentBySelfPaise, 2000000, 'the ₹20,000 is ordinary spend, counted once');
  assert.strictEqual(o.reconciliation.ok, true, 'and an overrun is not a reconciliation failure');
});

// ── deletion ──────────────────────────────────────────────────────────────────────────────────────
test('a soft-deleted allowance leaves its drawn spend intact and stops being reported', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Bathroom tiles', capKind: 'lump', capRupees: '10000' });
  await spend(c.id, a.id, '4000.00');
  assert.strictEqual((await H.del(`/api/contracts/${c.id}/allowances/${a.id}`, { cookie })).status, 200);
  assert.deepStrictEqual((await getContract()).allowances, [], 'gone from the live list');
  const o = (await H.get('/api/overview', { cookie })).json;
  assert.strictEqual(o.money.spentBySelfPaise, 400000, 'the ₹4,000 is still real spend and still counted');
});

test('hard-deleting a contract is blocked while a cash-out entry still draws against its allowance', async () => {
  const c = await mkContract();
  const a = await addAllowance(c.id, { name: 'Kitchen sink and wash area', capKind: 'lump', capRupees: '10000' });
  await spend(c.id, a.id, '4000.00');
  assert.strictEqual((await H.del('/api/contracts/' + c.id, { cookie })).status, 200, 'soft-delete first (Recycle Bin)');
  const hard = await H.del(`/api/trash/contract/${c.id}`, { cookie });
  assert.strictEqual(hard.status, 409, 'a raw FK crash is caught as a clean 409 instead');
  assert.match(hard.json.error, /drawing against one of its allowances/);
});

// ── backup ────────────────────────────────────────────────────────────────────────────────────────
test('allowances and their draws survive an export/import round trip', async () => {
  const c = await mkContract();
  const lump = await addAllowance(c.id, { name: 'Main entry steel door', capKind: 'lump', capRupees: '50000' });
  const rate = await addAllowance(c.id, { name: 'Flooring tiles', capKind: 'per_sqft', capRatePerSqftRupees: '75', areaSqft: '1200' });
  await spend(c.id, lump.id, '52000.00');

  const backup = (await H.get('/api/backup/export', { cookie })).json;
  assert.strictEqual(backup.tables.contract_allowances.length, 2, 'the table is exported');
  assert.strictEqual((await H.post('/api/backup/import', backup, { cookie })).status, 200);

  const back = await getContract();
  assert.strictEqual(back.allowances.length, 2);
  assert.strictEqual(byName(back, 'Main entry steel door').spentPaise, 5200000, 'the draw survived');
  assert.strictEqual(byName(back, 'Main entry steel door').positionPaise, -200000, 'over by ₹2,000');
  assert.strictEqual(byName(back, 'Flooring tiles').effectiveCapPaise, 9000000, '₹75 × 1,200 sqft = ₹90,000');
  assert.strictEqual(rate.effectiveCapPaise, 9000000);
});

test('a backup whose cash_out draws against an allowance not in the file is rejected', async () => {
  const backup = {
    app: 'plannr', kind: 'plannr-backup', schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z',
    tables: {
      contract: [{ id: 1, contractor_name: 'A', area_of_work: 'x', ledger_code: '5.0', date_signed: '2026-01-01', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }],
      contract_allowances: [], contract_payment_dates: [], contractor_payments: [],
      loans: [], settings: [], cash_in: [],
      cash_out: [{ id: 1, amount_paise: 100, tx_date: '2026-01-02', by_type: 'user', ledger_code: '5.0', contract_scope: 'included', contract_allowance_id: 77, created_at: '2026-01-02 00:00:00', updated_at: '2026-01-02 00:00:00' }],
    },
  };
  const r = await H.post('/api/backup/import', backup, { cookie });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /contract_allowance_id 77 is not present/);
});
