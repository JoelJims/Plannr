// Tenant data-access layer.
//
// Phase 2 collapsed the app to a single household: every read/write/aggregate that used to be
// scoped by tenant_id now just operates on the whole table, since the whole table IS the one
// household (tenant_id itself was dropped from the schema in Step 2a). This module keeps the same
// function names and shapes as before Phase 2 (minus the leading tenantId argument every one of
// them took), so route handlers in server.js didn't need to change their call shape beyond
// dropping that one argument.
//
// Every function here reads or writes through db.js's async database interface and returns a
// Promise (step 1.4 B10-B12). Nothing is prepared at import, so this module may be imported before
// the database is open; init() must have run before the first call (the tables must exist).

import { dbAdapter, transaction } from './db.js';
import { statementOn } from './core/db-adapter.js';

// Step 1.4 B10-B12: repo.js moves to the async database interface (core/db-adapter.js), one group of
// statements per part. S(sql) looks like a prepared statement (get/all/run with positional params),
// but every call returns a Promise, so every caller awaits it. The adapter prepares each SQL text on
// first use and keeps it; it also resolves the connection at call time, so these need no open
// database at import. Converted: overview, ledgerCustoms, ledgers, authoredCount (B10); contract (B11); crud, trash,
// backup (B12). Nothing here prepares a statement on the synchronous handle any more.
const S = (sql) => statementOn(dbAdapter(), sql);

// ── generic CRUD (used by makeLedgerCrud) ────────────────────────────────────────────────────────
// config: { table, select, listWhere, byIdWhere, columns, alias } — alias is the table alias used in
// `select`/`listWhere`/`byIdWhere` ('c', 'cp', or '' for none).
// Every runner returns a Promise (step 1.4 B12).
function crud({ table, select, listWhere, byIdWhere, columns, alias = '', searchCols = null }) {
  const a = alias ? alias + '.' : '';
  const listStmt = S(`${select} ${listWhere}`);
  const byIdStmt = S(`${select} ${byIdWhere}`);
  const existsStmt = S(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`);
  const fullRowStmt = S(`SELECT * FROM ${table} WHERE id = ?`);
  const liveCountStmt = S(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`);
  const insertStmt = S(insertSqlFor(table, columns));
  const updateStmt = S(updateSqlFor(table, columns));
  const softDeleteStmt = S(`UPDATE ${table} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`);

  // Part A — SQL-side filtered search (opt-in via searchCols). Builds ONLY the active predicates so
  // the planner can use the right index per combination. The SQL is cached by filter SHAPE (and the
  // adapter prepares each text once). searchCols maps filter -> column(s): { date, amount, ledger,
  // subledger, text: [cols] }.
  let search = null;
  if (searchCols) {
    const searchCache = new Map();
    const buildSearch = (shape) => {
      const clauses = [`${a}deleted_at IS NULL`];
      if (shape.includes('d')) clauses.push(`${a}${searchCols.date} >= ? AND ${a}${searchCols.date} <= ?`);
      if (shape.includes('a')) clauses.push(`${a}${searchCols.amount} >= ? AND ${a}${searchCols.amount} <= ?`);
      if (shape.includes('l')) clauses.push(`${a}${searchCols.ledger} = ?`);
      if (shape.includes('s')) clauses.push(`${a}${searchCols.subledger} = ?`);
      if (shape.includes('q')) clauses.push('(' + searchCols.text.map((c) => `${a}${c} LIKE ?`).join(' OR ') + ')');
      return S(`${select} WHERE ${clauses.join(' AND ')} ORDER BY ${a}id ASC`);
    };
    // filters: { start, end, min, max, ledger, subledger, q } — any subset.
    search = (f = {}) => {
      const shape = [], params = [];
      if (f.start != null || f.end != null) { shape.push('d'); params.push(f.start || '0000-01-01', f.end || '9999-12-31'); }
      if (f.min != null || f.max != null) { shape.push('a'); params.push(f.min == null ? 0 : f.min, f.max == null ? Number.MAX_SAFE_INTEGER : f.max); }
      if (f.ledger) { shape.push('l'); params.push(f.ledger); if (f.subledger) { shape.push('s'); params.push(f.subledger); } }
      if (f.q) { shape.push('q'); const like = `%${f.q}%`; for (const _ of searchCols.text) params.push(like); }
      const key = shape.join('');
      let stmt = searchCache.get(key);
      if (!stmt) { stmt = buildSearch(key); searchCache.set(key, stmt); }
      return stmt.all(...params);
    };
  }

  return {
    list: () => listStmt.all(),
    getById: (id) => byIdStmt.get(id),
    existsLive: async (id) => !!(await existsStmt.get(id)),
    fullRow: (id) => fullRowStmt.get(id),
    liveCount: async () => (await liveCountStmt.get()).n,
    insert: (vals) => insertStmt.run(...vals),
    update: (id, vals) => updateStmt.run(...vals, id),
    softDelete: (id) => softDeleteStmt.run(id),
    search, // null unless searchCols was supplied
  };
}

