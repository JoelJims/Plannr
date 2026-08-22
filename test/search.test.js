// Part A — SQL-side outflow search/filter. Each filter alone + composed with correct counts, the
// unfiltered `total`, cross-tenant isolation of the filtered query, and that a filtered edit-mode save
// touches only the rows it was given (never rows outside the filter).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let A, B;

// Direct insert with the fields the search spans (reason + custom names) — seedCashOut doesn't carry them.
function ins(tenantId, o) {
  return Number(H.db.prepare(
    `INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, ledger_code, subledger_code, ledger_custom_name, subledger_custom_name, reason, contract_scope, deleted_at, tenant_id)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(o.amountPaise, o.txDate, o.byUserId, o.ledgerCode, o.subledgerCode || null, o.ledgerCustomName || null, o.subledgerCustomName || null, o.reason || null, o.scope || 'extra', o.deletedAt || null, tenantId).lastInsertRowid);
}
async function search(cookie, qs) {
  const r = await H.get('/api/cash-out' + (qs ? '?' + qs : ''), { cookie });
  return r;
}
const reasons = (json) => json.entries.map((e) => e.reason).sort();

before(async () => {
  await H.startApp();
  A = H.seedLoggedIn();
  B = H.seedLoggedIn();
});
after(async () => { await H.stopApp(); });

beforeEach(() => {
  H.clearLedger();
  // Tenant A: 4 live rows + 1 soft-deleted (must never appear).
  ins(A.user.id, { amountPaise: 10000, txDate: '2026-01-10', byUserId: A.user.id, ledgerCode: '4.0', subledgerCode: '4.2', reason: 'Cement bags' });
  ins(A.user.id, { amountPaise: 50000, txDate: '2026-02-15', byUserId: A.user.id, ledgerCode: '4.0', subledgerCode: '4.1', reason: 'Steel rods' });
  ins(A.user.id, { amountPaise: 200000, txDate: '2026-03-20', byUserId: A.user.id, ledgerCode: '5.0', subledgerCode: '5.1', reason: 'Foundation labour' });
  ins(A.user.id, { amountPaise: 1000000, txDate: '2026-06-01', byUserId: A.user.id, ledgerCode: 'CUSTOM', ledgerCustomName: 'Scaffolding', reason: 'monthly rent' });
  ins(A.user.id, { amountPaise: 5000, txDate: '2026-06-05', byUserId: A.user.id, ledgerCode: '9.0', reason: 'wiring bits', deletedAt: "2026-06-06 00:00:00" });
});

test('no filter → all live rows, total = 4, filtered=false (soft-deleted excluded)', async () => {
  const r = await search(A.cookie, '');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.entries.length, 4);
  assert.strictEqual(r.json.total, 4);
  assert.strictEqual(r.json.filtered, false);
});

test('text search spans remark AND custom names, case-insensitive', async () => {
  assert.deepStrictEqual(reasons((await search(A.cookie, 'q=cement')).json), ['Cement bags']); // reason, case-insensitive
  assert.deepStrictEqual(reasons((await search(A.cookie, 'q=SCAFFOLD')).json), ['monthly rent']); // matches ledger_custom_name
  const none = (await search(A.cookie, 'q=nonexistentxyz')).json;
  assert.strictEqual(none.entries.length, 0);
  assert.strictEqual(none.total, 4);       // total is the UNFILTERED count even when nothing matches
  assert.strictEqual(none.filtered, true);
});

test('ledger + sub-ledger equality', async () => {
  assert.strictEqual((await search(A.cookie, 'ledger=4.0')).json.entries.length, 2);
  assert.deepStrictEqual(reasons((await search(A.cookie, 'ledger=4.0&subledger=4.2')).json), ['Cement bags']);
  assert.deepStrictEqual(reasons((await search(A.cookie, 'ledger=CUSTOM')).json), ['monthly rent']);
});

test('amount range (rupees → paise)', async () => {
  assert.deepStrictEqual(reasons((await search(A.cookie, 'min=1000')).json), ['Foundation labour', 'monthly rent']); // ≥ ₹1000
  assert.deepStrictEqual(reasons((await search(A.cookie, 'max=1000')).json), ['Cement bags', 'Steel rods']);         // ≤ ₹1000
  assert.deepStrictEqual(reasons((await search(A.cookie, 'min=500&max=2000')).json), ['Foundation labour', 'Steel rods']);
});

test('date range (inclusive)', async () => {
  assert.deepStrictEqual(reasons((await search(A.cookie, 'start=2026-02-01&end=2026-03-31')).json), ['Foundation labour', 'Steel rods']);
});

test('composed filters AND together', async () => {
  // ledger 4.0 AND from Feb → only Steel rods (Cement bags is Jan 10, excluded).
  assert.deepStrictEqual(reasons((await search(A.cookie, 'ledger=4.0&start=2026-02-01')).json), ['Steel rods']);
  // text AND ledger.
  assert.deepStrictEqual(reasons((await search(A.cookie, 'q=labour&ledger=5.0')).json), ['Foundation labour']);
});

test('bad filters are rejected with 400', async () => {
  assert.strictEqual((await search(A.cookie, 'start=nope')).status, 400);
  assert.strictEqual((await search(A.cookie, 'min=500&max=100')).status, 400); // min > max
  assert.strictEqual((await search(A.cookie, 'min=-5')).status, 400);
});

// The other half of this test (verifying B's own search over an "as B" HTTP request) is removed:
// Phase 1.6 (single-owner auth) removed login, so there is no second live identity to request as.
// skipped: needs two users; tenancy is removed in Phase 2.
test.skip('A’s filters never surface another household’s rows (B’s decoy row stays out)', async () => {
  // Tenant B: one row that would MATCH several of A's filters — to prove isolation.
  ins(B.user.id, { amountPaise: 999, txDate: '2026-02-20', byUserId: B.user.id, ledgerCode: '4.0', reason: 'cement secret' });
  assert.strictEqual((await search(A.cookie, 'q=secret')).json.entries.length, 0);
  assert.strictEqual((await search(A.cookie, 'ledger=4.0')).json.entries.length, 2); // A's two only, not B's
});

test('filtered edit-mode save touches ONLY the rows it is given (not rows outside the filter)', async () => {
  // Fetch the ledger=4.0 subset, edit ONE of them via batch, and confirm rows OUTSIDE the filter are untouched.
  const subset = (await search(A.cookie, 'ledger=4.0')).json.entries;
  const target = subset.find((e) => e.reason === 'Cement bags');
  const outside = (await search(A.cookie, 'ledger=5.0')).json.entries[0]; // Foundation labour — not in the filter
  const beforeOutside = H.db.prepare('SELECT amount_paise, updated_at FROM cash_out WHERE id = ?').get(outside.id);

  const res = await H.post('/api/cash-out/batch', { rows: [{ id: target.id, amountRupees: '123.45', txDate: target.txDate, byType: 'user', byUserId: A.user.id, ledgerCode: '4.0', subledgerCode: '4.2', contractScope: 'extra' }] }, { cookie: A.cookie });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.saved, 1);

  assert.strictEqual(H.db.prepare('SELECT amount_paise FROM cash_out WHERE id = ?').get(target.id).amount_paise, 12345); // changed
  const afterOutside = H.db.prepare('SELECT amount_paise, updated_at FROM cash_out WHERE id = ?').get(outside.id);
  assert.deepStrictEqual(afterOutside, beforeOutside); // the out-of-filter row is byte-for-byte untouched
});
