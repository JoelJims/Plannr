// Plannr — Express server: registration, login, sessions, logout.

// Load .env (if present) BEFORE anything reads process.env. Node built-in — no dotenv
// dependency. Real environment variables win over the file, and a missing .env is fine.
try { process.loadEnvFile(); } catch { /* no .env present */ }

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const pw = require('./password'); // shared hashing + strength (bcrypt + cost factor live there)
const { db, init, DB_PATH, SESSION_TTL_DAYS, cleanupExpiredSessions } = require('./db');
const { LEDGERS } = require('./public/ledgers.js'); // fixed 23-ledger reference (single source, shared with the browser)
const csp = require('./csp');                        // Phase 8C: per-page CSP (inline hashes computed at boot)

// Shared IST (Asia/Kolkata) date/time stamps — used by auth-event logging, the Overview PDF
// filename, and upcoming-payment day counts. IST has no DST, so no seasonal complexity.
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

// Behind a reverse proxy in production, trust the first hop so req.ip is the
// real client address (used by the auth rate limiter), not the proxy's.
if (IS_PROD) app.set('trust proxy', 1);

const COOKIE_NAME = 'plannr_session';
// Phase 8A — cookie lifetime derives from the SAME SESSION_TTL_DAYS as the DB expires_at column,
// so browser and server agree on the absolute 90-day window. The SQL modifier ('+90 days') used to
// stamp expires_at at login comes from the same constant too — one source, no drift.
const SESSION_MAX_AGE_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const SESSION_EXPIRY_MODIFIER = `+${SESSION_TTL_DAYS} days`;

// A valid-format hash we compare against when the username is unknown, so a
// wrong username and a wrong password take roughly the same time (limits
// username enumeration via timing). A login-FLOW concern, so it stays here — but it
// uses the shared hasher so the cost factor is still defined only in password.js.
const DUMMY_HASH = pw.hashSync('plannr-timing-equalizer'); // sync at boot (see password.js)

init();

// Tenancy Phase 3 — the tenant data-access layer. Required AFTER init() so it can prepare its
// tenant-scoped statements against the migrated schema. Every read/write touching one of the eight
// tenant tables goes through repo.*; the boot assertion (below, after the definitions it needs) is
// the backstop that fails boot on an unscoped statement.
const repo = require('./repo');

// Hot prepared statements — hoisted here, AFTER init() has created and migrated every
// table (incl. the cash_out create-copy-swap rebuild and the contract_services drop), so
// each binds to the final schema. node:sqlite compiles each SQL once here instead of on
// every call. These sit on the hottest paths: currentUser() runs on every authenticated
// request and guarded page load; computeOverview()'s four queries + getBudgetPaise() back
// the Overview screen and every PDF export; lockRow() backs the single-editor lock/heartbeat.
// (Order matters — declaring these before init() would prepare against a pre-migration or
// dropped table. Keep them here.)
// currentUser enforces the ABSOLUTE expiry here: a session past expires_at is treated as if it did
// not exist (no row returned → 401 → redirect to login). We deliberately do NOT implement idle/sliding
// expiry: that would require a last_seen_at (or expires_at) WRITE on every authenticated request — this
// statement runs on the hottest path — and keeping that path read-only is intentional. The expiry is
// absolute-from-creation by design; do not add a per-request write here.
const CURRENT_USER_STMT = db.prepare(
  `SELECT u.id, u.username, u.display_name AS displayName
     FROM sessions s
     JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > datetime('now')`
);
const LOCK_ROW_STMT = db.prepare(
  "SELECT holder_user_id, holder_display_name, acquired_at, last_heartbeat_at, " +
  "(strftime('%s','now') - strftime('%s', last_heartbeat_at)) AS age FROM edit_locks WHERE scope = ?"
);
// Tenancy Phase 3 (Part B.6) — the budget read is now tenant-scoped (settings has a composite
// (tenant_id, key) key). B can no longer read A's budget.
const BUDGET_STMT = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'budget_paise'");
// Phase 6C — computeOverview reads each ledger table BOTH cumulatively (a balance) and
// range-scoped (a period figure), so the two are split into separate queries:
//
//  Tenancy Phase 3 — these eight statements MOVED into repo.overview.* (tenant-scoped). computeOverview
//  now calls repo.overview.<x>(tenantId): cashoutCumulative, contracts, paidByContract, outsAll/outsRange,
//  paymentsAll/paymentsRange, loansSum. The cumulative aggregates are still never range-filtered (the
//  offset stays cumulative); the range forms still use the open sentinels + partial indexes.
// Phase 2: the user roster for the "By" attribution pickers (id + display name ONLY — never
// username/hash), and an existence check for validating a chosen by_user_id.
// Tenancy Phase 3 (Part B.7) — the "By" roster is scoped to the tenant. Under one-account-per-household
// the tenant IS a user, so this is that one account (id = tenant). B can no longer enumerate A's users.
// (users has no tenant_id — the tenant id IS the account id in the current model.)
const USERS_ROSTER_STMT = db.prepare('SELECT id, display_name AS displayName FROM users WHERE id = ? ORDER BY id ASC');
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
app.use(cookieParser());

// Baseline security headers on every response (defense-in-depth; no dependency).
// nosniff: don't let the browser MIME-sniff; DENY: block framing (clickjacking);
// same-origin referrer: don't leak full URLs cross-site. (CSP/CSRF intentionally
// not added here — see review notes.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

// The raw token lives only in the user's cookie. We store only its SHA-256
// hash, so a leaked database can't be used to hijack live sessions.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Part D — the request's client IP (trust-proxy-aware in prod; 'unknown' fallback, as the rate limiter)
// and a length-capped user-agent. Used to stamp sessions + auth events so a stolen session leaves a trace.
function reqIp(req) { return (req && req.ip) || 'unknown'; }
function reqUa(req) { return String((req && req.get && req.get('user-agent')) || '').slice(0, 200) || null; }

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  // expires_at set explicitly (NOT relying on the column default — a migrated DB's ADD COLUMN has
  // none) from the shared constant, so it's absolute and never extended. Opportunistic sweep of
  // expired rows here (login is low-frequency, unlike the per-request path) keeps the table bounded.
  // Part D — record origin ip + user_agent for the active-sessions surface (record-and-surface).
  cleanupExpiredSessions();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?, ?, datetime('now', ?), ?, ?)")
    .run(hashToken(token), userId, SESSION_EXPIRY_MODIFIER, reqIp(req), reqUa(req));
  return token;
}

// ---------------------------------------------------------------------------
// Part D — auth-event detection rings. Bounded (last 50) JSON arrays in settings (composite
// (tenant_id,key)) — mirroring the Daily-Report attempt-ring. Each event carries an IST timestamp +
// request IP. The attempted USERNAME is recorded on a failed login; the PASSWORD is NEVER stored, not
// even hashed. Two rings:
//   • PER-TENANT `auth_events` — a real account's own activity (login_success|login_failed|logout|
//     password_change|lockout). Surfaced on Home, the Data page, and /api/health (tenant-scoped).
//   • GLOBAL `auth_events_unknown` under the RESERVED tenant_id 0 (settings has no FK; 0 has no user
//     row) — login attempts for usernames that DON'T EXIST. These have no owning account, so filing
//     them under a real tenant would be wrong and would pollute that account's log. Kept in this global
//     ring and DELIBERATELY excluded from every tenant's `auth_events` and from /api/health, so they
//     can never leak into an account's own view. Username enumeration is exactly what an attacker does
//     first, so the count is surfaced to the owner on Home + the Data page, beside the failed-attempts.
// ---------------------------------------------------------------------------
const AUTH_EVENTS_KEEP = 50;
const GLOBAL_TENANT = 0;                          // reserved settings row — global (non-account) signals
const UNKNOWN_KEY = 'auth_events_unknown';
const getRingStmt = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?');
const setRingStmt = db.prepare('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value');
function readRing(tenantId, key) {
  try { const r = getRingStmt.get(tenantId, key); if (r && r.value) { const v = JSON.parse(r.value); if (Array.isArray(v)) return v; } } catch { /* corrupt/absent → empty */ }
  return [];
}
function pushRing(tenantId, key, rec) {
  const arr = readRing(tenantId, key);
  arr.push(rec);
  while (arr.length > AUTH_EVENTS_KEEP) arr.shift(); // bounded like the others
  setRingStmt.run(tenantId, key, JSON.stringify(arr));
}
function evRec(type, detail = {}) {
  const now = new Date();
  const rec = { at: now.toISOString(), atIST: istStampFull(now), type, ip: detail.ip || null };
  if (detail.username != null) rec.username = String(detail.username).slice(0, 60); // NEVER the password
  return rec;
}
function readAuthEvents(tenantId) { return readRing(tenantId, 'auth_events'); }
// A real account's event. tenantId is the OWNING user id; a null tenant (unknown username) routes to
// recordUnknownLoginFailure instead — never filed here.
function recordAuthEvent(tenantId, type, detail = {}) {
  if (!tenantId) return null;
  const rec = evRec(type, detail);
  pushRing(tenantId, 'auth_events', rec);
  return rec;
}
// A login attempt for a username that does not exist → the GLOBAL ring only. No owning tenant, no
// password. This is the username-enumeration signal.
function recordUnknownLoginFailure(username, ip) { pushRing(GLOBAL_TENANT, UNKNOWN_KEY, evRec('login_failed_unknown', { username, ip })); }
function readUnknownLoginFailures() { return readRing(GLOBAL_TENANT, UNKNOWN_KEY); }

// The tenant's PREVIOUS successful login (the current session's is the last; this is the one before) —
// the boundary shared by "failed attempts since" and "unknown attempts since".
function prevLogin(tenantId) {
  const successes = readAuthEvents(tenantId).filter((e) => e.type === 'login_success');
  return successes.length >= 2 ? successes[successes.length - 2] : null;
}
// TENANT-scoped summary for Home + /api/health (NO global/unknown data — that must not leak here).
function authSummary(tenantId) {
  const events = readAuthEvents(tenantId);
  const prev = prevLogin(tenantId);
  const boundary = prev ? prev.at : '';
  return { lastLogin: prev ? { atIST: prev.atIST, ip: prev.ip } : null, failedSinceLastLogin: events.filter((e) => e.type === 'login_failed' && e.at > boundary).length };
}
// GLOBAL unknown-username enumeration summary — surfaced to the owner on Home + the Data page ONLY
// (never in a tenant's auth_events, never in /api/health). `sinceLastLogin` uses the caller's own
// previous-login boundary so it reads alongside failedSinceLastLogin.
function unknownEnumeration(tenantId) {
  const prev = prevLogin(tenantId);
  const boundary = prev ? prev.at : '';
  const ring = readUnknownLoginFailures();
  return { sinceLastLogin: ring.filter((e) => e.at > boundary).length, ringSize: ring.length, recent: ring.slice(-25).reverse() };
}

