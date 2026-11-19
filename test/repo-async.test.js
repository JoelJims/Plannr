// Step 1.4 B10-B12: repo.js moves to the async database interface (core/db-adapter.js), one group
// per part, and every caller awaits it. This file checks the converted groups themselves: each call
// answers with a Promise, a multi-row write is still one transaction, and the in-memory ledger list
// (core/ledger-index.js) cannot be read before its first refresh. The routes over them are covered by
// the route tests, in both passes.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
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

test('B11: every repo.contract function answers with a Promise', async () => {
  H.clearLedger();
  const cid = H.seedContract();
  const allowance = { name: 'B11 cap', cap_kind: 'lump', cap_paise: 100000, cap_rate_per_sqft_paise: null, area_milli_sqft: null, sort_order: 0 };
  let sid = null;
  let aid = null;
  // The two inserts keep their row id for the calls after them; the Promise itself is what is checked.
  const keepId = (answer, set) => { answer.then((r) => set(r.lastInsertRowid), () => {}); return answer; };
  const calls = {
    list: () => repo.contract.list(),
    getLive: () => repo.contract.getLive(cid),
    existsLive: () => repo.contract.existsLive(cid),
    liveCount: () => repo.contract.liveCount(),
    deletedAt: () => repo.contract.deletedAt(cid),
    update: () => repo.contract.update(cid, ['area_of_work'], ['B11 area']),
    payDatesFor: () => repo.contract.payDatesFor(cid),
    writePayDates: () => repo.contract.writePayDates(cid, ['2026-08-01', '2026-09-01']),
    servicesFor: () => repo.contract.servicesFor(cid),
    insertService: () => keepId(repo.contract.insertService(cid, 'B11 service'), (id) => { sid = id; }),
    serviceLive: () => repo.contract.serviceLive(sid),
    serviceForContract: () => repo.contract.serviceForContract(cid, sid),
    updateService: () => repo.contract.updateService(sid, 'B11 service renamed'),
    serviceLinkable: () => repo.contract.serviceLinkable(sid),
    serviceClaimedByOther: () => repo.contract.serviceClaimedByOther(sid, -1),
    softDeleteService: () => repo.contract.softDeleteService(sid),
    livePaymentsFor: () => repo.contract.livePaymentsFor(cid),
    paymentOnDate: () => repo.contract.paymentOnDate(cid, '2026-08-01'),
    paymentsForAny: () => repo.contract.paymentsForAny(cid),
    paymentContractId: () => repo.contract.paymentContractId(1),
    cashOutReferencingServices: () => repo.contract.cashOutReferencingServices(cid),
    cashOutServiceId: () => repo.contract.cashOutServiceId(1),
    nextAllowanceOrder: () => repo.contract.nextAllowanceOrder(cid),
    insertAllowance: () => keepId(repo.contract.insertAllowance(cid, allowance), (id) => { aid = id; }),
    allowancesFor: () => repo.contract.allowancesFor(cid),
    allowanceLive: () => repo.contract.allowanceLive(aid),
    allowanceLinkable: () => repo.contract.allowanceLinkable(aid),
    allowanceForContract: () => repo.contract.allowanceForContract(cid, aid),
    allowanceCount: () => repo.contract.allowanceCount(cid),
    allowanceSpendFor: () => repo.contract.allowanceSpendFor(cid),
    updateAllowance: () => repo.contract.updateAllowance(aid, { ...allowance, cap_paise: 200000 }),
    softDeleteAllowance: () => repo.contract.softDeleteAllowance(aid),
    cashOutReferencingAllowances: () => repo.contract.cashOutReferencingAllowances(cid),
    softDelete: () => repo.contract.softDelete(cid),
    insert: () => repo.contract.insert(['contractor_name', 'area_of_work', 'ledger_code'], ['B11', 'B11 area', '5.0']),
  };
  assert.deepStrictEqual(Object.keys(calls).sort(), Object.keys(repo.contract).sort(), 'every function is checked');
  for (const [name, call] of Object.entries(calls)) {
    const answer = call();
    assert.ok(answer instanceof Promise, `contract.${name} returns a Promise`);
    await answer;
  }
  assert.ok(Number.isInteger(sid) && Number.isInteger(aid), 'the inserts answered with their row ids');
  // What the calls did, read back directly: they ran, in order, on this file's database.
  assert.deepStrictEqual(H.db.prepare('SELECT pay_date FROM contract_payment_dates WHERE contract_id = ? ORDER BY pay_date').all(cid).map((r) => r.pay_date), ['2026-08-01', '2026-09-01']);
  assert.strictEqual(H.db.prepare('SELECT name FROM contract_services WHERE id = ?').get(sid).name, 'B11 service renamed');
  assert.strictEqual(H.db.prepare('SELECT cap_paise FROM contract_allowances WHERE id = ?').get(aid).cap_paise, 200000);
  assert.strictEqual(H.db.prepare('SELECT COUNT(*) AS n FROM contract WHERE deleted_at IS NULL').get().n, 1, 'the first contract soft-deleted, the second inserted');
  H.clearLedger();
});

