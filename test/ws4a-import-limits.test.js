// Q10 (review 2026-11-21), the owner's decision of 2026-11-28: a JSON backup import checks the same
// amount limits as a typed amount (core/parsers.js). Any amount over its limit refuses the WHOLE file
// with a 400 that names the bad rows, before the safety snapshot and before any write, so nothing
// changes. Single entries (cash in, cash out, contractor payments) may be at most MAX_AMOUNT_PAISE;
// totals (the budget, a loan, a contract's reference amount, total and rate, an allowance's cap and
// rate) at most MAX_TOTAL_PAISE. A value exactly at its limit imports; one paisa over is refused.
// The routes run on both test passes (desktop and phone code).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const imp = (rel) => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const clone = (o) => JSON.parse(JSON.stringify(o));
let P, BF; // core/parsers.js, backup-format.js
let good; // a real export of the seeded database: it imports cleanly

// A safety snapshot is a file beside the database on the dev server, and a download in the phone code
// running outside the app (safety-snapshots.js downloadJson clicks a link it makes).
let downloads = 0;
const snapshotsWritten = () => (H.TARGET === 'shim'
  ? downloads
  : fs.readdirSync(path.dirname(H.TEST_DB)).filter((f) => /^auto-snapshot-before-import-.*\.json$/.test(f)).length);

// Every table the import replaces, row by row, and the row counts.
const dumpAll = () => Object.fromEntries(BF.BACKUP_TABLES.map((t) => [t, H.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map((r) => ({ ...r }))]));
const counts = (dump) => Object.fromEntries(Object.entries(dump).map(([t, rows]) => [t, rows.length]));

before(async () => {
  await H.startApp();
  P = await imp('core/parsers.js');
  BF = await imp('backup-format.js');
  if (H.TARGET === 'shim') {
    const make = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => { if (tag === 'a') downloads++; return make(tag); };
  }
  H.seedLoggedIn();
  const cid = H.seedContract({ contractorName: 'ACME Builders', dateSigned: '2026-07-01' });
  H.seedPayment({ contractId: cid, payDate: '2026-07-10' });
  H.seedCashOut({ txDate: '2026-07-12' });
  H.db.prepare("UPDATE cash_in SET tx_date = '2026-07-05' WHERE id = ?").run(H.seedCashIn());
  H.db.prepare("INSERT INTO loans (amount_paise, bank_name, interest_rate, tenure) VALUES (500000000, 'Example Co-op Bank', 8.5, '10 years')").run();
  H.db.prepare("INSERT INTO contract_allowances (contract_id, name, cap_kind, cap_paise) VALUES (?, 'Tiles', 'lump', 2000000)").run(cid);
  H.db.prepare("INSERT INTO contract_allowances (contract_id, name, cap_kind, cap_rate_per_sqft_paise, area_milli_sqft) VALUES (?, 'Paint', 'per_sqft', 5000, 1000000)").run(cid);
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', '900000000') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  good = (await H.get('/api/backup/export?includeContacts=1')).json;
  for (const t of ['cash_in', 'cash_out', 'contractor_payments', 'loans', 'contract', 'contract_allowances']) {
    assert.ok(good.tables[t].length >= 1, `the export has a ${t} row`);
  }
});
after(async () => { await H.stopApp(); });

