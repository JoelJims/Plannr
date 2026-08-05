// Loan interest recorded under ledger 20.0 / sub-ledger 20.3 (Loan interest) as an ordinary cash_out
// row: it counts in total spend and the finance-charges pie slice, stays OUT of contract dues (always
// 'extra' → no reimbursement offset), keeps build ledgers as separate slices, and survives a backup
// round-trip. loans.interest_rate remains informational (drives no figure).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let A;
const interestBody = { amountRupees: '5000.00', txDate: '2026-07-15', byType: 'user', ledgerCode: '20.0', subledgerCode: '20.3', contractScope: 'extra' };

before(async () => { await H.startApp(); A = H.seedLoggedIn(); });
after(async () => {
  await H.stopApp();
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  try { for (const f of fs.readdirSync(os.tmpdir())) if (/^auto-snapshot-before-import-.*\.json$/.test(f)) fs.unlinkSync(path.join(os.tmpdir(), f)); } catch { /* ignore */ }
});
beforeEach(() => H.clearLedger());

const overview = async () => (await H.get('/api/overview', { cookie: A.cookie })).json;
const addInterest = () => H.post('/api/cash-out', { ...interestBody, byUserId: A.user.id }, { cookie: A.cookie });

test('the create route accepts ledger 20.0 + sub-ledger 20.3 (Loan interest)', async () => {
  const r = await addInterest();
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.entry.ledgerCode, '20.0');
  assert.strictEqual(r.json.entry.subledgerCode, '20.3');
  assert.strictEqual(r.json.entry.contractScope, 'extra');
});

test('interest counts in total spend + the 20.0 finance slice, kept separate from build ledgers, and NEVER in owed (F)', async () => {
  const cid = H.seedContract({ tenantId: A.user.id, pricePaise: 10000000 }); // stated ₹1,00,000
  H.seedPayment({ contractId: cid, amountPaise: 4000000, tenantId: A.user.id }); // paid ₹40,000
  H.seedCashOut({ amountPaise: 3200000, byUserId: A.user.id, tenantId: A.user.id, ledgerCode: '4.0', subledgerCode: '4.2', contractScope: 'extra' }); // ₹32,000 cement (build)
  await addInterest(); // ₹5,000 interest under 20.0/20.3

  const o = await overview();
  assert.strictEqual(o.money.spentBySelfPaise, 3200000 + 500000, 'C includes cement + interest');
  assert.strictEqual(o.money.totalSpentPaise, 3200000 + 500000 + 4000000, 'D = C + payments');
  assert.strictEqual(o.money.owedToContractorsPaise, 10000000 - 4000000, 'owed unaffected: interest is extra, no offset');

  const fin = o.ledgers.find((L) => L.code === '20.0');
  assert.ok(fin && fin.totalPaise === 500000, '20.0 finance slice carries only the interest');
  const sub = fin.subs.find((s) => s.code === '20.3');
  assert.ok(sub && sub.totalPaise === 500000, '20.3 sub-slice = the interest');
  const build = o.ledgers.find((L) => L.code === '4.0');
  assert.strictEqual(build.totalPaise, 3200000, 'build ledger is its own slice, NOT mixed with interest');
  assert.strictEqual(o.reconciliation.ok, true, 'pie/totals still reconcile with an interest row present');
});

test('interest does not touch loanReceived (E) or contract total (A) — interest_rate stays informational', async () => {
  H.seedContract({ tenantId: A.user.id, pricePaise: 10000000 });
  await addInterest();
  const o = await overview();
  assert.strictEqual(o.money.loanReceivedPaise, 0, 'interest is a spend, not a loan received');
  assert.strictEqual(o.money.totalContractPaise, 10000000, 'contract total unchanged by interest');
});

test('a backup round-trips a 20.3 interest row (import validation accepts it)', async () => {
  await addInterest();
  const backup = (await H.get('/api/backup/export', { cookie: A.cookie })).json;
  assert.ok(backup.tables.cash_out.some((r) => r.ledger_code === '20.0' && r.subledger_code === '20.3'), 'export contains the 20.3 interest row');
  const imp = await H.post('/api/backup/import', backup, { cookie: A.cookie });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.json));
  const fin = (await overview()).ledgers.find((L) => L.code === '20.0');
  assert.ok(fin && fin.totalPaise === 500000, 'interest survives the round-trip');
});
