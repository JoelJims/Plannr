// S2 (docs/security-quality-review-2026-11-21.md): the dev server (server.js) had no Origin check, so
// a web page open in the same browser could send body-less POSTs (mark exported, restore from the
// Recycle Bin) to it while it runs. A request that changes something (not GET/HEAD/OPTIONS) and
// carries an Origin of another site is now refused with 403. Requests from Plannr's own pages
// (same origin) and requests with no Origin (curl, the tests) go through as before.
// Dev server only: the phone has no network port (run-tests.js pass 2 skips these checks).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const devServer = H.TARGET !== 'shim';
let cookie, base;
before(async () => { ({ base } = await H.startApp()); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });

test('S2: a POST from another site\'s page is refused with 403', { skip: !devServer && 'dev server only' }, async () => {
  for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:1']) {
    const r = await H.req('POST', '/api/trash/cash_out/999999/restore', { cookie, headers: { Origin: origin } });
    assert.strictEqual(r.status, 403, `${origin}: ${JSON.stringify(r.json)}`);
  }
  const del = await H.req('DELETE', '/api/trash/cash_out/999999', { cookie, headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(del.status, 403);
});

test('S2: same-origin and Origin-less requests are unchanged; GET is not checked', { skip: !devServer && 'dev server only' }, async () => {
  const self = new URL(base).origin;
  const same = await H.req('POST', '/api/trash/cash_out/999999/restore', { cookie, headers: { Origin: self } });
  assert.strictEqual(same.status, 404, JSON.stringify(same.json));
  const none = await H.req('POST', '/api/trash/cash_out/999999/restore', { cookie });
  assert.strictEqual(none.status, 404);
  const get = await H.req('GET', '/api/trash', { cookie, headers: { Origin: 'http://evil.example' } });
  assert.notStrictEqual(get.status, 403);
});
