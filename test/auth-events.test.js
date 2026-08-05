// Part D — auth detection. Each event type recorded (never a password value); failed-count resets after
// a success; an unknown-username failure is filed to no tenant; sign-out-everywhere 401s old cookies;
// the /api/health auth section is tenant-isolated; sessions record ip + user-agent.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const PW = H.SEED_PW; // seeded users hash this password, so H.login works with real bcrypt

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });
beforeEach(() => {
  H.app._resetAuthLimits();
  H.db.exec("DELETE FROM settings WHERE key IN ('auth_events','auth_events_unknown')"); // fresh rings each test
  H.db.exec('DELETE FROM sessions');
});

function events(cookie) { return H.get('/api/sessions', { cookie }); }

test('login_success + login_failed recorded, attempted username kept, password NEVER stored', async () => {
  const u = H.seedUser();
  const bad = await H.login(u.username, 'totally-wrong-secret');
  assert.strictEqual(bad.status, 401);
  const good = await H.login(u.username, PW);
  assert.strictEqual(good.status, 200);

  const r = await events(good.cookie);
  const types = r.json.events.map((e) => e.type);
  assert.ok(types.includes('login_success'));
  assert.ok(types.includes('login_failed'));
  const failed = r.json.events.find((e) => e.type === 'login_failed');
  assert.strictEqual(failed.username, u.username);           // the attempted username IS kept
  assert.ok(failed.atIST && /IST$/.test(failed.atIST));       // IST timestamp
  // The password (or the wrong one tried) must appear NOWHERE, and no event has a password key.
  const blob = JSON.stringify(r.json);
  assert.ok(!blob.includes('totally-wrong-secret'), 'the attempted wrong password must not be stored');
  assert.ok(!blob.includes(PW), 'the real password must not be stored');
  for (const e of r.json.events) assert.ok(!('password' in e), 'no event may carry a password field');
});

test('an unknown username failure is NOT filed under any tenant’s own log', async () => {
  // (It goes to the GLOBAL enumeration ring instead — asserted in the Item-1 tests below.) Here we only
  // guard the isolation property: no per-tenant `auth_events` ring is touched by an unknown-username try.
  const before = H.db.prepare("SELECT value FROM settings WHERE key = 'auth_events'").all().map((r) => r.value).join('');
  const bad = await H.login('ghost_who_does_not_exist', 'x');
  assert.strictEqual(bad.status, 401);
  const rows = H.db.prepare("SELECT value FROM settings WHERE key = 'auth_events'").all().map((r) => r.value).join('');
  assert.strictEqual(rows, before, 'no tenant auth_events ring changed');
  assert.ok(!rows.includes('ghost_who_does_not_exist'), 'the unknown username is not in any tenant’s log');
});

test('failedSinceLastLogin counts failures since the PREVIOUS success, and resets on a clean login', async () => {
  const u = H.seedUser();
  await H.login(u.username, PW);                 // success #1
  await H.login(u.username, 'wrong1');           // fail
  await H.login(u.username, 'wrong2');           // fail
  const s2 = await H.login(u.username, PW);      // success #2
  let me = await H.get('/api/me', { cookie: s2.cookie });
  assert.strictEqual(me.json.failedSinceLastLogin, 2);       // the 2 fails between #1 and #2
  assert.ok(me.json.lastLogin && me.json.lastLogin.atIST);    // previous login shown

  const s3 = await H.login(u.username, PW);      // success #3, no fails in between
  me = await H.get('/api/me', { cookie: s3.cookie });
  assert.strictEqual(me.json.failedSinceLastLogin, 0);       // reset
});

test('a lockout event is recorded once the failure threshold is hit', async () => {
  const u = H.seedUser();
  for (let i = 0; i < 5; i++) await H.login(u.username, 'nope' + i); // LOGIN_MAX_FAILS = 5
  const s = await H.login(u.username, PW); // may be locked; wait out isn't possible in a unit test
  // Whether or not the final success got through, the ring (in settings, survives) must hold a lockout.
  const raw = H.db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'auth_events'").get(u.id);
  const ring = JSON.parse(raw.value);
  assert.ok(ring.some((e) => e.type === 'lockout'), 'a lockout event must be recorded at the threshold');
  assert.ok(ring.filter((e) => e.type === 'login_failed').length >= 5);
  for (const e of ring) assert.ok(!('password' in e));
  if (s.status === 200) { /* threshold hit exactly, then cleared — fine */ }
});

