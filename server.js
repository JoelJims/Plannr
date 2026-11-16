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
const { db, init, DB_PATH, isStorageFullError, rollbackQuietly } = require('./db');
const { encrypt, MIN_PASSPHRASE_LEN } = require('./backup-crypto'); // Phase 10b — the pre-Ledger-List-import safety backup

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

// ---------------------------------------------------------------------------
// Network access. Plannr has no login, so this server must never be reachable from other machines
// by accident. Default: listen on 127.0.0.1 (this PC only). LAN access is an explicit opt-in —
// PLANNR_HOST=0.0.0.0 (or a LAN IP) — and then every request that does not come from this PC must
// carry PLANNR_TOKEN; the server refuses to start in LAN mode without a long enough token.
// Read from the environment on every call (not once at load) so tests can switch modes per case.
// ---------------------------------------------------------------------------
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const MIN_TOKEN_LEN = 16;
function accessConfig(env = process.env) {
  const host = String(env.PLANNR_HOST || '127.0.0.1').trim();
  return { host, lan: !LOOPBACK_NAMES.has(host.toLowerCase()), token: String(env.PLANNR_TOKEN || '') };
}
// "[::1]:3000" -> "::1", "LocalHost:3000" -> "localhost", missing -> ""
function hostNameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end > 0 ? h.slice(1, end) : ''; }
  return h.replace(/:\d+$/, '');
}
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const isLoopbackAddr = (a) => { const s = String(a || ''); return s === '::1' || s.startsWith('127.') || s.startsWith('::ffff:127.'); };
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}
function accessGate(req, res, next) {
  const cfg = accessConfig();
  // 1) Host allow-list. Blocks DNS rebinding: a page on evil.example that re-points its name at
  //    127.0.0.1 still sends "Host: evil.example". Loopback names always pass; in LAN mode a bare
  //    IPv4 address passes too (rebinding needs a domain name, so an IP literal is safe).
  const name = hostNameOf(req.headers.host);
  if (!(LOOPBACK_NAMES.has(name) || (cfg.lan && isIPv4(name)))) {
    return res.status(403).type('text/plain').send('Plannr: unexpected Host header.');
  }
  // 2) LAN mode: a request from another machine needs the token — once via ?token= (which sets an
  //    HttpOnly cookie and redirects the token out of the address bar), then by cookie or Bearer.
  if (cfg.lan && !isLoopbackAddr(req.socket && req.socket.remoteAddress)) {
    const fromQuery = typeof req.query.token === 'string' ? req.query.token : '';
    if (fromQuery && tokenMatches(fromQuery, cfg.token)) {
      res.setHeader('Set-Cookie', `plannr_token=${encodeURIComponent(cfg.token)}; HttpOnly; SameSite=Strict; Path=/`);
      return res.redirect(302, req.path.startsWith('//') ? '/' : req.path); // '//x' would be an open redirect
    }
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : cookieValue(req.headers.cookie, 'plannr_token');
    if (!tokenMatches(given, cfg.token)) {
      return res.status(401).type('text/plain').send('Plannr: open this address once with ?token=<PLANNR_TOKEN> first.');
    }
  }
  next();
}
app.use(accessGate);
// Basic hardening headers on every response. (No Content-Security-Policy yet: the pages still carry
// inline scripts and import maps, which a strict CSP would block.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Phase 2 (Step 6): the explicit "this is the desktop dev server" marker. public/runtime-mode.js
  // uses it (in a plain browser only; never inside the phone app) to leave /api to this server.
  res.setHeader('X-Plannr-Dev-Server', '1');
  next();
});

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
// Request checks shared with the phone (size limits, malformed JSON, unknown /api routes).
const requestRules = require('./request-rules');
// Pure input checks and formatting, shared with the phone (cross-platform plan, step 1.3).
const { str, parsePaise, parseIsoDate, parseAmountFilter, parseLedgerFilters, fmtRs } = require('./core/parsers.js');
const { createLedgerIndex } = require('./core/ledger-index.js');

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
// Phase 2: an existence check for validating a chosen by_user_id. (The roster itself is read in
// core/routes/people.js.)
const USER_EXISTS_STMT = db.prepare('SELECT 1 FROM users WHERE id = ?');
const userExists = (id) => Number.isInteger(id) && !!USER_EXISTS_STMT.get(id);

