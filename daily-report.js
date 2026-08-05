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
const whatsapp = require('./whatsapp'); // WhatsApp delivery (second channel; its OWN schedule)

const EMAIL_RE = /^[^\s@]+@gmail\.com$/i;          // Gmail addresses only
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;      // HH:MM, 24-hour
// Basic phone format for WhatsApp: optional leading +, then 8–15 digits (E.164
// range). Canonicalised to "+<digits>" on save. Same rule as the browser side.
// This is a FORMAT check only — a well-formed but non-WhatsApp number is caught
// at send time (client.getNumberId) and reported as a failed recipient.
const PHONE_RE = /^\+?\d{8,15}$/;
const normPhone = (raw) => '+' + String(raw == null ? '' : raw).replace(/[\s\-().]/g, '').replace(/^\+/, '');

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

// ── Phase 2: WhatsApp-failure → email alert, hard-capped one per day ─────────────────────────────
// Deliberately narrow: if a WhatsApp send doesn't get through AND email can actually deliver, send the
// email recipients a one-line heads-up (no PDF). Capped to one per day so a persistently broken channel
// can't produce a daily stream. NEVER used for an email failure — email can't report its own failure.
function whatsappAlertedToday(tenant = primaryTenant()) { return getSetting('daily_report_whatsapp_alert_last', tenant) === istDateStamp(); }
function noteWhatsappAlert(tenant = primaryTenant()) { setSetting('daily_report_whatsapp_alert_last', istDateStamp(), tenant); }
function whatsappAlertShouldFire({ problem, emailConfigured, alertedToday }) {
  return !!(problem && emailConfigured && !alertedToday);
}

// { recipients, whatsappRecipients: string[], sendTimes, whatsappSendTimes: 'HH:MM'[] } — browser-facing.
// EMAIL and WHATSAPP each have their OWN independent send-time list (separate settings keys).
function getConfig(tenant = primaryTenant()) {
  const recipients = getArr('daily_report_recipients', tenant);
  const whatsappRecipients = getArr('daily_report_whatsapp', tenant);
  let sendTimes = getArr('daily_report_times', tenant);
  // Fall back to the pre-multi-time single value ONLY when the new list is empty/absent — so once
  // daily_report_times is populated (the normal state after the Phase 10E migration), the legacy key
  // is NEVER read and can't shadow the list. The legacy `daily_report_time` row is intentionally kept
  // (now an empty string): it's the anchor that lets migrateLegacyEmailTime() re-convert a restored
  // PRE-Phase-10E backup (which has only this key) on boot. Removing it would break that restore path.
  if (!sendTimes.length) { const legacy = getSetting('daily_report_time', tenant); if (legacy && TIME_RE.test(legacy)) sendTimes = [legacy]; }
  const whatsappSendTimes = getArr('daily_report_whatsapp_times', tenant);
  return { recipients, whatsappRecipients, sendTimes, whatsappSendTimes };
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
  return { email: one('email', cfg.recipients, cfg.sendTimes), whatsapp: one('whatsapp', cfg.whatsappRecipients, cfg.whatsappSendTimes) };
}

// One-line boot summary for the windowless case — each channel's configured state, last success, and
// whether the last attempt failed — so diagnosing "nothing was sent" is opening the log ONCE, not
// grepping [daily-report] lines across rotated boots.
function bootSummaryLine(tenant = primaryTenant()) {
  const cfg = getConfig(tenant);
  const st = sendStatus(tenant);
  const seg = (label, recips, times, s) => {
    const configured = recips.length > 0 && times.length > 0;
    const la = s.lastAttempt;
    const attempt = la ? (la.outcome + (la.outcome !== 'sent' && la.reason ? ` — ${la.reason}` : '')) : 'none yet';
    return `${label} ${configured ? 'configured' : 'NOT configured'}, last success ${s.lastSuccess || 'never'}, last attempt ${attempt}${s.stale ? ' [STALE]' : ''}`;
  };
  return '[daily-report] status — ' + seg('EMAIL:', cfg.recipients, cfg.sendTimes, st.email)
    + '  |  ' + seg('WHATSAPP:', cfg.whatsappRecipients, cfg.whatsappSendTimes, st.whatsapp);
}

