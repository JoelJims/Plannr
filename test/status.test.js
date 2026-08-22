// Phase 2 — make failures visible. Records the outcome of every send attempt, flags stale channels,
// and exposes /api/health. NONE of these tests send: makeTransport is null under PLANNR_TEST.
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
  // No recordAttempt (sent/failed/skipped) may ever touch last-success — only noteSuccess does.
  assert.equal(getSetting('daily_report_email_last_success'), null);
});

test('the send paths record the right outcome (email, no recipients -> skipped)', async () => {
  await dr.sendEmail(dr.primaryTenant(), 'unit');
  assert.equal(dr.lastAttempt('email').outcome, 'skipped');
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
  });
  const r = await H.get('/api/health', { cookie });
  assert.equal(r.status, 200);
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('secret.person@gmail.com'), 'no email address');
  assert.ok(!body.includes('@'), 'no @ anywhere (so no addresses at all)');
  assert.equal(r.json.channels.email.configured, true);
  assert.equal(r.json.channels.email.recipientCount, 1, 'a count, not the address');
  assert.deepEqual(r.json.channels.email.sendTimes, ['09:00'], 'HH:MM only — not PII');
  assert.ok(r.json.csp === 'enforcing' || r.json.csp === 'report-only');
  assert.ok(r.json.serverStart, 'server start time present');
});

test('PLANNR_NO_CATCHUP=1 suppresses the boot catch-up entirely — no attempt recorded, nothing sent', async () => {
  dr.saveConfig({ recipients: ['x@gmail.com'], sendTimes: ['00:01'] }); // would be "due", but catch-up is disabled in tests
  await dr.runCatchUp(async () => true);
  assert.equal(dr.lastAttempt('email'), null, 'no send was attempted under PLANNR_NO_CATCHUP');
});

test('bootSummaryLine states configured/last-success/last-attempt in one line', () => {
  dr.saveConfig({ recipients: ['a@gmail.com'], sendTimes: ['09:00'] });
  dr.recordAttempt('email', 'sent');
  const line = dr.bootSummaryLine();
  assert.match(line, /EMAIL: configured/);
  assert.match(line, /last attempt sent/);
});
