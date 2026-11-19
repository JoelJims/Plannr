// The people routes (core/routes/people.js) and the "By" user check the cash-in and cash-out routes
// make (ctx.userExists), in both passes (server.js and the phone's public/local-api.js).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const plain = (rows) => rows.map((r) => ({ ...r }));

test('people: /api/me is the owner (the lowest id); /api/users lists only id and display name, by id', async () => {
  const owner = H.seedUser({ username: 'owner1', displayName: 'Owner One' });
  const second = Number(H.db.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('second', 'Second Person', 'x')").run().lastInsertRowid);
  try {
    const me = await H.get('/api/me');
    assert.strictEqual(me.status, 200);
    assert.deepStrictEqual({ ...me.json.user }, { id: owner.id, username: owner.username, displayName: owner.displayName });
    const users = await H.get('/api/users');
    assert.strictEqual(users.status, 200);
    assert.deepStrictEqual(plain(users.json.users), [
      { id: owner.id, displayName: owner.displayName },
      { id: second, displayName: 'Second Person' },
    ], 'never the username or the password hash');
  } finally {
    H.db.prepare('DELETE FROM users WHERE id = ?').run(second);
  }
});

test('"By" a user: a real user is accepted on cash in and cash out; an unknown one is refused and nothing is saved', async () => {
  const owner = H.seedUser();
  const count = (t) => H.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const cashIn = (byUserId) => H.post('/api/cash-in', { amountRupees: '100', txDate: '2026-07-01', byType: 'user', byUserId });
  const cashOut = (byUserId) => H.post('/api/cash-out', { amountRupees: '100', txDate: '2026-07-01', byType: 'user', byUserId, ledgerCode: '1.0', subledgerCode: '', contractScope: 'extra' });
  for (const [table, add] of [['cash_in', cashIn], ['cash_out', cashOut]]) {
    for (const bad of [owner.id + 1000, 'x']) {
      const r = await add(bad);
      assert.strictEqual(r.status, 400, `${table} by user ${bad}`);
      assert.strictEqual(r.json.error, 'The selected user does not exist.');
    }
    assert.strictEqual(count(table), 0, `${table}: nothing saved for an unknown user`);
    const ok = await add(owner.id);
    assert.strictEqual(ok.status, 201, `${table}: ${JSON.stringify(ok.json)}`);
    assert.strictEqual(H.db.prepare(`SELECT by_user_id FROM ${table}`).get().by_user_id, owner.id);
  }
});
