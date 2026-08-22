// Phase 4 — overpaid presentation, the summary PDF composition, cash_in.tx_date, and /select-date's
// removal. The DOM-only behaviours (ledger carry-over, the overpaid UI surfaces, login→home, the
// unsaved cue) are exercised by the Playwright pass; these cover everything testable in node:test.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie, TENANT;
before(async () => { await H.startApp(); const s = H.seedLoggedIn(); cookie = s.cookie; TENANT = s.user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.clearLedger(); });

// ---- Part C1 — overpaid renders "Overpaid by", underlying value stays negative ----
test('Part C1 — owed stays NEGATIVE in computeOverview; the PDF prints "Overpaid by ₹X"', async () => {
  const cid = H.seedContract({ pricePaise: 1000000 });       // ₹10,000 contract
  H.seedPayment({ contractId: cid, amountPaise: 2000000 });   // ₹20,000 paid → overpaid by ₹10,000
  const ov = await H.get('/api/overview', { cookie });
  assert.ok(ov.json.money.owedToContractorsPaise < 0, 'underlying owed is signed (negative), never clamped');
  assert.strictEqual(ov.json.money.owedToContractorsPaise, -1000000);
  const html = H.app._overviewPdfHtml({ tenantId: TENANT, part: 'summary', theme: 'light', range: { start: null, end: null } });
  assert.match(html, /Overpaid by ₹10,000/, 'PDF owed section shows "Overpaid by ₹X"');
  assert.doesNotMatch(html, /-₹10,000/, 'no negative "-₹" owed figure in the PDF');
});

// ---- Part C2 — summary composition (scheduled/catch-up) vs full (manual) ----
test('Part C2 — summary PDF omits the transactions table but keeps the ledger rollup; full keeps it', () => {
  H.seedContract({ pricePaise: 2500000 });
  for (let i = 0; i < 5; i++) H.seedCashOut({ amountPaise: 100000, ledgerCode: '4.0', subledgerCode: '4.2' });
  const summary = H.app._overviewPdfHtml({ tenantId: TENANT, part: 'summary', theme: 'light', range: { start: null, end: null } });
  const full = H.app._overviewPdfHtml({ tenantId: TENANT, part: 'full', theme: 'light', range: { start: null, end: null } });
  assert.doesNotMatch(summary, /<h2>Transactions<\/h2>/, 'summary has NO transactions table');
  assert.match(summary, /Spending by Ledger/, 'summary keeps the ledger rollup + pie');
  assert.match(full, /<h2>Transactions<\/h2>/, 'the manual full export keeps the transactions table');
});

// ---- Part C3 — cash_in.tx_date ----
test('Part C3 — cash_in has tx_date; migration idempotent; backfill from created_at', () => {
  assert.ok(H.db.prepare('PRAGMA table_info(cash_in)').all().map((c) => c.name).includes('tx_date'), 'fresh CREATE has tx_date');
  const id = Number(H.db.prepare("INSERT INTO cash_in (amount_paise, tx_date, by_type, created_at, tenant_id) VALUES (100000, NULL, 'user', '2025-06-15 10:00:00', (SELECT MIN(id) FROM users))").run().lastInsertRowid);
  H.db.exec("UPDATE cash_in SET tx_date = date(created_at) WHERE tx_date IS NULL"); // the migration's backfill
  assert.strictEqual(H.db.prepare('SELECT tx_date FROM cash_in WHERE id=?').get(id).tx_date, '2025-06-15');
  assert.doesNotThrow(() => require('../db').init(), 're-running init() is idempotent');
});

test('Part C3 — a new inflow requires a date and round-trips; missing date is rejected', async () => {
  const ok = await H.post('/api/cash-in', { amountRupees: '5000', txDate: '2025-08-01', byType: 'relative', byLabel: 'Father' }, { cookie });
  assert.strictEqual(ok.status, 201, 'created');
  const list = await H.get('/api/cash-in', { cookie });
  assert.strictEqual(list.json.entries[0].txDate, '2025-08-01');
  const bad = await H.post('/api/cash-in', { amountRupees: '5000', byType: 'relative', byLabel: 'Father' }, { cookie });
  assert.strictEqual(bad.status, 400, 'a new inflow with no date is rejected');
});

test('Part C3 — backup export carries tx_date; a PRE-Phase-4 backup (no tx_date) still imports (dateless)', async () => {
  await H.post('/api/cash-in', { amountRupees: '5000', txDate: '2025-08-01', byType: 'relative', byLabel: 'Father' }, { cookie });
  const exp = await H.get('/api/backup/export', { cookie });
  assert.strictEqual(exp.json.tables.cash_in.find(Boolean).tx_date, '2025-08-01', 'export includes tx_date');
  const legacy = JSON.parse(JSON.stringify(exp.json));
  legacy.tables.cash_in = [{ id: 1, amount_paise: 700000, by_type: 'user', by_user_id: null, by_label: null, reason: 'legacy', created_at: '2025-01-01 00:00:00', updated_at: '2025-01-01 00:00:00', deleted_at: null }];
  const imp = await H.post('/api/backup/import', legacy, { cookie });
  assert.strictEqual(imp.status, 200, 'a backup with no cash_in.tx_date imports without error');
  const after = await H.get('/api/cash-in', { cookie });
  assert.strictEqual(after.json.entries.length, 1);
  assert.strictEqual(after.json.entries[0].txDate, null, 'the imported legacy inflow is dateless (null), not rejected');
});

// ---- Part B — /select-date removed ----
test('Part B — /select-date and /date.html are gone (404)', async () => {
  assert.strictEqual((await H.get('/select-date', { cookie })).status, 404);
  assert.strictEqual((await H.get('/date.html', { cookie })).status, 404);
});
