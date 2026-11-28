// Cross-platform plan, step 1.2: the request checks both backends share (request-rules.js).
// run-tests.js runs this file against server.js AND against the phone's public/local-api.js, so
// each rule is pinned on both.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { BODY_LIMITS } = require('../request-rules');

before(async () => { await H.startApp(); H.seedLoggedIn(); });
after(async () => { await H.stopApp(); });

const cashInCount = () => H.db.prepare('SELECT COUNT(*) AS n FROM cash_in').get().n;
// A JSON body of exactly `bytes` bytes (ASCII only, so characters = bytes).
function bodyOfSize(bytes, fields = {}) {
  const base = JSON.stringify({ ...fields, pad: '' });
  return JSON.stringify({ ...fields, pad: 'p'.repeat(bytes - base.length) });
}

// ---- malformed JSON ----
test('a body that is not valid JSON gets 400 "Invalid request." and saves nothing', async () => {
  const n = cashInCount();
  const r = await H.post('/api/cash-in', '{"amountRupees": 5,');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'Invalid request.');
  assert.strictEqual(cashInCount(), n);
});

test('JSON that is not an object or array gets 400 "Invalid request."', async () => {
  for (const body of ['5', '"text"', 'null', 'true']) {
    const r = await H.post('/api/cash-in', body);
    assert.strictEqual(r.status, 400, body);
    assert.strictEqual(r.json.error, 'Invalid request.', body);
  }
});

test('an empty body is read as {}, so the route answers with its own validation message', async () => {
  const r = await H.post('/api/cash-in', '');
  assert.strictEqual(r.status, 400);
  assert.notStrictEqual(r.json.error, 'Invalid request.');
});

// ---- size limits, one per kind of route ----
test('normal routes: exactly 32 KB is accepted; one byte more gets the 32 KB message', async () => {
  assert.strictEqual(BODY_LIMITS.normal, 32 * 1024);
  const atLimit = await H.post('/api/cash-in', bodyOfSize(BODY_LIMITS.normal, { amountRupees: 'x' }));
  assert.notStrictEqual(atLimit.status, 413, JSON.stringify(atLimit.json));
  const over = await H.post('/api/cash-in', bodyOfSize(BODY_LIMITS.normal + 1, { amountRupees: 'x' }));
  assert.strictEqual(over.status, 413);
  assert.match(over.json.error, /too much text to save in one go \(the limit is 32 KB\)/);
  assert.doesNotMatch(over.json.error, /batch|rows/i, 'not the batch message on a normal route');
});

test('the limit counts bytes, not characters', async () => {
  // 11,000 euro signs: 11,000 characters but 33,000 bytes, over the 32 KB (32,768-byte) limit.
  const r = await H.post('/api/cash-in', JSON.stringify({ amountRupees: 1, reason: '€'.repeat(11000) }));
  assert.strictEqual(r.status, 413);
});

test('batch routes: 100 KB is accepted (over the normal limit); over 256 KB gets the batch message', async () => {
  const ok = await H.post('/api/cash-out/batch', bodyOfSize(100 * 1024, { rows: [] }));
  assert.notStrictEqual(ok.status, 413, JSON.stringify(ok.json));
  const over = await H.post('/api/cash-out/batch', bodyOfSize(BODY_LIMITS.batch + 1, { rows: [] }));
  assert.strictEqual(over.status, 413);
  assert.match(over.json.error, /save fewer rows at a time \(the batch limit is 500 rows\)/);
});

test('restoring a backup: 1 MB is accepted, over the limit (32 MB, F14) gets the backup message (JSON and encrypted)', async () => {
  for (const route of ['/api/backup/import', '/api/backup/import-encrypted']) {
    // An encrypted restore sends the whole database file as base64, far over the normal limit.
    const ok = await H.post(route, bodyOfSize(1024 * 1024, { passphrase: 'x'.repeat(12), dataBase64: 'AAAA' }));
    assert.notStrictEqual(ok.status, 413, `${route}: ${JSON.stringify(ok.json)}`);
    const over = await H.post(route, bodyOfSize(BODY_LIMITS.backup + 1, { passphrase: 'x'.repeat(12) }));
    assert.strictEqual(over.status, 413, route);
    assert.strictEqual(over.json.error, 'That backup file is too large to restore: the limit is 24 MB for an encrypted backup and 32 MB for a JSON backup.', route);
  }
});

// ---- unknown routes ----
test('an unknown /api route gets a JSON 404 that names the request', async () => {
  const r = await H.get('/api/no-such-route');
  assert.strictEqual(r.status, 404);
  assert.deepStrictEqual(r.json, { error: 'Not found: GET /api/no-such-route' });
});

test('a known /api path with a method it does not have gets the same JSON 404', async () => {
  for (const [method, path] of [['PATCH', '/api/cash-in'], ['DELETE', '/api/overview'], ['PUT', '/api/backup/export']]) {
    const r = await H.req(method, path, { body: {} });
    assert.strictEqual(r.status, 404, `${method} ${path}`);
    assert.deepStrictEqual(r.json, { error: `Not found: ${method} ${path}` });
  }
});
