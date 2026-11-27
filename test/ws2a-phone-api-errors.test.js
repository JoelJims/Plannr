// Q16 (docs/security-quality-review-2026-11-21.md): the phone's API (public/local-api.js) answers
// errors and route params the way server.js does:
// - a route param is URL-decoded before the handler sees it; a malformed one gets 400;
// - an error that carries a status (core/host.js hostError, e.g. 409) keeps it, with the message
//   server.js's error handler gives ("Invalid request." below 500, "Something went wrong." from 500).
// run-tests.js runs this file against both server.js and the phone code.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const shimTarget = H.TARGET === 'shim' ? require('./shim-target') : null;
let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });

test('Q16: a URL-encoded route param is decoded before the route reads it', async () => {
  // cash%5Fout is cash_out: a known table, so the answer is "not found", not "Unknown table".
  const r = await H.post('/api/trash/cash%5Fout/999999/restore', undefined, { cookie });
  assert.strictEqual(r.status, 404, JSON.stringify(r.json));
  assert.strictEqual(r.json.error, 'That deleted item was not found.');
});

test('Q16: a malformed URL-encoded route param gets 400, not 500', async () => {
  const r = await H.post('/api/trash/%E0%A4/1/restore', undefined, { cookie });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.strictEqual(r.json.error, 'Invalid request.');
});

test('Q16: an error that carries a status keeps it; a plain error is a 500', { skip: !shimTarget && "phone code only: server.js's error handler is the reference" }, async () => {
  const { routes } = shimTarget.wiring();
  const add = (path, err) => routes.unshift({ method: 'GET', path, regex: new RegExp(`^${path}$`), paramNames: [], handler: () => { throw err; } });
  add('/api/ws2a-conflict', Object.assign(new Error('busy'), { status: 409 }));
  add('/api/ws2a-status-code', Object.assign(new Error('bad'), { statusCode: 422 }));
  add('/api/ws2a-plain', new Error('boom'));
  try {
    const conflict = await H.get('/api/ws2a-conflict', { cookie });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.json.error, 'Invalid request.');
    const statusCode = await H.get('/api/ws2a-status-code', { cookie });
    assert.strictEqual(statusCode.status, 422);
    const plain = await H.get('/api/ws2a-plain', { cookie });
    assert.strictEqual(plain.status, 500);
    assert.strictEqual(plain.json.error, 'Something went wrong.');
  } finally {
    routes.splice(0, 3);
  }
});