const E = () => P.MAX_AMOUNT_PAISE;
const T = () => P.MAX_TOTAL_PAISE;
const budgetRow = (b) => b.tables.settings.find((s) => s.key === 'budget_paise');
const allowance = (b, name) => b.tables.contract_allowances.find((a) => a.name === name);
// Every amount the import checks: [label, set it on a backup to a value, read it back from the database, limit].
const FIELDS = [
  ['cash in', (b, v) => { b.tables.cash_in[0].amount_paise = v; }, () => H.db.prepare('SELECT amount_paise AS v FROM cash_in').get().v, E],
  ['cash out', (b, v) => { b.tables.cash_out[0].amount_paise = v; }, () => H.db.prepare('SELECT amount_paise AS v FROM cash_out').get().v, E],
  ['contractor payment', (b, v) => { b.tables.contractor_payments[0].amount_paise = v; }, () => H.db.prepare('SELECT amount_paise AS v FROM contractor_payments').get().v, E],
  ['budget', (b, v) => { budgetRow(b).value = String(v); }, () => Number(H.db.prepare("SELECT value AS v FROM settings WHERE key = 'budget_paise'").get().v), T],
  ['loan', (b, v) => { b.tables.loans[0].amount_paise = v; }, () => H.db.prepare('SELECT amount_paise AS v FROM loans').get().v, T],
  ['contract reference amount', (b, v) => { b.tables.contract[0].amount_paise = v; }, () => H.db.prepare('SELECT amount_paise AS v FROM contract').get().v, T],
  ['contract total', (b, v) => { b.tables.contract[0].price_of_contract_paise = v; }, () => H.db.prepare('SELECT price_of_contract_paise AS v FROM contract').get().v, T],
  ['contract rate', (b, v) => { b.tables.contract[0].rate_per_sqft_paise = v; }, () => H.db.prepare('SELECT rate_per_sqft_paise AS v FROM contract').get().v, T],
  ['allowance cap', (b, v) => { allowance(b, 'Tiles').cap_paise = v; }, () => H.db.prepare("SELECT cap_paise AS v FROM contract_allowances WHERE name = 'Tiles'").get().v, T],
  ['allowance rate', (b, v) => { allowance(b, 'Paint').cap_rate_per_sqft_paise = v; }, () => H.db.prepare("SELECT cap_rate_per_sqft_paise AS v FROM contract_allowances WHERE name = 'Paint'").get().v, T],
];

// POST a backup that must be refused: 400, nothing changed, no snapshot. Returns the message.
async function refused(backup) {
  const before = dumpAll();
  const snaps = snapshotsWritten();
  const r = await H.post('/api/backup/import', backup);
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.strictEqual(typeof r.json.error, 'string');
  const now = dumpAll();
  assert.deepStrictEqual(counts(now), counts(before), 'the row counts are unchanged');
  assert.deepStrictEqual(now, before, 'every row is unchanged');
  assert.strictEqual(snapshotsWritten(), snaps, 'no safety snapshot was written');
  return r.json.error;
}

test('Q10: over-limit amounts in several lists are named, and nothing changes', async () => {
  const bad = clone(good);
  const c = bad.tables.contract[0];
  bad.tables.cash_in[0].amount_paise = E() + 1;
  bad.tables.cash_out[0].amount_paise = E() + 1;
  bad.tables.cash_out[0].deleted_at = '2026-07-20 10:00:00';
  bad.tables.contractor_payments[0].amount_paise = E() + 50000;
  bad.tables.loans[0].amount_paise = T() + 1;
  c.price_of_contract_paise = T() + 1;
  allowance(bad, 'Tiles').cap_paise = T() + 1;
  budgetRow(bad).value = String(T() + 1);
  const msg = await refused(bad);
  const id = (t) => bad.tables[t][0].id;
  const rowOf = (t, r) => bad.tables[t].indexOf(r) + 1;
  const tiles = allowance(bad, 'Tiles');
  assert.strictEqual(msg, [
    "This backup was not imported: 7 amounts in it are over Plannr's limits. Nothing was changed.",
    `• Cash Inflow (cash_in row 1, id ${id('cash_in')}), 05/07/26: ₹1,00,00,000.01 is over the ₹1,00,00,000 limit for one entry.`,
    `• Cash Outflow (cash_out row 1, id ${id('cash_out')}), 12/07/26, in the Recycle Bin: ₹1,00,00,000.01 is over the ₹1,00,00,000 limit for one entry.`,
    `• Contractor Payments (contractor_payments row 1, id ${id('contractor_payments')}), 10/07/26: ₹1,00,00,500.00 is over the ₹1,00,00,000 limit for one entry.`,
    `• Loan Details (loans row 1, id ${id('loans')}), Example Co-op Bank: ₹10,00,00,00,000.01 is over the ₹10,00,00,00,000 limit for totals.`,
    `• Contract Details (contract row 1, id ${c.id}), ACME Builders, 01/07/26: Total contract value ₹10,00,00,00,000.01 is over the ₹10,00,00,00,000 limit for totals.`,
    `• Allowances (contract_allowances row ${rowOf('contract_allowances', tiles)}, id ${tiles.id}), Tiles: Cap ₹10,00,00,00,000.01 is over the ₹10,00,00,00,000 limit for totals.`,
    '• Budget (settings, budget_paise): ₹10,00,00,00,000.01 is over the ₹10,00,00,00,000 limit for totals.',
    'Correct these amounts in the file, then import it again.',
  ].join('\n'));
});