test('logout is recorded', async () => {
  const u = H.seedUser();
  const s = await H.login(u.username, PW);
  await H.post('/api/logout', {}, { cookie: s.cookie });
  // read the ring directly (the cookie is now invalid)
  const ring = JSON.parse(H.db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'auth_events'").get(u.id).value);
  assert.ok(ring.some((e) => e.type === 'logout'));
});

test('sign-out-everywhere ends all sessions — old cookies 401 afterwards', async () => {
  const u = H.seedUser();
  const a = await H.login(u.username, PW);
  const b = await H.login(u.username, PW); // a second device
  assert.strictEqual((await H.get('/api/me', { cookie: a.cookie })).status, 200);
  const out = await H.post('/api/sign-out-everywhere', {}, { cookie: a.cookie });
  assert.strictEqual(out.status, 200);
  assert.ok(out.json.cleared >= 2);
  assert.strictEqual((await H.get('/api/me', { cookie: a.cookie })).status, 401); // this device
  assert.strictEqual((await H.get('/api/me', { cookie: b.cookie })).status, 401); // the other device too
});

test('sessions record ip + user-agent', async () => {
  const u = H.seedUser();
  await H.post('/api/login', { username: u.username, password: PW }, { headers: { 'user-agent': 'PlannrTest/9.9' } });
  const row = H.db.prepare('SELECT ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC').get(u.id);
  assert.ok(row.ip && row.ip !== 'unknown', 'ip recorded: ' + row.ip);
  assert.match(row.user_agent || '', /PlannrTest\/9\.9/);
});

// ── Item 1 (follow-up) — unknown-username enumeration ring ──────────────────────────────────────────

test('unknown-username failure → GLOBAL ring (tenant 0), never a tenant log, never a password', async () => {
  const u = H.seedUser();
  const bad = await H.login('nosuchuser_zzz', 'sneaky-password-value');
  assert.strictEqual(bad.status, 401);
  // Filed under the reserved global tenant 0, key auth_events_unknown.
  const raw = H.db.prepare("SELECT value FROM settings WHERE tenant_id = 0 AND key = 'auth_events_unknown'").get();
  assert.ok(raw && raw.value, 'global unknown ring exists under tenant 0');
  const ring = JSON.parse(raw.value);
  assert.ok(ring.some((e) => e.type === 'login_failed_unknown' && e.username === 'nosuchuser_zzz'), 'attempt recorded with the attempted username');
  assert.ok(!raw.value.includes('sneaky-password-value'), 'password NEVER stored');
  for (const e of ring) assert.ok(!('password' in e));
  // NOT filed under the real user's own tenant log.
  const tenantRow = H.db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'auth_events'").get(u.id);
  assert.ok(!tenantRow || !tenantRow.value.includes('nosuchuser_zzz'), 'must not appear in any tenant’s own log');
});

test('unknown-username failures do NOT appear in /api/health (stays tenant-only)', async () => {
  const u = H.seedUser();
  await H.login('ghost_for_health_qqq', 'x');       // unknown → global ring
  const cookie = (await H.login(u.username, PW)).cookie;
  const health = await H.get('/api/health', { cookie });
  assert.strictEqual(health.status, 200);
  assert.ok(!JSON.stringify(health.json).includes('ghost_for_health_qqq'), 'the unknown username must not surface in /api/health');
  assert.ok(!('unknownLoginFailures' in (health.json.auth || {})), '/api/health carries no global unknown data');
});

test('unknown-username enumeration is surfaced (count + recent) in /api/me and /api/sessions', async () => {
  const u = H.seedUser();
  await H.login(u.username, PW);                     // success #1 → the "since" boundary
  await H.login('enumA_' + Date.now(), 'x');         // unknown
  await H.login('enumB_' + Date.now(), 'y');         // unknown
  const s2 = await H.login(u.username, PW);          // success #2
  const me = await H.get('/api/me', { cookie: s2.cookie });
  assert.ok(me.json.unknownLoginFailures.sinceLastLogin >= 2, 'Home count reflects the 2 enumeration attempts');
  const sess = await H.get('/api/sessions', { cookie: s2.cookie });
  assert.ok(sess.json.unknownLoginFailures.recent.length >= 2, 'Data page gets the recent list');
  for (const e of sess.json.unknownLoginFailures.recent) assert.ok(!('password' in e));
});

test('the global unknown ring stays bounded at 50 (like the others)', () => {
  for (let i = 0; i < 55; i++) H.app._recordUnknownLoginFailure('probe_' + i, '10.0.0.' + (i % 255));
  const ring = H.app._readUnknownLoginFailures();
  assert.strictEqual(ring.length, 50, 'ring capped at 50');
  assert.strictEqual(ring[ring.length - 1].username, 'probe_54', 'newest kept');
  assert.strictEqual(ring[0].username, 'probe_5', 'oldest dropped (55 pushed, first 5 gone)');
});

test('/api/health auth section is tenant-isolated', async () => {
  const A = H.seedUser({ username: 'alice_ae' });
  const B = H.seedUser({ username: 'bob_ae' });
  await H.login(A.username, 'wrongA1'); // a failure under A
  const bCookie = (await H.login(B.username, PW)).cookie;
  const health = await H.get('/api/health', { cookie: bCookie });
  assert.strictEqual(health.status, 200);
  const blob = JSON.stringify(health.json.auth);
  assert.ok(!blob.includes('alice_ae'), 'B\'s health must not surface A\'s attempted-username events');
  // B sees its own login_success.
  assert.ok(health.json.auth.recentEvents.some((e) => e.type === 'login_success'));
});
