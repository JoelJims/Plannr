// Phase 2 — make failures visible. Records the outcome of every send attempt, flags stale channels,
// exposes /api/health, and caps the WhatsApp→email alert. NONE of these tests send: makeTransport is
// null under PLANNR_TEST and no WhatsApp client is ever booted.
const H = require('./helpers');
const dr = require('../daily-report');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(() => { assert.strictEqual(dr.makeTransport(), null, 'guard: no transport may be constructible in tests'); });
after(async () => { dr._stopAll(); await H.stopApp(); });
beforeEach(() => { H.clearLedger(); dr._stopAll(); });

const getSetting = (k) => { const r = H.db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };

test('recordAttempt records sent / failed / skipped, and NEVER writes the last-success date', () => {
  dr.recordAttempt('email', 'sent');
  assert.equal(dr.lastAttempt('email').outcome, 'sent');
  dr.recordAttempt('email', 'failed', 'SMTP rejected');
  const la = dr.lastAttempt('email');
  assert.equal(la.outcome, 'failed');
  assert.equal(la.reason, 'SMTP rejected');
  assert.match(la.atIST, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} IST$/, 'IST timestamp');
  dr.recordAttempt('whatsapp', 'skipped', 'not connected');
  assert.equal(dr.lastAttempt('whatsapp').outcome, 'skipped');
  // No recordAttempt (sent/failed/skipped) may ever touch last-success — only noteSuccess does.
  assert.equal(getSetting('daily_report_email_last_success'), null);
  assert.equal(getSetting('daily_report_whatsapp_last_success'), null);
});

test('the send paths record the right outcome; a client-not-ready WhatsApp records SKIPPED with a reason', async () => {
  // email, no recipients -> skipped
  await dr.sendEmail(dr.primaryTenant(), 'unit');
  assert.equal(dr.lastAttempt('email').outcome, 'skipped');
  // WhatsApp configured but the client was never booted (PLANNR_TEST) -> couldn't attempt -> skipped
  dr.saveConfig({ whatsappRecipients: ['+919999999999'], whatsappSendTimes: ['08:00'] });
  const r = await dr.sendWhatsapp(dr.primaryTenant(), 'scheduled WhatsApp send (08:00)');
  assert.equal(r.ok, false);
  const la = dr.lastAttempt('whatsapp');
  assert.equal(la.outcome, 'skipped', 'client-not-ready is a skip, not a failure');
  assert.match(la.reason, /not connected/i);
  assert.equal(dr.sendStatus().whatsapp.lastSuccess, null, 'a non-send never advances last-success');
});

test('attempt history stays bounded to the last few (a status indicator, not a log)', () => {
  for (let i = 0; i < 12; i++) dr.recordAttempt('email', 'skipped', 'r' + i);
  const arr = JSON.parse(getSetting('daily_report_email_attempts'));
  assert.ok(arr.length <= 5, 'bounded to <= 5 attempts');
  assert.equal(arr[arr.length - 1].reason, 'r11', 'keeps the newest');
  assert.equal(arr[0].reason, 'r7', 'drops the oldest beyond the cap');
});

test('stale flag fires at/after the threshold and not before, on the IST day boundary', () => {
  const today = '2026-08-10';
  const c = { configured: true };
  assert.equal(dr.isStale({ ...c, lastSuccess: '2026-08-10', today }), false, 'same day -> fresh');
  assert.equal(dr.isStale({ ...c, lastSuccess: '2026-08-09', today }), false, '1 IST day -> below threshold');
  assert.equal(dr.isStale({ ...c, lastSuccess: '2026-08-08', today }), true, '2 IST days (~48h+) -> stale');
  assert.equal(dr.isStale({ ...c, lastSuccess: '2026-08-01', today }), true, 'long gap -> stale');
  assert.equal(dr.isStale({ configured: true, lastSuccess: null, today }), true, 'configured but never succeeded -> stale');
  assert.equal(dr.isStale({ configured: false, lastSuccess: null, today }), false, 'not configured -> never stale');
});