// Every database call the shared core and both backends make through repo.js or the adapter (and the
// async helpers built on them) is awaited, returned, or the body of an arrow function its caller awaits. A call left
// un-awaited answers the request before it has run, and its failure is lost (an unhandled rejection
// instead of a 500). The node:sqlite engine runs the SQL at call time, so no route test can see a
// missing await on a write whose answer is not read; this check can.
test('B12: every repo call in the core and both backends is awaited', () => {
  const ROOT = path.join(__dirname, '..');
  const files = ['server.js', 'public/local-api.js', ...fs.readdirSync(path.join(ROOT, 'core'), { recursive: true })
    .filter((f) => f.endsWith('.js')).map((f) => path.join('core', f))];
  const HELPERS = ['contractRow', 'getContractRow', 'getServiceRow', 'getLiveServiceForContract', 'getLiveAllowanceForContract',
    'writePaymentDates', 'allowanceById', 'computeOverview', 'computeUpcomingPayments', 'overviewPdfHtml', 'saveLedgerCustom',
    'validate', 'finalize', 'afterWrite', 'getBudgetPaise', 'getNotificationTimes', 'getLastExportAt', 'getBackupReminderDays',
    'getBackupReminderStatus', 'setSetting', 'getOwner', 'userExists', 'resolveBy', 'resolveCashOutBy'];
  const CALL = new RegExp(String.raw`(?:\brepo\.(?:overview|contract|ledgerCustoms|ledgers|backup)\.\w+|\brepo\.authoredCount|\brc\.\w+`
    + String.raw`|\bTRASH_REPO\[\w+\]\.\w+|\bLEDGER_CRUDS\.\w+\.\w+|\bledgerIndex\.refresh`
    + String.raw`|\bbackupFormat\.(?:buildBackup|applyBackup|assertImportOwnershipComplete)`
    + String.raw`|\b(?:adapter|tx|dbAdapter\(\))\.(?:get|all|run|exec|transaction)|\b(?:${HELPERS.join('|')}))\(`, 'g');
  const SYNC = new Set(['repo.ledgers.toCsv']); // builds text, no database
  const bad = [];
  let seen = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      if (/^\s*(\/\/|\*)/.test(raw)) return; // a comment
      const line = raw.replace(/\s\/\/.*$/, ''); // and a comment after the code
      const arrowAbove = i > 0 && /=>\s*$/.test(lines[i - 1]); // `(...) =>` with its body on this line
      for (const m of line.matchAll(CALL)) {
        if (SYNC.has(m[0].slice(0, -1))) continue;
        const before = line.slice(0, m.index);
        if (/\bfunction\s+$/.test(before)) continue; // the helper's own definition
        seen++;
        if (arrowAbove && !before.trim()) continue;
        if (!/(?:\bawait\s*\(?|\breturn\s+|=>\s*)$/.test(before)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.ok(seen > 100, `the check found the calls (${seen})`);
  assert.deepStrictEqual(bad, [], 'these calls are not awaited');
});