// Validate + de-dupe + sort a send-time list ('HH:MM', 24h). Shared by both the email
// and the WhatsApp schedules so they behave identically. -> { times } or { error }.
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

// PARTIAL update: each of the four fields is persisted ONLY when provided (not undefined),
// so saving one channel never touches the other's stored data. An explicit [] clears that
// field; omitting it leaves the stored value untouched. Always (re)schedules from the full
// resulting config and returns it. Returns { ok, ...config } or { error }.
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

  // WHATSAPP numbers — same de-dupe + validate pattern as the email list.
  if (patch.whatsappRecipients !== undefined) {
    if (!Array.isArray(patch.whatsappRecipients)) return { error: 'WhatsApp recipients must be a list of phone numbers.' };
    const cleanW = [];
    for (const raw of patch.whatsappRecipients) {
      const w = String(raw == null ? '' : raw).replace(/[\s\-().]/g, '').trim();
      if (!w) continue;
      if (!PHONE_RE.test(w)) return { error: `"${raw}" is not a valid phone number (use country code, e.g. +919876543210).` };
      const canon = normPhone(w);
      if (!cleanW.includes(canon)) cleanW.push(canon); // de-dupe on canonical +digits form
    }
    setSetting('daily_report_whatsapp', JSON.stringify(cleanW), tenant);
  }

  // EMAIL send times (independent list).
  if (patch.sendTimes !== undefined) {
    const r = cleanTimeList(patch.sendTimes);
    if (r.error) return { error: r.error };
    setSetting('daily_report_times', JSON.stringify(r.times), tenant);
    setSetting('daily_report_time', '', tenant); // clear the legacy single-time key so it can't shadow the list
  }

  // WHATSAPP send times (independent list — separate key, separate cron jobs).
  if (patch.whatsappSendTimes !== undefined) {
    const r = cleanTimeList(patch.whatsappSendTimes);
    if (r.error) return { error: r.error };
    setSetting('daily_report_whatsapp_times', JSON.stringify(r.times), tenant);
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

// WHATSAPP channel — send the same Overview PDF as a file attachment (MessageMedia)
// to every saved WhatsApp number, via the resident client (whatsapp.js). Same
// return shape and NEVER-throws contract as sendEmail. `pdf` reused if provided; `cfg` is
// an optional pre-read getConfig() from fireAt (absent for the manual test button).
async function sendWhatsapp(tenant, reason, pdf, cfg, opts = {}) {
  cfg = cfg || getConfig(tenant);
  const { whatsappRecipients } = cfg;
  if (!whatsappRecipients.length) {
    console.log(`[daily-report] ${reason}: no WhatsApp numbers configured — nothing to send.`);
    recordAttempt('whatsapp', 'skipped', 'No WhatsApp numbers configured.', tenant);
    return { ok: false, skipped: true, reason: 'no-recipients' };
  }
  if (!whatsapp.isReady()) {
    console.error(`[daily-report] ${reason}: WhatsApp is not connected — cannot send. Re-run whatsapp-login.js if this persists.`);
    // Couldn't attempt (client not ready) -> SKIPPED, with the reason. This is exactly the invisible
    // case Phase 2 exists for — nothing surfaced it before.
    recordAttempt('whatsapp', 'skipped', 'WhatsApp is not connected on the server.', tenant);
    await maybeAlertWhatsappProblem(tenant, cfg, 'WhatsApp is not connected', opts);
    return { ok: false, error: 'WhatsApp is not connected on the server. Re-run whatsapp-login.js to re-link.' };
  }
  const dateStr = istDateStamp(); // Phase 10C — IST calendar date, not the UTC date
  try {
    if (!pdf) pdf = await buildPdf(tenant);
  } catch (e) {
    console.error(`[daily-report] ${reason}: PDF generation failed —`, (e && e.message) || e);
    recordAttempt('whatsapp', 'failed', 'Could not generate the Overview PDF.', tenant);
    await maybeAlertWhatsappProblem(tenant, cfg, 'the Overview PDF could not be generated', opts);
    return { ok: false, error: 'Could not generate the Overview PDF.' };
  }
  const label = opts.catchUp ? `catch-up for ${dateStr}` : dateStr; // Phase 11A — unmistakable catch-up label
  const delta = buildDelta('whatsapp', tenant); // Part B — same "what changed" text, this channel's own boundary
  const caption = `Plannr — Daily Overview (${label})\nAutomated report (${reason}).` + (delta.text ? `\n\n${delta.text}` : '');
  const r = await whatsapp.sendPdf(whatsappRecipients, pdf, `plannr-overview-${opts.catchUp ? 'catch-up-' : ''}${dateStr}.pdf`, caption);
  if (!r.ok) {
    console.error(`[daily-report] ${reason}: WHATSAPP FAILED — ${r.error}`);
    recordAttempt('whatsapp', 'failed', String(r.error || 'WhatsApp channel error').slice(0, 140));
    await maybeAlertWhatsappProblem(cfg, 'the WhatsApp channel is down', opts);
    return { ok: false, error: r.error };
  }
  if (r.failed.length) {
    // Log every failed recipient + reason server-side. The number is MASKED (+9198****1427) so contact
    // data doesn't accumulate on disk in the project root (Part B) — enough to debug, not the full number.
    console.error(`[daily-report] ${reason}: WhatsApp sent to ${r.sent}, failed ${r.failed.length}: ` +
      r.failed.map((f) => `${whatsapp.maskPhone(f.number)} (${f.reason})`).join('; '));
  } else {
    console.log(`[daily-report] ${reason}: sent Overview PDF via WhatsApp to ${r.sent} number(s).`);
  }
  if (r.sent > 0) {
    noteSuccess('whatsapp', { ...opts, figures: delta.figures }, tenant); // record success + snapshot figures only if ≥1 number received it
    // Delivered to at least one -> 'sent' (note a partial). NO numbers in the stored reason — Home/health surface it.
    recordAttempt('whatsapp', 'sent', r.failed.length ? `${r.failed.length} of ${r.sent + r.failed.length} number(s) failed` : null, tenant);
  } else {
    // Every number was rejected -> a real failure. Store a COUNT (the masked per-number detail is in the log above).
    recordAttempt('whatsapp', 'failed', `all ${r.failed.length} recipient(s) were rejected`, tenant);
    await maybeAlertWhatsappProblem(tenant, cfg, 'no recipient accepted the WhatsApp report', opts);
  }
  return { ok: true, sent: r.sent, failed: r.failed };
}

// The narrow WhatsApp-failure → email alert (Phase 2). Fires only when there's a real WhatsApp problem,
// email can actually deliver, we haven't alerted today, and this isn't a manual test (opts.suppressAlert).
// Consumes the daily slot UP FRONT so a second failure the same day can't re-alert. Never throws.
async function maybeAlertWhatsappProblem(tenant, cfg, shortReason, opts = {}) {
  try {
    if (opts.suppressAlert) return; // manual "Send Test WhatsApp Now" — the user is watching; don't cross-alert or burn the slot
    const emailConfigured = cfg.recipients.length > 0 && !!makeTransport(); // makeTransport folds in "credentials present"
    if (!whatsappAlertShouldFire({ problem: true, emailConfigured, alertedToday: whatsappAlertedToday(tenant) })) return;
    noteWhatsappAlert(tenant); // hard cap: consume today's slot before attempting the send
    const today = istDateStamp();
    await sendPlainEmail(cfg.recipients, `Plannr — WhatsApp Daily Report did not send (${today})`,
      `Today's WhatsApp Daily Report could not be sent: ${shortReason}. Open Plannr → Home to see the channel status.\n\n(Automated one-per-day notice. Your email reports are unaffected.)`);
  } catch (e) {
    console.error('[daily-report] WhatsApp-failure email alert error (ignored):', (e && e.message) || e);
  }
}
// Short text-only email (no PDF) for the alert. Reuses makeTransport (null under PLANNR_TEST → no send).
async function sendPlainEmail(recipients, subject, text) {
  const transport = makeTransport();
  if (!transport || !recipients.length) return { ok: false, skipped: true };
  await transport.sendMail({ from: process.env.GMAIL_USER, to: recipients.join(', '), subject, text });
  console.log(`[daily-report] sent WhatsApp-failure notice by email to ${recipients.length} recipient(s).`);
  return { ok: true };
}

// Fire the channels scheduled at ONE minute, sharing a SINGLE PDF render across them.
// The PDF is built ONCE here (only if a firing channel actually has recipients) and the
// same buffer is handed to sendEmail/sendWhatsapp — so when both channels share a send
// minute we render one PDF, not two. The channels stay independent: a channel not
// scheduled at this minute (or with no recipients) simply isn't sent. Never throws.
// (On a build failure pdf stays null and each channel falls back to its own build+error,
// matching the manual test-send path.)
// Per-tenant staggering within a shared minute: a deterministic 0..STAGGER_SPAN_MS offset derived from
// the tenant id, so N tenants sharing 09:00 don't all enqueue at 09:00:00 (keeps the render backlog
// shallow). A daily report isn't latency-sensitive, so a few seconds' spread is free. No-op under test.
const STAGGER_SPAN_MS = 45_000;
function staggerMs(tenant) {
  if (process.env.PLANNR_TEST === '1' || process.env.PLANNR_NO_STAGGER === '1') return 0;
  return Math.abs(Math.imul(tenant | 0, 2654435761)) % STAGGER_SPAN_MS; // pseudo-uniform, clock-free
}
const staggerDelay = (tenant) => { const ms = staggerMs(tenant); return ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); };