// ── Recycle Bin (per-table) ──────────────────────────────────────────────────────────────────────
// config: { table, select, alias } — `select` is the resource's live SELECT (reused so trash labels
// match the live list). Returns runners for the deleted-only list + find/restore/hard-delete, each
// returning a Promise (step 1.4 B12).
function trash({ table, select, alias = '' }) {
  const a = alias ? alias + '.' : '';
  // A `SELECT *` already carries deleted_at; otherwise expose it explicitly so the shaper + handler
  // can read it (matches the pre-Phase-3 trash selects exactly).
  const withDeleted = /^\s*SELECT\s+\*/i.test(select) ? select : select.replace(/^\s*SELECT /i, `SELECT ${a}deleted_at AS deleted_at, `);
  const listStmt = S(`${withDeleted} WHERE ${a}deleted_at IS NOT NULL ORDER BY ${a}deleted_at DESC`);
  const findStmt = S(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`);
  const restoreStmt = S(`UPDATE ${table} SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL`);
  const hardDeleteStmt = S(`DELETE FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`);
  return {
    listDeleted: () => listStmt.all(),
    find: (id) => findStmt.get(id),
    restore: (id) => restoreStmt.run(id),
    hardDelete: (id) => hardDeleteStmt.run(id),
  };
}

// ── Overview aggregates ──────────────────────────────────────────────────────────────────────────
const OV_OUTS_COLS = 'amount_paise, by_type, ledger_code, subledger_code, subledger_custom_name';
const OV_PAY_COLS = 'amount_paise, ledger_code, subledger_code, subledger_custom_name';
const ov = {
  // The 'included'-debit cumulative scan that fed the Phase 5E reimbursement offset (and its
  // missing-offset reconciliation check) is gone with the offset itself — nothing reads
  // cash_out.contract_stated_paise any more, so there is no aggregate over it here.
  contracts: S(
    `SELECT id, contractor_name, area_of_work, ledger_code, subledger_code, ledger_custom_name, subledger_custom_name, price_of_contract_paise,
            rate_per_sqft_paise, measured_area_milli_sqft
       FROM contract WHERE deleted_at IS NULL ORDER BY id ASC`
  ),
  paidByContract: S('SELECT contract_id, COUNT(*) AS c, COALESCE(SUM(amount_paise), 0) AS s FROM contractor_payments WHERE deleted_at IS NULL GROUP BY contract_id'),
  outsAll: S(`SELECT ${OV_OUTS_COLS} FROM cash_out WHERE deleted_at IS NULL`),
  outsRange: S(`SELECT ${OV_OUTS_COLS} FROM cash_out WHERE deleted_at IS NULL AND tx_date >= ? AND tx_date <= ?`),
  paymentsAll: S(`SELECT ${OV_PAY_COLS} FROM contractor_payments WHERE deleted_at IS NULL`),
  paymentsRange: S(`SELECT ${OV_PAY_COLS} FROM contractor_payments WHERE deleted_at IS NULL AND pay_date >= ? AND pay_date <= ?`),
  loansSum: S('SELECT COALESCE(SUM(amount_paise), 0) AS s FROM loans WHERE deleted_at IS NULL'),
  // F4 (b): the whole project's spend, for the budget block while a date range is set. One SUM per
  // table, so no row is sent back for it: live rows only, with no date bound, so an undated (legacy)
  // cash_out row still counts. contractor_payments.pay_date is NOT NULL, so every payment has a date.
  outsSumAll: S('SELECT COALESCE(SUM(amount_paise), 0) AS s FROM cash_out WHERE deleted_at IS NULL'),
  paymentsSumAll: S('SELECT COALESCE(SUM(amount_paise), 0) AS s FROM contractor_payments WHERE deleted_at IS NULL'),
  // Part B — cash_out logged (created) since the last report's boundary timestamp (created_at is UTC ISO).
  outsSince: S("SELECT COUNT(*) AS c, COALESCE(SUM(amount_paise), 0) AS s FROM cash_out WHERE deleted_at IS NULL AND created_at > ?"),
};
// Each returns a Promise (step 1.4 B10).
const overview = {
  contracts: () => ov.contracts.all(),
  paidByContract: () => ov.paidByContract.all(),
  outsAll: () => ov.outsAll.all(),
  outsRange: (lo, hi) => ov.outsRange.all(lo, hi),
  paymentsAll: () => ov.paymentsAll.all(),
  paymentsRange: (lo, hi) => ov.paymentsRange.all(lo, hi),
  loansSum: () => ov.loansSum.get(),
  outsSumAll: () => ov.outsSumAll.get(),         // F4 (b) — { s }
  paymentsSumAll: () => ov.paymentsSumAll.get(), // F4 (b) — { s }
  outsSince: (sinceIso) => ov.outsSince.get(sinceIso), // Part B — { c, s }
};

// ── Contract + services + payment dates ───────────────────────────────────────────────────────────
const cStmt = {
  list: S('SELECT * FROM contract WHERE deleted_at IS NULL ORDER BY id ASC'),
  getLive: S('SELECT * FROM contract WHERE id = ? AND deleted_at IS NULL'),
  existsLive: S('SELECT 1 FROM contract WHERE id = ? AND deleted_at IS NULL'),
  liveCount: S('SELECT COUNT(*) AS n FROM contract WHERE deleted_at IS NULL'),
  deletedAt: S('SELECT deleted_at FROM contract WHERE id = ?'),
  softDelete: S("UPDATE contract SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"),
  payDatesFor: S('SELECT pay_date FROM contract_payment_dates WHERE contract_id = ? ORDER BY pay_date ASC, id ASC'),
  servicesFor: S('SELECT id, name FROM contract_services WHERE contract_id = ? AND deleted_at IS NULL ORDER BY id ASC'),
  serviceLive: S('SELECT * FROM contract_services WHERE id = ? AND deleted_at IS NULL'),
  serviceForContract: S('SELECT * FROM contract_services WHERE id = ? AND contract_id = ? AND deleted_at IS NULL'),
  insService: S('INSERT INTO contract_services (contract_id, name) VALUES (?, ?)'),
  updService: S("UPDATE contract_services SET name = ?, updated_at = datetime('now') WHERE id = ?"),
  delService: S("UPDATE contract_services SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"),
  livePaymentsFor: S('SELECT COUNT(*) AS n FROM contractor_payments WHERE contract_id = ? AND deleted_at IS NULL'),
  // Part C — best-effort overdue heuristic: is there a LIVE payment recorded on exactly this scheduled
  // (contract_id, pay_date)? There is no schedule↔payment FK, so this exact-date match is the only signal.
  paymentOnDate: S('SELECT 1 FROM contractor_payments WHERE contract_id = ? AND pay_date = ? AND deleted_at IS NULL LIMIT 1'),
  paymentsForAny: S('SELECT COUNT(*) AS n FROM contractor_payments WHERE contract_id = ?'),
  paymentContractId: S('SELECT contract_id FROM contractor_payments WHERE id = ?'),
  // cash_out.contract_service_id -> contract_services(id) has NO ON DELETE action, so hard-deleting a
  // contract (which CASCADEs into its contract_services) throws a raw FK error if any cash_out row —
  // live OR in the Recycle Bin, since FK checks don't know about deleted_at — still points at one of
  // those services. Counted the same way as paymentsForAny, so the route can guard it the same way.
  cashOutReferencingServices: S(
    'SELECT COUNT(*) AS n FROM cash_out WHERE contract_service_id IN (SELECT id FROM contract_services WHERE contract_id = ?)'
  ),
  // One-live-debit-per-service guard (the safety-critical pair). Contract Phase A: this used to
  // be serviceLivePriced and also returned price_paise, because only a PRICED service could be
  // linked. Services carry no price now, so the question it answers is simply "is this a live
  // service on the live contract" - the price half of the old rule went out with the column.
  serviceLinkable: S('SELECT cs.id FROM contract_services cs JOIN contract c ON c.id = cs.contract_id WHERE cs.id = ? AND cs.deleted_at IS NULL AND c.deleted_at IS NULL'),
  serviceClaimedByOther: S('SELECT id, tx_date, amount_paise FROM cash_out WHERE contract_service_id = ? AND deleted_at IS NULL AND id != ?'),
  cashOutServiceId: S('SELECT contract_service_id FROM cash_out WHERE id = ?'),

  // Contract Phase A - allowance caps. Same shape as the service statements above, with two
  // differences that matter: an allowance is NOT tenant-scoped (the column was never added,
  // post-collapse), and its spend is a SUM over many debits rather than a one-to-one link.
  allowancesFor: S('SELECT id, name, cap_kind, cap_paise, cap_rate_per_sqft_paise, area_milli_sqft, sort_order FROM contract_allowances WHERE contract_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC'),
  allowanceLive: S('SELECT * FROM contract_allowances WHERE id = ? AND deleted_at IS NULL'),
  // Mirror of serviceLinkable: is this a live allowance on the LIVE contract? (No uniqueness
  // check to go with it - many debits may draw against one cap; that is what a cap is.)
  allowanceLinkable: S('SELECT ca.id FROM contract_allowances ca JOIN contract c ON c.id = ca.contract_id WHERE ca.id = ? AND ca.deleted_at IS NULL AND c.deleted_at IS NULL'),
  allowanceForContract: S('SELECT * FROM contract_allowances WHERE id = ? AND contract_id = ? AND deleted_at IS NULL'),
  allowanceCount: S('SELECT COUNT(*) AS n FROM contract_allowances WHERE contract_id = ? AND deleted_at IS NULL'),
  allowanceMaxOrder: S('SELECT COALESCE(MAX(sort_order), -1) AS m FROM contract_allowances WHERE contract_id = ?'),
  insAllowance: S('INSERT INTO contract_allowances (contract_id, name, cap_kind, cap_paise, cap_rate_per_sqft_paise, area_milli_sqft, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updAllowance: S("UPDATE contract_allowances SET name = ?, cap_kind = ?, cap_paise = ?, cap_rate_per_sqft_paise = ?, area_milli_sqft = ?, updated_at = datetime('now') WHERE id = ?"),
  delAllowance: S("UPDATE contract_allowances SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"),
  // Running spend per allowance: LIVE cash_out rows only, one grouped pass for the whole
  // contract (idx_cash_out_allowance_live). Soft-deleting a debit releases its draw, exactly as
  // it does for every other figure in the app.
  allowanceSpendFor: S(
    'SELECT co.contract_allowance_id AS id, COALESCE(SUM(co.amount_paise), 0) AS s, COUNT(*) AS c '
    + 'FROM cash_out co JOIN contract_allowances ca ON ca.id = co.contract_allowance_id '
    + 'WHERE ca.contract_id = ? AND co.deleted_at IS NULL AND co.contract_allowance_id IS NOT NULL '
    + 'GROUP BY co.contract_allowance_id'
  ),
  // Mirror of cashOutReferencingServices: contract_allowances CASCADEs off a hard-deleted
  // contract, but cash_out.contract_allowance_id has no ON DELETE action, so the same raw FK
  // crash is possible and gets the same pre-flight count.
  cashOutReferencingAllowances: S(
    'SELECT COUNT(*) AS n FROM cash_out WHERE contract_allowance_id IN (SELECT id FROM contract_allowances WHERE contract_id = ?)'
  ),
};
// Every function returns a Promise (step 1.4 B11). A contract and its payment dates are saved in ONE
// transaction (review finding Q3): insertWithPayDates / updateWithPayDates. Any error rolls the whole
// save back, so the old dates are never left deleted and a contract is never left without its dates.
const writePayDatesOn = async (tx, cid, dates) => {
  await tx.run('DELETE FROM contract_payment_dates WHERE contract_id = ?', [cid]);
  for (const d of dates) await tx.run('INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (?, ?)', [cid, d]);
};
const contract = {
  list: () => cStmt.list.all(),
  getLive: async (id) => (await cStmt.getLive.get(id)) || null,
  existsLive: async (id) => !!(await cStmt.existsLive.get(id)),
  liveCount: async () => (await cStmt.liveCount.get()).n,
  deletedAt: (id) => cStmt.deletedAt.get(id),
  softDelete: (id) => cStmt.softDelete.run(id),
  insertWithPayDates: (cols, vals, dates) => transaction(async (tx) => {
    const info = await tx.run(insertSqlFor('contract', cols), vals);
    await writePayDatesOn(tx, info.lastInsertRowid, dates);
    return info;
  }),
  updateWithPayDates: (id, cols, vals, dates) => transaction(async (tx) => {
    await tx.run(updateSqlFor('contract', cols), [...vals, id]);
    await writePayDatesOn(tx, id, dates);
  }),
  payDatesFor: async (cid) => (await cStmt.payDatesFor.all(cid)).map((r) => r.pay_date),
  servicesFor: (cid) => cStmt.servicesFor.all(cid),
  serviceLive: async (id) => (await cStmt.serviceLive.get(id)) || null,
  serviceForContract: async (cid, sid) => (await cStmt.serviceForContract.get(sid, cid)) || null,
  insertService: (cid, name) => cStmt.insService.run(cid, name),
  updateService: (id, name) => cStmt.updService.run(name, id),
  softDeleteService: (id) => cStmt.delService.run(id),
  livePaymentsFor: async (cid) => (await cStmt.livePaymentsFor.get(cid)).n,
  paymentOnDate: async (cid, payDate) => !!(await cStmt.paymentOnDate.get(cid, payDate)), // Part C

  paymentsForAny: async (cid) => (await cStmt.paymentsForAny.get(cid)).n,
  paymentContractId: (id) => cStmt.paymentContractId.get(id),
  cashOutReferencingServices: async (cid) => (await cStmt.cashOutReferencingServices.get(cid)).n,
  serviceLinkable: (sid) => cStmt.serviceLinkable.get(sid),
  serviceClaimedByOther: (sid, excludeId) => cStmt.serviceClaimedByOther.get(sid, excludeId),
  cashOutServiceId: (id) => cStmt.cashOutServiceId.get(id),

  // Contract Phase A - allowance caps
  allowancesFor: (cid) => cStmt.allowancesFor.all(cid),
  allowanceLive: async (id) => (await cStmt.allowanceLive.get(id)) || null,
  allowanceLinkable: (aid) => cStmt.allowanceLinkable.get(aid),
  allowanceForContract: async (cid, aid) => (await cStmt.allowanceForContract.get(aid, cid)) || null,
  allowanceCount: async (cid) => (await cStmt.allowanceCount.get(cid)).n,
  insertAllowance: (cid, v) => cStmt.insAllowance.run(cid, v.name, v.cap_kind, v.cap_paise, v.cap_rate_per_sqft_paise, v.area_milli_sqft, v.sort_order),
  updateAllowance: (id, v) => cStmt.updAllowance.run(v.name, v.cap_kind, v.cap_paise, v.cap_rate_per_sqft_paise, v.area_milli_sqft, id),
  softDeleteAllowance: (id) => cStmt.delAllowance.run(id),
  nextAllowanceOrder: async (cid) => (await cStmt.allowanceMaxOrder.get(cid)).m + 1,
  // -> Map(allowanceId -> { spentPaise, entryCount }); absent = no live spend against it yet.
  allowanceSpendFor: async (cid) => new Map((await cStmt.allowanceSpendFor.all(cid)).map((r) => [r.id, { spentPaise: r.s, entryCount: r.c }])),
  cashOutReferencingAllowances: async (cid) => (await cStmt.cashOutReferencingAllowances.get(cid)).n,
};

// Column-list INSERT/UPDATE (contract). Since step 1.4 B11 these build the SQL text only: the adapter
// prepares each text once.
const insertSqlFor = (table, cols) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
const updateSqlFor = (table, cols) => `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;

// ── Per-user custom ledger names ──────────────────────────────────────────────────────────────────
const lcStmt = {
  list: S('SELECT name FROM ledger_customs ORDER BY name COLLATE NOCASE ASC'),
  save: S('INSERT OR IGNORE INTO ledger_customs (name) VALUES (?)'),
  // Part 4 (Phase 11B): prune a name from the pick-list. Denormalised — cash_out rows keep their
  // stored ledger_custom_name copy, so this only shrinks the autocomplete list, never rewrites past debits.
  remove: S('DELETE FROM ledger_customs WHERE name = ?'),
};
const ledgerCustoms = { // each returns a Promise (step 1.4 B10)
  list: async () => (await lcStmt.list.all()).map((r) => r.name),
  save: (name) => lcStmt.save.run(name),
  remove: (name) => lcStmt.remove.run(name),
};

// ── Ledger taxonomy (Phase 10b) — user-editable via CSV export/import on the Data Backup page.
// `code` IS the identity (no separate internal id); a rename keeps the same code so historical
// cash_out/contract/contractor_payments rows never orphan. ────────────────────────────────────────
const ledgerStmt = {
  mains: S('SELECT code, name FROM ledger_mains ORDER BY sort_order ASC'),
  allSubs: S('SELECT code, main_code AS mainCode, name FROM ledger_subs ORDER BY sort_order ASC'),
};

const MAIN_CODE_RE = /^\d+\.0$/;
const SUB_CODE_RE = /^(\d+)\.(\d+)$/;
const LEDGER_CSV_HEADER = ['Code', 'Main ledger', 'Sub-code', 'Sub-ledger'];
// Phase 14 — codes are the row identity (see ledgerUsageCounts/validateLedgerCsv below) and must
// never be hand-edited; only the name columns are. Exported as a leading comment row so the note
// travels with the file itself, not just the in-app copy on Data Backup.
const LEDGER_CSV_NOTE = '# Do not edit the Code / Sub-code column — it is the permanent identity Plannr matches rows by. Only the Main ledger / Sub-ledger name text may be changed.';

async function ledgerList() {
  const subs = await ledgerStmt.allSubs.all();
  return (await ledgerStmt.mains.all()).map((m) => ({
    code: m.code, name: m.name,
    subLedgers: subs.filter((s) => s.mainCode === m.code).map((s) => ({ code: s.code, name: s.name })),
  }));
}

// How many rows across the three ledger-bearing tables reference each of `codes` (main or sub) —
// counting EVERY row, not just live ones: a soft-deleted row can be restored later, so its stored
// code still has to resolve to something real. contract_services has no ledger_code column at all,
// so it is not part of this check.
async function ledgerUsageCounts(codes) {
  const counts = {};
  if (!codes.length) return counts;
  const placeholders = codes.map(() => '?').join(',');
  for (const table of ['cash_out', 'contract', 'contractor_payments']) {
    for (const col of ['ledger_code', 'subledger_code']) {
      const rows = await dbAdapter().all(`SELECT ${col} AS code, COUNT(*) AS n FROM ${table} WHERE ${col} IN (${placeholders}) GROUP BY ${col}`, codes);
      for (const r of rows) counts[r.code] = (counts[r.code] || 0) + r.n;
    }
  }
  return counts;
}

// One transaction (db.js transaction(): any error rolls the whole list back and is passed on).
function ledgerReplaceAll(mains, subs) {
  return transaction(async (tx) => {
    await tx.run('DELETE FROM ledger_subs');
    await tx.run('DELETE FROM ledger_mains');
    for (const [i, m] of mains.entries()) await tx.run('INSERT INTO ledger_mains (code, name, sort_order) VALUES (?, ?, ?)', [m.code, m.name, i]);
    for (const [i, s] of subs.entries()) await tx.run('INSERT INTO ledger_subs (code, main_code, name, sort_order) VALUES (?, ?, ?, ?)', [s.code, s.mainCode, s.name, i]);
  });
}

function ledgerToCsv(list) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [[LEDGER_CSV_NOTE], LEDGER_CSV_HEADER];
  for (const L of list) {
    rows.push([L.code, L.name, '', '']);
    for (const s of L.subLedgers) rows.push([L.code, L.name, s.code, s.name]);
  }
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// The app's own 4-column export shape (Code, Main ledger, Sub-code, Sub-ledger) — NOT a general CSV
// library: quoted fields with embedded commas/quotes/newlines (RFC 4180), nothing more.
function parseLedgerCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = text.replace(/^﻿/, ''); // strip a UTF-8 BOM if present (Excel/Sheets add one on save)
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* swallow; \r\n and a bare \r both end on the \n (or EOF) below */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== '')); // drop wholly-blank rows (e.g. a trailing newline)
}

