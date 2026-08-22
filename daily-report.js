// Daily Report — a scheduled Overview-PDF email via Gmail SMTP (Nodemailer + node-cron).
//
// Config (recipient list + up to 5 daily send times) is stored in the existing settings key/value
// table. Credentials come ONLY from process.env (GMAIL_USER / GMAIL_APP_PASSWORD,
// loaded from .env in server.js) — they are never persisted to the DB, never logged,
// and never served to the browser.
//
// RUNS ONLY WHILE THE SERVER IS RUNNING. node-cron is an in-process timer, not a hosted
// job. If the machine is asleep/off (or the process isn't running) at the saved minute,
// that day's email simply does not go out — there is no catch-up. See the note surfaced
// in the Data-page UI.

const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { db } = require('./db');

const EMAIL_RE = /^[^\s@]+@gmail\.com$/i;          // Gmail addresses only
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;      // HH:MM, 24-hour

let generatePdf = null; // injected by server.js init() to avoid a circular require
let reportExtras = null; // Part B — injected: (tenantId, prevSnapshot) -> { text, figures }. computeOverview
                         // + repo live in server.js, so the delta is computed there and passed in here.
let tasks = [];         // active node-cron jobs (one per send time), or [] when idle
const MAX_TIMES = 5;    // cap: at most 5 scheduled sends per day

// Phase 10C — all stored send times are IST wall-clock. Interpret them in the IANA zone (never a
// hardcoded +5:30). IST has no DST, so there is no seasonal complexity. node-cron 4.6.0 honours the
// `timezone` option (verified empirically via getNextRun, not docs).
const TZ = 'Asia/Kolkata';
// The IST calendar date (YYYY-MM-DD) for a report stamp. new Date().toISOString() gives the UTC
// date, which is a day EARLY between 00:00 and 05:30 IST — wrong in the filename, subject and caption.
function istDateStamp(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); }
// Minutes since IST midnight for an instant (default now) — the boot catch-up's "has the earliest send
// time already passed today?" test. Same IANA zone as istDateStamp; the optional arg makes it testable.
function istNowMinutes(d = new Date()) {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/^24:/, '00:');
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
const timeToMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

// getSetting/setSetting are hot (every config read + save, and each scheduled send). This
// module is required BEFORE db init() runs, so we can't prepare at module load — the
// settings table won't exist yet. Prepare once on first use (which is always post-init)
// and cache, which still stops node:sqlite recompiling the SQL on every call.
let getSettingStmt = null, setSettingStmt = null, primaryTenantStmt = null;
// Tenancy Phase 2 — settings is now keyed on (tenant_id, key). The scheduler is still GLOBAL /
// single-schedule (Part E is not reshaping it), so every setting it writes on its own — the
// last-success / attempt / alert bookkeeping and the legacy-time migration — belongs to the PRIMARY
// tenant: the lowest user id (the household head), the SAME target db.js's Part-D backfill used, so
// migration-backfilled and scheduler-written rows land on one tenant and a plain WHERE-key read stays
// unambiguous. Callers with a real user (the config-save route) pass that tenant explicitly.
function primaryTenant() {
  if (!primaryTenantStmt) primaryTenantStmt = db.prepare('SELECT MIN(id) AS id FROM users');
  const r = primaryTenantStmt.get();
  return (r && r.id != null) ? r.id : 0; // 0 = the reserved global/no-household sentinel (settings has no FK)
}
// Tenancy Phase 3 — settings reads are TENANT-SCOPED (composite (tenant_id, key)). tenant defaults to
// the primary tenant so the (still-global, pre-Part-C) scheduler's own reads work unchanged; the
// browser endpoints pass the caller's tenant so B can't read A's recipients/schedule/budget/status.
function getSetting(key, tenant = primaryTenant()) {
  if (!getSettingStmt) getSettingStmt = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?');
  const r = getSettingStmt.get(tenant, key); return r ? r.value : null;
}
function setSetting(key, value, tenant = primaryTenant()) {
  if (!setSettingStmt) setSettingStmt = db.prepare('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value');
  setSettingStmt.run(tenant, key, value);
}

