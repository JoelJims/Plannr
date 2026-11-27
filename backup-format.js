// Phase 2, Step 1 — the JSON backup format, shared by BOTH backends: server.js (desktop/dev, Node,
// node:sqlite) and public/local-api.js (the phone, sqlite-wasm). It used to be copied into each
// file, and the copies had to be kept identical by hand; now there is exactly one definition, so the
// phone and the desktop cannot drift apart on what a backup contains or how it is restored.
// sync-public-modules.js copies this file into public/ like db.js and repo.js.
//
// Format versions
//   v1 (until Phase 2): the ledger tables + settings only. Restoring it onto a NEW phone lost the
//      categories (ledger_mains/ledger_subs), the saved custom category names (ledger_customs) and the
//      people (users) — and failed outright if the file used a category the new phone did not have.
//   v2 (current): everything needed to rebuild the app on a new phone — every table, plus the
//      AUTOINCREMENT high-water marks (sqlite_sequence), so a restored database hands out the same next
//      ids as the original. Password hashes from the retired login system are NEVER exported.
// v1 files still restore: the tables a v1 file does not carry (users and the category tables) are
// left exactly as they are on this install, and its category codes are checked against this
// install's categories — the same behaviour as before v2 existed.
//
// Every function that touches the database takes the async database interface as its first argument
// (core/db-adapter.js: get/all/run/exec/transaction, params as an array; step 1.4 B13) and returns a
// Promise, so this module has no imports of its own. validateBackup() reads only the file.

export const BACKUP_SCHEMA_VERSION = 2;
export const READABLE_BACKUP_VERSIONS = [1, 2];

// Insert order = parents before children (foreign keys are ON): users before cash_in/cash_out
// (by_user_id), ledger_mains before ledger_subs (main_code), contract before its children, and
// contract_services/contract_allowances before cash_out (contract_service_id/contract_allowance_id).
export const BACKUP_TABLES = [
  'users', 'ledger_mains', 'ledger_subs', 'ledger_customs',
  'contract', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments',
  'loans', 'settings', 'cash_in', 'cash_out',
];
// The tables v2 added. A v1 file does not carry them, so a v1 restore leaves this install's own copies alone.
export const V2_TABLES = ['users', 'ledger_mains', 'ledger_subs', 'ledger_customs'];
// Tables older v1 files may lack (they predate those features); absent reads as empty.
// Review finding F1 (2026-11-21): a backup's category codes must have the shapes Plannr makes itself
// (ledgers.js, and the Ledger List CSV's rule in repo.js): a category "N.0", a sub-category "N.M"
// under category "N.0". Every built-in code since the first taxonomy has these shapes.
const MAIN_CODE_RE = /^\d+\.0$/;
const SUB_CODE_RE = /^(\d+)\.(\d+)$/;
const OPTIONAL_V1_TABLES =['contract_payment_dates', 'contractor_payments', 'contract_services', 'contract_allowances'];

// TABLES THE IMPORT OWNS (clears during teardown), CHILDREN-FIRST so a DELETE never trips a foreign key
// and never leans on an implicit ON DELETE CASCADE. settings is never cleared (it is UPSERTed: keys the
// file lacks keep this install's value — several are migration markers). assertImportOwnershipComplete()
// fails at startup if a table with a foreign key into one of these is ever left out.
// `sessions` is the removed login's table (sessions.user_id -> users): databases first made by the
// two oldest schemas still have it after their upgrade, with dead rows. Owned, so the import clears it
// before `users` (only where it exists) and the start-up check accepts those databases (review Q1).
export const IMPORT_OWNED_TABLES = [
  'cash_out', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments',
  'contract', 'cash_in', 'loans', 'settings', 'ledger_customs', 'ledger_subs', 'ledger_mains', 'sessions', 'users',
];

