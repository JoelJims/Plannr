// F4 (review 2026-11-21), option (b) — AWAITING THE USER'S DECISION. With a date range set, the
// Overview's "left" figure compared the spend IN THE RANGE with the WHOLE-PROJECT budget. Now
// "left" (and "over") always compares the WHOLE project's spend with the budget, on the screen and
// in the PDF, and says so: "₹X left of total budget" / "₹X over total budget". The range figures
// (B, C, D) are unchanged. Runs on both test passes (desktop and phone code).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.clearLedger(); });

const JULY = { start: '2026-07-01', end: '2026-07-31' };
const setBudget = (paise) => H.db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(paise));
// In July: ₹5,000 spent by self + ₹2,000 paid to the contractor = ₹7,000. In August: ₹8,000 more.
// Whole project: ₹15,000.
function seedSpend() {
  const cid = H.seedContract({ pricePaise: 10000000 });
  H.seedPayment({ contractId: cid, payDate: '2026-07-10', amountPaise: 200000 });
  H.seedCashOut({ txDate: '2026-07-12', amountPaise: 500000 });
  H.seedCashOut({ txDate: '2026-08-20', amountPaise: 800000 });
}

test('F4 (b): the API gives the whole-project spend next to the range figures', async () => {
  seedSpend();
  const ranged = await H.get(`/api/overview?start=${JULY.start}&end=${JULY.end}`, { cookie });
  assert.strictEqual(ranged.status, 200);
  assert.strictEqual(ranged.json.money.totalSpentPaise, 700000, 'D stays the spend in the range');
  assert.strictEqual(ranged.json.money.wholeProjectSpentPaise, 1500000, 'the whole-project spend, ignoring the range');
  const all = await H.get('/api/overview', { cookie });
  assert.strictEqual(all.json.money.wholeProjectSpentPaise, 1500000, 'with no range it equals D');
  assert.strictEqual(all.json.money.totalSpentPaise, 1500000);
});

test('F4 (b): the PDF with a range set says "left of total budget", from the whole-project spend', async () => {
  seedSpend();
  setBudget(2000000); // ₹20,000 budget: ₹5,000 left of the total; the old wording said ₹13,000 left
  const html = await H.pdfHtml({ part: 'full', range: JULY });
  assert.match(html, /₹5,000(\.00)?<\/b> left of total budget/);
  assert.doesNotMatch(html, /13,000/, 'the in-range "left" figure is gone');
});

test('F4 (b): the PDF with a range set says "over total budget" when the whole project is over', async () => {
  seedSpend();
  setBudget(1000000); // ₹10,000 budget: the range (₹7,000) is under it, the whole project (₹15,000) is ₹5,000 over
  const html = await H.pdfHtml({ part: 'full', range: JULY });
  assert.match(html, /₹5,000(\.00)?<\/b> over total budget/);
  assert.doesNotMatch(html, /3,000(\.00)?<\/b> left/, 'no in-range "₹3,000 left"');
});
