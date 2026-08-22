// Safety invariants — the two absolute constraints of Phase 9, asserted in-process.
const H = require('./helpers'); // FIRST require: sets PLANNR_TEST + a temp PLANNR_DB
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

test('resolved DB_PATH is NOT the live database (fails outright if it is)', () => {
  const { DB_PATH } = require('../db');
  assert.notStrictEqual(path.resolve(DB_PATH).toLowerCase(), H.LIVE_DB.toLowerCase(), `DB_PATH must not be live: ${DB_PATH}`);
  assert.ok(!/[\\/]data[\\/]plannr\.db$/i.test(DB_PATH), `DB_PATH looks live: ${DB_PATH}`);
});

test('harness: seed user + session + authed request round-trips', async () => {
  const { user, cookie } = H.seedLoggedIn();
  const me = await H.get('/api/me', { cookie });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.username, user.username);
  const anon = await H.get('/api/me');
  assert.strictEqual(anon.status, 401);
});
