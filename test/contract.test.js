// One-live-contract invariant (Phase 5D) — enforced in the DB by a partial unique index.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const C = (n) => ({ contractorName: n || 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', statedAmountRupees: '100000.00', dateSigned: '2026-07-01' });
const create = (n) => H.post('/api/contracts', C(n), { cookie });
const del = (id) => H.del('/api/contracts/' + id, { cookie });
const restore = (id) => H.post('/api/trash/contract/' + id + '/restore', undefined, { cookie });
const liveCount = () => H.db.prepare('SELECT COUNT(*) n FROM contract WHERE deleted_at IS NULL').get().n;

test('a second create returns 409', async () => {
  assert.strictEqual((await create('A')).status, 201);
  const second = await create('B');
  assert.strictEqual(second.status, 409);
  assert.match(second.json.error, /single contract/i);
  assert.strictEqual(liveCount(), 1);
});

test('a soft-deleted contract coexists with a live one; delete-then-restore succeeds', async () => {
  const a = (await create('A')).json.contract.id;
  assert.strictEqual((await del(a)).status, 200);          // A -> trash, none live
  assert.strictEqual(liveCount(), 0);
  const b = (await create('B')).json.contract.id;          // B now the live one
  assert.strictEqual(liveCount(), 1);
  // soft-deleted A coexists with live B
  const total = H.db.prepare('SELECT COUNT(*) n FROM contract').get().n;
  assert.strictEqual(total, 2, 'both rows exist (A soft-deleted, B live)');

  // delete-then-restore succeeds when nothing else is live
  assert.strictEqual((await del(b)).status, 200);          // B -> trash, none live
  assert.strictEqual((await restore(b)).status, 200);      // restore B -> live again
  assert.strictEqual(liveCount(), 1);
});

test('restoring a soft-deleted contract while one is live returns 409', async () => {
  const a = (await create('A')).json.contract.id;
  await del(a);                                            // A -> trash
  await create('B');                                       // B live
  const r = await restore(a);                              // can't restore A while B is live
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /already live|single contract/i);
  assert.strictEqual(liveCount(), 1);
});

// ── The total contract value is OPTIONAL ─────────────────────────────────────────────────────────
// A contract may now be saved with no stated price. It then contributes nothing to figure A (total
// contract) and nothing to owed — the payments against it still count in B/D/pie. A contract that
// DOES carry a price behaves exactly as it always did.
test('a contract saves with NO stated amount, and stores NULL (not 0)', async () => {
  const r = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', dateSigned: '2026-07-01' }, { cookie });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.contract.statedAmountPaise, null, 'blank -> NULL, never 0');
  assert.strictEqual(H.db.prepare('SELECT price_of_contract_paise p FROM contract WHERE id=?').get(r.json.contract.id).p, null);
});

test('an empty-string stated amount is accepted; a malformed or non-positive one is still 400', async () => {
  assert.strictEqual((await H.post('/api/contracts', { contractorName: 'A', areaOfWork: 'F', ledgerCode: '5.0', dateSigned: '2026-07-01', statedAmountRupees: '' }, { cookie })).status, 201);
  const live = H.db.prepare('SELECT id FROM contract WHERE deleted_at IS NULL').get();
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { contractorName: 'A', areaOfWork: 'F', ledgerCode: '5.0', dateSigned: '2026-07-01', statedAmountRupees: 'abc' }, { cookie })).status, 400, 'malformed is rejected');
  assert.strictEqual((await H.put('/api/contracts/' + live.id, { contractorName: 'A', areaOfWork: 'F', ledgerCode: '5.0', dateSigned: '2026-07-01', statedAmountRupees: '0' }, { cookie })).status, 400, 'zero is rejected');
});

test('an unstated contract contributes 0 to figure A and 0 to owed; its payments still count in B', async () => {
  const c = await H.post('/api/contracts', { contractorName: 'ACME', areaOfWork: 'Foundation', ledgerCode: '5.0', dateSigned: '2026-07-01' }, { cookie });
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: c.json.contract.id, amountRupees: '40000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  const m = (await H.get('/api/overview', { cookie })).json.money;
  assert.strictEqual(m.totalContractPaise, 0, 'A = 0 — nothing stated');
  assert.strictEqual(m.paidToContractorsPaise, 4000000, 'B still counts the payment');
  assert.strictEqual(m.owedToContractorsPaise, -4000000, 'owed = 0 − 40,000, reported unclamped (overpaid)');
});

test('a contract WITH a price is unchanged: A and owed behave exactly as before', async () => {
  const c = await create('ACME');                            // stated ₹1,00,000
  assert.strictEqual((await H.post('/api/contractor-payments', { contractId: c.json.contract.id, amountRupees: '40000.00', payDate: '2026-07-10' }, { cookie })).status, 201);
  const m = (await H.get('/api/overview', { cookie })).json.money;
  assert.strictEqual(m.totalContractPaise, 10000000);
  assert.strictEqual(m.owedToContractorsPaise, 6000000, 'owed = 1,00,000 − 40,000');
});
