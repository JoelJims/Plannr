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

// Step 1.4 B11: the contract's children are read through the async interface. No test read them back
// from the API before, so an un-awaited read (a Promise sent as {}) went unnoticed.
test('the contract answer carries its payment dates, services and allowances, on create, edit and list', async () => {
  const body = { ...C('A'), paymentDates: ['2026-09-01', '2026-08-01'] };
  const made = await H.post('/api/contracts', body, { cookie });
  assert.strictEqual(made.status, 201);
  const id = made.json.contract.id;
  assert.deepStrictEqual(made.json.contract.paymentDates, ['2026-08-01', '2026-09-01'], 'create: the dates, in date order');
  assert.strictEqual((await H.post(`/api/contracts/${id}/services`, { name: 'Plastering' }, { cookie })).status, 201);
  assert.strictEqual((await H.post(`/api/contracts/${id}/allowances`, { name: 'Tiles', capKind: 'lump', capRupees: '50000' }, { cookie })).status, 201);
  const edited = await H.put(`/api/contracts/${id}`, { ...body, paymentDates: ['2026-10-01'] }, { cookie });
  assert.strictEqual(edited.status, 200);
  for (const [what, c] of [['edit', edited.json.contract], ['list', (await H.get('/api/contracts', { cookie })).json.contracts[0]]]) {
    assert.deepStrictEqual(c.paymentDates, ['2026-10-01'], `${what}: the dates replaced`);
    assert.deepStrictEqual(c.services.map((s) => s.name), ['Plastering'], `${what}: the services`);
    assert.deepStrictEqual(c.allowances.map((a) => [a.name, a.capPaise, a.spentPaise]), [['Tiles', 5000000, 0]], `${what}: the allowances`);
  }
});

test('a contractor payment needs a live contract: a missing or deleted one is refused', async () => {
  const id = (await create('A')).json.contract.id;
  const pay = (contractId) => H.post('/api/contractor-payments', { contractId, payDate: '2026-08-01', amountRupees: '1000' }, { cookie });
  assert.strictEqual((await pay(id)).status, 201, 'the live contract is accepted');
  assert.strictEqual((await del(id)).status, 409, 'a contract with a live payment cannot be deleted');
  H.db.prepare('UPDATE contract SET deleted_at = datetime(\'now\') WHERE id = ?').run(id);
  for (const bad of [id, id + 1000]) {
    const r = await pay(bad);
    assert.strictEqual(r.status, 400, `contract ${bad === id ? 'in the Recycle Bin' : 'that does not exist'}`);
    assert.strictEqual(r.json.error, 'Select a valid contract.');
  }
});

// Review finding Q3: saving a contract wrote the contract row and its payment dates as separate
// statements. A failure part-way left the edit half-done: the new name with only some of the new
// dates, the old dates deleted. A trigger makes one date's insert fail; nothing of the save may stay.
test('a contract and its payment dates are saved all or nothing (create and edit)', async () => {
  const dates = () => H.db.prepare('SELECT pay_date FROM contract_payment_dates ORDER BY pay_date').all().map((r) => r.pay_date);
  const made = await H.post('/api/contracts', { ...C('Before'), paymentDates: ['2026-08-01', '2026-09-01'] }, { cookie });
  assert.strictEqual(made.status, 201);
  const id = made.json.contract.id;
  H.db.exec("CREATE TRIGGER q3_fail_one_date BEFORE INSERT ON contract_payment_dates WHEN NEW.pay_date = '2099-01-01' BEGIN SELECT RAISE(ABORT, 'injected: this date cannot be saved'); END");
  try {
    const edit = await H.put(`/api/contracts/${id}`, { ...C('After'), paymentDates: ['2026-10-01', '2099-01-01'] }, { cookie });
    assert.strictEqual(edit.status, 500, JSON.stringify(edit.json));
    assert.strictEqual(H.db.prepare('SELECT contractor_name n FROM contract WHERE id = ?').get(id).n, 'Before', 'the edit is undone');
    assert.deepStrictEqual(dates(), ['2026-08-01', '2026-09-01'], 'the old dates are all still there');

    assert.strictEqual((await del(id)).status, 200);
    const create2 = await H.post('/api/contracts', { ...C('New'), paymentDates: ['2026-11-01', '2099-01-01'] }, { cookie });
    assert.strictEqual(create2.status, 500, JSON.stringify(create2.json));
    assert.strictEqual(liveCount(), 0, 'no contract without its dates');
    assert.deepStrictEqual(dates(), ['2026-08-01', '2026-09-01'], 'no stray dates from the failed create');
  } finally {
    H.db.exec('DROP TRIGGER IF EXISTS q3_fail_one_date');
  }
  const ok = await H.post('/api/contracts', { ...C('New'), paymentDates: ['2026-11-01'] }, { cookie });
  assert.strictEqual(ok.status, 201, 'saves work again');
});