// JSON body parsing, one size limit per kind of route. The limits, which route gets which, and the
// "too large" / "Invalid request." answers live in request-rules.js, shared with the phone
// (public/local-api.js applies the same rules). 32 KB for every normal route; 256 KB for Save All
// batches (the batch route ALSO caps the row count: BATCH_MAX_ROWS in core/ledger-crud.js); 20 MB for restoring a backup.
// Errors are answered by the global error handler at the end of this file.
const JSON_PARSERS = Object.fromEntries(Object.entries(requestRules.BODY_LIMITS)
  .map(([kind, limit]) => [kind, express.json({ limit })]));
app.use((req, res, next) => JSON_PARSERS[requestRules.bodyKind(req.method, req.path)](req, res, next));

// Single-user offline app: every request resolves to the fixed local owner, no session lookup.
function currentUser(req) { return getOwner(); }

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Cross-platform plan, step 1.3: route groups move one at a time into core/routes/, the one copy
// both this server and the phone (public/local-api.js) run. coreContext is what those routes need
// from this side; the phone builds its own. Routes still written here come after.
// The ledger list (categories), kept in memory and refreshed after an import or a restore.
const ledgerIndex = createLedgerIndex(repo);
const coreContext = {
  db, repo, getOwner, userExists, isStorageFullError, rollbackQuietly, istDateStamp, parseLedgerFilters,
  auth: requireApiAuth,
  logError: (...args) => { if (!IS_PROD) console.error(...args); },
  storageFull: (what) => `Storage is full — ${what} Free up space, then try again.`,
  ledgerIndex,
};
require('./core/routes/people.js').register(app, coreContext);
require('./core/routes/ledger-list.js').register(app, coreContext);

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

// The shared list/add/edit/delete/batch routes for the ledger tables live in core/ledger-crud.js
// (step 1.3). Each table below registers through makeLedgerCrud.
const { makeLedgerCrud, LEDGER_CRUDS } = require('./core/ledger-crud.js').createLedgerCrud(app, coreContext);

// Cash in, loans and cash out: core/routes/cash-and-loans.js (step 1.3). What it returns is used by
// the routes still written below.
const { REASON_MAX, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CUSTOM_CODE, ledgerLabel, resolveLedger, CASH_OUT_SELECT, cashOutRow } = require('./core/routes/cash-and-loans.js').register(app, { ...coreContext, makeLedgerCrud });
// The Contract Details API (contracts, services, allowances): core/routes/contracts.js (step 1.3).
const { unitPricePaise, contractRow, CONTRACT_COLS } = require('./core/routes/contracts.js').register(app, { ...coreContext, ledgerLabel, resolveLedger });

