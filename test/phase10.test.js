// Phase 10 — timezone (IST), the date stamp, zero-times scheduling, migration.
// None of these send anything (PLANNR_TEST => makeTransport null).
const H = require('./helpers');
const dr = require('../daily-report');
const cron = require('node-cron');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(() => { assert.strictEqual(dr.makeTransport(), null, 'guard: no transport constructible in tests'); });
after(() => { dr._stopAll(); });
beforeEach(() => { H.clearLedger(); dr._stopAll(); });

const nextRunUtc = (hhmm, tz) => { const t = cron.schedule(dr.buildCronExpr(hhmm), () => {}, { timezone: tz }); const n = t.getNextRun(); try { t.destroy(); } catch { try { t.stop(); } catch {} } return n; };

test('a stored 08:00 fires at 08:00 IST (02:30 UTC) — a different instant than a UTC/server would give', () => {
  const ist = nextRunUtc('08:00', dr.TZ);
  const utc = nextRunUtc('08:00', 'UTC');
  assert.strictEqual(ist.getUTCHours(), 2, 'IST 08:00 == 02:30 UTC (hour)');
  assert.strictEqual(ist.getUTCMinutes(), 30, 'IST 08:00 == 02:30 UTC (minute)');
  // The zone offset is proven by the two wall-clock fire times themselves: a UTC-scheduled 08:00 fires
  // at 08:00 UTC, the IST-scheduled 08:00 at 02:30 UTC — 5:30h apart. Assert the clock times directly
  // rather than subtracting the raw instants: getNextRun() is relative to NOW, so when the two next
  // runs fall on different calendar days (now between 02:30 and 08:00 UTC) the instant difference wraps
  // to -1110 instead of +330. The wall-clock check is day-independent and proves the same thing.
  assert.strictEqual(utc.getUTCHours(), 8, 'a UTC-scheduled 08:00 fires at 08:00 UTC');
  assert.strictEqual(utc.getUTCMinutes(), 0, 'on the hour — 5:30h after the IST fire, so the zone is honoured');
});

test('the report date stamp is the IST date, even when UTC and IST fall on different days', () => {
  // 2026-07-30T19:00:00Z == 2026-07-31 00:30 IST — a UTC stamp would read the previous day.
  const d = new Date('2026-07-30T19:00:00Z');
  assert.strictEqual(dr.istDateStamp(d), '2026-07-31', 'IST calendar date');
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-07-30', 'the old UTC stamp would have been a day early');
  // (sendEmail's filename+subject derive from istDateStamp().)
});

test('a channel with recipients and ZERO send times creates zero cron jobs (the warning condition)', () => {
  dr.saveConfig({ recipients: ['a@gmail.com', 'b@gmail.com'], sendTimes: [] });
  const cfg = dr.getConfig();
  assert.strictEqual(cfg.recipients.length, 2);
  assert.strictEqual(cfg.sendTimes.length, 0);
  assert.strictEqual(dr._scheduledCount(), 0, 'recipients but no times -> nothing scheduled (Home shows the warning)');
});

test('legacy email-time migration writes the list, clears the old key, and is idempotent across two boots', () => {
  H.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (COALESCE((SELECT MIN(id) FROM users), 0), 'daily_report_time', '07:30')").run();
  assert.strictEqual(dr.migrateLegacyEmailTime(), true, 'boot 1 migrates');
  assert.deepStrictEqual(dr.getConfig().sendTimes, ['07:30'], 'written as a one-element list');
  assert.strictEqual(H.db.prepare("SELECT value FROM settings WHERE key='daily_report_time'").get().value, '', 'legacy key cleared');
  assert.strictEqual(dr.migrateLegacyEmailTime(), false, 'boot 2 is a no-op (idempotent)');
  assert.deepStrictEqual(dr.getConfig().sendTimes, ['07:30'], 'list unchanged on the second boot');
});
