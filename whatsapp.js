// WhatsApp delivery channel for the Daily Report — a single long-lived
// whatsapp-web.js client, initialised once at server startup and kept connected
// in the background (mirrors how the email scheduler stays resident).
//
// It reuses the session already linked by whatsapp-login.js (LocalAuth in
// ./.wwebjs_auth), so on startup it reconnects automatically with NO QR scan.
// If the session is missing/invalid a `qr` event fires — we DON'T print it here
// (headless server); we log a clear line telling the operator to re-run
// whatsapp-login.js. Nothing in here ever throws into the server: a failed
// init or send is logged and reported, never fatal. Session credentials live
// only on disk under .wwebjs_auth and are never logged or put in an error string.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// SAME dir whatsapp-login.js linked. PLANNR_WWEBJS_AUTH overrides it for ISOLATED testing only
// (so a destructive shutdown test never touches the real linked session); prod leaves it unset.
const SESSION_DIR = process.env.PLANNR_WWEBJS_AUTH || path.join(__dirname, '.wwebjs_auth');
const CACHE_DIR = path.join(__dirname, '.wwebjs_cache');  // whatsapp-web.js caches one HTML per WA Web version
const CACHE_KEEP = 2;                                     // only the newest is ever used; keep a small margin
const SNAPSHOT_DIR = path.join(__dirname, '.wwebjs_auth_snapshot'); // local recovery copy of the linked session

// Mirror the linked session into a LOCAL snapshot dir so a corrupted store is a folder-restore
// instead of a QR rescan from the spare phone (repeated re-linking is the ban risk). FULL copy on
// purpose: a cache-pruned copy does NOT restore (verified). NEVER throws into the app; gitignored;
// its contents are never printed or copied outside the project.
//
// COMPLETENESS: robocopy /MIR SILENTLY SKIPS files the live browser holds locked — the
// WhatsApp IndexedDB LevelDB (the session state itself) among them — and still exits "success-ish"
// (code 11). So a snapshot taken while the browser is running is INCOMPLETE by definition and would
// not restore. The guard: while the browser is LIVE we refuse to overwrite an existing COMPLETE
// snapshot with an incomplete one (we'd only replace a known-good copy with a useless one); we take a
// live copy only to BOOTSTRAP when no complete one exists yet. A COMPLETE snapshot is possible only
// once the browser is CLOSED — taken on the clean-shutdown path. Completeness is recorded in a sibling
// marker file (next to the dir, so robocopy /PURGE can't delete it) holding { complete, code, at }.
const markerPath = (dst) => dst + '.state.json';
function readSnapshotMarker(dst = SNAPSHOT_DIR) { try { return JSON.parse(fs.readFileSync(markerPath(dst), 'utf8')); } catch { return null; } }
function snapshotIsComplete(dst = SNAPSHOT_DIR) { const m = readSnapshotMarker(dst); return !!(m && m.complete === true); }
function writeSnapshotMarker(dst, complete, code) {
  try { fs.writeFileSync(markerPath(dst), JSON.stringify({ complete: !!complete, code, at: new Date().toISOString() }, null, 2)); } catch { /* best-effort */ }
}
// Pure policy — decide whether to run the mirror given (browser closed?) and (a complete copy exists?).
function snapshotDecision({ browserClosed, existingComplete }) {
  if (browserClosed) return { action: 'run', reason: 'browser closed — taking a COMPLETE snapshot' };
  if (existingComplete) return { action: 'skip', reason: 'keeping the existing COMPLETE snapshot (a live browser can only make an incomplete copy — refusing to clobber the good one)' };
  return { action: 'run', reason: 'no complete snapshot yet — bootstrapping an INCOMPLETE live copy until the next clean shutdown' };
}
// Returns a Promise that resolves when the mirror (or the decision to skip) is done. On-ready callers
// don't await it; the shutdown path DOES (bounded by shutdown()'s hard-kill). `src`/`dst` default to
// the real dirs; a test can point them at throwaway dirs (the isolated-test skip only applies to the
// real recovery dir, so those tests still exercise the real robocopy path).
function snapshotSession({ browserClosed = false, src = SESSION_DIR, dst = SNAPSHOT_DIR } = {}) {
  if (process.env.PLANNR_WWEBJS_AUTH && dst === SNAPSHOT_DIR) return Promise.resolve({ skipped: 'isolated-test' });
  const decision = snapshotDecision({ browserClosed, existingComplete: snapshotIsComplete(dst) });
  if (decision.action === 'skip') {
    console.log(`[whatsapp] session snapshot skipped — ${decision.reason}.`);
    return Promise.resolve({ skipped: 'protect-complete', reason: decision.reason });
  }
  console.log(`[whatsapp] session snapshot — ${decision.reason}…`);
  return new Promise((resolve) => {
    try {
      const rc = spawn('robocopy', [src, dst, '/MIR', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, stdio: 'ignore' });
      rc.on('close', (code) => {
        const complete = !!browserClosed && code < 8; // only a browser-CLOSED copy with no skipped files is complete
        writeSnapshotMarker(dst, complete, code);
        if (complete) console.log(`[whatsapp] session snapshot refreshed — COMPLETE (robocopy code ${code}); marked good.`);
        else if (browserClosed) console.error(`[whatsapp] session snapshot at shutdown returned robocopy code ${code} (>=8) — marked INCOMPLETE; will retry next clean shutdown.`);
        else console.warn(`[whatsapp] session snapshot bootstrapped while browser LIVE — INCOMPLETE by design (robocopy code ${code}); a COMPLETE copy will replace it at the next clean shutdown.`);
        resolve({ code, complete });
      });
      rc.on('error', (e) => { console.error('[whatsapp] session snapshot skipped (ignored):', (e && e.message) || e); resolve({ error: true }); });
    } catch (e) { console.error('[whatsapp] session snapshot skipped (ignored):', (e && e.message) || e); resolve({ error: true }); }
  });
}