test('Q10: every checked amount imports when it is exactly at its limit', async () => {
  const atLimit = clone(good);
  for (const [, set, , limit] of FIELDS) set(atLimit, limit());
  const snaps = snapshotsWritten();
  const r = await H.post('/api/backup/import', atLimit);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(snapshotsWritten(), snaps + 1, 'the import wrote its safety snapshot (the counter works)');
  for (const [label, , read, limit] of FIELDS) assert.strictEqual(read(), limit(), label);
});

test('Q10: one paisa over the limit is refused, for each checked amount on its own', async () => {
  for (const [label, set, , limit] of FIELDS) {
    const bad = clone(good);
    set(bad, limit() + 1);
    const msg = await refused(bad);
    assert.match(msg, /^This backup was not imported: 1 amount in it is over Plannr's limits\. Nothing was changed\.\n• /, label);
    assert.strictEqual(msg.split('\n').length, 3, `${label}: the header, one row and what to do`);
    assert.ok(msg.includes(P.fmtRs(limit() + 1)), `${label}: the amount, in rupees: ${msg}`);
    assert.ok(msg.includes(`₹${(limit() / 100).toLocaleString('en-IN')} limit for ${limit === E ? 'one entry' : 'totals'}.`), `${label}: which limit: ${msg}`);
  }
});

test('Q10: at most 10 rows are named, then how many more', async () => {
  const bad = clone(good);
  const row = bad.tables.cash_out[0];
  bad.tables.cash_out = Array.from({ length: 13 }, (_, i) => ({ ...row, id: 1000 + i, amount_paise: E() + 1 + i }));
  const lines = (await refused(bad)).split('\n');
  assert.strictEqual(lines[0], "This backup was not imported: 13 amounts in it are over Plannr's limits. Nothing was changed.");
  assert.strictEqual(lines.filter((l) => l.startsWith('• ')).length, 10);
  assert.match(lines[1], /^• Cash Outflow \(cash_out row 1, id 1000\), 12\/07\/26: ₹1,00,00,000\.01 is over/);
  assert.match(lines[10], /^• Cash Outflow \(cash_out row 10, id 1009\), 12\/07\/26: ₹1,00,00,000\.10 is over/);
  assert.deepStrictEqual(lines.slice(11), ['…and 3 more.', 'Correct these amounts in the file, then import it again.']);
});

test('Q10: a per-square-foot allowance\'s rate x area is not checked (the owner\'s decision)', async () => {
  const b = clone(good);
  const paint = allowance(b, 'Paint');
  paint.cap_rate_per_sqft_paise = T();      // at the limit for a rate
  paint.area_milli_sqft = 1000 * 1000000;   // a million sq ft: rate x area is far over the totals limit
  const r = await H.post('/api/backup/import', b);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
});

test('Q10: a backup within the limits still imports as before', async () => {
  const r = await H.post('/api/backup/import', clone(good));
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
});