function currentUser(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  return CURRENT_USER_STMT.get(hashToken(token)) || null;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,       // not readable from JS — mitigates XSS token theft
    sameSite: 'lax',
    secure: IS_PROD,      // require HTTPS in production
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;
// Password strength (min length) lives in password.js (pw.passwordError) so the script and server agree.

// Normalize a text field: coerce to string and trim. NOT for passwords — a
// leading or trailing space is a legitimate password character.
const str = (v) => String(v ?? '').trim();

// ---------------------------------------------------------------------------
// Rate limiting (auth endpoints only)
// ---------------------------------------------------------------------------
// Dependency-free fixed-window limiter: at most RL_MAX attempts per IP per
// window. In-memory only, so it resets on restart — acceptable for this small
// single-process app; its job is to blunt brute-force / credential-stuffing
// bursts, not to be a durable quota. Kept lenient so real users never hit it.
const RL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RL_MAX = 10;                  // attempts per IP per window
const rateBuckets = new Map();      // ip -> { count, resetAt }

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RL_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RL_MAX) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
  }
  next();
}

// Periodically drop expired buckets so the Map can't grow without bound.
// unref() so this timer never keeps the process alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
}, RL_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// Login brute-force lockout (a strict second layer ON TOP of the per-IP
// rateLimit above). Tracks failed logins per (IP + username) pair: after
// LOGIN_MAX_FAILS failures the pair is refused for LOGIN_LOCK_MS — even with
// the correct password — then auto-clears; a successful login clears the pair.
// In-memory, lazy-expired (resets on restart). It is purely COUNT-based, so it
// behaves identically for a real and a fake username and never reveals whether
// an account exists. A different username from the same IP has its own budget.
// ---------------------------------------------------------------------------
const LOGIN_MAX_FAILS = 5;       // real users mistype once or twice; 5 gives clear headroom
const LOGIN_LOCK_MS = 60 * 1000; // 60-second cooldown, then auto-clears (not a permanent lock)
const loginFails = new Map();    // `${ip}::${username}` -> { count, expireAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginFails) {
    if (now >= rec.expireAt) loginFails.delete(key);
  }
}, LOGIN_LOCK_MS).unref();

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Phase 7C — Express 4 does NOT catch rejections from async route handlers: an async handler that
// throws leaves the request hanging forever and never reaches the error handler. Wrap every async
// handler so a rejection is forwarded to next() -> the global error handler -> a real response.
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post('/api/register', rateLimit, asyncH(async (req, res) => {
  const username = str(req.body.username);
  const displayName = str(req.body.displayName);
  const password = String(req.body.password || '');            // never trim a password
  const confirmPassword = String(req.body.confirmPassword || '');

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-30 characters: letters, numbers, dot, dash or underscore.',
    });
  }
  if (!displayName || displayName.length > 60) {
    return res.status(400).json({ error: 'Display name is required (max 60 characters).' });
  }
  { const e = pw.passwordError(password); if (e) return res.status(400).json({ error: e }); }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = await pw.hash(password);
  db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)').run(
    username,
    displayName,
    passwordHash
  );

  res.status(201).json({ ok: true, message: 'Account created. You can now log in.' });
}));

app.post('/api/login', rateLimit, asyncH(async (req, res) => {
  const username = str(req.body.username);
  const password = String(req.body.password || '');            // never trim a password

  // Brute-force lockout keyed by (IP + username), checked BEFORE the credential
  // check and based purely on the failure count — so it behaves identically for
  // a real and a fake username (no account-existence leak).
  const now = Date.now();
  const key = `${req.ip || 'unknown'}::${username}`;
  const existing = loginFails.get(key);
  if (existing && now >= existing.expireAt) loginFails.delete(key); // lock expired -> auto-clear
  const rec = loginFails.get(key);
  if (rec && rec.count >= LOGIN_MAX_FAILS) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. For your security, sign-in is paused for about a minute — please wait and try again.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Phase 7C — bcrypt is now ASYNC, so concurrent logins interleave and the old
  // check-then-(after-await)-increment could let many attempts pass the check at a stale count.
  // Increment the failure count NOW (synchronously, before the await) — the check above + this
  // increment run in one tick, so concurrent attempts can't all read a low count. A SUCCESS
  // clears it below; so this optimistically counts the attempt as a failure until proven otherwise.
  loginFails.set(key, { count: (rec ? rec.count : 0) + 1, expireAt: now + LOGIN_LOCK_MS });
  const passwordOk = await pw.verify(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !passwordOk) {
    // Failure: the count is already incremented (above). Same generic message + timing equalizer.
    // Part D — record the failed attempt under the TARGETED account (if the username is real), so the
    // owner can see "someone tried to log in as me". An unknown username has no account home → console
    // only (never file a stranger's typo under a random tenant). Password is NEVER recorded.
    const newCount = (rec ? rec.count : 0) + 1;
    if (user) {
      recordAuthEvent(user.id, 'login_failed', { ip: reqIp(req), username });
      if (newCount === LOGIN_MAX_FAILS) recordAuthEvent(user.id, 'lockout', { ip: reqIp(req), username });
    } else {
      // Unknown username → the GLOBAL enumeration ring (no owning account). Username kept, password never.
      recordUnknownLoginFailure(username, reqIp(req));
      console.warn(`[auth] failed login for UNKNOWN username "${String(username).slice(0, 60)}" from ${reqIp(req)} — recorded to the global enumeration ring.`);
    }
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  loginFails.delete(key); // a successful login resets the pair's count to 0
  recordAuthEvent(user.id, 'login_success', { ip: reqIp(req) });
  const token = createSession(user.id, req);
  setSessionCookie(res, token);
  res.json({ ok: true, user: { id: user.id, username: user.username, displayName: user.display_name } });
}));

app.post('/api/logout', (req, res) => {
  const u = currentUser(req); // resolve BEFORE deleting the row, so we can attribute the event
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  if (u) recordAuthEvent(u.id, 'logout', { ip: reqIp(req) }); // Part D
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// Change password while logged in. Reuses the SAME session check (currentUser),
// bcrypt rounds, validation messages, and cookie clearing as the existing
// routes. On success every session row for this user is deleted (logged out
// everywhere) and the caller's cookie is cleared, forcing a fresh login with
// the new password. Rate-limited like the other credential endpoints.
app.post('/api/change-password', rateLimit, asyncH(async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });

  const currentPassword = String(req.body.currentPassword || ''); // never trim a password
  const newPassword = String(req.body.newPassword || '');
  const confirmPassword = String(req.body.confirmPassword || '');

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!row || !(await pw.verify(currentPassword, row.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  { const e = pw.passwordError(newPassword); if (e) return res.status(400).json({ error: e }); }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must be different from the current one.' });
  }

  const passwordHash = await pw.hash(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  recordAuthEvent(user.id, 'password_change', { ip: reqIp(req) }); // Part D — the ring lives in settings, survives the session wipe
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // log out everywhere
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true, message: 'Password changed. Please log in again.' });
}));

// Delete the logged-in user's OWN account (never anyone else's — always the
// session user). Requires the current password (bcrypt-verified, same as
// change-password). DATA-SAFETY GUARD: refuse if the account owns ANY ledger
// entries — cash_in/cash_out rows with by_user_id = this user, live OR
// soft-deleted — because deleting would orphan that data (and the by_user_id
// foreign key has no cascade). The user must reassign/remove those first. On a
// clean delete the user row is removed and its sessions cascade (schema
// ON DELETE CASCADE); the caller's cookie is cleared so the client goes to login.
// Rate-limited like the other credential endpoints.
app.post('/api/delete-account', rateLimit, asyncH(async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });

  const currentPassword = String(req.body.currentPassword || ''); // never trim a password
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!row || !(await pw.verify(currentPassword, row.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  // Rows the user authored, within their OWN tenant (one-account-per-household -> tenant_id = user.id).
  const owned = repo.authoredCount(user.id, user.id);
  if (owned > 0) {
    return res.status(409).json({
      error: `Your account is attached to ${owned} ledger entr${owned === 1 ? 'y' : 'ies'} recorded under your name. Deleting it would orphan that data, so it's blocked — reassign or remove those entries first, then delete your account.`,
    });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // sessions cascade (ON DELETE CASCADE)
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true, message: 'Account deleted.' });
}));

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  // Part D — lastLogin + failedSinceLastLogin (tenant), plus the GLOBAL unknown-username enumeration
  // count (a separate field, never merged into the tenant's own log). Both feed the Home surface.
  res.json({ user, ...authSummary(user.id), unknownLoginFailures: unknownEnumeration(user.id) });
});

// Part D — the caller's OWN active (non-expired) sessions + recent auth events, for the Data page's
// security section. Account-scoped (sessions carry user_id). Never returns the token hash; flags THIS
// session as `current`. events are the caller's own (own account) — no cross-tenant exposure.
app.get('/api/sessions', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const cur = req.cookies[COOKIE_NAME] ? hashToken(req.cookies[COOKIE_NAME]) : null;
  const rows = db.prepare("SELECT token_hash, created_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC").all(user.id);
  res.json({
    sessions: rows.map((r) => ({ createdAt: r.created_at, ip: r.ip || null, userAgent: r.user_agent || null, current: r.token_hash === cur })),
    events: readAuthEvents(user.id).slice(-25).reverse(), // most-recent first, bounded
    ...authSummary(user.id),
    unknownLoginFailures: unknownEnumeration(user.id), // GLOBAL enumeration ring (separate from the tenant log)
  });
});

// Part D — sign out on ALL devices (this one included). Reuses the same "delete all sessions for this
// user" primitive as change-password, then clears the caller's cookie → a fresh login is needed
// everywhere. One logout event is recorded (the ring lives in settings, so it survives the wipe).
app.post('/api/sign-out-everywhere', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const info = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  recordAuthEvent(user.id, 'logout', { ip: reqIp(req) });
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true, cleared: info.changes });
});