// The Contractor Payments API: core/routes/contractor-payments.js (step 1.3).
const { CONTRACTOR_PAYMENTS_SELECT, paymentRow } = require('./core/routes/contractor-payments.js').register(app, { ...coreContext, makeLedgerCrud, ledgerLabel, resolveLedger, REASON_MAX });

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
      const meta = isCustom ? null : ledgerIndex.byCode().get(ledgerCode);
      L = { code: key, name: isCustom ? CUSTOM_GROUP_NAME : (meta ? `${meta.code} ${meta.name}` : ledgerCode), isCustom, ...zero(), subs: new Map(), noSub: zero() };
      ledMap.set(key, L);
    }
    add(L, byType, amt);
    if (subCode) {
      let subKey, subName;
      if (subCode === CUSTOM_CODE) { subName = subCustom || 'Custom sub-ledger'; subKey = 'CUSTOM:' + subName; }
      else {
        const meta = isCustom ? null : ledgerIndex.byCode().get(ledgerCode);
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
    const idx = Math.max(0, ledgerIndex.list().findIndex((x) => x.code === L.code));
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
// Data backup — restorable JSON export/import. The format (which tables and columns, validation,
// the restore transaction) lives in backup-format.js, shared with the phone's public/local-api.js so
// the two can never drift. v2 carries EVERY table — people, categories, saved custom names, ledger
// data, settings and the AUTOINCREMENT high-water marks — so a backup fully rebuilds the app on a
// new phone. v1 files (ledger data + settings only) still restore. Money stays INTEGER paise.
// Soft-deleted rows and all ids/foreign keys are preserved.
// ---------------------------------------------------------------------------
const backupFormat = require('./backup-format');
// Startup drift guard (see backup-format.js): fail at boot, not silently during a restore.
const assertImportOwnershipComplete = () => backupFormat.assertImportOwnershipComplete(db);
assertImportOwnershipComplete();
const buildBackup = (opts) => backupFormat.buildBackup(db, opts);
// Read ledgerIndex.byCode() at call time: ledgerIndex.refresh() replaces it after a category import or restore.
const validateBackup = (data) => backupFormat.validateBackup(data, { liveLedgerByCode: ledgerIndex.byCode(), customCode: CUSTOM_CODE, parseIsoDate });

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
  if ([...passphrase].length < MIN_PASSPHRASE_LEN) return res.status(400).json({ error: `Use a passphrase of at least ${MIN_PASSPHRASE_LEN} characters. A short one can be guessed by anyone who gets the file.` });
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

// Storage meter on the Data Backup page (Phase 2, Step 3). The phone answers this from its app
// storage limit (public/local-api.js measureStorage()); a desktop database file has no such limit.
app.get('/api/storage', requireApiAuth, (req, res) => {
  let databaseBytes = null;
  try { databaseBytes = fs.statSync(DB_PATH).size; } catch { /* reported as unknown */ }
  res.json({ mode: 'desktop', databaseBytes, usedBytes: null, limitBytes: null, fraction: null, level: 'ok' });
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
app.post('/api/backup/import', requireApiAuth, (req, res) => {
  // 1. VALIDATE — abort before changing anything.
  const v = validateBackup(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

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

  // 3. REPLACE in one transaction (backup-format.js). Any error rolls back: current data unchanged.
  let result;
  try {
    result = backupFormat.applyBackup(db, req.body);
  } catch (e) {
    if (!IS_PROD) console.error('Backup import failed, rolled back:', e);
    if (isStorageFullError(e)) return res.status(500).json({ error: 'Storage is full — the import did not go through. Free up space, then try again.', snapshot });
    return res.status(500).json({ error: 'The import failed and was rolled back — your current data is unchanged. The file may be internally inconsistent.', snapshot });
  }
  ledgerIndex.refresh(); // a v2 backup may have brought its own categories

  res.json({ ok: true, imported: result.imported, remappedUsers: result.remappedUsers, snapshot });
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

// An unknown /api route, or a known path with a method it does not have: a JSON 404, the same
// answer the phone gives (request-rules.js). Must come after every /api route. Other paths keep
// Express's own 404 page.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  res.status(404).json(requestRules.notFound(req.method, req.path));
});

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
  // The JSON body parsers' own errors get the answers shared with the phone (request-rules.js):
  // a body over its route's limit gets that route's "too large" message, and a body that is not a
  // JSON object or array gets a plain "Invalid request.".
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json(requestRules.tooLarge(requestRules.bodyKind(req.method, req.path)));
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json(requestRules.invalidRequest());
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
app._accessGate = accessGate; // Phase 1 safety: LAN/Host gate, unit-tested with fake requests
app._accessConfig = accessConfig;
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
repo.configure({ contractCols: CONTRACT_COLS }); // backup statements now live in backup-format.js

module.exports = app;

// EXTERNAL side effects — the LAN listener, cron scheduling, and the process signal handlers — run
// ONLY when started directly (`node server.js`), NEVER when the app is imported (node --test). This
// is what makes the suite structurally unable to schedule a real send. `npm start` is unchanged:
// there, require.main === module.
if (require.main === module) {
  // This PC only by default; LAN access only with PLANNR_HOST + PLANNR_TOKEN (see accessGate above).
  // Checked first, before anything else at startup touches the disk.
  const access = accessConfig();
  if (access.lan && access.token.length < MIN_TOKEN_LEN) {
    console.error(`[startup] PLANNR_HOST=${access.host} would open Plannr, which has no login, to your whole network. ` +
      `Set PLANNR_TOKEN to a random string of at least ${MIN_TOKEN_LEN} characters, or unset PLANNR_HOST to keep it on this PC.`);
    process.exit(1);
  }

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
  // Phase 11B — console-independent graceful stop: creating a `.plannr-stop` file in the project root
  // routes into the SAME shutdown() as the signals above (stop-plannr.cmd, which did this, was retired
  // in Phase 2 Step 6). Removes a stale sentinel on boot so a leftover can't stop this start.
  watchStopSentinel(STOP_SENTINEL, shutdown);

  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)?.address;

  app.listen(PORT, access.host, () => {
    console.log('DEV MODE – not used by the phone app');
    console.log(`Plannr desktop dev server running at http://localhost:${PORT} (the Android app keeps its own data and never talks to this server).`);
    if (access.lan && lanIp) console.log(`  on your network:  http://${lanIp}:${PORT}/?token=<your PLANNR_TOKEN>  (open once per device)`);
  });
}