// whatsapp-web.js writes a new .wwebjs_cache/<version>.html every time WhatsApp Web bumps its version
// and NEVER removes the old ones, so the dir grows ~578KB per bump (it tripled during Phase 7). Only
// the newest version is ever loaded, so on boot we keep the newest CACHE_KEEP and delete the rest,
// logging what went — silent unbounded growth can't creep back. Safe: never touches .wwebjs_auth
// (the session), tolerant of a missing cache dir (first-ever run) and of individual unlink failures.
function pruneVersionCache() {
  let entries;
  try { entries = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.html')); }
  catch { return; } // no cache dir yet — nothing to prune
  if (entries.length <= CACHE_KEEP) return;
  const byNewest = entries
    .map((f) => { const p = path.join(CACHE_DIR, f); try { return { f, p, m: fs.statSync(p).mtimeMs, s: fs.statSync(p).size }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m);
  const remove = byNewest.slice(CACHE_KEEP);
  let bytes = 0, n = 0;
  for (const { p, s } of remove) { try { fs.unlinkSync(p); bytes += s; n++; } catch { /* ignore */ } }
  if (n) console.log(`[whatsapp] pruned web-version cache: removed ${n} old file(s) (${(bytes / 1024 / 1024).toFixed(1)} MB), kept newest ${CACHE_KEEP}.`);
}

let client = null;
let ready = false;      // true once the client has connected and is usable
let everReady = false;  // Phase 11A — did we reach a good live session THIS run? gates the shutdown snapshot
let lastError = null;   // short, non-sensitive reason the channel is down (for logs)

// Phase 8-fix: init "settled" tracking so a shutdown DURING initialization waits for the client to
// reach a TERMINAL state (ready / qr / auth_failure / disconnected) before closing the browser —
// so Chromium is never killed while whatsapp-web.js is mid-write to the LocalAuth session store
// (killing mid-write corrupts it and forces a QR next boot). Bounded by a grace timeout in destroy().
let settled = false;
let settleWaiters = [];
function markSettled() { settled = true; const w = settleWaiters; settleWaiters = []; for (const r of w) r(); }
function waitForSettle(ms) {
  if (settled) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    settleWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}
const SETTLE_GRACE_MS = 10000; // longest we wait for init to settle before closing anyway
const CLOSE_TIMEOUT_MS = 6000; // longest we wait for a graceful browser close before a direct fallback

// Digits-only form for whatsapp-web.js (it wants the number without a leading +).
const digits = (n) => String(n == null ? '' : n).replace(/\D/g, '');

// Part B — mask a recipient number for LOGS: keep the leading country/first digits and the last 4,
// hide the middle (+9198****1427). Identifies a recipient enough to debug a failed send without
// persisting the full number to disk (Phase 8 stripped contacts from backups; the logs mustn't undo it).
function maskPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const plus = s.startsWith('+') ? '+' : '';
  const d = s.replace(/\D/g, '');
  if (d.length <= 4) return plus + '****';
  if (d.length <= 8) return plus + d.slice(0, 2) + '****' + d.slice(-2);
  return plus + d.slice(0, 4) + '****' + d.slice(-4);
}

// ── Part C: a remote logout must not crash the server ───────────────────────────────────────────────
// Everything else works fine without WhatsApp, so a device logout must NEVER take the process down.
let loggingOut = false;         // true from the start of a logout until a grace period after cleanup
let crashGuardInstalled = false;

// Only a genuine remote logout should clear the session — a network/socket-state disconnect must not.
// whatsapp-web.js already enforces this (it calls authStrategy.logout() ONLY for reason 'LOGOUT';
// state disconnects go through authStrategy.disconnect(), which we leave as its no-op). This mirror is
// for our own 'disconnected' logging + the tests.
function shouldCleanupOnDisconnect(reason) { return reason === 'LOGOUT'; }

// Recursively remove a directory, TOLERATING per-file failures — a file the browser still holds is
// skipped, not fatal, instead of aborting the whole delete on the first one like fs.rm(recursive).
// Returns true iff the target is fully gone afterwards. Never throws.
function rmTolerant(target) {
  let st;
  try { st = fs.lstatSync(target); } catch { return true; } // already absent
  if (st.isDirectory()) {
    let names = [];
    try { names = fs.readdirSync(target); } catch { /* can't list — leave it */ }
    for (const name of names) rmTolerant(path.join(target, name));
    try { fs.rmdirSync(target); } catch { /* still non-empty (a locked child survived) — leave it */ }
  } else {
    try { fs.unlinkSync(target); } catch { /* locked/busy — skip this file, keep going */ }
  }
  try { return !fs.existsSync(target); } catch { return false; }
}

// Ordered, never-throwing logout cleanup, installed as LocalAuth.logout so the library awaits THIS in
// place of its own unsafe rm. Close the browser FIRST (releases the Windows file locks that caused the
// EBUSY half-delete), THEN remove the session dir tolerantly. If it can't be fully cleared, say the dir
// is in an unknown state and keep serving — WhatsApp is disabled until a re-link, nothing else is hit.
// destroyFn/dir are injectable for tests.
async function handleRemoteLogout({ destroyFn = destroy, dir = SESSION_DIR } = {}) {
  loggingOut = true;
  try {
    console.error('[whatsapp] remote logout detected — closing the browser BEFORE touching the session (avoids the EBUSY half-delete).');
    try { await destroyFn(); } catch (e) { console.error('[whatsapp] browser close during logout errored (continuing):', (e && e.message) || e); }
    const gone = rmTolerant(dir);
    if (gone) console.log('[whatsapp] session cleared after logout — re-link with `node whatsapp-login.js` to use WhatsApp again. The rest of Plannr is unaffected.');
    else console.error('[whatsapp] session directory is in an UNKNOWN state (some files could not be removed) — a re-link (`node whatsapp-login.js`) will be needed; delete .wwebjs_auth manually if it persists. Server continues; only WhatsApp is affected.');
  } catch (e) {
    console.error('[whatsapp] logout cleanup error (ignored — server keeps running):', (e && e.message) || e);
  } finally {
    // Hold the crash guard past cleanup: the library re-inits + inject()s on the now-closed page right
    // after this resolves, and that rejects — that late rejection must still be swallowed.
    setTimeout(() => { loggingOut = false; }, 8000).unref(); // .unref: never keep the process alive just for this
  }
}

// A remote logout makes whatsapp-web.js reject from an internal async handler we don't control (its
// post-logout inject() on the browser we just closed). Node's default crashes the process on that
// unhandled rejection. WHILE a logout is in flight, swallow + log it so the server survives; at all
// OTHER times preserve Node's default (log + exit) so real bugs still surface. Installed once.
function installCrashGuardOnce() {
  if (crashGuardInstalled) return;
  crashGuardInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const msg = (reason && reason.stack) || String(reason);
    if (loggingOut) { console.error('[whatsapp] async error during logout cleanup — ignored so the server keeps running:', msg); return; }
    console.error('Unhandled promise rejection (fatal):', msg);
    process.exit(1);
  });
}

