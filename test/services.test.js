// Services phase — contract services (A), the debit service picker + the one-service-one-live-debit
// guard (C/D), per-user customs (E), company (F). API + direct-index coverage.
//
// TWO things this file used to cover are gone with Contract Phase A:
//   · the service PRICE. The contract is a fixed unit-rate lump sum whose schedule of work attaches
//     no rupee figure to any scope item, so price_paise could only hold an invented number.
//   · the REMAINDER line it fed (stated − Σ priced services). With no priced services it could only
//     ever equal the stated total, restating a figure already on screen.
// What is left is asserted below: a service is a NAME, every live service is linkable, and the
// one-live-debit guard is unchanged (it never depended on the price).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const mkContract = async (stated = '100000.00', extra = {}) => {
  const r = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', statedAmountRupees: stated, dateSigned: '2026-07-01', ...extra }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.contract;
};
const addService = async (cid, name) => {
  const r = await H.post(`/api/contracts/${cid}/services`, { name }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.service;
};
const getContract = async () => (await H.get('/api/contracts', { cookie })).json.contracts[0];

// ── Part A — services are a SCOPE LIST: a name, and nothing else ─────────────────────────────────
test('Part A — a service is a name; no price is stored, asked for, or returned', async () => {
  const c = await mkContract();
  const svc = await addService(c.id, 'Electrical');
  assert.deepStrictEqual(Object.keys(svc).sort(), ['id', 'name'], 'the API shape is exactly { id, name }');
  assert.strictEqual('price_paise' in H.db.prepare('SELECT * FROM contract_services WHERE id = ?').get(svc.id), false,
    'the column itself is gone from the table');
  const second = await addService(c.id, 'Consultation');
  assert.strictEqual((await getContract()).services.length, 2, 'both services returned on the contract');
  // soft-delete removes it from the live list
  assert.strictEqual((await H.del(`/api/contracts/${c.id}/services/${second.id}`, { cookie })).status, 200);
  assert.strictEqual((await getContract()).services.length, 1, 'soft-deleted service drops out of the live list');
});

test('Part A — a stale client still sending priceRupees is IGNORED, not rejected', async () => {
  const c = await mkContract();
  const r = await H.post(`/api/contracts/${c.id}/services`, { name: 'Plumbing', priceRupees: '40000' }, { cookie });
  assert.strictEqual(r.status, 201, 'the extra field does not 400 an otherwise valid save');
  assert.deepStrictEqual(Object.keys(r.json.service).sort(), ['id', 'name'], 'and nothing about it is stored');
});

// ── Part B — the remainder line is GONE ──────────────────────────────────────────────────────────
test('Part B — no remainder is reported: with no service prices there is nothing to subtract', async () => {
  const c = await mkContract('1000000.00'); // ₹10,00,000
  await addService(c.id, 'A');
  await addService(c.id, 'B');
  const got = await getContract();
  assert.strictEqual(got.remainderPaise, undefined, 'remainderPaise is removed from the payload');
  assert.strictEqual(got.servicesPricedTotalPaise, undefined, 'so is the priced-services total that fed it');
  assert.strictEqual(got.statedAmountPaise, 100000000, 'the stated total is untouched by how many services exist');
});

// ── Part C — the picker fills the offset; manual entry still works ────────────────────────────────
test('Part C — a debit linking a service records the service id, and no amount', async () => {
  const c = await mkContract();
  const svc = await addService(c.id, 'Electrical');
  const deb = await H.post('/api/cash-out', { amountRupees: '32000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id }, { cookie });
  assert.strictEqual(deb.status, 201, JSON.stringify(deb.json));
  assert.strictEqual(deb.json.entry.contractServiceId, svc.id, 'the service link (provenance) is recorded');
  assert.strictEqual(deb.json.entry.contractStatedPaise, null, 'the service price is NOT copied onto the debit any more');
});

test('Part C — an in-contract debit with NO service picked still works exactly as before', async () => {
  await mkContract();
  const deb = await H.post('/api/cash-out', { amountRupees: '1000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included' }, { cookie });
  assert.strictEqual(deb.status, 201, JSON.stringify(deb.json));
  assert.strictEqual(deb.json.entry.contractServiceId, null, 'no service link when none is picked');
  assert.strictEqual(deb.json.entry.contractStatedPaise, null);
});

test('Part C — EVERY live service is linkable now; a service that does not exist still is not', async () => {
  const c = await mkContract();
  const svc = await addService(c.id, 'Consultation');
  // The old rule ("only a PRICED service can be linked") went out with the column. This service
  // would have been rejected before Contract Phase A; it must be accepted now.
  const ok = await H.post('/api/cash-out', { amountRupees: '100.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id }, { cookie });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.entry.contractServiceId, svc.id);
  const bad = await H.post('/api/cash-out', { amountRupees: '100.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id + 9999 }, { cookie });
  assert.strictEqual(bad.status, 400, 'a service id that resolves to nothing is still rejected');
});

test('Part C — scope=extra clears any service link', async () => {
  const c = await mkContract();
  const svc = await addService(c.id, 'Electrical');
  const extra = await H.post('/api/cash-out', { amountRupees: '100.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '1.0', contractScope: 'extra', contractServiceId: svc.id }, { cookie });
  assert.strictEqual(extra.status, 201);
  assert.strictEqual(extra.json.entry.contractServiceId, null, 'scope=extra forces the service link to NULL');
});

// ── Part D — one service, one offset (API + directly against the index) ───────────────────────────
test('Part D — two live debits cannot claim one service (API 409, naming the existing debit)', async () => {
  const c = await mkContract();
  const svc = await addService(c.id, 'Electrical');
  const body = (d) => ({ amountRupees: '32000.00', txDate: d, byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id });
  const first = await H.post('/api/cash-out', body('2026-07-12'), { cookie });
  assert.strictEqual(first.status, 201);
  const second = await H.post('/api/cash-out', body('2026-07-13'), { cookie });
  assert.strictEqual(second.status, 409, 'the second debit claiming the same service is refused');
  assert.match(second.json.error, new RegExp('#' + first.json.entry.id), 'the 409 names the existing debit');
});

test('Part D — the invariant is enforced in the DB (partial unique index), not just app code', () => {
  const cid = H.seedContract();
  const sid = Number(H.db.prepare("INSERT INTO contract_services (contract_id, name) VALUES (?, 'E')").run(cid).lastInsertRowid);
  const ins = (d) => H.db.prepare("INSERT INTO cash_out (amount_paise, tx_date, by_type, ledger_code, contract_scope, contract_service_id) VALUES (100,?,'user','5.0','included',?)").run(d, sid);
  ins('2026-07-12');
  assert.throws(() => ins('2026-07-13'), /UNIQUE/, 'a second LIVE debit on the same service violates idx_cash_out_service_live');
  // A NULL link is unconstrained: many live debits may carry no service.
  const nul = () => H.db.prepare("INSERT INTO cash_out (amount_paise, tx_date, by_type, ledger_code, contract_scope) VALUES (1,'2026-07-14','user','1.0','extra')").run();
  assert.doesNotThrow(nul); assert.doesNotThrow(nul);
});

test('Part D — soft-delete RELEASES the service; restore REFUSES if it has since been claimed', async () => {
  const c = await mkContract();
  const svc = await addService(c.id, 'Electrical');
  const body = (d) => ({ amountRupees: '32000.00', txDate: d, byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id });
  const first = (await H.post('/api/cash-out', body('2026-07-12'), { cookie })).json.entry.id;
  assert.strictEqual((await H.del(`/api/cash-out/${first}`, { cookie })).status, 200, 'soft-delete the first debit');
  // released: a second debit can now claim the same service
  const second = await H.post('/api/cash-out', body('2026-07-13'), { cookie });
  assert.strictEqual(second.status, 201, 'the service is free after the first was soft-deleted');
  // restoring the first now double-claims -> refuse (same 409 shape as the three existing guards)
  const restore = await H.post(`/api/trash/cash_out/${first}/restore`, undefined, { cookie });
  assert.strictEqual(restore.status, 409, 'restore refuses because the service was reclaimed');
  assert.match(restore.json.error, new RegExp('#' + second.json.entry.id), 'names the claimant');
});

test('Part C/D — editing a linked debit WITHOUT sending contractServiceId PRESERVES the link', async () => {
  const c = await mkContract();
  const svc = await addService(c.id, 'Electrical');
  const first = (await H.post('/api/cash-out', { amountRupees: '32000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id }, { cookie })).json.entry.id;
  // The editable table's PUT does NOT carry contractServiceId; the link must survive an amount edit.
  const put = await H.put(`/api/cash-out/${first}`, { amountRupees: '35000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included' }, { cookie });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.json.entry.contractServiceId, svc.id, 'the service link is preserved across an edit that omits it');
  // Because it is preserved, a second debit still cannot claim the same service (guard not bypassed).
  const second = await H.post('/api/cash-out', { amountRupees: '1.00', txDate: '2026-07-13', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id }, { cookie });
  assert.strictEqual(second.status, 409, 'the preserved link still blocks a double-claim');
});

// ── Part D — a linked service does NOT move the dues maths (cumulative under a range) ──────────────
test('Part D — a service-linked debit leaves owed at stated − paid, cumulative under a range', async () => {
  const c = await mkContract('100000.00');
  const svc = await addService(c.id, 'Electrical');
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: c.id, amountRupees: '40000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  const deb = await H.post('/api/cash-out', { amountRupees: '32000.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'included', contractServiceId: svc.id }, { cookie });
  assert.strictEqual(deb.status, 201);
  const full = (await H.get('/api/overview', { cookie })).json.money;
  assert.strictEqual(full.owedToContractorsPaise, 6000000, 'owed = ₹60,000 (100000 − 40000 paid); the linked service offsets nothing');
  const excl = (await H.get('/api/overview?start=2026-09-01&end=2026-09-30', { cookie })).json.money;
  assert.strictEqual(excl.owedToContractorsPaise, 6000000, 'owed stays ₹60,000 under a range excluding the debit (cumulative)');
});

// ── Part E — per-user customs ─────────────────────────────────────────────────────────────────────
// 'Part E — a typed custom ledger name is saved to the caller list and is INVISIBLE to other users' is
// removed: it verified the "invisible to B" half via a second logged-in identity (B) over HTTP.
// Phase 1.6 (single-owner auth) removed login, so there is no second live identity left to request as.

test('Part E — existing free-text custom ledger names still display on their rows', async () => {
  // A pre-existing row written directly (as a migration/legacy row would be), custom ledger, no list entry.
  const id = Number(H.db.prepare("INSERT INTO cash_out (amount_paise, tx_date, by_type, ledger_code, ledger_custom_name, contract_scope) VALUES (500, '2026-01-01', 'user', 'CUSTOM', 'Legacy custom cat', 'extra')").run().lastInsertRowid);
  const rows = (await H.get('/api/cash-out', { cookie })).json.entries;
  const row = rows.find((e) => e.id === id);
  assert.ok(row, 'the legacy custom row is listed');
  assert.strictEqual(row.ledger, 'Legacy custom cat', 'its free-text custom name still displays unchanged');
});

// ── Part F — company (presentation), and the scope values are UNTOUCHED ───────────────────────────
test('Part F — optional company round-trips; contract_scope values stay included/extra', async () => {
  const c = await mkContract('100000.00', { company: 'Rajan & Sons Builders' });
  assert.strictEqual((await getContract()).company, 'Rajan & Sons Builders', 'company saved + returned');
  const deb = await H.post('/api/cash-out', { amountRupees: '100.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '1.0', contractScope: 'extra' }, { cookie });
  assert.strictEqual(H.db.prepare('SELECT contract_scope FROM cash_out WHERE id=?').get(deb.json.entry.id).contract_scope, 'extra', 'stored scope value unchanged (presentation-only rename)');
});

// ── a pre-change backup still imports ─────────────────────────────────────────────────────────────
test('a pre-change backup (no contract_services, no company / contract_service_id) still imports', async () => {
  const backup = {
    app: 'plannr', kind: 'plannr-backup', schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z',
    tables: {
      contract: [{ id: 1, contractor_name: 'Old', area_of_work: 'x', ledger_code: '5.0', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null, amount_paise: null, price_of_contract_paise: 100000, contract_end_date: null, date_signed: '2025-01-01', created_at: '2025-01-01 00:00:00', updated_at: '2025-01-01 00:00:00', deleted_at: null }],
      loans: [], settings: [{ key: 'budget_paise', value: '5000' }], cash_in: [],
      cash_out: [{ id: 1, amount_paise: 3200, tx_date: '2025-02-01', by_type: 'user', by_user_id: null, by_label: null, ledger_code: '5.0', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null, reason: null, contract_scope: 'included', contract_stated_paise: 4000, created_at: '2025-02-01 00:00:00', updated_at: '2025-02-01 00:00:00', deleted_at: null }],
    },
  };
  const r = await H.post('/api/backup/import', backup, { cookie });
  assert.strictEqual(r.status, 200, 'pre-change backup imports: ' + JSON.stringify(r.json));
  // imported rows carry NULL for the new columns
  const co = H.db.prepare('SELECT contract_service_id FROM cash_out WHERE id=1').get();
  assert.strictEqual(co.contract_service_id, null, 'no service link on a pre-change row');
  assert.strictEqual(H.db.prepare('SELECT company FROM contract WHERE id=1').get().company, null, 'company defaults NULL');
});
