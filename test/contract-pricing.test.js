// Contract Phase A — the contract as a FIXED UNIT-RATE LUMP SUM.
//
// The price is a rate per square foot times the FINAL MEASURED built-up area, so both halves are
// optional and independently editable: the rate is fixed at signing, the area is not known until
// final measurement, and a contract routinely sits with a rate and no area for months. What this
// file pins down:
//   · a typed stated price still works, unchanged (rate pricing is an alternative, not a replacement)
//   · rate + area DERIVES the stated price, and re-derives it when EITHER half changes
//   · one half alone derives nothing and quietly leaves the typed value alone
//   · the derived price flows into owed / figure A through the same column as a typed one
//   · the optional metadata round-trips, and expectedCompletionDate is derived, not stored
//   · reconciliation.contractPriceDerivation flags a stored price that no longer matches rate × area
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const BASE = { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0' };
const mk = async (extra = {}) => {
  const r = await H.post('/api/contracts', { ...BASE, ...extra }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.contract;
};
const put = async (id, extra = {}) => {
  const r = await H.put('/api/contracts/' + id, { ...BASE, ...extra }, { cookie });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.contract;
};
const getContract = async () => (await H.get('/api/contracts', { cookie })).json.contracts[0];

// ── typed pricing is untouched ────────────────────────────────────────────────────────────────────
test('a typed stated price still works exactly as before, and reports pricingMode "typed"', async () => {
  const c = await mk({ statedAmountRupees: '2500000.00', dateSigned: '2026-07-01' });
  assert.strictEqual(c.statedAmountPaise, 250000000);
  assert.strictEqual(c.pricingMode, 'typed');
  assert.strictEqual(c.ratePerSqftPaise, null);
  assert.strictEqual(c.measuredAreaMilliSqft, null);
  assert.strictEqual(c.computedPricePaise, null, 'nothing is computed without both halves');
});

test('a contract with no price at all is still valid, and reports pricingMode "none"', async () => {
  const c = await mk({});
  assert.strictEqual(c.statedAmountPaise, null);
  assert.strictEqual(c.pricingMode, 'none');
  const money = (await H.get('/api/overview', { cookie })).json.money;
  assert.strictEqual(money.totalContractPaise, 0, 'an unpriced contract contributes 0 to A');
  assert.strictEqual(money.owedToContractorsPaise, 0, 'and 0 to owed');
});

// ── rate × area ───────────────────────────────────────────────────────────────────────────────────
test('rate + area DERIVES the stated price; the product is exact integer paise', async () => {
  // ₹1,850.00/sqft × 1,240.5 sqft = ₹22,94,925.00 exactly.
  const c = await mk({ ratePerSqftRupees: '1850.00', measuredAreaSqft: '1240.5' });
  assert.strictEqual(c.ratePerSqftPaise, 185000);
  assert.strictEqual(c.measuredAreaMilliSqft, 1240500, 'area is stored as thousandths of a sq ft');
  assert.strictEqual(c.computedPricePaise, 229492500);
  assert.strictEqual(c.statedAmountPaise, 229492500, 'the derived price is written to the stated column');
  assert.strictEqual(c.pricingMode, 'rate');
  assert.strictEqual(Number.isInteger(H.db.prepare('SELECT price_of_contract_paise p FROM contract WHERE id=?').get(c.id).p), true);
});

test('a typed price sent alongside a complete rate price is IGNORED, not rejected', async () => {
  const c = await mk({ ratePerSqftRupees: '2000', measuredAreaSqft: '1000', statedAmountRupees: '999999.00' });
  assert.strictEqual(c.statedAmountPaise, 200000000, 'rate × area wins: ₹2,000 × 1,000 sqft = ₹20,00,000');
  assert.strictEqual(c.pricingMode, 'rate');
});

test('either half alone derives nothing and leaves a typed price standing', async () => {
  const rateOnly = await mk({ ratePerSqftRupees: '1850.00', statedAmountRupees: '2500000.00' });
  assert.strictEqual(rateOnly.computedPricePaise, null, 'a rate with no area is not a price');
  assert.strictEqual(rateOnly.statedAmountPaise, 250000000, 'the typed value survives');
  assert.strictEqual(rateOnly.pricingMode, 'typed');

  const areaOnly = await put(rateOnly.id, { measuredAreaSqft: '1240.5', statedAmountRupees: '2500000.00' });
  assert.strictEqual(areaOnly.computedPricePaise, null, 'an area with no rate is not a price either');
  assert.strictEqual(areaOnly.statedAmountPaise, 250000000);
});

test('the total RECOMPUTES when either half changes, in both directions', async () => {
  const c = await mk({ ratePerSqftRupees: '2000', measuredAreaSqft: '1000' });
  assert.strictEqual(c.statedAmountPaise, 200000000); // ₹20,00,000

  // final measurement comes in larger
  const remeasured = await put(c.id, { ratePerSqftRupees: '2000', measuredAreaSqft: '1250.25' });
  assert.strictEqual(remeasured.statedAmountPaise, 250050000, '₹2,000 × 1,250.25 sqft = ₹25,00,500');

  // rate renegotiated
  const rerated = await put(c.id, { ratePerSqftRupees: '2100', measuredAreaSqft: '1250.25' });
  assert.strictEqual(rerated.statedAmountPaise, 262552500, '₹2,100 × 1,250.25 sqft = ₹26,25,525');

  // area cleared again — back to whatever is typed (nothing here), NOT the last computed figure
  const cleared = await put(c.id, { ratePerSqftRupees: '2100', measuredAreaSqft: '' });
  assert.strictEqual(cleared.measuredAreaMilliSqft, null);
  assert.strictEqual(cleared.statedAmountPaise, null, 'a stale derived price is not left behind');
  assert.strictEqual(cleared.pricingMode, 'none');
});

test('a derived price drives owed and figure A through the same column a typed one does', async () => {
  const c = await mk({ ratePerSqftRupees: '2000', measuredAreaSqft: '1000' }); // ₹20,00,000
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: c.id, amountRupees: '500000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  const money = (await H.get('/api/overview', { cookie })).json.money;
  assert.strictEqual(money.totalContractPaise, 200000000, 'A = the derived contract value');
  assert.strictEqual(money.owedToContractorsPaise, 150000000, 'owed = ₹20,00,000 − ₹5,00,000 paid');
});

test('malformed rate or area is rejected; both are optional when blank', async () => {
  assert.strictEqual((await H.post('/api/contracts', { ...BASE, ratePerSqftRupees: 'abc' }, { cookie })).status, 400);
  const live = await mk({});
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { ...BASE, measuredAreaSqft: '-5' }, { cookie })).status, 400, 'negative area rejected');
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { ...BASE, measuredAreaSqft: '0' }, { cookie })).status, 400, 'zero area rejected');
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { ...BASE, measuredAreaSqft: '1234.5678' }, { cookie })).status, 400, 'more than 3 decimals rejected');
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { ...BASE, ratePerSqftRupees: '', measuredAreaSqft: '' }, { cookie })).status, 200, 'blank is fine');
});