// Read + JSON-parse a settings key into an array (defensive: always returns []).
function getArr(key, tenant = primaryTenant()) {
  try { const raw = getSetting(key, tenant); if (raw) { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } } catch { /* fall through */ }
  return [];
}

// ── Phase 2: per-attempt outcome recording (bounded) ────────────────────────────────────────────
// Phase 10 recorded the last SUCCESS date per channel. Phase 2 also records the last few ATTEMPTS —
// each with an IST timestamp, an outcome (sent / failed / skipped) and, on a non-send, the reason the
// send path already produced. This is a STATUS INDICATOR, not an audit log, so it's hard-bounded.
const ATTEMPTS_KEEP = 5;   // keep only the last few attempts per channel
const STALE_MIN_DAYS = 2;  // a configured channel whose last success is >= 2 IST days old (~48h+) is stale

// "YYYY-MM-DD HH:MM IST" for an attempt's timestamp — IST wall-clock via the IANA zone (no +5:30).
function istStampFull(d = new Date()) {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/^24:/, '00:');
  return `${istDateStamp(d)} ${hm} IST`;
}
// Record ONE attempt for a channel. NEVER touches last-success (only noteSuccess does), so a failure or
// skip can't move the success date. Bounded to the last ATTEMPTS_KEEP (oldest dropped). Returns the record.
function recordAttempt(channel, outcome, reason = null, tenant = primaryTenant()) {
  const now = new Date();
  const rec = { at: now.toISOString(), atIST: istStampFull(now), outcome, reason: reason || null };
  const arr = getArr(`daily_report_${channel}_attempts`, tenant);
  arr.push(rec);
  while (arr.length > ATTEMPTS_KEEP) arr.shift();
  setSetting(`daily_report_${channel}_attempts`, JSON.stringify(arr), tenant);
  return rec;
}
function lastAttempt(channel, tenant = primaryTenant()) { const a = getArr(`daily_report_${channel}_attempts`, tenant); return a.length ? a[a.length - 1] : null; }

// Whole IST days between two 'YYYY-MM-DD' stamps (b - a), and adding days to one. Compared on the IST
// day boundary (both stamps are already IST dates), so no timezone drift.
function istDaysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function addIstDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Stale iff the channel is configured (recipients AND times) and its last success is >= STALE_MIN_DAYS
// IST days old — or it has never succeeded at all. Pure (all inputs passed in) so it's testable on the
// day boundary without a real clock. The point: the common invisible failure is "the server simply
// wasn't running", which produces NO failed attempt — only a last-success date that stops advancing.
function isStale({ configured, lastSuccess, today, minDays = STALE_MIN_DAYS }) {
  if (!configured) return false;
  if (!lastSuccess) return true;
  return istDaysBetween(lastSuccess, today) >= minDays;
}
// Next scheduled fire for a channel as an IST wall-clock string (or null when no times are set).
function nextFireIST(times, nowMin = istNowMinutes(), today = istDateStamp()) {
  if (!times || !times.length) return null;
  const sorted = [...times].sort();
  const next = sorted.find((t) => timeToMin(t) > nowMin);
  return next ? `${today} ${next} IST` : `${addIstDays(today, 1)} ${sorted[0]} IST`;
}

