// Manual test-send cooldown (cooldown.js + the /api/daily-report/test route, server.js ~1957-1974).
// Unit: makeCooldown's remaining/arm/clear. Route: the no-recipients path releases the cooldown (a
// following attempt is NOT 429), and a successful send arms it (an immediate repeat is 429).
//
// NOTE on the 429 arming test: under PLANNR_TEST makeTransport() is null, so sendEmail can NEVER return
// {ok:true} — with recipients configured it returns {ok:false,error} and the route CLEARS the cooldown
// (502 path). The arm-on-success -> 429 behaviour is therefore only reachable when the send succeeds, so
// that one test stubs dailyReport.sendEmail to stand in for a working transport (no real send happens;
// the stub returns synchronously). Everything else is exercised against the real route unmodified.
const H = require('./helpers');
const { makeCooldown } = require('../cooldown');
const dr = require('../daily-report');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

test('makeCooldown: remaining()===0, then >0 after arm(), then 0 after clear()', () => {
  const c = makeCooldown(10000);
  assert.strictEqual(c.remaining('k'), 0, 'fresh key -> allowed now');
  c.arm('k');
  const r = c.remaining('k');
  assert.ok(r > 0 && r <= 10000, `armed -> a positive remaining within the window, got ${r}`);
  c.clear('k');
  assert.strictEqual(c.remaining('k'), 0, 'cleared -> allowed again');
});

test('route: NO recipients returns 400 and leaves the cooldown CLEAR (a following attempt is not 429)', async () => {
  const { cookie } = H.seedLoggedIn(); // fresh session -> its own cooldown key; no recipients configured
  const first = await H.post('/api/daily-report/test', {}, { cookie });
  assert.strictEqual(first.status, 400, JSON.stringify(first.json));
  assert.match(first.json.error, /Add at least one recipient/);
  // The 429 check runs BEFORE sendEmail, so a second no-recipient POST returning 400 (not 429) proves
  // the first attempt released the cooldown rather than leaving it armed.
  const second = await H.post('/api/daily-report/test', {}, { cookie });
  assert.strictEqual(second.status, 400, `a genuine first use must not be penalised; got ${second.status}: ${JSON.stringify(second.json)}`);
  assert.match(second.json.error, /Add at least one recipient/);
});

test('route: a successful send arms the cooldown; an immediate second POST is 429', async () => {
  const { cookie } = H.seedLoggedIn();
  await H.put('/api/daily-report', { recipients: ['someone@gmail.com'], sendTimes: ['09:00'] }, { cookie });
  const orig = dr.sendEmail;
  dr.sendEmail = async () => ({ ok: true, sent: 1 }); // stand in for a working transport (inert; no real send)
  try {
    const first = await H.post('/api/daily-report/test', {}, { cookie });
    assert.strictEqual(first.status, 200, JSON.stringify(first.json));
    assert.strictEqual(first.json.ok, true);
    const second = await H.post('/api/daily-report/test', {}, { cookie });
    assert.strictEqual(second.status, 429, `an immediate repeat within the window must be 429; got ${second.status}`);
    assert.match(second.json.error, /wait \d+s/i);
  } finally {
    dr.sendEmail = orig; // restore so nothing else in this process sees the stub
  }
});
