// Tenancy Phase 3 — the tenant data-access layer.
//
// EVERY read/write/aggregate touching one of the eight tenant-bearing tables lives here and is scoped
// by tenant_id. Route handlers call these functions with tenantId as the REQUIRED first argument; the
// raw table name never appears in a route. The tenant predicate is woven in centrally, so an
// unfiltered query is un-writable rather than merely discouraged.
//
// assertTenantScoped() is the boot backstop (modelled on assertImportOwnershipComplete): it scans every
// SQL string this module prepared and FAILS boot if one references a tenant table without a tenant_id
// predicate. It is coarse by design — node:sqlite can't cheaply expose prepared SQL, so we keep our own
// strings inspectable via P() — a SECOND line of defence, not the primary one.
//
// db.init() must have run before this module is required (server.js requires it right after init()).

const { db } = require('./db');

const TENANT_TABLES = ['cash_out', 'cash_in', 'loans', 'contract', 'contract_payment_dates', 'contractor_payments', 'contract_services', 'ledger_customs'];

// ── the registry + boot scan ─────────────────────────────────────────────────────────────────────
const REGISTERED = []; // every SQL string prepared through P()
function P(sql) { REGISTERED.push(sql); return db.prepare(sql); }

function assertTenantScoped() {
  const offenders = [];
  for (const sql of REGISTERED) {
    const s = sql.replace(/--[^\n]*/g, ' ');
    // A whole-word table name; '_' is a word char, so \bcontract\b never matches inside contract_services.
    const touches = TENANT_TABLES.some((t) => new RegExp('\\b' + t + '\\b').test(s));
    if (touches && !/\btenant_id\b/.test(s)) offenders.push(sql.replace(/\s+/g, ' ').trim().slice(0, 140));
  }
  if (offenders.length) {
    throw new Error(
      'repo: these prepared statements touch a tenant-bearing table but carry NO tenant_id predicate — ' +
      'an unfiltered query would leak/clobber another household. Scope them by tenant_id:\n  ' + offenders.join('\n  ')
    );
  }
}

// Inject `<alias>tenant_id = ? AND ` right after the leading WHERE of a fragment, preserving ORDER BY etc.
function scopeWhere(whereFrag, aliasDot) {
  return whereFrag.replace(/^\s*WHERE\s+/i, `WHERE ${aliasDot}tenant_id = ? AND `);
}

// ── generic CRUD (used by makeLedgerCrud) ────────────────────────────────────────────────────────
// config: { table, select, listWhere, byIdWhere, columns, alias } — alias is the table alias used in
// `select`/`listWhere`/`byIdWhere` ('c', 'cp', or '' for none). Returns tenantId-first runners.
function crud({ table, select, listWhere, byIdWhere, columns, alias = '', searchCols = null }) {
  const a = alias ? alias + '.' : '';
  const listStmt = P(`${select} ${scopeWhere(listWhere, a)}`);
  const byIdStmt = P(`${select} ${scopeWhere(byIdWhere, a)}`);
  const existsStmt = P(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`);
  const fullRowStmt = P(`SELECT * FROM ${table} WHERE tenant_id = ? AND id = ?`);
  const liveCountStmt = P(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND deleted_at IS NULL`);
  const insertStmt = P(`INSERT INTO ${table} (tenant_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`);
  const updateStmt = P(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`);
  const softDeleteStmt = P(`UPDATE ${table} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`);

  // Part A — SQL-side filtered search (opt-in via searchCols). Builds ONLY the active predicates so
  // the planner can use the right index per combination, always prefixed by `tenant_id = ? AND
  // deleted_at IS NULL`. Prepared statements are cached by filter SHAPE and registered through P(); a
  // build-time assertion mirrors assertTenantScoped for shapes first built after boot (the boot scan
  // has already run by then). searchCols maps filter -> column(s): { date, amount, ledger, subledger,
  // text: [cols] }.
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
      const sql = `${select} WHERE ${a}tenant_id = ? AND ${clauses.join(' AND ')} ORDER BY ${a}id ASC`;
      if (!/\btenant_id\b/.test(sql)) throw new Error('repo.crud.search built a statement with NO tenant_id predicate — refusing to prepare it.');
      return P(sql);
    };
    buildSearch(''); // pre-build the base (no-filter) shape at boot so assertTenantScoped() covers it
    // filters: { start, end, min, max, ledger, subledger, q } — any subset. tenantId is ALWAYS first.
    search = (t, f = {}) => {
      const shape = [], params = [t];
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
    list: (t) => listStmt.all(t),
    getById: (t, id) => byIdStmt.get(t, id),
    existsLive: (t, id) => !!existsStmt.get(t, id),
    fullRow: (t, id) => fullRowStmt.get(t, id),
    liveCount: (t) => liveCountStmt.get(t).n,
    insert: (t, vals) => insertStmt.run(t, ...vals),
    update: (t, id, vals) => updateStmt.run(...vals, t, id),
    softDelete: (t, id) => softDeleteStmt.run(t, id),
    search, // null unless searchCols was supplied
  };
}

