// Plannr — Express server.

// Load .env (if present) BEFORE anything reads process.env. Node built-in — no dotenv
// dependency. Real environment variables win over the file, and a missing .env is fine.
try { process.loadEnvFile(); } catch { /* no .env present */ }

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { db, init, DB_PATH, isStorageFullError } = require('./db');
const { encrypt } = require('./backup-crypto'); // Phase 10b — the pre-Ledger-List-import safety backup

// Shared IST (Asia/Kolkata) date/time stamps — used by the Overview PDF filename and
// upcoming-payment day counts. IST has no DST, so no seasonal complexity.
const IST_TZ = 'Asia/Kolkata';
function istDateStamp(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(d); }
function istStampFull(d = new Date()) {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: IST_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/^24:/, '00:');
  return `${istDateStamp(d)} ${hm} IST`;
}

const app = express();
app.disable('x-powered-by'); // don't advertise the framework/version
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SERVER_START = new Date(); // Phase 2 — process start time, surfaced by GET /api/health

init();

// Single-user offline app: no login, no sessions. The one existing users row is the fixed
// local owner; every request resolves to it, regardless of any cookie. There is no
// registration route, so a user row must already exist (seed-demo.js or a direct INSERT).
// Queried fresh per call (not resolved once at require-time): the test harness requires this
// module before seeding any user, so a value captured at load time would be permanently stale.
const OWNER_STMT = db.prepare('SELECT id, username, display_name AS displayName FROM users ORDER BY id ASC LIMIT 1');
const getOwner = () => OWNER_STMT.get();

// The data-access layer. Required AFTER init() so it can prepare its statements against the
// migrated schema. Every read/write touching one of the ledger tables goes through repo.*.
const repo = require('./repo');

// Hot prepared statements — hoisted here, AFTER init() has created and migrated every
// table (incl. the cash_out create-copy-swap rebuild and the contract_services drop), so
// each binds to the final schema. node:sqlite compiles each SQL once here instead of on
// every call. These sit on the hottest paths: computeOverview()'s four queries + getBudgetPaise()
// back the Overview screen and every PDF export.
// (Order matters — declaring these before init() would prepare against a pre-migration or
// dropped table. Keep them here.)
const BUDGET_STMT = db.prepare("SELECT value FROM settings WHERE key = 'budget_paise'");
// Phase 6C — computeOverview reads each ledger table BOTH cumulatively (a balance) and
// range-scoped (a period figure), so the two are split into separate queries:
//
//  These seven statements live in repo.overview.*. computeOverview calls repo.overview.<x>():
//  contracts, paidByContract, outsAll/outsRange, paymentsAll/paymentsRange, loansSum. The
//  cumulative aggregates are never range-filtered (owed is a running balance); the range forms
//  use the open sentinels + partial indexes.
// Phase 2: the user roster for the "By" attribution pickers (id + display name ONLY — never
// username/hash), and an existence check for validating a chosen by_user_id. Single-user app: the
// roster is just the one owner account.
const USERS_ROSTER_STMT = db.prepare('SELECT id, display_name AS displayName FROM users ORDER BY id ASC');
const USER_EXISTS_STMT = db.prepare('SELECT 1 FROM users WHERE id = ?');
const userExists = (id) => Number.isInteger(id) && !!USER_EXISTS_STMT.get(id);

// Two JSON body parsers: a tight 32kb cap for every normal route (no legitimate
// auth/ledger request is larger), and a larger cap reserved for the data-backup
// import, whose body is a full ledger export. The tight parser stays the global
// default; the import route opts into the larger one explicitly (below), so the
// 32kb hardening is unchanged everywhere else. Malformed JSON still -> 400.
const jsonSmall = express.json({ limit: '32kb' });
const jsonBackup = express.json({ limit: '20mb' });
// Phase 6B: Save All batches many changed cash_out rows into ONE request, so the 32kb cap is too
// small (≈90 rows). A dedicated 256kb parser (~700 rows) fits a whole realistic ledger in one
// round trip; the route ALSO caps the row count explicitly (BATCH_MAX_ROWS) with a clear message.
const jsonBatch = express.json({ limit: '256kb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/backup/import') return next(); // parsed by jsonBackup on the route
  if (req.method === 'POST' && /^\/api\/[a-z-]+\/batch$/.test(req.path)) return next(); // parsed by jsonBatch on the route
  jsonSmall(req, res, next);
});

// Single-user offline app: every request resolves to the fixed local owner, no session lookup.
function currentUser(req) { return getOwner(); }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Normalize a text field: coerce to string and trim. NOT for passwords — a
// leading or trailing space is a legitimate password character.
const str = (v) => String(v ?? '').trim();

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Keep: /api/me — 8 pages call it, 3 use the response to populate "By" dropdowns. Returns the
// fixed local owner with no auth check.
app.get('/api/me', (req, res) => {
  res.json({ user: getOwner() });
});

// User roster for the "By" attribution pickers. Auth-gated (requireApiAuth): a public
// roster would be a user-enumeration vector on the login page. Returns ONLY id +
// displayName, ordered by id — never username, password_hash, or created_at.
app.get('/api/users', requireApiAuth, (req, res) => {
  res.json({ users: USERS_ROSTER_STMT.all() });
});

