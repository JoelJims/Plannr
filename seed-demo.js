// Plannr — seed a realistic Kerala house build for scale/UX testing (Phase 3, Part B).
//
//   npm run seed:demo          -> REFUSES (live DB) via db-guard
//   PLANNR_DB=/tmp/demo.db npm run seed:demo   -> seeds the isolated copy
//
// Shape modelled on real entry, NOT a uniform spread: clusters of same-day rows (a delivery is several
// lines at once), long gaps, and repeated ledger/sub-ledger combos — the pattern that reveals whether
// defaults and repetition-shortcuts would help. Deterministic (seeded PRNG) so runs reproduce.

const { guardDbTarget } = require('./db-guard');
guardDbTarget();                          // refuses data/plannr.db unless --i-really-mean-the-live-db
const { db, init } = require('./db');
init();
const { LEDGERS } = require('./public/ledgers.js');

// ---- deterministic RNG (LCG) — no Math.random, so seed:demo reproduces exactly ----
let _s = 20260803;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));                 // inclusive int
const chance = (p) => rnd() < p;
const rupees = (rs) => Math.round(rs) * 100;                              // ₹ -> integer paise
function wpick(items) { const tot = items.reduce((s, x) => s + x.w, 0); let r = rnd() * tot; for (const x of items) { if ((r -= x.w) <= 0) return x; } return items[items.length - 1]; }

const TARGET = Number(process.env.PLANNR_SEED_ROWS || 1800);               // rows (default 1800; PLANNR_SEED_ROWS for a baseline)
// Phase 4E — two reproducible reconciliation states. Default 'overoffset' keeps the existing dataset
// whose included offsets exceed the ₹25L contract (reconciliation.ok = false — exercises the banner).
// PLANNR_SEED_PROFILE=reconcile drops the included ratio so offsets stay well under the contract and
// reconciliation.ok = true. Both are worth having; a seed that trips the banner isn't a bug to tidy away.
const RECONCILE = (process.env.PLANNR_SEED_PROFILE || 'overoffset').toLowerCase() === 'reconcile';
const START = new Date(Date.UTC(2025, 0, 6));                              // 18 months: Jan 2025 → Jun 2026
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Per-ledger spend profiles: [code, weight, ₹min, ₹max, labour?]. Cement/labour/transport/sand dominate
// (realistic repetition); steel/kitchen/flooring are big + sparse. Covers 20 of 24 ledgers (missing only
// 3 APPROVALS & STATUTORY FEES, 5 TEMPORARY SITE SETUP, 23 POST-COMPLETION & HANDOVER, and 24
// CONTINGENCY & UNPLANNED — all rare/late-phase), well past the "≥18" bar.
const P = (code, w, mn, mx, labour) => ({ code, w, mn, mx, labour: !!labour });
// Weights favour SMALL rows heavily — a real ledger's row COUNT is daily labour + transport + small
// buys; big deliveries (steel in lakhs, kitchen, flooring) are rare. Keeps the total realistic for a
// fully-itemised ₹25L-contract build (owner-supplied materials on top) instead of ballooning to crores.
const PROFILES = [
  // small / labour / transport — dominant by count (hundreds to low-thousands)
  P('12.2', 70, 300, 900, 1), P('12.7', 70, 350, 1300, 1), P('13.1', 35, 400, 1200, 1),
  P('21.3', 45, 300, 2500), P('13.3', 18, 500, 2500, 1), P('9.3', 12, 500, 4000), P('21.1', 30, 1000, 8000),
  // materials — thousands to low tens-of-thousands
  P('6.1', 12, 4000, 24000), P('6.3', 9, 6000, 16000), P('6.5', 7, 5000, 14000), P('7.2', 5, 8000, 26000),
  P('14.1', 4, 2000, 14000), P('8.1', 4, 2000, 14000), P('18.5', 2, 6000, 20000), P('13.7', 2, 5000, 18000),
  P('18.1', 2, 8000, 26000), P('8.5', 2, 5000, 25000), P('4.4', 2, 4000, 18000), P('20.2', 2, 2000, 12000),
  P('19.1', 2, 3000, 18000), P('20.1', 1, 3000, 15000), P('22.6', 1, 8000, 25000),
  // big / rare — steel in lakhs, kitchen/flooring/doors, low weight so they stay ~1% of rows
  P('6.2', 3, 70000, 150000), P('11.1', 2, 15000, 65000), P('11.2', 2, 8000, 30000), P('15.1', 2, 8000, 44000),
  P('15.2', 2, 8000, 40000), P('18.2', 1, 40000, 100000), P('2.1', 1, 25000, 70000), P('1.2', 1, 40000, 100000),
  P('16.1', 1, 10000, 55000), P('17.1', 1, 15000, 50000), P('10.6', 1, 15000, 40000),
];
const topLevel = (code) => code.split('.')[0];
const nameFor = (code) => { const t = topLevel(code); const L = LEDGERS.find((x) => x.code === t + '.0'); if (!L) return code; const sub = L.subLedgers.find((s) => s.code === code); return sub ? sub.name : L.name; };

