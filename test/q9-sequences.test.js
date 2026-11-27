// Q9: a backup's "sequences" section naming a table without an id column (settings, ledger_mains,
// ledger_subs) must be refused with a 400 before anything changes. Before the fix it passed the
// check and the restore failed with a 500 (SELECT MAX(id) on a table that has no id).
// The test database is a fresh temp file (test/helpers.js). Nothing opens data/plannr.db.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const F = require('./fixtures/full-dataset');

const written = [];
before(async () => { await H.startApp(); });
after(async () => {
  for (const rel of written) fs.rmSync(path.resolve(__dirname, '..', rel), { force: true });
  await H.stopApp();
});

test('Q9: sequences for a table without an id is a 400 that names it, and nothing changes', async () => {
  const good = (await H.get('/api/backup/export')).json;
  const before = F.dumpAll(H.db);
  for (const name of ['settings', 'ledger_mains', 'ledger_subs']) {
    const r = await H.post('/api/backup/import', { ...good, sequences: { ...(good.sequences || {}), [name]: 5 } });
    if (r.json && r.json.snapshot) written.push(r.json.snapshot);
    assert.strictEqual(r.status, 400, `${name}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, new RegExp(`sequences: ${name} has no id`));
  }
  assert.deepStrictEqual(F.dumpAll(H.db), before);
});

test('Q9: sequences for tables with an id still restore', async () => {
  const good = (await H.get('/api/backup/export')).json;
  const r = await H.post('/api/backup/import', { ...good, sequences: { ...(good.sequences || {}), cash_out: 40 } });
  if (r.json && r.json.snapshot) written.push(r.json.snapshot);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(H.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'cash_out'").get().seq, 40);
});
