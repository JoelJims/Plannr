// Phase 5 — local API layer + fetch shim.
//
// Runs Plannr entirely in the browser: intercepts window.fetch, matches /api/* URLs against the
// route table below, and runs the SAME logic server.js's Express handlers run — lifted from
// server.js as directly as possible (validation, computeOverview, resolveLedger/resolveBy, the
// contract/service-offset guards, backup validate/snapshot/replace). The money arithmetic is
// unchanged from server.js; this file does not reimplement it, it copies it.
//
// installFetchShim(repo) must be called only after db.js's ready() has resolved and repo.js has
// been imported (repo.js prepares statements eagerly at import time) — see local-bootstrap.js,
// which is the only thing that should ever call this.
//
// Phase 6a — PDF export, on-device. server.js renders buildOverviewPdfHtml()'s output with
// Playwright, which doesn't run on Android. Instead: WebView.createPrintDocumentAdapter(), driven
// manually against the app's own ParcelFileDescriptor (bypassing the print dialog/spooler entirely)
// via @capgo/capacitor-pdf-generator, which implements exactly that. Rendering goes through the
// WebView's own Chromium, so buildOverviewPdfHtml()'s inline <style>/inline SVG need no changes —
// ported verbatim below, byte-for-byte the same function bodies as server.js.
//
// Not ported: GET /api/health (never called by any page) and everything in server.js that only
// exists to drive Playwright specifically (the PDF concurrency guard, warmPdfBrowser, getPdfBrowser)
// — the print-adapter plugin needs none of that; it's not a shared headless-browser resource, it's a
// one-shot WebView spun up and torn down per call.
//
// Phase 7 adds the encrypted full-snapshot backup path (export-encrypted/import-encrypted) alongside
// the plain-JSON ledger export/import above — a separate concern (raw database bytes, not the
// ledger-table JSON), handled by backup-crypto.js + local-snapshot.js and just wired in here.

import { db, isStorageFullError, rollbackQuietly } from './db.js';
import { encrypt, decrypt, looksLikeSqlite, MIN_PASSPHRASE_LEN } from './backup-crypto.js';
import * as backupFormat from './backup-format.js';
import * as requestRules from './request-rules.js';
import { str, parsePaise, parseIsoDate, parseAmountFilter, parseLedgerFilters, fmtRs } from './core/parsers.js';
import { createLedgerIndex } from './core/ledger-index.js';
import * as peopleRoutes from './core/routes/people.js';
import * as ledgerListRoutes from './core/routes/ledger-list.js';
import * as cashAndLoansRoutes from './core/routes/cash-and-loans.js';
import * as contractsRoutes from './core/routes/contracts.js';
import * as contractorPaymentsRoutes from './core/routes/contractor-payments.js';
import * as ledgerCrud from './core/ledger-crud.js';
import { exportSnapshotBytes, restoreSnapshotBytes } from './local-snapshot.js';
import { writeJsonSnapshot, writePreRestoreSnapshot } from './safety-snapshots.js';
// Phase 12: Capacitor/PdfGenerator are used ONLY inside the /api/overview/pdf handler below, but a
// static import here was loaded unconditionally by every page (local-bootstrap.js pulls this whole
// file in on every navigation) even though only the Overview page's PDF button ever needs them —
// same "only import.js on demand" pattern @capacitor/share and @capacitor/filesystem already use
// elsewhere in this codebase. Dynamically imported inside the handler instead.

// ── Phase 2 (Step 3): app storage on the phone ──────────────────────────────────────────────────
// The database lives in the WebView's localStorage (kvvfs: one entry per 8 KB database page), and
// localStorage has a fixed size limit per app. MEASURED in Playwright's Chromium
// (test-ui/storage-limit.js): 5,242,880 characters of keys + values, i.e. 10 MiB at the 2 bytes per
// character Chromium counts. The database hit that limit at about 2.7 MB (≈12,500 typical entries).
// The Android System WebView is Chromium too, so the phone is EXPECTED to have the same limit; that
// part is an estimate until it is checked on a device (docs/PHONE-TEST-CHECKLIST.md).
export const LOCALSTORAGE_LIMIT_CHARS = 5 * 1024 * 1024;
export const STORAGE_WARN_AT = 0.7;   // "getting full"
export const STORAGE_STRONG_AT = 0.9; // "export a backup now"
export function measureStorage(storage = window.localStorage) {
  let chars = 0, databaseChars = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    const n = key.length + (storage.getItem(key) || '').length;
    chars += n;
    if (key.startsWith('kvvfs-local')) databaseChars += n;
  }
  const fraction = chars / LOCALSTORAGE_LIMIT_CHARS;
  return {
    mode: 'phone',
    usedBytes: chars * 2,
    limitBytes: LOCALSTORAGE_LIMIT_CHARS * 2,
    databaseBytes: databaseChars * 2,
    fraction,
    level: fraction >= STORAGE_STRONG_AT ? 'critical' : fraction >= STORAGE_WARN_AT ? 'warning' : 'ok',
  };
}