const LONG_REMARKS = [
  'Second lot of 8mm and 12mm TMT bars for the first-floor slab; the site engineer flagged the earlier challan was short by roughly 40kg, so this covers the shortfall too.',
  'Cement delivered in two tempo loads on the same morning — 90 bags total. Ten bags set aside for the compound wall so they are not counted against the slab pour estimate.',
  'Daily labour for de-shuttering the ground-floor beams and shifting the props up for the next slab. Six workers plus the mestri; paid in cash at the site as usual.',
  'M-sand load rejected at first as too silty; replaced by the supplier the next day at no extra cost. This entry is the accepted second load with the corrected weighbridge slip.',
  'Advance to the tile contractor for the hall and two bedrooms, vitrified 800x800; balance to be paid after laying is inspected. Rate held from the original quotation despite the GST change.',
  'Electrical rough-in for the first floor — conduits and back boxes only, no wiring pulled yet. Extra points added in the kitchen and near the staircase beyond the original drawing.',
  'Waterproofing chemical plus labour for both first-floor bathrooms; the mason recommended a second coat over the sunk portion, which is included in this amount.',
  'Transport for granite slabs from the yard, including the hydra charge to lift them over the compound wall since the gate opening was too narrow for the lorry.',
  'Part payment for the modular kitchen carcass; the countertop and chimney are billed separately later. Colour and shutter finish confirmed with the client before the advance.',
  'Plastering labour for the rear elevation and the two side walls; scaffolding rental for the week is booked under equipment, not here, to keep the labour figure clean.',
];

const now = new Date();
const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);

console.error('[seed] wiping ledger tables on the target (isolated) DB and re-seeding…');
db.exec('DELETE FROM cash_out; DELETE FROM cash_in; DELETE FROM contractor_payments; DELETE FROM contract_payment_dates; DELETE FROM contract; DELETE FROM loans;');
db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('cash_out','cash_in','contractor_payments','contract','loans')").run();
db.prepare("DELETE FROM settings WHERE key='budget_paise'").run();

