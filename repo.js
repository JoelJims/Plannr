// Tenant data-access layer.
//
// Phase 2 collapsed the app to a single household: every read/write/aggregate that used to be
// scoped by tenant_id now just operates on the whole table, since the whole table IS the one
// household (tenant_id itself was dropped from the schema in Step 2a). This module keeps the same
// function names and shapes as before Phase 2 (minus the leading tenantId argument every one of
// them took), so route handlers in server.js didn't need to change their call shape beyond
// dropping that one argument.
//
// db.init() must have run before this module is required (server.js requires it right after init()).
//
// Phase 4c: this module is now an ES module and imports `db` directly from db.js — every statement
// below is prepared eagerly, at THIS module's own top level, against whatever `db` is at that moment.
// Under Node that's always already open (db.js's Node path is synchronous), so nothing here changed
// behaviorally. A future browser entry point must `await` db.js's `ready()` and only import this
// module afterward (e.g. via a dynamic `import('./repo.js')`) — importing it eagerly, before `db` is
// open, would throw the moment any statement below tries to `db.prepare(...)` against a not-yet-open
// connection.

import { db } from './db.js';

// ── generic CRUD (used by makeLedgerCrud) ────────────────────────────────────────────────────────
// config: { table, select, listWhere, byIdWhere, columns, alias } — alias is the table alias used in
// `select`/`listWhere`/`byIdWhere` ('c', 'cp', or '' for none).
function crud({ table, select, listWhere, byIdWhere, columns, alias = '', searchCols = null }) {
  const a = alias ? alias + '.' : '';
  const listStmt = db.prepare(`${select} ${listWhere}`);
  const byIdStmt = db.prepare(`${select} ${byIdWhere}`);
  const existsStmt = db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`);
  const fullRowStmt = db.prepare(`SELECT * FROM ${table} WHERE id = ?`);
  const liveCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`);
  const insertStmt = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  const updateStmt = db.prepare(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`);
  const softDeleteStmt = db.prepare(`UPDATE ${table} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`);

  // Part A — SQL-side filtered search (opt-in via searchCols). Builds ONLY the active predicates so
  // the planner can use the right index per combination. Prepared statements are cached by filter
  // SHAPE. searchCols maps filter -> column(s): { date, amount, ledger, subledger, text: [cols] }.
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
      const sql = `${select} WHERE ${clauses.join(' AND ')} ORDER BY ${a}id ASC`;
      return db.prepare(sql);
    };
    buildSearch(''); // pre-build the base (no-filter) shape at boot
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
    existsLive: (id) => !!existsStmt.get(id),
    fullRow: (id) => fullRowStmt.get(id),
    liveCount: () => liveCountStmt.get().n,
    insert: (vals) => insertStmt.run(...vals),
    update: (id, vals) => updateStmt.run(...vals, id),
    softDelete: (id) => softDeleteStmt.run(id),
    search, // null unless searchCols was supplied
  };
}

// ── Recycle Bin (per-table) ──────────────────────────────────────────────────────────────────────
// config: { table, select, alias } — `select` is the resource's live SELECT (reused so trash labels
// match the live list). Returns runners for the deleted-only list + find/restore/hard-delete.
function trash({ table, select, alias = '' }) {
  const a = alias ? alias + '.' : '';
  // A `SELECT *` already carries deleted_at; otherwise expose it explicitly so the shaper + handler
  // can read it (matches the pre-Phase-3 trash selects exactly).
  const withDeleted = /^\s*SELECT\s+\*/i.test(select) ? select : select.replace(/^\s*SELECT /i, `SELECT ${a}deleted_at AS deleted_at, `);
  const listStmt = db.prepare(`${withDeleted} WHERE ${a}deleted_at IS NOT NULL ORDER BY ${a}deleted_at DESC`);
  const findStmt = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`);
  const restoreStmt = db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NOT NULL`);
  const hardDeleteStmt = db.prepare(`DELETE FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`);
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
  cashoutCumulative: db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN contract_stated_paise > 0 THEN contract_stated_paise ELSE 0 END), 0) AS offset, " +
    "COUNT(CASE WHEN contract_stated_paise IS NULL OR contract_stated_paise = 0 THEN 1 END) AS missCount, " +
    "COALESCE(SUM(CASE WHEN contract_stated_paise IS NULL OR contract_stated_paise = 0 THEN amount_paise ELSE 0 END), 0) AS missSum " +
    "FROM cash_out WHERE deleted_at IS NULL AND contract_scope = 'included'"
  ),
  contracts: db.prepare(
    `SELECT id, contractor_name, area_of_work, ledger_code, subledger_code, ledger_custom_name, subledger_custom_name, price_of_contract_paise
       FROM contract WHERE deleted_at IS NULL ORDER BY id ASC`
  ),
  paidByContract: db.prepare('SELECT contract_id, COUNT(*) AS c, COALESCE(SUM(amount_paise), 0) AS s FROM contractor_payments WHERE deleted_at IS NULL GROUP BY contract_id'),
  outsAll: db.prepare(`SELECT ${OV_OUTS_COLS} FROM cash_out WHERE deleted_at IS NULL`),
  outsRange: db.prepare(`SELECT ${OV_OUTS_COLS} FROM cash_out WHERE deleted_at IS NULL AND tx_date >= ? AND tx_date <= ?`),
  paymentsAll: db.prepare(`SELECT ${OV_PAY_COLS} FROM contractor_payments WHERE deleted_at IS NULL`),
  paymentsRange: db.prepare(`SELECT ${OV_PAY_COLS} FROM contractor_payments WHERE deleted_at IS NULL AND pay_date >= ? AND pay_date <= ?`),
  loansSum: db.prepare('SELECT COALESCE(SUM(amount_paise), 0) AS s FROM loans WHERE deleted_at IS NULL'),
  // Part B — cash_out logged (created) since the last report's boundary timestamp (created_at is UTC ISO).
  outsSince: db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(amount_paise), 0) AS s FROM cash_out WHERE deleted_at IS NULL AND created_at > ?"),
};
const overview = {
  cashoutCumulative: () => ov.cashoutCumulative.get(),
  contracts: () => ov.contracts.all(),
  paidByContract: () => ov.paidByContract.all(),
  outsAll: () => ov.outsAll.all(),
  outsRange: (lo, hi) => ov.outsRange.all(lo, hi),
  paymentsAll: () => ov.paymentsAll.all(),
  paymentsRange: (lo, hi) => ov.paymentsRange.all(lo, hi),
  loansSum: () => ov.loansSum.get(),
  outsSince: (sinceIso) => ov.outsSince.get(sinceIso), // Part B — { c, s }
};

// ── Contract + services + payment dates ───────────────────────────────────────────────────────────
const cStmt = {
  list: db.prepare('SELECT * FROM contract WHERE deleted_at IS NULL ORDER BY id ASC'),
  getLive: db.prepare('SELECT * FROM contract WHERE id = ? AND deleted_at IS NULL'),
  existsLive: db.prepare('SELECT 1 FROM contract WHERE id = ? AND deleted_at IS NULL'),
  liveCount: db.prepare('SELECT COUNT(*) AS n FROM contract WHERE deleted_at IS NULL'),
  deletedAt: db.prepare('SELECT deleted_at FROM contract WHERE id = ?'),
  softDelete: db.prepare("UPDATE contract SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"),
  payDatesFor: db.prepare('SELECT pay_date FROM contract_payment_dates WHERE contract_id = ? ORDER BY pay_date ASC, id ASC'),
  delPayDates: db.prepare('DELETE FROM contract_payment_dates WHERE contract_id = ?'),
  insPayDate: db.prepare('INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (?, ?)'),
  servicesFor: db.prepare('SELECT id, name, price_paise FROM contract_services WHERE contract_id = ? AND deleted_at IS NULL ORDER BY id ASC'),
  serviceLive: db.prepare('SELECT * FROM contract_services WHERE id = ? AND deleted_at IS NULL'),
  serviceForContract: db.prepare('SELECT * FROM contract_services WHERE id = ? AND contract_id = ? AND deleted_at IS NULL'),
  insService: db.prepare('INSERT INTO contract_services (contract_id, name, price_paise) VALUES (?, ?, ?)'),
  updService: db.prepare("UPDATE contract_services SET name = ?, price_paise = ?, updated_at = datetime('now') WHERE id = ?"),
  delService: db.prepare("UPDATE contract_services SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"),
  livePaymentsFor: db.prepare('SELECT COUNT(*) AS n FROM contractor_payments WHERE contract_id = ? AND deleted_at IS NULL'),
  // Part C — best-effort overdue heuristic: is there a LIVE payment recorded on exactly this scheduled
  // (contract_id, pay_date)? There is no schedule↔payment FK, so this exact-date match is the only signal.
  paymentOnDate: db.prepare('SELECT 1 FROM contractor_payments WHERE contract_id = ? AND pay_date = ? AND deleted_at IS NULL LIMIT 1'),
  paymentsForAny: db.prepare('SELECT COUNT(*) AS n FROM contractor_payments WHERE contract_id = ?'),
  paymentContractId: db.prepare('SELECT contract_id FROM contractor_payments WHERE id = ?'),
  // cash_out.contract_service_id -> contract_services(id) has NO ON DELETE action, so hard-deleting a
  // contract (which CASCADEs into its contract_services) throws a raw FK error if any cash_out row —
  // live OR in the Recycle Bin, since FK checks don't know about deleted_at — still points at one of
  // those services. Counted the same way as paymentsForAny, so the route can guard it the same way.
  cashOutReferencingServices: db.prepare(
    'SELECT COUNT(*) AS n FROM cash_out WHERE contract_service_id IN (SELECT id FROM contract_services WHERE contract_id = ?)'
  ),
  // Service one-offset guard (the safety-critical pair)
  serviceLivePriced: db.prepare('SELECT cs.id, cs.price_paise FROM contract_services cs JOIN contract c ON c.id = cs.contract_id WHERE cs.id = ? AND cs.deleted_at IS NULL AND c.deleted_at IS NULL'),
  serviceClaimedByOther: db.prepare('SELECT id, tx_date, amount_paise FROM cash_out WHERE contract_service_id = ? AND deleted_at IS NULL AND id != ?'),
  cashOutServiceId: db.prepare('SELECT contract_service_id FROM cash_out WHERE id = ?'),
};
const contract = {
  list: () => cStmt.list.all(),
  getLive: (id) => cStmt.getLive.get(id) || null,
  existsLive: (id) => !!cStmt.existsLive.get(id),
  liveCount: () => cStmt.liveCount.get().n,
  deletedAt: (id) => cStmt.deletedAt.get(id),
  softDelete: (id) => cStmt.softDelete.run(id),
  insert: (cols, vals) => insertInto('contract', cols, vals),
  update: (id, cols, vals) => updateBy('contract', id, cols, vals),
  payDatesFor: (cid) => cStmt.payDatesFor.all(cid).map((r) => r.pay_date),
  writePayDates: (cid, dates) => { cStmt.delPayDates.run(cid); for (const d of dates) cStmt.insPayDate.run(cid, d); },
  servicesFor: (cid) => cStmt.servicesFor.all(cid),
  serviceLive: (id) => cStmt.serviceLive.get(id) || null,
  serviceForContract: (cid, sid) => cStmt.serviceForContract.get(sid, cid) || null,
  insertService: (cid, name, price) => cStmt.insService.run(cid, name, price),
  updateService: (id, name, price) => cStmt.updService.run(name, price, id),
  softDeleteService: (id) => cStmt.delService.run(id),
  livePaymentsFor: (cid) => cStmt.livePaymentsFor.get(cid).n,
  paymentOnDate: (cid, payDate) => !!cStmt.paymentOnDate.get(cid, payDate), // Part C

  paymentsForAny: (cid) => cStmt.paymentsForAny.get(cid).n,
  paymentContractId: (id) => cStmt.paymentContractId.get(id),
  cashOutReferencingServices: (cid) => cStmt.cashOutReferencingServices.get(cid).n,
  serviceLivePriced: (sid) => cStmt.serviceLivePriced.get(sid),
  serviceClaimedByOther: (sid, excludeId) => cStmt.serviceClaimedByOther.get(sid, excludeId),
  cashOutServiceId: (id) => cStmt.cashOutServiceId.get(id),
};

// Column-list INSERT/UPDATE (contract) — statements built ONCE at boot via configure(); keyed by
// table|cols. Building a same-key statement later just reuses the cached one.
const _insCache = new Map(), _updCache = new Map();
function insertStmtFor(table, cols) {
  const key = table + '|' + cols.join(',');
  let stmt = _insCache.get(key);
  if (!stmt) { stmt = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`); _insCache.set(key, stmt); }
  return stmt;
}
function updateStmtFor(table, cols) {
  const key = table + '|' + cols.join(',');
  let stmt = _updCache.get(key);
  if (!stmt) { stmt = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`); _updCache.set(key, stmt); }
  return stmt;
}
function insertInto(table, cols, vals) { return insertStmtFor(table, cols).run(...vals); }
function updateBy(table, id, cols, vals) { return updateStmtFor(table, cols).run(...vals, id); }

// ── Per-user custom ledger names ──────────────────────────────────────────────────────────────────
const lcStmt = {
  list: db.prepare('SELECT name FROM ledger_customs ORDER BY name COLLATE NOCASE ASC'),
  save: db.prepare('INSERT OR IGNORE INTO ledger_customs (name) VALUES (?)'),
  // Part 4 (Phase 11B): prune a name from the pick-list. Denormalised — cash_out rows keep their
  // stored ledger_custom_name copy, so this only shrinks the autocomplete list, never rewrites past debits.
  remove: db.prepare('DELETE FROM ledger_customs WHERE name = ?'),
};
const ledgerCustoms = {
  list: () => lcStmt.list.all().map((r) => r.name),
  save: (name) => lcStmt.save.run(name),
  remove: (name) => lcStmt.remove.run(name),
};

// ── Ledger taxonomy (Phase 10b) — user-editable via CSV export/import on the Data Backup page.
// `code` IS the identity (no separate internal id); a rename keeps the same code so historical
// cash_out/contract/contractor_payments rows never orphan. ────────────────────────────────────────
const ledgerStmt = {
  mains: db.prepare('SELECT code, name FROM ledger_mains ORDER BY sort_order ASC'),
  allSubs: db.prepare('SELECT code, main_code AS mainCode, name FROM ledger_subs ORDER BY sort_order ASC'),
  deleteMains: db.prepare('DELETE FROM ledger_mains'),
  deleteSubs: db.prepare('DELETE FROM ledger_subs'),
  insMain: db.prepare('INSERT INTO ledger_mains (code, name, sort_order) VALUES (?, ?, ?)'),
  insSub: db.prepare('INSERT INTO ledger_subs (code, main_code, name, sort_order) VALUES (?, ?, ?, ?)'),
};

const MAIN_CODE_RE = /^\d+\.0$/;
const SUB_CODE_RE = /^(\d+)\.(\d+)$/;
const LEDGER_CSV_HEADER = ['Code', 'Main ledger', 'Sub-code', 'Sub-ledger'];

function ledgerList() {
  const subs = ledgerStmt.allSubs.all();
  return ledgerStmt.mains.all().map((m) => ({
    code: m.code, name: m.name,
    subLedgers: subs.filter((s) => s.mainCode === m.code).map((s) => ({ code: s.code, name: s.name })),
  }));
}

// How many rows across the three ledger-bearing tables reference each of `codes` (main or sub) —
// counting EVERY row, not just live ones: a soft-deleted row can be restored later, so its stored
// code still has to resolve to something real. contract_services has no ledger_code column at all,
// so it is not part of this check.
function ledgerUsageCounts(codes) {
  const counts = {};
  if (!codes.length) return counts;
  const placeholders = codes.map(() => '?').join(',');
  for (const table of ['cash_out', 'contract', 'contractor_payments']) {
    for (const col of ['ledger_code', 'subledger_code']) {
      const rows = db.prepare(`SELECT ${col} AS code, COUNT(*) AS n FROM ${table} WHERE ${col} IN (${placeholders}) GROUP BY ${col}`).all(...codes);
      for (const r of rows) counts[r.code] = (counts[r.code] || 0) + r.n;
    }
  }
  return counts;
}

function ledgerReplaceAll(mains, subs) {
  db.exec('BEGIN');
  try {
    ledgerStmt.deleteSubs.run();
    ledgerStmt.deleteMains.run();
    mains.forEach((m, i) => ledgerStmt.insMain.run(m.code, m.name, i));
    subs.forEach((s, i) => ledgerStmt.insSub.run(s.code, s.mainCode, s.name, i));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function ledgerToCsv(list) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [LEDGER_CSV_HEADER];
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
// { ok:true, mains, subs } (ready for ledgerReplaceAll) or { ok:false, error, rowErrors }. The
// WHOLE file is rejected on any failure — this never does a partial import.
function validateLedgerCsv(csvText) {
  let rows;
  try { rows = parseLedgerCsv(csvText); } catch (e) { return { ok: false, error: 'Could not parse the file as CSV: ' + e.message, rowErrors: [] }; }
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
  const oldCodes = [...ledgerStmt.mains.all().map((m) => m.code), ...ledgerStmt.allSubs.all().map((s) => s.code)];
  const removedCodes = oldCodes.filter((c) => !newCodes.has(c));
  if (removedCodes.length) {
    const counts = ledgerUsageCounts(removedCodes);
    const stillUsed = removedCodes.filter((c) => counts[c] > 0).map((c) => ({ code: c, rows: counts[c] }));
    if (stillUsed.length) {
      return {
        ok: false,
        error: 'Some codes removed from this file are still used by existing rows: ' + stillUsed.map((u) => `${u.code} (${u.rows} row${u.rows === 1 ? '' : 's'})`).join(', ') + '.',
        rowErrors: stillUsed.map((u) => ({ row: null, message: `Code "${u.code}" is missing from the file but is still used by ${u.rows} existing row${u.rows === 1 ? '' : 's'}.` })),
      };
    }
  }

  return { ok: true, mains, subs };
}

const ledgers = {
  list: ledgerList,
  usageCounts: ledgerUsageCounts,
  replaceAll: ledgerReplaceAll,
  toCsv: ledgerToCsv,
  validateImport: validateLedgerCsv,
};

// ── delete-account: rows the user authored ────────────────────────────────────────────────────────
const authoredStmt = {
  cashIn: db.prepare('SELECT COUNT(*) AS n FROM cash_in WHERE by_user_id = ?'),
  cashOut: db.prepare('SELECT COUNT(*) AS n FROM cash_out WHERE by_user_id = ?'),
};
const authoredCount = (userId) => authoredStmt.cashIn.get(userId).n + authoredStmt.cashOut.get(userId).n;

// ── Backup export / teardown / insert ─────────────────────────────────────────────────────────────
// Tables come from a fixed server-side allowlist (BACKUP_TABLES); statements are cached by table (and
// by cols for insert). configure() pre-builds them at boot.
const _expCache = new Map(), _delCache = new Map();
const settingsUpsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
function exportStmtFor(table) { let s = _expCache.get(table); if (!s) { s = db.prepare(`SELECT * FROM ${table}`); _expCache.set(table, s); } return s; }
function deleteStmtFor(table) { let s = _delCache.get(table); if (!s) { s = db.prepare(`DELETE FROM ${table}`); _delCache.set(table, s); } return s; }
const backup = {
  exportTable: (table) => exportStmtFor(table).all(),
  deleteTenantRows: (table) => deleteStmtFor(table).run(),
  insertRow: (table, cols, vals) => insertStmtFor(table, cols).run(...vals),
  upsertSetting: (key, value) => settingsUpsert.run(key, value), // settings PK is now a plain key
};

// Pre-build every column/table-dependent statement at boot. Called by server.js once (after route
// setup) with its fixed allowlists.
function configure({ contractCols, backupTables, backupCols }) {
  if (contractCols) { insertStmtFor('contract', contractCols); updateStmtFor('contract', contractCols); }
  for (const table of (backupTables || [])) {
    if (table === 'settings') continue; // settings handled by settingsUpsert / exportStmtFor below
    exportStmtFor(table); deleteStmtFor(table);
    if (backupCols && backupCols[table]) insertStmtFor(table, backupCols[table]);
  }
  exportStmtFor('settings'); deleteStmtFor('settings');
}

export {
  crud, trash, configure,
  overview, contract, ledgerCustoms, ledgers, authoredCount, backup,
};
