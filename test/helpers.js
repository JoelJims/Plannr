// Shared test harness (Phase 9). MUST be the FIRST require in every test file: it sets PLANNR_TEST
// and a UNIQUE PLANNR_DB *before* requiring db.js/server.js, so the hoisted prepared statements bind
// to the temp DB and the live data/plannr.db is never opened. node --test runs each file in its own
// process, so one temp DB + one app instance per file — natural isolation, no mid-process re-pointing.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert');

// --- env, set BEFORE any require of ./db or ./server ---------------------------------------------
process.env.PLANNR_TEST = '1';                       // structural: makeTransport() -> null
if (!process.env.PLANNR_DB) {
  process.env.PLANNR_DB = path.join(os.tmpdir(), `plannr-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
}
const TEST_DB = process.env.PLANNR_DB;
// Defensive: never let a test touch the live DB even if something is misconfigured.
const LIVE_DB = path.resolve(__dirname, '..', 'data', 'plannr.db');
assert.notStrictEqual(path.resolve(TEST_DB).toLowerCase(), LIVE_DB.toLowerCase(), 'test DB must not be the live DB');

const app = require('../server'); // requires ./db (binds prepared statements to TEST_DB) with side effects gated off
const { db } = require('../db');
const pw = require('../password');

// One bcrypt hash, computed ONCE and reused for every seeded user via direct INSERT — bcrypt at 12
// rounds is ~200ms, so registering users through the route would dominate the suite's runtime.
const SEED_PW = 'TestPass123!aa';
const SEED_HASH = pw.hashSync(SEED_PW);

// --- app lifecycle (ephemeral port; drive over real HTTP) ----------------------------------------
let server = null, base = null;
function startApp() {
  if (base) return Promise.resolve({ base, server });
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, server });
    });
  });
}
async function stopApp() {
  // Close a Playwright PDF browser that a GET /overview may have warmed — its open handles would
  // otherwise keep the process alive and hang the file's runner.
  try { if (app._closePdfBrowser) await app._closePdfBrowser(); } catch { /* ignore */ }
  await new Promise((r) => { if (server) server.close(() => r()); else r(); });
}

// --- HTTP (Node fetch has no cookie jar — thread set-cookie manually) -----------------------------
async function req(method, urlPath, { cookie, body, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (cookie) h.Cookie = cookie;
  let payload;
  if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(base + urlPath, { method, headers: h, body: payload, redirect: 'manual' });
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  let json = null, text = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) { json = await r.json().catch(() => null); } else { text = await r.text().catch(() => null); }
  return { status: r.status, json, text, headers: r.headers, setCookie, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}
const get = (p, o) => req('GET', p, o);
const post = (p, body, o) => req('POST', p, Object.assign({ body }, o));
const put = (p, body, o) => req('PUT', p, Object.assign({ body }, o));
const del = (p, o) => req('DELETE', p, o);

// login through the REAL route (auth tests use this; returns the threaded session cookie).
async function login(username, password) {
  const r = await post('/api/login', { username, password });
  return { status: r.status, cookie: r.cookie, json: r.json };
}

// --- seed helpers (direct INSERT — fast, bypasses routes) -----------------------------------------
let userSeq = 0;
function seedUser(opts = {}) {
  const username = opts.username || `user${++userSeq}`;
  const displayName = opts.displayName || username;
  const info = db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)').run(username, displayName, SEED_HASH);
  return { id: Number(info.lastInsertRowid), username, displayName, password: SEED_PW };
}
// A valid session cookie WITHOUT a bcrypt login — for the many functional tests that just need "a
// logged-in user" and aren't testing auth. token_hash = sha256(token), matching server.js hashToken.
function seedSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now','+90 days'))").run(tokenHash, userId);
  return 'plannr_session=' + token;
}
// A logged-in user in one step: seed the user + a session, return { user, cookie }.
function seedLoggedIn(opts) { const user = seedUser(opts); return { user, cookie: seedSession(user.id) }; }

// Tenancy Phase 2 — every ledger table now has NOT NULL tenant_id. The seed helpers stamp it from
// opts.tenantId, falling back to opts.byUserId (where present) and finally the first seeded user
// (SELECT MIN(id) FROM users) — so the existing call sites (which seed a user first) need no change,
// and the two-tenant tests pass tenantId explicitly.
function seedContract(opts = {}) {
  const info = db.prepare(
    `INSERT INTO contract (contractor_name, area_of_work, ledger_code, price_of_contract_paise, date_signed, deleted_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT MIN(id) FROM users)))`
  ).run(opts.contractorName || 'ACME', opts.areaOfWork || 'Foundation', opts.ledgerCode || '5.0',
    opts.pricePaise == null ? 10000000 : opts.pricePaise, opts.dateSigned || '2026-07-01', opts.deletedAt || null, opts.tenantId == null ? null : opts.tenantId);
  return Number(info.lastInsertRowid);
}
function seedPayment(opts = {}) {
  const info = db.prepare('INSERT INTO contractor_payments (contract_id, pay_date, amount_paise, deleted_at, tenant_id) VALUES (?, ?, ?, ?, COALESCE(?, (SELECT tenant_id FROM contract WHERE id = ?), (SELECT MIN(id) FROM users)))')
    .run(opts.contractId, opts.payDate || '2026-07-10', opts.amountPaise == null ? 4000000 : opts.amountPaise, opts.deletedAt || null, opts.tenantId == null ? null : opts.tenantId, opts.contractId);
  return Number(info.lastInsertRowid);
}
function seedCashOut(opts = {}) {
  const info = db.prepare(
    `INSERT INTO cash_out (amount_paise, tx_date, by_type, by_user_id, by_label, ledger_code, subledger_code, contract_scope, contract_stated_paise, deleted_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ?, (SELECT MIN(id) FROM users)))`
  ).run(opts.amountPaise == null ? 100000 : opts.amountPaise, opts.txDate || '2026-07-12', opts.byType || 'user',
    opts.byUserId == null ? null : opts.byUserId, opts.byLabel || null, opts.ledgerCode || '1.0', opts.subledgerCode || null,
    opts.contractScope || 'extra', opts.contractStatedPaise == null ? null : opts.contractStatedPaise, opts.deletedAt || null,
    opts.tenantId == null ? null : opts.tenantId, opts.byUserId == null ? null : opts.byUserId);
  return Number(info.lastInsertRowid);
}
function seedCashIn(opts = {}) {
  const info = db.prepare('INSERT INTO cash_in (amount_paise, by_type, by_user_id, by_label, reason, deleted_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, ?, (SELECT MIN(id) FROM users)))')
    .run(opts.amountPaise == null ? 100000 : opts.amountPaise, opts.byType || 'user', opts.byUserId == null ? null : opts.byUserId,
      opts.byLabel || null, opts.reason || null, opts.deletedAt || null, opts.tenantId == null ? null : opts.tenantId, opts.byUserId == null ? null : opts.byUserId);
  return Number(info.lastInsertRowid);
}

// Clear ledger + config state between tests in a file (users/sessions kept). Lets each test start
// from a clean slate without a fresh DB per test.
function clearLedger() {
  for (const t of ['cash_out', 'cash_in', 'contractor_payments', 'contract', 'loans']) { try { db.exec(`DELETE FROM ${t}`); } catch { /* table may not exist */ } }
  try { db.exec('DELETE FROM edit_locks'); } catch { /* ignore */ }
  try { db.prepare("DELETE FROM settings WHERE key IN ('budget_paise','daily_report_recipients','daily_report_whatsapp','daily_report_times','daily_report_time','daily_report_whatsapp_times','daily_report_email_last_success','daily_report_email_last_catchup','daily_report_whatsapp_last_success','daily_report_whatsapp_last_catchup','daily_report_email_attempts','daily_report_whatsapp_attempts','daily_report_whatsapp_alert_last','daily_report_email_last_snapshot','daily_report_whatsapp_last_snapshot','auth_events','auth_events_unknown')").run(); } catch { /* ignore */ }
}

// Best-effort cleanup of the temp DB when the file's process exits.
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } } });

module.exports = {
  app, db, pw, TEST_DB, LIVE_DB, SEED_PW, SEED_HASH,
  startApp, stopApp, req, get, post, put, del, login, clearLedger,
  seedUser, seedSession, seedLoggedIn, seedContract, seedPayment, seedCashOut, seedCashIn,
};