// Phase 8C — CSP violation sink. Browsers POST a report (application/csp-report) for every blocked
// resource; we log a compact line so report-only mode surfaces exactly what to fix before enforcing.
// Public (a violation can happen on the login page, pre-auth) and cheap; parses ANY content-type as
// JSON since browsers use application/csp-report, not application/json.
app.post('/api/csp-report', express.json({ type: () => true, limit: '64kb' }), (req, res) => {
  const r = (req.body && (req.body['csp-report'] || req.body)) || {};
  console.warn('[csp-report]', JSON.stringify({
    doc: r['document-uri'], violated: r['violated-directive'] || r['effective-directive'],
    blocked: r['blocked-uri'], source: r['source-file'], line: r['line-number'],
  }));
  res.status(204).end();
});

// User roster for the "By" attribution pickers. Auth-gated (requireApiAuth): a public
// roster would be a user-enumeration vector on the login page. Returns ONLY id +
// displayName, ordered by id — never username, password_hash, or created_at.
app.get('/api/users', requireApiAuth, (req, res) => {
  res.json({ users: USERS_ROSTER_STMT.all(req.user.id) });
});

// Services phase (Part E) — the caller's saved custom LEDGER names, for the debit form's pick-list.
// FILTERED by the caller (a genuinely PER-USER list, unlike the shared household ledger tables), so
// one user's private category names are never visible to another. Names are auto-saved on first use
// (see saveLedgerCustom / afterWrite on cash_out). The 23 built-ins stay in ledgers.js, not here.
app.get('/api/ledger-customs', requireApiAuth, (req, res) => {
  res.json({ customs: repo.ledgerCustoms.list(req.user.id) });
});
// Part 4 (Phase 11B): remove a saved custom LEDGER name from the caller's pick-list — the delete path
// that was missing (a typo like "Cemnt" used to be stuck in the dropdown forever, and the Recycle Bin
// doesn't cover ledger_customs). Name passed as ?name= (query, so any characters survive encoding).
// Idempotent (removing an absent name is a no-op 200) and tenant-scoped in repo. Denormalised: past
// debits keep their stored ledger_custom_name, so this prunes the autocomplete only, never rewrites history.
app.delete('/api/ledger-customs', requireApiAuth, (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Which name? Pass it as ?name=…' });
  repo.ledgerCustoms.remove(req.user.id, name);
  res.json({ ok: true, customs: repo.ledgerCustoms.list(req.user.id) });
});

// ---------------------------------------------------------------------------
// Cash Inflow API (cash_in) + the shared "people" source. Logged-in only.
// Money is stored as INTEGER paise (₹1 = 100); the API accepts rupees in and
// returns paise out. Parameterized queries only; soft-delete (never hard).
// ---------------------------------------------------------------------------