// Fire ONE tenant's channels scheduled at ONE minute. That tenant's email+whatsapp still share a SINGLE
// render (the within-tenant dedupe holds — same household, same document); the cross-tenant render is
// what can't be shared. The render is queued (bounded concurrency), preceded by the per-tenant stagger.
async function fireAt(tenant, time, doEmail, doWa) {
  await staggerDelay(tenant);
  const cfg = getConfig(tenant); // read ONCE per fire; pass down so the senders don't re-read it
  const needEmail = doEmail && cfg.recipients.length > 0;
  const needWa = doWa && cfg.whatsappRecipients.length > 0;
  let pdf = null;
  if (needEmail || needWa) {
    try { pdf = await buildPdf(tenant); }
    catch (e) { console.error(`[daily-report] scheduled send (tenant ${tenant}, ${time}): PDF generation failed —`, (e && e.message) || e); }
  }
  if (doEmail) await sendEmail(tenant, `scheduled email send (${time})`, pdf, cfg);
  if (doWa) await sendWhatsapp(tenant, `scheduled WhatsApp send (${time})`, pdf, cfg);
}

// CRITICAL: tear down EVERY previously-scheduled job first, then create fresh ones — so
// repeated Saves never leave stale jobs behind. Schedules ONE cron job per DISTINCT
// minute across both channels' saved times (the union); each job fires whichever channels
// are set for that minute via fireAt(), which renders the shared PDF once. The two
// schedules stay independent (email-only and WhatsApp-only minutes each fire just their
// channel); the only change is that a minute both channels share renders one PDF, not two.
// No times -> idle. Called on save and at startup.
// Tenancy Phase 3 (Part C) — the households that MAY have a schedule = the distinct tenant_ids present
// in settings (a tenant with no settings row can't have recipients/times). Cheaper than every user, and
// it includes the sentinel tenant 0 used when there are no user rows (test/first-boot).
let scheduleTenantsStmt = null;
function scheduleTenants() { if (!scheduleTenantsStmt) scheduleTenantsStmt = db.prepare('SELECT DISTINCT tenant_id FROM settings'); return scheduleTenantsStmt.all().map((r) => r.tenant_id); }

