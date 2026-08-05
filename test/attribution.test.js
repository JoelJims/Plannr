// Attribution (the Phase 2 corruption): "By" records who PAID, decoupled from who edits the row.
// Tenancy Phase 3 re-seed: Alice and Bob are BOTH in ONE tenant (the household), so cross-user
// attribution is exercised WITHIN a tenant — the behaviour is correct there, and the test proves it
// survives tenant scoping (it is NOT a cross-tenant leak). The rows live in the editor's tenant
// (tenant = Bob.id, the logged-in user); by_user_id still records who PAID (Alice), independent of
// who edits (Bob). userExists (who-paid metadata) stays global, so attributing to a fellow member is
// allowed; the ROW is what's tenant-scoped.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let userA, userB, cookieB, TENANT;
before(async () => {
  await H.startApp();
  userA = H.seedUser({ username: 'alice', displayName: 'Alice' });
  userB = H.seedUser({ username: 'bob', displayName: 'Bob' });
  cookieB = H.seedSession(userB.id); // Bob is the one logged in and editing
  TENANT = userB.id;                 // the household tenant Bob operates in (his own id, per the current model)
});
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const byUserId = (id) => H.db.prepare('SELECT by_user_id FROM cash_out WHERE id = ?').get(id).by_user_id;
const amountOf = (id) => H.db.prepare('SELECT amount_paise FROM cash_out WHERE id = ?').get(id).amount_paise;
const editBody = (id, amountRupees, byUId, extra) => Object.assign({ id, amountRupees, txDate: '2026-07-12', byType: 'user', byUserId: byUId, ledgerCode: '1.0', subledgerCode: '', contractScope: 'extra' }, extra || {});

test('batch editing rows (as Bob) with their stored by_user_id changes ZERO attributions', async () => {
  const id1 = H.seedCashOut({ amountPaise: 10000, byUserId: userA.id, tenantId: TENANT });
  const id2 = H.seedCashOut({ amountPaise: 20000, byUserId: userA.id, tenantId: TENANT });
  const r = await H.post('/api/cash-out/batch', { rows: [editBody(id1, '500.00', userA.id), editBody(id2, '600.00', userA.id)] }, { cookie: cookieB });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.saved, 2);
  assert.strictEqual(byUserId(id1), userA.id, 'attribution unchanged (still Alice) though Bob saved');
  assert.strictEqual(byUserId(id2), userA.id, 'attribution unchanged');
  assert.strictEqual(amountOf(id1), 50000, 'the edited field DID persist');
});

test('a non-existent byUserId returns 400', async () => {
  const id = H.seedCashOut({ amountPaise: 10000, byUserId: userA.id, tenantId: TENANT });
  const r = await H.put('/api/cash-out/' + id, editBody(id, '500.00', 99999), { cookie: cookieB });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /does not exist/i);
  assert.strictEqual(byUserId(id), userA.id, 'the rejected edit left the row untouched');
});

test('a stored-NULL by_user_id round-trips when another field is edited', async () => {
  const id = H.seedCashOut({ amountPaise: 10000, byType: 'user', byUserId: null, tenantId: TENANT }); // import-remapped unknown
  const r = await H.put('/api/cash-out/' + id, editBody(id, '777.00', null), { cookie: cookieB });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(byUserId(id), null, 'already-NULL attribution round-trips as NULL');
  assert.strictEqual(amountOf(id), 77700, 'the other field still edited');
});

test('a deliberate reassignment persists and emits the audit line', async () => {
  const id = H.seedCashOut({ amountPaise: 10000, byUserId: userA.id, tenantId: TENANT });
  const orig = console.warn; const warns = [];
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  let r;
  try { r = await H.put('/api/cash-out/' + id, editBody(id, '500.00', userB.id), { cookie: cookieB }); }
  finally { console.warn = orig; }
  assert.strictEqual(r.status, 200);
  assert.strictEqual(byUserId(id), userB.id, 'reassignment to Bob persisted');
  assert.ok(warns.some((w) => new RegExp(`\\[audit\\] cash_out id=${id}: by_user_id ${userA.id} -> ${userB.id}`).test(w)), 'audit line emitted: ' + JSON.stringify(warns));
});
