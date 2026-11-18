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
const { db, initSync, DB_PATH, isStorageFullError, rollbackQuietly } = require('./db');
const { encrypt, MIN_PASSPHRASE_LEN } = require('./backup-crypto'); // the encrypted export (also the Ledger List import's safety backup)

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

initSync(); // step 1.4 B4: the synchronous start, until server.js awaits init() (B17)

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
const { str, parsePaise, parseAmountFilter, parseLedgerFilters, fmtRs } = require('./core/parsers.js');
const { createLedgerIndex } = require('./core/ledger-index.js');
const { checkHost, hostError } = require('./core/host.js');
const { createRequestQueue, queuedRoutes } = require('./core/request-queue.js');

// Prepared statements go here or later, AFTER init() has created and migrated every table, so each
// binds to the final schema (preparing before init() would bind to a pre-migration or dropped
// table). The Overview's queries live in repo.overview.* (see core/routes/overview.js) and the
// budget's in core/routes/budget.js; both are prepared after this point too.
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
// The platform services the core may call (core/host.js, step 1.4 A4): this server's. Both are
// defined further down: renderOverviewPdf (Playwright) and writeJsonSnapshotBesideDb.
const host = checkHost({
  pdf: { render: (html) => renderOverviewPdf(html) },
  snapshot: { writeJson: async (backup) => writeJsonSnapshotBesideDb(backup) },
  now: () => new Date(),
});
// One request at a time (core/request-queue.js, step 1.4 B5): every /api route is registered through
// `api`, which runs its handler inside this queue. Pages and static files do not touch the database
// and stay on `app`. The phone (public/local-api.js) does the same.
const requestQueue = createRequestQueue();
const api = queuedRoutes(app, requestQueue);
// The ledger list's first read (step 1.4 B10: through the async interface) is the queue's first job,
// so no request can run before the list is in memory. app._ready is this; the start below waits for it.
const ledgerIndexReady = requestQueue.run(() => ledgerIndex.refresh());
ledgerIndexReady.catch(() => {}); // reported where it is awaited (the start below, the tests)
const coreContext = {
  db, repo, getOwner, userExists, isStorageFullError, rollbackQuietly, istDateStamp, parseLedgerFilters,
  host,
  auth: requireApiAuth,
  logError: (...args) => { if (!IS_PROD) console.error(...args); },
  storageFull: (what) => `Storage is full — ${what} Free up space, then try again.`,
  ledgerIndex,
  exclusive: (fn) => requestQueue.run(fn), // for the one route outside the queue (the PDF): its database part
};
require('./core/routes/people.js').register(api, coreContext);
require('./core/routes/ledger-list.js').register(api, coreContext);

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
const { makeLedgerCrud, LEDGER_CRUDS } = require('./core/ledger-crud.js').createLedgerCrud(api, coreContext);

// Cash in, loans and cash out: core/routes/cash-and-loans.js (step 1.3). What it returns is used by
// the routes still written below.
const { REASON_MAX, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CUSTOM_CODE, ledgerLabel, resolveLedger, CASH_OUT_SELECT, cashOutRow } = require('./core/routes/cash-and-loans.js').register(api, { ...coreContext, makeLedgerCrud });
// The Contract Details API (contracts, services, allowances): core/routes/contracts.js (step 1.3).
const { unitPricePaise, contractRow, CONTRACT_COLS } = require('./core/routes/contracts.js').register(api, { ...coreContext, ledgerLabel, resolveLedger });

// The Contractor Payments API: core/routes/contractor-payments.js (step 1.3).
const { CONTRACTOR_PAYMENTS_SELECT, paymentRow } = require('./core/routes/contractor-payments.js').register(api, { ...coreContext, makeLedgerCrud, ledgerLabel, resolveLedger, REASON_MAX });

// The Recycle Bin: core/routes/trash.js (step 1.3).
require('./core/routes/trash.js').register(api, { ...coreContext, CASH_IN_SELECT, cashInRow, LOANS_SELECT, loanRow, CASH_OUT_SELECT, cashOutRow, contractRow, CONTRACTOR_PAYMENTS_SELECT, paymentRow });

// ---------------------------------------------------------------------------
// Overview API (READ-ONLY analytics) + the optional overall budget. Logged-in
// only. Every figure is computed from LIVE (non-deleted) rows; money is INTEGER
// paise throughout (never float). No editing here — that is a later phase.
// ---------------------------------------------------------------------------

// The overall budget: core/routes/budget.js (step 1.3).
const { getBudgetPaise } = require('./core/routes/budget.js').register(api, coreContext);

// The reminder times: core/routes/notification-times.js (step 1.3).
require('./core/routes/notification-times.js').register(api, coreContext);

// The Overview: core/routes/overview.js (step 1.3).
const { computeOverview } = require('./core/routes/overview.js').register(api, { ...coreContext, ledgerLabel, CUSTOM_CODE, unitPricePaise, getBudgetPaise });

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

// What goes into the PDF (query checks, data, HTML): core/overview-pdf.js (step 1.3). Rendering it
// stays here, below.
const { readPdfQuery, overviewPdfHtml } = require('./core/overview-pdf.js').createOverviewPdf({ computeOverview, LEDGER_CRUDS, cashOutRow, CUSTOM_CODE, ledgerIndex });