// { recipients, sendTimes: 'HH:MM'[] } — browser-facing.
function getConfig(tenant = primaryTenant()) {
  const recipients = getArr('daily_report_recipients', tenant);
  let sendTimes = getArr('daily_report_times', tenant);
  // Fall back to the pre-multi-time single value ONLY when the new list is empty/absent — so once
  // daily_report_times is populated (the normal state after the Phase 10E migration), the legacy key
  // is NEVER read and can't shadow the list. The legacy `daily_report_time` row is intentionally kept
  // (now an empty string): it's the anchor that lets migrateLegacyEmailTime() re-convert a restored
  // PRE-Phase-10E backup (which has only this key) on boot. Removing it would break that restore path.
  if (!sendTimes.length) { const legacy = getSetting('daily_report_time', tenant); if (legacy && TIME_RE.test(legacy)) sendTimes = [legacy]; }
  return { recipients, sendTimes };
}

// Phase 11A — last successful send per channel (IST date). Written ONLY on a genuine success
// (ok && at least one recipient delivered), NEVER on a skip (no recipients) or a failure — so a
// miss/failure leaves the date stale and the NEXT boot's catch-up retries. The *_catchup key also
// records the date of the last CATCH-UP success so Home can flag "this report was a catch-up".
function noteSuccess(channel, opts = {}, tenant = primaryTenant()) {
  const today = istDateStamp();
  setSetting(`daily_report_${channel}_last_success`, today, tenant);
  if (opts.catchUp) setSetting(`daily_report_${channel}_last_catchup`, today, tenant);
  // Part B — snapshot the headline figures + a PRECISE timestamp at this genuine success, so the NEXT
  // report can diff against it ("what changed since last time"). Per channel (each diffs its own last
  // send). opts.figures is the current figures computed while building this send's delta.
  if (opts.figures) {
    const now = new Date();
    setSetting(`daily_report_${channel}_last_snapshot`, JSON.stringify({ at: now.toISOString(), atIST: istStampFull(now), figures: opts.figures }), tenant);
  }
}
// Part B — the previous success snapshot for a channel (the delta boundary), or null on the first-ever send.
function readSnapshot(channel, tenant = primaryTenant()) {
  try { const raw = getSetting(`daily_report_${channel}_last_snapshot`, tenant); if (raw) { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } } catch { /* absent/corrupt → first-report behaviour */ }
  return null;
}
// Build the "what changed since last report" text for a channel via the injected server-side computer.
// Returns { text, figures } (text may be '' if extras aren't wired, e.g. a unit test that skips init).
function buildDelta(channel, tenant = primaryTenant()) {
  if (typeof reportExtras !== 'function') return { text: '', figures: null };
  try { return reportExtras(tenant, readSnapshot(channel, tenant)) || { text: '', figures: null }; }
  catch (e) { console.error('[daily-report] delta build failed (report still sends):', (e && e.message) || e); return { text: '', figures: null }; }
}
// Browser-facing send status for both channels — surfaced on Home. Per channel: last success/catchup
// dates (Phase 10), the LAST ATTEMPT (outcome + reason + IST time), whether the channel is configured,
// and the STALE flag (Phase 2). Carries no recipient addresses/numbers — safe for the browser.
function sendStatus(tenant = primaryTenant()) {
  const cfg = getConfig(tenant);
  const today = istDateStamp();
  const one = (ch, recipients, times) => {
    const lastSuccess = getSetting(`daily_report_${ch}_last_success`, tenant) || null;
    const configured = recipients.length > 0 && times.length > 0;
    return {
      lastSuccess,
      lastCatchup: getSetting(`daily_report_${ch}_last_catchup`, tenant) || null,
      lastAttempt: lastAttempt(ch, tenant),   // { at, atIST, outcome, reason } or null — reason carries no numbers
      configured,
      stale: isStale({ configured, lastSuccess, today }),
    };
  };
  return { email: one('email', cfg.recipients, cfg.sendTimes) };
}