// ── Recycle Bin (per-table, scoped) ──────────────────────────────────────────────────────────────
// config: { table, select, alias } — `select` is the resource's live SELECT (reused so trash labels
// match the live list). Returns tenantId-first runners for the deleted-only list + find/restore/hard-delete.
function trash({ table, select, alias = '' }) {
  const a = alias ? alias + '.' : '';
  // A `SELECT *` already carries deleted_at; otherwise expose it explicitly so the shaper + handler
  // can read it (matches the pre-Phase-3 trash selects exactly).
  const withDeleted = /^\s*SELECT\s+\*/i.test(select) ? select : select.replace(/^\s*SELECT /i, `SELECT ${a}deleted_at AS deleted_at, `);
  const listStmt = P(`${withDeleted} WHERE ${a}tenant_id = ? AND ${a}deleted_at IS NOT NULL ORDER BY ${a}deleted_at DESC`);
  const findStmt = P(`SELECT id FROM ${table} WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`);
  const restoreStmt = P(`UPDATE ${table} SET deleted_at = NULL, updated_at = datetime('now') WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`);
  const hardDeleteStmt = P(`DELETE FROM ${table} WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`);
  return {
    listDeleted: (t) => listStmt.all(t),
    find: (t, id) => findStmt.get(t, id),
    restore: (t, id) => restoreStmt.run(t, id),
    hardDelete: (t, id) => hardDeleteStmt.run(t, id),
  };
}

