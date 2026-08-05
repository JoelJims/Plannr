// Part 4 (Phase 11B) — the ledger_customs REMOVAL path. Custom ledger names auto-save on first use and
// had no delete, so a typo ("Cemnt") was stuck in the dropdown forever (and the Recycle Bin doesn't
// cover ledger_customs). These prove the new DELETE /api/ledger-customs: it is tenant-scoped, idempotent,
// and denormalised — pruning the pick-list never rewrites the historical debits that used the name.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let A, B;
const add = (tenantId, name) => H.db.prepare('INSERT INTO ledger_customs (tenant_id, name) VALUES (?, ?)').run(tenantId, name);

before(async () => {
  await H.startApp();
  A = H.seedLoggedIn({ username: 'lc_alice', displayName: 'Alice' });
  B = H.seedLoggedIn({ username: 'lc_bob', displayName: 'Bob' });
  add(A.user.id, 'Cement'); add(A.user.id, 'Cemnt'); add(A.user.id, 'Steel'); // 'Cemnt' is the typo to prune
  add(B.user.id, 'Cemnt'); // Bob independently typed the same string in his OWN household
});
after(async () => { await H.stopApp(); });

test('GET lists only the caller’s custom names (per-user, sorted NOCASE)', async () => {
  const a = await H.get('/api/ledger-customs', { cookie: A.cookie });
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(a.json.customs, ['Cement', 'Cemnt', 'Steel']);
});

test('DELETE removes the caller’s name and returns the updated list; it persists', async () => {
  const r = await H.del('/api/ledger-customs?name=' + encodeURIComponent('Cemnt'), { cookie: A.cookie });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.customs, ['Cement', 'Steel'], 'typo pruned, others intact');
  const again = await H.get('/api/ledger-customs', { cookie: A.cookie });
  assert.ok(!again.json.customs.includes('Cemnt'), 'removal persisted across requests');
});

test('a delete never reaches another tenant’s list', async () => {
  // Alice already deleted HER 'Cemnt'; Bob's identically-named entry must be untouched.
  const b = await H.get('/api/ledger-customs', { cookie: B.cookie });
  assert.ok(b.json.customs.includes('Cemnt'), 'B’s same-named entry survived A’s delete');
  // Explicit cross-tenant attempt: A tries to delete a name only B has -> B keeps it.
  add(B.user.id, 'BobOnly');
  const attempt = await H.del('/api/ledger-customs?name=' + encodeURIComponent('BobOnly'), { cookie: A.cookie });
  assert.strictEqual(attempt.status, 200, 'idempotent no-op for A (A has no such name)');
  const b2 = await H.get('/api/ledger-customs', { cookie: B.cookie });
  assert.ok(b2.json.customs.includes('BobOnly'), 'A’s delete never crossed into B’s tenant');
});

test('removing a name leaves the historical debits that used it untouched', async () => {
  H.db.prepare(`INSERT INTO cash_out (amount_paise, tx_date, by_type, ledger_code, ledger_custom_name, contract_scope, tenant_id)
                VALUES (500, '2026-07-20', 'user', 'CUSTOM', 'Steel', 'extra', ?)`).run(A.user.id);
  const r = await H.del('/api/ledger-customs?name=' + encodeURIComponent('Steel'), { cookie: A.cookie });
  assert.strictEqual(r.status, 200);
  assert.ok(!r.json.customs.includes('Steel'), 'Steel pruned from the pick-list');
  const row = H.db.prepare("SELECT ledger_custom_name FROM cash_out WHERE tenant_id=? AND ledger_code='CUSTOM'").get(A.user.id);
  assert.strictEqual(row.ledger_custom_name, 'Steel', 'the past debit keeps its stored name — history not rewritten');
});

test('DELETE with no name is a 400 (nothing to remove)', async () => {
  const r = await H.del('/api/ledger-customs', { cookie: A.cookie });
  assert.strictEqual(r.status, 400);
});