// One-line boot summary for the windowless case — configured state, last success, and whether the
// last attempt failed — so diagnosing "nothing was sent" is opening the log ONCE, not grepping
// [daily-report] lines across rotated boots.
function bootSummaryLine(tenant = primaryTenant()) {
  const cfg = getConfig(tenant);
  const st = sendStatus(tenant);
  const seg = (label, recips, times, s) => {
    const configured = recips.length > 0 && times.length > 0;
    const la = s.lastAttempt;
    const attempt = la ? (la.outcome + (la.outcome !== 'sent' && la.reason ? ` — ${la.reason}` : '')) : 'none yet';
    return `${label} ${configured ? 'configured' : 'NOT configured'}, last success ${s.lastSuccess || 'never'}, last attempt ${attempt}${s.stale ? ' [STALE]' : ''}`;
  };
  return '[daily-report] status — ' + seg('EMAIL:', cfg.recipients, cfg.sendTimes, st.email);
}

// Validate + de-dupe + sort a send-time list ('HH:MM', 24h). -> { times } or { error }.
function cleanTimeList(list) {
  if (!Array.isArray(list)) return { error: 'Send times must be a list.' };
  const clean = [];
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    if (!TIME_RE.test(t)) return { error: `"${t}" is not a valid time (use HH:MM, 24-hour).` };
    if (!clean.includes(t)) clean.push(t); // de-dupe
  }
  if (clean.length > MAX_TIMES) return { error: `At most ${MAX_TIMES} send times per day.` };
  clean.sort(); // ascending -> stable, readable list
  return { times: clean };
}

// PARTIAL update: each field is persisted ONLY when provided (not undefined). An explicit []
// clears that field; omitting it leaves the stored value untouched. Always (re)schedules from
// the full resulting config and returns it. Returns { ok, ...config } or { error }.
function saveConfig(patch, tenant = primaryTenant()) {
  patch = patch || {}; // Tenancy Phase 2 — writes attribute to `tenant` (the saving user); the route passes req.user.id.

  // EMAIL recipients (Gmail-only) — unchanged rules.
  if (patch.recipients !== undefined) {
    if (!Array.isArray(patch.recipients)) return { error: 'Recipients must be a list of email addresses.' };
    const cleanR = [];
    for (const raw of patch.recipients) {
      const r = String(raw == null ? '' : raw).trim();
      if (!r) continue;
      if (r.length > 254 || !EMAIL_RE.test(r)) return { error: `"${r}" is not a valid Gmail address (must end in @gmail.com).` };
      const lower = r.toLowerCase();
      if (!cleanR.includes(lower)) cleanR.push(lower); // de-dupe
    }
    setSetting('daily_report_recipients', JSON.stringify(cleanR), tenant);
  }

  // EMAIL send times (independent list).
  if (patch.sendTimes !== undefined) {
    const r = cleanTimeList(patch.sendTimes);
    if (r.error) return { error: r.error };
    setSetting('daily_report_times', JSON.stringify(r.times), tenant);
    setSetting('daily_report_time', '', tenant); // clear the legacy single-time key so it can't shadow the list
  }

  reschedule();
  return { ok: true, ...getConfig() };
}

// 'HH:MM' -> node-cron expression firing daily at that time in IST (see TZ passed to cron.schedule).
function buildCronExpr(time) {
  if (!TIME_RE.test(String(time || ''))) return null;
  const [hh, mm] = time.split(':');
  return `${Number(mm)} ${Number(hh)} * * *`;
}

