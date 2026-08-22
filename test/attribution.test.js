// Attribution (the Phase 2 corruption): "By" records who PAID, decoupled from who edits the row.
// Single-owner auth (Phase 1.6) removed login, so there is only ever ONE real users row — the
// owner. "By" still supports a non-owner payer via byType='custom' + byLabel (e.g. a relative or
// neighbour who isn't a system user), so attribution-differs-from-editor is exercised with a
// custom-labelled payer instead of a second user account.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let owner, cookie, TENANT;
before(async () => {
  await H.startApp();
  ({ user: owner, cookie } = H.seedLoggedIn());
  TENANT = owner.id;
});
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const byUserId = (id) => H.db.prepare('SELECT by_user_id FROM cash_out WHERE id = ?').get(id).by_user_id;
const amountOf = (id) => H.db.prepare('SELECT amount_paise FROM cash_out WHERE id = ?').get(id).amount_paise;
const byRow = (id) => H.db.prepare('SELECT by_type, by_user_id, by_label FROM cash_out WHERE id = ?').get(id);
const editBody = (id, amountRupees, byUId, extra) => Object.assign({ id, amountRupees, txDate: '2026-07-12', byType: 'user', byUserId: byUId, ledgerCode: '1.0', subledgerCode: '', contractScope: 'extra' }, extra || {});

test('batch editing rows with a stored custom by_label changes ZERO attributions', async () => {
  const id1 = H.seedCashOut({ amountPaise: 10000, byType: 'custom', byLabel: 'Neighbour', tenantId: TENANT });
  const id2 = H.seedCashOut({ amountPaise: 20000, byType: 'custom', byLabel: 'Neighbour', tenantId: TENANT });
  const r = await H.post('/api/cash-out/batch', { rows: [
    editBody(id1, '500.00', null, { byType: 'custom', byLabel: 'Neighbour' }),
    editBody(id2, '600.00', null, { byType: 'custom', byLabel: 'Neighbour' }),
  ] }, { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.saved, 2);
  assert.deepStrictEqual({ ...byRow(id1) }, { by_type: 'custom', by_user_id: null, by_label: 'Neighbour' }, 'attribution unchanged though the amount was edited');
  assert.strictEqual(amountOf(id1), 50000, 'the edited field DID persist');
});

test('a non-existent byUserId returns 400', async () => {
  const id = H.seedCashOut({ amountPaise: 10000, byUserId: owner.id, tenantId: TENANT });
  const r = await H.put('/api/cash-out/' + id, editBody(id, '500.00', 99999), { cookie });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /does not exist/i);
  assert.strictEqual(byUserId(id), owner.id, 'the rejected edit left the row untouched');
});

test('a stored-NULL by_user_id round-trips when another field is edited', async () => {
  const id = H.seedCashOut({ amountPaise: 10000, byType: 'user', byUserId: null, tenantId: TENANT }); // import-remapped unknown
  const r = await H.put('/api/cash-out/' + id, editBody(id, '777.00', null), { cookie });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(byUserId(id), null, 'already-NULL attribution round-trips as NULL');
  assert.strictEqual(amountOf(id), 77700, 'the other field still edited');
});

test('a deliberate reassignment (custom payer -> the real owner) persists and emits the audit line', async () => {
  const id = H.seedCashOut({ amountPaise: 10000, byType: 'custom', byLabel: 'Neighbour', tenantId: TENANT });
  const orig = console.warn; const warns = [];
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  let r;
  try { r = await H.put('/api/cash-out/' + id, editBody(id, '500.00', owner.id), { cookie }); }
  finally { console.warn = orig; }
  assert.strictEqual(r.status, 200);
  assert.strictEqual(byUserId(id), owner.id, 'reassignment to the owner persisted');
  assert.ok(warns.some((w) => new RegExp(`\\[audit\\] cash_out id=${id}: by_user_id null -> ${owner.id}`).test(w)), 'audit line emitted: ' + JSON.stringify(warns));
});
