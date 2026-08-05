// Notification config — pure config/validation/scheduling logic. NEVER sends: makeTransport is null
// under PLANNR_TEST and no WhatsApp client is ever booted; cron jobs are counted then stopped.
const H = require('./helpers');
const dr = require('../daily-report');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(() => { assert.strictEqual(dr.makeTransport(), null, 'guard: no transport may be constructible in tests'); });
after(() => { dr._stopAll(); });
beforeEach(() => { H.clearLedger(); dr._stopAll(); });

test('getConfig reads/writes both channels independently; saving one does not touch the other', () => {
  dr.saveConfig({ recipients: ['keep@gmail.com'] });
  assert.deepStrictEqual(dr.getConfig().recipients, ['keep@gmail.com']);
  assert.deepStrictEqual(dr.getConfig().whatsappRecipients, [], 'whatsapp untouched by an email-only save');
  dr.saveConfig({ whatsappRecipients: ['+919999999999'] });
  const c = dr.getConfig();
  assert.deepStrictEqual(c.recipients, ['keep@gmail.com'], 'email recipients survived a whatsapp-only save');
  assert.deepStrictEqual(c.whatsappRecipients, ['+919999999999']);
  dr.saveConfig({ sendTimes: ['09:00'] });
  assert.deepStrictEqual(dr.getConfig().whatsappSendTimes, [], 'whatsapp times untouched by an email-times save');
});

test('legacy daily_report_time fallback works when daily_report_times is absent', () => {
  H.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (COALESCE((SELECT MIN(id) FROM users), 0), 'daily_report_time', '09:30') ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value").run();
  assert.deepStrictEqual(dr.getConfig().sendTimes, ['09:30'], 'single legacy time is migrated on read');
});

test('cleanTimeList rejects malformed times and enforces the five-time cap', () => {
  assert.ok(dr.cleanTimeList(['25:00']).error, 'reject hour > 23');
  assert.ok(dr.cleanTimeList(['9:5']).error, 'reject non-HH:MM');
  assert.ok(dr.cleanTimeList(['abc']).error, 'reject garbage');
  assert.ok(dr.cleanTimeList(['01:00', '02:00', '03:00', '04:00', '05:00', '06:00']).error, 'reject > 5 times');
  assert.deepStrictEqual(dr.cleanTimeList(['09:00', '08:00', '09:00']).times, ['08:00', '09:00'], 'de-dupe + sort');
});

test('the phone validation regex accepts and rejects correctly', () => {
  for (const ok of ['+919876543210', '919876543210', '12345678', '+12345678901234']) assert.ok(dr.PHONE_RE.test(ok), `should accept ${ok}`);
  for (const bad of ['1234567', 'abc', '+', '12345678901234567', '+91 9876543210']) assert.ok(!dr.PHONE_RE.test(bad), `should reject ${bad}`);
});

test('reschedule creates one cron job per distinct minute across the union — and none fires / no transport', () => {
  dr.saveConfig({ sendTimes: ['09:00', '10:00'], whatsappSendTimes: ['10:00', '11:00'] }); // union = 09:00,10:00,11:00
  assert.strictEqual(dr._scheduledCount(), 3, 'one job per DISTINCT minute across both schedules');
  dr.saveConfig({ sendTimes: [], whatsappSendTimes: [] });
  assert.strictEqual(dr._scheduledCount(), 0, 'clearing both schedules leaves the scheduler idle');
  assert.strictEqual(dr.makeTransport(), null, 'still structurally unable to build a transport');
  assert.strictEqual(require('../whatsapp').isReady(), false, 'no WhatsApp client was ever booted');
});