// ---- the owner user for the UI walkthroughs (no login exists; password_hash is a placeholder) ----
let owner = db.prepare('SELECT id FROM users WHERE username = ?').get('demo');
if (!owner) owner = { id: Number(db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?,?,?)').run('demo', 'Demo Owner', 'demo-no-auth').lastInsertRowid) };
const ownerId = owner.id;

db.exec('BEGIN');
try {
  // ---- contract ~₹25,00,000 ----
  const contractId = Number(db.prepare(
    `INSERT INTO contract (contractor_name, area_of_work, ledger_code, subledger_code, price_of_contract_paise, date_signed, contract_end_date, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run('Rajan & Sons Builders', '2,400 sqft — G+1 residential, Thrissur', '12.0', '12.7', rupees(2500000), '2025-01-15', '2026-06-30', nowIso, nowIso).lastInsertRowid);

  // ---- 7 contractor payments across ~12 months (partial — leaves genuine dues) ----
  const payDates = ['2025-02-10', '2025-04-05', '2025-06-12', '2025-08-20', '2025-10-15', '2025-12-18', '2026-02-25'];
  const payAmts = [300000, 250000, 300000, 250000, 300000, 200000, 150000]; // ₹ — sums to ₹17,50,000 of the ₹25,00,000
  const insPayDate = db.prepare('INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (?,?)');
  const insPay = db.prepare(`INSERT INTO contractor_payments (contract_id, pay_date, amount_paise, ledger_code, subledger_code, remarks, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  payDates.forEach((d, i) => { insPayDate.run(contractId, d); insPay.run(contractId, d, rupees(payAmts[i]), '12.0', '12.7', i === 0 ? 'Mobilisation advance on signing' : null, nowIso, nowIso); });

  // ---- cash_out: clustered, gappy, repeated combos ----
  const insOut = db.prepare(
    `INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, by_label, ledger_code, subledger_code, reason, contract_scope, contract_stated_paise, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let day = new Date(START);
  const END = new Date(Date.UTC(2026, 5, 28));
  let n = 0, longRemarks = 0, included = 0, byLedger = {};
  const wantLong = 36;
  while (n < TARGET) {
    // advance: mostly 1–7 days, sometimes a long 20–45 day gap (a lull between work phases)
    day = addDays(day, chance(0.12) ? ri(20, 45) : ri(1, 7));
    if (day > END) day = new Date(START.getTime() + ri(0, 30) * 86400000); // wrap so we always reach TARGET
    const dom = wpick(PROFILES);                              // the day's dominant material/work
    const cluster = chance(0.25) ? ri(4, 8) : ri(1, 3);      // delivery/work days = several rows at once
    for (let i = 0; i < cluster && n < TARGET; i++) {
      const p = chance(0.7) ? dom : wpick(PROFILES);         // 70% repeat the same combo (realistic)
      const amt = rupees(ri(p.mn, p.mx));
      const t = topLevel(p.code);
      const canInclude = ['6', '7', '8', '9', '10', '11', '12', '13', '14'].includes(t);
      // reconcile: far fewer included rows so Σ offsets + Σ payments stays under the ₹25L contract.
      const isInc = chance(canInclude ? (RECONCILE ? 0.05 : 0.5) : (RECONCILE ? 0 : 0.08));
      const stated = isInc ? Math.round(amt * (0.85 + rnd() * 0.3)) : null;
      let reason = null;
      if (longRemarks < wantLong && chance(0.03)) { reason = LONG_REMARKS[longRemarks % LONG_REMARKS.length]; longRemarks++; }
      else if (p.labour && chance(0.5)) reason = `Daily labour — ${ri(3, 9)} workers`;
      else if (chance(0.06)) reason = nameFor(p.code).split('(')[0].trim();
      const custom = chance(0.08);
      insOut.run(amt, iso(day), custom ? 'custom' : 'user', custom ? null : ownerId, custom ? wpick([{ w: 1, code: 'Site supervisor' }, { w: 1, code: 'Mestri (cash)' }, { w: 1, code: 'Relative on site' }]).code : null,
        t + '.0', p.code, reason, isInc ? 'included' : 'extra', stated, nowIso, nowIso);
      if (isInc) included++;
      byLedger[t] = (byLedger[t] || 0) + 1;
      n++;
    }
  }

  // ---- inflow: owner funding + a relative's contribution ----
  const insIn = db.prepare('INSERT INTO cash_in (amount_paise, tx_date, by_type, by_user_id, by_label, reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const inflows = [
    [1500000, '2025-01-08', 'user', ownerId, null, 'Own savings — initial'], [500000, '2025-02-14', 'relative', null, 'Father', 'Family contribution'],
    [800000, '2025-03-20', 'user', ownerId, null, 'Salary top-up'], [1200000, '2025-05-05', 'user', ownerId, null, 'FD closed for the build'],
    [300000, '2025-07-11', 'relative', null, 'Brother-in-law', 'Loan from family'], [600000, '2025-09-02', 'custom', null, 'Land sale (small plot)', 'Sold ancestral plot share'],
    [400000, '2025-11-18', 'user', ownerId, null, 'Bonus'], [250000, '2026-01-09', 'relative', null, 'Mother', 'Gift'],
  ];
  inflows.forEach(([a, d, bt, uid, lbl, r]) => insIn.run(rupees(a), d, bt, uid, lbl, r, nowIso, nowIso));

  // ---- two loans ----
  const insLoan = db.prepare('INSERT INTO loans (amount_paise, bank_name, interest_rate, tenure, created_at, updated_at) VALUES (?,?,?,?,?,?)');
  insLoan.run(rupees(1500000), 'SBI Home Loan', 8.5, '20 years', nowIso, nowIso);
  insLoan.run(rupees(500000), 'Federal Bank top-up', 10.25, '7 years', nowIso, nowIso);

  // ---- budget: ~8% above total spent (debits + contractor payments), rounded to the nearest lakh, so
  //      the bar sits "near" by default. Part E adjusts it up/down for the under/over screenshots. ----
  const spentSoFar = db.prepare('SELECT COALESCE(SUM(amount_paise),0) s FROM cash_out').get().s
    + db.prepare('SELECT COALESCE(SUM(amount_paise),0) s FROM contractor_payments').get().s;
  const budgetPaise = Math.round((spentSoFar * 1.08) / 10000000) * 10000000; // round to ₹1,00,000
  db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(budgetPaise));

  db.exec('COMMIT');

  // ---- summary ----
  const q1 = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount_paise),0) s FROM cash_out').get();
  const ledgerCount = Object.keys(byLedger).length;
  const payTot = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount_paise),0) s FROM contractor_payments').get();
  const inTot = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount_paise),0) s FROM cash_in').get();
  const fmt = (paise) => '₹' + (paise / 100).toLocaleString('en-IN');
  console.log('\n[seed] DONE — realistic Kerala G+1 build seeded (profile: ' + (RECONCILE ? 'RECONCILE — offsets under contract, reconciliation.ok=true' : 'OVER-OFFSET — reconciliation.ok=false, banner shows') + '):');
  console.log(`  contract:            ${fmt(rupees(2500000))} (Rajan & Sons Builders)`);
  console.log(`  contractor payments: ${payTot.c} rows, ${fmt(payTot.s)} paid`);
  console.log(`  cash_out (debits):   ${q1.c} rows, ${fmt(q1.s)} spent, across ${ledgerCount} of 24 ledgers`);
  console.log(`  · included (offset): ${included} rows   · long remarks (100–200c): ${longRemarks} rows`);
  console.log(`  cash_in (inflow):    ${inTot.c} rows, ${fmt(inTot.s)}`);
  console.log(`  loans:               2   · budget: ${fmt(budgetPaise)}  (total spent incl. payments: ${fmt(spentSoFar)})`);
  console.log(`  login:               username "demo"  password "DemoPass123!aa"`);
  // Bounds enforced only for the DEFAULT demo (1800). A smaller baseline seed (PLANNR_SEED_ROWS) is exempt.
  if (TARGET >= 1500) {
    if (q1.c < 1500 || q1.c > 2000) { console.error(`[seed] WARNING: cash_out count ${q1.c} outside [1500,2000]`); process.exit(1); }
    if (ledgerCount < 18) { console.error(`[seed] WARNING: only ${ledgerCount} ledgers populated (< 18)`); process.exit(1); }
  }
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[seed] FAILED, rolled back —', e);
  process.exit(1);
}
