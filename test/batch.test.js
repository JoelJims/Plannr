// Batch save (Phase 6B) — per-row hold-back, and both 413s.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const amountOf = (id) => H.db.prepare('SELECT amount_paise FROM cash_out WHERE id = ?').get(id).amount_paise;
const editBody = (id, amountRupees, byUId) => ({ id, amountRupees, txDate: '2026-07-12', byType: 'user', byUserId: byUId == null ? userId : byUId, ledgerCode: '1.0', subledgerCode: '', contractScope: 'extra' });

test('N-1 rows persist while one invalid row is held back; the others are unaffected', async () => {
  const ids = [0, 1, 2, 3, 4].map(() => H.seedCashOut({ amountPaise: 10000, byUserId: userId }));
  const rows = ids.map((id, i) => editBody(id, '500.00', i === 2 ? 99999 : userId)); // row index 2 invalid
  const r = await H.post('/api/cash-out/batch', { rows }, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.saved, 4);
  assert.strictEqual(r.json.failed, 1);
  const bad = r.json.results[2];
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /does not exist/i);
  assert.strictEqual(amountOf(ids[2]), 10000, 'held-back row unchanged');
  for (const i of [0, 1, 3, 4]) assert.strictEqual(amountOf(ids[i]), 50000, `row ${i} saved`);
});

test('over BATCH_MAX_ROWS (501) returns 413 with the row-cap message', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ id: 100000 + i })); // tiny rows -> under the 256kb parser limit
  const r = await H.post('/api/cash-out/batch', { rows }, { cookie });
  assert.strictEqual(r.status, 413);
  assert.match(r.json.error, /maximum is 500/i);
});

test('an oversized body returns the clean 413 message, not a raw parser error', async () => {
  // ~50 rows each carrying a ~6KB remark => ~300KB > the 256KB parser limit, but < 500 rows: this
  // trips the body-size limit BEFORE the row-count check, exercising the entity.too.large handler.
  const big = 'x'.repeat(6000);
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, reason: big }));
  const r = await H.post('/api/cash-out/batch', { rows }, { cookie });
  assert.strictEqual(r.status, 413);
  assert.match(r.json.error, /too large to process in one go/i);
  assert.doesNotMatch(r.json.error, /Invalid request/i, 'must be the clean message, not a bare parser error');
});

// Step 1.4 B12: the write runs in db.js transaction(). A database error on the last row (a trigger
// here, standing in for a full disk or a broken constraint) must leave every row as it was.
test('a write that fails on its last row rolls the whole save back: no row changes', async () => {
  const ids = [0, 1, 2].map(() => H.seedCashOut({ amountPaise: 10000, byUserId: userId }));
  H.db.exec(`CREATE TRIGGER test_batch_fail BEFORE UPDATE ON cash_out WHEN NEW.id = ${ids[2]} BEGIN SELECT RAISE(ABORT, 'test: this row cannot be written'); END`);
  try {
    const r = await H.post('/api/cash-out/batch', { rows: ids.map((id) => editBody(id, '500.00')) }, { cookie });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json.error, "Couldn't save – try again."); // Q11: the owner's wording for any failed save
  } finally {
    H.db.exec('DROP TRIGGER IF EXISTS test_batch_fail');
  }
  for (const id of ids) assert.strictEqual(amountOf(id), 10000, `row ${id} unchanged`);
  const again = await H.post('/api/cash-out/batch', { rows: ids.map((id) => editBody(id, '500.00')) }, { cookie });
  assert.strictEqual(again.json.saved, 3, 'the next save works: no transaction was left open');
});

// Step 1.4 B12: the "is this row live?" check is read through the async interface. An edit of a row
// that is in the Recycle Bin, or that never existed, is a 404 (single edit) or a held-back row (Save
// All), and changes nothing.
test('editing a deleted or missing row: 404 on its own, held back in Save All', async () => {
  const [live, gone] = [0, 1].map(() => H.seedCashOut({ amountPaise: 10000, byUserId: userId }));
  assert.strictEqual((await H.del('/api/cash-out/' + gone, { cookie })).status, 200);
  for (const id of [gone, gone + 1000]) {
    const r = await H.put('/api/cash-out/' + id, editBody(id, '500.00'), { cookie });
    assert.strictEqual(r.status, 404, `PUT ${id === gone ? 'a deleted row' : 'a missing row'}`);
    assert.strictEqual(r.json.error, 'Entry not found.');
  }
  const r = await H.post('/api/cash-out/batch', { rows: [editBody(live, '500.00'), editBody(gone, '500.00')] }, { cookie });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.json.saved, r.json.failed], [1, 1]);
  assert.deepStrictEqual(r.json.results[1], { id: gone, ok: false, error: 'Entry not found.' });
  assert.deepStrictEqual([amountOf(live), amountOf(gone)], [50000, 10000], 'only the live row changed');
});
