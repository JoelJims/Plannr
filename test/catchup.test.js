// Phase 11A — Daily Report boot catch-up. NONE of these send: they exercise the pure decision
// (catchUpDue), the IST-day/minute helpers, the write-only-on-success recorder, and the
// PLANNR_NO_CATCHUP suppression. sendEmail here runs under PLANNR_TEST, where the transport is
// null — so a "failure"/"skip" is structurally incapable of delivering anything, which is exactly
// what the unwritten-date cases assert.
const H = require('./helpers');
const dailyReport = require('../daily-report');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(() => H.startApp());
after(() => H.stopApp());
beforeEach(() => H.clearLedger());

const cfgOf = (o = {}) => ({
  recipients: o.recipients || [], sendTimes: o.sendTimes || [],
});

test('due channel with no success today fires; a success today suppresses it', () => {
  const cfg = cfgOf({ recipients: ['a@gmail.com'], sendTimes: ['09:00'] });
  // earliest (09:00) has passed by 10:00; last success was yesterday -> DUE
  assert.equal(dailyReport.catchUpDue(cfg, { nowMin: 600, today: '2026-07-31', lastEmail: '2026-07-30' }).email, true);
  // same channel after a success TODAY -> not due
  assert.equal(dailyReport.catchUpDue(cfg, { nowMin: 600, today: '2026-07-31', lastEmail: '2026-07-31' }).email, false);
});

test('four days of downtime yields exactly one catch-up (then none until tomorrow)', () => {
  const cfg = cfgOf({ recipients: ['a@gmail.com'], sendTimes: ['09:00'] });
  // 4 days since the last success, earliest passed -> DUE once (a single boolean, not a backlog of 4)
  assert.equal(dailyReport.catchUpDue(cfg, { nowMin: 600, today: '2026-07-31', lastEmail: '2026-07-27' }).email, true);
  // once today's catch-up succeeds, last_success becomes today -> a second boot the same day does NOT re-fire
  assert.equal(dailyReport.catchUpDue(cfg, { nowMin: 601, today: '2026-07-31', lastEmail: '2026-07-31' }).email, false);
});

test('recipients-but-zero-times does not fire; a future-only send time does not fire', () => {
  assert.equal(dailyReport.catchUpDue(cfgOf({ recipients: ['a@gmail.com'], sendTimes: [] }),
    { nowMin: 600, today: '2026-07-31', lastEmail: null }).email, false);
  assert.equal(dailyReport.catchUpDue(cfgOf({ recipients: ['a@gmail.com'], sendTimes: ['23:59'] }),
    { nowMin: 600, today: '2026-07-31', lastEmail: null }).email, false);
});

test('a boot at 00:30 IST evaluates the correct IST day (not the UTC day)', () => {
  // 2026-07-30T19:00:00Z == 2026-07-31 00:30 IST — the UTC day is still the 30th.
  const inst = new Date('2026-07-30T19:00:00Z');
  assert.equal(dailyReport.istDateStamp(inst), '2026-07-31', 'IST date must have rolled to the 31st');
  assert.equal(dailyReport.istNowMinutes(inst), 30, '00:30 IST -> 30 minutes past midnight');
  const cfg = cfgOf({ recipients: ['a@gmail.com'], sendTimes: ['00:15'] });
  // 00:15 has passed (15 < 30); last success was the 30th (yesterday, IST) -> DUE for the 31st
  assert.equal(dailyReport.catchUpDue(cfg, { nowMin: 30, today: '2026-07-31', lastEmail: '2026-07-30' }).email, true);
  // had the day been read as UTC (the 30th), last_success '2026-07-30' would wrongly read as "today" -> not due
  assert.equal(dailyReport.catchUpDue(cfg, { nowMin: 30, today: '2026-07-30', lastEmail: '2026-07-30' }).email, false);
});

test('a skip and a failure both leave the last-success date UNWRITTEN, so the next boot retries', async () => {
  // SKIP — no recipients: sendEmail returns {ok:false, skipped} and nothing is recorded.
  dailyReport.saveConfig({ recipients: [], sendTimes: ['09:00'] });
  const skip = await dailyReport.sendEmail(dailyReport.primaryTenant(), 'test skip');
  assert.equal(skip.skipped, true);
  assert.equal(dailyReport.sendStatus().email.lastSuccess, null, 'a skip must not write the date');

  // FAILURE — recipients present but under PLANNR_TEST makeTransport() is null: {ok:false, error}, no send.
  dailyReport.saveConfig({ recipients: ['a@gmail.com'] });
  const fail = await dailyReport.sendEmail(dailyReport.primaryTenant(), 'test failure');
  assert.equal(fail.ok, false);
  assert.ok(fail.error, 'a failure returns an error, not a success');
  assert.equal(dailyReport.sendStatus().email.lastSuccess, null, 'a failure must not write the date');

  // so the channel is still DUE -> the next boot retries.
  assert.equal(dailyReport.catchUpDue(dailyReport.getConfig(), { nowMin: 1439, today: '2026-07-31', lastEmail: null }).email, true);
});

test('noteSuccess records today (IST); the catchUp variant also stamps the catch-up date', () => {
  const today = dailyReport.istDateStamp();
  dailyReport.noteSuccess('email', {});                 // ordinary success
  assert.equal(dailyReport.sendStatus().email.lastSuccess, today);
  assert.equal(dailyReport.sendStatus().email.lastCatchup, null, 'a non-catch-up success must not set the catchup date');
  dailyReport.noteSuccess('email', { catchUp: true });  // catch-up success
  assert.equal(dailyReport.sendStatus().email.lastCatchup, today);
});

test('PLANNR_NO_CATCHUP=1 suppresses the boot catch-up entirely (no send, no write)', async () => {
  // the harness sets PLANNR_NO_CATCHUP=1 for the whole run; configure a channel that WOULD be due.
  dailyReport.saveConfig({ recipients: ['a@gmail.com'], sendTimes: ['00:01'] });
  assert.equal(process.env.PLANNR_NO_CATCHUP, '1');
  await dailyReport.runCatchUp(); // must return immediately
  assert.equal(dailyReport.sendStatus().email.lastSuccess, null, 'suppressed catch-up must not send or record anything');
});

test('runCatchUp never throws and, under the test transport, records nothing (no real send)', async () => {
  delete process.env.PLANNR_NO_CATCHUP; // allow it to run its decision this once
  try {
    dailyReport.saveConfig({ recipients: ['a@gmail.com'], sendTimes: ['00:01'] }); // email may be due (00:01 passed)
    await assert.doesNotReject(dailyReport.runCatchUp(), 'runCatchUp must never throw into boot');
    // under PLANNR_TEST the transport is null, so even a due email cannot be delivered -> nothing recorded.
    assert.equal(dailyReport.sendStatus().email.lastSuccess, null);
  } finally {
    process.env.PLANNR_NO_CATCHUP = '1'; // restore the harness default
  }
});