// ── Overview aggregates (the riskiest surface — 8 statements, all tenant-scoped) ──────────────────
const OV_OUTS_COLS = 'amount_paise, by_type, ledger_code, subledger_code, subledger_custom_name';
const OV_PAY_COLS = 'amount_paise, ledger_code, subledger_code, subledger_custom_name';
const ov = {
  cashoutCumulative: P(
    "SELECT COALESCE(SUM(CASE WHEN contract_stated_paise > 0 THEN contract_stated_paise ELSE 0 END), 0) AS offset, " +
    "COUNT(CASE WHEN contract_stated_paise IS NULL OR contract_stated_paise = 0 THEN 1 END) AS missCount, " +
    "COALESCE(SUM(CASE WHEN contract_stated_paise IS NULL OR contract_stated_paise = 0 THEN amount_paise ELSE 0 END), 0) AS missSum " +
    "FROM cash_out WHERE tenant_id = ? AND deleted_at IS NULL AND contract_scope = 'included'"
  ),
  contracts: P(
    `SELECT id, contractor_name, area_of_work, ledger_code, subledger_code, ledger_custom_name, subledger_custom_name, price_of_contract_paise
       FROM contract WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id ASC`
  ),
  paidByContract: P('SELECT contract_id, COUNT(*) AS c, COALESCE(SUM(amount_paise), 0) AS s FROM contractor_payments WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY contract_id'),
  outsAll: P(`SELECT ${OV_OUTS_COLS} FROM cash_out WHERE tenant_id = ? AND deleted_at IS NULL`),
  outsRange: P(`SELECT ${OV_OUTS_COLS} FROM cash_out WHERE tenant_id = ? AND deleted_at IS NULL AND tx_date >= ? AND tx_date <= ?`),
  paymentsAll: P(`SELECT ${OV_PAY_COLS} FROM contractor_payments WHERE tenant_id = ? AND deleted_at IS NULL`),
  paymentsRange: P(`SELECT ${OV_PAY_COLS} FROM contractor_payments WHERE tenant_id = ? AND deleted_at IS NULL AND pay_date >= ? AND pay_date <= ?`),
  loansSum: P('SELECT COALESCE(SUM(amount_paise), 0) AS s FROM loans WHERE tenant_id = ? AND deleted_at IS NULL'),
  // Part B — cash_out logged (created) since the last report's boundary timestamp (created_at is UTC ISO).
  outsSince: P("SELECT COUNT(*) AS c, COALESCE(SUM(amount_paise), 0) AS s FROM cash_out WHERE tenant_id = ? AND deleted_at IS NULL AND created_at > ?"),
};
const overview = {
  cashoutCumulative: (t) => ov.cashoutCumulative.get(t),
  contracts: (t) => ov.contracts.all(t),
  paidByContract: (t) => ov.paidByContract.all(t),
  outsAll: (t) => ov.outsAll.all(t),
  outsRange: (t, lo, hi) => ov.outsRange.all(t, lo, hi),
  paymentsAll: (t) => ov.paymentsAll.all(t),
  paymentsRange: (t, lo, hi) => ov.paymentsRange.all(t, lo, hi),
  loansSum: (t) => ov.loansSum.get(t),
  outsSince: (t, sinceIso) => ov.outsSince.get(t, sinceIso), // Part B — { c, s }
};