// Start the client once. Safe to call again (no-op if already starting/started).
// Never throws — any failure is caught, logged, and leaves ready=false.
function init() {
  // Phase 9 — structural safety: the test suite can NEVER boot a WhatsApp client. Under PLANNR_TEST
  // this is a hard no-op (belt-and-suspenders on top of server.js only calling init() when run
  // directly). WhatsApp is currently throttled from rapid reconnects; no test may launch Chromium.
  if (process.env.PLANNR_TEST === '1') { lastError = 'disabled under PLANNR_TEST'; return; }
  // Phase 11C — PLANNR_NO_WHATSAPP=1 makes init a CLEAN no-op: no client, no Chromium, no connect. Set
  // by `npm run dev` so --watch doesn't reconnect on every file save (the throttling pattern). Returns
  // here BEFORE requiring whatsapp-web.js, so nothing is even loaded. isReady() stays false and the
  // Test-send button reports "not connected" honestly.
  if (process.env.PLANNR_NO_WHATSAPP === '1') { lastError = 'WhatsApp disabled (PLANNR_NO_WHATSAPP=1)'; console.log('[whatsapp] PLANNR_NO_WHATSAPP=1 — client NOT started (no Chromium, no connect).'); return; }
  if (client) return;
  let Client, LocalAuth;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
  } catch (e) {
    lastError = 'whatsapp-web.js is not installed';
    console.error('[whatsapp] library not available — WhatsApp channel disabled:', (e && e.message) || e);
    return;
  }

  try {
    settled = false; // fresh init — not yet at a terminal state
    installCrashGuardOnce(); // Part C — a logout-driven rejection must never crash the process
    // Part C — replace LocalAuth's unsafe logout (fs.rm on the session dir while Chromium still holds
    // the files → EBUSY → an unhandled rejection kills the process, half-deleting the dir) with our
    // ordered, tolerant, never-throwing cleanup. The library calls this ONLY on a real logout, so a
    // network drop (which routes through authStrategy.disconnect(), never logout()) never wipes anything.
    const localAuth = new LocalAuth({ dataPath: SESSION_DIR });
    localAuth.logout = () => handleRemoteLogout();
    client = new Client({
      authStrategy: localAuth,
      puppeteer: { headless: true, args: ['--no-sandbox'] },
    });

    // Each terminal state marks init "settled" so a concurrent shutdown stops waiting and closes.
    client.on('ready', () => { ready = true; everReady = true; lastError = null; markSettled(); console.log('[whatsapp] connected — reusing saved session (no QR needed).'); snapshotSession({ browserClosed: false }); });
    client.on('authenticated', () => { console.log('[whatsapp] session authenticated.'); });
    // A QR here means the saved session is gone/expired — a server can't scan it.
    client.on('qr', () => { ready = false; lastError = 'session not linked'; markSettled(); console.error('[whatsapp] no valid session — run `node whatsapp-login.js` once to re-link (QR scan). WhatsApp sending is disabled until then.'); });
    client.on('auth_failure', (m) => { ready = false; lastError = 'authentication failed'; markSettled(); console.error('[whatsapp] auth failure — re-run whatsapp-login.js to re-link.', m ? String(m).slice(0, 120) : ''); });
    client.on('disconnected', (reason) => {
      ready = false; lastError = 'disconnected'; markSettled();
      // Only 'LOGOUT' clears the session (handled by the LocalAuth.logout override above). Every other
      // reason (a WAState like CONFLICT/TIMEOUT/UNPAIRED — i.e. a network/socket drop) leaves the
      // session untouched so the client can reconnect; it must NOT trigger a wipe.
      if (shouldCleanupOnDisconnect(reason)) console.error('[whatsapp] disconnected: device logged out remotely — the saved session is being cleared (browser first); a re-link will be needed.');
      else console.error(`[whatsapp] disconnected: ${reason} — transient/network, session preserved; will reconnect when possible.`);
    });

    client.initialize().catch((e) => {
      ready = false; lastError = 'startup failed';
      console.error('[whatsapp] client startup failed — WhatsApp channel disabled this run:', (e && e.message) || e);
    });
    console.log('[whatsapp] starting client (reconnecting from saved session)…');
  } catch (e) {
    ready = false; lastError = 'startup failed';
    console.error('[whatsapp] could not start client:', (e && e.message) || e);
  }
}