// The exact columns exported and restored, per table. Every column of the live schema must be listed:
// the round-trip tests (test/backup-roundtrip.test.js and test-ui/backup-roundtrip.js) compare every
// table row by row, so a column added to db.js but forgotten here fails them.
export const BACKUP_COLS = {
  users: ['id', 'username', 'display_name', 'created_at'], // password_hash deliberately NOT exported
  ledger_mains: ['code', 'name', 'sort_order', 'created_at', 'updated_at'],
  ledger_subs: ['code', 'main_code', 'name', 'sort_order', 'created_at', 'updated_at'],
  ledger_customs: ['id', 'name', 'created_at'],
  contract: ['id', 'contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company',
    'rate_per_sqft_paise', 'measured_area_milli_sqft', 'completion_period_months', 'supervision_rate_pct', 'specified_brands', 'excluded_scope', 'owner_obligations',
    'created_at', 'updated_at', 'deleted_at'],
  // Contract Phase A dropped price_paise. An older backup that still carries the key imports fine —
  // rows are written through this explicit column list, so an extra key is ignored.
  contract_services: ['id', 'contract_id', 'name', 'created_at', 'updated_at', 'deleted_at'],
  contract_allowances: ['id', 'contract_id', 'name', 'cap_kind', 'cap_paise', 'cap_rate_per_sqft_paise', 'area_milli_sqft', 'sort_order', 'created_at', 'updated_at', 'deleted_at'],
  contract_payment_dates: ['id', 'contract_id', 'pay_date', 'created_at'],
  contractor_payments: ['id', 'contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'phase', 'subpart', 'remarks', 'created_at', 'updated_at', 'deleted_at'],
  loans: ['id', 'amount_paise', 'bank_name', 'interest_rate', 'tenure', 'created_at', 'updated_at', 'deleted_at'],
  settings: ['key', 'value'],
  cash_in: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason', 'created_at', 'updated_at', 'deleted_at'],
  cash_out: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_stated_paise', 'phase', 'subpart', 'contract_service_id', 'contract_allowance_id', 'created_at', 'updated_at', 'deleted_at'],
};
const PRIMARY_KEY = { ledger_mains: 'code', ledger_subs: 'code', settings: 'key' }; // everything else: id

// Phase 8B — settings keys that held contact details for the retired Daily Report feature. Left out
// of a user-facing export unless explicitly asked for, so a backup you share carries no personal data.
export const CONTACT_SETTINGS_KEYS = ['daily_report_recipients', 'daily_report_whatsapp'];
// What a restored user's password_hash is set to: there is no login, so no real hash is ever needed.
export const NO_PASSWORD = 'local-single-user-no-auth';

// (The adapter prepares each SQL text once and keeps it.)
const tableNames = async (adapter) => new Set((await adapter.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((r) => r.name));

// Startup drift guard: a table with a foreign key INTO an import-owned table, but not itself owned,
// would have its parent cleared under it by an import. Derived from the real schema. Rejects.
export async function assertImportOwnershipComplete(adapter) {
  const owned = new Set(IMPORT_OWNED_TABLES);
  const offenders = [];
  for (const t of await tableNames(adapter)) {
    for (const fk of await adapter.all(`PRAGMA foreign_key_list(${t})`)) {
      if (owned.has(fk.table) && !owned.has(t)) offenders.push(`${t}.${fk.from} -> ${fk.table}(${fk.to})`);
    }
  }
  if (offenders.length) {
    throw new Error(
      'IMPORT_OWNED_TABLES is incomplete — these tables have a foreign key into an import-owned table but ' +
      'are not themselves owned, so a backup import would clear their parent and cascade/orphan them ' +
      'silently: ' + offenders.join('; ') + '. Add them to IMPORT_OWNED_TABLES (children-first).'
    );
  }
}

// A full snapshot as a plain object — every table, every listed column, INCLUDING soft-deleted rows.
// includeContacts: the user-facing export leaves the retired contact keys out unless asked; the
// pre-import safety snapshot passes true (it is a local rollback file and must lose nothing).
export async function buildBackup(adapter, { includeContacts = false } = {}) {
  const present = await tableNames(adapter);
  const tables = {};
  for (const t of BACKUP_TABLES) {
    if (!present.has(t)) { tables[t] = []; continue; }
    tables[t] = (await adapter.all(`SELECT ${BACKUP_COLS[t].join(', ')} FROM ${t} ORDER BY ${PRIMARY_KEY[t] || 'id'}`)).map((r) => ({ ...r }));
  }
  if (!includeContacts) tables.settings = tables.settings.filter((r) => !CONTACT_SETTINGS_KEYS.includes(r.key));
  const sequences = {};
  if (present.has('sqlite_sequence') || await adapter.get("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")) {
    for (const r of await adapter.all('SELECT name, seq FROM sqlite_sequence ORDER BY name')) {
      if (BACKUP_TABLES.includes(r.name)) sequences[r.name] = r.seq;
    }
  }
  return { app: 'plannr', kind: 'plannr-backup', schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables, sequences };
}

// Strict, side-effect-free validation of an uploaded backup. Returns { ok: true } or { error }.
// ctx: { liveLedgerByCode: Map(code -> { subLedgers: [{ code }] }), customCode, parseIsoDate } — the
// category list a v1 file is checked against (a v2 file is checked against its OWN categories).
export function validateBackup(data, ctx) {
  const { liveLedgerByCode, customCode: CUSTOM_CODE, parseIsoDate } = ctx;
  const isInt = (v) => Number.isInteger(v);
  const optInt = (v) => v == null || Number.isInteger(v);
  const optStr = (v) => v == null || typeof v === 'string';
  const optNum = (v) => v == null || (typeof v === 'number' && Number.isFinite(v));
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'This is not a valid Plannr backup file.' };
  if (!READABLE_BACKUP_VERSIONS.includes(data.schemaVersion)) {
    return { error: `Unsupported backup version (found ${JSON.stringify(data.schemaVersion)}; this app restores versions ${READABLE_BACKUP_VERSIONS.join(' and ')}).` };
  }
  const full = data.schemaVersion >= 2;
  const T = data.tables;
  if (!T || typeof T !== 'object') return { error: 'Backup is missing its "tables" section.' };
  for (const t of BACKUP_TABLES) {
    if (V2_TABLES.includes(t) && !full) continue;
    if (!full && OPTIONAL_V1_TABLES.includes(t) && T[t] === undefined) continue; // older v1 files predate them
    if (!Array.isArray(T[t])) return { error: `Backup is missing or has an invalid "${t}" table.` };
  }

  // v2: the people and the categories travel with the file, and everything else is checked against them.
  let ledgerByCode = liveLedgerByCode;
  if (full) {
    if (!T.users.length) return { error: 'users: the backup has no users (it needs at least one).' };
    const usernames = new Set();
    for (const r of T.users) {
      if (!isInt(r.id)) return { error: 'users: a row has a non-integer id.' };
      if (!nonEmpty(r.username)) return { error: 'users: username must be a non-empty string.' };
      if (typeof r.display_name !== 'string') return { error: 'users: display_name must be a string.' };
      const u = r.username.toLowerCase();
      if (usernames.has(u)) return { error: `users: username ${JSON.stringify(r.username)} appears twice.` };
      usernames.add(u);
    }
    const mains = new Map();
    for (const r of T.ledger_mains) {
      if (!nonEmpty(r.code)) return { error: 'ledger_mains: code must be a non-empty string.' };
      if (!MAIN_CODE_RE.test(r.code)) return { error: `ledger_mains: code ${JSON.stringify(r.code)} is not a category code (a category's code is "N.0", like "22.0").` };
      if (mains.has(r.code)) return { error: `ledger_mains: code ${JSON.stringify(r.code)} appears twice.` };
      if (!nonEmpty(r.name)) return { error: `ledger_mains: category ${JSON.stringify(r.code)} needs a name.` };
      if (!isInt(r.sort_order)) return { error: 'ledger_mains: sort_order must be an integer.' };
      mains.set(r.code, { code: r.code, subLedgers: [] });
    }
    const subCodes = new Set();
    for (const r of T.ledger_subs) {
      if (!nonEmpty(r.code)) return { error: 'ledger_subs: code must be a non-empty string.' };
      const shape = SUB_CODE_RE.exec(r.code);
      if (!shape) return { error: `ledger_subs: code ${JSON.stringify(r.code)} is not a sub-category code (a sub-category's code is "N.M", like "22.5").` };
      if (subCodes.has(r.code)) return { error: `ledger_subs: code ${JSON.stringify(r.code)} appears twice.` };
      if (!mains.has(r.main_code)) return { error: `ledger_subs: ${JSON.stringify(r.code)} belongs to category ${JSON.stringify(r.main_code)}, which is not in the backup.` };
      if (r.main_code !== `${shape[1]}.0`) return { error: `ledger_subs: sub-category ${JSON.stringify(r.code)} is listed under category ${JSON.stringify(r.main_code)}, but its code says "${shape[1]}.0".` };
      if (!nonEmpty(r.name)) return { error: `ledger_subs: sub-category ${JSON.stringify(r.code)} needs a name.` };
      if (!isInt(r.sort_order)) return { error: 'ledger_subs: sort_order must be an integer.' };
      subCodes.add(r.code);
      mains.get(r.main_code).subLedgers.push({ code: r.code });
    }
    for (const r of T.ledger_customs) {
      if (!isInt(r.id)) return { error: 'ledger_customs: a row has a non-integer id.' };
      if (!nonEmpty(r.name)) return { error: 'ledger_customs: name must be a non-empty string.' };
    }
    if (data.sequences !== undefined) {
      if (!data.sequences || typeof data.sequences !== 'object' || Array.isArray(data.sequences)) return { error: 'Backup has an invalid "sequences" section.' };
      for (const [name, seq] of Object.entries(data.sequences)) {
        if (!BACKUP_TABLES.includes(name)) return { error: `sequences: unknown table ${JSON.stringify(name)}.` };
        // Q9: only a table with an id column has an AUTOINCREMENT sequence (the restore reads MAX(id)).
        if (!BACKUP_COLS[name] || !BACKUP_COLS[name].includes('id')) return { error: `sequences: ${name} has no id column, so it cannot have a sequence.` };
        if (!isInt(seq) || seq < 0) return { error: `sequences: ${name} must be a non-negative integer.` };
      }
    }
    ledgerByCode = mains;
  }
  const knownLedger = (code) => ledgerByCode.has(code);
  const subBelongs = (ledgerCode, subCode) => {
    const l = ledgerByCode.get(ledgerCode);
    return !!l && l.subLedgers.some((s) => s.code === subCode);
  };

  const contractIds = new Set();
  for (const r of T.contract) {
    if (!isInt(r.id)) return { error: 'contract: a row has a non-integer id.' };
    if (!optInt(r.amount_paise)) return { error: 'contract: amount_paise must be integer paise or null.' };
    if (!optInt(r.price_of_contract_paise)) return { error: 'contract: price_of_contract_paise must be integer paise or null.' };
    if (!optStr(r.area_of_work)) return { error: 'contract: area_of_work must be a string or null.' };
    if (!(r.ledger_code == null || r.ledger_code === CUSTOM_CODE || knownLedger(r.ledger_code))) return { error: `contract: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
    if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || (r.ledger_code != null && subBelongs(r.ledger_code, r.subledger_code)))) return { error: `contract: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
    { const d = parseIsoDate(r.date_signed); if (!(r.date_signed == null || (!d.error && d.date))) return { error: `contract: date_signed must be ISO YYYY-MM-DD or null (got ${JSON.stringify(r.date_signed)}).` }; }
    { const d = parseIsoDate(r.contract_end_date); if (!(r.contract_end_date == null || (!d.error && d.date))) return { error: `contract: contract_end_date must be ISO YYYY-MM-DD or null (got ${JSON.stringify(r.contract_end_date)}).` }; }
    if (!optStr(r.company)) return { error: 'contract: company must be a string or null.' };
    // Contract Phase A — rate-based pricing + optional metadata. All nullable.
    if (!optInt(r.rate_per_sqft_paise)) return { error: 'contract: rate_per_sqft_paise must be integer paise or null.' };
    if (!optInt(r.measured_area_milli_sqft)) return { error: 'contract: measured_area_milli_sqft must be an integer number of thousandths of a square foot, or null.' };
    if (!optInt(r.completion_period_months)) return { error: 'contract: completion_period_months must be a whole number of months or null.' };
    if (!optNum(r.supervision_rate_pct)) return { error: 'contract: supervision_rate_pct must be a number or null.' };
    for (const f of ['specified_brands', 'excluded_scope', 'owner_obligations']) {
      if (!optStr(r[f])) return { error: `contract: ${f} must be a string or null.` };
    }
    contractIds.add(r.id);
  }
  const serviceIds = new Set();
  for (const r of (T.contract_services || [])) {
    if (!isInt(r.id)) return { error: 'contract_services: a row has a non-integer id.' };
    if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contract_services: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'contract_services: name must be a non-empty string.' };
    serviceIds.add(r.id);
  }
  // A lump cap MUST have its rupee ceiling, a per-sqft cap MUST have its rate; the area stays optional.
  const allowanceIds = new Set();
  for (const r of (T.contract_allowances || [])) {
    if (!isInt(r.id)) return { error: 'contract_allowances: a row has a non-integer id.' };
    if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contract_allowances: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'contract_allowances: name must be a non-empty string.' };
    if (r.cap_kind !== 'lump' && r.cap_kind !== 'per_sqft') return { error: `contract_allowances: unknown cap_kind ${JSON.stringify(r.cap_kind)} (expected 'lump' or 'per_sqft').` };
    if (!optInt(r.cap_paise)) return { error: 'contract_allowances: cap_paise must be integer paise or null.' };
    if (!optInt(r.cap_rate_per_sqft_paise)) return { error: 'contract_allowances: cap_rate_per_sqft_paise must be integer paise or null.' };
    if (!optInt(r.area_milli_sqft)) return { error: 'contract_allowances: area_milli_sqft must be an integer number of thousandths of a square foot, or null.' };
    if (!optInt(r.sort_order)) return { error: 'contract_allowances: sort_order must be an integer or null.' };
    if (r.cap_kind === 'lump' && !isInt(r.cap_paise)) return { error: 'contract_allowances: a lump-sum allowance needs a cap_paise amount.' };
    if (r.cap_kind === 'per_sqft' && !isInt(r.cap_rate_per_sqft_paise)) return { error: 'contract_allowances: a per-square-foot allowance needs a cap_rate_per_sqft_paise rate.' };
    allowanceIds.add(r.id);
  }
  for (const r of (T.contract_payment_dates || [])) {
    if (!isInt(r.id)) return { error: 'contract_payment_dates: a row has a non-integer id.' };
    if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contract_payment_dates: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
    { const d = parseIsoDate(r.pay_date); if (d.error || !d.date) return { error: `contract_payment_dates: pay_date must be ISO YYYY-MM-DD (got ${JSON.stringify(r.pay_date)}).` }; }
  }
  for (const r of (T.contractor_payments || [])) {
    if (!isInt(r.id)) return { error: 'contractor_payments: a row has a non-integer id.' };
    if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contractor_payments: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
    { const d = parseIsoDate(r.pay_date); if (d.error || !d.date) return { error: `contractor_payments: pay_date must be ISO YYYY-MM-DD (got ${JSON.stringify(r.pay_date)}).` }; }
    if (!isInt(r.amount_paise) || r.amount_paise <= 0) return { error: 'contractor_payments: amount_paise must be a positive integer (paise).' };
    if (!(r.ledger_code == null || r.ledger_code === CUSTOM_CODE || knownLedger(r.ledger_code))) return { error: `contractor_payments: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
    if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || (r.ledger_code != null && subBelongs(r.ledger_code, r.subledger_code)))) return { error: `contractor_payments: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
  }
  for (const r of T.loans) {
    if (!isInt(r.id)) return { error: 'loans: a row has a non-integer id.' };
    if (!optInt(r.amount_paise)) return { error: 'loans: amount_paise must be integer paise or null.' };
    if (!optNum(r.interest_rate)) return { error: 'loans: interest_rate must be a number or null.' };
  }
  for (const r of T.settings) {
    if (typeof r.key !== 'string') return { error: 'settings: a row has a non-string key.' };
    if (!optStr(r.value)) return { error: 'settings: value must be a string or null.' };
  }
  for (const r of T.cash_in) {
    if (!isInt(r.id)) return { error: 'cash_in: a row has a non-integer id.' };
    if (!isInt(r.amount_paise) || r.amount_paise <= 0) return { error: 'cash_in: amount_paise must be a positive integer (paise).' };
    if (!['user', 'relative', 'custom'].includes(r.by_type)) return { error: `cash_in: invalid by_type ${JSON.stringify(r.by_type)}.` };
    if (!optInt(r.by_user_id)) return { error: 'cash_in: by_user_id must be an integer or null.' };
    // tx_date: ISO 'YYYY-MM-DD' or null. A pre-Phase-4 backup omits it (undefined -> null).
    { const d = parseIsoDate(r.tx_date); if (!(r.tx_date == null || (!d.error && d.date))) return { error: `cash_in: tx_date must be an ISO YYYY-MM-DD date or null (got ${JSON.stringify(r.tx_date)}).` }; }
  }
  for (const r of T.cash_out) {
    if (!isInt(r.id)) return { error: 'cash_out: a row has a non-integer id.' };
    if (!isInt(r.amount_paise) || r.amount_paise <= 0) return { error: 'cash_out: amount_paise must be a positive integer (paise).' };
    { const d = parseIsoDate(r.tx_date); if (!(r.tx_date == null || (!d.error && d.date))) return { error: `cash_out: tx_date must be an ISO YYYY-MM-DD date or null (got ${JSON.stringify(r.tx_date)}).` }; }
    // 'contractor' is still ACCEPTED here (legacy rows from old backups must import); only NEW form
    // writes reject it. Do not remove 'contractor' from this allowlist.
    if (!['user', 'contractor', 'custom'].includes(r.by_type)) return { error: `cash_out: invalid by_type ${JSON.stringify(r.by_type)}.` };
    if (!optInt(r.by_user_id)) return { error: 'cash_out: by_user_id must be an integer or null.' };
    if (!(r.ledger_code === CUSTOM_CODE || knownLedger(r.ledger_code))) return { error: `cash_out: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
    if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || subBelongs(r.ledger_code, r.subledger_code))) return { error: `cash_out: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
    if (!['included', 'extra'].includes(r.contract_scope)) return { error: `cash_out: invalid contract_scope ${JSON.stringify(r.contract_scope)}.` };
    // contract_stated_paise — the retired Phase 5E offset column, still round-tripped. Type-check only.
    if (!optInt(r.contract_stated_paise)) return { error: 'cash_out: contract_stated_paise must be an integer (paise) or null.' };
    if (!(r.contract_service_id == null || (isInt(r.contract_service_id) && serviceIds.has(r.contract_service_id)))) return { error: `cash_out: contract_service_id ${JSON.stringify(r.contract_service_id)} is not present in the backup's contract_services.` };
    if (!(r.contract_allowance_id == null || (isInt(r.contract_allowance_id) && allowanceIds.has(r.contract_allowance_id)))) return { error: `cash_out: contract_allowance_id ${JSON.stringify(r.contract_allowance_id)} is not present in the backup's contract_allowances.` };
  }
  return { ok: true };
}

// Replace the data with a VALIDATED backup, in ONE transaction (adapter.transaction(): any error rolls
// everything back, the current data is untouched, and the error is passed on for the caller to turn
// into a message). Resolves to { imported, remappedUsers }. A by_user_id that matches no user (in the
// file for v2, on this install for v1) is set to NULL and counted, so a missing person never fails a
// restore.
export async function applyBackup(adapter, data) {
  const T = data.tables;
  const full = data.schemaVersion >= 2;
  const present = await tableNames(adapter);
  const userIds = new Set((full ? T.users : await adapter.all('SELECT id FROM users')).map((u) => u.id));
  let remappedUsers = 0;

  await adapter.transaction(async (tx) => {
    for (const t of IMPORT_OWNED_TABLES) {
      if (t === 'settings' || (!full && V2_TABLES.includes(t)) || !present.has(t)) continue;
      await tx.run(`DELETE FROM ${t}`);
    }
    for (const t of BACKUP_TABLES) {
      if (!full && V2_TABLES.includes(t)) continue;
      if (t === 'settings') {
        for (const r of (T.settings || [])) {
          await tx.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [r.key, r.value === undefined ? null : r.value]);
        }
        continue;
      }
      const cols = t === 'users' ? [...BACKUP_COLS.users, 'password_hash'] : BACKUP_COLS[t];
      const sql = `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      for (const r of (T[t] || [])) {
        await tx.run(sql, cols.map((col) => {
          if (col === 'password_hash') return NO_PASSWORD;
          let val = r[col];
          if (col === 'by_user_id' && val != null && !userIds.has(val)) { val = null; remappedUsers++; }
          return val === undefined ? null : val;
        }));
      }
    }
    // The AUTOINCREMENT high-water marks, so the next id handed out matches the original database.
    // Never set one below a table's current max id (that would let SQLite reuse an id).
    if (full && data.sequences) {
      for (const [name, seq] of Object.entries(data.sequences)) {
        if (!present.has(name)) continue;
        const maxId = (await tx.get(`SELECT COALESCE(MAX(id), 0) AS m FROM ${name}`)).m;
        await tx.run('DELETE FROM sqlite_sequence WHERE name = ?', [name]);
        await tx.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [name, Math.max(seq, maxId)]);
      }
    }
  });
  const imported = {};
  for (const t of BACKUP_TABLES) if (full || !V2_TABLES.includes(t)) imported[t] = (T[t] || []).length;
  return { imported, remappedUsers };
}