// API auth guard: like requireAuth but returns 401 JSON instead of an HTML
// redirect, so fetch() callers get a clean error (matches /api/me's convention).
function requireApiAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  req.user = user;
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
  // Tenancy Phase 3 — ALL SQL for this resource is built + tenant-scoped by repo.crud. Handlers never
  // touch the raw table; they pass req.user.id (the tenant) as the first argument. A row belonging to
  // another tenant simply isn't found — reads return nothing, mutations report 404 (never 403).
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
    // filters the list IN SQL (tenant-scoped in repo). Absent params → unchanged "all live rows" behaviour,
    // so every other resource and the no-filter fetch are untouched. `total` is the unfiltered live count
    // (for "N of M" + the add-form's next Sl.No, which must not shrink when a filter hides rows).
    if (opts.searchCols) {
      const f = parseLedgerFilters(req);
      if (f.error) return res.status(400).json({ error: f.error });
      return res.json({ [listKey]: rc.search(req.user.id, f.filters).map(shape), total: rc.liveCount(req.user.id), filtered: f.active });
    }
    res.json({ [listKey]: rc.list(req.user.id).map(shape) });
  });

  app.post(basePath, requireApiAuth, (req, res) => {
    const v = validate(req);
    if (v.error) return res.status(400).json({ error: v.error });
    if (finalize) { const f = finalize(v.values, { req, id: null, existing: null }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
    const info = rc.insert(req.user.id, orderedVals(v.values));
    if (afterWrite) afterWrite(v.values, { req, id: Number(info.lastInsertRowid) });
    res.status(201).json({ ok: true, [itemKey]: shape(rc.getById(req.user.id, info.lastInsertRowid)) });
  });

  app.put(`${basePath}/:id`, ...byIdChain, (req, res) => {
    const id = Number(req.params.id);
    // existsLive is tenant-scoped: another tenant's row (or a stranger's id) is NOT found -> 404.
    if (!Number.isInteger(id) || !rc.existsLive(req.user.id, id)) return res.status(404).json({ error: notFoundMsg });
    // Fetch the existing (tenant-scoped) row for the audit old-value + finalize's `existing`.
    const existing = (finalize || afterWrite || auditField) ? rc.fullRow(req.user.id, id) : null;
    const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
    const v = validate(req, oldVal);
    if (v.error) return res.status(400).json({ error: v.error });
    if (finalize) { const f = finalize(v.values, { req, id, existing }); if (f && f.error) return res.status(f.status || 400).json({ error: f.error }); }
    if (auditField && oldVal !== v.values[auditField]) console.warn(`[audit] ${table} id=${id}: ${auditField} ${oldVal} -> ${v.values[auditField]} (attribution changed on edit)`);
    rc.update(req.user.id, id, orderedVals(v.values));
    if (afterWrite) afterWrite(v.values, { req, id });
    res.json({ ok: true, [itemKey]: shape(rc.getById(req.user.id, id)) });
  });

  app.delete(`${basePath}/:id`, ...byIdChain, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: invalidIdMsg });
    const info = rc.softDelete(req.user.id, id); // scoped: nothing changes for another tenant's id -> 404
    if (info.changes === 0) return res.status(404).json({ error: notFoundMsg });
    res.json({ ok: true });
  });

  // Phase 6B — batch edit (Save All in ONE round trip). Only registered for resources that opt in
  // (cash_out). Validates EVERY row FIRST, then writes only the valid rows in a SINGLE transaction,
  // and returns a per-row result array — so per-row hold-back survives exactly ("saved 19, held
  // back 1"): invalid/not-found rows are left untouched and individually reported. Same lock
  // asymmetry as the by-id routes — editGate runs ONCE per request (X-Overview-Edit gates Overview;
  // Money Debited sends no header and passes through). Phase 2.1 preserved: the attribution audit
  // line logs per changed by_user_id, and a stored-NULL by_user_id round-trips via validate(oldVal).
  if (opts.batch) {
    app.post(`${basePath}/batch`, jsonBatch, ...byIdChain, (req, res) => {
      const rows = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
      if (!rows) return res.status(400).json({ error: 'Expected a { rows: [...] } array.' });
      if (rows.length > BATCH_MAX_ROWS) return res.status(413).json({ error: `Too many rows in one save (${rows.length}); the maximum is ${BATCH_MAX_ROWS}. Save in smaller batches.` });
      const t = req.user.id;

      // 1) VALIDATE every row before any write. Not-found (or another tenant's id) / invalid rows are
      // recorded, not written — existsLive / fullRow are tenant-scoped, so a stranger's row is "not found".
      const results = new Array(rows.length);
      const toWrite = []; // { i, id, values, oldVal } for the rows that passed
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const id = Number(row && row.id);
        if (!Number.isInteger(id) || !rc.existsLive(t, id)) { results[i] = { id: row && row.id, ok: false, error: notFoundMsg }; continue; }
        const existing = (finalize || auditField) ? rc.fullRow(t, id) : null;
        const oldVal = auditField ? (existing ? existing[auditField] : undefined) : undefined;
        const v = validate({ body: row }, oldVal);
        if (v.error) { results[i] = { id, ok: false, error: v.error }; continue; }
        if (finalize) { const f = finalize(v.values, { req, id, existing }); if (f && f.error) { results[i] = { id, ok: false, error: f.error }; continue; } }
        toWrite.push({ i, id, values: v.values, oldVal });
      }

      // 2) WRITE only the valid rows, in one transaction (each update tenant-scoped).
      db.exec('BEGIN');
      try {
        for (const w of toWrite) rc.update(t, w.id, orderedVals(w.values));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        if (!IS_PROD) console.error(`${table} batch write failed, rolled back:`, e);
        return res.status(500).json({ error: 'The save failed and was rolled back — no rows were changed.' });
      }

      // 3) Audit each attribution change + shape the saved rows.
      for (const w of toWrite) {
        if (auditField && w.oldVal !== w.values[auditField]) console.warn(`[audit] ${table} id=${w.id}: ${auditField} ${w.oldVal} -> ${w.values[auditField]} (attribution changed on edit)`);
        if (afterWrite) afterWrite(w.values, { req, id: w.id });
        results[w.i] = { id: w.id, ok: true, [itemKey]: shape(rc.getById(t, w.id)) };
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
  alias: 'c', // the table alias used in CASH_IN_SELECT — repo.crud scopes on c.tenant_id
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
  alias: '', // LOANS_SELECT has no table alias — repo.crud scopes on tenant_id
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

// Ledger lookups built once from the single source of truth (ledgers.js).
const LEDGER_BY_CODE = new Map(LEDGERS.map((l) => [l.code, l]));
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
          c.contract_scope, c.contract_stated_paise, c.contract_service_id, c.created_at,
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
    contractStatedPaise: r.contract_stated_paise, // Phase 5E: reimbursement offset (paise) when 'included', else null
    contractServiceId: r.contract_service_id,     // Services phase: the linked service (provenance), or null
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Single-editor lock for the Overview editable table (Part B). Scope: OVERVIEW
// ONLY — the cash-outflow page never acquires it and is never gated (its writes
// carry no marker). Authoritative + atomic; auto-releasable when stale.
// ---------------------------------------------------------------------------
const OVERVIEW_LOCK = 'overview';
const LOCK_STALE_SECONDS = 180; // 3 min without a heartbeat → takeover allowed
// Tenancy Phase 2 (Part C) — the Overview edit-lock is now PER TENANT. Previously one global
// scope='overview' row meant one household editing froze EVERYONE; namespacing the scope
// ('overview:<tenant>') gives each tenant an independent lock. No schema change (scope is already the
// TEXT primary key); the heartbeat + 3-minute stale-takeover behaviour are unchanged, just keyed per
// tenant. (ponytail: namespaced scope, not a tenant_id column — the scope key already encodes it.)
const overviewLockScope = (userId) => `${OVERVIEW_LOCK}:${userId}`;

// Current lock row for a scope with a computed `age` (seconds since last heartbeat), or null.
function lockRow(scope) {
  return LOCK_ROW_STMT.get(scope) || null;
}
function lockState(req) {
  const row = lockRow(overviewLockScope(req.user.id));
  const fresh = !!row && row.age <= LOCK_STALE_SECONDS;
  return {
    locked: fresh,
    holder: row ? { userId: row.holder_user_id, displayName: row.holder_display_name } : null,
    byMe: !!row && !!req.user && row.holder_user_id === req.user.id,
    stale: !!row && !fresh,
  };
}

app.get('/api/overview/lock', requireApiAuth, (req, res) => res.json({ lock: lockState(req) }));

// Acquire (atomic upsert): take the lock if free, held by me already, or STALE.
// A fresh lock held by someone else → no-op → we detect it and return 409.
app.post('/api/overview/lock', requireApiAuth, (req, res) => {
  db.prepare(
    "INSERT INTO edit_locks (scope, holder_user_id, holder_display_name, acquired_at, last_heartbeat_at) " +
    "VALUES (?, ?, ?, datetime('now'), datetime('now')) " +
    "ON CONFLICT(scope) DO UPDATE SET " +
    "  holder_user_id = excluded.holder_user_id, holder_display_name = excluded.holder_display_name, " +
    "  acquired_at = datetime('now'), last_heartbeat_at = datetime('now') " +
    "WHERE edit_locks.holder_user_id = excluded.holder_user_id " +
    `   OR (strftime('%s','now') - strftime('%s', edit_locks.last_heartbeat_at)) > ${LOCK_STALE_SECONDS}`
  ).run(overviewLockScope(req.user.id), req.user.id, req.user.displayName);
  const row = lockRow(overviewLockScope(req.user.id));
  if (row && row.holder_user_id === req.user.id) return res.json({ ok: true, lock: lockState(req) });
  return res.status(409).json({ error: (row ? row.holder_display_name : 'Someone') + ' is editing right now — you can view but not edit.', lock: lockState(req) });
});

// Heartbeat: only the current holder can refresh (keeps the lock fresh while editing).
app.post('/api/overview/lock/heartbeat', requireApiAuth, (req, res) => {
  const info = db.prepare("UPDATE edit_locks SET last_heartbeat_at = datetime('now') WHERE scope = ? AND holder_user_id = ?").run(overviewLockScope(req.user.id), req.user.id);
  if (info.changes === 0) return res.status(409).json({ error: 'You no longer hold the edit lock.', lock: lockState(req) });
  res.json({ ok: true, lock: lockState(req) });
});

// Release: idempotent, only clears the row if this user holds it.
app.delete('/api/overview/lock', requireApiAuth, (req, res) => {
  db.prepare('DELETE FROM edit_locks WHERE scope = ? AND holder_user_id = ?').run(overviewLockScope(req.user.id), req.user.id);
  res.json({ ok: true });
});

// Marker gate: ONLY requests that declare themselves an Overview edit
// (X-Overview-Edit: 1) are lock-checked. The caller must currently hold the lock,
// else 409 (covers a stale client whose lock was taken over). Requests without the
// header — i.e. the cash-outflow page — fall straight through, unaffected.
function overviewEditGate(req, res, next) {
  if (req.get('X-Overview-Edit') !== '1') return next();
  const row = lockRow(overviewLockScope(req.user.id));
  if (!row || row.holder_user_id !== req.user.id) {
    return res.status(409).json({ error: row ? (row.holder_display_name + ' is editing right now — refresh to see the latest.') : 'The edit lock is not held — click Edit to acquire it, then try again.' });
  }
  next();
}

// Services phase (Part E) — remember a typed custom LEDGER name in the caller's per-user list, so it is
// selectable next time. INSERT OR IGNORE keys on idx_ledger_customs_tenant_name (no duplicates). Called
// via afterWrite only when the row actually uses a custom ledger; a built-in ledger saves nothing.
const saveLedgerCustom = (tenantId, values) => {
  if (values.ledger_code === CUSTOM_CODE && values.ledger_custom_name && values.ledger_custom_name.trim()) {
    repo.ledgerCustoms.save(tenantId, values.ledger_custom_name.trim());
  }
};

// Services phase (Part C/D) — resolve + guard cash_out.contract_service_id. Runs AFTER validate, BEFORE
// the write, so it can MUTATE values and reject with a status. THE safety-critical piece: one service
// may source at most one LIVE debit, so a single substitution can never offset the contractor's dues
// twice. (The partial-unique index idx_cash_out_service_live is the DB backstop; this gives the clean,
// naming 409.)
// Tenancy Phase 3 — the service resolution + one-offset guard are tenant-scoped via repo, so a debit
// can only ever link a service in ITS OWN household, and the "already claimed" check only sees this
// tenant's live debits. finalize runs with ctx.req present (single POST/PUT + the batch loop pass req).
function cashOutServiceFinalize(values, { req, existing }) {
  const t = req.user.id;
  // Only an 'included' debit may carry a service link; 'extra' forces NULL (mirrors contract_stated_paise
  // so a stale link can't keep counting if the scope flips back).
  if (values.contract_scope !== 'included') { values.contract_service_id = null; return; }
  // undefined = the body did not send contractServiceId (the editable table doesn't) -> PRESERVE the
  // existing link on edit; on create there is no existing, so it's NULL (manual entry).
  let sid = values.contract_service_id;
  if (sid === undefined) sid = existing ? existing.contract_service_id : null;
  if (sid == null) { values.contract_service_id = null; return; }
  const svc = repo.contract.serviceLivePriced(t, sid);
  if (!svc) return { status: 400, error: 'That contract service was not found — pick a listed service, or type the amount directly.' };
  if (svc.price_paise == null) return { status: 400, error: 'That service has no price set, so it cannot be linked — add a price to it, or type the amount directly.' };
  const other = repo.contract.serviceClaimedByOther(t, sid, existing ? existing.id : -1);
  if (other) {
    return { status: 409, error: `That service is already linked to entry #${other.id} (${fmtRs(other.amount_paise)} on ${other.tx_date}). One service can offset only one debit — unlink it there first, or pick another service.` };
  }
  values.contract_service_id = sid;
}

// The Overview edit-lock gate is applied to cash-out's by-id writes via makeLedgerCrud's
// editGate option below (one chain: requireApiAuth, overviewEditGate, handler).
makeLedgerCrud({
  basePath: '/api/cash-out',
  alias: 'c', // the table alias used in CASH_OUT_SELECT — repo.crud scopes on c.tenant_id
  editGate: overviewEditGate,
  batch: true, // Phase 6B: POST /api/cash-out/batch — Save All in one round trip (both pages)
  auditField: 'by_user_id', // Phase 2: log who-paid changes on edit
  finalize: cashOutServiceFinalize,                    // Services phase (Part C/D): service link + guard
  afterWrite: (values, { req }) => saveLedgerCustom(req.user.id, values), // Part E: remember a custom ledger name
  table: 'cash_out',
  select: CASH_OUT_SELECT,
  listWhere: 'WHERE c.deleted_at IS NULL ORDER BY c.id ASC',
  byIdWhere: 'WHERE c.id = ?',
  // Part A — SQL-side search/filter columns (see repo.crud). Text search spans the remark + the two
  // custom names; ledger/sub are equality; date + amount are ranges (sargable, sentinel-padded).
  searchCols: { date: 'tx_date', amount: 'amount_paise', ledger: 'ledger_code', subledger: 'subledger_code', text: ['reason', 'ledger_custom_name', 'subledger_custom_name'] },
  shape: cashOutRow,
  columns: ['amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_stated_paise', 'contract_service_id'],
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

    // Phase 5E — reimbursement offset (Option C). contract_stated_paise = the contract's STATED
    // amount for this item; it reduces dues while the actual amount_paise stays recorded as real
    // spending. REQUIRED (positive paise) when 'included'; forced NULL when 'extra' so a stale
    // value can't keep counting if the scope flips back.
    let contractStatedPaise = null;
    if (contractScope === 'included') {
      contractStatedPaise = parsePaise(req.body.contractStatedRupees);
      if (contractStatedPaise === null) return { error: 'Enter the contract’s stated amount for this item (greater than 0, up to 2 decimals).' };
    }

    // Services phase (Part C/D) — the picked service id. The picker fills contractStatedRupees above;
    // this records WHICH service (provenance + the one-offset guard key). Manual entry stays valid: no
    // contractServiceId means no link. undefined (key absent, e.g. the editable table) tells finalize()
    // to PRESERVE the existing link on edit; null/'' clears it; a number is validated + guarded there.
    let contractServiceId; // undefined = not sent
    if ('contractServiceId' in req.body) {
      const raw = req.body.contractServiceId;
      if (raw == null || raw === '') contractServiceId = null;
      else { const n = Number(raw); if (!Number.isInteger(n) || n <= 0) return { error: 'Invalid service selection.' }; contractServiceId = n; }
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
        contract_stated_paise: contractStatedPaise,
        contract_service_id: contractServiceId, // finalize() resolves/guards this (may be undefined)
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
// headline ledger tag + an optional free-form amount + a REQUIRED stated amount +
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

const serviceRow = (s) => ({ id: s.id, name: s.name, pricePaise: s.price_paise }); // pricePaise null = unpriced

// Shape a contract row for the API: resolved headline ledger label, the REQUIRED stated amount, the
// OPTIONAL free-form amount, both dates, the scheduled payment-date list, the OPTIONAL company (Part F),
// the line-item services (Part A), and the informational REMAINDER (Part B): the stated total minus the
// sum of PRICED services. remainderPaise is SIGNED (may be negative) — the UI shows "remains"/"over"
// wording, never a bare minus, mirroring Phase 4's overpaid figure. Services never drive dues:
// price_of_contract_paise stays the single source of truth for owed.
const contractRow = (r) => {
  // Child fetches are scoped by the parent row's OWN tenant (r.tenant_id) — contractRow is only ever
  // handed a row already fetched via a tenant-scoped query (list/getLive/trash), so this stays isolated.
  const services = repo.contract.servicesFor(r.tenant_id, r.id);
  const servicesPricedTotalPaise = services.reduce((sum, s) => sum + (s.price_paise || 0), 0);
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
    statedAmountPaise: r.price_of_contract_paise, // REQUIRED stated amount (single source of truth for owed)
    dateSigned: r.date_signed || '',
    dateEnds: r.contract_end_date || '',
    paymentDates: repo.contract.payDatesFor(r.tenant_id, r.id),
    services: services.map(serviceRow),           // Part A: live line-item services
    servicesPricedTotalPaise,                     // Σ of PRICED services (informational)
    remainderPaise: (r.price_of_contract_paise || 0) - servicesPricedTotalPaise, // Part B: SIGNED remainder
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

const getContractRow = (tenantId, id) => repo.contract.getLive(tenantId, id);

// Columns written on contract create/update (id/timestamps/deleted_at excluded).
const CONTRACT_COLS = ['contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company'];
const COMPANY_MAX = 120; // Part F: optional company/firm name cap

// Validate + normalise a contract request body -> { values, paymentDates } or { error }.
// Required: contractorName, areaOfWork, a valid headline ledger, stated amount > 0,
// date signed. Optional: free-form amount, date ends, and 0..many payment dates.
function readContractBody(req) {
  const contractorName = str(req.body.contractorName).slice(0, CONTRACTOR_MAX);
  if (!contractorName) return { error: 'Contractor name is required.' };
  const areaOfWork = str(req.body.areaOfWork).slice(0, AREA_MAX);
  if (!areaOfWork) return { error: 'Area of work is required.' };

  const led = resolveLedger(req.body); // headline category (fixed-or-CUSTOM), shared rules
  if (led.error) return { error: led.error };

  const amount = parsePriceOptional(req.body.amountRupees); // optional free-form; blank -> null
  if (amount.error) return { error: amount.error };

  const statedAmountPaise = parsePaise(req.body.statedAmountRupees); // required > 0
  if (statedAmountPaise === null) return { error: 'Enter a valid stated contract amount greater than 0 (up to 2 decimals).' };

  const signed = parseIsoDate(req.body.dateSigned);
  if (signed.error) return { error: signed.error };
  if (!signed.date) return { error: 'Select the date the contract was signed.' };

  const ends = parseIsoDate(req.body.dateEnds); // optional; blank -> null
  if (ends.error) return { error: ends.error };

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
      price_of_contract_paise: statedAmountPaise,
      contract_end_date: ends.date,
      date_signed: signed.date,
      company: company || null,
    },
    paymentDates,
  };
}

// Replace a contract's scheduled payment-date children with a fresh list (tenant-scoped via repo).
const writePaymentDates = (tenantId, contractId, dates) => repo.contract.writePayDates(tenantId, contractId, dates);

// Contracts CRUD. Phase 5D: AT MOST ONE live contract (enforced by the idx_contract_single_live
// partial unique index). The path + the { contracts: [...] } response shape are UNCHANGED so the
// frontend fetch doesn't churn — it is simply always an array of 0 or 1. paymentDatesFor() is
// called once per returned row (contractRow); with the invariant that N+1 is now bounded at one
// contract, so it needs no batching/restructuring.
app.get('/api/contracts', requireApiAuth, (req, res) => {
  res.json({ contracts: repo.contract.list(req.user.id).map(contractRow) });
});

app.post('/api/contracts', requireApiAuth, (req, res) => {
  const v = readContractBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  // Tenancy Phase 3 (Part B.3) — the single-contract guard is now PER-TENANT: it only blocks a SECOND
  // contract in THE CALLER'S household. A second tenant creating their first contract is a clean 201,
  // not the old "a contract already exists" existence leak. (idx_contract_single_live_tenant backstops it.)
  if (repo.contract.liveCount(req.user.id) > 0) {
    return res.status(409).json({ error: 'A contract already exists — Plannr tracks a single contract. Edit the existing one instead of adding another (or delete it first).' });
  }
  const info = repo.contract.insert(req.user.id, CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
  writePaymentDates(req.user.id, info.lastInsertRowid, v.paymentDates);
  res.status(201).json({ ok: true, contract: contractRow(getContractRow(req.user.id, info.lastInsertRowid)) });
});

app.put('/api/contracts/:id', requireApiAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !getContractRow(req.user.id, id)) return res.status(404).json({ error: 'Contract not found.' });
  const v = readContractBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  repo.contract.update(req.user.id, id, CONTRACT_COLS, CONTRACT_COLS.map((c) => v.values[c]));
  writePaymentDates(req.user.id, id, v.paymentDates);
  res.json({ ok: true, contract: contractRow(getContractRow(req.user.id, id)) });
});

// ---------------------------------------------------------------------------
// Contract services (Services phase, Part A). A contract's line-item services: a NAME + an OPTIONAL
// price. Add / edit / soft-delete, nested under the parent contract so the id proves ownership.
// A service's ONLY job downstream is to supply cash_out.contract_stated_paise on the debit form —
// it is NOT a second offset mechanism and never enters the dues maths itself.
// ---------------------------------------------------------------------------
const SERVICE_NAME_MAX = 120;
const getServiceRow = (tenantId, id) => repo.contract.serviceLive(tenantId, id);
const getLiveServiceForContract = (tenantId, cid, sid) => repo.contract.serviceForContract(tenantId, cid, sid);

function readServiceBody(req) {
  const name = str(req.body.name).slice(0, SERVICE_NAME_MAX);
  if (!name) return { error: 'Service name is required.' };
  const price = parsePriceOptional(req.body.priceRupees); // blank -> null (unpriced; can't be picked on a debit)
  if (price.error) return { error: price.error };
  return { values: { name, price_paise: price.paise } };
}

app.post('/api/contracts/:id/services', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id);
  if (!Number.isInteger(cid) || !getContractRow(req.user.id, cid)) return res.status(404).json({ error: 'Contract not found.' });
  const v = readServiceBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  const info = repo.contract.insertService(req.user.id, cid, v.values.name, v.values.price_paise);
  res.status(201).json({ ok: true, service: serviceRow(getServiceRow(req.user.id, info.lastInsertRowid)) });
});

app.put('/api/contracts/:id/services/:sid', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id), sid = Number(req.params.sid);
  if (!Number.isInteger(cid) || !Number.isInteger(sid) || !getLiveServiceForContract(req.user.id, cid, sid)) return res.status(404).json({ error: 'Service not found.' });
  const v = readServiceBody(req);
  if (v.error) return res.status(400).json({ error: v.error });
  repo.contract.updateService(req.user.id, sid, v.values.name, v.values.price_paise);
  res.json({ ok: true, service: serviceRow(getServiceRow(req.user.id, sid)) });
});