function makeTransport() {
  // Phase 9 — structural safety: under PLANNR_TEST this returns null BEFORE nodemailer.createTransport
  // is ever reached, so the test suite is structurally incapable of constructing a live transport (a
  // diagnostic already delivered a real report to real people; the suite must never send). sendEmail
  // treats null as "credentials not configured" and sends nothing.
  if (process.env.PLANNR_TEST === '1') return null;
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

// Tenancy Phase 3 (Part C) — every household has its OWN schedule and its OWN Overview PDF, so the
// render-once-share-across-CHANNELS trick can't dedupe ACROSS tenants (different documents). N tenants
// sharing 09:00 would otherwise fire N unguarded Chromium renders at once — and the scheduler used to
// call generatePdf DIRECTLY, bypassing the HTTP route's PDF_MAX_CONCURRENT (a live bug even at ONE
// tenant). Every scheduled + catch-up render now goes through ONE bounded, NON-SHEDDING queue:
// concurrency RENDER_CONCURRENCY, steady drain, enqueue-and-WAIT. Never 503-shed — a dropped daily
// report is a silent miss, not an acceptable fast-fail. Per-tenant staggering (fireAt) spreads a shared
// minute so the backlog stays shallow.
const RENDER_CONCURRENCY = 2;
let _renderActive = 0;
const _renderQueue = [];
function _drainRenders() {
  while (_renderActive < RENDER_CONCURRENCY && _renderQueue.length) {
    const job = _renderQueue.shift();
    _renderActive++;
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { _renderActive--; _drainRenders(); });
  }
}
function enqueueRender(fn) { return new Promise((resolve, reject) => { _renderQueue.push({ fn, resolve, reject }); _drainRenders(); }); }
function renderQueueState() { return { active: _renderActive, queued: _renderQueue.length, concurrency: RENDER_CONCURRENCY }; } // test/introspection hook

// All households (each user = one tenant in the current model). ORDER BY id for stable staggering.
let tenantsStmt = null;
function tenants() { if (!tenantsStmt) tenantsStmt = db.prepare('SELECT id FROM users ORDER BY id ASC'); return tenantsStmt.all().map((r) => r.id); }

// Build ONE tenant's summary PDF through the bounded queue. Returns a Buffer or throws (callers turn a
// throw into a per-channel error). SUMMARY composition (Phase 4C): the on-demand Download exports keep
// the complete parts; the scheduled/catch-up/test send uses the bounded summary.
async function buildPdf(tenant) {
  if (typeof generatePdf !== 'function') throw new Error('PDF generator not initialised.');
  if (tenant == null) throw new Error('buildPdf requires a tenant.');
  return enqueueRender(() => generatePdf({ tenantId: tenant, part: 'summary', theme: 'light', range: { start: null, end: null } }));
}