test('GET /api/health: 401 unauthenticated, and leaks NO recipient addresses or phone numbers', async () => {
  await H.startApp();
  const un = await H.get('/api/health');
  assert.equal(un.status, 401, 'auth-gated');

  const { cookie } = H.seedLoggedIn();
  dr.saveConfig({
    recipients: ['secret.person@gmail.com'], sendTimes: ['09:00'],
    whatsappRecipients: ['+919812345678'], whatsappSendTimes: ['08:00'],
  });
  const r = await H.get('/api/health', { cookie });
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('secret.person@gmail.com'), 'no email address');
  assert.ok(!body.includes('@'), 'no @ anywhere (so no addresses at all)');
  assert.ok(!body.includes('919812345678') && !body.includes('9812345678'), 'no phone number');
  assert.equal(r.json.channels.email.configured, true);
  assert.equal(r.json.channels.email.recipientCount, 1, 'a count, not the address');
  assert.deepEqual(r.json.channels.email.sendTimes, ['09:00'], 'HH:MM only — not PII');
  assert.equal(r.json.channels.whatsapp.ready, false, 'no client booted -> not ready');
  assert.ok(typeof r.json.channels.whatsapp.nextFire === 'string');
  assert.ok(r.json.csp === 'enforcing' || r.json.csp === 'report-only');
  assert.ok(r.json.serverStart, 'server start time present');
});

test('WhatsApp-failure email: hard-capped one per day, and never triggers for an email failure', async () => {
  // Pure decision covers the cap + the trigger conditions.
  assert.equal(dr.whatsappAlertShouldFire({ problem: true, emailConfigured: true, alertedToday: false }), true);
  assert.equal(dr.whatsappAlertShouldFire({ problem: true, emailConfigured: true, alertedToday: true }), false, 'already alerted today -> capped');
  assert.equal(dr.whatsappAlertShouldFire({ problem: false, emailConfigured: true, alertedToday: false }), false, 'no problem -> no alert');
  assert.equal(dr.whatsappAlertShouldFire({ problem: true, emailConfigured: false, alertedToday: false }), false, 'email not working -> no alert');
  // Cap round-trips through settings.
  assert.equal(dr.whatsappAlertedToday(), false);
  dr.noteWhatsappAlert();
  assert.equal(dr.whatsappAlertedToday(), true, 'once noted, the day is consumed');
  // An EMAIL failure/skip must NEVER touch the WhatsApp alert cap (email can't report its own failure).
  H.clearLedger();
  dr.saveConfig({ recipients: ['x@gmail.com'], sendTimes: ['09:00'] });
  await dr.sendEmail(dr.primaryTenant(), 'unit email that cannot send (no transport under test)');
  assert.equal(dr.lastAttempt('email').outcome, 'skipped', 'email could not attempt -> skipped');
  assert.equal(dr.whatsappAlertedToday(), false, 'the email path never consumed the WhatsApp alert slot');
});

test('PLANNR_NO_CATCHUP=1 suppresses the boot catch-up entirely — no attempt recorded, nothing sent', async () => {
  dr.saveConfig({ recipients: ['x@gmail.com'], sendTimes: ['00:01'] }); // would be "due", but catch-up is disabled in tests
  await dr.runCatchUp(async () => true);
  assert.equal(dr.lastAttempt('email'), null, 'no send was attempted under PLANNR_NO_CATCHUP');
});

test('bootSummaryLine states each channel configured/last-success/last-attempt in one line', () => {
  dr.saveConfig({ recipients: ['a@gmail.com'], sendTimes: ['09:00'] });
  dr.recordAttempt('email', 'sent');
  const line = dr.bootSummaryLine();
  assert.match(line, /EMAIL: configured/);
  assert.match(line, /WHATSAPP: NOT configured/);
  assert.match(line, /last attempt sent/);
});