// This server's pdf.render (core/host.js, step 1.4 A4): the Overview PDF page -> a PDF Buffer, with
// Playwright. Waits for a render slot first (the guard below). Every refusal or failure is a
// hostError, so the route answers exactly as before: 503 "busy" or 503 "unavailable".
async function renderOverviewPdf(html) {
  const gotSlot = await acquirePdfSlot();
  if (!gotSlot) throw hostError(503, 'The server is busy generating other PDFs right now. Please try again in a moment.');
  _pdfInFlight++;                                    // hold off the idle-close for the whole render
  try {
    const browser = await getPdfBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    } finally { await page.close(); }
  } catch (err) {
    _pdfBrowserPromise = null; // reset so a later request can relaunch
    throw hostError(503, 'PDF generation is unavailable on the server (Playwright/Chromium not ready).', err);
  } finally {
    _pdfInFlight--; touchPdfActivity();             // (re)arm the idle timer after each render
    releasePdfSlot();
  }
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

// The route itself: core/routes/pdf.js (step 1.4 A5). It renders through host.pdf.render, which is
// renderOverviewPdf above.
require('./core/routes/pdf.js').register(api, { ...coreContext, readPdfQuery, overviewPdfHtml });

// ---------------------------------------------------------------------------
// Phase 2 — one-request health check for the windowless case. Server start time only now.
api.get('/api/health', requireApiAuth, (req, res) => {
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
// The startup drift guard (see backup-format.js) runs when core/routes/backup.js registers. This copy
// is for the schema tests (app._assertImportOwnershipComplete).
const assertImportOwnershipComplete = () => backupFormat.assertImportOwnershipComplete(db);

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
api.post('/api/backup/export-encrypted', requireApiAuth, async (req, res) => {
  const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
  if (!passphrase) return res.status(400).json({ error: 'Enter a passphrase to encrypt this backup.' });
  if ([...passphrase].length < MIN_PASSPHRASE_LEN) return res.status(400).json({ error: `Use a passphrase of at least ${MIN_PASSPHRASE_LEN} characters. A short one can be guessed by anyone who gets the file.` });
  try {
    const plain = vacuumSnapshotBytes();
    const enc = await encrypt(plain, passphrase); // a Buffer (backup-crypto.js -> core/backup-crypto.js)
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
api.post('/api/backup/import-encrypted', requireApiAuth, (req, res) => {
  res.status(501).json({ error: 'Restoring from an encrypted backup isn’t available when Plannr is running as a hosted server. Use the Android app to restore an encrypted backup, or restore this server from the plain JSON backup instead.' });
});

// Phase 15 backup-overdue reminder (GET/PUT /api/backup/reminder, POST /api/backup/mark-exported):
// core/routes/backup-reminder.js (step 1.4 A6). Its clock is host.now().
require('./core/routes/backup-reminder.js').register(api, coreContext);

// Storage meter on the Data Backup page (Phase 2, Step 3). The phone answers this from its app
// storage limit (public/local-api.js measureStorage()); a desktop database file has no such limit.
api.get('/api/storage', requireApiAuth, (req, res) => {
  let databaseBytes = null;
  try { databaseBytes = fs.statSync(DB_PATH).size; } catch { /* reported as unknown */ }
  res.json({ mode: 'desktop', databaseBytes, usedBytes: null, limitBytes: null, fraction: null, level: 'ok' });
});

// This server's snapshot.writeJson (core/host.js, step 1.4 A4): the safety copy before a JSON
// restore goes in a file beside the DB, and the answer reports its path relative to the project.
function writeJsonSnapshotBesideDb(backup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapPath = path.join(path.dirname(DB_PATH), `auto-snapshot-before-import-${stamp}.json`);
  fs.writeFileSync(snapPath, JSON.stringify(backup, null, 2));
  return path.relative(__dirname, snapPath).split(path.sep).join('/');
}

// JSON export and import (REPLACE, made safe: check, safety copy, one transaction):
// core/routes/backup.js (step 1.4 A7).
require('./core/routes/backup.js').register(api, { ...coreContext, CUSTOM_CODE });

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
// Global error handler (must be last; 4-arg signature). An error thrown by an /api
// handler arrives here through the request queue (core/request-queue.js passes it to
// next), so individual routes don't need try/catch. Never leak internals in production.
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
app._requestQueue = requestQueue; // step 1.4 B5: tests hold it to check every /api route waits its turn
app._ready = ledgerIndexReady; // step 1.4 B10: settles once the ledger list is read (the queue's first job)
app._accessGate = accessGate; // Phase 1 safety: LAN/Host gate, unit-tested with fake requests
app._accessConfig = accessConfig;
app._watchStopSentinel = watchStopSentinel; // Phase 11B: test that a sentinel file routes into the same stop callback as SIGINT
// Phase 10G — the exact HTML page.pdf() rasterizes, for rendering the table to an image in tests
// (the authoritative composition path; the endpoint's compressed stream is a weaker check).
app._overviewPdfHtml = ({ part = 'full', theme = 'light', range = { start: null, end: null } } = {}) =>
  overviewPdfHtml({ part, theme, range });
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

  ledgerIndexReady.then(() => {
    app.listen(PORT, access.host, () => {
      console.log('DEV MODE – not used by the phone app');
      console.log(`Plannr desktop dev server running at http://localhost:${PORT} (the Android app keeps its own data and never talks to this server).`);
      if (access.lan && lanIp) console.log(`  on your network:  http://${lanIp}:${PORT}/?token=<your PLANNR_TOKEN>  (open once per device)`);
    });
  }, (e) => {
    console.error('[startup] could not read the ledger list:', e);
    process.exit(1);
  });
}