// ── Contract + services + payment dates ───────────────────────────────────────────────────────────
const cStmt = {
  list: P('SELECT * FROM contract WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id ASC'),
  getLive: P('SELECT * FROM contract WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'),
  existsLive: P('SELECT 1 FROM contract WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'),
  liveCount: P('SELECT COUNT(*) AS n FROM contract WHERE tenant_id = ? AND deleted_at IS NULL'),
  deletedAt: P('SELECT deleted_at FROM contract WHERE tenant_id = ? AND id = ?'),
  softDelete: P("UPDATE contract SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL"),
  payDatesFor: P('SELECT pay_date FROM contract_payment_dates WHERE tenant_id = ? AND contract_id = ? ORDER BY pay_date ASC, id ASC'),
  delPayDates: P('DELETE FROM contract_payment_dates WHERE tenant_id = ? AND contract_id = ?'),
  insPayDate: P('INSERT INTO contract_payment_dates (tenant_id, contract_id, pay_date) VALUES (?, ?, ?)'),
  servicesFor: P('SELECT id, name, price_paise FROM contract_services WHERE tenant_id = ? AND contract_id = ? AND deleted_at IS NULL ORDER BY id ASC'),
  serviceLive: P('SELECT * FROM contract_services WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'),
  serviceForContract: P('SELECT * FROM contract_services WHERE tenant_id = ? AND id = ? AND contract_id = ? AND deleted_at IS NULL'),
  insService: P('INSERT INTO contract_services (tenant_id, contract_id, name, price_paise) VALUES (?, ?, ?, ?)'),
  updService: P("UPDATE contract_services SET name = ?, price_paise = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?"),
  delService: P("UPDATE contract_services SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE tenant_id = ? AND id = ?"),
  livePaymentsFor: P('SELECT COUNT(*) AS n FROM contractor_payments WHERE tenant_id = ? AND contract_id = ? AND deleted_at IS NULL'),
  // Part C — best-effort overdue heuristic: is there a LIVE payment recorded on exactly this scheduled
  // (contract_id, pay_date)? There is no schedule↔payment FK, so this exact-date match is the only signal.
  paymentOnDate: P('SELECT 1 FROM contractor_payments WHERE tenant_id = ? AND contract_id = ? AND pay_date = ? AND deleted_at IS NULL LIMIT 1'),
  paymentsForAny: P('SELECT COUNT(*) AS n FROM contractor_payments WHERE tenant_id = ? AND contract_id = ?'),
  paymentContractId: P('SELECT contract_id FROM contractor_payments WHERE tenant_id = ? AND id = ?'),
  // Service one-offset guard (the safety-critical pair)
  serviceLivePriced: P('SELECT cs.id, cs.price_paise FROM contract_services cs JOIN contract c ON c.id = cs.contract_id WHERE cs.tenant_id = ? AND cs.id = ? AND cs.deleted_at IS NULL AND c.deleted_at IS NULL'),
  serviceClaimedByOther: P('SELECT id, tx_date, amount_paise FROM cash_out WHERE tenant_id = ? AND contract_service_id = ? AND deleted_at IS NULL AND id != ?'),
  cashOutServiceId: P('SELECT contract_service_id FROM cash_out WHERE tenant_id = ? AND id = ?'),
};
const contract = {
  list: (t) => cStmt.list.all(t),
  getLive: (t, id) => cStmt.getLive.get(t, id) || null,
  existsLive: (t, id) => !!cStmt.existsLive.get(t, id),
  liveCount: (t) => cStmt.liveCount.get(t).n,
  deletedAt: (t, id) => cStmt.deletedAt.get(t, id),
  softDelete: (t, id) => cStmt.softDelete.run(t, id),
  insert: (t, cols, vals) => insertInto('contract', t, cols, vals),
  update: (t, id, cols, vals) => updateBy('contract', t, id, cols, vals),
  payDatesFor: (t, cid) => cStmt.payDatesFor.all(t, cid).map((r) => r.pay_date),
  writePayDates: (t, cid, dates) => { cStmt.delPayDates.run(t, cid); for (const d of dates) cStmt.insPayDate.run(t, cid, d); },
  servicesFor: (t, cid) => cStmt.servicesFor.all(t, cid),
  serviceLive: (t, id) => cStmt.serviceLive.get(t, id) || null,
  serviceForContract: (t, cid, sid) => cStmt.serviceForContract.get(t, sid, cid) || null,
  insertService: (t, cid, name, price) => cStmt.insService.run(t, cid, name, price),
  updateService: (t, id, name, price) => cStmt.updService.run(name, price, t, id),
  softDeleteService: (t, id) => cStmt.delService.run(t, id),
  livePaymentsFor: (t, cid) => cStmt.livePaymentsFor.get(t, cid).n,
  paymentOnDate: (t, cid, payDate) => !!cStmt.paymentOnDate.get(t, cid, payDate), // Part C

  paymentsForAny: (t, cid) => cStmt.paymentsForAny.get(t, cid).n,
  paymentContractId: (t, id) => cStmt.paymentContractId.get(t, id),
  serviceLivePriced: (t, sid) => cStmt.serviceLivePriced.get(t, sid),
  serviceClaimedByOther: (t, sid, excludeId) => cStmt.serviceClaimedByOther.get(t, sid, excludeId),
  cashOutServiceId: (t, id) => cStmt.cashOutServiceId.get(t, id),
};