// EMAIL channel — email the Overview PDF to ALL saved recipients in one message.
// Returns {ok:true, sent} | {ok:false, skipped} | {ok:false, error}. NEVER throws.
// `pdf` (optional) is a pre-built Buffer reused from a combined send; if absent, it's
// generated here. `cfg` (optional) is a pre-read getConfig() passed down from fireAt so a
// scheduled send reads the config once; when absent (manual test button) it reads its own.
async function sendEmail(tenant, reason, pdf, cfg, opts = {}) {
  const { recipients } = cfg || getConfig(tenant);
  if (!recipients.length) { // no recipients -> nothing to send (no error, no partial send)
    console.log(`[daily-report] ${reason}: no email recipients configured — nothing to send.`);
    recordAttempt('email', 'skipped', 'No email recipients configured.', tenant);
    return { ok: false, skipped: true, reason: 'no-recipients' };
  }
  const transport = makeTransport();
  if (!transport) {
    console.error('[daily-report] GMAIL_USER / GMAIL_APP_PASSWORD are not set in .env — cannot send. Add them to .env and restart.');
    // Couldn't attempt (no credentials = email's "not ready") -> skipped, with the actionable reason.
    recordAttempt('email', 'skipped', 'Email credentials are not configured on the server (.env).', tenant);
    return { ok: false, error: 'Email credentials are not configured on the server (.env).' };
  }
  const dateStr = istDateStamp(); // Phase 10C — IST calendar date, not the UTC date
  try {
    if (!pdf) pdf = await buildPdf(tenant);
  } catch (e) {
    console.error(`[daily-report] ${reason}: PDF generation failed —`, (e && e.message) || e);
    recordAttempt('email', 'failed', 'Could not generate the Overview PDF.', tenant);
    return { ok: false, error: 'Could not generate the Overview PDF.' };
  }
  try {
    // Phase 11A — a catch-up is labelled UNMISTAKABLY (subject + filename), so a late report can't be
    // read against the wrong date. istDateStamp() is today's IST date; the report is a current snapshot.
    const label = opts.catchUp ? `catch-up for ${dateStr}` : dateStr;
    const delta = buildDelta('email', tenant); // Part B — "what changed since last report" (+ upcoming payments)
    const info = await transport.sendMail({
      from: process.env.GMAIL_USER,
      to: recipients.join(', '),
      subject: `Plannr — Daily Overview (${label})`,
      text: `Attached is the Plannr Overview report (${reason}), generated ${dateStr}.` + (delta.text ? `\n\n${delta.text}` : '') + `\n\nThis is an automated message from Plannr.`,
      attachments: [{ filename: `plannr-overview-${opts.catchUp ? 'catch-up-' : ''}${dateStr}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
    console.log(`[daily-report] ${reason}: emailed Overview PDF to ${recipients.length} recipient(s). messageId=${info.messageId}`);
    noteSuccess('email', { ...opts, figures: delta.figures }, tenant); // record IST date + snapshot the figures for next time's delta
    recordAttempt('email', 'sent', null, tenant);
    return { ok: true, sent: recipients.length };
  } catch (e) {
    // Clear, single-line failure record. The credential is never included in the error text.
    console.error(`[daily-report] ${reason}: EMAIL FAILED —`, (e && e.message) || e);
    recordAttempt('email', 'failed', (e && e.message) ? String(e.message).slice(0, 140) : 'Email send failed.', tenant);
    return { ok: false, error: (e && e.message) || 'Email send failed.' };
  }
}

// Fire the channel scheduled at ONE minute. The PDF is built ONCE here (only if the firing
// channel actually has recipients). Never throws. (On a build failure pdf stays null and the
// channel falls back to its own build+error, matching the manual test-send path.)
// Per-tenant staggering within a shared minute: a deterministic 0..STAGGER_SPAN_MS offset derived from
// the tenant id, so N tenants sharing 09:00 don't all enqueue at 09:00:00 (keeps the render backlog
// shallow). A daily report isn't latency-sensitive, so a few seconds' spread is free. No-op under test.
const STAGGER_SPAN_MS = 45_000;
function staggerMs(tenant) {
  if (process.env.PLANNR_TEST === '1' || process.env.PLANNR_NO_STAGGER === '1') return 0;
  return Math.abs(Math.imul(tenant | 0, 2654435761)) % STAGGER_SPAN_MS; // pseudo-uniform, clock-free
}
const staggerDelay = (tenant) => { const ms = staggerMs(tenant); return ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); };

// Fire ONE tenant's channel scheduled at ONE minute. The render is queued (bounded concurrency),
// preceded by the per-tenant stagger.
async function fireAt(tenant, time, doEmail) {
  await staggerDelay(tenant);
  const cfg = getConfig(tenant); // read ONCE per fire; pass down so the sender doesn't re-read it
  const needEmail = doEmail && cfg.recipients.length > 0;
  let pdf = null;
  if (needEmail) {
    try { pdf = await buildPdf(tenant); }
    catch (e) { console.error(`[daily-report] scheduled send (tenant ${tenant}, ${time}): PDF generation failed —`, (e && e.message) || e); }
  }
  if (doEmail) await sendEmail(tenant, `scheduled email send (${time})`, pdf, cfg);
}

// CRITICAL: tear down EVERY previously-scheduled job first, then create fresh ones — so
// repeated Saves never leave stale jobs behind. Schedules ONE cron job per DISTINCT minute
// across the saved send times; each job fires via fireAt(). No times -> idle. Called on
// save and at startup.
// Tenancy Phase 3 (Part C) — the households that MAY have a schedule = the distinct tenant_ids present
// in settings (a tenant with no settings row can't have recipients/times). Cheaper than every user, and
// it includes the sentinel tenant 0 used when there are no user rows (test/first-boot).
let scheduleTenantsStmt = null;
function scheduleTenants() { if (!scheduleTenantsStmt) scheduleTenantsStmt = db.prepare('SELECT DISTINCT tenant_id FROM settings'); return scheduleTenantsStmt.all().map((r) => r.tenant_id); }

// CRITICAL: tear down EVERY previously-scheduled job first, then create fresh ones. Schedules ONE
// cron job per (TENANT, distinct-minute), firing THAT tenant's send via fireAt(tenant, ...). Renders
// go through the bounded queue, so N households sharing 09:00 never spawn more than RENDER_CONCURRENCY
// concurrent Chromium renders.
function reschedule() {
  for (const t of tasks) { try { t.stop(); } catch { /* ignore */ } }
  tasks = [];
  let totalE = 0, households = 0;
  for (const tenant of scheduleTenants()) {
    const { sendTimes } = getConfig(tenant);
    if (!sendTimes.length) continue; // this household has no schedule
    households++;
    for (const time of sendTimes) {
      const expr = buildCronExpr(time);
      if (!expr || !cron.validate(expr)) continue;
      totalE++;
      tasks.push(cron.schedule(expr, () => { fireAt(tenant, time, true).catch((e) => console.error(`[daily-report] scheduled send (tenant ${tenant}, ${time}) crashed:`, e)); }, { timezone: TZ })); // Phase 10C — fire at IST wall-clock
    }
  }
  if (totalE) console.log(`[daily-report] scheduled ${totalE} EMAIL send(s) across ${households} household(s) IST (Asia/Kolkata), drained through a bounded render queue (concurrency ${RENDER_CONCURRENCY}).`);
  else console.log('[daily-report] no send times set on any household — scheduler idle.');
}

// Phase 10E — finish the multi-time migration that saveConfig would do on the next email save, but
// do it on boot so the email schedule stops silently riding the single legacy key. If there is no
// daily_report_times row AND a valid legacy daily_report_time exists, write it as a one-element list
// and clear the legacy key. Idempotent (once the list row exists, this is a no-op) and safe when
// neither key exists. Returns true iff it migrated. getSetting returns null for an ABSENT row.
function migrateLegacyEmailTime() {
  let migrated = false;
  for (const tenant of scheduleTenants()) {
    if (getSetting('daily_report_times', tenant) !== null) continue; // list row already present -> done
    const legacy = getSetting('daily_report_time', tenant);
    if (!legacy || !TIME_RE.test(legacy)) continue;                  // no valid legacy time -> nothing to do
    setSetting('daily_report_times', JSON.stringify([legacy]), tenant);
    setSetting('daily_report_time', '', tenant);                     // clear legacy, exactly as saveConfig does
    console.log(`[daily-report] migrated legacy email time ${legacy} -> daily_report_times ["${legacy}"] for household ${tenant}.`);
    migrated = true;
  }
  return migrated;
}

// Pure per-channel decision: is a catch-up due right now? Due iff the channel has recipients AND at
// least one send time AND its EARLIEST send time has already PASSED today (IST) AND no success has
// been recorded for today. All inputs are passed in, so this is testable without a real clock or DB.
function catchUpDue(cfg, { nowMin, today, lastEmail }) {
  const due = (recipients, times, last) =>
    recipients.length > 0 && times.length > 0 && Math.min(...times.map(timeToMin)) < nowMin && last !== today;
  return { email: due(cfg.recipients, cfg.sendTimes, lastEmail) };
}
// Human-readable reason a channel is NOT due (null when it IS due) — for a clear boot log.
function catchUpSkipReason(recipients, times, last, nowMin, today) {
  if (!recipients.length) return 'no recipients';
  if (!times.length) return 'no send times';
  if (Math.min(...times.map(timeToMin)) >= nowMin) return "today's earliest send time hasn't passed";
  if (last === today) return `already sent today (${today})`;
  return null;
}

// Boot catch-up: if a scheduled send was MISSED because the machine was off/asleep at its time, send
// ONE report reflecting CURRENT state (a snapshot, never a per-day backlog — four days down still
// yields one) on the next startup. At most once per day (the last-success date guards it). NEVER
// throws: any failure is logged and boot continues. PLANNR_NO_CATCHUP=1 disables it entirely (set in
// the test harness so the suite can't send at boot).
async function runCatchUp() {
  if (process.env.PLANNR_NO_CATCHUP === '1') { console.log('[daily-report] catch-up disabled (PLANNR_NO_CATCHUP=1).'); return; }
  const today = istDateStamp();
  const nowMin = istNowMinutes();
  const hhmm = `${String(Math.floor(nowMin / 60)).padStart(2, '0')}:${String(nowMin % 60).padStart(2, '0')}`;
  // Per household: independent catch-up decision + a queued render (bounded), so 100 due households at
  // boot never spawn 100 concurrent Chromium renders. NEVER throws: a per-tenant failure is logged.
  for (const tenant of scheduleTenants()) {
    try {
      const cfg = getConfig(tenant);
      const lastEmail = getSetting('daily_report_email_last_success', tenant);
      const due = catchUpDue(cfg, { nowMin, today, lastEmail });
      const eReason = catchUpSkipReason(cfg.recipients, cfg.sendTimes, lastEmail, nowMin, today);
      console.log(`[daily-report] catch-up check (household ${tenant}, ${today} ${hhmm} IST): ` +
        `email ${due.email ? 'DUE — sending catch-up' : `not due (${eReason})`}.`);
      if (!due.email) continue;
      let pdf = null; // ONE queued render (mirrors fireAt)
      try { pdf = await buildPdf(tenant); }
      catch (e) { console.error(`[daily-report] catch-up (household ${tenant}): PDF generation failed —`, (e && e.message) || e); }
      if (due.email) await sendEmail(tenant, `catch-up for ${today}`, pdf, cfg, { catchUp: true });
    } catch (e) {
      console.error(`[daily-report] catch-up (household ${tenant}) failed (continuing) —`, (e && e.message) || e);
    }
  }
}

function init(pdfFn, reportExtrasFn) { generatePdf = pdfFn; reportExtras = reportExtrasFn || null; migrateLegacyEmailTime(); reschedule(); }

module.exports = {
  init, getConfig, saveConfig, sendEmail, buildCronExpr,
  // Phase 9 test seams — pure/validation internals + the scheduler, exported so the suite can test
  // them directly without sending anything. `_scheduledCount`/`_stopAll` let a test assert the cron
  // job count (one per distinct minute) and then stop the jobs so none can ever fire.
  cleanTimeList, makeTransport, reschedule, migrateLegacyEmailTime, fireAt, EMAIL_RE, istDateStamp, TZ,
  // Phase 11A — boot catch-up: pure decision + orchestrator + success recorder + browser-facing status.
  istNowMinutes, catchUpDue, runCatchUp, noteSuccess, sendStatus,
  // Phase 2 — attempt recording, staleness, next-fire, boot summary.
  recordAttempt, lastAttempt, isStale, istDaysBetween, addIstDays, istStampFull, nextFireIST, bootSummaryLine,
  _scheduledCount: () => tasks.length,
  _stopAll: () => { for (const t of tasks) { try { t.stop(); } catch { /* ignore */ } } tasks = []; },
  // Tenancy Phase 3 (Part C) — the bounded render queue + tenant list, exported so the suite can verify
  // that N tenants sharing a minute never exceed RENDER_CONCURRENCY concurrent renders (no real sends).
  enqueueRender, renderQueueState, tenants, scheduleTenants, buildPdf, primaryTenant,
};
