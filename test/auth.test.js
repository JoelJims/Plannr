// Auth negatives — this group is why the suite exists. Uses REAL bcrypt (seeded hash + real login).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.app._resetAuthLimits(); }); // clear per-IP + per-(ip,user) limiter state between cases

let seq = 0;
const freshUser = () => H.seedUser({ username: `auth${++seq}_${Date.now()}` });

test('wrong password returns 401', async () => {
  const u = freshUser();
  const r = await H.post('/api/login', { username: u.username, password: 'WrongPass999' });
  assert.strictEqual(r.status, 401);
});

test('wrong username returns 401', async () => {
  const r = await H.post('/api/login', { username: 'nobody_' + Date.now(), password: 'whatever123' });
  assert.strictEqual(r.status, 401);
});

test('wrong password and wrong username take comparable time (timing equalizer, no enumeration leak)', async () => {
  const u = freshUser();
  const time = async (body) => { const t = process.hrtime.bigint(); await H.post('/api/login', body); return Number(process.hrtime.bigint() - t) / 1e6; };
  const wp = (await time({ username: u.username, password: 'x' }) + await time({ username: u.username, password: 'y' })) / 2;
  const wu = (await time({ username: 'ghostA' + Date.now(), password: 'x' }) + await time({ username: 'ghostB' + Date.now(), password: 'y' })) / 2;
  // Both must run a real bcrypt (wrong-user hits DUMMY_HASH), so neither is instant, and neither is
  // dramatically faster than the other. A broken equalizer makes wrong-user ~0ms.
  assert.ok(wp > 50 && wu > 50, `both should run bcrypt (~200ms): wrong-pw ${wp.toFixed(0)}ms, wrong-user ${wu.toFixed(0)}ms`);
  const ratio = wu / wp;
  assert.ok(ratio > 0.5 && ratio < 2.0, `comparable timing: wrong-pw ${wp.toFixed(0)}ms vs wrong-user ${wu.toFixed(0)}ms (ratio ${ratio.toFixed(2)})`);
});

test('brute-force lockout fires at 5 failures with its own message', async () => {
  const u = freshUser();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push(await H.post('/api/login', { username: u.username, password: 'WrongPass999' }));
  for (let i = 0; i < 5; i++) assert.strictEqual(codes[i].status, 401, `attempt ${i + 1} should be 401`);
  assert.strictEqual(codes[5].status, 429, '6th attempt should be 429 lockout');
  assert.match(codes[5].json.error, /paused/i);
});

test('IP rate limiter fires with a distinct message', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await H.post('/api/login', { username: 'user' + i + '_' + Date.now(), password: 'x' }); // distinct users -> never lockout
  assert.strictEqual(last.status, 429, '11th request should hit the IP rate limit');
  assert.match(last.json.error, /Too many attempts/i);
  assert.doesNotMatch(last.json.error, /paused/i, 'rate-limit message is distinct from the lockout message');
});

test('a session whose expires_at is in the past returns 401', async () => {
  const u = freshUser();
  const cookie = H.seedSession(u.id);
  assert.strictEqual((await H.get('/api/me', { cookie })).status, 200, 'valid session works');
  const tokenHash = require('node:crypto').createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  H.db.prepare("UPDATE sessions SET expires_at = datetime('now','-1 day') WHERE token_hash = ?").run(tokenHash);
  assert.strictEqual((await H.get('/api/me', { cookie })).status, 401, 'expired session rejected');
});

test('change-password sets a working password, rejects the old one, and invalidates sessions', async () => {
  const u = freshUser();
  const li = await H.login(u.username, H.SEED_PW);
  assert.strictEqual(li.status, 200);
  const NEW = 'NewPass456!';
  const cp = await H.post('/api/change-password', { currentPassword: H.SEED_PW, newPassword: NEW, confirmPassword: NEW }, { cookie: li.cookie });
  assert.strictEqual(cp.status, 200, JSON.stringify(cp.json));
  assert.strictEqual((await H.get('/api/me', { cookie: li.cookie })).status, 401, 'old session invalidated');
  assert.strictEqual((await H.login(u.username, H.SEED_PW)).status, 401, 'old password rejected');
  assert.strictEqual((await H.login(u.username, NEW)).status, 200, 'new password works');
});