// Column-list INSERT/UPDATE (contract) — statements built ONCE at boot via configure() so the scan
// covers them; keyed by table|cols. Building a same-key statement later just reuses the cached one.
const _insCache = new Map(), _updCache = new Map();
function insertStmtFor(table, cols) {
  const key = table + '|' + cols.join(',');
  let stmt = _insCache.get(key);
  if (!stmt) { stmt = P(`INSERT INTO ${table} (tenant_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`); _insCache.set(key, stmt); }
  return stmt;
}
function updateStmtFor(table, cols) {
  const key = table + '|' + cols.join(',');
  let stmt = _updCache.get(key);
  if (!stmt) { stmt = P(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`); _updCache.set(key, stmt); }
  return stmt;
}
function insertInto(table, t, cols, vals) { return insertStmtFor(table, cols).run(t, ...vals); }
function updateBy(table, t, id, cols, vals) { return updateStmtFor(table, cols).run(...vals, t, id); }

// ── Per-user custom ledger names ──────────────────────────────────────────────────────────────────
const lcStmt = {
  list: P('SELECT name FROM ledger_customs WHERE tenant_id = ? ORDER BY name COLLATE NOCASE ASC'),
  save: P('INSERT OR IGNORE INTO ledger_customs (tenant_id, name) VALUES (?, ?)'),
  // Part 4 (Phase 11B): prune a name from the caller's pick-list. Tenant-scoped like the rest, so a
  // user can only remove their OWN saved names. Denormalised — cash_out rows keep their stored
  // ledger_custom_name copy, so this only shrinks the autocomplete list, never rewrites past debits.
  remove: P('DELETE FROM ledger_customs WHERE tenant_id = ? AND name = ?'),
};
const ledgerCustoms = {
  list: (t) => lcStmt.list.all(t).map((r) => r.name),
  save: (t, name) => lcStmt.save.run(t, name),
  remove: (t, name) => lcStmt.remove.run(t, name),
};

// ── delete-account: rows the user authored, within their own tenant ───────────────────────────────
const authoredStmt = {
  cashIn: P('SELECT COUNT(*) AS n FROM cash_in WHERE tenant_id = ? AND by_user_id = ?'),
  cashOut: P('SELECT COUNT(*) AS n FROM cash_out WHERE tenant_id = ? AND by_user_id = ?'),
};
const authoredCount = (t, userId) => authoredStmt.cashIn.get(t, userId).n + authoredStmt.cashOut.get(t, userId).n;

// ── Backup export / teardown / insert — all tenant-scoped ─────────────────────────────────────────
// Tables come from a fixed server-side allowlist (BACKUP_TABLES); statements are cached by table (and
// by cols for insert). configure() pre-builds them at boot so assertTenantScoped() covers them.
const _expCache = new Map(), _delCache = new Map();
const settingsUpsert = P('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value');
function exportStmtFor(table) { let s = _expCache.get(table); if (!s) { s = P(`SELECT * FROM ${table} WHERE tenant_id = ?`); _expCache.set(table, s); } return s; }
function deleteStmtFor(table) { let s = _delCache.get(table); if (!s) { s = P(`DELETE FROM ${table} WHERE tenant_id = ?`); _delCache.set(table, s); } return s; }
const backup = {
  exportTable: (t, table) => exportStmtFor(table).all(t),
  deleteTenantRows: (t, table) => deleteStmtFor(table).run(t),
  insertRow: (t, table, cols, vals) => insertStmtFor(table, cols).run(t, ...vals),
  upsertSetting: (t, key, value) => settingsUpsert.run(t, key, value), // settings composite (tenant_id, key)
};

// Pre-build every column/table-dependent statement at boot so the tenant-scope scan can see them all.
// Called by server.js once (after route setup) with its fixed allowlists, right before assertTenantScoped().
function configure({ contractCols, backupTables, backupCols }) {
  if (contractCols) { insertStmtFor('contract', contractCols); updateStmtFor('contract', contractCols); }
  for (const table of (backupTables || [])) {
    if (table === 'settings') continue; // settings handled by settingsUpsert / exportStmtFor below
    exportStmtFor(table); deleteStmtFor(table);
    if (backupCols && backupCols[table]) insertStmtFor(table, backupCols[table]);
  }
  exportStmtFor('settings'); deleteStmtFor('settings');
}

module.exports = {
  TENANT_TABLES, assertTenantScoped, crud, trash, configure,
  overview, contract, ledgerCustoms, authoredCount, backup,
  _registeredCount: () => REGISTERED.length,
};
