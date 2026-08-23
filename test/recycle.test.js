// Recycle Bin (Phase 3C) — five-table delete/restore cycle + the three 409/400 guards + auth.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const deletedAt = (table, id) => H.db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id).deleted_at;
const seedLoan = () => Number(H.db.prepare('INSERT INTO loans (amount_paise, bank_name) VALUES (?, ?)').run(500000, 'Bank').lastInsertRowid);

test('five-table delete-and-restore cycle', async () => {
  const cases = [
    { path: '/api/cash-in', table: 'cash_in', seed: () => H.seedCashIn({ byUserId: userId }) },
    { path: '/api/cash-out', table: 'cash_out', seed: () => H.seedCashOut({ byUserId: userId }) },
    { path: '/api/loans', table: 'loans', seed: seedLoan },
    { path: '/api/contracts', table: 'contract', seed: () => H.seedContract() },
    { path: '/api/contractor-payments', table: 'contractor_payments', seed: () => H.seedPayment({ contractId: H.seedContract() }) },
  ];
  for (const c of cases) {
    H.clearLedger();
    const id = c.seed();
    assert.strictEqual((await H.del(c.path + '/' + id, { cookie })).status, 200, `${c.table}: soft-delete`);
    assert.notStrictEqual(deletedAt(c.table, id), null, `${c.table}: now soft-deleted`);
    const trash = await H.get('/api/trash', { cookie });
    assert.ok(JSON.stringify(trash.json).includes(`"id":${id}`), `${c.table}: appears in /api/trash`);
    assert.strictEqual((await H.post(`/api/trash/${c.table}/${id}/restore`, undefined, { cookie })).status, 200, `${c.table}: restore`);
    assert.strictEqual(deletedAt(c.table, id), null, `${c.table}: live again`);
  }
});

test('restoring a payment under a soft-deleted contract returns 409', async () => {
  const cid = H.seedContract();
  const pid = H.seedPayment({ contractId: cid });
  await H.del('/api/contractor-payments/' + pid, { cookie }); // payment -> trash
  await H.del('/api/contracts/' + cid, { cookie });           // contract -> trash
  const r = await H.post(`/api/trash/contractor_payments/${pid}/restore`, undefined, { cookie });
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /parent contract first/i);
});

test('hard-deleting a contract that still has payments returns 409', async () => {
  const cid = H.seedContract();
  H.seedPayment({ contractId: cid });
  await H.del('/api/contracts/' + cid, { cookie }); // can't delete a contract with LIVE payments... so soft-delete needs no live payment
  // The contract delete above may 409 if payments are live; soft-delete the payment first if so.
  if (deletedAt('contract', cid) === null) { const pid = H.db.prepare('SELECT id FROM contractor_payments WHERE contract_id=?').get(cid).id; H.db.prepare("UPDATE contractor_payments SET deleted_at=datetime('now') WHERE id=?").run(pid); await H.del('/api/contracts/' + cid, { cookie }); }
  const r = await H.del(`/api/trash/contract/${cid}`, { cookie }); // hard delete with payments still referencing
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /still has .* contractor payment/i);
});

test('a bogus :table returns 400', async () => {
  assert.strictEqual((await H.post('/api/trash/bogus/1/restore', undefined, { cookie })).status, 400);
  assert.strictEqual((await H.del('/api/trash/bogus/1', { cookie })).status, 400);
});
