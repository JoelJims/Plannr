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