function isReady() { return ready; }

// Phase 11A — resolve true once the client is READY, or false if it settles in any other terminal
// state (qr / auth_failure / disconnected) or the wait times out. Used by the boot catch-up so a
// WhatsApp catch-up waits (bounded) for the reused session to reconnect before trying to send.
// Reuses the same settle machinery as destroy(); never throws.
async function whenReady(ms = SETTLE_GRACE_MS) {
  if (ready) return true;
  await waitForSettle(ms);
  return ready;
}

// Close the WhatsApp client's browser so it doesn't orphan on server exit. Calls client.destroy()
// (closes the puppeteer browser) and NEVER logout() — logout would unlink the session in
// .wwebjs_auth and force a fresh QR scan from the spare phone on next boot. Tolerant of every state
// so it can be awaited from shutdown() without ever throwing: null client, a client that never
// became ready, an initialize() still in flight, and a destroy() that itself throws.
async function destroy() {
  const c = client;
  client = null; ready = false;
  if (!c) return;                                    // never inited / already destroyed

  // 1) If init hasn't settled, the LocalAuth session store may be mid-write (and pupBrowser may not
  //    even be assigned yet). Wait — bounded — for a terminal state so we close AFTER the write, not
  //    during it. Ctrl+C after 'ready' skips this instantly (settled === true).
  if (!settled) {
    console.log('[whatsapp] shutdown during init — waiting briefly for the session to settle before closing…');
    await waitForSettle(SETTLE_GRACE_MS);
  }

  // 2) Close cleanly. client.destroy() = a GRACEFUL browser.close() (Chromium flushes IndexedDB then
  //    exits) + a NO-OP LocalAuth.destroy() (only logout() ever deletes the session — we never call
  //    it). Bound it so a wedged mid-init browser can't hang shutdown forever.
  const timeout = Symbol('timeout');
  const race = (p, ms) => Promise.race([Promise.resolve(p).catch((e) => { console.error('[whatsapp] close error (ignored):', (e && e.message) || e); }), new Promise((r) => setTimeout(() => r(timeout), ms))]);

  const r = await race(c.destroy(), CLOSE_TIMEOUT_MS);
  if (r === timeout) {
    // client.destroy() stalled (browser wedged). Close the underlying puppeteer browser DIRECTLY;
    // by now init has settled/timed-out, so the credential write is done — no mid-write kill.
    console.error('[whatsapp] client.destroy() stalled — closing the underlying browser directly.');
    const browser = c.pupBrowser;
    if (browser) {
      await race(browser.close(), 3000);             // graceful first
      try { const proc = browser.process && browser.process(); if (proc && proc.exitCode === null) proc.kill(); } catch { /* last resort */ }
    }
  }
}

