// Part B — "what changed since the last report" (tested via the injected builder directly, since the
// send path short-circuits under PLANNR_TEST). Part C — upcoming scheduled payments + the honest,
// best-effort overdue flag (tested via GET /api/overview and the same builder).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const dailyReport = require('../daily-report');

let A;
const TODAY = dailyReport.istDateStamp();
function shift(iso, days) { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10); }
function insPayDate(cid, date, tenantId) { H.db.prepare('INSERT INTO contract_payment_dates (contract_id, pay_date, tenant_id) VALUES (?, ?, ?)').run(cid, date, tenantId); }
const build = (prev) => H.app._buildReportExtras(A.user.id, prev);
const snap = (figures, at = '2000-01-01T00:00:00.000Z') => ({ at, atIST: '2000-01-01 00:00 IST', figures });

before(async () => { await H.startApp(); A = H.seedLoggedIn(); });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

// ── Part B ────────────────────────────────────────────────────────────────────────────────────────

test('first-ever report: no baseline, no movement line', () => {
  H.seedCashOut({ amountPaise: 10000, byUserId: A.user.id, tenantId: A.user.id, txDate: '2026-01-01' });
  const { text, figures } = build(null);
  assert.match(text, /first report/i);
  assert.ok(!/Movement:/.test(text), 'no movement line without a baseline');
  assert.strictEqual(typeof figures.totalSpentPaise, 'number');
});

test('entries since last report: count + total (created_at > boundary)', () => {
  for (const p of [10000, 20000, 30000]) H.seedCashOut({ amountPaise: p, byUserId: A.user.id, tenantId: A.user.id });
  const { text } = build(snap({}, '2000-01-01T00:00:00.000Z')); // boundary in the past → all 3 count
  assert.match(text, /Since the last report \(2000-01-01 00:00 IST\)/);
  assert.match(text, /3 new entries logged, ₹600\.00 in total/);
});

test('zero new entries says so plainly (not an empty section)', () => {
  H.seedCashOut({ amountPaise: 10000, byUserId: A.user.id, tenantId: A.user.id });
  const { text } = build(snap({}, '2999-01-01T00:00:00.000Z')); // boundary in the FUTURE → nothing newer
  assert.match(text, /Nothing new has been logged since the last report/);
});

test('headline movement: signed deltas vs the snapshot, and "unchanged" when equal', () => {
  H.seedCashOut({ amountPaise: 500000, byUserId: A.user.id, tenantId: A.user.id }); // ₹5,000 spent
  const fromZero = build(snap({ totalSpentPaise: 0, paidToContractorsPaise: 0, owedToContractorsPaise: 0, loanReceivedPaise: 0 }));
  assert.match(fromZero.text, /Movement:/);
  assert.match(fromZero.text, /Total spent \+₹5,000\.00/);
  const fromCurrent = build(snap(fromZero.figures)); // snapshot == current → no movement
  assert.match(fromCurrent.text, /Headline figures are unchanged\./);
});

test("today's individual transactions are listed; a non-today row is not", () => {
  H.seedCashOut({ amountPaise: 12300, byUserId: A.user.id, tenantId: A.user.id, txDate: TODAY });
  H.seedCashOut({ amountPaise: 45600, byUserId: A.user.id, tenantId: A.user.id, txDate: TODAY });
  H.seedCashOut({ amountPaise: 99900, byUserId: A.user.id, tenantId: A.user.id, txDate: shift(TODAY, -2) }); // not today
  const { text } = build(null);
  assert.match(text, /Logged today \(2\):/);      // exactly the two today rows
  assert.match(text, /₹123\.00/);
  assert.ok(!text.includes('₹999.00'), 'the 2-days-ago row must not appear in today’s list');
});

test('nothing logged today says so', () => {
  H.seedCashOut({ amountPaise: 10000, byUserId: A.user.id, tenantId: A.user.id, txDate: shift(TODAY, -5) });
  assert.match(build(null).text, /Nothing logged today\./);
});

// ── Part C ────────────────────────────────────────────────────────────────────────────────────────

test('upcoming payments: dates forward + days remaining, no amount claimed', async () => {
  const cid = H.seedContract({ tenantId: A.user.id });
  insPayDate(cid, shift(TODAY, 10), A.user.id);
  insPayDate(cid, shift(TODAY, 3), A.user.id);
  const r = await H.get('/api/overview', { cookie: A.cookie });
  const up = r.json.upcomingPayments;
  assert.ok(Array.isArray(up) && up.length === 2);
  const next = up.find((u) => u.date === shift(TODAY, 3));
  assert.strictEqual(next.daysRemaining, 3);
  assert.strictEqual(next.possiblyOverdue, false);
  assert.ok(!('amountPaise' in next) && !('amount' in next), 'no amount is claimed per scheduled date');
});

test('overdue is a best-effort exact-date match: flagged only when no payment on that date', async () => {
  const cid = H.seedContract({ tenantId: A.user.id });
  const overdueDate = shift(TODAY, -5); // past, no payment → possibly overdue
  const paidDate = shift(TODAY, -3);    // past, but a payment exists on that exact date → NOT overdue
  insPayDate(cid, overdueDate, A.user.id);
  insPayDate(cid, paidDate, A.user.id);
  H.seedPayment({ contractId: cid, payDate: paidDate, amountPaise: 100000, tenantId: A.user.id });

  const up = (await H.get('/api/overview', { cookie: A.cookie })).json.upcomingPayments;
  assert.strictEqual(up.find((u) => u.date === overdueDate).possiblyOverdue, true);
  assert.strictEqual(up.find((u) => u.date === paidDate).possiblyOverdue, false);
  assert.strictEqual(up.find((u) => u.date === paidDate).paidOnDate, true);

  // The report text reflects both, honestly labelled.
  const { text } = build(null);
  assert.match(text, new RegExp('Scheduled ' + overdueDate + ' has no recorded payment'));
  assert.ok(!text.includes('Scheduled ' + paidDate + ' has no recorded payment'), 'the paid date must not be flagged overdue');
  assert.match(text, /best-effort date match/);
});

test('upcoming payments never leak across tenants', async () => {
  const B = H.seedLoggedIn();
  const cid = H.seedContract({ tenantId: A.user.id });
  insPayDate(cid, shift(TODAY, 7), A.user.id);
  const bUp = (await H.get('/api/overview', { cookie: B.cookie })).json.upcomingPayments;
  assert.strictEqual(bUp.length, 0, 'B sees none of A’s scheduled dates');
});