// ── optional metadata ─────────────────────────────────────────────────────────────────────────────
test('every new metadata field is optional and round-trips', async () => {
  const c = await mk({
    dateSigned: '2026-01-31',
    completionPeriodMonths: '13',
    supervisionRatePct: '12.5',
    specifiedBrands: 'Cement: as specified. Wiring: as specified.',
    excludedScope: 'Compound wall, landscaping.',
    ownerObligations: 'Water and power at site.',
  });
  assert.strictEqual(c.completionPeriodMonths, 13);
  assert.strictEqual(c.supervisionRatePct, 12.5);
  assert.strictEqual(c.specifiedBrands, 'Cement: as specified. Wiring: as specified.');
  assert.strictEqual(c.excludedScope, 'Compound wall, landscaping.');
  assert.strictEqual(c.ownerObligations, 'Water and power at site.');

  const bare = await put(c.id, {}); // every field omitted
  assert.strictEqual(bare.completionPeriodMonths, null);
  assert.strictEqual(bare.supervisionRatePct, null);
  assert.strictEqual(bare.specifiedBrands, '');
  assert.strictEqual(bare.dateSigned, '', 'the signing date is optional too');
});

test('expectedCompletionDate = signing date + N months, clamped at month end, derived not stored', async () => {
  const c = await mk({ dateSigned: '2026-01-31', completionPeriodMonths: '1' });
  assert.strictEqual(c.expectedCompletionDate, '2026-02-28', '31 Jan + 1 month clamps to the end of Feb');
  assert.strictEqual(
    H.db.prepare('PRAGMA table_info(contract)').all().some((col) => col.name.includes('expected')), false,
    'it is computed from two editable fields, never stored as a third');

  assert.strictEqual((await put(c.id, { dateSigned: '2026-07-15', completionPeriodMonths: '18' })).expectedCompletionDate, '2028-01-15', 'crosses years correctly');
  assert.strictEqual((await put(c.id, { completionPeriodMonths: '12' })).expectedCompletionDate, '', 'no signing date to count from -> no date claimed');
  assert.strictEqual((await put(c.id, { dateSigned: '2026-07-15' })).expectedCompletionDate, '', 'no period -> no date claimed');
});

