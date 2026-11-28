// Characterization test for how POST /api/cash-out reads its optional service and allowance links
// (core/routes/cash-and-loans.js): a bad id is refused with its own message; a blank one is a
// valid entry with no link. Pins today's behaviour so the shared reader cannot drift.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let cookie, userId;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; userId = s.user.id; });
after(async () => { await H.stopApp(); });

const entry = (extra) => ({ amountRupees: '100.00', txDate: '2026-07-12', byType: 'user', byUserId: userId, ledgerCode: '5.0', contractScope: 'extra', ...extra });
const post = (extra) => H.req('POST', '/api/cash-out', { cookie, body: entry(extra) });

test('a service id that is not a positive whole number is refused', async () => {
  for (const bad of ['abc', -1, 0, 1.5]) {
    const r = await post({ contractServiceId: bad });
    assert.strictEqual(r.status, 400, `contractServiceId ${JSON.stringify(bad)}`);
    assert.strictEqual(r.json.error, 'Invalid service selection.');
  }
});

test('an allowance id that is not a positive whole number is refused', async () => {
  for (const bad of ['abc', -1, 0, 1.5]) {
    const r = await post({ contractAllowanceId: bad });
    assert.strictEqual(r.status, 400, `contractAllowanceId ${JSON.stringify(bad)}`);
    assert.strictEqual(r.json.error, 'Invalid allowance selection.');
  }
});

test('a blank or absent link is a valid entry with no link', async () => {
  for (const extra of [{}, { contractServiceId: '', contractAllowanceId: null }, { contractServiceId: null, contractAllowanceId: '' }]) {
    const r = await post(extra);
    assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(extra) + ' status ' + r.status);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.entry.contractServiceId, null);
    assert.strictEqual(r.json.entry.contractAllowanceId, null);
  }
});
