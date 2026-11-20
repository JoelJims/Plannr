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

import { db, isStorageFullError, rollbackQuietly, transaction, dbAdapter, usingOwnHandle } from './db.js';
import { encrypt, decrypt } from './backup-crypto.js';
import * as requestRules from './request-rules.js';
import { str, parsePaise, parseAmountFilter, parseLedgerFilters, fmtRs, base64ToBytes } from './core/parsers.js';
import { createLedgerIndex } from './core/ledger-index.js';
import { checkHost, hostError } from './core/host.js';
import { createRequestQueue, queuedRoutes } from './core/request-queue.js';
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
import * as backupRoutes from './core/routes/backup.js';
import * as storageRoutes from './core/routes/storage.js';
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
// What localStorage holds now (the levels are core/routes/storage.js's: warn from 70%, strongly from 90%).
export function measureStorage(storage = window.localStorage) {
  let chars = 0, databaseChars = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    const n = key.length + (storage.getItem(key) || '').length;
    chars += n;
    if (key.startsWith('kvvfs-local')) databaseChars += n;
  }
  return { usedBytes: chars * 2, limitBytes: LOCALSTORAGE_LIMIT_CHARS * 2, databaseBytes: databaseChars * 2 };
}

// The phone's host.storage.info (step 1.4 C11). Before the move, localStorage and its limit. After it,
// the database file (with its journal) and the phone's free space, plus the old localStorage copy
// while it is kept (it counts toward Android's Google backup until it is deleted).
export async function phoneStorageInfo() {
  if (usingOwnHandle()) return { kind: 'localstorage', ...measureStorage() };
  const file = await dbAdapter().info();
  return { kind: 'file', databaseBytes: file.sizeBytes, freeBytes: file.freeBytes, oldCopyBytes: measureStorage().databaseBytes };
}

// "Storage is full" on the phone. Before the move it means Plannr's own space inside the app is used
// up, not the phone's storage, so "free up space on your phone" would not help: say what does. After
// the move (the data in its own file) it means the phone itself is full.
const storageFull = (what) => (usingOwnHandle()
  ? `Storage is full — ${what} Your saved data is safe. On the Data Backup page, export a backup, then permanently delete items you no longer need from the Recycle Bin to make room.`
  : `Storage is full — ${what} Your saved data is safe. This phone is out of space: free up space on the phone (photos, videos, apps you no longer use), then try again.`);

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
    return (routePath, ...fns) => routes.push({ method, path: routePath, ...compilePath(routePath), handler: fns[fns.length - 1] });
  }
  // One request at a time (core/request-queue.js, step 1.4 B5), as on the dev server: every route is
  // registered through queuedRoutes(), so its handler runs inside this queue. An encrypted restore
  // awaits init() part-way through; nothing else can run in between.
  const requestQueue = createRequestQueue();
  const localApp = queuedRoutes({ get: on('GET'), post: on('POST'), put: on('PUT'), delete: on('DELETE') }, requestQueue);

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
  // Through the async interface (step 1.4 B15): both answer with a Promise.
  const getOwner = () => dbAdapter().get('SELECT id, username, display_name AS displayName FROM users ORDER BY id ASC LIMIT 1');
  const userExists = async (id) => Number.isInteger(id) && !!(await dbAdapter().get('SELECT 1 FROM users WHERE id = ?', [id]));
  async function requireApiAuth(req, res, next) { try { req.user = await getOwner(); } catch (e) { return next(e); } next(); }

  // Cross-platform plan, step 1.3: the route groups already moved to core/routes/ (the one copy the
  // dev server runs too). coreContext is what they need from the phone's side.
  // The ledger list (categories), kept in memory and refreshed after an import or a restore.
  const ledgerIndex = createLedgerIndex(repo);
  // Start-up work that reads the database (step 1.4 B10, B13): each is a job in the request queue,
  // ahead of any request. The first: the ledger list, so no request can read it empty.
  // local-bootstrap.js awaits them all (`ready`, returned below) and shows a start-up error if one fails.
  const startJobs = [];
  const atStart = (fn) => { const job = requestQueue.run(fn); job.catch(() => {}); startJobs.push(job); };
  atStart(() => ledgerIndex.refresh());
  // The platform services the core may call (core/host.js, step 1.4 A4): the phone's. The PDF goes
  // through the print-adapter plugin (renderPdfOnPhone, below); the safety copy before a JSON
  // restore goes into the app's private folder (safety-snapshots.js).
  // Step 1.4 C11: the encrypted backup (export, safety copy, restore: local-snapshot.js and
  // safety-snapshots.js, on localStorage or on the file) and what /api/storage reports.
  const host = checkHost({
    pdf: { render: (html, opts) => renderPdfOnPhone(html, opts) },
    snapshot: { writeJson: (backup) => writeJsonSnapshot(backup), writeDatabase: () => writePreRestoreSnapshot() },
    now: () => new Date(),
    crypto: { encrypt: (bytes, passphrase) => encrypt(bytes, passphrase), decrypt: (bytes, passphrase) => decrypt(bytes, passphrase) },
    database: { exportBytes: async () => exportSnapshotBytes(), restore: (bytes) => restoreSnapshotBytes(bytes) },
    storage: { info: () => phoneStorageInfo() },
  });
  // The core reaches the database only through `adapter` and `repo` (step 1.4 B16): no synchronous handle.
  const coreContext = {
    adapter: dbAdapter(), atStart, repo, transaction, getOwner, userExists, isStorageFullError, istDateStamp, storageFull, parseLedgerFilters,
    host,
    auth: requireApiAuth, // never called here: localApp runs only the last handler
    logError: (...args) => console.error(...args),
    ledgerIndex,
    exclusive: (fn) => requestQueue.run(fn), // for the one route outside the queue (the PDF): its database part
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
  const { unitPricePaise, contractRow } = contractsRoutes.register(localApp, { ...coreContext, ledgerLabel, resolveLedger });

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
  // Data backup. JSON export and import (REPLACE, made safe: check, safety copy, one transaction):
  // core/routes/backup.js (step 1.4 A7), with the format in backup-format.js, shared with server.js.
  // The phone's own part is the safety copy, host.snapshot.writeJson (safety-snapshots.js): the
  // app's private data folder through Capacitor Filesystem, checked with stat; in a plain browser, a
  // download.
  // ---------------------------------------------------------------------------
  backupRoutes.register(localApp, { ...coreContext, CUSTOM_CODE });

  // Storage meter on the Data Backup page (Phase 2, Step 3): core/routes/storage.js (step 1.4 C11),
  // from phoneStorageInfo() above.
  storageRoutes.register(localApp, coreContext);

  // Phase 7 — the encrypted full-snapshot backup (the WHOLE database, byte for byte) is in
  // core/routes/backup.js since step 1.4 C11, through the host above. The body carries the encrypted
  // bytes as base64 (an in-process call through the fetch shim, not a real HTTP request).
  // Phase 15 backup-overdue reminder (GET/PUT /api/backup/reminder, POST /api/backup/mark-exported):
  // core/routes/backup-reminder.js (step 1.4 A6). Its clock is host.now().
  backupReminderRoutes.register(localApp, coreContext);

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

  // For the tests (test/shim-target.js, test/request-queue-wiring.test.js); local-bootstrap.js does not use it.
  const ready = Promise.all(startJobs);
  ready.catch(() => {}); // reported where it is awaited
  return { requestQueue, routes, ready };
}