// Validates a full Ledger List CSV against every rule in Phase 10b's spec and returns either
// { ok:true, mains, subs } (ready for ledgerReplaceAll) or { ok:false, error, rowErrors }, as a
// Promise (it reads the codes in use). The WHOLE file is rejected on any failure — this never does a
// partial import.
async function validateLedgerCsv(csvText) {
  let rows;
  try { rows = parseLedgerCsv(csvText); } catch (e) { return { ok: false, error: 'Could not parse the file as CSV: ' + e.message, rowErrors: [] }; }
  if (!rows.length) return { ok: false, error: 'The file is empty.', rowErrors: [] };
  // The export's leading "do not edit codes" note (Phase 14) — a single-cell comment row, optional
  // on import so hand-built/older files without it still work.
  if (rows[0].length === 1 && rows[0][0].trim().startsWith('#')) rows = rows.slice(1);
  if (!rows.length) return { ok: false, error: 'The file is empty.', rowErrors: [] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const expected = LEDGER_CSV_HEADER.map((h) => h.toLowerCase());
  if (header.length !== 4 || !expected.every((h, i) => header[i] === h)) {
    return { ok: false, error: 'Expected columns "Code, Main ledger, Sub-code, Sub-ledger" as the first row.', rowErrors: [] };
  }

  const rowErrors = [];
  const mains = [];
  const subRowsPending = [];
  const seenCodes = new Set();
  const declaredMains = new Set();

  rows.slice(1).forEach((r, i) => {
    const rowNum = i + 2; // 1-based; row 1 is the header
    const code = (r[0] || '').trim();
    const mainLedger = (r[1] || '').trim();
    const subCode = (r[2] || '').trim();
    const subLedger = (r[3] || '').trim();

    if (!subCode) {
      if (!code || !MAIN_CODE_RE.test(code)) { rowErrors.push({ row: rowNum, message: `Row ${rowNum}: Code "${code}" is malformed — a main ledger code must be "N.0".` }); return; }
      if (!mainLedger) { rowErrors.push({ row: rowNum, message: `Row ${rowNum}: main ledger "${code}" has no name.` }); return; }
      if (seenCodes.has(code)) { rowErrors.push({ row: rowNum, message: `Row ${rowNum}: code "${code}" is duplicated.` }); return; }
      seenCodes.add(code); declaredMains.add(code);
      mains.push({ code, name: mainLedger });
    } else {
      const m = SUB_CODE_RE.exec(subCode);
      if (!m) { rowErrors.push({ row: rowNum, message: `Row ${rowNum}: sub-code "${subCode}" is malformed — must be "N.M".` }); return; }
      if (!subLedger) { rowErrors.push({ row: rowNum, message: `Row ${rowNum}: sub-ledger "${subCode}" has no name.` }); return; }
      if (seenCodes.has(subCode)) { rowErrors.push({ row: rowNum, message: `Row ${rowNum}: code "${subCode}" is duplicated.` }); return; }
      const impliedMain = m[1] + '.0';
      if (!code || code !== impliedMain) { rowErrors.push({ row: rowNum, message: `Row ${rowNum}: sub-code "${subCode}" doesn't match its Code column ("${code}") — expected "${impliedMain}".` }); return; }
      seenCodes.add(subCode);
      subRowsPending.push({ rowNum, code: subCode, mainCode: code, name: subLedger });
    }
  });

  const subs = [];
  for (const p of subRowsPending) {
    if (!declaredMains.has(p.mainCode)) {
      rowErrors.push({ row: p.rowNum, message: `Row ${p.rowNum}: sub-ledger "${p.code}" references main "${p.mainCode}", which is not present in this file.` });
      continue;
    }
    subs.push({ code: p.code, mainCode: p.mainCode, name: p.name });
  }

  if (rowErrors.length) return { ok: false, error: `${rowErrors.length} row(s) failed validation.`, rowErrors };

  // The critical check: a code missing from the new file must not still be in use.
  const newCodes = new Set([...mains.map((m) => m.code), ...subs.map((s) => s.code)]);
  const oldCodes = [...(await ledgerStmt.mains.all()).map((m) => m.code), ...(await ledgerStmt.allSubs.all()).map((s) => s.code)];
  const removedCodes = oldCodes.filter((c) => !newCodes.has(c));
  if (removedCodes.length) {
    const counts = await ledgerUsageCounts(removedCodes);
    const stillUsed = removedCodes.filter((c) => counts[c] > 0).map((c) => ({ code: c, rows: counts[c] }));
    if (stillUsed.length) {
      return {
        ok: false,
        error: 'Codes are permanent — some were removed or altered in this file but are still used by existing rows: ' + stillUsed.map((u) => `${u.code} (${u.rows} row${u.rows === 1 ? '' : 's'})`).join(', ') + '. Only the ledger/sub-ledger NAME can be changed; the code itself cannot.',
        rowErrors: stillUsed.map((u) => ({ row: null, message: `Code "${u.code}" was removed or altered in this file, but is still used by ${u.rows} existing row${u.rows === 1 ? '' : 's'}. Codes cannot be changed once rows reference them — only the name can.` })),
      };
    }
  }

  return { ok: true, mains, subs };
}

// list, usageCounts, replaceAll and validateImport return Promises (step 1.4 B10); toCsv does not
// touch the database.
const ledgers = {
  list: ledgerList,
  usageCounts: ledgerUsageCounts,
  replaceAll: ledgerReplaceAll,
  toCsv: ledgerToCsv,
  validateImport: validateLedgerCsv,
};

// ── delete-account: rows the user authored ────────────────────────────────────────────────────────
const authoredStmt = {
  cashIn: S('SELECT COUNT(*) AS n FROM cash_in WHERE by_user_id = ?'),
  cashOut: S('SELECT COUNT(*) AS n FROM cash_out WHERE by_user_id = ?'),
};
const authoredCount = async (userId) => (await authoredStmt.cashIn.get(userId)).n + (await authoredStmt.cashOut.get(userId)).n;

// ── Backup export / teardown / insert ─────────────────────────────────────────────────────────────
// Tables come from a fixed server-side allowlist (BACKUP_TABLES). Each runner returns a Promise
// (step 1.4 B12). (backup-format.js builds and restores backups with its own statements.)
const backup = {
  exportTable: (table) => S(`SELECT * FROM ${table}`).all(),
  deleteTenantRows: (table) => S(`DELETE FROM ${table}`).run(),
  insertRow: (table, cols, vals) => S(insertSqlFor(table, cols)).run(...vals),
  upsertSetting: (key, value) => S('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value), // settings PK is now a plain key
};

export {
  crud, trash,
  overview, contract, ledgerCustoms, ledgers, authoredCount, backup,
};
