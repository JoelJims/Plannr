// The cross-tenant isolation harness. Phase 1 built it (measuring 65 leaks); Phase 3 closed the
// data-access layer and it now reads 0 — a PERMANENT regression net folded into `npm test`. Any future
// unfiltered query re-opens a leak and fails here. Isolated DB only. No production code/routes touched.
//
//   npm run test:isolation
//
// Seeds user A with data in every table (live + soft-deleted), a budget, and Daily Report recipients;
// registers user B; then, as B, asserts B can see and touch NONE of A's data. Every failing assertion
// is a measured leak. The count grouped by surface is the deliverable — it should reach zero when the
// tenancy work is done. Run it, don't add it to `npm test`, until then.

process.env.PLANNR_TEST = '1';
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
process.env.PLANNR_DB = path.join(os.tmpdir(), `plannr-isolation-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const app = require('../server');
const { db, init, DB_PATH } = require('../db');
const { assertRegistryComplete, REGISTRY } = require('./registry');
try { init(); } catch { /* server may already have run it */ }

// Never the live DB.
if (path.resolve(DB_PATH).toLowerCase() === path.resolve(__dirname, '..', 'data', 'plannr.db').toLowerCase()) {
  console.error('REFUSING: PLANNR_DB resolved to the live database.'); process.exit(3);
}

// ── assertion tally, grouped by surface ─────────────────────────────────────────────────────────
const fails = {}; // surface -> [descriptions]
let passed = 0, failed = 0;
function check(surface, desc, cond) {
  if (cond) { passed++; return; }
  failed++; (fails[surface] = fails[surface] || []).push(desc);
}
const row = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id); // table from a fixed set; id numeric

(async () => {
  // Harness self-check: the registry must cover every live tenant-bearing route (this must PASS).
  try { assertRegistryComplete(app); } catch (e) { console.error('\n✖ REGISTRY COMPLETENESS FAILED (harness bug, not a leak):\n' + e.message + '\n'); process.exit(2); }

  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, p, { cookie, body } = {}) => {
    const h = {}; if (cookie) h.Cookie = cookie; if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const setCookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
    return { status: r.status, json, buf, cookie: setCookie };
  };
  const PW = 'IsolPass123!aa';
  const register = async (username, displayName) => {
    await req('POST', '/api/register', { body: { username, displayName, password: PW, confirmPassword: PW } });
    const r = await req('POST', '/api/login', { body: { username, password: PW } });
    return { cookie: r.cookie, id: r.json && r.json.user && r.json.user.id };
  };

  const A = await register('usera', 'User A');
  const B = await register('userb', 'User B');

  // ── seed A's data: live + soft-deleted in every table, budget, Daily Report recipients ──────────
  const nowSql = "datetime('now')";
  const ids = {};
  // Tenancy Phase 2 — every ledger row now carries NOT NULL tenant_id. Seed ALL of A's rows as
  // tenant A. Phase 2 applies NO read filter, so B still sees/touches all of it — the 60 leaks are
  // unchanged; the column just satisfies the schema (and lets Phase 3's filter have something to key on).
  ids.ciLive = Number(db.prepare("INSERT INTO cash_in (amount_paise, tx_date, by_type, by_user_id, reason, tenant_id) VALUES (111100,'2025-03-01','user',?,'A inflow',?)").run(A.id, A.id).lastInsertRowid);
  ids.ciDel = Number(db.prepare(`INSERT INTO cash_in (amount_paise, tx_date, by_type, by_user_id, reason, deleted_at, tenant_id) VALUES (222200,'2025-03-02','user',?,'A inflow deleted', ${nowSql}, ?)`).run(A.id, A.id).lastInsertRowid);
  ids.coLive = Number(db.prepare("INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, ledger_code, contract_scope, tenant_id) VALUES (987654321,'2025-03-03','user',?, '4.0','extra',?)").run(A.id, A.id).lastInsertRowid); // distinctive ₹98,76,543.21 for the PDF check
  ids.coDel = Number(db.prepare(`INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, ledger_code, contract_scope, deleted_at, tenant_id) VALUES (333300,'2025-03-04','user',?, '4.0','extra', ${nowSql}, ?)`).run(A.id, A.id).lastInsertRowid);
  ids.ciDel2 = Number(db.prepare(`INSERT INTO cash_in (amount_paise, tx_date, by_type, by_user_id, reason, deleted_at, tenant_id) VALUES (444400,'2025-03-05','user',?,'A inflow deleted 2', ${nowSql}, ?)`).run(A.id, A.id).lastInsertRowid);
  ids.coDel2 = Number(db.prepare(`INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, ledger_code, contract_scope, deleted_at, tenant_id) VALUES (555500,'2025-03-06','user',?, '4.0','extra', ${nowSql}, ?)`).run(A.id, A.id).lastInsertRowid);
  ids.loanLive = Number(db.prepare("INSERT INTO loans (amount_paise, bank_name, tenant_id) VALUES (5000000,'A Bank',?)").run(A.id).lastInsertRowid);
  ids.loanDel = Number(db.prepare(`INSERT INTO loans (amount_paise, bank_name, deleted_at, tenant_id) VALUES (6000000,'A Bank (deleted)', ${nowSql}, ?)`).run(A.id).lastInsertRowid);
  ids.ctDel = Number(db.prepare(`INSERT INTO contract (contractor_name, price_of_contract_paise, date_signed, deleted_at, tenant_id) VALUES ('A Old Contractor', 2500000, '2025-01-01', ${nowSql}, ?)`).run(A.id).lastInsertRowid);
  ids.ctLive = Number(db.prepare("INSERT INTO contract (contractor_name, area_of_work, ledger_code, price_of_contract_paise, date_signed, tenant_id) VALUES ('A Contractor','Foundation','5.0', 2500000, '2025-01-02', ?)").run(A.id).lastInsertRowid);
  db.prepare("INSERT INTO contract_payment_dates (contract_id, pay_date, tenant_id) VALUES (?, '2025-02-01', ?)").run(ids.ctLive, A.id);
  ids.payLive = Number(db.prepare("INSERT INTO contractor_payments (contract_id, pay_date, amount_paise, tenant_id) VALUES (?, '2025-02-01', 1000000, ?)").run(ids.ctLive, A.id).lastInsertRowid);
  ids.payDel = Number(db.prepare(`INSERT INTO contractor_payments (contract_id, pay_date, amount_paise, deleted_at, tenant_id) VALUES (?, '2025-02-02', 500000, ${nowSql}, ?)`).run(ids.ctLive, A.id).lastInsertRowid);
  // Services phase — a priced service on A's live contract. A NEW tenant-bearing surface with no read
  // filter yet, so B can see/touch it (expected to raise the leak count above 60).
  ids.svcLive = Number(db.prepare("INSERT INTO contract_services (contract_id, name, price_paise, tenant_id) VALUES (?, 'A Electrical', 4000000, ?)").run(ids.ctLive, A.id).lastInsertRowid);
  // Tenancy Phase 2 — settings is keyed on (tenant_id, key); seed all of A's settings under tenant A.
  const setS = db.prepare('INSERT INTO settings (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value');
  setS.run(A.id, 'budget_paise', '4200000');
  setS.run(A.id, 'daily_report_recipients', JSON.stringify(['a-secret@gmail.com']));
  setS.run(A.id, 'daily_report_whatsapp', JSON.stringify(['+919812345678']));
  setS.run(A.id, 'daily_report_times', JSON.stringify(['09:00']));
  setS.run(A.id, 'daily_report_whatsapp_times', JSON.stringify(['16:05']));

  // ── as B: reads must see NOTHING of A's ─────────────────────────────────────────────────────────
  const listEmpty = async (surface, p, key) => { const r = await req('GET', p, { cookie: B.cookie }); check(surface, `${p} returns 0 rows for B (saw ${(r.json && r.json[key] || []).length})`, (r.json && Array.isArray(r.json[key]) && r.json[key].length === 0)); };
  await listEmpty('cash_in read', '/api/cash-in', 'entries');
  await listEmpty('cash_out read', '/api/cash-out', 'entries');
  await listEmpty('loans read', '/api/loans', 'loans');
  await listEmpty('contract read', '/api/contracts', 'contracts');
  await listEmpty('contractor_payments read', '/api/contractor-payments', 'payments');

  // Services phase — B must not see A's contract services (nested in the contract read). No filter yet, so it leaks.
  { const r = await req('GET', '/api/contracts', { cookie: B.cookie });
    const svcCount = (r.json && r.json.contracts || []).reduce((n, c) => n + ((c.services || []).length), 0);
    check('contract_services read', `contract services empty for B (saw ${svcCount})`, svcCount === 0); }

  const ov = await req('GET', '/api/overview', { cookie: B.cookie });
  const m = (ov.json && ov.json.money) || {};
  for (const k of ['spentBySelfPaise', 'paidToContractorsPaise', 'totalSpentPaise', 'loanReceivedPaise', 'totalContractPaise', 'owedToContractorsPaise']) {
    check('overview', `money.${k} is 0 for B (saw ${m[k]})`, m[k] === 0);
  }
  check('overview', `overview ledgers empty for B (saw ${(ov.json && ov.json.ledgers || []).length})`, ov.json && Array.isArray(ov.json.ledgers) && ov.json.ledgers.length === 0);
  check('overview', `overview contracts empty for B (saw ${(ov.json && ov.json.contracts || []).length})`, ov.json && Array.isArray(ov.json.contracts) && ov.json.contracts.length === 0);
  check('overview', `budgetPaise is null for B (saw ${ov.json && ov.json.budgetPaise})`, ov.json && (ov.json.budgetPaise === null || ov.json.budgetPaise === undefined));

  // As B, the PDF must render B's (empty) ledger, not A's rows. Inflate the PDF's FlateDecode streams and
  // search for A's distinctive amount; ALSO check the exact composition the endpoint renders
  // (computeOverview → buildOverviewPdfHtml) so a compressed/fragmented content stream can't hide the leak.
  const zlib = require('node:zlib');
  const pdf = await req('GET', '/api/overview/pdf?part=table', { cookie: B.cookie });
  let pdfText = pdf.buf.toString('latin1');
  { const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let mm; const raw = pdf.buf.toString('latin1'); while ((mm = re.exec(raw)) !== null) { try { pdfText += '\n' + zlib.inflateSync(Buffer.from(mm[1], 'latin1')).toString('latin1'); } catch { /* not a flate stream */ } } }
  check('overview/pdf', `PDF served to B contains none of A's amount ₹98,76,543 (endpoint bytes, inflated)`, !pdfText.includes('98,76,543'));
  check('overview/pdf', `PDF composition (computeOverview→HTML) contains none of A's rows`, !app._overviewPdfHtml({ tenantId: B.id, part: 'table', theme: 'light', range: { start: null, end: null } }).includes('98,76,543'));

  const trash = await req('GET', '/api/trash', { cookie: B.cookie });
  const trashTotal = trash.json && trash.json.trash ? Object.values(trash.json.trash).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0) : -1;
  check('trash read', `trash shows 0 of A's deleted rows for B (saw ${trashTotal})`, trashTotal === 0);

  const exp = await req('GET', '/api/backup/export', { cookie: B.cookie });
  const T = (exp.json && exp.json.tables) || {};
  for (const t of ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments', 'contract_payment_dates']) {
    check('backup/export', `export.${t} empty for B (saw ${(T[t] || []).length})`, Array.isArray(T[t]) && T[t].length === 0);
  }
  const expSettings = JSON.stringify((T.settings || []));
  check('backup/export', `export leaks none of A's budget/recipients for B`, !/budget_paise|a-secret@gmail\.com|919812345678/.test(expSettings));

  const users = await req('GET', '/api/users', { cookie: B.cookie });
  const roster = (users.json && users.json.users) || [];
  check('users roster', `/api/users returns only B, not A (saw ${roster.length} users)`, roster.length === 1 && roster.every((u) => u.id !== A.id));

  const budget = await req('GET', '/api/budget', { cookie: B.cookie });
  check('budget read', `/api/budget is null for B (saw ${budget.json && budget.json.budgetPaise})`, budget.json && (budget.json.budgetPaise === null || budget.json.budgetPaise === undefined));

  // ── Point 4: cross-tenant contract creation must be WRITABLE — run it now, WHILE A still has a
  // live contract (the mutation section below soft-deletes it via a leak), so it genuinely exercises
  // the single-live-contract invariant. That invariant is enforced by idx_contract_single_live_tenant
  // (db.js), a PER-TENANT unique index — Tenancy Phase 2 (Part B) retired the old database-wide
  // idx_contract_single_live specifically because it made a second tenant unable to create ANY
  // contract. So B succeeding here is correct isolation, not a leak; test/tenancy.test.js already
  // asserts the same invariant directly at the DB level (one tenant is capped at one live contract,
  // two different tenants can each hold one simultaneously).
  const cRes = await req('POST', '/api/contracts', { cookie: B.cookie, body: { contractorName: 'B Contractor', areaOfWork: 'Roof', ledgerCode: '5.0', statedAmountRupees: '1000', dateSigned: '2025-06-01' } });
  check('contract create (cross-tenant)', `POST /api/contracts as B (while A has a live contract) → HTTP 201 (saw ${cRes.status}: ${JSON.stringify(cRes.json).slice(0, 160)})`, cRes.status === 201);

  // Verify it's the PER-TENANT index doing the work, not an absent/disabled constraint: the old
  // database-wide index must be gone and the per-tenant one must exist and actually key off tenant_id.
  const contractIndexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='contract'").all();
  const perTenantIdx = contractIndexes.find((i) => i.name === 'idx_contract_single_live_tenant');
  check('contract create (cross-tenant)', 'idx_contract_single_live_tenant exists and is scoped by tenant_id', !!perTenantIdx && /\btenant_id\b/.test(perTenantIdx.sql || ''));
  check('contract create (cross-tenant)', 'the old database-wide idx_contract_single_live has been retired', !contractIndexes.some((i) => i.name === 'idx_contract_single_live'));

  // ── as B: mutations must 404 (not 403), and leave A's row byte-identical ─────────────────────────
  const mut = async (surface, method, p, table, id, body) => {
    const before = JSON.stringify(row(table, id) || null);
    const r = await req(method, p, { cookie: B.cookie, body });
    check(surface, `${method} ${p} → 404 for B (was ${r.status}; a 2xx is a write, a 403 confirms the row)`, r.status === 404);
    check(surface, `A's ${table}#${id} byte-identical after B's ${method} (no cross-tenant write)`, JSON.stringify(row(table, id) || null) === before);
  };
  const editBody = { amountRupees: '9', txDate: '2025-01-01', byType: 'custom', byLabel: 'B', ledgerCode: '4.0', contractScope: 'extra' };
  await mut('cash_in mutate', 'PUT', `/api/cash-in/${ids.ciLive}`, 'cash_in', ids.ciLive, { amountRupees: '9', txDate: '2025-01-01', byType: 'custom', byLabel: 'B' });
  await mut('cash_in mutate', 'DELETE', `/api/cash-in/${ids.ciLive}`, 'cash_in', ids.ciLive);
  await mut('cash_out mutate', 'PUT', `/api/cash-out/${ids.coLive}`, 'cash_out', ids.coLive, editBody);
  await mut('cash_out mutate', 'DELETE', `/api/cash-out/${ids.coLive}`, 'cash_out', ids.coLive);
  await mut('loans mutate', 'PUT', `/api/loans/${ids.loanLive}`, 'loans', ids.loanLive, { amountRupees: '9', bankName: 'B' });
  await mut('loans mutate', 'DELETE', `/api/loans/${ids.loanLive}`, 'loans', ids.loanLive);
  await mut('contractor_payments mutate', 'PUT', `/api/contractor-payments/${ids.payLive}`, 'contractor_payments', ids.payLive, { contractId: ids.ctLive, payDate: '2025-01-01', amountRupees: '9' });
  await mut('contractor_payments mutate', 'DELETE', `/api/contractor-payments/${ids.payLive}`, 'contractor_payments', ids.payLive);
  // Services phase — B mutating A's service (BEFORE the contract soft-delete below, so A's contract is still live).
  await mut('contract_services mutate', 'PUT', `/api/contracts/${ids.ctLive}/services/${ids.svcLive}`, 'contract_services', ids.svcLive, { name: 'B hijack', priceRupees: '1' });
  await mut('contract_services mutate', 'DELETE', `/api/contracts/${ids.ctLive}/services/${ids.svcLive}`, 'contract_services', ids.svcLive);
  await mut('contract mutate', 'DELETE', `/api/contracts/${ids.ctLive}`, 'contract', ids.ctLive);

  // trash: restore + hard-delete A's soft-deleted rows (DISTINCT rows so a leaked restore can't mask a
  // subsequent hard-delete on the same id).
  await mut('trash restore', 'POST', `/api/trash/cash_in/${ids.ciDel}/restore`, 'cash_in', ids.ciDel);
  await mut('trash hard-delete', 'DELETE', `/api/trash/cash_in/${ids.ciDel2}`, 'cash_in', ids.ciDel2);
  await mut('trash restore', 'POST', `/api/trash/cash_out/${ids.coDel}/restore`, 'cash_out', ids.coDel);
  await mut('trash hard-delete', 'DELETE', `/api/trash/cash_out/${ids.coDel2}`, 'cash_out', ids.coDel2);
  await mut('trash hard-delete', 'DELETE', `/api/trash/loans/${ids.loanDel}`, 'loans', ids.loanDel);
  await mut('trash hard-delete', 'DELETE', `/api/trash/contract/${ids.ctDel}`, 'contract', ids.ctDel);
  await mut('trash restore', 'POST', `/api/trash/contractor_payments/${ids.payDel}/restore`, 'contractor_payments', ids.payDel);

  // ── report ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(' Plannr cross-tenant isolation harness — a PERMANENT regression net (Phase 3: must stay at 0 leaks)');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`Registry: ${REGISTRY.length} tenant-bearing routes registered; completeness assertion PASSED.`);
  console.log(`Seeded user A (id=${A.id}); registered user B (id=${B.id}). Ran isolation assertions as B.\n`);

  const surfaces = Object.keys(fails).sort();
  if (surfaces.length) {
    console.log('LEAKS BY SURFACE (failing assertions = data B could see/touch that belongs to A):');
    for (const s of surfaces) { console.log(`  ✖ ${s}: ${fails[s].length}`); for (const d of fails[s]) console.log(`       - ${d}`); }
  }

  console.log('\n── SUMMARY ───────────────────────────────────────────────────────────');
  console.log(`  assertions run:    ${passed + failed}`);
  console.log(`  passed (isolated): ${passed}`);
  console.log(`  FAILED (leaks):    ${failed}   ← must stay at 0 (Phase 3 closed the data-access layer)`);
  console.log(`  surfaces leaking:  ${surfaces.length}`);
  console.log(failed === 0 ? '\n  ✓ ISOLATION CLEAN — no cross-tenant read or write leaks across any registered surface.' : '');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  await new Promise((r) => server.close(r));
  try { if (app._closePdfBrowser) await app._closePdfBrowser(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { require('node:fs').unlinkSync(process.env.PLANNR_DB + s); } catch {} }
  process.exit(failed > 0 ? 1 : 0); // non-zero WHILE the leak exists (that is the point of this phase)
})().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