// Phase 10b — the fixed ledger taxonomy itself (ledger_mains/ledger_subs), user-editable via CSV on
// the Data Backup page. GET returns the current list for dropdowns; the CSV pair is export/import.
app.get('/api/ledgers', requireApiAuth, (req, res) => {
  res.json({ ledgers: LEDGERS });
});
app.get('/api/ledgers/csv', requireApiAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="plannr-ledger-list-${istDateStamp()}.csv"`);
  res.send(repo.ledgers.toCsv(LEDGERS));
});
// Validate fully -> replace in ONE transaction -> refresh the in-memory cache. The mandatory
// pre-import encrypted backup (non-negotiable per spec) is sequenced by the CLIENT, which must call
// POST /api/backup/export-encrypted and have it succeed before it ever calls this route — appropriate
// for a single-user app where the only person who could skip that step is the same person the
// safety net protects, but noted here because it is a real design choice, not enforced server-side.
app.post('/api/ledgers/csv', requireApiAuth, (req, res) => {
  const csvText = typeof req.body.csv === 'string' ? req.body.csv : '';
  if (!csvText.trim()) return res.status(400).json({ error: 'No CSV content received.' });
  const v = repo.ledgers.validateImport(csvText);
  if (!v.ok) return res.status(400).json({ error: v.error, rowErrors: v.rowErrors });
  try {
    repo.ledgers.replaceAll(v.mains, v.subs);
  } catch (e) {
    if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — the ledger list was not saved. Free up space, then try again.' });
    return res.status(500).json({ error: 'Could not save the ledger list: ' + e.message });
  }
  refreshLedgers();
  res.json({ ok: true, ledgers: LEDGERS });
});

// Services phase (Part E) — the caller's saved custom LEDGER names, for the debit form's pick-list.
// FILTERED by the caller (a genuinely PER-USER list, unlike the shared household ledger tables), so
// one user's private category names are never visible to another. Names are auto-saved on first use
// (see saveLedgerCustom / afterWrite on cash_out). The 24 built-ins live in ledger_mains/ledger_subs
// (Phase 10b), not here — this table is only ever free-text CUSTOM names.
app.get('/api/ledger-customs', requireApiAuth, (req, res) => {
  res.json({ customs: repo.ledgerCustoms.list() });
});
// Part 4 (Phase 11B): remove a saved custom LEDGER name from the caller's pick-list — the delete path
// that was missing (a typo like "Cemnt" used to be stuck in the dropdown forever, and the Recycle Bin
// doesn't cover ledger_customs). Name passed as ?name= (query, so any characters survive encoding).
// Idempotent (removing an absent name is a no-op 200) and tenant-scoped in repo. Denormalised: past
// debits keep their stored ledger_custom_name, so this prunes the autocomplete only, never rewrites history.
app.delete('/api/ledger-customs', requireApiAuth, (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Which name? Pass it as ?name=…' });
  repo.ledgerCustoms.remove(name);
  res.json({ ok: true, customs: repo.ledgerCustoms.list() });
});

// ---------------------------------------------------------------------------
// Cash Inflow API (cash_in) + the shared "people" source. Logged-in only.
// Money is stored as INTEGER paise (₹1 = 100); the API accepts rupees in and
// returns paise out. Parameterized queries only; soft-delete (never hard).
// ---------------------------------------------------------------------------

// Single-user offline app: no auth check. Sets req.user to the fixed local owner (kept for any
// future per-request use; repo.js calls no longer take a tenant argument, so nothing currently
// reads req.user outside this assignment).
function requireApiAuth(req, res, next) {
  req.user = getOwner();
  next();
}

// Shared CRUD for the ledger list-tables (cash_in, loans; Cash Outflow will
// reuse this). Registers, for one resource: GET (list, oldest→newest, stable
// Sl.No) / POST (create) / PUT (edit) / DELETE (soft-delete). All logged-in only.
// Every behaviour that differs between resources — SQL, columns, validation,
// response keys, and error strings — is supplied via opts, so each route stays
// EXACTLY as before (same paths, JSON shapes, status codes, and error text).
const LEDGER_CRUDS = {}; // table -> its repo.crud runners (populated as each resource registers below)
function makeLedgerCrud(opts) {
  const { basePath, table, select, listWhere, byIdWhere, shape, columns, validate, listKey, itemKey, notFoundMsg, invalidIdMsg, editGate, auditField, finalize, afterWrite, alias } = opts;
  // ALL SQL for this resource is built by repo.crud. Handlers never touch the raw table.
  //  · finalize(values, { req, id, existing }) — after validate, before the write; may MUTATE values
  //    and/or return { error, status } to reject (e.g. the one-service-one-offset 409 guard).
  //  · afterWrite(values, { req, id }) — after a successful create/edit (e.g. save a custom name).
  //  · auditField — when an EDIT changes this raw column (by_user_id), log old->new.
  const rc = repo.crud({ table, select, listWhere, byIdWhere, columns, alias: alias || '', searchCols: opts.searchCols || null });
  LEDGER_CRUDS[table] = rc; // exposed so other tenant-scoped surfaces (e.g. the PDF's cash_out rows) reuse it
  const orderedVals = (values) => columns.map((c) => values[c]); // column values in declared order
  const byIdChain = editGate ? [requireApiAuth, editGate] : [requireApiAuth];

  app.get(basePath, requireApiAuth, (req, res) => {
    // Part A — when a resource opts into search (cash_out), any of ?q/start/end/min/max/ledger/subledger
    // filters the list IN SQL. Absent params → unchanged "all live rows" behaviour, so every other
    // resource and the no-filter fetch are untouched. `total` is the unfiltered live count (for
    // "N of M" + the add-form's next Sl.No, which must not shrink when a filter hides rows).
    if (opts.searchCols) {
      const f = parseLedgerFilters(req);
      if (f.error) return res.status(400).json({ error: f.error });
      return res.json({ [listKey]: rc.search(f.filters).map(shape), total: rc.liveCount(), filtered: f.active });
    }
    res.json({ [listKey]: rc.list().map(shape) });
  });

  app.post(basePath, requireApiAuth, (req, res) => {
    const v = validate(req);
    if (v.error) return res.status(400).json({ error: v.error });
    if (finalize) { const f = finalize(v.values, { req, id: null, existing: null }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
    const info = rc.insert(orderedVals(v.values));
    if (afterWrite) afterWrite(v.values, { req, id: Number(info.lastInsertRowid) });
    res.status(201).json({ ok: true, [itemKey]: shape(rc.getById(info.lastInsertRowid)) });
  });

  app.put(`${basePath}/:id`, ...byIdChain, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !rc.existsLive(id)) return res.status(404).json({ error: notFoundMsg });
    // Fetch the existing row for the audit old-value + finalize's `existing`.
    const existing = (finalize || afterWrite || auditField) ? rc.fullRow(id) : null;
    const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
    const v = validate(req, oldVal);
    if (v.error) return res.status(400).json({ error: v.error });
    if (finalize) { const f = finalize(v.values, { req, id, existing }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
    if (auditField && oldVal !== v.values[auditField]) console.warn(`[audit] ${table} id=${id}: ${auditField} ${oldVal} -> ${v.values[auditField]} (attribution changed on edit)`);
    rc.update(id, orderedVals(v.values));
    if (afterWrite) afterWrite(v.values, { req, id });
    res.json({ ok: true, [itemKey]: shape(rc.getById(id)) });
  });

  app.delete(`${basePath}/:id`, ...byIdChain, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: invalidIdMsg });
    const info = rc.softDelete(id);
    if (info.changes === 0) return res.status(404).json({ error: notFoundMsg });
    res.json({ ok: true });
  });

  // Phase 6B — batch edit (Save All in ONE round trip). Only registered for resources that opt in
  // (cash_out). Validates EVERY row FIRST, then writes only the valid rows in a SINGLE transaction,
  // and returns a per-row result array — so per-row hold-back survives exactly ("saved 19, held
  // back 1"): invalid/not-found rows are left untouched and individually reported. Phase 2.1
  // preserved: the attribution audit line logs per changed by_user_id, and a stored-NULL
  // by_user_id round-trips via validate(oldVal).
  if (opts.batch) {
    app.post(`${basePath}/batch`, jsonBatch, ...byIdChain, (req, res) => {
      const rows = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ error: 'Expected a { rows: [...] } array.' });
      if (rows.length > BATCH_MAX_ROWS) return res.status(413).json({ error: `Too many rows in one save (${rows.length}); the maximum is ${BATCH_MAX_ROWS}. Save in smaller batches.` });

      // 1) VALIDATE every row before any write. Not-found / invalid rows are recorded, not written.
      const results = new Array(rows.length);
      const toWrite = []; // { i, id, values, oldVal } for the rows that passed
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const id = Number(row && row.id);
        if (!Number.isInteger(id) || !rc.existsLive(id)) { results[i] = { id: row && row.id, ok: false, error: notFoundMsg }; continue; }
        const existing = (finalize || auditField) ? rc.fullRow(id) : null;
        const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
        const v = validate({ body: row }, oldVal);
        if (v.error) { results[i] = { id, ok: false, error: v.error }; continue; }
        if (finalize) { const f = finalize(v.values, { req, id, existing }); if (f && f.error) { results[i] = { id, ok: false, error: f.error }; continue; } }
        toWrite.push({ i, id, values: v.values, oldVal });
      }

      // 2) WRITE only the valid rows, in one transaction.
      db.exec('BEGIN');
      try {
        for (const w of toWrite) rc.update(w.id, orderedVals(w.values));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        if (!IS_PROD) console.error(`${table} batch write failed, rolled back:`, e);
        if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — this save did not go through. Free up space, then try again.' });
        return res.status(500).json({ error: 'The save failed and was rolled back — no rows were changed.' });
      }

      // 3) Audit each attribution change + shape the saved rows.
      for (const w of toWrite) {
        if (auditField && w.oldVal !== w.values[auditField]) console.warn(`[audit] ${table} id=${w.id}: ${auditField} ${w.oldVal} -> ${w.values[auditField]} (attribution changed on edit)`);
        if (afterWrite) afterWrite(w.values, { req, id: w.id });
        results[w.i] = { id: w.id, ok: true, [itemKey]: shape(rc.getById(w.id)) };
      }
      res.json({ results, saved: toWrite.length, failed: rows.length - toWrite.length });
    });
  }
}
// Phase 6B — explicit per-request cap for the batch endpoint (clear error instead of the opaque
// 256kb body-parser failure). ~700 rows fit in 256kb; 500 is a comfortable ceiling for one ledger.
const BATCH_MAX_ROWS = 500;

const CASH_IN_BY_TYPES = new Set(['user', 'relative', 'custom']);
const REASON_MAX = 300;
const LABEL_MAX = 60;

// Parse a rupees amount (string/number, up to 2 decimals, commas allowed) into
// an exact INTEGER number of paise using string math — no float rounding drift.
// Returns a positive safe integer, or null if invalid / not greater than 0.
function parsePaise(v) {
  const s = String(v == null ? '' : v).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [ip, dp = ''] = s.split('.');
  const paise = Number(ip) * 100 + Number((dp + '00').slice(0, 2));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

// Validate/resolve the "By" attribution from a request body. `existingByUserId` is the row's
// stored by_user_id on EDIT (the PUT path passes it); undefined on CREATE.
// -> { byType, byUserId, byLabel }  or  { error }.
function resolveBy(body, existingByUserId) {
  const byType = str(body.byType);
  if (!CASH_IN_BY_TYPES.has(byType)) return { error: 'Select who the money is from.' };
  if (byType === 'user') {
    // "By" records who PAID, not who entered the row — a shared, multi-user ledger — so any
    // real user is valid (create AND edit). Accept any existing by_user_id; reject unknowns.
    const id = Number(body.byUserId);
    if (Number.isInteger(id) && userExists(id)) return { byType, byUserId: id, byLabel: null };
    // Edit round-trip: an already-NULL attribution (backup-import remap of an unknown user)
    // must stay editable — preserve NULL when the stored value is already NULL and this edit
    // carries no real id. Create stays strict (existingByUserId is undefined there).
    if (existingByUserId === null && body.byUserId == null) return { byType, byUserId: null, byLabel: null };
    return { error: 'The selected user does not exist.' };
  }
  if (byType === 'relative') {
    return { byType, byUserId: null, byLabel: (str(body.byLabel) || 'Relative').slice(0, LABEL_MAX) };
  }
  const label = str(body.byLabel); // custom
  if (!label) return { error: 'Enter a name for the custom source.' };
  return { byType, byUserId: null, byLabel: label.slice(0, LABEL_MAX) };
}

const CASH_IN_SELECT =
  `SELECT c.id, c.amount_paise, c.tx_date, c.by_type, c.by_user_id, c.by_label, c.reason, c.created_at,
          u.display_name AS user_display_name
     FROM cash_in c
     LEFT JOIN users u ON u.id = c.by_user_id`;

// Shape a joined cash_in row into the API response object (amount in paise).
function cashInRow(r) {
  return {
    id: r.id,
    amountPaise: r.amount_paise,
    txDate: r.tx_date,   // Phase 4C: user-chosen inflow date, ISO 'YYYY-MM-DD' (may be null on legacy rows)
    byType: r.by_type,
    byUserId: r.by_user_id,
    byLabel: r.by_label,
    by: r.by_type === 'user' ? (r.user_display_name || 'Unknown') : (r.by_label || ''),
    reason: r.reason || '',
    createdAt: r.created_at,
  };
}

// Cash Inflow CRUD (cash_in) — shapes/strings preserved exactly via makeLedgerCrud.
makeLedgerCrud({
  basePath: '/api/cash-in',
  auditField: 'by_user_id', // Phase 2: log who-paid changes on edit
  table: 'cash_in',
  alias: 'c', // the table alias used in CASH_IN_SELECT
  select: CASH_IN_SELECT,
  listWhere: 'WHERE c.deleted_at IS NULL ORDER BY c.id ASC',
  byIdWhere: 'WHERE c.id = ?',
  shape: cashInRow,
  columns: ['amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason'],
  validate: (req, existingByUserId) => {
    const amountPaise = parsePaise(req.body.amountRupees);
    if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
    // Phase 4C — inflow date REQUIRED on new writes (ISO 'YYYY-MM-DD'), same rule as cash_out.tx_date.
    const txd = parseIsoDate(req.body.txDate);
    if (txd.error || !txd.date) return { error: 'Enter a valid date (YYYY-MM-DD).' };
    const by = resolveBy(req.body, existingByUserId);
    if (by.error) return { error: by.error };
    return { values: { amount_paise: amountPaise, tx_date: txd.date, by_type: by.byType, by_user_id: by.byUserId, by_label: by.byLabel, reason: str(req.body.reason).slice(0, REASON_MAX) } };
  },
  listKey: 'entries',
  itemKey: 'entry',
  notFoundMsg: 'Entry not found.',
  invalidIdMsg: 'Invalid entry id.',
});

// ---------------------------------------------------------------------------
// Loan Details API (loans). Logged-in only. Loan interest lives ONLY here (a
// plain rate on the loan) — never a ledger line. Money is INTEGER paise.
// ---------------------------------------------------------------------------
const BANK_MAX = 100;
const TENURE_MAX = 60;

// Optional non-negative interest rate (a plain number like 8.5, not money).
// -> { rate: number|null } or { error }.
function parseRate(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return { rate: null }; // optional
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: 'Interest rate must be a number (0 or more).' };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { error: 'Interest rate must be a number (0 or more).' };
  return { rate: n };
}

const LOANS_SELECT = 'SELECT id, amount_paise, bank_name, interest_rate, tenure, created_at FROM loans';

function loanRow(r) {
  return {
    id: r.id,
    amountPaise: r.amount_paise,
    bankName: r.bank_name || '',
    interestRate: r.interest_rate, // number or null
    tenure: r.tenure || '',
    createdAt: r.created_at,
  };
}

// Validate the shared loan fields from a request body.
// -> { amountPaise, bankName, rate, tenure } or { error }.
function readLoanBody(body) {
  const amountPaise = parsePaise(body.amountRupees);
  if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
  const bankName = str(body.bankName);
  if (!bankName) return { error: 'Bank name is required.' };
  const rate = parseRate(body.interestRate);
  if (rate.error) return { error: rate.error };
  return { amountPaise, bankName: bankName.slice(0, BANK_MAX), rate: rate.rate, tenure: str(body.tenure).slice(0, TENURE_MAX) };
}

// Loan Details CRUD (loans) — shapes/strings preserved exactly via makeLedgerCrud.
makeLedgerCrud({
  basePath: '/api/loans',
  table: 'loans',
  alias: '', // LOANS_SELECT has no table alias
  select: LOANS_SELECT,
  listWhere: 'WHERE deleted_at IS NULL ORDER BY id ASC',
  byIdWhere: 'WHERE id = ?',
  shape: loanRow,
  columns: ['amount_paise', 'bank_name', 'interest_rate', 'tenure'],
  validate: (req) => {
    const v = readLoanBody(req.body);
    if (v.error) return { error: v.error };
    return { values: { amount_paise: v.amountPaise, bank_name: v.bankName, interest_rate: v.rate, tenure: v.tenure } };
  },
  listKey: 'loans',
  itemKey: 'loan',
  notFoundMsg: 'Loan not found.',
  invalidIdMsg: 'Invalid loan id.',
});

// ---------------------------------------------------------------------------
// Cash Outflow API (cash_out) — money debited. Same CRUD conventions as
// cash_in/loans (makeLedgerCrud). Adds ledger/sub-ledger validation against the
// single-source ledgers.js, and a contract_scope. Money is INTEGER paise.
// ---------------------------------------------------------------------------
const CASH_OUT_BY_TYPES = new Set(['user', 'custom']); // Phase 1: 'contractor' removed (moves to a later Contractor Payments phase)
const CONTRACT_SCOPES = new Set(['included', 'extra']);
// Sentinel stored in ledger_code / subledger_code when the user typed a custom
// ledger or sub-ledger (the typed text goes in ledger_custom_name / subledger_
// custom_name). NOTE for a future Overview phase: ledger_code === CUSTOM_CODE is
// the grouping key — all custom entries roll up under one "Custom / Uncategorized".
const CUSTOM_CODE = 'CUSTOM';
const CUSTOM_NAME_MAX = 80;

// Phase 10b — the ledger taxonomy is DATA now (ledger_mains/ledger_subs, seeded from ledgers.js on
// first run — see db.js), not a static import: it can change at runtime via the Ledger List CSV
// import, so LEDGERS/LEDGER_BY_CODE are rebuilt on demand rather than frozen once at require time.
// refreshLedgers() is called once below and again after every successful CSV import.
let LEDGERS, LEDGER_BY_CODE;
function refreshLedgers() {
  LEDGERS = repo.ledgers.list();
  LEDGER_BY_CODE = new Map(LEDGERS.map((l) => [l.code, l]));
}
refreshLedgers();
const subBelongs = (ledgerCode, subCode) => {
  const l = LEDGER_BY_CODE.get(ledgerCode);
  return !!l && l.subLedgers.some((s) => s.code === subCode);
};
// Human-readable "code name" for a row — resolves all four cases (fixed/custom
// ledger × fixed/custom/none sub). Shows the sub if one is chosen, else the ledger.
function ledgerLabel(ledgerCode, subCode, ledgerCustom, subCustom) {
  if (subCode === CUSTOM_CODE) return subCustom || '';        // custom sub -> typed name
  if (subCode) {                                              // fixed sub -> "code name"
    const l = LEDGER_BY_CODE.get(ledgerCode);
    const s = l && l.subLedgers.find((x) => x.code === subCode);
    if (s) return `${s.code} ${s.name}`;
  }
  if (ledgerCode === CUSTOM_CODE) return ledgerCustom || '';  // custom ledger, no sub -> typed name
  const l = LEDGER_BY_CODE.get(ledgerCode);                   // fixed ledger, no sub -> "code name"
  return l ? `${l.code} ${l.name}` : (ledgerCode || '');
}

// Shared ledger + sub-ledger resolution/validation from a request body. The SINGLE
// source of ledger rules — used by cash_out and the contractor-payments ledger tag so
// they accept the same dropdown + 'CUSTOM' inputs with identical error strings. Returns
// { ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName } or { error }.
function resolveLedger(body) {
  // Ledger: a real fixed code, or the CUSTOM sentinel with a typed name.
  const ledgerCode = str(body.ledgerCode);
  let ledgerCustomName = null;
  if (ledgerCode === CUSTOM_CODE) {
    ledgerCustomName = str(body.ledgerCustomName);
    if (!ledgerCustomName) return { error: 'Enter a name for the custom ledger.' };
    ledgerCustomName = ledgerCustomName.slice(0, CUSTOM_NAME_MAX);
  } else if (!LEDGER_BY_CODE.has(ledgerCode)) {
    return { error: 'Select a valid ledger.' };
  }

  // Sub-ledger (optional): none, a real code (fixed ledger only, must belong),
  // or the CUSTOM sentinel with a typed name.
  let subledgerCode = str(body.subledgerCode);
  let subledgerCustomName = null;
  if (!subledgerCode) {
    subledgerCode = null; // — none —
  } else if (subledgerCode === CUSTOM_CODE) {
    subledgerCustomName = str(body.subledgerCustomName);
    if (!subledgerCustomName) return { error: 'Enter a name for the custom sub-ledger.' };
    subledgerCustomName = subledgerCustomName.slice(0, CUSTOM_NAME_MAX);
  } else if (ledgerCode === CUSTOM_CODE) {
    return { error: 'A custom ledger cannot use a fixed sub-ledger.' };
  } else if (!subBelongs(ledgerCode, subledgerCode)) {
    return { error: 'Sub-ledger does not belong to the selected ledger.' };
  }

  return { ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName };
}

// "By" for outflow: {user, custom} only. Phase 1 removed 'contractor' — contractor
// spending is no longer recorded as an outflow (a later phase adds a dedicated tab).
// A NEW write with by_type='contractor' is rejected with a clear 400; existing legacy
// 'contractor' rows are left untouched in the DB (this function never rewrites them).
function resolveCashOutBy(body, existingByUserId) {
  const byType = str(body.byType);
  if (byType === 'contractor') return { error: 'Contractor spending is no longer recorded as an outflow.' };
  if (!CASH_OUT_BY_TYPES.has(byType)) return { error: 'Select who the money is from.' };
  if (byType === 'user') {
    // "By" records who PAID, not who entered the row — shared ledger, so any real user is a
    // valid attribution (create AND edit). Accept any existing by_user_id; reject unknowns.
    const id = Number(body.byUserId);
    if (Number.isInteger(id) && userExists(id)) return { byType, byUserId: id, byLabel: null };
    // Edit round-trip: preserve an already-NULL attribution (import remap of an unknown user)
    // so its other fields stay editable. Create stays strict (existingByUserId undefined there).
    if (existingByUserId === null && body.byUserId == null) return { byType, byUserId: null, byLabel: null };
    return { error: 'The selected user does not exist.' };
  }
  const label = str(body.byLabel); // custom
  if (!label) return { error: 'Enter a name for the custom source.' };
  return { byType, byUserId: null, byLabel: label.slice(0, LABEL_MAX) };
}

const CASH_OUT_SELECT =
  `SELECT c.id, c.amount_paise, c.tx_date, c.by_type, c.by_user_id, c.by_label, c.ledger_code,
          c.subledger_code, c.ledger_custom_name, c.subledger_custom_name, c.reason,
          c.contract_scope, c.contract_stated_paise, c.contract_service_id, c.contract_allowance_id, c.created_at,
          u.display_name AS user_display_name
     FROM cash_out c
     LEFT JOIN users u ON u.id = c.by_user_id`;

function cashOutRow(r) {
  return {
    id: r.id,
    amountPaise: r.amount_paise,
    txDate: r.tx_date,    // user-chosen transaction date, ISO 'YYYY-MM-DD' (may be null on legacy rows)
    byType: r.by_type,
    byUserId: r.by_user_id,
    byLabel: r.by_label,
    by: r.by_type === 'user' ? (r.user_display_name || 'Unknown') : (r.by_label || ''),
    ledgerCode: r.ledger_code,
    subledgerCode: r.subledger_code,
    ledgerCustomName: r.ledger_custom_name,
    subledgerCustomName: r.subledger_custom_name,
    ledger: ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name), // resolved (fixed or custom)
    reason: r.reason || '',
    contractScope: r.contract_scope,
    contractStatedPaise: r.contract_stated_paise, // LEGACY (Phase 5E offset). No longer written or used in any maths.
    contractServiceId: r.contract_service_id,     // Services phase: the linked service (provenance), or null
    contractAllowanceId: r.contract_allowance_id, // Contract Phase A: the allowance this spend draws against, or null
    createdAt: r.created_at,
  };
}

// Services phase (Part E) — remember a typed custom LEDGER name in the caller's per-user list, so it is
// selectable next time. INSERT OR IGNORE keys on idx_ledger_customs_tenant_name (no duplicates). Called
// via afterWrite only when the row actually uses a custom ledger; a built-in ledger saves nothing.
const saveLedgerCustom = (values) => {
  if (values.ledger_code === CUSTOM_CODE && values.ledger_custom_name && values.ledger_custom_name.trim()) {
    repo.ledgerCustoms.save(values.ledger_custom_name.trim());
  }
};

// Resolve + guard the two CONTRACT LINKS a debit can carry: the service it was for (provenance) and
// the allowance it draws against. Runs AFTER validate, BEFORE the write, so it can MUTATE values and
// reject with a status. finalize runs with ctx.req present (single POST/PUT + the batch loop pass req).
//
// The two links are deliberately NOT symmetrical:
//   · SERVICE — at most one LIVE debit per service (idx_cash_out_service_live is the DB backstop;
//     this gives the clean, naming 409). Pure provenance: it moves no figure.
//     Contract Phase A removed the "only a PRICED service is linkable" rule along with the column —
//     services carry no price now, so every live service is selectable.
//   · ALLOWANCE — many debits per allowance, by design. An allowance is a CAP with a RUNNING spend;
//     a uniqueness rule here would break the feature. It moves no figure either: the cap position is
//     displayed, and the contract's settlement of an overrun/underrun stays the owner's to make.
function cashOutContractLinksFinalize(values, { existing }) {
  // Only an 'included' debit may carry either link; 'extra' forces both NULL so a stale link can't
  // linger if the scope flips back.
  if (values.contract_scope !== 'included') {
    values.contract_service_id = null;
    values.contract_allowance_id = null;
    return;
  }

  // undefined = the body did not send the key (the editable table doesn't) -> PRESERVE the existing
  // link on edit; on create there is no existing, so it's NULL (manual entry).
  let sid = values.contract_service_id;
  if (sid === undefined) sid = existing ? existing.contract_service_id : null;
  if (sid == null) values.contract_service_id = null;
  else {
    if (!repo.contract.serviceLinkable(sid)) return { status: 400, error: 'That contract service was not found — pick a listed service, or leave it blank.' };
    const other = repo.contract.serviceClaimedByOther(sid, existing ? existing.id : -1);
    if (other) {
      return { status: 409, error: `That service is already linked to entry #${other.id} (${fmtRs(other.amount_paise)} on ${other.tx_date}). One service can be linked to only one entry — unlink it there first, or pick another service.` };
    }
    values.contract_service_id = sid;
  }

  let aid = values.contract_allowance_id;
  if (aid === undefined) aid = existing ? existing.contract_allowance_id : null;
  if (aid == null) { values.contract_allowance_id = null; return; }
  if (!repo.contract.allowanceLinkable(aid)) return { status: 400, error: 'That allowance was not found — pick a listed allowance, or leave it blank.' };
  values.contract_allowance_id = aid;
}

makeLedgerCrud({
  basePath: '/api/cash-out',
  alias: 'c', // the table alias used in CASH_OUT_SELECT
  batch: true, // Phase 6B: POST /api/cash-out/batch — Save All in one round trip (both pages)
  auditField: 'by_user_id', // Phase 2: log who-paid changes on edit
  finalize: cashOutContractLinksFinalize,              // service link + one-live-debit guard, and the allowance draw
  afterWrite: (values) => saveLedgerCustom(values), // Part E: remember a custom ledger name
  table: 'cash_out',
  select: CASH_OUT_SELECT,
  listWhere: 'WHERE c.deleted_at IS NULL ORDER BY c.id ASC',
  byIdWhere: 'WHERE c.id = ?',
  // Part A — SQL-side search/filter columns (see repo.crud). Text search spans the remark + the two
  // custom names; ledger/sub are equality; date + amount are ranges (sargable, sentinel-padded).
  searchCols: { date: 'tx_date', amount: 'amount_paise', ledger: 'ledger_code', subledger: 'subledger_code', text: ['reason', 'ledger_custom_name', 'subledger_custom_name'] },
  shape: cashOutRow,
  // contract_stated_paise is deliberately ABSENT from this list: new rows get NULL, and an edit of a
  // legacy row leaves its stored value untouched (the column is never in the UPDATE ... SET list).
  columns: ['amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_service_id', 'contract_allowance_id'],
  validate: (req, existingByUserId) => {
    const amountPaise = parsePaise(req.body.amountRupees);
    if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };

    // Phase 1: transaction date is REQUIRED (ISO 'YYYY-MM-DD'). Reuse parseIsoDate
    // (also used for the contract end date). Missing -> 400; malformed -> 400.
    const txd = parseIsoDate(req.body.txDate);
    if (txd.error) return { error: txd.error };
    if (!txd.date) return { error: 'Select a date for this entry.' };

    const by = resolveCashOutBy(req.body, existingByUserId);
    if (by.error) return { error: by.error };

    // Ledger + sub-ledger (fixed-or-CUSTOM) — shared with the standalone ledger picker.
    const led = resolveLedger(req.body);
    if (led.error) return { error: led.error };
    const { ledgerCode, subledgerCode, ledgerCustomName, subledgerCustomName } = led;

    // Contract Included (Yes=included / No=extra) tag. Values unchanged; only the
    // display label changed. It is NOT the removed service-link feature.
    const contractScope = str(req.body.contractScope);
    if (!CONTRACT_SCOPES.has(contractScope)) return { error: 'Select whether the work is included in the contract (Yes or No).' };

    // The Phase 5E reimbursement offset is GONE: contractStatedRupees is no longer read, and
    // contract_stated_paise is no longer written (see the `columns` note above). 'included' is now a
    // purely descriptive label. A body that still sends contractStatedRupees is silently ignored
    // rather than rejected, so an older client / stale tab cannot 400 on an otherwise valid entry.

    // Services phase (Part C/D) — the picked service id, recorded as PROVENANCE (which service this
    // spend was for). Manual entry stays valid: no contractServiceId means no link. undefined (key
    // absent, e.g. the editable table) tells finalize() to PRESERVE the existing link on edit;
    // null/'' clears it; a number is validated + guarded there.
    let contractServiceId; // undefined = not sent
    if ('contractServiceId' in req.body) {
      const raw = req.body.contractServiceId;
      if (raw == null || raw === '') contractServiceId = null;
      else { const n = Number(raw); if (!Number.isInteger(n) || n <= 0) return { error: 'Invalid service selection.' }; contractServiceId = n; }
    }

    // Contract Phase A — which allowance cap this spend draws against. Same undefined/null/number
    // convention as the service link above, resolved and validated in finalize().
    let contractAllowanceId; // undefined = not sent
    if ('contractAllowanceId' in req.body) {
      const raw = req.body.contractAllowanceId;
      if (raw == null || raw === '') contractAllowanceId = null;
      else { const n = Number(raw); if (!Number.isInteger(n) || n <= 0) return { error: 'Invalid allowance selection.' }; contractAllowanceId = n; }
    }

    return {
      values: {
        amount_paise: amountPaise,
        tx_date: txd.date,
        by_type: by.byType,
        by_user_id: by.byUserId,
        by_label: by.byLabel,
        ledger_code: ledgerCode,
        subledger_code: subledgerCode,
        ledger_custom_name: ledgerCustomName,
        subledger_custom_name: subledgerCustomName,
        reason: str(req.body.reason).slice(0, REASON_MAX),
        contract_scope: contractScope,
        contract_service_id: contractServiceId,     // finalize() resolves/guards this (may be undefined)
        contract_allowance_id: contractAllowanceId, // ditto
      },
    };
  },
  listKey: 'entries',
  itemKey: 'entry',
  notFoundMsg: 'Entry not found.',
  invalidIdMsg: 'Invalid entry id.',
});

