// Characterization test for the Ledger List CSV routes (core/routes/ledger-list.js): the import
// replaces the whole category list, and no other node test sends it a file. This pins what it does
// today: an empty body and a bad file are refused without touching the list; a good file replaces
// the list and the in-memory copy that GET /api/ledgers serves.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let cookie;
before(async () => { await H.startApp(); ({ cookie } = H.seedLoggedIn()); });
after(async () => { await H.stopApp(); });

const listNow = async () => (await H.req('GET', '/api/ledgers', { cookie })).json.ledgers;

test('an empty body is refused', async () => {
  const r = await H.req('POST', '/api/ledgers/csv', { cookie, body: { csv: '   ' } });
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.json, { error: 'No CSV content received.' });
});

test('a bad file is refused with its row errors and the list is unchanged', async () => {
  const before = await listNow();
  const r = await H.req('POST', '/api/ledgers/csv', { cookie, body: { csv: 'Code,Main ledger,Sub-code,Sub-ledger\r\n1.5,Bad,,' } });
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.json, {
    error: '1 row(s) failed validation.',
    rowErrors: [{ row: 2, message: 'Row 2: Code "1.5" is malformed — a main ledger code must be "N.0".' }],
  });
  assert.deepStrictEqual(await listNow(), before);
});

test('the exported file, with one name changed, replaces the list', async () => {
  const before = await listNow();
  const exp = await H.req('GET', '/api/ledgers/csv', { cookie });
  assert.strictEqual(exp.status, 200);
  const csv = exp.text;
  assert.ok(csv.includes(before[0].name), 'the export holds the first main ledger name');

  const renamed = csv.split(before[0].name).join('Renamed first ledger');
  const r = await H.req('POST', '/api/ledgers/csv', { cookie, body: { csv: renamed } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  const expected = before.map((m, i) => (i === 0 ? { ...m, name: 'Renamed first ledger' } : m));
  assert.deepStrictEqual(r.json.ledgers, expected);
  assert.deepStrictEqual(await listNow(), expected);
});