// "Storage is full" on the phone means Plannr's own space inside the app is used up, not the phone's
// storage, so "free up space on your phone" would not help. Say what does.
const storageFull = (what) => `Storage is full — ${what} Your saved data is safe. On the Data Backup page, export a backup, then permanently delete items you no longer need from the Recycle Bin to make room.`;

export function installFetchShim(repo) {
  const originalFetch = window.fetch.bind(window);

  // ── tiny req/res mock so route handlers below can be copied from server.js almost verbatim ──────
  const routes = []; // { method, regex, paramNames, handler }
  function compilePath(pattern) {
    const paramNames = [];
    const parts = pattern.split('/').map((seg) => {
      if (seg.startsWith(':')) { paramNames.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return { regex: new RegExp('^' + parts.join('/') + '$'), paramNames };
  }
  // Mimics app.get/post/put/delete(path, ...middleware, handler) — only the LAST function matters;
  // requireApiAuth is a no-op here (there is no session to check in this single-user app),
  // and the body is read in window.fetch below by request-rules.js, the same rules as server.js.
  function on(method) {
    return (routePath, ...fns) => routes.push({ method, ...compilePath(routePath), handler: fns[fns.length - 1] });
  }
  const localApp = { get: on('GET'), post: on('POST'), put: on('PUT'), delete: on('DELETE') };

  class Res {
    constructor() { this.statusCode = 200; this._body = undefined; this._kind = 'json'; }
    status(n) { this.statusCode = n; return this; }
    json(obj) { this._body = obj; this._kind = 'json'; return this; }
    send(buf) { this._body = buf; this._kind = 'raw'; return this; }
    setHeader() { return this; } // headers are irrelevant to the fetch shim's Response-like object
  }

  // ---------------------------------------------------------------------------
  // Single-user offline app: no login, no sessions — mirrors server.js exactly.
  // ---------------------------------------------------------------------------
  const OWNER_STMT = db.prepare('SELECT id, username, display_name AS displayName FROM users ORDER BY id ASC LIMIT 1');
  const getOwner = () => OWNER_STMT.get();
  const USER_EXISTS_STMT = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const userExists = (id) => Number.isInteger(id) && !!USER_EXISTS_STMT.get(id);
  function requireApiAuth(req, res, next) { req.user = getOwner(); next(); }

  // Cross-platform plan, step 1.3: the route groups already moved to core/routes/ (the one copy the
  // dev server runs too). coreContext is what they need from the phone's side.
  // The ledger list (categories), kept in memory and refreshed after an import or a restore.
  const ledgerIndex = createLedgerIndex(repo);
  const coreContext = {
    db, repo, getOwner, userExists, isStorageFullError, rollbackQuietly, istDateStamp, storageFull, parseLedgerFilters,
    auth: requireApiAuth, // never called here: localApp runs only the last handler
    logError: (...args) => console.error(...args),
    ledgerIndex,
  };
  peopleRoutes.register(localApp, coreContext);
  ledgerListRoutes.register(localApp, coreContext);

  // The shared list/add/edit/delete/batch routes for the ledger tables: core/ledger-crud.js (step
  // 1.3). Each table below registers through makeLedgerCrud.
  const { makeLedgerCrud, LEDGER_CRUDS } = ledgerCrud.createLedgerCrud(localApp, coreContext);

  // Cash in, loans and cash out: core/routes/cash-and-loans.js (step 1.3). What it returns is used by
  // the routes still written below, which are ported from server.js until they move to core/ too.
  const { REASON_MAX, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CUSTOM_CODE, ledgerLabel, resolveLedger, CASH_OUT_SELECT, cashOutRow } = cashAndLoansRoutes.register(localApp, { ...coreContext, makeLedgerCrud });
  // The Contract Details API (contracts, services, allowances): core/routes/contracts.js (step 1.3).
  const { unitPricePaise, contractRow, CONTRACT_COLS } = contractsRoutes.register(localApp, { ...coreContext, ledgerLabel, resolveLedger });

  // The Contractor Payments API: core/routes/contractor-payments.js (step 1.3).
  const { CONTRACTOR_PAYMENTS_SELECT, paymentRow } = contractorPaymentsRoutes.register(localApp, { ...coreContext, makeLedgerCrud, ledgerLabel, resolveLedger, REASON_MAX });

  // ---------------------------------------------------------------------------
  // Recycle Bin — ported from server.js verbatim.
  // ---------------------------------------------------------------------------
  const TRASH_TABLES = ['cash_in', 'cash_out', 'loans', 'contract', 'contractor_payments'];
  const TRASH_SHAPERS = { cash_in: cashInRow, cash_out: cashOutRow, loans: loanRow, contract: contractRow, contractor_payments: paymentRow };
  const TRASH_REPO = {
    cash_in: repo.trash({ table: 'cash_in', select: CASH_IN_SELECT, alias: 'c' }),
    cash_out: repo.trash({ table: 'cash_out', select: CASH_OUT_SELECT, alias: 'c' }),
    loans: repo.trash({ table: 'loans', select: LOANS_SELECT, alias: '' }),
    contract: repo.trash({ table: 'contract', select: 'SELECT * FROM contract', alias: '' }),
    contractor_payments: repo.trash({ table: 'contractor_payments', select: CONTRACTOR_PAYMENTS_SELECT, alias: 'cp' }),
  };

  localApp.get('/api/trash', (req, res) => {
    const trash = {};
    for (const t of TRASH_TABLES) {
      trash[t] = TRASH_REPO[t].listDeleted().map((r) => ({ ...TRASH_SHAPERS[t](r), deletedAt: r.deleted_at }));
    }
    res.json({ trash });
  });

  function trashTable(req) { return TRASH_TABLES.includes(req.params.table) ? req.params.table : null; }

  localApp.post('/api/trash/:table/:id/restore', (req, res) => {
    const table = trashTable(req);
    if (!table) return res.status(400).json({ error: 'Unknown table.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
    if (table === 'contractor_payments') {
      const row = repo.contract.paymentContractId(id);
      const parent = repo.contract.deletedAt(row.contract_id);
      if (!parent || parent.deleted_at !== null) {
        return res.status(409).json({ error: 'Restore the parent contract first — this payment belongs to a contract that is still in the Recycle Bin.' });
      }
    }
    if (table === 'contract' && repo.contract.liveCount() > 0) {
      return res.status(409).json({ error: 'Another contract is already live — Plannr tracks a single contract. Delete the current one before restoring this from the Recycle Bin.' });
    }
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

  localApp.delete('/api/trash/:table/:id', (req, res) => {
    const table = trashTable(req);
    if (!table) return res.status(400).json({ error: 'Unknown table.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !TRASH_REPO[table].find(id)) return res.status(404).json({ error: 'That deleted item was not found.' });
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
      // Contract Phase A: contract_allowances CASCADEs the same way and cash_out.contract_allowance_id
      // has no ON DELETE action either.
      const k = repo.contract.cashOutReferencingAllowances(id);
      if (k > 0) {
        return res.status(409).json({ error: `This contract still has ${k} cash-out entr${k === 1 ? 'y' : 'ies'} drawing against one of its allowances (live or in the Recycle Bin). Permanently deleting it would orphan ${k === 1 ? 'that entry' : 'those entries'} — unlink or restore ${k === 1 ? 'it' : 'them'} first.` });
      }
    }
    TRASH_REPO[table].hardDelete(id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Budget + computeOverview() — ported verbatim. This is the money-arithmetic core; nothing here
  // was changed from server.js.
  // ---------------------------------------------------------------------------
  const BUDGET_STMT = db.prepare("SELECT value FROM settings WHERE key = 'budget_paise'");
  function getBudgetPaise() {
    const r = BUDGET_STMT.get();
    if (!r || r.value == null || r.value === '') return null;
    const n = Number(r.value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  localApp.get('/api/budget', (req, res) => { res.json({ budgetPaise: getBudgetPaise() }); });

  localApp.put('/api/budget', (req, res) => {
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

  // Phase 6b — up to 5 daily local-notification times ("HH:MM", 24h), ported verbatim from
  // server.js's identical route. Reuses the old daily_report_times settings key (inert since the
  // Phase 1.3 email-report scheduler was deleted). Scheduling itself is client-side
  // (notifications.js) — this is just persistence, same as budget above.
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

  localApp.get('/api/notification-times', (req, res) => { res.json({ times: getNotificationTimes() }); });

  localApp.put('/api/notification-times', (req, res) => {
    const times = normalizeNotificationTimes(req.body.times);
    if (times === null) return res.status(400).json({ error: 'Send up to 5 unique times as "HH:MM" (24h).' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('daily_report_times', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(times));
    res.json({ times });
  });

  const CUSTOM_GROUP_NAME = 'Custom / Uncategorized';

  function computeOverview(range) {
    const start = (range && range.start) || null;
    const end = (range && range.end) || null;
    const bounded = !!(start || end);
    const lo = start || '0000-01-01', hi = end || '9999-12-31';

    // The Phase 5E reimbursement offset is REMOVED, all-or-nothing: no 'included' debit reduces
    // owed, whatever contract_stated_paise a legacy row still holds. The cumulative 'included' scan
    // that fed it (and its missing-offset check) is gone with it.

    const contractRows = repo.overview.contracts();
    const liveContractIds = new Set(contractRows.map((c) => c.id));

    const paidByContract = new Map();
    let cumulativePaid = 0;
    const orphan = { count: 0, amountPaise: 0, contractIds: [] };
    for (const g of repo.overview.paidByContract()) {
      paidByContract.set(g.contract_id, g.s);
      cumulativePaid += g.s;
      if (!liveContractIds.has(g.contract_id)) { orphan.count += g.c; orphan.amountPaise += g.s; orphan.contractIds.push(g.contract_id); }
    }

    // owed(C) = stated - Sum(paid). An UNSTATED contract reads as stated = 0: nothing in A, nothing
    // in owed - but its payments still count in B/D/pie.
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

    const zero = () => ({ totalPaise: 0, userPaise: 0, otherPaise: 0 });
    const add = (o, byType, amt) => { o.totalPaise += amt; if (byType === 'user') o.userPaise += amt; else o.otherPaise += amt; };

    let spentBySelf = 0, paidToContractors = 0, userSpent = 0, otherSpent = 0;
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
        add(L.noSub, byType, amt);
      }
    };

    const outs = bounded ? repo.overview.outsRange(lo, hi) : repo.overview.outsAll();
    const payments = bounded ? repo.overview.paymentsRange(lo, hi) : repo.overview.paymentsAll();
    for (const r of outs) {
      spentBySelf += r.amount_paise;
      rollup(r.by_type, r.ledger_code, r.subledger_code, r.subledger_custom_name, r.amount_paise);
    }
    for (const p of payments) {
      paidToContractors += p.amount_paise;
      rollup('other', p.ledger_code || CUSTOM_CODE, p.subledger_code, p.subledger_custom_name, p.amount_paise);
    }

    const loanReceived = repo.overview.loansSum().s;
    const totalSpent = paidToContractors + spentBySelf;

    const ledgers = [...ledMap.values()]
      .sort((a, b) => (a.isCustom ? 1 : b.isCustom ? -1 : parseFloat(a.code) - parseFloat(b.code)))
      .map((L) => ({
        code: L.code, name: L.name, isCustom: L.isCustom,
        totalPaise: L.totalPaise, userPaise: L.userPaise, otherPaise: L.otherPaise,
        noSub: L.noSub, subs: [...L.subs.values()],
      }));

    const splitSumsToTotal = userSpent + otherSpent === totalSpent;
    const mainsSumToTotal = ledgers.reduce((a, L) => a + L.totalPaise, 0) === totalSpent;
    const subsSumToMains = ledgers.every((L) => L.subs.reduce((a, s) => a + s.totalPaise, 0) + L.noSub.totalPaise === L.totalPaise);

    // The over-offset check is RETAINED. With the offset gone it now reads as "contractor payments
    // exceed the contract value". The missing-offset check is REMOVED: a NULL/0 stated amount on an
    // 'included' debit is the normal case now, so it would fire on every hand.
    const appliedAgainstContract = cumulativePaid;
    const overOffset = { over: totalContract > 0 && appliedAgainstContract > totalContract, contractPaise: totalContract, appliedPaise: appliedAgainstContract, excessPaise: Math.max(0, appliedAgainstContract - totalContract) };

    // Contract Phase A - contractPriceDerivation. A rate-priced contract MATERIALISES rate x area
    // into price_of_contract_paise so owed/A/the PDF keep reading one column; a materialised derived
    // value can drift (a restored backup writes columns verbatim rather than re-running the write
    // path). Recompute and FLAG - the figure is reported as stored, never corrected.
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
      money: {
        totalContractPaise: totalContract,
        paidToContractorsPaise: paidToContractors,
        spentBySelfPaise: spentBySelf,
        totalSpentPaise: totalSpent,
        loanReceivedPaise: loanReceived,
        owedToContractorsPaise: owedToContractors,
      },
      contracts,
      upcomingPayments: computeUpcomingPayments(),
      reconciliation: {
        ok: splitSumsToTotal && mainsSumToTotal && subsSumToMains && orphan.count === 0 && !overOffset.over && !contractPriceDerivation.drifted,
        orphanedContractorPayments: orphan,
        overOffset: overOffset,
        contractPriceDerivation,
      },
    };
  }

  const IST_TZ = 'Asia/Kolkata';
  function istDateStamp(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(d); }
  function daysBetweenIso(fromIso, toIso) {
    const [ya, ma, da] = fromIso.split('-').map(Number);
    const [yb, mb, db2] = toIso.split('-').map(Number);
    return Math.round((Date.UTC(yb, mb - 1, db2) - Date.UTC(ya, ma - 1, da)) / 86400000);
  }
  function computeUpcomingPayments() {
    const today = istDateStamp();
    const out = [];
    for (const c of repo.contract.list()) {
      for (const d of repo.contract.payDatesFor(c.id)) {
        const daysRemaining = daysBetweenIso(today, d);
        const paidOnDate = repo.contract.paymentOnDate(c.id, d);
        out.push({ date: d, daysRemaining, paidOnDate, possiblyOverdue: daysRemaining < 0 && !paidOnDate });
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  localApp.get('/api/overview', (req, res) => {
    const s = parseIsoDate(req.query.start);
    if (s.error) return res.status(400).json({ error: 'Invalid start date (YYYY-MM-DD).' });
    const e = parseIsoDate(req.query.end);
    if (e.error) return res.status(400).json({ error: 'Invalid end date (YYYY-MM-DD).' });
    if (s.date && e.date && s.date > e.date) return res.status(400).json({ error: 'Start date must be on or before the end date.' });
    res.json(computeOverview({ start: s.date, end: e.date }));
  });

  // ---------------------------------------------------------------------------
  // Overview PDF (Phase 6a) — ported verbatim from server.js: same fmtRs/pdfEsc/PDF_PALETTE/
  // pdfSlices/pdfPieSvg/fmtDatePdf/buildOverviewPdfHtml, same HTML, same layout. Only the render
  // BACKEND differs (the print-adapter plugin's WebView instead of Playwright's). fmtRs() is already
  // declared above (Phase 12: this was a byte-identical redundant re-declaration in the same scope).
  // ---------------------------------------------------------------------------
  const pdfEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Phase C re-derived this alongside server.js's copy — see the long note there. Before: min ΔE00
  // 2.99, and #8a5a2b was BOTH the 18th ledger's colour and the Custom slice's, so those two slices
  // were byte-identical whenever both had spend. After: no exact duplicate, nothing under ΔE00 5,
  // min 6.00. Still 39 pairs under 10 — a structural ceiling of holding 24 categories inside one
  // hue family, not something more searching fixes.
  const PDF_PALETTE = [
    '#f59e0b', '#ffc31b', '#9a5115', '#d97706', '#e3c153', '#973913', '#ef8a4b', '#d2b001',
    '#a56b1a', '#dda077', '#c2703d', '#e8d12f', '#7d452a', '#f6ba83', '#876322', '#d29e0f',
    '#ffcf70', '#845f44', '#eca955', '#6f4518', '#c2410c', '#b45f06', '#7c2d12', '#cea871'];
  // Custom's slice colour, pulled out of the literal it used to be written as so it can take part in
  // the distinctness check.
  const PDF_CUSTOM_COLOR = '#8a5a2b';
  // Ledgers past the fixed 24 — farthest-point derived, replacing the golden-angle generator that
  // was blind to the palette it was extending (first generated colour landed ΔE00 3.99 from a fixed
  // one). Not hue-constrained, as the old generator was not.
  const PDF_PALETTE_EXT = [
    '#f720f8', '#1dc2fc', '#144ea8', '#058f67', '#d5cdf2', '#27f164', '#8e2b69', '#7f7a92',
    '#ff758f', '#b6d9cd', '#49554c', '#638af8', '#277f92', '#739114', '#851cf6', '#868779',
    '#0d6007', '#d41346', '#11b4b3', '#5d4e56', '#ca8ec6', '#f9c5c5', '#9dbf7c', '#a0adb9'];
  // Beyond 48 mains — unverified last resort.
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

  function fmtDatePdf(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso));
    return m ? (m[3] + '/' + m[2] + '/' + m[1].slice(2)) : String(iso == null ? '' : iso);
  }
  function buildOverviewPdfHtml(part, o, rows, range, theme) {
    const m = o.money;
    const fmtOwed = (v) => (v < 0 ? 'Overpaid by ' + fmtRs(-v) : fmtRs(v));
    const rangeLabel = (range.start || range.end) ? `${fmtDatePdf(range.start) || '…'} to ${fmtDatePdf(range.end) || '…'}` : 'All transactions';
    const slices = pdfSlices(o);
    const incl = (s) => (s === 'included' ? 'Yes' : 'No');

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
      // no longer written or used. Contract Included (Yes/No) stays: that label is still recorded.
      return '<h2>Transactions</h2><table><thead><tr><th class="num">#</th><th>Date</th><th class="num">Amount</th><th>By</th><th>Ledger</th><th>Remark</th><th>Contract Included</th></tr></thead><tbody>' +
        rows.map((e, i) => `<tr><td class="num">${i + 1}</td><td>${e.txDate ? pdfEsc(fmtDatePdf(e.txDate)) : '—'}</td><td class="num">${fmtRs(e.amountPaise)}</td><td>${pdfEsc(e.by)}</td><td>${pdfEsc(e.ledger)}</td><td>${e.reason ? pdfEsc(e.reason) : '—'}</td><td>${incl(e.contractScope)}</td></tr>`).join('') +
        `</tbody><tfoot><tr><td colspan="2">Total (${rows.length})</td><td class="num">${fmtRs(total)}</td><td colspan="4"></td></tr></tfoot></table>`;
    };

    const TITLE = { full: 'Overview', summary: 'Overview — summary', pie: 'Spending by Ledger — chart', table: 'Transactions', ledger: 'Spending by Ledger' };
    let body;
    if (part === 'pie') body = pieBlock();
    else if (part === 'table') body = txTableBlock();
    else if (part === 'ledger') body = ledgerTableBlock();
    else if (part === 'summary') body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + ledgerTableBlock();
    else body = figuresBlock() + owedBlock() + budgetBlock() + pieBlock() + txTableBlock();

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

  function base64ToBytes(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Phase 6a follow-up — the print-adapter plugin's native call has no cancel API and, if the hidden
  // WebView it spins up never fires onPageFinished/onLayout, its PluginCall promise simply never
  // settles: no throw, no reject, nothing for a try/catch to catch. Without this, that hang is
  // indistinguishable from "nothing happened" — exactly the silent failure reported on-device. This
  // turns an infinite silent wait into a real, visible error after a bounded time.
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — the native print adapter did not respond.`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  localApp.get('/api/overview/pdf', async (req, res) => {
    const s = parseIsoDate(req.query.start); if (s.error) return res.status(400).json({ error: 'Invalid start date (YYYY-MM-DD).' });
    const e = parseIsoDate(req.query.end); if (e.error) return res.status(400).json({ error: 'Invalid end date (YYYY-MM-DD).' });
    if (s.date && e.date && s.date > e.date) return res.status(400).json({ error: 'Start date must be on or before the end date.' });
    const part = ['full', 'pie', 'table', 'ledger'].includes(String(req.query.part)) ? String(req.query.part) : 'full';
    const theme = String(req.query.theme) === 'dark' ? 'dark' : 'light';

    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) {
      return res.status(503).json({ error: 'PDF export needs the Android app — this browser preview cannot generate one.' });
    }
    if (!Capacitor.isPluginAvailable('PdfGenerator')) {
      // Distinguishes "isNativePlatform() is true but the plugin never registered" from every other
      // failure mode below — a real possibility the on-screen message must be able to name outright.
      return res.status(500).json({ error: `PDF export: the PdfGenerator plugin is not available on this platform (${Capacitor.getPlatform()}). It may not have registered correctly.` });
    }
    const { PdfGenerator } = await import('@capgo/capacitor-pdf-generator');

    const range = { start: s.date, end: e.date };
    const inR = (d) => { if (!range.start && !range.end) return true; if (d == null) return false; if (range.start && d < range.start) return false; if (range.end && d > range.end) return false; return true; };
    const o = computeOverview(range);
    const rows = LEDGER_CRUDS.cash_out.list().map(cashOutRow).filter((r) => inR(r.txDate));
    const html = buildOverviewPdfHtml(part, o, rows, range, theme);

    try {
      const result = await withTimeout(
        PdfGenerator.fromData({ data: html, type: 'base64', documentSize: 'A4', fileName: `plannr-overview-${part}.pdf` }),
        25000,
        'PDF generation'
      );
      if (!result || result.type !== 'base64' || !result.base64) {
        return res.status(500).json({ error: 'PDF generation returned an unexpected result: ' + JSON.stringify(result) });
      }
      res.send(base64ToBytes(result.base64));
    } catch (err) {
      console.error('PDF generation failed:', err);
      res.status(500).json({ error: 'Could not generate the PDF: ' + (err && err.message ? err.message : String(err)) });
    }
  });

  // ---------------------------------------------------------------------------
  // Data backup. The format (tables, columns, validation, the restore transaction) lives in
  // backup-format.js, shared with server.js, so the phone and the desktop cannot drift. The one
  // phone-specific part is the pre-import safety snapshot (safety-snapshots.js): there is no
  // file beside the DB here, so it goes into the app's data folder through Capacitor Filesystem.
  // ---------------------------------------------------------------------------
  backupFormat.assertImportOwnershipComplete(db);
  const buildBackup = (opts) => backupFormat.buildBackup(db, opts);
  // Read ledgerIndex.byCode() at call time: ledgerIndex.refresh() replaces it after a category import or restore.
  const validateBackup = (data) => backupFormat.validateBackup(data, { liveLedgerByCode: ledgerIndex.byCode(), customCode: CUSTOM_CODE, parseIsoDate });

  // Storage meter on the Data Backup page (Phase 2, Step 3). See measureStorage() above.
  localApp.get('/api/storage', (req, res) => { res.json(measureStorage()); });

  localApp.get('/api/backup/export', (req, res) => {
    const includeContacts = req.query.includeContacts === '1';
    const backup = buildBackup({ includeContacts });
    res.json(backup);
  });

  // Pre-import safety snapshot: safety-snapshots.js writes it into the app's private data folder
  // (Capacitor Filesystem, checked with stat) before the import may touch anything. server.js writes
  // its own to a file beside the DB. In a plain browser it falls back to a download.
  localApp.post('/api/backup/import', async (req, res) => {
    const v = validateBackup(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    let snapshot;
    try {
      snapshot = await writeJsonSnapshot(buildBackup({ includeContacts: true }));
    } catch (e) {
      console.error('Backup snapshot failed:', e);
      return res.status(500).json({ error: 'Could not write the safety snapshot, so the import was aborted — your current data is unchanged.' });
    }

    // Replace in one transaction (backup-format.js). Any error rolls back: current data unchanged.
    let result;
    try {
      result = backupFormat.applyBackup(db, req.body);
    } catch (e) {
      console.error('Backup import failed, rolled back:', e);
      if (isStorageFullError(e)) return res.status(500).json({ error: storageFull('the import did not go through.'), snapshot });
      return res.status(500).json({ error: 'The import failed and was rolled back — your current data is unchanged. The file may be internally inconsistent.', snapshot });
    }
    ledgerIndex.refresh(); // a v2 backup may have brought its own categories

    res.json({ ok: true, imported: result.imported, remappedUsers: result.remappedUsers, snapshot });
  });

  // ---------------------------------------------------------------------------
  // Phase 7 — encrypted full-snapshot backup. A different thing from the plain-JSON export/import
  // above: this is the WHOLE database (every table, users/sessions included), byte-for-byte, the
  // local-mode equivalent of backup-db.js's VACUUM INTO + backup-crypto.js encryption. The body carries
  // the encrypted bytes as base64 (this is an in-process call through the fetch shim, not a real HTTP
  // request, so there's no size pressure that would justify anything fancier than JSON + base64).
  // ---------------------------------------------------------------------------
  localApp.post('/api/backup/export-encrypted', async (req, res) => {
    const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    if (!passphrase) return res.status(400).json({ error: 'Enter a passphrase to encrypt this backup.' });
    if ([...passphrase].length < MIN_PASSPHRASE_LEN) return res.status(400).json({ error: `Use a passphrase of at least ${MIN_PASSPHRASE_LEN} characters. A short one can be guessed by anyone who gets the file.` });
    try {
      const plain = exportSnapshotBytes();
      const enc = await encrypt(plain, passphrase);
      res.send(enc);
    } catch (e) {
      console.error('Encrypted export failed:', e);
      res.status(500).json({ error: 'Could not build the encrypted backup: ' + e.message });
    }
  });

  localApp.post('/api/backup/import-encrypted', async (req, res) => {
    const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    const dataBase64 = typeof req.body.dataBase64 === 'string' ? req.body.dataBase64 : '';
    if (!passphrase) return res.status(400).json({ error: 'Enter the passphrase this backup was encrypted with.' });
    if (!dataBase64) return res.status(400).json({ error: 'Choose an encrypted backup file first.' });

    let encBytes;
    try {
      const binary = atob(dataBase64);
      encBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) encBytes[i] = binary.charCodeAt(i);
    } catch {
      return res.status(400).json({ error: 'That file could not be read — choose a Plannr encrypted backup (.db.enc).' });
    }

    let plain;
    try {
      plain = await decrypt(encBytes, passphrase);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!looksLikeSqlite(plain)) {
      return res.status(400).json({ error: 'Decryption succeeded but the result does not look like a SQLite database — the file may be corrupt.' });
    }

    // Phase 2 (Step 4): a whole-database copy of the CURRENT data before the restore replaces it
    // (safety-snapshots.js; inside the app's private folder, checked with stat). No copy, no restore.
    let snapshot = null;
    try {
      snapshot = await writePreRestoreSnapshot();
    } catch (e) {
      console.error('Pre-restore snapshot failed:', e);
      return res.status(500).json({ error: 'Could not write the safety snapshot, so the restore was not started — your current data is unchanged.' });
    }

    try {
      await restoreSnapshotBytes(plain);
    } catch (e) {
      console.error('Encrypted import failed:', e);
      if (e && e.code === 'BACKUP_TOO_NEW') return res.status(400).json({ error: e.message });
      if (isStorageFullError(e)) return res.status(500).json({ error: storageFull('the restore did not go through.') });
      return res.status(500).json({ error: 'Restore failed partway through: ' + e.message + ' Reload the page to see the current state before continuing.', snapshot });
    }
    res.json({ ok: true, snapshot });
  });

  // ---------------------------------------------------------------------------
  // Phase 15 — backup-overdue reminder, ported verbatim from server.js's identical routes.
  // last_encrypted_export_at is stamped only by a VERIFIED encrypted full backup (see saveFile() in
  // data-backup.html, gated on the .db.enc filename) — a JSON export or a Ledger List CSV is not a
  // complete restore point, so neither touches this. backup_reminder_days is the user's overdue
  // threshold: unset = the default (7), the literal string 'off' = disabled, otherwise a whole
  // number of days.
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

  localApp.get('/api/backup/reminder', (req, res) => { res.json(getBackupReminderStatus()); });

  localApp.put('/api/backup/reminder', (req, res) => {
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
  localApp.post('/api/backup/mark-exported', (req, res) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_encrypted_export_at', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    res.json(getBackupReminderStatus());
  });

  repo.configure({ contractCols: CONTRACT_COLS }); // backup statements now live in backup-format.js

  // ---------------------------------------------------------------------------
  // The fetch shim itself. Only /api/* is intercepted; everything else (styles.css, plannr-ui.js,
  // the page HTML itself) goes through <script src>/<link href>, never window.fetch, so there is
  // nothing else to pass through in practice — but a non-/api/ fetch is forwarded to the real fetch
  // defensively rather than swallowed.
  // ---------------------------------------------------------------------------
  function toResponse(res) {
    const status = res.statusCode;
    const ok = status >= 200 && status < 300;
    const isBlob = res._kind === 'raw';
    return {
      ok, status,
      async json() { return isBlob ? JSON.parse(res._body) : res._body; },
      async blob() { return isBlob ? new Blob([res._body]) : new Blob([JSON.stringify(res._body)], { type: 'application/json' }); },
      async text() { return isBlob ? String(res._body) : JSON.stringify(res._body); },
    };
  }

  window.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    if (!rawUrl.startsWith('/api/')) return originalFetch(input, init);
    const method = ((init && init.method) || 'GET').toUpperCase();
    const u = new URL(rawUrl, window.location.origin);
    const pathname = u.pathname;
    const query = Object.fromEntries(u.searchParams);
    // Same body rules as server.js (request-rules.js): a size limit per kind of route, and a body
    // that is not a JSON object or array is refused instead of being read as {}.
    const parsed = requestRules.parseJsonBody(init && init.body != null ? String(init.body) : '', requestRules.bodyKind(method, pathname));
    if (parsed.error) return toResponse(new Res().status(parsed.status).json(parsed.error));
    const body = parsed.body;

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
      const req = { params, query, body };
      const res = new Res();
      try {
        await r.handler(req, res); // handlers may be sync or async (Phase 7's encrypted backup routes are async)
      } catch (e) {
        console.error('local-api handler error:', e);
        // Phase 2 (Step 3): a single add / edit / delete has no try/catch of its own, so a write that
        // hits the storage limit lands here. Say so, instead of the generic message.
        res.status(500).json({ error: isStorageFullError(e) ? storageFull('this change was not saved.') : 'Something went wrong.' });
      }
      return toResponse(res);
    }
    return toResponse(new Res().status(404).json(requestRules.notFound(method, pathname)));
  };
}