// ---------------------------------------------------------------------------
// Contract Details API. Logged-in only. Resource: contracts — a normal
// add/edit/soft-delete list (/api/contracts). Each has contractor + area + a
// headline ledger tag + an optional free-form amount + an OPTIONAL stated amount +
// date signed + optional date ends + 0..many scheduled payment dates
// (contract_payment_dates child). Money is INTEGER paise throughout.
// ---------------------------------------------------------------------------
const CONTRACTOR_MAX = 100;

// Optional ISO 'YYYY-MM-DD' date. Empty -> null. Rejects malformed or impossible
// dates (e.g. 2026-13-40). -> { date: string|null } or { error }.
function parseIsoDate(v) {
  const s = str(v);
  if (s === '') return { date: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: 'Enter a valid date (YYYY-MM-DD).' };
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: 'Enter a valid date (YYYY-MM-DD).' };
  }
  return { date: s };
}

// Part A — an OPTIONAL amount filter bound (rupees). Empty -> no bound (null). Otherwise a valid
// positive paise amount (reuses parsePaise). -> { paise: number|null } or { error }.
function parseAmountFilter(v) {
  const s = str(v);
  if (s === '') return { paise: null };
  const p = parsePaise(s);
  if (p === null) return { error: 'invalid' };
  return { paise: p };
}

// Part A — parse the outflow search/filter query into a repo.crud.search filters object. Every field is
// optional; an all-empty query means "no filters" (active:false → the full list). Dates reuse
// parseIsoDate; amounts reuse parsePaise via parseAmountFilter; text/ledger are bounded-length strings.
function parseLedgerFilters(req) {
  const q = str(req.query.q).slice(0, 100).trim();
  const s = parseIsoDate(req.query.start); if (s.error) return { error: 'Enter a valid start date (YYYY-MM-DD).' };
  const e = parseIsoDate(req.query.end); if (e.error) return { error: 'Enter a valid end date (YYYY-MM-DD).' };
  if (s.date && e.date && s.date > e.date) return { error: 'Start date must be on or before the end date.' };
  const min = parseAmountFilter(req.query.min); if (min.error) return { error: 'Enter a valid minimum amount (greater than 0).' };
  const max = parseAmountFilter(req.query.max); if (max.error) return { error: 'Enter a valid maximum amount (greater than 0).' };
  if (min.paise != null && max.paise != null && min.paise > max.paise) return { error: 'The minimum amount must be less than or equal to the maximum.' };
  const ledger = str(req.query.ledger).slice(0, 40) || null;
  const subledger = ledger ? (str(req.query.subledger).slice(0, 40) || null) : null;
  const filters = { start: s.date, end: e.date, min: min.paise, max: max.paise, ledger, subledger, q: q || null };
  const active = !!(filters.start || filters.end || filters.min != null || filters.max != null || filters.ledger || filters.q);
  return { filters, active };
}

// Optional manually-typed total price. Empty -> null; otherwise a valid positive
// paise amount (reuses parsePaise). -> { paise: number|null } or { error }.
function parsePriceOptional(v) {
  const s = str(v);
  if (s === '') return { paise: null };
  const paise = parsePaise(s);
  if (paise === null) return { error: 'Enter a valid price greater than 0 (up to 2 decimals).' };
  return { paise };
}

const AREA_MAX = 200;

// ---------------------------------------------------------------------------
// Contract Phase A — the contract is a FIXED UNIT-RATE LUMP SUM: its price is a rate per square
// foot times the final measured built-up area. The helpers below are what that costs.
// ---------------------------------------------------------------------------

// Areas are stored as INTEGER thousandths of a square foot, for the same reason money is stored as
// integer paise: rate x area has to be exact integer arithmetic. Accepts up to 3 decimals.
const MILLI_PER_SQFT = 1000;
function parseAreaOptional(v) {
  const t = str(v).replace(/,/g, '');
  if (t === '') return { milli: null };
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return { error: 'Enter a valid area in square feet (up to 3 decimals), or leave it blank.' };
  const [ip, dp = ''] = t.split('.');
  const milli = Number(ip) * MILLI_PER_SQFT + Number((dp + '000').slice(0, 3));
  if (!Number.isSafeInteger(milli) || milli <= 0) return { error: 'Enter an area greater than 0 square feet.' };
  return { milli };
}

// rate (paise per sq ft) x area (milli-sq-ft) -> paise. Returns null unless BOTH are present: one
// half of a rate price is not a price, and guessing the other half is exactly the invented-number
// problem that got contract_services.price_paise removed. Also used for a per-sqft allowance
// ceiling, which is the same shape of calculation.
function unitPricePaise(ratePaise, areaMilli) {
  if (ratePaise == null || areaMilli == null) return null;
  const product = ratePaise * areaMilli;
  if (!Number.isSafeInteger(product)) return null; // absurd inputs; the parsers below reject them first
  return Math.round(product / MILLI_PER_SQFT);
}

// Optional whole number in [min, max]. Blank -> null.
function parseWholeOptional(v, min, max, message) {
  const t = str(v).replace(/,/g, '');
  if (t === '') return { value: null };
  if (!/^\d+$/.test(t)) return { error: message };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < min || n > max) return { error: message };
  return { value: n };
}

// Optional percentage, 0–100, up to 2 decimals. Blank -> null. Stored as a REAL because it is a
// RATE, not money — and, exactly like loans.interest_rate, it drives no calculation anywhere: it
// records what the contract says the supervision charge on a change order is. Nothing multiplies
// by it, so no rounding rule is needed and none is implied.
function parsePercentOptional(v) {
  const t = str(v).replace(/,/g, '');
  if (t === '') return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: 'Enter a supervision rate between 0 and 100 percent (up to 2 decimals), or leave it blank.' };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { error: 'Enter a supervision rate between 0 and 100 percent (up to 2 decimals), or leave it blank.' };
  return { value: n };
}

