// Step 1.4 B5: init() awaits legacyInit()'s database calls through the async interface; initSync()
// (server.js, reset-db.js and seed-demo.js until B17) makes the same calls at once.
//
// Awaiting means other code can run between two calls. That is why the request queue is switched on
// in the same step: on the phone an encrypted restore runs init() inside a request (see
// test/request-queue-wiring.test.js and test-ui/backup-roundtrip.js). initSync() is the known
// positive: nothing runs in between.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const L = require('./fixtures/schema-history/lib');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-init-async-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
process.env.PLANNR_TEST = '1';
const START = new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);

// A fresh copy of db.js (a new module instance) on a new, empty database file.
let n = 0;
async function freshDbJs() {
  const file = path.join(DIR, `fresh-${++n}.db`);
  process.env.PLANNR_DB = file;
  const m = await import(`${pathToFileURL(path.join(__dirname, '..', 'db.js')).href}?fresh=${n}`);
  return { m, file };
}
// How many times other code got to run while fn was running.
async function turnsDuring(fn) {
  let turns = 0;
  let stop = false;
  const other = (async () => { while (!stop) { await null; turns++; } })();
  try { await fn(); } finally { stop = true; await other; }
  return turns;
}

test('init() awaits its database calls: other code runs between them; initSync() makes them at once', async () => {
  const a = await freshDbJs();
  const awaited = await turnsDuring(() => a.m.init());
  const b = await freshDbJs();
  const atOnce = await turnsDuring(() => b.m.initSync());
  // A new database: the converted calls include about 190 inserts of the default categories.
  assert.ok(awaited >= 40, `init(): other code ran ${awaited} times`);
  assert.ok(atOnce <= 2, `initSync(): other code ran ${atOnce} times`);
  for (const x of [a, b]) x.m.db.close();
  // And both built the same database.
  const mask = L.maskSince(START);
  assert.deepStrictEqual(L.fingerprintFile(a.file, { mask }), L.fingerprintFile(b.file, { mask }));
  assert.deepStrictEqual(L.checks(a.file), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('a failing call inside init() rejects with its error and leaves nothing half-done', async () => {
  // The default categories are seeded in one transaction: a refused insert part-way rolls it back.
  const { m, file } = await freshDbJs();
  m.db.exec('CREATE TABLE ledger_mains (code TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL, created_at TEXT, updated_at TEXT)');
  m.db.exec("CREATE TRIGGER refuse_10th BEFORE INSERT ON ledger_mains WHEN (SELECT COUNT(*) FROM ledger_mains) >= 9 BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
  await assert.rejects(m.init(), /refused by the test/);
  assert.strictEqual(m.db.prepare('SELECT COUNT(*) AS n FROM ledger_mains').get().n, 0, 'the seed was rolled back');
  assert.strictEqual(m.db.isTransaction, false, 'no transaction left open');
  m.db.exec('DROP TRIGGER refuse_10th');
  await m.init(); // the next start finishes
  assert.ok(m.db.prepare('SELECT COUNT(*) AS n FROM ledger_mains').get().n > 9);
  m.db.close();
  assert.deepStrictEqual(L.checks(file), { integrity: 'ok', foreignKeyViolations: 0 });
});
