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
// Phase 6a — PDF export, on-device. server.js renders the PDF's HTML (core/overview-pdf.js) with
// Playwright, which doesn't run on Android. Instead: WebView.createPrintDocumentAdapter(), driven
// manually against the app's own ParcelFileDescriptor (bypassing the print dialog/spooler entirely)
// via @capgo/capacitor-pdf-generator, which implements exactly that. Rendering goes through the
// WebView's own Chromium, so the HTML's inline <style>/inline SVG need no changes.
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
import { checkHost, hostError } from './core/host.js';
import * as peopleRoutes from './core/routes/people.js';
import * as ledgerListRoutes from './core/routes/ledger-list.js';
import * as cashAndLoansRoutes from './core/routes/cash-and-loans.js';
import * as contractsRoutes from './core/routes/contracts.js';
import * as contractorPaymentsRoutes from './core/routes/contractor-payments.js';
import * as trashRoutes from './core/routes/trash.js';
import * as budgetRoutes from './core/routes/budget.js';
import * as notificationTimesRoutes from './core/routes/notification-times.js';
import * as overviewRoutes from './core/routes/overview.js';
import * as overviewPdf from './core/overview-pdf.js';
import * as pdfRoutes from './core/routes/pdf.js';
import * as backupReminderRoutes from './core/routes/backup-reminder.js';
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
  // The platform services the core may call (core/host.js, step 1.4 A4): the phone's. The PDF goes
  // through the print-adapter plugin (renderPdfOnPhone, below); the safety copy before a JSON
  // restore goes into the app's private folder (safety-snapshots.js).
  const host = checkHost({
    pdf: { render: (html, opts) => renderPdfOnPhone(html, opts) },
    snapshot: { writeJson: (backup) => writeJsonSnapshot(backup) },
    now: () => new Date(),
  });
  const coreContext = {
    db, repo, getOwner, userExists, isStorageFullError, rollbackQuietly, istDateStamp, storageFull, parseLedgerFilters,
    host,
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

  // The Recycle Bin: core/routes/trash.js (step 1.3).
  trashRoutes.register(localApp, { ...coreContext, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CASH_OUT_SELECT, cashOutRow, contractRow, CONTRACTOR_PAYMENTS_SELECT, paymentRow });

  // ---------------------------------------------------------------------------
  // computeOverview() — ported verbatim. This is the money-arithmetic core; nothing here
  // was changed from server.js.
  // ---------------------------------------------------------------------------
  // The overall budget: core/routes/budget.js (step 1.3).
  const { getBudgetPaise } = budgetRoutes.register(localApp, coreContext);

  // The reminder times: core/routes/notification-times.js (step 1.3).
  notificationTimesRoutes.register(localApp, coreContext);

  // IST dates: coreContext passes istDateStamp to the core routes (a hoisted function, so it is
  // ready before this line runs).
  const IST_TZ = 'Asia/Kolkata';
  function istDateStamp(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(d); }

  // The Overview: core/routes/overview.js (step 1.3).
  const { computeOverview } = overviewRoutes.register(localApp, { ...coreContext, ledgerLabel, CUSTOM_CODE, unitPricePaise, getBudgetPaise });

  // ---------------------------------------------------------------------------
  // Overview PDF (Phase 6a). What goes into it (query checks, data, HTML) is core/overview-pdf.js
  // (step 1.3), the same as the dev server's. Only the render BACKEND differs: the print-adapter
  // plugin's WebView here, Playwright there.
  // ---------------------------------------------------------------------------
  const { readPdfQuery, overviewPdfHtml } = overviewPdf.createOverviewPdf({ computeOverview, LEDGER_CRUDS, cashOutRow, CUSTOM_CODE, ledgerIndex });

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

  // The phone's pdf.render (core/host.js, step 1.4 A4): the Overview PDF page -> PDF bytes, through
  // the print-adapter plugin. A refusal the user should see is a hostError with its status.
  async function renderPdfOnPhone(html, { part }) {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) {
      throw hostError(503, 'PDF export needs the Android app — this browser preview cannot generate one.');
    }
    if (!Capacitor.isPluginAvailable('PdfGenerator')) {
      // Distinguishes "isNativePlatform() is true but the plugin never registered" from every other
      // failure mode below — a real possibility the on-screen message must be able to name outright.
      throw hostError(500, `PDF export: the PdfGenerator plugin is not available on this platform (${Capacitor.getPlatform()}). It may not have registered correctly.`);
    }
    const { PdfGenerator } = await import('@capgo/capacitor-pdf-generator');
    const result = await withTimeout(
      PdfGenerator.fromData({ data: html, type: 'base64', documentSize: 'A4', fileName: `plannr-overview-${part}.pdf` }),
      25000,
      'PDF generation'
    );
    if (!result || result.type !== 'base64' || !result.base64) {
      throw hostError(500, 'PDF generation returned an unexpected result: ' + JSON.stringify(result));
    }
    return base64ToBytes(result.base64);
  }

  // The route itself: core/routes/pdf.js (step 1.4 A5). It renders through host.pdf.render, which is
  // renderPdfOnPhone above.
  pdfRoutes.register(localApp, { ...coreContext, readPdfQuery, overviewPdfHtml });

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
      snapshot = await host.snapshot.writeJson(buildBackup({ includeContacts: true }));
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

  // Phase 15 backup-overdue reminder (GET/PUT /api/backup/reminder, POST /api/backup/mark-exported):
  // core/routes/backup-reminder.js (step 1.4 A6). Its clock is host.now().
  backupReminderRoutes.register(localApp, coreContext);

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