// date_signed + N whole months, clamped to the end of the target month (31 Jan + 1 month = 28/29
// Feb, never 2/3 Mar). Pure string maths on the ISO date — no Date parsing of the input, so no
// timezone can shift it. '' when either half is missing: an expected completion date with no
// signing date to count from would be a fabricated one.
function addMonthsIso(iso, months) {
  if (!iso || months == null) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const total = y * 12 + (mo - 1) + months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate(); // day 0 of month nm+1 = last day of nm
  const nd = Math.min(d, lastDay);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(ny, 4)}-${pad(nm, 2)}-${pad(nd, 2)}`;
}

const NOTE_MAX = 2000;      // each of the three free-text contract notes
const ALLOWANCE_NAME_MAX = 120;
const ALLOWANCE_KINDS = new Set(['lump', 'per_sqft']);
const MAX_MONTHS = 600;     // 50 years — a typo guard, not a domain rule

// A service is a NAME and nothing else (Contract Phase A removed price_paise — the contract's
// schedule of work attaches no price to any scope item).
const serviceRow = (s) => ({ id: s.id, name: s.name });

// One allowance row, with its DERIVED position. `spend` is this row's entry from
// repo.contract.allowanceSpendFor(), or undefined when nothing has been drawn against it yet.
//
// effectiveCapPaise is the rupee ceiling this row can actually be measured against:
//   · 'lump'     -> cap_paise, always present.
//   · 'per_sqft' -> the ceiling RATE times the area this allowance covers. With no area recorded
//                   there IS no rupee ceiling, so it stays null and positionPaise stays null too —
//                   the row reports its ceiling as a rate and declines to compute an over/under
//                   rather than inventing an area to make one appear.
// positionPaise is SIGNED: positive = under the cap, negative = over it. Plannr only DISPLAYS it.
// Where a contract says an overrun is added to the next progress payment and an underrun subtracted
// from the final, that is a settlement the owner performs, not one this app performs for them.
// Nothing here feeds owed, Total contract, or any Overview figure.
const allowanceRow = (a, spend) => {
  const spentPaise = spend ? spend.spentPaise : 0;
  const effectiveCapPaise = a.cap_kind === 'per_sqft'
    ? unitPricePaise(a.cap_rate_per_sqft_paise, a.area_milli_sqft)
    : a.cap_paise;
  return {
    id: a.id,
    name: a.name,
    capKind: a.cap_kind,
    capPaise: a.cap_paise,
    capRatePerSqftPaise: a.cap_rate_per_sqft_paise,
    areaMilliSqft: a.area_milli_sqft,
    effectiveCapPaise,
    spentPaise,
    entryCount: spend ? spend.entryCount : 0,
    positionPaise: effectiveCapPaise == null ? null : effectiveCapPaise - spentPaise,
  };
};

// Shape a contract row for the API.
//
// Contract Phase A changed two things here:
//   · servicesPricedTotalPaise / remainderPaise are GONE. The remainder was "stated total − Σ priced
//     services", and with no service carrying a price it could only ever equal the stated total —
//     a line that restated a number already on screen and implied services were meant to add up to
//     it. The services list is a scope list now, so there is nothing to subtract.
//   · statedAmountPaise may now be DERIVED. When a rate and a measured area are both recorded, the
//     stated price is their product and price_of_contract_paise is rewritten to match on every
//     contract write; `pricingMode` says which it is, so the UI never presents a computed figure as
//     something the owner typed. Dues maths is untouched: owed still reads the one stored column.
const contractRow = (r) => {
  const spend = repo.contract.allowanceSpendFor(r.id);
  const computedPricePaise = unitPricePaise(r.rate_per_sqft_paise, r.measured_area_milli_sqft);
  return {
    id: r.id,
    contractorName: r.contractor_name || '',
    company: r.company || '',                     // Part F: optional company/firm (presentation only)
    areaOfWork: r.area_of_work || '',
    ledgerCode: r.ledger_code,
    subledgerCode: r.subledger_code,
    ledgerCustomName: r.ledger_custom_name,
    subledgerCustomName: r.subledger_custom_name,
    ledger: r.ledger_code ? ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name) : '',
    amountPaise: r.amount_paise,                  // optional free-form amount or null
    statedAmountPaise: r.price_of_contract_paise, // the stated amount owed maths reads — typed OR derived
    // Rate-based pricing (both optional, both editable at any time — the area is not known until
    // final measurement). 'rate' when both are present, 'typed' when a price was entered directly,
    // 'none' when the contract states no price at all (all three are valid).
    ratePerSqftPaise: r.rate_per_sqft_paise,
    measuredAreaMilliSqft: r.measured_area_milli_sqft,
    computedPricePaise,                           // rate × area, or null when either half is missing
    pricingMode: computedPricePaise != null ? 'rate' : (r.price_of_contract_paise != null ? 'typed' : 'none'),
    dateSigned: r.date_signed || '',
    dateEnds: r.contract_end_date || '',
    // Optional metadata. expectedCompletionDate is DERIVED (signing date + N months) and never
    // stored: it is a function of two fields that are both editable, so storing it would just be a
    // third value to keep in step.
    completionPeriodMonths: r.completion_period_months,
    expectedCompletionDate: addMonthsIso(r.date_signed, r.completion_period_months),
    supervisionRatePct: r.supervision_rate_pct,   // informational only; drives no calculation
    specifiedBrands: r.specified_brands || '',
    excludedScope: r.excluded_scope || '',
    ownerObligations: r.owner_obligations || '',
    paymentDates: repo.contract.payDatesFor(r.id),
    services: repo.contract.servicesFor(r.id).map(serviceRow), // scope list: names only
    allowances: repo.contract.allowancesFor(r.id).map((a) => allowanceRow(a, spend.get(a.id))),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

const getContractRow = (id) => repo.contract.getLive(id);

// Columns written on contract create/update (id/timestamps/deleted_at excluded).
const CONTRACT_COLS = ['contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company',
  // Contract Phase A — rate-based pricing + optional metadata. price_of_contract_paise stays in
  // the list and stays the single source of truth for owed; when a rate and an area are both
  // given, readContractBody() writes the product into it rather than whatever was typed.
  'rate_per_sqft_paise', 'measured_area_milli_sqft', 'completion_period_months', 'supervision_rate_pct', 'specified_brands', 'excluded_scope', 'owner_obligations'];
const COMPANY_MAX = 120; // Part F: optional company/firm name cap

// Validate + normalise a contract request body -> { values, paymentDates } or { error }.
// Required: contractorName, areaOfWork, a valid headline ledger, date signed.
// Optional: stated amount, free-form amount, date ends, and 0..many payment dates.
function readContractBody(req) {
  const contractorName = str(req.body.contractorName).slice(0, CONTRACTOR_MAX);
  if (!contractorName) return { error: 'Contractor name is required.' };
  const areaOfWork = str(req.body.areaOfWork).slice(0, AREA_MAX);
  if (!areaOfWork) return { error: 'Area of work is required.' };

  const led = resolveLedger(req.body); // headline category (fixed-or-CUSTOM), shared rules
  if (led.error) return { error: led.error };

  const amount = parsePriceOptional(req.body.amountRupees); // optional free-form; blank -> null
  if (amount.error) return { error: amount.error };

  // The stated total is OPTIONAL: blank -> NULL. A contract with no stated price contributes 0 to
  // figure A (total contract) and 0 to owed; a contract that HAS one behaves exactly as before.
  const stated = parsePriceOptional(req.body.statedAmountRupees);
  if (stated.error) return { error: 'Enter a valid total contract value greater than 0 (up to 2 decimals), or leave it blank.' };

  // Contract Phase A — rate-based pricing. Both halves are OPTIONAL and independently editable at
  // any time: the rate is fixed at signing, the area is not known until final measurement, so a
  // contract routinely sits with a rate and no area for months. When BOTH land, the product REPLACES
  // whatever is in statedAmountRupees; a typed value sent alongside a complete rate price is
  // ignored, not rejected, so an older client or a stale tab can't 400 on an otherwise valid save.
  const rate = parsePriceOptional(req.body.ratePerSqftRupees);
  if (rate.error) return { error: 'Enter a valid rate per square foot greater than 0 (up to 2 decimals), or leave it blank.' };
  const area = parseAreaOptional(req.body.measuredAreaSqft);
  if (area.error) return { error: area.error };
  if (rate.paise != null && area.milli != null && unitPricePaise(rate.paise, area.milli) == null) {
    return { error: 'That rate and area multiply out to a number too large to record. Check both figures.' };
  }
  const computed = unitPricePaise(rate.paise, area.milli); // null unless BOTH halves are present

  // Contract Phase A — the signing date is OPTIONAL now (it was required). Every field on this form
  // is optional except the contractor, the area of work and the headline ledger. A malformed date
  // is still rejected; an absent one is simply absent, and the expected completion date it would
  // have anchored is then not reported rather than being counted from a made-up day.
  const signed = parseIsoDate(req.body.dateSigned);
  if (signed.error) return { error: signed.error };

  const ends = parseIsoDate(req.body.dateEnds); // optional; blank -> null
  if (ends.error) return { error: ends.error };

  const months = parseWholeOptional(req.body.completionPeriodMonths, 1, MAX_MONTHS, `Enter the completion period as a whole number of months between 1 and ${MAX_MONTHS}, or leave it blank.`);
  if (months.error) return { error: months.error };

  const supervision = parsePercentOptional(req.body.supervisionRatePct);
  if (supervision.error) return { error: supervision.error };

  const specifiedBrands = str(req.body.specifiedBrands).slice(0, NOTE_MAX);
  const excludedScope = str(req.body.excludedScope).slice(0, NOTE_MAX);
  const ownerObligations = str(req.body.ownerObligations).slice(0, NOTE_MAX);

  const company = str(req.body.company).slice(0, COMPANY_MAX); // Part F: optional; blank -> null below

  const rawDates = Array.isArray(req.body.paymentDates) ? req.body.paymentDates : [];
  const paymentDates = [];
  for (const d of rawDates) {
    const p = parseIsoDate(d);
    if (p.error || !p.date) return { error: 'Each payment date must be a valid date (YYYY-MM-DD).' };
    paymentDates.push(p.date);
  }

  return {
    values: {
      contractor_name: contractorName,
      area_of_work: areaOfWork,
      ledger_code: led.ledgerCode,
      subledger_code: led.subledgerCode,
      ledger_custom_name: led.ledgerCustomName,
      subledger_custom_name: led.subledgerCustomName,
      amount_paise: amount.paise,
      // DERIVED when the contract is rate-priced, TYPED otherwise. Materialising it into the one
      // column every consumer already reads (owed, figure A, the PDF, the Contractor Payments
      // "Remaining" line) is what keeps this change additive: nothing downstream learns about rates.
      // reconciliation.contractPriceDerivation re-checks the product on every Overview load and
      // flags any drift rather than silently correcting it.
      price_of_contract_paise: computed != null ? computed : stated.paise,
      rate_per_sqft_paise: rate.paise,
      measured_area_milli_sqft: area.milli,
      contract_end_date: ends.date,
      date_signed: signed.date,
      completion_period_months: months.value,
      supervision_rate_pct: supervision.value,
      specified_brands: specifiedBrands || null,
      excluded_scope: excludedScope || null,
      owner_obligations: ownerObligations || null,
      company: company || null,
    },
    paymentDates,
  };
}

// Replace a contract's scheduled payment-date children with a fresh list.
const writePaymentDates = (contractId, dates) => repo.contract.writePayDates(contractId, dates);

// Contracts CRUD. Phase 5D: AT MOST ONE live contract (enforced by the idx_contract_single_live
// partial unique index). The path + the { contracts: [...] } response shape are UNCHANGED so the
// frontend fetch doesn't churn — it is simply always an array of 0 or 1. paymentDatesFor() is
// called once per returned row (contractRow); with the invariant that N+1 is now bounded at one
// contract, so it needs no batching/restructuring.
app.get('/api/contracts', requireApiAuth, (req, res) => {
  res.json({ contracts: repo.contract.list().map(contractRow) });
});

app.post('/api/contracts', requireApiAuth, (req, res) => {
  const v = readContractBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  // Phase 5D: the single-contract guard — a second contract is a clean 409, never a silent overwrite.
  // (idx_contract_single_live backstops it in the database.)
  if (repo.contract.liveCount() > 0) {
    return res.status(409).json({ error: 'A contract already exists — Plannr tracks a single contract. Edit the existing one instead of adding another (or delete it first).' });
  }
  const info = repo.contract.insert(CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
  writePaymentDates(info.lastInsertRowid, v.paymentDates);
  res.status(201).json({ ok: true, contract: contractRow(getContractRow(info.lastInsertRowid)) });
});

app.put('/api/contracts/:id', requireApiAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !getContractRow(id)) return res.status(404).json({ error: 'Contract not found.' });
  const v = readContractBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  repo.contract.update(id, CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
  writePaymentDates(id, v.paymentDates);
  res.json({ ok: true, contract: contractRow(getContractRow(id)) });
});

// ---------------------------------------------------------------------------
// Contract services (Services phase, Part A). A contract's line-item services: a NAME + an OPTIONAL
// price. Add / edit / soft-delete, nested under the parent contract so the id proves ownership.
// A service's only job downstream is to be NAMED by a debit (cash_out.contract_service_id) as the
// thing that spend was for. It never enters the dues maths — nothing does but the contract's stated
// value and the contractor payments.
// ---------------------------------------------------------------------------
const SERVICE_NAME_MAX = 120;
const getServiceRow = (id) => repo.contract.serviceLive(id);
const getLiveServiceForContract = (cid, sid) => repo.contract.serviceForContract(cid, sid);

// A service is a name. Contract Phase A dropped priceRupees; a body that still sends one is
// IGNORED rather than rejected, so a stale tab or an older client cannot 400 on a valid save.
function readServiceBody(req) {
  const name = str(req.body.name).slice(0, SERVICE_NAME_MAX);
  if (!name) return { error: 'Service name is required.' };
  return { values: { name } };
}

app.post('/api/contracts/:id/services', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id);
  if (!Number.isInteger(cid) || !getContractRow(cid)) return res.status(404).json({ error: 'Contract not found.' });
  const v = readServiceBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const info = repo.contract.insertService(cid, v.values.name);
  res.status(201).json({ ok: true, service: serviceRow(getServiceRow(info.lastInsertRowid)) });
});

app.put('/api/contracts/:id/services/:sid', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id), sid = Number(req.params.sid);
  if (!Number.isInteger(cid) || !Number.isInteger(sid) || !getLiveServiceForContract(cid, sid)) return res.status(404).json({ error: 'Service not found.' });
  const v = readServiceBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  repo.contract.updateService(sid, v.values.name);
  res.json({ ok: true, service: serviceRow(getServiceRow(sid)) });
});

app.delete('/api/contracts/:id/services/:sid', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id), sid = Number(req.params.sid);
  if (!Number.isInteger(cid) || !Number.isInteger(sid) || !getLiveServiceForContract(cid, sid)) return res.status(404).json({ error: 'Service not found.' });
  // Soft-delete. A LIVE debit may still reference this now-deleted service (keeping the provenance
  // link); it simply stops being offered by the picker. No block — services are informational.
  repo.contract.softDeleteService(sid);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Contract allowances (Contract Phase A). The contract's allowance caps — the only rupee figures
// the contract attaches to anything. Entirely OPTIONAL: a contract with none behaves normally.
// Nested under the parent contract so the id proves ownership, exactly like services.
//
// Spend against a cap is DERIVED from live cash_out rows tagged with the allowance, never typed,
// and the over/under position is DISPLAYED only. The contract settles an overrun by adding it to
// the next progress payment and an underrun by subtracting it from the final — that is the owner's
// decision to make on the day, so nothing here touches owed or any Overview total.
// ---------------------------------------------------------------------------
const getLiveAllowanceForContract = (cid, aid) => repo.contract.allowanceForContract(cid, aid);

// Read + normalise an allowance body -> { values } | { error }.
// 'lump'     needs capRupees.                    'per_sqft' needs capRatePerSqftRupees.
// 'per_sqft' may ALSO carry areaSqft — optional, because a rate ceiling is a real cap on its own
// and only becomes a rupee figure once an area is known. Without it the row simply reports no
// position; making the area mandatory would force the owner to invent one.
function readAllowanceBody(req) {
  const name = str(req.body.name).slice(0, ALLOWANCE_NAME_MAX);
  if (!name) return { error: 'Allowance name is required.' };
  const kind = str(req.body.capKind) || 'lump';
  if (!ALLOWANCE_KINDS.has(kind)) return { error: 'Choose whether this cap is a rupee amount or a rate per square foot.' };

  if (kind === 'lump') {
    const cap = parsePriceOptional(req.body.capRupees);
    if (cap.error) return { error: 'Enter a valid cap amount greater than 0 (up to 2 decimals).' };
    if (cap.paise == null) return { error: 'Enter the cap amount for this allowance.' };
    return { values: { name, cap_kind: 'lump', cap_paise: cap.paise, cap_rate_per_sqft_paise: null, area_milli_sqft: null } };
  }

  const rate = parsePriceOptional(req.body.capRatePerSqftRupees);
  if (rate.error) return { error: 'Enter a valid ceiling rate per square foot greater than 0 (up to 2 decimals).' };
  if (rate.paise == null) return { error: 'Enter the ceiling rate per square foot for this allowance.' };
  const area = parseAreaOptional(req.body.areaSqft); // optional
  if (area.error) return { error: area.error };
  if (area.milli != null && unitPricePaise(rate.paise, area.milli) == null) {
    return { error: 'That rate and area multiply out to a number too large to record. Check both figures.' };
  }
  return { values: { name, cap_kind: 'per_sqft', cap_paise: null, cap_rate_per_sqft_paise: rate.paise, area_milli_sqft: area.milli } };
}

// Re-shape one allowance for a single-row response (the list comes back via contractRow).
const allowanceById = (cid, aid) => {
  const row = repo.contract.allowanceForContract(cid, aid);
  return row ? allowanceRow(row, repo.contract.allowanceSpendFor(cid).get(aid)) : null;
};

app.post('/api/contracts/:id/allowances', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id);
  if (!Number.isInteger(cid) || !getContractRow(cid)) return res.status(404).json({ error: 'Contract not found.' });
  const v = readAllowanceBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const info = repo.contract.insertAllowance(cid, { ...v.values, sort_order: repo.contract.nextAllowanceOrder(cid) });
  res.status(201).json({ ok: true, allowance: allowanceById(cid, Number(info.lastInsertRowid)) });
});

app.put('/api/contracts/:id/allowances/:aid', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id), aid = Number(req.params.aid);
  if (!Number.isInteger(cid) || !Number.isInteger(aid) || !getLiveAllowanceForContract(cid, aid)) return res.status(404).json({ error: 'Allowance not found.' });
  const v = readAllowanceBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  repo.contract.updateAllowance(aid, v.values);
  res.json({ ok: true, allowance: allowanceById(cid, aid) });
});

app.delete('/api/contracts/:id/allowances/:aid', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id), aid = Number(req.params.aid);
  if (!Number.isInteger(cid) || !Number.isInteger(aid) || !getLiveAllowanceForContract(cid, aid)) return res.status(404).json({ error: 'Allowance not found.' });
  // Soft-delete, same as a service. Debits already drawn against it keep their link (the spend is
  // still real spend, and it still counts in every Overview figure — only the cap stops being
  // reported); the allowance simply stops being offered on the debit form.
  repo.contract.softDeleteAllowance(aid);
  res.json({ ok: true });
});

// Soft-delete a contract. Scheduled payment-date children are left in place (only
// surfaced via the contract).
app.delete('/api/contracts/:id', requireApiAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contract id.' });
  // Guard (Phase 4D): refuse while any LIVE contractor payment references this contract. Otherwise
  // A/F (which iterate live contracts) drop the contract while B/D/pie (which iterate live payments)
  // keep its ₹ — you end up having paid toward a contract totalling ₹0, and the Overview stops
  // reconciling. Same shape as the two Recycle-Bin guards and /api/delete-account.
  const live = repo.contract.livePaymentsFor(id);
  if (live > 0) {
    return res.status(409).json({ error: `This contract has ${live} live contractor payment${live === 1 ? '' : 's'} recorded against it. Deleting it would leave ${live === 1 ? 'that payment' : 'those payments'} attributed to a contract that is gone (and unbalance the Overview), so it's blocked — delete or reassign ${live === 1 ? 'that payment' : 'those payments'} first, then delete the contract.` });
  }
  const info = repo.contract.softDelete(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Contract not found.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Contractor Payments API (Phase 3). Money PAID to a contractor, each tied to a
// specific contract. A normal add/edit/soft-delete list via makeLedgerCrud. The
// ledger fields are an OPTIONAL DISPLAY tag; they do NOT drive dues math — owed is the contract's
// stated value minus Σ amount_paise of its payments, never a payment's ledger.
// ---------------------------------------------------------------------------

// Like resolveLedger, but the ledger is OPTIONAL: an empty ledgerCode -> all NULL
// (no tag). When a ledger IS chosen the SAME rules/error strings apply (delegates).
function resolveLedgerOptional(body) {
  if (str(body.ledgerCode) === '') return { ledgerCode: null, subledgerCode: null, ledgerCustomName: null, subledgerCustomName: null };
  return resolveLedger(body);
}

// Joined so each payment carries its parent contract's name/area for display.
const CONTRACTOR_PAYMENTS_SELECT = `
  SELECT cp.id, cp.contract_id, cp.pay_date, cp.amount_paise,
         cp.ledger_code, cp.subledger_code, cp.ledger_custom_name, cp.subledger_custom_name,
         cp.remarks, cp.created_at,
         ct.contractor_name AS contractor_name, ct.area_of_work AS area_of_work
    FROM contractor_payments cp
    LEFT JOIN contract ct ON ct.id = cp.contract_id`;

const paymentRow = (r) => ({
  id: r.id,
  contractId: r.contract_id,
  contractorName: r.contractor_name || '',
  areaOfWork: r.area_of_work || '',
  payDate: r.pay_date,
  amountPaise: r.amount_paise,
  ledgerCode: r.ledger_code,
  subledgerCode: r.subledger_code,
  ledgerCustomName: r.ledger_custom_name,
  subledgerCustomName: r.subledger_custom_name,
  ledger: r.ledger_code ? ledgerLabel(r.ledger_code, r.subledger_code, r.ledger_custom_name, r.subledger_custom_name) : '',
  remarks: r.remarks || '',
  createdAt: r.created_at,
});

makeLedgerCrud({
  basePath: '/api/contractor-payments',
  alias: 'cp', // the table alias used in CONTRACTOR_PAYMENTS_SELECT
  table: 'contractor_payments',
  select: CONTRACTOR_PAYMENTS_SELECT,
  listWhere: 'WHERE cp.deleted_at IS NULL ORDER BY cp.id ASC',
  byIdWhere: 'WHERE cp.id = ?',
  shape: paymentRow,
  columns: ['contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'remarks'],
  validate: (req) => {
    // Contract required + must be a live contract.
    const contractId = Number(req.body.contractId);
    if (!Number.isInteger(contractId) || !repo.contract.existsLive(contractId)) {
      return { error: 'Select a valid contract.' };
    }
    // Date of payment required (ISO). Amount required (> 0, integer paise).
    const d = parseIsoDate(req.body.payDate);
    if (d.error) return { error: d.error };
    if (!d.date) return { error: 'Select a date of payment.' };
    const amountPaise = parsePaise(req.body.amountRupees);
    if (amountPaise === null) return { error: 'Enter a valid amount greater than 0 (up to 2 decimals).' };
    // Ledger tag OPTIONAL.
    const led = resolveLedgerOptional(req.body);
    if (led.error) return { error: led.error };
    return { values: {
      contract_id: contractId,
      pay_date: d.date,
      amount_paise: amountPaise,
      ledger_code: led.ledgerCode,
      subledger_code: led.subledgerCode,
      ledger_custom_name: led.ledgerCustomName,
      subledger_custom_name: led.subledgerCustomName,
      remarks: str(req.body.remarks).slice(0, REASON_MAX),
    } };
  },
  listKey: 'payments',
  itemKey: 'payment',
  notFoundMsg: 'Payment not found.',
  invalidIdMsg: 'Invalid payment id.',
});

// ---------------------------------------------------------------------------
// Phase 3C — Recycle Bin: view / restore / permanently-delete soft-deleted rows for the
// five soft-deleting tables. Everything below is auth-gated. Statements are prepared once
// here (module scope, AFTER init() and after the SELECTs/shapers above — the Phase 1 pattern).
// ---------------------------------------------------------------------------
const TRASH_TABLES = ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments']; // the ONLY allowed :table values
const TRASH_SHAPERS = { cash_in: cashInRow, cash_out: cashOutRow, loans: loanRow, contract: contractRow, contractor_payments: paymentRow };
// The Recycle Bin routes through repo.trash.
const TRASH_REPO = {
  cash_in:  repo.trash({ table: 'cash_in', select: CASH_IN_SELECT, alias: 'c' }),
  cash_out: repo.trash({ table: 'cash_out', select: CASH_OUT_SELECT, alias: 'c' }),
  loans:    repo.trash({ table: 'loans', select: LOANS_SELECT, alias: '' }),
  contract: repo.trash({ table: 'contract', select: 'SELECT * FROM contract', alias: '' }),
  contractor_payments: repo.trash({ table: 'contractor_payments', select: CONTRACTOR_PAYMENTS_SELECT, alias: 'cp' }),
};

// GET /api/trash — soft-deleted rows for all five tables, each shaped like the live list plus
// deletedAt, newest-deleted first.
app.get('/api/trash', requireApiAuth, (req, res) => {
  const trash = {};
  for (const t of TRASH_TABLES) {
    trash[t] = TRASH_REPO[t].listDeleted().map((r) => ({ ...TRASH_SHAPERS[t](r), deletedAt: r.deleted_at }));
  }
  res.json({ trash });
});

// Validate :table against the allowlist; return the name or null.
function trashTable(req) { return TRASH_TABLES.includes(req.params.table) ? req.params.table : null; }

// POST /api/trash/:table/:id/restore — un-delete (deleted_at = NULL, bump updated_at).
app.post('/api/trash/:table/:id/restore', requireApiAuth, (req, res) => {
  const table = trashTable(req);
  if (!table) return res.status(400).json({ error: 'Unknown table.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
  // Guard: a contractor payment must not go live under a still-deleted contract — otherwise a
  // live payment sits under a deleted contract, inflating Overview spend while the contract's
  // value stays out of the totals. Require the contract to be restored first.
  if (table === 'contractor_payments') {
    const row = repo.contract.paymentContractId(id);
    const parent = repo.contract.deletedAt(row.contract_id);
    if (!parent || parent.deleted_at !== null) {
      return res.status(409).json({ error: 'Restore the parent contract first — this payment belongs to a contract that is still in the Recycle Bin.' });
    }
  }
  // Phase 5H — the single-live-contract invariant (idx_contract_single_live). Guard explicitly:
  // refuse restoring a contract while another is already live. Message style matches the two
  // guards above and /api/delete-account.
  if (table === 'contract' && repo.contract.liveCount() > 0) {
    return res.status(409).json({ error: 'Another contract is already live — Plannr tracks a single contract. Delete the current one before restoring this from the Recycle Bin.' });
  }
  // Services phase (Part D) — a soft-deleted debit RELEASED its service (the partial-unique index only
  // counts live rows). If ANOTHER live debit has since CLAIMED that service, restoring this one would
  // make two live debits offset a single substitution — the DB index would raise a raw 500. Guard
  // explicitly with the same 409 shape: refuse, naming the claimant.
  if (table === 'cash_out') {
    const row = repo.contract.cashOutServiceId(id);
    if (row && row.contract_service_id != null) {
      const other = repo.contract.serviceClaimedByOther(row.contract_service_id, id);
      if (other) {
        return res.status(409).json({ error: `Can’t restore — its contract service is now linked to entry #${other.id} (${fmtRs(other.amount_paise)} on ${other.tx_date}). One service can offset only one debit. Unlink it there first, then restore.` });
      }
    }
  }
  TRASH_REPO[table].restore(id);
  res.json({ ok: true });
});

// DELETE /api/trash/:table/:id — permanent hard delete.
app.delete('/api/trash/:table/:id', requireApiAuth, (req, res) => {
  const table = trashTable(req);
  if (!table) return res.status(400).json({ error: 'Unknown table.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
  // Guard: contractor_payments.contract_id references contract(id) with NO ACTION (unlike
  // contract_payment_dates / contract_services, which CASCADE). Hard-deleting a contract that
  // any payment — live OR soft-deleted — still references would orphan/violate the FK, so
  // refuse and say so (modelled on the /api/delete-account guard).
  if (table === 'contract') {
    const n = repo.contract.paymentsForAny(id);
    if (n > 0) {
      return res.status(409).json({ error: `This contract still has ${n} contractor payment${n === 1 ? '' : 's'} referencing it (live or in the Recycle Bin). Permanently deleting it would orphan ${n === 1 ? 'that payment' : 'those payments'} — delete or restore ${n === 1 ? 'it' : 'them'} first.` });
    }
    // cash_out.contract_service_id has no ON DELETE action, so a contract_services row cascading out
    // from this delete would otherwise throw a raw FK error if any cash-out entry (live or in the
    // Recycle Bin) still references one of this contract's services.
    const m = repo.contract.cashOutReferencingServices(id);
    if (m > 0) {
      return res.status(409).json({ error: `This contract still has ${m} cash-out entr${m === 1 ? 'y' : 'ies'} linked to one of its services (live or in the Recycle Bin). Permanently deleting it would orphan ${m === 1 ? 'that entry' : 'those entries'} — unlink or restore ${m === 1 ? 'it' : 'them'} first.` });
    }
    // Contract Phase A: contract_allowances CASCADEs the same way, and cash_out.contract_allowance_id
    // has no ON DELETE action either — same crash, same pre-flight count.
    const k = repo.contract.cashOutReferencingAllowances(id);
    if (k > 0) {
      return res.status(409).json({ error: `This contract still has ${k} cash-out entr${k === 1 ? 'y' : 'ies'} drawing against one of its allowances (live or in the Recycle Bin). Permanently deleting it would orphan ${k === 1 ? 'that entry' : 'those entries'} — unlink or restore ${k === 1 ? 'it' : 'them'} first.` });
    }
  }
  TRASH_REPO[table].hardDelete(id); // contract_payment_dates / contract_services children cascade
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Overview API (READ-ONLY analytics) + the optional overall budget. Logged-in
// only. Every figure is computed from LIVE (non-deleted) rows; money is INTEGER
// paise throughout (never float). No editing here — that is a later phase.
// ---------------------------------------------------------------------------

// Optional overall budget, stored as one settings row. NULL = unset.
function getBudgetPaise() {
  const r = BUDGET_STMT.get();
  if (!r || r.value == null || r.value === '') return null;
  const n = Number(r.value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

app.get('/api/budget', requireApiAuth, (req, res) => {
  res.json({ budgetPaise: getBudgetPaise() });
});

// Set (positive ₹) or clear (empty) the overall budget. Optional / non-blocking.
app.put('/api/budget', requireApiAuth, (req, res) => {
  const raw = req.body.budgetRupees;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', NULL) ON CONFLICT(key) DO UPDATE SET value = NULL").run();
    return res.json({ budgetPaise: null });
  }
  const paise = parsePaise(raw);
  if (paise === null) return res.status(400).json({ error: 'Enter a valid budget greater than 0 (up to 2 decimals).' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(paise));
  res.json({ budgetPaise: paise });
});

// Phase 6b — up to 5 daily local-notification times ("HH:MM", 24h), replacing the deleted
// scheduled-email report (Phase 1.3 removed daily-report.js, nodemailer, and its scheduling UI).
// Reuses the old daily_report_times settings key; its old rows are inert (unread by any code before
// this), so no format migration is needed. Actual notification scheduling is client-side
// (public/notifications.js) — this is just persistence, same as budget above.
const NOTIF_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function normalizeNotificationTimes(raw) {
  if (!Array.isArray(raw) || raw.length > 5) return null;
  const seen = new Set(); const out = [];
  for (const t of raw) {
    const s = String(t ?? '').trim();
    if (!NOTIF_TIME_RE.test(s)) return null;
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.sort();
}
function getNotificationTimes() {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'daily_report_times'").get();
  if (!r || r.value == null) return [];
  try { return normalizeNotificationTimes(JSON.parse(r.value)) || []; } catch { return []; }
}

app.get('/api/notification-times', requireApiAuth, (req, res) => {
  res.json({ times: getNotificationTimes() });
});

app.put('/api/notification-times', requireApiAuth, (req, res) => {
  const times = normalizeNotificationTimes(req.body.times);
  if (times === null) return res.status(400).json({ error: 'Send up to 5 unique times as "HH:MM" (24h).' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('daily_report_times', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(times));
  res.json({ times });
});

// All ledger_code='CUSTOM' outflows roll up under ONE group with this label.
const CUSTOM_GROUP_NAME = 'Custom / Uncategorized';

// Compute the whole Overview summary from LIVE (non-deleted) rows. Money is INTEGER
// paise throughout.
//   `range` (optional) = { start, end } ISO 'YYYY-MM-DD' bounds, inclusive; a null
//   bound is unbounded on that side, and no range = everything (the default). The
//   range scopes ONLY the SPENDING views — B (paid to contractors), C (spent by self),
//   D (total spent), and the Spending-by-Ledger rollup / pie — by each transaction's
//   own date (cash_out.tx_date, contractor_payments.pay_date). Dateless legacy rows
//   drop out once a bound is set. A (total contract), E (loans) and F (owed) are
//   running agreements/balances and stay CUMULATIVE, unaffected by the range.
//   Every spend transaction counts in the ledger rollup regardless of who paid or of
//   contract scope: cash_out AND contractor_payments both contribute; a contractor
//   payment with no ledger tag rolls up under Custom / Uncategorized.
function computeOverview(range) {
  const start = (range && range.start) || null;
  const end = (range && range.end) || null;
  const bounded = !!(start || end);              // any bound set -> range mode (dateless rows drop out)
  const lo = start || '0000-01-01', hi = end || '9999-12-31'; // open sentinels -> sargable col>=? AND col<=?

  // The Phase 5E reimbursement offset is REMOVED, all-or-nothing: no 'included' debit reduces owed,
  // whatever contract_stated_paise a legacy row still holds. Nothing reads that column any more, so
  // the cumulative 'included' scan that fed the offset (and its missing-offset check) is gone too.

  // Live contract (single, Phase 5D). area_of_work + headline ledger label the owed row.
  const contractRows = repo.overview.contracts();
  const liveContractIds = new Set(contractRows.map((c) => c.id));

  // paid grouped by contract_id (cumulative) — ONE aggregate feeds three things: the owed balance
  // (paidByContract), the cumulative paid total (over-offset check), and orphaned-payment detection
  // (groups whose contract is soft-deleted/missing). No payment rows are fetched for any of these.
  const paidByContract = new Map();
  let cumulativePaid = 0;
  const orphan = { count: 0, amountPaise: 0, contractIds: [] };
  for (const g of repo.overview.paidByContract()) {
    paidByContract.set(g.contract_id, g.s);
    cumulativePaid += g.s;
    if (!liveContractIds.has(g.contract_id)) { orphan.count += g.c; orphan.amountPaise += g.s; orphan.contractIds.push(g.contract_id); }
  }

  // Per-contract dues + A/F — all CUMULATIVE (unaffected by the range).
  //   owed(C) = stated − Σ paid   (RAW; negative = overpaid, never clamped)
  // An UNSTATED contract (price_of_contract_paise NULL) reads as stated = 0: it adds nothing to A
  // and nothing to owed — but its payments still count in B/D/pie, exactly as before.
  let totalContract = 0, owedToContractors = 0;
  const contracts = contractRows.map((c) => {
    const stated = c.price_of_contract_paise || 0;
    const paid = paidByContract.get(c.id) || 0;
    const owed = stated - paid;
    totalContract += stated; owedToContractors += owed;
    return {
      id: c.id,
      contractorName: c.contractor_name || '',
      areaOfWork: c.area_of_work || '',
      ledger: c.ledger_code ? ledgerLabel(c.ledger_code, c.subledger_code, c.ledger_custom_name, c.subledger_custom_name) : '',
      statedPaise: stated, paidPaise: paid, owedPaise: owed,
    };
  });

  // Spending-by-Ledger rollup (the pie) + B/C/D — RANGE-SCOPED, counting EVERY spend
  // transaction: cash_out (spent by self) AND contractor_payments (paid to a
  // contractor). Nothing is excluded by who paid or by contract scope. The user/other
  // split feeds the reconciliation self-check only (not shown); payments count as 'other'.
  const zero = () => ({ totalPaise: 0, userPaise: 0, otherPaise: 0 });
  const add = (o, byType, amt) => { o.totalPaise += amt; if (byType === 'user') o.userPaise += amt; else o.otherPaise += amt; };

  let spentBySelf = 0, paidToContractors = 0, userSpent = 0, otherSpent = 0; // C, B
  const ledMap = new Map();
  const rollup = (byType, ledgerCode, subCode, subCustom, amt) => {
    if (byType === 'user') userSpent += amt; else otherSpent += amt;
    const isCustom = ledgerCode === CUSTOM_CODE;
    const key = isCustom ? CUSTOM_CODE : ledgerCode;
    let L = ledMap.get(key);
    if (!L) {
      const meta = isCustom ? null : LEDGER_BY_CODE.get(ledgerCode);
      L = { code: key, name: isCustom ? CUSTOM_GROUP_NAME : (meta ? `${meta.code} ${meta.name}` : ledgerCode), isCustom, ...zero(), subs: new Map(), noSub: zero() };
      ledMap.set(key, L);
    }
    add(L, byType, amt);
    if (subCode) {
      let subKey, subName;
      if (subCode === CUSTOM_CODE) { subName = subCustom || 'Custom sub-ledger'; subKey = 'CUSTOM:' + subName; }
      else {
        const meta = isCustom ? null : LEDGER_BY_CODE.get(ledgerCode);
        const s = meta && meta.subLedgers.find((x) => x.code === subCode);
        subName = s ? `${s.code} ${s.name}` : subCode; subKey = subCode;
      }
      let S = L.subs.get(subKey);
      if (!S) { S = { code: subCode, name: subName, ...zero() }; L.subs.set(subKey, S); }
      add(S, byType, amt);
    } else {
      add(L.noSub, byType, amt); // logged with no sub-ledger
    }
  };

  // Phase 6C — RANGE-SCOPED row fetches: the range is pushed into SQL (partial index on tx_date/
  // pay_date), so only the in-range rows are transferred. These feed C, B and the pie ONLY.
  const outs = bounded ? repo.overview.outsRange(lo, hi) : repo.overview.outsAll();
  const payments = bounded ? repo.overview.paymentsRange(lo, hi) : repo.overview.paymentsAll();
  for (const r of outs) {
    spentBySelf += r.amount_paise; // C (range)
    rollup(r.by_type, r.ledger_code, r.subledger_code, r.subledger_custom_name, r.amount_paise);
  }
  for (const p of payments) {
    paidToContractors += p.amount_paise; // B (range)
    rollup('other', p.ledger_code || CUSTOM_CODE, p.subledger_code, p.subledger_custom_name, p.amount_paise);
  }

  const loanReceived = repo.overview.loansSum().s; // E (cumulative)
  const totalSpent = paidToContractors + spentBySelf; // D = B + C (range)

  const ledgers = [...ledMap.values()]
    .sort((a, b) => (a.isCustom ? 1 : b.isCustom ? -1 : parseFloat(a.code) - parseFloat(b.code)))
    .map((L) => ({
      code: L.code, name: L.name, isCustom: L.isCustom,
      totalPaise: L.totalPaise, userPaise: L.userPaise, otherPaise: L.otherPaise,
      noSub: L.noSub, subs: [...L.subs.values()],
    }));

  // Reconciliation self-check now balances against D (B + C) — the pie counts all spend.
  const splitSumsToTotal = userSpent + otherSpent === totalSpent;
  const mainsSumToTotal = ledgers.reduce((a, L) => a + L.totalPaise, 0) === totalSpent;
  const subsSumToMains = ledgers.every((L) => L.subs.reduce((a, s) => a + s.totalPaise, 0) + L.noSub.totalPaise === L.totalPaise);

  // Reconciliation detections (cumulative, computed from the aggregates above):
  //  · orphan (Phase 4D) — payments whose parent contract is soft-deleted/missing: their ₹ is still
  //    in B/D/pie but not counted in A/F. From the paidByContract groups (contract_id not live).
  //  · overOffset (Phase 5E, retained) — payments exceed the contract value. The 'included'-debit
  //    offset no longer contributes, so this is now purely "paid more than the contract is worth".
  // The Phase 5E missing-offset check is GONE: a NULL/0 contract_stated_paise on an 'included' debit
  // is the normal case now, so the check would fire on every single hand.
  // Both flag-and-log only; NO figure is adjusted (same discipline as Phase 4D).
  const appliedAgainstContract = cumulativePaid;
  const overOffset = { over: totalContract > 0 && appliedAgainstContract > totalContract, contractPaise: totalContract, appliedPaise: appliedAgainstContract, excessPaise: Math.max(0, appliedAgainstContract - totalContract) };

  // Contract Phase A — contractPriceDerivation. A rate-priced contract stores the PRODUCT of its
  // rate and its measured area in price_of_contract_paise, so that owed, figure A, the PDF and the
  // Contractor Payments "Remaining" line all keep reading the one column they always read. That
  // makes the stored price a DERIVED value, and a derived value that is materialised can drift —
  // a backup restored from a file whose stored price disagreed with its own rate and area is the
  // realistic way in, since the import writes columns verbatim rather than re-running the write
  // path. This recomputes the product for every rate-priced live contract and flags a mismatch.
  // Flag-and-log only: it reports the figure AS STORED and corrects nothing, exactly like the two
  // checks above. Re-saving the contract on the Contract Details page rewrites it.
  const priceDrift = [];
  for (const c of contractRows) {
    const expected = unitPricePaise(c.rate_per_sqft_paise, c.measured_area_milli_sqft);
    if (expected != null && expected !== (c.price_of_contract_paise || 0)) {
      priceDrift.push({ contractId: c.id, storedPaise: c.price_of_contract_paise, expectedPaise: expected });
    }
  }
  const contractPriceDerivation = { drifted: priceDrift.length > 0, contracts: priceDrift };

  if (!splitSumsToTotal || !mainsSumToTotal || !subsSumToMains) {
    console.error('Overview reconciliation failed', { splitSumsToTotal, mainsSumToTotal, subsSumToMains });
  }
  if (orphan.count > 0) {
    console.warn(`Overview reconciliation: ${orphan.count} live contractor payment(s) totalling ${orphan.amountPaise} paise reference a soft-deleted or missing contract (contract ids: ${orphan.contractIds.join(', ')}). Counted in B/D/pie but not offset in A/F — figures reported AS-IS, not adjusted. Restore or reassign those payments' contract to rebalance.`);
  }
  if (overOffset.over) {
    console.warn(`Overview reconciliation: contractor payments (${overOffset.appliedPaise} paise) exceed the contract value (${overOffset.contractPaise} paise) by ${overOffset.excessPaise} paise — over-offset. owed is reported unclamped (negative = overpaid), not adjusted.`);
  }
  if (contractPriceDerivation.drifted) {
    console.warn(`Overview reconciliation: ${priceDrift.length} rate-priced contract(s) have a stored price that no longer equals rate × measured area — ${priceDrift.map((d) => `#${d.contractId}: stored ${d.storedPaise} paise, rate × area ${d.expectedPaise} paise`).join('; ')}. The STORED figure is what every total above uses; re-save the contract to recompute it.`);
  }

  return {
    budgetPaise: getBudgetPaise(),
    ledgers,
    // Money model (A–F). A/E/F are cumulative; B/C/D reflect the selected date range.
    money: {
      totalContractPaise: totalContract,        // A (cumulative)
      paidToContractorsPaise: paidToContractors, // B (range)
      spentBySelfPaise: spentBySelf,            // C (range)
      totalSpentPaise: totalSpent,              // D = B + C (range)
      loanReceivedPaise: loanReceived,          // E (cumulative)
      owedToContractorsPaise: owedToContractors, // F = stated − Σ paid (cumulative)
    },
    contracts, // per-contract: { id, contractorName, statedPaise, paidPaise, owedPaise }
    upcomingPayments: computeUpcomingPayments(), // Part C — scheduled dates forward + soft overdue
    // Phase 4D + 5E — reconciliation status (additive, backward-compatible; the frontend may
    // surface it later). ok=false means the summary doesn't self-reconcile. Every sub-object is a
    // flag over data reported AS-IS — nothing here adjusts a figure.
    reconciliation: {
      ok: splitSumsToTotal && mainsSumToTotal && subsSumToMains && orphan.count === 0 && !overOffset.over && !contractPriceDerivation.drifted,
      orphanedContractorPayments: orphan,          // { count, amountPaise, contractIds }   (Phase 4D)
      overOffset: overOffset,                      // { over, contractPaise, appliedPaise, excessPaise } (Phase 5E)
      contractPriceDerivation,                     // { drifted, contracts: [{ contractId, storedPaise, expectedPaise }] } (Phase A)
    },
  };
}

// Part C — surface the contract's SCHEDULED payment dates forward. HONEST about the data:
//   • contract_payment_dates carries NO amount → we never claim a due/overdue ₹ amount.
//   • there is NO key linking a recorded payment to a scheduled date → "overdue" is a BEST-EFFORT
//     match: a past scheduled date with no LIVE payment on that exact (contract_id, pay_date). It is
//     flagged softly (possiblyOverdue), never as a hard financial assertion.
// Returns [{ date, daysRemaining (>=0 future, <0 past), paidOnDate, possiblyOverdue }], date-sorted.
function daysBetweenIso(fromIso, toIso) {
  const [ya, ma, da] = fromIso.split('-').map(Number);
  const [yb, mb, db2] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db2) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
function computeUpcomingPayments() {
  const today = istDateStamp();
  const out = [];
  for (const c of repo.contract.list()) { // one live contract, but the loop is correct either way
    for (const d of repo.contract.payDatesFor(c.id)) {
      const daysRemaining = daysBetweenIso(today, d);
      const paidOnDate = repo.contract.paymentOnDate(c.id, d);
      out.push({ date: d, daysRemaining, paidOnDate, possiblyOverdue: daysRemaining < 0 && !paidOnDate });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// Optional inclusive date range via ?start=&end= (ISO 'YYYY-MM-DD'); blank/absent = all.
app.get('/api/overview', requireApiAuth, (req, res) => {
  const s = parseIsoDate(req.query.start);
  if (s.error) return res.status(400).json({ error: 'Invalid start date (YYYY-MM-DD).' });
  const e = parseIsoDate(req.query.end);
  if (e.error) return res.status(400).json({ error: 'Invalid end date (YYYY-MM-DD).' });
  if (s.date && e.date && s.date > e.date) return res.status(400).json({ error: 'Start date must be on or before the end date.' });
  res.json(computeOverview({ start: s.date, end: e.date }));
});

// ---------------------------------------------------------------------------
// Overview PDF export — SERVER-SIDE, rendered by Playwright (headless Chromium) to a
// LIGHT / white-background layout (dark themes waste ink on paper). Four independent
// parts: full | pie | table | ledger. Each stands alone (Plannr name + the selected
// date range printed on it). Range scopes the spend views exactly like /api/overview.
// Playwright is lazy-required so the server still BOOTS if it (or its browser) is
// absent; the route then returns 503 with a clear message.
// ---------------------------------------------------------------------------
let _pdfBrowserPromise = null;
function getPdfBrowser() {
  if (!_pdfBrowserPromise) {
    const { chromium } = require('playwright'); // lazy: only when a PDF is first requested/warmed
    _pdfBrowserPromise = chromium.launch({ args: ['--no-sandbox'] });
  }
  return _pdfBrowserPromise;
}

// Phase 7G — the headless PDF Chromium no longer sits resident from boot (~150-250MB of private
// working set for a browser used only for exports). Instead it is WARMED when the Overview page
// loads — so it's ready by the time the user clicks export, which keeps navigator.share inside its
// mobile user-activation window — and CLOSED again after PDF_IDLE_MS with no render, reclaiming that
// memory between exports. A scheduled Daily Report (or any export) after a close just relaunches
// lazily via getPdfBrowser(); the cold ~2-3s launch then only ever hits an automated/background
// send, never an interactive export that was preceded by an Overview visit.
const PDF_IDLE_MS = Number(process.env.PLANNR_PDF_IDLE_MS) || 5 * 60 * 1000; // env override: tests only
let _pdfInFlight = 0;   // renders currently running (BOTH the HTTP export and the scheduled send)
let _pdfIdleTimer = null;
function touchPdfActivity() {
  if (_pdfIdleTimer) clearTimeout(_pdfIdleTimer);
  _pdfIdleTimer = setTimeout(() => { closeIdlePdfBrowser().catch(() => {}); }, PDF_IDLE_MS);
  if (_pdfIdleTimer.unref) _pdfIdleTimer.unref(); // never keep the process alive just for this timer
}
async function closeIdlePdfBrowser() {
  if (_pdfInFlight > 0) { touchPdfActivity(); return; } // a render is in flight -> defer the close
  const p = _pdfBrowserPromise;
  _pdfBrowserPromise = null; // next getPdfBrowser() relaunches lazily (keeps scheduled sends working)
  if (p) { const b = await p.catch(() => null); if (b) await b.close().catch(() => {}); }
  if (!IS_PROD) console.log('[pdf] idle — closed headless browser to free memory (re-warms on next Overview load).');
}
// Called from the Overview page load: launch (idempotent) + (re)arm the idle timer. Non-blocking.
function warmPdfBrowser() {
  getPdfBrowser().catch((e) => { if (!IS_PROD) console.error('PDF browser warm-up failed:', e); });
  touchPdfActivity();
}

// paise -> "₹12,34,567.89" (Indian grouping; exact integer math). Server-side twin of
// the browser formatPaise, used only for the print HTML.
function fmtRs(paise) {
  const neg = paise < 0; paise = Math.abs(paise);
  const rupees = Math.floor(paise / 100);
  const p = String(paise % 100).padStart(2, '0');
  return (neg ? '-' : '') + '₹' + rupees.toLocaleString('en-IN') + '.' + p;
}
const pdfEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Amber-family palette for the printed pie; Custom = deep amber (PDF_CUSTOM_COLOR).
//
// Phase C re-derived it, and it is the WEAK one of the two palettes — knowingly. Measured before:
// min ΔE00 2.99, six pairs under 5, forty-seven under 10, and #8a5a2b appeared BOTH as the 18th
// ledger's colour and as the Custom slice's, so those two slices were byte-identical whenever both
// had spend. After: no exact duplicate, nothing under ΔE00 5, min 6.00 — but still 39 pairs under 10.
//
// That ceiling is structural, not laziness. Hue is the axis that separates categories; this palette
// gives hue up by design to stay in the app's amber identity on white paper, leaving only lightness
// and a little chroma to hold 24 categories apart. Measured alternatives, if that trade is ever
// revisited: staying amber but allowing heavy drift into browns and olives reaches min ΔE00 11.64
// (and stops reading as amber); dropping the hue constraint entirely reaches 20.14. Both are design
// decisions about the report's identity, not bug fixes, so neither was taken unilaterally.
const PDF_PALETTE = [
  '#f59e0b', '#ffc31b', '#9a5115', '#d97706', '#e3c153', '#973913', '#ef8a4b', '#d2b001',
  '#a56b1a', '#dda077', '#c2703d', '#e8d12f', '#7d452a', '#f6ba83', '#876322', '#d29e0f',
  '#ffcf70', '#845f44', '#eca955', '#6f4518', '#c2410c', '#b45f06', '#7c2d12', '#cea871'];
// Custom's slice colour. Pulled out of the literal it used to be written as, because it also has to
// participate in the distinctness check — the old code hard-coded a value that was already in the
// palette, which no amount of checking the palette alone would ever have caught.
const PDF_CUSTOM_COLOR = '#8a5a2b';
// Ledgers past the fixed 24, same farthest-point derivation as overview.html's LEDGER_PALETTE_EXT
// (see the long note there for why the golden-angle generator was retired). Not hue-constrained:
// the old generator emitted full-spectrum hsl() here too, and forcing extras into an amber family
// that cannot separate its own 24 would make things worse, not better.
const PDF_PALETTE_EXT = [
  '#f720f8', '#1dc2fc', '#144ea8', '#058f67', '#d5cdf2', '#27f164', '#8e2b69', '#7f7a92',
  '#ff758f', '#b6d9cd', '#49554c', '#638af8', '#277f92', '#739114', '#851cf6', '#868779',
  '#0d6007', '#d41346', '#11b4b3', '#5d4e56', '#ca8ec6', '#f9c5c5', '#9dbf7c', '#a0adb9'];
// Beyond 48 mains — unverified last resort, as on screen.
function extraLedgerColor(extraIndex) {
  const hue = (extraIndex * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}, 65%, 50%)`;
}
function pdfLedgerColor(idx) {
  if (idx < PDF_PALETTE.length) return PDF_PALETTE[idx];
  const ext = idx - PDF_PALETTE.length;
  return ext < PDF_PALETTE_EXT.length ? PDF_PALETTE_EXT[ext] : extraLedgerColor(ext - PDF_PALETTE_EXT.length);
}
function pdfSlices(o) {
  return (o.ledgers || []).filter((L) => L.totalPaise > 0).map((L) => {
    const idx = Math.max(0, LEDGERS.findIndex((x) => x.code === L.code));
    const color = L.code === CUSTOM_CODE ? PDF_CUSTOM_COLOR : pdfLedgerColor(idx);
    return { label: L.name, value: L.totalPaise, color };
  });
}
function pdfPieSvg(slices) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return '<p class="muted">No spending to chart in this range.</p>';
  const cx = 50, cy = 50, r = 46;
  if (slices.length === 1) return `<svg viewBox="0 0 100 100" class="pie"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${slices[0].color}"/></svg>`;
  let a0 = -Math.PI / 2;
  const paths = slices.map((s) => {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0; a0 = a1;
    return `<path d="M${cx},${cy} L${x0.toFixed(3)},${y0.toFixed(3)} A${r},${r} 0 ${large},1 ${x1.toFixed(3)},${y1.toFixed(3)} Z" fill="${s.color}" stroke="#fff" stroke-width="0.6"/>`;
  }).join('');
  return `<svg viewBox="0 0 100 100" class="pie">${paths}</svg>`;
}

// Build the standalone, light-theme print document for one part.
// paise date 'YYYY-MM-DD' -> 'dd/mm/yy' for the PDF (display-only; storage stays ISO).
function fmtDatePdf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
  return m ? (m[3] + '/' + m[2] + '/' + m[1].slice(2)) : String(iso == null ? '' : iso);
}
function buildOverviewPdfHtml(part, o, rows, range, theme) {
  const m = o.money;
  // Phase 4C — owed(F) is a signed balance (negative = overpaid; never clamped). Present a negative as
  // "Overpaid by ₹X" so it doesn't misread as money due. Same rule as the UI's PlannrUI.formatOwed.
  const fmtOwed = (v) => (v < 0 ? 'Overpaid by ' + fmtRs(-v) : fmtRs(v));
  const rangeLabel = (range.start || range.end) ? `${fmtDatePdf(range.start) || '…'} to ${fmtDatePdf(range.end) || '…'}` : 'All transactions';
  const slices = pdfSlices(o);
  const incl = (s) => (s === 'included' ? 'Yes' : 'No'); // "Contract Included" display

  const figuresBlock = () => {
    const figs = [
      ['Total contract (A)', m.totalContractPaise], ['Paid to contractors (B)', m.paidToContractorsPaise],
      ['Spent by self (C)', m.spentBySelfPaise], ['Total spent (D)', m.totalSpentPaise],
      ['Loan received (E)', m.loanReceivedPaise], ['Owed to contractors (F)', m.owedToContractorsPaise],
    ];
    return '<h2>Headline figures</h2><div class="figs">' +
      figs.map(([k, v]) => `<div class="fig"><div class="k">${pdfEsc(k)}</div><div class="v ${v < 0 ? 'neg' : ''}">${k.startsWith('Owed') ? fmtOwed(v) : fmtRs(v)}</div></div>`).join('') + '</div>';
  };
  const owedBlock = () => {
    // Phase 5D enforces a single contract, so this is singular now (the loop still maps the 0-or-1
    // array — correct for both cases). Heading + empty text reworded from the old "per contract".
    if (!o.contracts.length) return '<h2>Owed on the contract</h2><p class="muted">No contract yet.</p>';
    return '<h2>Owed on the contract</h2><table><thead><tr><th>Contractor</th><th>Area · Ledger</th><th class="num">Stated</th><th class="num">Paid</th><th class="num">Owed</th></tr></thead><tbody>' +
      o.contracts.map((c) => `<tr><td>${pdfEsc(c.contractorName || '—')}</td><td>${pdfEsc([c.areaOfWork, c.ledger].filter(Boolean).join(' · ')) || '—'}</td><td class="num">${fmtRs(c.statedPaise)}</td><td class="num">${fmtRs(c.paidPaise)}</td><td class="num ${c.owedPaise < 0 ? 'neg' : ''}">${fmtOwed(c.owedPaise)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td colspan="4">Owed to contractors (F)</td><td class="num">${fmtOwed(m.owedToContractorsPaise)}</td></tr></tfoot></table>`;
  };
  const budgetBlock = () => {
    if (o.budgetPaise == null) return '<h2>Budget</h2><p class="muted">No budget set. Total spent (D): <b>' + fmtRs(m.totalSpentPaise) + '</b>.</p>';
    const diff = o.budgetPaise - m.totalSpentPaise;
    return `<h2>Budget vs actual</h2><p>Budget <b>${fmtRs(o.budgetPaise)}</b> · Spent <b>${fmtRs(m.totalSpentPaise)}</b> · ${diff < 0 ? 'Over by <b class="neg">' + fmtRs(-diff) + '</b>' : '<b>' + fmtRs(diff) + '</b> left'}.</p>`;
  };
  const pieBlock = () => {
    if (!slices.length) return '<h2>Spending by Ledger</h2><p class="muted">No spending in this range.</p>';
    return '<h2>Spending by Ledger</h2><div class="pie-wrap">' + pdfPieSvg(slices) +
      '<div class="legend">' + slices.map((s) => `<div class="lg"><span class="sw" style="background:${s.color}"></span><span class="l">${pdfEsc(s.label)}</span><span class="v">${fmtRs(s.value)}</span></div>`).join('') + '</div></div>';
  };
  const ledgerTableBlock = () => {
    if (!slices.length) return '<h2>Spending by Ledger</h2><p class="muted">No spending in this range.</p>';
    return '<h2>Spending by Ledger</h2><table><thead><tr><th>Ledger</th><th class="num">Amount</th></tr></thead><tbody>' +
      slices.map((s) => `<tr><td>${pdfEsc(s.label)}</td><td class="num">${fmtRs(s.value)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td>Total spent (D)</td><td class="num">${fmtRs(m.totalSpentPaise)}</td></tr></tfoot></table>`;
  };
  const txTableBlock = () => {
    if (!rows.length) return '<h2>Transactions</h2><p class="muted">No outflow entries in this range.</p>';
    const total = rows.reduce((a, e) => a + e.amountPaise, 0);
    // The Contract Stated column is gone with the reimbursement offset — the number it printed is
    // no longer written or used, so a column that would read '—' on every future row is not carried.
    // Contract Included (Yes/No) stays: that label is still recorded.
    return '<h2>Transactions</h2><table><thead><tr><th class="num">#</th><th>Date</th><th class="num">Amount</th><th>By</th><th>Ledger</th><th>Remark</th><th>Contract Included</th></tr></thead><tbody>' +
      rows.map((e, i) => `<tr><td class="num">${i + 1}</td><td>${e.txDate ? pdfEsc(fmtDatePdf(e.txDate)) : '—'}</td><td class="num">${fmtRs(e.amountPaise)}</td><td>${pdfEsc(e.by)}</td><td>${pdfEsc(e.ledger)}</td><td>${e.reason ? pdfEsc(e.reason) : '—'}</td><td>${incl(e.contractScope)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td colspan="2">Total (${rows.length})</td><td class="num">${fmtRs(total)}</td><td colspan="4"></td></tr></tfoot></table>`;
  };

  const TITLE = { full: 'Overview', summary: 'Overview — summary', pie: 'Spending by Ledger — chart', table: 'Transactions', ledger: 'Spending by Ledger' };
  let body;
  if (part === 'pie') body = pieBlock();
  else if (part === 'table') body = txTableBlock();
  else if (part === 'ledger') body = ledgerTableBlock();
  // Phase 4C — 'summary' = the useful, bounded composition for the SCHEDULED/catch-up daily report:
  // headline figures + owed + budget + pie + the 23-line ledger rollup, and NO 1,800-row transactions
  // table (that PDF ran to 81 pages). The four MANUAL exports (full/pie/table/ledger) are unchanged.
  else if (part === 'summary') body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + ledgerTableBlock();
  else body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + txTableBlock();

  // Light (default) or dark palette — chosen by the user before export.
  const dark = theme === 'dark';
  const C = dark
    ? { bg: '#15161a', text: '#ececee', sub: '#a9aab0', head: '#f6b352', accent: '#f5b45b', line: '#2c2d33', line2: '#3a3b42', muted: '#9a9ba1', figB: '#3a3020', neg: '#f87171', swB: 'rgba(255,255,255,0.25)' }
    : { bg: '#ffffff', text: '#1a1a1a', sub: '#555555', head: '#7c3f12', accent: '#b45309', line: '#eeeeee', line2: '#dddddd', muted: '#888888', figB: '#eadfce', neg: '#b91c1c', swB: 'rgba(0,0,0,0.15)' };

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: ${C.text}; background: ${C.bg}; margin: 0; padding: 6px 2px; font-size: 12px; }
    .hdr { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 2px solid #f59e0b; padding-bottom: 8px; margin-bottom: 16px; }
    .brand { font-size: 22px; font-weight: 800; letter-spacing: 0.02em; color: ${C.text}; }
    .brand span { color: ${C.accent}; }
    .sub { font-size: 12px; color: ${C.sub}; text-align: right; }
    .sub b { color: ${C.text}; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: ${C.head}; border-bottom: 1px solid ${C.line}; padding-bottom: 4px; margin: 20px 0 10px; }
    .figs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .fig { border: 1px solid ${C.figB}; border-radius: 4px; padding: 8px 10px; }
    .fig .k { font-size: 10.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: 0.04em; }
    .fig .v { font-size: 17px; font-weight: 700; margin-top: 3px; color: ${C.accent}; }
    .fig .v.neg, .neg { color: ${C.neg}; }
    table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
    th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid ${C.line}; }
    th { text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; color: ${C.muted}; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    tfoot td { font-weight: 700; border-top: 2px solid ${C.line2}; border-bottom: none; }
    .muted { color: ${C.muted}; }
    .pie-wrap { display: flex; gap: 22px; align-items: center; }
    .pie { width: 200px; height: 200px; flex: none; }
    .legend { flex: 1 1 auto; }
    .lg { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 2px 0; }
    .sw { width: 12px; height: 12px; flex: none; border: 1px solid ${C.swB}; }
    .lg .l { flex: 1 1 auto; }
    .lg .v { font-weight: 600; white-space: nowrap; }
  </style></head><body>
    <div class="hdr">
      <div class="brand">Plann<span>r</span></div>
      <div class="sub">${pdfEsc(TITLE[part] || 'Overview')}<br>Date range: <b>${pdfEsc(rangeLabel)}</b></div>
    </div>
    ${body}
  </body></html>`;
}

// Render the Overview PDF to a Buffer. The SINGLE source of PDF generation — used by
// the HTTP export below. Defaults: full report, light theme. Throws on Playwright
// failure (callers handle it).
async function generateOverviewPdf({ part = 'full', theme = 'light', range = { start: null, end: null } } = {}) {
  const o = computeOverview(range);
  const inR = (d) => { if (!range.start && !range.end) return true; if (d == null) return false; if (range.start && d < range.start) return false; if (range.end && d > range.end) return false; return true; };
  const rows = LEDGER_CRUDS.cash_out.list().map(cashOutRow).filter((r) => inR(r.txDate));
  const html = buildOverviewPdfHtml(part, o, rows, range, theme);
  _pdfInFlight++;                                    // hold off the idle-close for the whole render
  try {
    const browser = await getPdfBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    } finally { await page.close(); }
  } finally { _pdfInFlight--; touchPdfActivity(); }  // (re)arm the idle timer after each render
}

// Basic concurrency guard for PDF generation: cap how many renders run at once so a burst
// of requests can't spawn many headless-Chromium pages and exhaust CPU/memory. Extra
// requests WAIT their turn (serialized); only if the wait queue is already full do we shed
// load with a 503. The Overview UI disables its download button per request and sends one
// at a time, so normal use of any of the four parts (full/pie/table/ledger) never waits.
const PDF_MAX_CONCURRENT = 2;
const PDF_MAX_QUEUED = 8;
let pdfActive = 0;
const pdfWaiters = [];
function acquirePdfSlot() {
  if (pdfActive < PDF_MAX_CONCURRENT) { pdfActive++; return Promise.resolve(true); }
  if (pdfWaiters.length >= PDF_MAX_QUEUED) return Promise.resolve(false); // too many queued -> shed load
  return new Promise((resolve) => pdfWaiters.push(resolve));
}
function releasePdfSlot() {
  const next = pdfWaiters.shift();
  if (next) next(true); // hand this slot to the next waiter (pdfActive unchanged)
  else pdfActive--;     // no one waiting -> free the slot
}

app.get('/api/overview/pdf', requireApiAuth, async (req, res) => {
  const s = parseIsoDate(req.query.start); if (s.error) return res.status(400).json({ error: 'Invalid start date (YYYY-MM-DD).' });
  const e = parseIsoDate(req.query.end); if (e.error) return res.status(400).json({ error: 'Invalid end date (YYYY-MM-DD).' });
  if (s.date && e.date && s.date > e.date) return res.status(400).json({ error: 'Start date must be on or before the end date.' });
  const part = ['full', 'pie', 'table', 'ledger'].includes(String(req.query.part)) ? String(req.query.part) : 'full';
  const theme = String(req.query.theme) === 'dark' ? 'dark' : 'light';
  // Validate BEFORE taking a slot so bad requests don't consume capacity.
  const gotSlot = await acquirePdfSlot();
  if (!gotSlot) return res.status(503).json({ error: 'The server is busy generating other PDFs right now. Please try again in a moment.' });
  try {
    const pdf = await generateOverviewPdf({ part, theme, range: { start: s.date, end: e.date } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="plannr-overview-${part}-${istDateStamp()}.pdf"`); // Phase 10C — IST date, not UTC
    res.send(pdf);
  } catch (err) {
    _pdfBrowserPromise = null; // reset so a later request can relaunch
    if (!IS_PROD) console.error('PDF generation failed:', err);
    res.status(503).json({ error: 'PDF generation is unavailable on the server (Playwright/Chromium not ready).' });
  } finally {
    releasePdfSlot();
  }
});

// ---------------------------------------------------------------------------
// Phase 2 — one-request health check for the windowless case. Server start time only now.
app.get('/api/health', requireApiAuth, (req, res) => {
  res.json({ serverStart: SERVER_START.toISOString() });
});

// ---------------------------------------------------------------------------
// Static frontend (with a server-side auth guard on the protected pages)
// ---------------------------------------------------------------------------

// Single-user offline app: pages are unguarded.
function requireAuth(req, res, next) {
  next();
}

// ---------------------------------------------------------------------------
// Data backup — restorable JSON export/import. Logged-in only. Covers ONLY the
// ledger data (contract, contract_payment_dates, contractor_payments, cash_in,
// cash_out, loans, settings); users/sessions/edit_locks are NEVER exported or
// touched by an import. Money stays INTEGER paise. Soft-deleted rows and all ids/
// foreign keys are preserved so rollups still resolve after a restore.
// ---------------------------------------------------------------------------
const BACKUP_SCHEMA_VERSION = 1;
// Import/insert order = parents before children (foreign keys are ON). Services phase: contract_services
// sits AFTER contract (its parent) and BEFORE cash_out (which references it via contract_service_id).
// Contract Phase A: contract_allowances sits AFTER contract (its parent) and BEFORE cash_out
// (which references it via contract_allowance_id) — same placement rule as contract_services.
const BACKUP_TABLES = ['contract', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments', 'loans', 'settings', 'cash_in', 'cash_out'];
// The AUTOINCREMENT tables among them (settings is key/value, not autoincrement).
const BACKUP_AUTOINC = ['contract', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments', 'loans', 'cash_in', 'cash_out'];

// TABLES THE IMPORT OWNS (clears during teardown). SINGLE SOURCE OF TRUTH for the teardown loop.
// Ordered CHILDREN-FIRST so DELETE never trips a foreign key and never leans on an implicit
// ON DELETE CASCADE to remove a child. The teardown skips any table not present on this DB.
// users/sessions/edit_locks are deliberately NOT owned — the import PRESERVES them (it remaps an
// unknown by_user_id to NULL precisely so existing users survive a restore).
// Phase 5C removed contract_services from this list: Phase 5B dropped cash_out.contract_service_id
// and Phase 5C dropped the contract_services table itself, so no DB has it any more — keeping it
// here would be dead config. The drift guard below now sees no table referencing it and passes.
//   fk chain (Services phase): contract ← contract_payment_dates, contractor_payments, contract_services;
//   and contract_services ← cash_out (contract_service_id). Children-first teardown: cash_out (child of
//   contract_services) precedes contract_services, which precedes contract.
//   Contract Phase A adds contract ← contract_allowances ← cash_out (contract_allowance_id), so
//   contract_allowances slots in after cash_out and before contract, same as contract_services.
//   assertImportOwnershipComplete() below fails the boot if that is ever forgotten.
const IMPORT_OWNED_TABLES = ['cash_out', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments', 'contract', 'cash_in', 'loans', 'settings'];

// Startup drift guard. If any table carries a foreign key INTO an import-owned table but is not
// itself owned, then clearing the owned parent would cascade/orphan that table's rows implicitly
// (the exact contract_services bug). Fail LOUDLY at boot rather than silently corrupt data during
// a restore. Derived from PRAGMA foreign_key_list — the real schema, not a maintained list.
// Runs at startup (called just below): it is O(tables), and it can only fire right after a schema
// change, so it surfaces the drift the moment it lands in EVERY environment — no test run required.
function assertImportOwnershipComplete() {
  const owned = new Set(IMPORT_OWNED_TABLES);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const offenders = [];
  for (const t of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) {
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
assertImportOwnershipComplete();

// Explicit column lists so an import writes ids + every foreign key verbatim.
const BACKUP_COLS = {
  contract: ['id', 'contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company',
    'rate_per_sqft_paise', 'measured_area_milli_sqft', 'completion_period_months', 'supervision_rate_pct', 'specified_brands', 'excluded_scope', 'owner_obligations',
    'created_at', 'updated_at', 'deleted_at'],
  // Contract Phase A dropped price_paise. An OLDER backup that still carries the key imports
  // fine — rows are written through this explicit column list, so an extra key is ignored (and
  // the figures themselves survive in settings._archived_service_prices_v1, written by the
  // migration that dropped the column).
  contract_services: ['id', 'contract_id', 'name', 'created_at', 'updated_at', 'deleted_at'],
  contract_allowances: ['id', 'contract_id', 'name', 'cap_kind', 'cap_paise', 'cap_rate_per_sqft_paise', 'area_milli_sqft', 'sort_order', 'created_at', 'updated_at', 'deleted_at'],
  contract_payment_dates: ['id', 'contract_id', 'pay_date', 'created_at'],
  contractor_payments: ['id', 'contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'remarks', 'created_at', 'updated_at', 'deleted_at'],
  loans: ['id', 'amount_paise', 'bank_name', 'interest_rate', 'tenure', 'created_at', 'updated_at', 'deleted_at'],
  settings: ['key', 'value'],
  cash_in: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason', 'created_at', 'updated_at', 'deleted_at'],
  cash_out: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_stated_paise', 'contract_service_id', 'contract_allowance_id', 'created_at', 'updated_at', 'deleted_at'],
};

// Phase 8B — settings keys that hold your family's CONTACT details (Gmail addresses + WhatsApp
// phone numbers for the Daily Report). Excluded from a user-facing export by default so a backup
// file you share/store doesn't carry them; included only on explicit opt-in. Everything else in
// settings (budget_paise, the schedule times) is NOT personal and is always exported.
const CONTACT_SETTINGS_KEYS = ['daily_report_recipients', 'daily_report_whatsapp'];

// A full snapshot of the ledger data as a plain object — raw rows, ALL columns, INCLUDING
// soft-deleted rows. Shared by /export (includeContacts from the opt-in) and the pre-import safety
// snapshot (includeContacts:true — a LOCAL rollback file that never leaves the machine, so it MUST
// keep the contacts or a rollback would lose them).
function buildBackup({ includeContacts = false } = {}) {
  const tables = {};
  for (const t of BACKUP_TABLES) tables[t] = repo.backup.exportTable(t);
  if (!includeContacts) tables.settings = tables.settings.filter((r) => !CONTACT_SETTINGS_KEYS.includes(r.key));
  return { app: 'plannr', kind: 'plannr-backup', schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables };
}

// Strict, side-effect-free validation of an uploaded backup. Returns { ok:true }
// or { error }. Checks schema version, expected tables, per-row required fields
// + types, money-as-integer, and referential sanity (cash_out links resolve
// inside the file; ledger codes real-or-CUSTOM; units positive where linked).
function validateBackup(data) {
  const isInt = (v) => Number.isInteger(v);
  const optInt = (v) => v == null || Number.isInteger(v);
  const optStr = (v) => v == null || typeof v === 'string';
  const optNum = (v) => v == null || (typeof v === 'number' && Number.isFinite(v));

  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'This is not a valid Plannr backup file.' };
  if (data.schemaVersion !== BACKUP_SCHEMA_VERSION) return { error: `Unsupported backup version (found ${JSON.stringify(data.schemaVersion)}; this app restores version ${BACKUP_SCHEMA_VERSION}).` };
  const T = data.tables;
  if (!T || typeof T !== 'object') return { error: 'Backup is missing its "tables" section.' };
  for (const t of BACKUP_TABLES) {
    if ((t === 'contract_payment_dates' || t === 'contractor_payments' || t === 'contract_services' || t === 'contract_allowances') && T[t] === undefined) continue; // optional (older backups predate them)
    if (!Array.isArray(T[t])) return { error: `Backup is missing or has an invalid "${t}" table.` };
  }

  const contractIds = new Set();
  for (const r of T.contract) {
    if (!isInt(r.id)) return { error: 'contract: a row has a non-integer id.' };
    if (!optInt(r.amount_paise)) return { error: 'contract: amount_paise must be integer paise or null.' };
    if (!optInt(r.price_of_contract_paise)) return { error: 'contract: price_of_contract_paise must be integer paise or null.' };
    if (!optStr(r.area_of_work)) return { error: 'contract: area_of_work must be a string or null.' };
    if (!(r.ledger_code == null || r.ledger_code === CUSTOM_CODE || LEDGER_BY_CODE.has(r.ledger_code))) return { error: `contract: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
    if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || (r.ledger_code != null && subBelongs(r.ledger_code, r.subledger_code)))) return { error: `contract: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
    { const d = parseIsoDate(r.date_signed); if (!(r.date_signed == null || (!d.error && d.date))) return { error: `contract: date_signed must be ISO YYYY-MM-DD or null (got ${JSON.stringify(r.date_signed)}).` }; }
    { const d = parseIsoDate(r.contract_end_date); if (!(r.contract_end_date == null || (!d.error && d.date))) return { error: `contract: contract_end_date must be ISO YYYY-MM-DD or null (got ${JSON.stringify(r.contract_end_date)}).` }; }
    if (!optStr(r.company)) return { error: 'contract: company must be a string or null.' }; // Services phase (Part F)
    // Contract Phase A — rate-based pricing + optional metadata. All nullable (every pre-Phase-A
    // backup has them absent, which reads as null and is correct).
    if (!optInt(r.rate_per_sqft_paise)) return { error: 'contract: rate_per_sqft_paise must be integer paise or null.' };
    if (!optInt(r.measured_area_milli_sqft)) return { error: 'contract: measured_area_milli_sqft must be an integer number of thousandths of a square foot, or null.' };
    if (!optInt(r.completion_period_months)) return { error: 'contract: completion_period_months must be a whole number of months or null.' };
    if (!optNum(r.supervision_rate_pct)) return { error: 'contract: supervision_rate_pct must be a number or null.' };
    for (const f of ['specified_brands', 'excluded_scope', 'owner_obligations']) {
      if (!optStr(r[f])) return { error: `contract: ${f} must be a string or null.` };
    }
    contractIds.add(r.id);
  }
  // Services phase (Part A) — contract_services rows (optional table). Collect valid ids so a debit's
  // contract_service_id can be checked to resolve inside the file.
  const serviceIds = new Set();
  for (const r of (T.contract_services || [])) {
    if (!isInt(r.id)) return { error: 'contract_services: a row has a non-integer id.' };
    if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contract_services: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'contract_services: name must be a non-empty string.' };
    // price_paise is NOT checked: Contract Phase A removed the column. A backup that still carries
    // the key is accepted and the value dropped on the way in (it is not in BACKUP_COLS).
    serviceIds.add(r.id);
  }
  // Contract Phase A — contract_allowances (optional table). Same shape of checks as services, plus
  // the cap-kind invariant: a lump cap MUST have its rupee ceiling, a per-sqft cap MUST have its
  // rate, and the area on a per-sqft cap stays optional (no area = a rate ceiling with no rupee
  // position, which is a legitimate state, not a broken row).
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
    if (!(r.ledger_code == null || r.ledger_code === CUSTOM_CODE || LEDGER_BY_CODE.has(r.ledger_code))) return { error: `contractor_payments: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
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
    // tx_date (Phase 4C): ISO 'YYYY-MM-DD' or null. A PRE-Phase-4 backup omits it entirely
    // (undefined -> treated as null) and imports fine; those rows stay dateless until edited.
    { const d = parseIsoDate(r.tx_date); if (!(r.tx_date == null || (!d.error && d.date))) return { error: `cash_in: tx_date must be an ISO YYYY-MM-DD date or null (got ${JSON.stringify(r.tx_date)}).` }; }
  }
  for (const r of T.cash_out) {
    if (!isInt(r.id)) return { error: 'cash_out: a row has a non-integer id.' };
    if (!isInt(r.amount_paise) || r.amount_paise <= 0) return { error: 'cash_out: amount_paise must be a positive integer (paise).' };
    // tx_date (Phase 1): ISO 'YYYY-MM-DD' or null. Older backups omit it entirely
    // (undefined -> treated as null) and import fine; those rows stay dateless.
    { const d = parseIsoDate(r.tx_date); if (!(r.tx_date == null || (!d.error && d.date))) return { error: `cash_out: tx_date must be an ISO YYYY-MM-DD date or null (got ${JSON.stringify(r.tx_date)}).` }; }
    // 'contractor' is still ACCEPTED here (legacy rows from old backups must import);
    // only NEW form writes reject it. Do not remove 'contractor' from this allowlist.
    if (!['user', 'contractor', 'custom'].includes(r.by_type)) return { error: `cash_out: invalid by_type ${JSON.stringify(r.by_type)}.` };
    if (!optInt(r.by_user_id)) return { error: 'cash_out: by_user_id must be an integer or null.' };
    if (!(r.ledger_code === CUSTOM_CODE || LEDGER_BY_CODE.has(r.ledger_code))) return { error: `cash_out: unknown ledger_code ${JSON.stringify(r.ledger_code)}.` };
    if (!(r.subledger_code == null || r.subledger_code === CUSTOM_CODE || subBelongs(r.ledger_code, r.subledger_code))) return { error: `cash_out: subledger_code ${JSON.stringify(r.subledger_code)} does not belong to ledger ${JSON.stringify(r.ledger_code)}.` };
    if (!['included', 'extra'].includes(r.contract_scope)) return { error: `cash_out: invalid contract_scope ${JSON.stringify(r.contract_scope)}.` };
    // contract_stated_paise — the retired Phase 5E offset column. Kept nullable in the schema and
    // still round-tripped by backups so a historical value survives an export/import, but nothing
    // reads it any more. Absent on pre-Phase-5 backups (undefined -> NULL). Type-check only.
    if (!optInt(r.contract_stated_paise)) return { error: 'cash_out: contract_stated_paise must be an integer (paise) or null.' };
    // Services phase (Part C/D): contract_service_id — optional. Absent on pre-change backups
    // (undefined -> NULL). If present, it must resolve to a service inside the file (referential
    // sanity); the DB's partial-unique index is the ultimate one-service-one-live-debit backstop on insert.
    if (!(r.contract_service_id == null || (isInt(r.contract_service_id) && serviceIds.has(r.contract_service_id)))) return { error: `cash_out: contract_service_id ${JSON.stringify(r.contract_service_id)} is not present in the backup's contract_services.` };
    // Contract Phase A: the allowance draw must resolve inside the file too. Absent on every
    // pre-Phase-A backup, which reads as null.
    if (!(r.contract_allowance_id == null || (isInt(r.contract_allowance_id) && allowanceIds.has(r.contract_allowance_id)))) return { error: `cash_out: contract_allowance_id ${JSON.stringify(r.contract_allowance_id)} is not present in the backup's contract_allowances.` };
  }
  return { ok: true };
}

// EXPORT: one JSON object (schema version + timestamp + every ledger table as
// arrays of full rows, incl. soft-deleted + the budget/settings). The frontend
// downloads it via fetch, but Content-Disposition names it for direct hits too.
// Phase 10b — full encrypted database snapshot, added specifically so the Ledger List CSV import
// (below) has something real to trigger as its non-negotiable pre-import restore point: server.js
// never had an encrypted, user-downloadable backup route before (only the plain-JSON ledger export
// above, and the unattended backup-db.js cron script, which writes to disk rather than the browser).
// VACUUM INTO a temp file first (safe to run against a live DB — see backup-db.js's own header for
// why), encrypt it, delete the temp file, return the bytes directly — same contract as local-api.js's
// export-encrypted, so the client-side code that calls this works identically under either backend.
function vacuumSnapshotBytes() {
  const tmp = path.join(os.tmpdir(), `plannr-ledger-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
  let handle;
  try {
    const destSql = tmp.split('\\').join('/'); // SQLite wants forward slashes in the SQL string literal
    try {
      handle = new DatabaseSync(DB_PATH, { readOnly: true });
      handle.exec(`VACUUM INTO '${destSql}'`);
    } catch (e) {
      try { if (handle) handle.close(); } catch { /* ignore */ }
      handle = new DatabaseSync(DB_PATH);
      handle.exec(`VACUUM INTO '${destSql}'`);
    }
    return fs.readFileSync(tmp);
  } finally {
    try { if (handle) handle.close(); } catch { /* ignore */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* ignore */ } }
  }
}
app.post('/api/backup/export-encrypted', requireApiAuth, (req, res) => {
  const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
  if (!passphrase) return res.status(400).json({ error: 'Enter a passphrase to encrypt this backup.' });
  try {
    const plain = vacuumSnapshotBytes();
    const enc = encrypt(plain, passphrase);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(enc);
  } catch (e) {
    if (!IS_PROD) console.error('Encrypted export failed:', e);
    res.status(500).json({ error: 'Could not build the encrypted backup: ' + e.message });
  }
});

// public/local-api.js has a real POST /api/backup/import-encrypted (Phase 7) — swapping the live
// SQLite file out from under an in-memory browser DB is straightforward there. Doing the same under
// server.js means safely closing/replacing/reopening a live node:sqlite handle shared by every route
// above, which is real design work, not a one-line port. Until that's built, the shared data-backup.html
// button must fail with a clear, specific message instead of Express's raw 404 (which the client's
// res.json().catch(() => ({})) swallows into a generic, misleading "Restore failed" — see Phase 11 audit).
app.post('/api/backup/import-encrypted', requireApiAuth, (req, res) => {
  res.status(501).json({ error: 'Restoring from an encrypted backup isn’t available when Plannr is running as a hosted server. Use the Android app to restore an encrypted backup, or restore this server from the plain JSON backup instead.' });
});

// ---------------------------------------------------------------------------
// Phase 15 — backup-overdue reminder. last_encrypted_export_at is stamped only by a VERIFIED
// encrypted full backup (see saveFile() in data-backup.html, gated on the .db.enc filename) — a
// JSON export or a Ledger List CSV is not a complete restore point, so neither touches this.
// backup_reminder_days is the user's overdue threshold: unset = the default (7), the literal string
// 'off' = disabled, otherwise a whole number of days.
// ---------------------------------------------------------------------------
const BACKUP_REMINDER_DEFAULT_DAYS = 7;
const BACKUP_REMINDER_MIN_DAYS = 1;
const BACKUP_REMINDER_MAX_DAYS = 365;

function getLastExportAt() {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'last_encrypted_export_at'").get();
  return (r && r.value) ? r.value : null;
}

function getBackupReminderDays() {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'backup_reminder_days'").get();
  if (!r || r.value == null) return BACKUP_REMINDER_DEFAULT_DAYS;
  if (r.value === 'off') return null;
  const n = Number(r.value);
  return Number.isInteger(n) && n >= BACKUP_REMINDER_MIN_DAYS && n <= BACKUP_REMINDER_MAX_DAYS ? n : BACKUP_REMINDER_DEFAULT_DAYS;
}

// Whole days elapsed since `utc` ('YYYY-MM-DD HH:MM:SS', same shape as every other *_at column) —
// floored, so "6 days and 23 hours" reads as 6 rather than rounding up to a false "7 days ago".
function daysSinceUtc(utc) {
  const then = new Date(String(utc).replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

function getBackupReminderStatus() {
  const lastExportAt = getLastExportAt();
  const reminderDays = getBackupReminderDays();
  const since = lastExportAt ? daysSinceUtc(lastExportAt) : null;
  const overdue = reminderDays != null && (since === null || since > reminderDays);
  return { lastExportAt, reminderDays, daysSince: since, overdue };
}

app.get('/api/backup/reminder', requireApiAuth, (req, res) => { res.json(getBackupReminderStatus()); });

app.put('/api/backup/reminder', requireApiAuth, (req, res) => {
  const raw = req.body.days;
  if (raw === null || raw === 'off') {
    db.prepare("INSERT INTO settings (key, value) VALUES ('backup_reminder_days', 'off') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    return res.json(getBackupReminderStatus());
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < BACKUP_REMINDER_MIN_DAYS || n > BACKUP_REMINDER_MAX_DAYS) {
    return res.status(400).json({ error: `Enter a whole number of days between ${BACKUP_REMINDER_MIN_DAYS} and ${BACKUP_REMINDER_MAX_DAYS}, or turn it off.` });
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('backup_reminder_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
  res.json(getBackupReminderStatus());
});

// Called only after the encrypted backup file is verified to actually exist (Filesystem.stat() on
// native, the closest browser equivalent otherwise) — see saveFile() in data-backup.html.
app.post('/api/backup/mark-exported', requireApiAuth, (req, res) => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('last_encrypted_export_at', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  res.json(getBackupReminderStatus());
});

app.get('/api/backup/export', requireApiAuth, (req, res) => {
  // Phase 8B — contacts (Gmail + WhatsApp numbers) are excluded unless the user opts in on the Data
  // page (?includeContacts=1). Default omits them so a shared/stored backup carries no personal data.
  const includeContacts = req.query.includeContacts === '1';
  const backup = buildBackup({ includeContacts });
  res.setHeader('Content-Disposition', `attachment; filename="plannr-backup-${backup.exportedAt.slice(0, 10)}.json"`);
  res.json(backup);
});

// IMPORT (REPLACE, made safe): validate fully -> auto-snapshot current data ->
// replace all ledger data in ONE transaction, preserving ids + foreign keys.
// Never deletes before the replacement is proven valid; rolls back on any error.
app.post('/api/backup/import', jsonBackup, requireApiAuth, (req, res) => {
  // 1. VALIDATE — abort before changing anything.
  const v = validateBackup(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const T = req.body.tables;

  // 2. AUTO-SNAPSHOT the current data first, beside the DB file. Report its path.
  let snapshot;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapPath = path.join(path.dirname(DB_PATH), `auto-snapshot-before-import-${stamp}.json`);
    fs.writeFileSync(snapPath, JSON.stringify(buildBackup({ includeContacts: true }), null, 2)); // local rollback file — keeps contacts
    snapshot = path.relative(__dirname, snapPath).split(path.sep).join('/');
  } catch (e) {
    if (!IS_PROD) console.error('Backup snapshot failed:', e);
    return res.status(500).json({ error: 'Could not write the safety snapshot, so the import was aborted — your current data is unchanged.' });
  }

  // 3. REPLACE in one transaction. Rows whose by_user_id is not a user in THIS
  // install keep by_type/by_label but drop the id to NULL (displays as "Unknown"
  // via the existing fallback), so a missing user never fails the import.
  const userIds = new Set(db.prepare('SELECT id FROM users').all().map((u) => u.id));
  let remappedUsers = 0;
  // Which owned tables actually exist here (contract_services is absent on fresh DBs).
  const existingTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));

  db.exec('BEGIN');
  try {
    // The teardown clears every import-owned table, CHILDREN-FIRST (IMPORT_OWNED_TABLES). users/
    // sessions/edit_locks are not owned. Settings is NOT cleared (absent keys keep their current
    // value); present keys are UPSERTed below.
    for (const t of IMPORT_OWNED_TABLES) { if (t === 'settings') continue; if (existingTables.has(t)) repo.backup.deleteTenantRows(t); }
    // No sqlite_sequence reset here. The rows were just freed by the teardown above, so re-inserting
    // them collides with nothing; the AUTOINCREMENT high-water mark is left as SQLite maintains it
    // (never reused).

    for (const t of BACKUP_TABLES) {
      // Settings is UPSERTed (not cleared+inserted).
      if (t === 'settings') {
        for (const r of (T.settings || [])) repo.backup.upsertSetting(r.key, r.value === undefined ? null : r.value);
        continue;
      }
      // ids are preserved (FK integrity within the file); a colliding id -> the whole transaction
      // rolls back, leaving the existing data byte-identical.
      const cols = BACKUP_COLS[t];
      for (const r of (T[t] || [])) {
        const vals = cols.map((col) => {
          let val = r[col];
          if (col === 'by_user_id' && val != null && !userIds.has(val)) { val = null; remappedUsers++; }
          return val === undefined ? null : val;
        });
        repo.backup.insertRow(t, cols, vals);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if (!IS_PROD) console.error('Backup import failed, rolled back:', e);
    if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — the import did not go through. Free up space, then try again.', snapshot });
    return res.status(500).json({ error: 'The import failed and was rolled back — your current data is unchanged. The file may be internally inconsistent.', snapshot });
  }

  const imported = {};
  for (const t of BACKUP_TABLES) imported[t] = (T[t] || []).length;
  res.json({ ok: true, imported, remappedUsers, snapshot });
});

// Guard the protected pages' RAW filenames BEFORE express.static, so a
// logged-out request for /home.html or /date.html is redirected instead of
// being served the file directly. A logged-in request calls next() and falls
// through to express.static, which serves the exact same bytes as before.
app.get(['/home.html', '/cash-flow.html', '/cash-inflow.html', '/loan-details.html', '/cash-outflow.html', '/contract-details.html', '/contractor-payments.html', '/overview.html', '/data-backup.html'], requireAuth);

// Static assets, cache policy by kind (Phase 7D):
//  - vendor/ (three, ogl, postprocessing) + fonts/*.woff2 NEVER change without a filename change,
//    so cache them for a year and mark immutable — the browser then skips even the revalidation
//    round-trip on repeat loads. This is the bulk of the transferred bytes.
//  - .html is the app shell that names every other asset; it must always be fresh, so no-cache
//    (store but ALWAYS revalidate — a 304 when unchanged, never a stale shell).
//  - everything else (styles.css, plannr-ui.js, ledgers.js, auth.js, date.*, the effect modules,
//    svgs) is edited during development, so it keeps express.static's default (max-age=0 + ETag =
//    revalidate every load). TRADE-OFF vs a ?v= version query string: revalidation costs one tiny
//    conditional GET (304, no body) per file per load, but needs zero manual version bumps and an
//    edit is visible on the very next reload. For a small live-edited app that's the right side of
//    the trade — versioned URLs would trade those cheap 304s for the toil of bumping a query string
//    (or adding a build step) on every CSS/JS change.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/[\\/](vendor|fonts)[\\/]/.test(filePath) || filePath.endsWith('.woff2')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// Serve a static HTML page from public/ (shared by the page routes below). Same no-cache as the
// raw .html above — these ARE the same files, just reached via clean URLs (/overview vs
// /overview.html) — so the shell is never served stale from either path.
const sendPage = (res, file) => {
  res.sendFile(path.join(__dirname, 'public', file), { headers: { 'Cache-Control': 'no-cache' } });
};

// Home (the "logged-in" page). Guarded server-side; the in-page /api/me check
// stays as a secondary client-side guard.
app.get('/', requireAuth, (req, res) => sendPage(res, 'home.html'));

// Phase 4B — the /select-date screen was removed: it defaulted to today and wrote a
// localStorage value nothing read (login now redirects straight to home). date.html/js/css and
// its sole effect (hyperspeed.js + the postprocessing dep) were deleted with it.

// Cash Flow landing page (reached from the home "Cash Flow" nav button). Guarded
// server-side like the other pages; its raw filename /cash-flow.html is guarded
// above (before express.static) so there is no logged-out backdoor.
app.get('/cash-flow', requireAuth, (req, res) => sendPage(res, 'cash-flow.html'));

// Cash Inflow (Money Credited) screen, reached from the cash-flow "Cash inflow"
// button. Guarded; raw filename /cash-inflow.html guarded above.
app.get('/cash-inflow', requireAuth, (req, res) => sendPage(res, 'cash-inflow.html'));

// Loan Details screen, reached from the cash-flow "Loan details" button. Guarded;
// raw filename /loan-details.html guarded above.
app.get('/loan-details', requireAuth, (req, res) => sendPage(res, 'loan-details.html'));

// Cash Outflow (Money Debited) screen, reached from the cash-flow "Cash outflow"
// button. Guarded; raw filename /cash-outflow.html guarded above.
app.get('/cash-outflow', requireAuth, (req, res) => sendPage(res, 'cash-outflow.html'));

// Contract Details screen, reached from the home "Contract details" button.
// Guarded; raw filename /contract-details.html guarded above.
app.get('/contract-details', requireAuth, (req, res) => sendPage(res, 'contract-details.html'));

// Contractor Payments screen (Phase 3), reached from the Cash Flow "Contractor
// payments" button. Guarded; raw filename /contractor-payments.html guarded above.
app.get('/contractor-payments', requireAuth, (req, res) => sendPage(res, 'contractor-payments.html'));

// Overview (read-only analytics) screen, reached from the home "Overview" button.
// Guarded; raw filename /overview.html guarded above.
app.get('/overview', requireAuth, (req, res) => { warmPdfBrowser(); sendPage(res, 'overview.html'); });

// Data Backup screen, reached from the home "Data backup" button. Guarded; raw
// filename /data-backup.html guarded above (no logged-out backdoor).
app.get('/data-backup', requireAuth, (req, res) => sendPage(res, 'data-backup.html'));

// ---------------------------------------------------------------------------
// Global error handler (must be last; 4-arg signature). node:sqlite is
// synchronous and Express forwards synchronous throws from handlers here, so
// individual routes don't need try/catch. Never leak internals in production.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Respect a status the error already carries (e.g. body-parser sets 400 for
  // malformed JSON). Only genuine server errors (5xx) are logged and get the
  // generic 'Something went wrong.' message; client errors report their status.
  const status = (err && (err.statusCode || err.status)) || 500;
  if (status >= 500) console.error('Unhandled error:', err);
  // Phase 4a (WASM SQLite port prep): a write that hit the kvvfs storage ceiling surfaces as a clean
  // SQLITE_IOERR (confirmed in the storage-ceiling spike — atomic rollback, never corruption). Most
  // write routes have no try/catch of their own (see the comment above this handler), so this is
  // where their errors land; give a clear message instead of the raw SQLite one.
  if (status >= 500 && isStorageFullError(err)) {
    return res.status(500).json({ error: 'Storage is full — this save did not go through. Free up space, then try again.' });
  }
  // Body-parser "payload too large" (413 / entity.too.large): a Save All batch whose rows carry
  // very long remarks can exceed the 256kb parser limit BEFORE the row-count check runs, which
  // otherwise surfaces as a bare "Invalid request." Give it a clear message consistent with the
  // batch row-cap 413 ("Save in smaller batches").
  if (status === 413 || (err && err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'That request was too large to process in one go — save fewer rows at a time (the batch limit is 500 rows).' });
  }
  const body = { error: status >= 500 ? 'Something went wrong.' : 'Invalid request.' };
  if (!IS_PROD && err && err.message) body.detail = err.message; // dev aid only
  res.status(status).json(body);
});

// ---------------------------------------------------------------------------
// Graceful shutdown: on a normal stop (e.g. Ctrl+C), close the DB cleanly.
// Phase 4a (WASM SQLite port prep): journal_mode is DELETE, not WAL (see db.js), so every commit
// already lands directly in data/plannr.db — there is no WAL to checkpoint or fold in, and a copy of
// plannr.db alone is always complete. (On a hard kill the handler won't run either way, but there's
// nothing left stranded for it to recover.)
// ---------------------------------------------------------------------------
// Phase 7A — clean shutdown that reaps the Playwright Chromium browser before exit. Async so the
// close can be awaited; a hard timeout force-exits if Chromium hangs; a SECOND Ctrl+C exits immediately.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('[shutdown] signal received — closing the PDF browser…');
  // A hung Chromium must never leave the process unkillable — force-exit as a last resort. Impatient?
  // A second Ctrl+C exits immediately.
  const hardKill = setTimeout(() => { console.error('[shutdown] timed out — forcing exit.'); process.exit(1); }, 35000);
  // Playwright: _pdfBrowserPromise may be PENDING or REJECTED (not a browser) — await defensively
  //    and skip cleanly if it rejected.
  try {
    if (_pdfBrowserPromise) { const b = await _pdfBrowserPromise.catch(() => null); if (b) await b.close().catch(() => {}); }
  } catch (e) { console.error('PDF browser shutdown error:', e); }
  // 3) Close the DB (no WAL to checkpoint — see the comment above shutdown()).
  try { db.close(); } catch (e) { console.error('DB shutdown error:', e); }
  clearTimeout(hardKill);
  console.log('[shutdown] browsers closed, DB closed — exiting cleanly.');
  process.exit(0);
}

// Phase 11B — a console-independent graceful stop. A windowless server (Task Scheduler's
// plannr-start.cmd) can't receive a Ctrl+C-equivalent on Windows — the ONLY way to stop it was a
// forced kill, which skips shutdown() entirely: the WAL never checkpoints, both Chromium trees leak on
// every logoff, and the complete session snapshot (whose only trigger is shutdown()) never gets taken.
// Fix: poll for a sentinel file (stop-plannr.cmd creates it) and route into the SAME shutdown() the
// signal handlers use — shutdown() itself is unchanged. POLL, not fs.watch, deliberately: fs.watch on
// the project dir fires constantly (the DB WAL, log files) and is platform-quirky; a once-a-second
// existence check is trivial, predictable, cross-platform, and 1s stop latency is fine for a shutdown.
const STOP_SENTINEL = path.join(__dirname, '.plannr-stop');
function watchStopSentinel(sentinelPath, onStop, intervalMs = 1000) {
  try { fs.rmSync(sentinelPath, { force: true }); } catch { /* ignore */ } // remove a STALE file BEFORE polling, so a leftover can't stop this fresh boot
  const timer = setInterval(() => {
    let exists = false; try { exists = fs.existsSync(sentinelPath); } catch { /* ignore */ }
    if (exists) { clearInterval(timer); console.log('[shutdown] stop sentinel detected — shutting down gracefully (same path as Ctrl+C).'); onStop(); }
  }, intervalMs);
  if (timer.unref) timer.unref(); // don't keep the event loop alive just for this poll
  return timer;
}

// Phase 9 — export the Express app so the test suite can start it on an ephemeral port WITHOUT any
// of the external side effects below (no listener on :3000, no cron).
app._assertImportOwnershipComplete = assertImportOwnershipComplete; // Phase 9: exercised by schema tests
app._closePdfBrowser = closeIdlePdfBrowser; // Phase 9: tests that hit /overview warm Playwright; teardown closes it
app._pdfBrowserActive = () => _pdfBrowserPromise !== null; // Phase 10A: read-only — is a PDF browser warmed?
app._watchStopSentinel = watchStopSentinel; // Phase 11B: test that a sentinel file routes into the same stop callback as SIGINT
// Phase 10G — the exact HTML page.pdf() rasterizes, for rendering the table to an image in tests
// (the authoritative composition path; the endpoint's compressed stream is a weaker check).
app._overviewPdfHtml = ({ part = 'full', theme = 'light', range = { start: null, end: null } } = {}) => {
  const o = computeOverview(range);
  const inR = (d) => { if (!range.start && !range.end) return true; if (d == null) return false; if (range.start && d < range.start) return false; if (range.end && d > range.end) return false; return true; };
  const rows = LEDGER_CRUDS.cash_out.list().map(cashOutRow).filter((r) => inR(r.txDate));
  return buildOverviewPdfHtml(part, o, rows, range, theme);
};
// Pre-builds every column/table-dependent repo statement (the makeLedgerCrud/trash factories already
// built theirs at route-registration time above).
repo.configure({ contractCols: CONTRACT_COLS, backupTables: BACKUP_TABLES, backupCols: BACKUP_COLS });

module.exports = app;

// EXTERNAL side effects — the LAN listener, cron scheduling, and the process signal handlers — run
// ONLY when started directly (`node server.js`), NEVER when the app is imported (node --test). This
// is what makes the suite structurally unable to schedule a real send. `npm start` is unchanged:
// there, require.main === module.
if (require.main === module) {
  let sigints = 0;
  process.on('SIGINT', () => {
    if (++sigints >= 2) {
      // Phase 9 (Part E): the force-exit bypasses shutdown()'s graceful close (PDF browser cleanup,
      // clean DB close). Warn loudly.
      console.error('[shutdown] second Ctrl+C — force-exiting NOW, bypassing the graceful close.');
      process.exit(1);
    }
    shutdown();
  });
  process.on('SIGTERM', shutdown);
  // Phase 11B — console-independent graceful stop for the windowless auto-started server: a sentinel
  // file (created by stop-plannr.cmd) routes into the SAME shutdown() as the signals above. Removes a
  // stale sentinel on boot so a leftover can't stop this start.
  watchStopSentinel(STOP_SENTINEL, shutdown);

  // Bind to 0.0.0.0 so phones/laptops on the same Wi-Fi can reach Plannr, not just this machine.
  const os = require('os');
  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)?.address;

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Plannr running at http://localhost:${PORT}`);
    if (lanIp) console.log(`  on your network:  http://${lanIp}:${PORT}`);
  });
}
