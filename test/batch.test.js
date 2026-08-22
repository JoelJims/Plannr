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