// CRITICAL: tear down EVERY previously-scheduled job first, then create fresh ones. Now schedules ONE
// cron job per (TENANT, distinct-minute): each household's email+whatsapp union of send times, each job
// firing THAT tenant's channels via fireAt(tenant, ...). Renders go through the bounded queue, so N
// households sharing 09:00 never spawn more than RENDER_CONCURRENCY concurrent Chromium renders.
function reschedule() {
  for (const t of tasks) { try { t.stop(); } catch { /* ignore */ } }
  tasks = [];
  let totalE = 0, totalW = 0, households = 0;
  for (const tenant of scheduleTenants()) {
    const { sendTimes, whatsappSendTimes } = getConfig(tenant);
    if (!sendTimes.length && !whatsappSendTimes.length) continue; // this household has no schedule
    households++;
    const emailSet = new Set(sendTimes), waSet = new Set(whatsappSendTimes);
    for (const time of new Set([...sendTimes, ...whatsappSendTimes])) { // union of distinct minutes
      const expr = buildCronExpr(time);
      if (!expr || !cron.validate(expr)) continue;
      const doEmail = emailSet.has(time), doWa = waSet.has(time);
      if (doEmail) totalE++;
      if (doWa) totalW++;
      tasks.push(cron.schedule(expr, () => { fireAt(tenant, time, doEmail, doWa).catch((e) => console.error(`[daily-report] scheduled send (tenant ${tenant}, ${time}) crashed:`, e)); }, { timezone: TZ })); // Phase 10C — fire at IST wall-clock
    }
  }
  if (totalE || totalW) console.log(`[daily-report] scheduled ${totalE} EMAIL + ${totalW} WHATSAPP send(s) across ${households} household(s) IST (Asia/Kolkata), drained through a bounded render queue (concurrency ${RENDER_CONCURRENCY}).`);
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

// Bound on the boot catch-up's wait for the reused WhatsApp session to reach 'ready'. Sized 2026-07-31
// against real observations (not a guess): a HEALTHY reused-session connect reaches 'ready' within a
// few seconds (authenticated→ready seen in ~seconds earlier that day); a THROTTLED session, by
// contrast, holds at 'authenticated' indefinitely — observed past 28 min, and a full 10-min boot never
// reached 'ready'. So no bound can wait a stall out. This exists to FAIL FAST: 120s sits comfortably
// above a healthy connect (~8× margin, so a merely slow-but-healthy load still makes it) yet a
// throttled boot gives up quickly and its catch-up retries on the next boot.
const WA_CATCHUP_WAIT_MS = 120_000;

// Pure per-channel decision: is a catch-up due right now? Due iff the channel has recipients AND at
// least one send time AND its EARLIEST send time has already PASSED today (IST) AND no success has
// been recorded for today. All inputs are passed in, so this is testable without a real clock or DB.
function catchUpDue(cfg, { nowMin, today, lastEmail, lastWhatsapp }) {
  const due = (recipients, times, last) =>
    recipients.length > 0 && times.length > 0 && Math.min(...times.map(timeToMin)) < nowMin && last !== today;
  return { email: due(cfg.recipients, cfg.sendTimes, lastEmail), whatsapp: due(cfg.whatsappRecipients, cfg.whatsappSendTimes, lastWhatsapp) };
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
// yields one) on the next startup. Per channel, independent, at most once per day (the last-success
// date guards it). Renders a SINGLE PDF shared by both due channels, exactly as fireAt() does for a
// shared minute — no second render path. NEVER throws: any failure is logged and boot continues.
// PLANNR_NO_CATCHUP=1 disables it entirely (set in the test harness so the suite can't send at boot).
// `waitReady` (whatsapp.whenReady) is awaited ONLY when WhatsApp is due, so the reused session has
// time to reconnect before we send through it; email has no such dependency.
async function runCatchUp(waitReady) {
  if (process.env.PLANNR_NO_CATCHUP === '1') { console.log('[daily-report] catch-up disabled (PLANNR_NO_CATCHUP=1).'); return; }
  const today = istDateStamp();
  const nowMin = istNowMinutes();
  const hhmm = `${String(Math.floor(nowMin / 60)).padStart(2, '0')}:${String(nowMin % 60).padStart(2, '0')}`;
  let waited = false; // WhatsApp readiness is a SHARED, ONE-TIME wait (one client for the whole server)
  // Per household: independent catch-up decision + a queued render (bounded), so 100 due households at
  // boot never spawn 100 concurrent Chromium renders. NEVER throws: a per-tenant failure is logged.
  for (const tenant of scheduleTenants()) {
    try {
      const cfg = getConfig(tenant);
      const lastEmail = getSetting('daily_report_email_last_success', tenant);
      const lastWhatsapp = getSetting('daily_report_whatsapp_last_success', tenant);
      const due = catchUpDue(cfg, { nowMin, today, lastEmail, lastWhatsapp });
      const eReason = catchUpSkipReason(cfg.recipients, cfg.sendTimes, lastEmail, nowMin, today);
      const wReason = catchUpSkipReason(cfg.whatsappRecipients, cfg.whatsappSendTimes, lastWhatsapp, nowMin, today);
      console.log(`[daily-report] catch-up check (household ${tenant}, ${today} ${hhmm} IST): ` +
        `email ${due.email ? 'DUE — sending catch-up' : `not due (${eReason})`}; ` +
        `whatsapp ${due.whatsapp ? 'DUE — sending catch-up' : `not due (${wReason})`}.`);
      if (!due.email && !due.whatsapp) continue;
      if (due.whatsapp && !waited && typeof waitReady === 'function') {
        waited = true;
        const ready = await waitReady(WA_CATCHUP_WAIT_MS);
        if (!ready) console.error('[daily-report] catch-up: WhatsApp is not connected yet — catch-ups will be retried on the next boot.');
      }
      let pdf = null; // ONE queued render, shared by this tenant's channels (mirrors fireAt)
      try { pdf = await buildPdf(tenant); }
      catch (e) { console.error(`[daily-report] catch-up (household ${tenant}): PDF generation failed —`, (e && e.message) || e); }
      if (due.email) await sendEmail(tenant, `catch-up for ${today}`, pdf, cfg, { catchUp: true });
      if (due.whatsapp) await sendWhatsapp(tenant, `catch-up for ${today}`, pdf, cfg, { catchUp: true });
    } catch (e) {
      console.error(`[daily-report] catch-up (household ${tenant}) failed (continuing) —`, (e && e.message) || e);
    }
  }
}

function init(pdfFn, reportExtrasFn) { generatePdf = pdfFn; reportExtras = reportExtrasFn || null; migrateLegacyEmailTime(); reschedule(); }

module.exports = {
  init, getConfig, saveConfig, sendEmail, sendWhatsapp, buildCronExpr,
  // Phase 9 test seams — pure/validation internals + the scheduler, exported so the suite can test
  // them directly without sending anything. `_scheduledCount`/`_stopAll` let a test assert the cron
  // job count (one per distinct minute) and then stop the jobs so none can ever fire.
  cleanTimeList, makeTransport, reschedule, migrateLegacyEmailTime, fireAt, PHONE_RE, EMAIL_RE, normPhone, istDateStamp, TZ,
  // Phase 11A — boot catch-up: pure decision + orchestrator + success recorder + browser-facing status.
  istNowMinutes, catchUpDue, runCatchUp, noteSuccess, sendStatus,
  // Phase 2 — attempt recording, staleness, next-fire, boot summary, and the WhatsApp→email alert decision.
  recordAttempt, lastAttempt, isStale, istDaysBetween, addIstDays, istStampFull, nextFireIST, bootSummaryLine,
  whatsappAlertShouldFire, whatsappAlertedToday, noteWhatsappAlert,
  _scheduledCount: () => tasks.length,
  _stopAll: () => { for (const t of tasks) { try { t.stop(); } catch { /* ignore */ } } tasks = []; },
  // Tenancy Phase 3 (Part C) — the bounded render queue + tenant list, exported so the suite can verify
  // that N tenants sharing a minute never exceed RENDER_CONCURRENCY concurrent renders (no real sends).
  enqueueRender, renderQueueState, tenants, scheduleTenants, buildPdf, primaryTenant,
};