// Send one PDF (Buffer) to every number. Returns {ok:true, sent, failed:[{number,reason}]}
// or {ok:false, error} when the whole channel is down. NEVER throws — a per-number
// failure (invalid/not-on-WhatsApp, send error) is isolated and collected, so one
// bad number can't stop the rest and can't crash the server.
async function sendPdf(numbers, pdfBuffer, filename, caption) {
  if (!client || !ready) {
    return { ok: false, error: `WhatsApp is not connected (${lastError || 'not linked'}). Re-run whatsapp-login.js if this persists.` };
  }
  const { MessageMedia } = require('whatsapp-web.js');
  const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), filename);

  let sent = 0; const failed = [];
  for (const raw of numbers) {
    const num = digits(raw);
    try {
      // getNumberId resolves the real WhatsApp chat id and returns null if the
      // number isn't registered on WhatsApp — that's our "invalid number" check.
      const numberId = await client.getNumberId(num);
      if (!numberId) { failed.push({ number: raw, reason: 'not a WhatsApp number' }); continue; }
      await client.sendMessage(numberId._serialized, media, { caption });
      sent++;
    } catch (e) {
      // Keep the recorded reason short and free of any session/credential detail.
      failed.push({ number: raw, reason: (e && e.message ? String(e.message).slice(0, 120) : 'send failed') });
    }
  }
  return { ok: true, sent, failed };
}

module.exports = {
  init, isReady, whenReady, sendPdf, destroy, pruneVersionCache, snapshotSession, maskPhone,
  everReady: () => everReady, // Phase 11A — shutdown gate: only snapshot a session that was actually good this run
  _hasClient: () => client !== null, // Phase 11C — test seam: assert PLANNR_NO_WHATSAPP constructs no client
  // Phase 11A snapshot-completeness guard — pure decision + marker helpers, exported for tests.
  snapshotDecision, readSnapshotMarker, snapshotIsComplete, writeSnapshotMarker,
  // Part C — logout resilience, exported for tests (pure/ordered cleanup pieces).
  shouldCleanupOnDisconnect, rmTolerant, handleRemoteLogout,
};
