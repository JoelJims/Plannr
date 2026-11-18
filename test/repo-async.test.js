// Step 1.4 B10-B12: repo.js moves to the async database interface (core/db-adapter.js), one group
// per part, and every caller awaits it. This file checks the converted groups themselves: each call
// answers with a Promise, a multi-row write is still one transaction, and the in-memory ledger list
// (core/ledger-index.js) cannot be read before its first refresh. The routes over them are covered by
// the route tests, in both passes.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repo = require('../repo');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

const imp = (rel) => import(pathToFileURL(path.join(__dirname, '..', rel)).href);

test('B10: overview, ledger list, custom names and authoredCount answer with Promises', async () => {
  const calls = {
    'overview.contracts': () => repo.overview.contracts(),
    'overview.paidByContract': () => repo.overview.paidByContract(),
    'overview.outsAll': () => repo.overview.outsAll(),
    'overview.outsRange': () => repo.overview.outsRange('2026-01-01', '2026-12-31'),
    'overview.paymentsAll': () => repo.overview.paymentsAll(),
    'overview.paymentsRange': () => repo.overview.paymentsRange('2026-01-01', '2026-12-31'),
    'overview.loansSum': () => repo.overview.loansSum(),
    'overview.outsSince': () => repo.overview.outsSince('2026-01-01 00:00:00'),
    'ledgerCustoms.list': () => repo.ledgerCustoms.list(),
    'ledgerCustoms.save': () => repo.ledgerCustoms.save('B10 test name'),
    'ledgerCustoms.remove': () => repo.ledgerCustoms.remove('B10 test name'),
    'ledgers.list': () => repo.ledgers.list(),
    'ledgers.usageCounts': () => repo.ledgers.usageCounts(['1.0']),
    'ledgers.validateImport': () => repo.ledgers.validateImport(''),
    authoredCount: () => repo.authoredCount(1),
  };
  for (const [name, call] of Object.entries(calls)) {
    const answer = call();
    assert.ok(answer instanceof Promise, `${name} returns a Promise`);
    await answer;
  }
  assert.ok(!(await repo.ledgerCustoms.list()).includes('B10 test name'), 'the name saved above was removed again');
  assert.strictEqual(typeof repo.ledgers.toCsv([]), 'string', 'toCsv does not touch the database and stays synchronous');
});

test('B10: ledgers.replaceAll is one transaction: a failure part-way leaves the list as it was', async () => {
  const before = await repo.ledgers.list();
  assert.ok(before.length > 1 && before[0].subLedgers.length > 0, 'the test database has the built-in ledger list');
  const mains = before.map((m) => ({ code: m.code, name: `${m.name} (renamed)` }));
  const subs = before.flatMap((m) => m.subLedgers.map((s) => ({ code: s.code, mainCode: m.code, name: s.name })));
  subs.push({ ...subs[0] }); // the last insert breaks the primary key, after every other row is written
  await assert.rejects(repo.ledgers.replaceAll(mains, subs), /UNIQUE constraint failed: ledger_subs\.code/);
  assert.deepStrictEqual(await repo.ledgers.list(), before, 'rolled back: no ledger renamed, no row lost');
});

test('B10: the ledger index cannot be read before its first refresh(); refresh() fills it from the database', async () => {
  const { createLedgerIndex } = await imp('core/ledger-index.js');
  const index = createLedgerIndex(repo);
  assert.throws(() => index.list(), /read before its first refresh\(\) finished/);
  assert.throws(() => index.byCode(), /read before its first refresh\(\) finished/);
  await index.refresh();
  const list = await repo.ledgers.list();
  assert.deepStrictEqual(index.list(), list);
  assert.deepStrictEqual([...index.byCode().keys()], list.map((l) => l.code));
});