app.delete('/api/contracts/:id/services/:sid', requireApiAuth, (req, res) => {
  const cid = Number(req.params.id), sid = Number(req.params.sid);
  if (!Number.isInteger(cid) || !Number.isInteger(sid) || !getLiveServiceForContract(req.user.id, cid, sid)) return res.status(404).json({ error: 'Service not found.' });
  // Soft-delete. A LIVE debit may still reference this now-deleted service (keeps its offset + the
  // provenance link); it simply stops being offered by the picker. No block — services are informational.
  repo.contract.softDeleteService(req.user.id, sid);
  res.json({ ok: true });
});

// Soft-delete a contract. Scheduled payment-date children are left in place (only
// surfaced via the contract).
app.delete('/api/contracts/:id', requireApiAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contract id.' });
  // Guard (Phase 4D): refuse while any LIVE contractor payment (in this tenant) references this contract.
  // Otherwise A/F (which iterate live contracts) drop the contract while B/D/pie (which iterate
  // live payments) keep its ₹ — you end up having paid toward a contract totalling ₹0, and the
  // Overview stops reconciling. Same shape as the two Recycle-Bin guards and /api/delete-account.
  const live = repo.contract.livePaymentsFor(req.user.id, id);
  if (live > 0) {
    return res.status(409).json({ error: `This contract has ${live} live contractor payment${live === 1 ? '' : 's'} recorded against it. Deleting it would leave ${live === 1 ? 'that payment' : 'those payments'} attributed to a contract that is gone (and unbalance the Overview), so it's blocked — delete or reassign ${live === 1 ? 'that payment' : 'those payments'} first, then delete the contract.` });
  }
  const info = repo.contract.softDelete(req.user.id, id); // tenant-scoped -> another tenant's id -> 404
  if (info.changes === 0) return res.status(404).json({ error: 'Contract not found.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Contractor Payments API (Phase 3). Money PAID to a contractor, each tied to a
// specific contract. A normal add/edit/soft-delete list via makeLedgerCrud. The
// ledger fields are an OPTIONAL DISPLAY tag; they do NOT drive dues math (confirmed under
// Option C — owed uses amount_paise + cash_out.contract_stated_paise, never a payment's ledger).
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
  alias: 'cp', // the table alias used in CONTRACTOR_PAYMENTS_SELECT — repo.crud scopes on cp.tenant_id
  table: 'contractor_payments',
  select: CONTRACTOR_PAYMENTS_SELECT,
  listWhere: 'WHERE cp.deleted_at IS NULL ORDER BY cp.id ASC',
  byIdWhere: 'WHERE cp.id = ?',
  shape: paymentRow,
  columns: ['contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'remarks'],
  validate: (req) => {
    // Contract required + must be a live contract IN THE CALLER'S tenant (repo scopes the check, so a
    // payment can never be pinned to another household's contract). No batch route here, so req.user exists.
    const contractId = Number(req.body.contractId);
    if (!Number.isInteger(contractId) || !repo.contract.existsLive(req.user.id, contractId)) {
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
// Tenancy Phase 3 (Part B.4) — the Recycle Bin routes through repo.trash, tenant-scoped. list/find/
// restore/hard-delete all take req.user.id first, so a CROSS-TENANT id is simply "not found" (404,
// never 403 — a 403 would confirm the row exists) and a cross-tenant restore/hard-delete changes 0 rows.
const TRASH_REPO = {
  cash_in:  repo.trash({ table: 'cash_in', select: CASH_IN_SELECT, alias: 'c' }),
  cash_out: repo.trash({ table: 'cash_out', select: CASH_OUT_SELECT, alias: 'c' }),
  loans:    repo.trash({ table: 'loans', select: LOANS_SELECT, alias: '' }),
  contract: repo.trash({ table: 'contract', select: 'SELECT * FROM contract', alias: '' }),
  contractor_payments: repo.trash({ table: 'contractor_payments', select: CONTRACTOR_PAYMENTS_SELECT, alias: 'cp' }),
};

// GET /api/trash — soft-deleted rows for all five tables (THIS tenant's), each shaped like the live
// list plus deletedAt, newest-deleted first.
app.get('/api/trash', requireApiAuth, (req, res) => {
  const trash = {};
  for (const t of TRASH_TABLES) {
    trash[t] = TRASH_REPO[t].listDeleted(req.user.id).map((r) => ({ ...TRASH_SHAPERS[t](r), deletedAt: r.deleted_at }));
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
  if (!Number.isInteger(id) || !TRASH_REPO[table].find(req.user.id, id)) return res.status(404).json({ error: 'That deleted item was not found.' });
  // Guard: a contractor payment must not go live under a still-deleted contract — otherwise a
  // live payment sits under a deleted contract, inflating Overview spend while the contract's
  // value stays out of the totals. Require the contract to be restored first. (Tenant-scoped.)
  if (table === 'contractor_payments') {
    const row = repo.contract.paymentContractId(req.user.id, id);
    const parent = repo.contract.deletedAt(req.user.id, row.contract_id);
    if (!parent || parent.deleted_at !== null) {
      return res.status(409).json({ error: 'Restore the parent contract first — this payment belongs to a contract that is still in the Recycle Bin.' });
    }
  }
  // Phase 5H — the single-live-contract invariant (idx_contract_single_live_tenant) is PER-TENANT.
  // Guard explicitly (per tenant): refuse restoring a contract while another is already live in THIS
  // household. Message style matches the two guards above and /api/delete-account.
  if (table === 'contract' && repo.contract.liveCount(req.user.id) > 0) {
    return res.status(409).json({ error: 'Another contract is already live — Plannr tracks a single contract. Delete the current one before restoring this from the Recycle Bin.' });
  }
  // Services phase (Part D) — a soft-deleted debit RELEASED its service (the partial-unique index only
  // counts live rows). If ANOTHER live debit has since CLAIMED that service, restoring this one would
  // make two live debits offset a single substitution — the DB index would raise a raw 500. Guard
  // explicitly with the same 409 shape: refuse, naming the claimant.
  if (table === 'cash_out') {
    const row = repo.contract.cashOutServiceId(req.user.id, id); // tenant-scoped
    if (row && row.contract_service_id != null) {
      const other = repo.contract.serviceClaimedByOther(req.user.id, row.contract_service_id, id);
      if (other) {
        return res.status(409).json({ error: `Can’t restore — its contract service is now linked to entry #${other.id} (${fmtRs(other.amount_paise)} on ${other.tx_date}). One service can offset only one debit. Unlink it there first, then restore.` });
      }
    }
  }
  TRASH_REPO[table].restore(req.user.id, id);
  res.json({ ok: true });
});

// DELETE /api/trash/:table/:id — permanent hard delete.
app.delete('/api/trash/:table/:id', requireApiAuth, (req, res) => {
  const table = trashTable(req);
  if (!table) return res.status(400).json({ error: 'Unknown table.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !TRASH_REPO[table].find(req.user.id, id)) return res.status(404).json({ error: 'That deleted item was not found.' });
  // Guard: contractor_payments.contract_id references contract(id) with NO ACTION (unlike
  // contract_payment_dates / contract_services, which CASCADE). Hard-deleting a contract that
  // any payment — live OR soft-deleted — still references would orphan/violate the FK, so
  // refuse and say so (modelled on the /api/delete-account guard). (Tenant-scoped count.)
  if (table === 'contract') {
    const n = repo.contract.paymentsForAny(req.user.id, id);
    if (n > 0) {
      return res.status(409).json({ error: `This contract still has ${n} contractor payment${n === 1 ? '' : 's'} referencing it (live or in the Recycle Bin). Permanently deleting it would orphan ${n === 1 ? 'that payment' : 'those payments'} — delete or restore ${n === 1 ? 'it' : 'them'} first.` });
    }
  }
  TRASH_REPO[table].hardDelete(req.user.id, id); // contract_payment_dates / contract_services children cascade
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Overview API (READ-ONLY analytics) + the optional overall budget. Logged-in
// only. Every figure is computed from LIVE (non-deleted) rows; money is INTEGER
// paise throughout (never float). No editing here — that is a later phase.
// ---------------------------------------------------------------------------

// Optional overall budget, stored as one settings row. NULL = unset.
function getBudgetPaise(tenantId) {
  const r = BUDGET_STMT.get(tenantId);
  if (!r || r.value == null || r.value === '') return null;
  const n = Number(r.value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

app.get('/api/budget', requireApiAuth, (req, res) => {
  res.json({ budgetPaise: getBudgetPaise(req.user.id) });
});

// Set (positive ₹) or clear (empty) the overall budget. Optional / non-blocking.
app.put('/api/budget', requireApiAuth, (req, res) => {
  const raw = req.body.budgetRupees;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'budget_paise', NULL) ON CONFLICT(tenant_id, key) DO UPDATE SET value = NULL").run(req.user.id);
    return res.json({ budgetPaise: null });
  }
  const paise = parsePaise(raw);
  if (paise === null) return res.status(400).json({ error: 'Enter a valid budget greater than 0 (up to 2 decimals).' });
  // Tenancy Phase 2 — the budget is per-tenant: upsert on (tenant_id, key) so one household's budget is
  // its own row and setting A's never touches B's. (Reads stay unfiltered in Phase 2 — see getBudgetPaise.)
  db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'budget_paise', ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value").run(req.user.id, String(paise));
  res.json({ budgetPaise: paise });
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
function computeOverview(tenantId, range) {
  const start = (range && range.start) || null;
  const end = (range && range.end) || null;
  const bounded = !!(start || end);              // any bound set -> range mode (dateless rows drop out)
  const lo = start || '0000-01-01', hi = end || '9999-12-31'; // open sentinels -> sargable col>=? AND col<=?

  // --- CUMULATIVE aggregates (Phase 6C) — computed in SQL, NO rows fetched, and NEVER range-scoped.
  // The reimbursement offset MUST stay cumulative: a date range must never zero it. NULL/0 stated is
  // excluded from the offset (SUM ignores NULL) and separately counted by the missing-offset check.
  const cum = repo.overview.cashoutCumulative(tenantId);    // one scan of THIS tenant's 'included' debits
  const includedOffset = cum.offset;                        // Σ contract_stated_paise ('included', >0)
  const missingOffset = { count: cum.missCount, amountPaise: cum.missSum }; // 'included' with NULL/0 offset

  // Live contract (single, Phase 5D). area_of_work + headline ledger label the owed row.
  const contractRows = repo.overview.contracts(tenantId);
  const liveContractIds = new Set(contractRows.map((c) => c.id));

  // paid grouped by contract_id (cumulative) — ONE aggregate feeds three things: the owed balance
  // (paidByContract), the cumulative paid total (over-offset check), and orphaned-payment detection
  // (groups whose contract is soft-deleted/missing). No payment rows are fetched for any of these.
  const paidByContract = new Map();
  let cumulativePaid = 0;
  const orphan = { count: 0, amountPaise: 0, contractIds: [] };
  for (const g of repo.overview.paidByContract(tenantId)) {
    paidByContract.set(g.contract_id, g.s);
    cumulativePaid += g.s;
    if (!liveContractIds.has(g.contract_id)) { orphan.count += g.c; orphan.amountPaise += g.s; orphan.contractIds.push(g.contract_id); }
  }

  // Per-contract dues + A/F — all CUMULATIVE (unaffected by the range). Phase 5D holds the live
  // contract count at 0 or 1, so the global reimbursement offset applies to that one contract.
  //   owed(C) = stated − Σ paid − Σ included offset   (RAW; negative = overpaid, never clamped)
  let totalContract = 0, owedToContractors = 0;
  const contracts = contractRows.map((c, idx) => {
    const stated = c.price_of_contract_paise || 0;
    const paid = paidByContract.get(c.id) || 0;
    // The offset isn't tied to a contract id (debits carry only a Yes/No flag); with one live
    // contract it belongs to it. Apply to the single (idx 0) contract's owed.
    const offset = idx === 0 ? includedOffset : 0;
    const owed = stated - paid - offset;
    totalContract += stated; owedToContractors += owed;
    return {
      id: c.id,
      contractorName: c.contractor_name || '',
      areaOfWork: c.area_of_work || '',
      ledger: c.ledger_code ? ledgerLabel(c.ledger_code, c.subledger_code, c.ledger_custom_name, c.subledger_custom_name) : '',
      statedPaise: stated, paidPaise: paid, offsetPaise: offset, owedPaise: owed,
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
  const outs = bounded ? repo.overview.outsRange(tenantId, lo, hi) : repo.overview.outsAll(tenantId);
  const payments = bounded ? repo.overview.paymentsRange(tenantId, lo, hi) : repo.overview.paymentsAll(tenantId);
  for (const r of outs) {
    spentBySelf += r.amount_paise; // C (range)
    rollup(r.by_type, r.ledger_code, r.subledger_code, r.subledger_custom_name, r.amount_paise);
  }
  for (const p of payments) {
    paidToContractors += p.amount_paise; // B (range)
    rollup('other', p.ledger_code || CUSTOM_CODE, p.subledger_code, p.subledger_custom_name, p.amount_paise);
  }

  const loanReceived = repo.overview.loansSum(tenantId).s; // E (cumulative)
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

  // Reconciliation detections were computed as CUMULATIVE aggregates at the top (Phase 6C):
  //  · orphan (Phase 4D) — payments whose parent contract is soft-deleted/missing: their ₹ is still
  //    in B/D/pie but not offset in A/F. From OV_PAID_BY_CONTRACT_STMT groups (contract_id not live).
  //  · missingOffset (Phase 5E) — 'included' debits with a NULL/0 offset (does nothing). From
  //    OV_MISSING_OFFSET_STMT. Reachable via a pre-Phase-5 backup import or direct SQL.
  //  · overOffset (Phase 5E) — payments + included offset exceed the contract value.
  // All three flag-and-log only; NO figure is adjusted (same discipline as Phase 4D).
  const appliedAgainstContract = cumulativePaid + includedOffset;
  const overOffset = { over: totalContract > 0 && appliedAgainstContract > totalContract, contractPaise: totalContract, appliedPaise: appliedAgainstContract, excessPaise: Math.max(0, appliedAgainstContract - totalContract) };

  if (!splitSumsToTotal || !mainsSumToTotal || !subsSumToMains) {
    console.error('Overview reconciliation failed', { splitSumsToTotal, mainsSumToTotal, subsSumToMains });
  }
  if (orphan.count > 0) {
    console.warn(`Overview reconciliation: ${orphan.count} live contractor payment(s) totalling ${orphan.amountPaise} paise reference a soft-deleted or missing contract (contract ids: ${orphan.contractIds.join(', ')}). Counted in B/D/pie but not offset in A/F — figures reported AS-IS, not adjusted. Restore or reassign those payments' contract to rebalance.`);
  }
  if (missingOffset.count > 0) {
    console.warn(`Overview reconciliation: ${missingOffset.count} 'included' debit(s) totalling ${missingOffset.amountPaise} paise have a NULL or zero contract_stated_paise — a reimbursement offset that does nothing (dues don't drop for that spend). Likely a pre-Phase-5 backup import or direct SQL. Set the contract's stated amount on those debits to rebalance. Reported AS-IS.`);
  }
  if (overOffset.over) {
    console.warn(`Overview reconciliation: payments + included offsets (${overOffset.appliedPaise} paise) exceed the contract value (${overOffset.contractPaise} paise) by ${overOffset.excessPaise} paise — over-offset. owed is reported unclamped (negative = overpaid), not adjusted.`);
  }

  return {
    budgetPaise: getBudgetPaise(tenantId),
    ledgers,
    // Money model (A–F). A/E/F are cumulative; B/C/D reflect the selected date range.
    money: {
      totalContractPaise: totalContract,        // A (cumulative)
      paidToContractorsPaise: paidToContractors, // B (range)
      spentBySelfPaise: spentBySelf,            // C (range)
      totalSpentPaise: totalSpent,              // D = B + C (range)
      loanReceivedPaise: loanReceived,          // E (cumulative)
      owedToContractorsPaise: owedToContractors, // F = stated − Σ paid − Σ included offset (cumulative)
    },
    contracts, // per-contract: { id, contractorName, statedPaise, paidPaise, offsetPaise, owedPaise }
    upcomingPayments: computeUpcomingPayments(tenantId), // Part C — scheduled dates forward + soft overdue
    // Phase 4D + 5E — reconciliation status (additive, backward-compatible; the frontend may
    // surface it later). ok=false means the summary doesn't self-reconcile. Every sub-object is a
    // flag over data reported AS-IS — nothing here adjusts a figure.
    reconciliation: {
      ok: splitSumsToTotal && mainsSumToTotal && subsSumToMains && orphan.count === 0 && missingOffset.count === 0 && !overOffset.over,
      orphanedContractorPayments: orphan,          // { count, amountPaise, contractIds }   (Phase 4D)
      includedDebitsMissingOffset: missingOffset,  // { count, amountPaise }                 (Phase 5E)
      overOffset: overOffset,                      // { over, contractPaise, appliedPaise, excessPaise } (Phase 5E)
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
function computeUpcomingPayments(tenantId) {
  const today = istDateStamp();
  const out = [];
  for (const c of repo.contract.list(tenantId)) { // one live contract per tenant, but loop is correct either way
    for (const d of repo.contract.payDatesFor(tenantId, c.id)) {
      const daysRemaining = daysBetweenIso(today, d);
      const paidOnDate = repo.contract.paymentOnDate(tenantId, c.id, d);
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
  res.json(computeOverview(req.user.id, { start: s.date, end: e.date }));
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

// Amber-family palette (same idea as the on-screen pie); Custom = deep amber.
const PDF_PALETTE = ['#f59e0b', '#fbbf24', '#b45309', '#d97706', '#fcd34d', '#92400e', '#ef8a4b',
  '#eab308', '#a16207', '#f4a06a', '#c2703d', '#facc15', '#7c3f12', '#fdba74', '#9a6a2f', '#e0a800',
  '#ffcf70', '#8a5a2b', '#f6b352', '#6f4518'];
function pdfSlices(o) {
  return (o.ledgers || []).filter((L) => L.totalPaise > 0).map((L) => ({
    label: L.name, value: L.totalPaise,
    color: L.code === CUSTOM_CODE ? '#8a5a2b' : PDF_PALETTE[Math.max(0, LEDGERS.findIndex((x) => x.code === L.code)) % PDF_PALETTE.length],
  }));
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
    // Phase 5-follow-up: Contract Stated column — the reimbursement offset (paise) for 'included'
    // rows, dash for 'extra'. Right-aligned via the existing class="num" convention. The table is
    // width:100% / table-layout:auto on A4 (12mm margins ≈ 186mm), and the two numeric columns are
    // nowrap, so this 8th column shrinks the wrappable By/Ledger/Remark rather than overflowing.
    return '<h2>Transactions</h2><table><thead><tr><th class="num">#</th><th>Date</th><th class="num">Amount</th><th>By</th><th>Ledger</th><th>Remark</th><th>Contract Included</th><th class="num">Contract Stated</th></tr></thead><tbody>' +
      rows.map((e, i) => `<tr><td class="num">${i + 1}</td><td>${e.txDate ? pdfEsc(fmtDatePdf(e.txDate)) : '—'}</td><td class="num">${fmtRs(e.amountPaise)}</td><td>${pdfEsc(e.by)}</td><td>${pdfEsc(e.ledger)}</td><td>${e.reason ? pdfEsc(e.reason) : '—'}</td><td>${incl(e.contractScope)}</td><td class="num">${e.contractScope === 'included' && e.contractStatedPaise != null ? fmtRs(e.contractStatedPaise) : '—'}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td colspan="2">Total (${rows.length})</td><td class="num">${fmtRs(total)}</td><td colspan="5"></td></tr></tfoot></table>`;
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
async function generateOverviewPdf({ tenantId, part = 'full', theme = 'light', range = { start: null, end: null } } = {}) {
  if (tenantId == null) throw new Error('generateOverviewPdf requires a tenantId'); // every render is per-tenant
  const o = computeOverview(tenantId, range);
  const inR = (d) => { if (!range.start && !range.end) return true; if (d == null) return false; if (range.start && d < range.start) return false; if (range.end && d > range.end) return false; return true; };
  const rows = LEDGER_CRUDS.cash_out.list(tenantId).map(cashOutRow).filter((r) => inR(r.txDate)); // tenant-scoped
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
    const pdf = await generateOverviewPdf({ tenantId: req.user.id, part, theme, range: { start: s.date, end: e.date } });
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
// Phase 2 — one-request health check for the windowless case. Auth-gated. Plus server start
// time + CSP mode and recent auth activity.
app.get('/api/health', requireApiAuth, (req, res) => {
  // Part D — auth-detection summary + recent events for the CALLER's tenant only (read by req.user.id).
  // The events are the caller's own account activity; isolation-harness verified they don't leak.
  const events = readAuthEvents(req.user.id);
  const activeSessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > datetime('now')").get(req.user.id).n;
  res.json({
    serverStart: SERVER_START.toISOString(),
    csp: csp.REPORT_ONLY ? 'report-only' : 'enforcing',
    auth: {
      ...authSummary(req.user.id),        // lastLogin { atIST, ip } + failedSinceLastLogin
      activeSessions,
      recentEvents: events.slice(-25).reverse(), // most-recent first
    },
  });
});

// ---------------------------------------------------------------------------
// Static frontend (with a server-side auth guard on the protected pages)
// ---------------------------------------------------------------------------

// Server-side page guard: only a request carrying a valid session may receive a
// protected page. Reuses the SAME currentUser() check as /api/me — no second
// session logic. On failure it issues a plain 302 browser redirect to login.
function requireAuth(req, res, next) {
  if (currentUser(req)) return next();
  res.redirect('/login.html');
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
const BACKUP_TABLES = ['contract', 'contract_services', 'contract_payment_dates', 'contractor_payments', 'loans', 'settings', 'cash_in', 'cash_out'];
// The AUTOINCREMENT tables among them (settings is key/value, not autoincrement).
const BACKUP_AUTOINC = ['contract', 'contract_services', 'contract_payment_dates', 'contractor_payments', 'loans', 'cash_in', 'cash_out'];

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
const IMPORT_OWNED_TABLES = ['cash_out', 'contract_services', 'contract_payment_dates', 'contractor_payments', 'contract', 'cash_in', 'loans', 'settings'];

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
  contract: ['id', 'contractor_name', 'area_of_work', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'amount_paise', 'price_of_contract_paise', 'contract_end_date', 'date_signed', 'company', 'created_at', 'updated_at', 'deleted_at'],
  contract_services: ['id', 'contract_id', 'name', 'price_paise', 'created_at', 'updated_at', 'deleted_at'],
  contract_payment_dates: ['id', 'contract_id', 'pay_date', 'created_at'],
  contractor_payments: ['id', 'contract_id', 'pay_date', 'amount_paise', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'remarks', 'created_at', 'updated_at', 'deleted_at'],
  loans: ['id', 'amount_paise', 'bank_name', 'interest_rate', 'tenure', 'created_at', 'updated_at', 'deleted_at'],
  settings: ['key', 'value'],
  cash_in: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'reason', 'created_at', 'updated_at', 'deleted_at'],
  cash_out: ['id', 'amount_paise', 'tx_date', 'by_type', 'by_user_id', 'by_label', 'ledger_code', 'subledger_code', 'ledger_custom_name', 'subledger_custom_name', 'reason', 'contract_scope', 'contract_stated_paise', 'contract_service_id', 'created_at', 'updated_at', 'deleted_at'],
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
function buildBackup(tenantId, { includeContacts = false } = {}) {
  const tables = {};
  // Tenancy Phase 3 (Part B.9) — export contains ONLY the caller's tenant (repo.backup.exportTable is
  // scoped `WHERE tenant_id = ?`, settings included). B's export can never carry A's rows.
  for (const t of BACKUP_TABLES) tables[t] = repo.backup.exportTable(tenantId, t);
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
    if ((t === 'contract_payment_dates' || t === 'contractor_payments' || t === 'contract_services') && T[t] === undefined) continue; // optional (older backups predate them)
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
    contractIds.add(r.id);
  }
  // Services phase (Part A) — contract_services rows (optional table). Collect valid ids so a debit's
  // contract_service_id can be checked to resolve inside the file.
  const serviceIds = new Set();
  for (const r of (T.contract_services || [])) {
    if (!isInt(r.id)) return { error: 'contract_services: a row has a non-integer id.' };
    if (!isInt(r.contract_id) || !contractIds.has(r.contract_id)) return { error: `contract_services: contract_id ${JSON.stringify(r.contract_id)} is not present in the backup's contracts.` };
    if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'contract_services: name must be a non-empty string.' };
    if (!optInt(r.price_paise)) return { error: 'contract_services: price_paise must be integer paise or null.' };
    serviceIds.add(r.id);
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
    // Phase 5E: contract_stated_paise — optional integer paise or null. Absent on pre-Phase-5
    // backups (undefined -> imported as NULL, which is correct); an 'included' row that lands with
    // NULL/0 is surfaced later by the reconciliation "missing offset" flag, NOT rejected here, so
    // old backups still restore. Only reject a present-but-wrong type.
    if (!optInt(r.contract_stated_paise)) return { error: 'cash_out: contract_stated_paise must be an integer (paise) or null.' };
    // Services phase (Part C/D): contract_service_id — optional. Absent on pre-change backups
    // (undefined -> NULL). If present, it must resolve to a service inside the file (referential
    // sanity); the DB's partial-unique index is the ultimate one-service-one-offset backstop on insert.
    if (!(r.contract_service_id == null || (isInt(r.contract_service_id) && serviceIds.has(r.contract_service_id)))) return { error: `cash_out: contract_service_id ${JSON.stringify(r.contract_service_id)} is not present in the backup's contract_services.` };
  }
  return { ok: true };
}

// EXPORT: one JSON object (schema version + timestamp + every ledger table as
// arrays of full rows, incl. soft-deleted + the budget/settings). The frontend
// downloads it via fetch, but Content-Disposition names it for direct hits too.
app.get('/api/backup/export', requireApiAuth, (req, res) => {
  // Phase 8B — contacts (Gmail + WhatsApp numbers) are excluded unless the user opts in on the Data
  // page (?includeContacts=1). Default omits them so a shared/stored backup carries no personal data.
  const includeContacts = req.query.includeContacts === '1';
  const backup = buildBackup(req.user.id, { includeContacts });
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
    fs.writeFileSync(snapPath, JSON.stringify(buildBackup(req.user.id, { includeContacts: true }), null, 2)); // local rollback file — keep contacts (this tenant only)
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
    // Tenancy Phase 3 (Part B.9) — the teardown clears ONLY THE IMPORTING TENANT'S rows (repo.backup.
    // deleteTenantRows is `DELETE FROM <t> WHERE tenant_id = ?`), CHILDREN-FIRST (IMPORT_OWNED_TABLES).
    // Another household's data is NEVER touched — the old global `DELETE FROM <t>` would have wiped
    // everyone. users/sessions/edit_locks are not owned. Settings is NOT cleared (absent keys keep the
    // target's value); present keys are UPSERTed below.
    for (const t of IMPORT_OWNED_TABLES) { if (t === 'settings') continue; if (existingTables.has(t)) repo.backup.deleteTenantRows(req.user.id, t); }
    // NO global sqlite_sequence reset here (unlike the old global import). ids are shared across
    // tenants, so resetting the counter would let a NEW row reuse another tenant's id. The importing
    // tenant's own ids were just freed by the teardown above, so re-inserting them collides with no
    // one; the AUTOINCREMENT high-water mark is left as SQLite maintains it (never reused).

    for (const t of BACKUP_TABLES) {
      // Settings is UPSERTed (not cleared+inserted), owned by the importing tenant (composite key).
      if (t === 'settings') {
        for (const r of (T.settings || [])) repo.backup.upsertSetting(req.user.id, r.key, r.value === undefined ? null : r.value);
        continue;
      }
      // Every non-settings BACKUP_TABLE is a tenant table. Stamp tenant_id = the importing user (the
      // whole restored ledger is re-owned by that tenant), so a foreign/pre-tenancy backup imports
      // cleanly. ids are preserved (FK integrity within the file); a colliding id -> the whole
      // transaction rolls back, leaving every tenant byte-identical.
      const cols = BACKUP_COLS[t];
      for (const r of (T[t] || [])) {
        const vals = cols.map((col) => {
          let val = r[col];
          if (col === 'by_user_id' && val != null && !userIds.has(val)) { val = null; remappedUsers++; }
          return val === undefined ? null : val;
        });
        repo.backup.insertRow(req.user.id, t, cols, vals);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if (!IS_PROD) console.error('Backup import failed, rolled back:', e);
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
      const policy = csp.cspFor(path.basename(filePath)); // Phase 8C — per-page inline-hash CSP
      if (policy) res.setHeader(csp.HEADER_NAME, policy);
    }
  },
}));

// Serve a static HTML page from public/ (shared by the page routes below). Same no-cache as the
// raw .html above — these ARE the same files, just reached via clean URLs (/overview vs
// /overview.html) — so the shell is never served stale from either path.
const sendPage = (res, file) => {
  const policy = csp.cspFor(file); // Phase 8C — same per-page CSP as the raw .html path
  const headers = { 'Cache-Control': 'no-cache' };
  if (policy) headers[csp.HEADER_NAME] = policy;
  res.sendFile(path.join(__dirname, 'public', file), { headers });
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
// Graceful shutdown: on a normal stop (e.g. Ctrl+C), checkpoint the WAL into
// the main DB file and close it, so data/plannr.db is self-contained and safe
// to copy. Without this, the newest writes stay stranded in data/plannr.db-wal
// — which is how a copy of plannr.db alone can look almost empty. (On a hard
// kill the handler won't run, but SQLite still recovers from the WAL on the
// next open, so no data is lost either way.)
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
  // 3) Checkpoint the WAL into the main file, then close the DB (unchanged behaviour).
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) { console.error('DB shutdown error:', e); }
  clearTimeout(hardKill);
  console.log('[shutdown] browsers closed, WAL checkpointed — exiting cleanly.');
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

// Phase 8A/9 — sweep expired sessions at startup. INTERNAL boot work, kept ungated so an imported
// test process runs it too (a no-op on a fresh test DB; clears stale rows on the live app).
const swept = cleanupExpiredSessions();
if (swept) console.log(`[sessions] removed ${swept} expired session(s) on boot.`);

// Phase 9 — export the Express app so the test suite can start it on an ephemeral port WITHOUT any
// of the external side effects below (no listener on :3000, no cron).
// Test seam: clear the in-memory auth limiters (per-IP rate limit + per-(ip,user) lockout) so tests
// sharing one process don't leak brute-force state between cases. No effect on production behaviour.
app._resetAuthLimits = () => { rateBuckets.clear(); loginFails.clear(); };
app._recordUnknownLoginFailure = recordUnknownLoginFailure; // Part D follow-up — fast bounded-ring test seam
app._readUnknownLoginFailures = readUnknownLoginFailures;
app._assertImportOwnershipComplete = assertImportOwnershipComplete; // Phase 9: exercised by schema tests
app._closePdfBrowser = closeIdlePdfBrowser; // Phase 9: tests that hit /overview warm Playwright; teardown closes it
app._pdfBrowserActive = () => _pdfBrowserPromise !== null; // Phase 10A: read-only — is a PDF browser warmed?
app._watchStopSentinel = watchStopSentinel; // Phase 11B: test that a sentinel file routes into the same stop callback as SIGINT
// Phase 10G — the exact HTML page.pdf() rasterizes, for rendering the table to an image in tests.
// Tenancy Phase 3 — REQUIRES tenantId: this is the authoritative composition path the isolation harness
// byte-searches (the endpoint's compressed stream is a weaker check), so it must be tenant-scoped.
app._overviewPdfHtml = ({ tenantId, part = 'full', theme = 'light', range = { start: null, end: null } } = {}) => {
  if (tenantId == null) throw new Error('_overviewPdfHtml requires a tenantId');
  const o = computeOverview(tenantId, range);
  const inR = (d) => { if (!range.start && !range.end) return true; if (d == null) return false; if (range.start && d < range.start) return false; if (range.end && d > range.end) return false; return true; };
  const rows = LEDGER_CRUDS.cash_out.list(tenantId).map(cashOutRow).filter((r) => inR(r.txDate));
  return buildOverviewPdfHtml(part, o, rows, range, theme);
};
// Tenancy Phase 3 (Part A) — the enforcement backstop. Placed at the END of synchronous setup so
// EVERY repo statement (incl. the makeLedgerCrud/trash factories and the column-dependent ones
// pre-built by configure) is registered before the scan runs. Fails module load — every boot AND
// every test import — if any repo statement touching a tenant table lacks a tenant_id predicate.
repo.configure({ contractCols: CONTRACT_COLS, backupTables: BACKUP_TABLES, backupCols: BACKUP_COLS });
repo.assertTenantScoped();

module.exports = app;

// EXTERNAL side effects — the LAN listener, cron scheduling, and the process signal handlers — run
// ONLY when started directly (`node server.js`), NEVER when the app is imported (node --test). This
// is what makes the suite structurally unable to schedule a real send. `npm start` is unchanged:
// there, require.main === module.
if (require.main === module) {
  let sigints = 0;
  process.on('SIGINT', () => {
    if (++sigints >= 2) {
      // Phase 9 (Part E): the force-exit bypasses shutdown()'s graceful close (WAL checkpoint, PDF
      // browser cleanup). Warn loudly.
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
    // Phase 10A — make the active CSP mode visible on every start. The default is enforcing and the
    // suite asserts that, but PLANNR_CSP_REPORT_ONLY is an env flag — a forgotten override would leave
    // production unprotected with every test still green, so log it (alarmingly, when not enforced).
    if (csp.REPORT_ONLY) console.warn('[csp] REPORT-ONLY — policy NOT enforced (PLANNR_CSP_REPORT_ONLY is set). Unset it in production.');
    else console.log('[csp] enforcing.');
  });
}