test('out-of-range metadata is rejected', async () => {
  assert.strictEqual((await H.post('/api/contracts', { ...BASE, completionPeriodMonths: '0' }, { cookie })).status, 400);
  const live = await mk({});
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { ...BASE, completionPeriodMonths: '2.5' }, { cookie })).status, 400, 'months must be whole');
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { ...BASE, supervisionRatePct: '101' }, { cookie })).status, 400, 'a percentage over 100 is rejected');
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { ...BASE, supervisionRatePct: '0' }, { cookie })).status, 200, '0% is a legitimate answer');
});

test('the supervision rate drives no calculation — it only records what the contract says', async () => {
  const c = await mk({ statedAmountRupees: '1000000.00', supervisionRatePct: '15' });
  const money = (await H.get('/api/overview', { cookie })).json.money;
  assert.strictEqual(money.totalContractPaise, 100000000, 'A is the stated price, not the price plus supervision');
  assert.strictEqual(money.owedToContractorsPaise, 100000000, 'and owed is untouched by it');
  assert.strictEqual(c.supervisionRatePct, 15);
});

// ── reconciliation: derived-price drift ───────────────────────────────────────────────────────────
test('reconciliation flags a stored price that no longer equals rate × area, and adjusts nothing', async () => {
  const c = await mk({ ratePerSqftRupees: '2000', measuredAreaSqft: '1000' }); // ₹20,00,000
  let o = (await H.get('/api/overview', { cookie })).json;
  assert.strictEqual(o.reconciliation.contractPriceDerivation.drifted, false, 'a freshly saved contract does not drift');
  assert.strictEqual(o.reconciliation.ok, true);

  // Reach past the write path, exactly as a restored backup does (it writes columns verbatim).
  H.db.prepare('UPDATE contract SET price_of_contract_paise = ? WHERE id = ?').run(123456789, c.id);
  o = (await H.get('/api/overview', { cookie })).json;
  assert.strictEqual(o.reconciliation.contractPriceDerivation.drifted, true, 'the mismatch is detected');
  assert.deepStrictEqual(o.reconciliation.contractPriceDerivation.contracts, [
    { contractId: c.id, storedPaise: 123456789, expectedPaise: 200000000 },
  ]);
  assert.strictEqual(o.reconciliation.ok, false);
  assert.strictEqual(o.money.totalContractPaise, 123456789, 'the STORED figure is still what is reported — nothing is corrected');

  // Re-saving the contract is the documented repair.
  await put(c.id, { ratePerSqftRupees: '2000', measuredAreaSqft: '1000' });
  o = (await H.get('/api/overview', { cookie })).json;
  assert.strictEqual(o.reconciliation.contractPriceDerivation.drifted, false, 're-saving recomputes it');
  assert.strictEqual(o.money.totalContractPaise, 200000000);
});

test('a typed-price contract can never drift — the check only looks at rate-priced ones', async () => {
  await mk({ statedAmountRupees: '2500000.00' });
  const o = (await H.get('/api/overview', { cookie })).json;
  assert.strictEqual(o.reconciliation.contractPriceDerivation.drifted, false);
  assert.deepStrictEqual(o.reconciliation.contractPriceDerivation.contracts, []);
});
