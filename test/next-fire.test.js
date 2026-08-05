// nextFireIST wrap-to-tomorrow (daily-report.js ~120). nextFireIST IS exported, and its signature is
// nextFireIST(times, nowMin = istNowMinutes(), today = istDateStamp()) — the last two params are the
// clock, so passing them explicitly makes this fully deterministic with NO real time dependency and no
// indirection through /api/health.
// (helpers is required FIRST so db.js binds to the temp DB, per its contract — daily-report pulls in db.)
const H = require('./helpers');
const dr = require('../daily-report');
const { test, after } = require('node:test');
const assert = require('node:assert');

after(async () => { await H.stopApp(); }); // no server started; this just stops any load-time cron timers

const min = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const TODAY = '2026-08-10';
const TOMORROW = '2026-08-11';

test('empty/absent times -> null', () => {
  assert.strictEqual(dr.nextFireIST([], min('10:00'), TODAY), null);
  assert.strictEqual(dr.nextFireIST(null, min('10:00'), TODAY), null);
});

test('picks the next time later TODAY when one remains', () => {
  assert.strictEqual(dr.nextFireIST(['08:00', '20:00'], min('10:00'), TODAY), `${TODAY} 20:00 IST`);
});

test('wraps to TOMORROW\'s earliest time when now is past the last', () => {
  assert.strictEqual(dr.nextFireIST(['08:00', '20:00'], min('23:00'), TODAY), `${TOMORROW} 08:00 IST`);
});

test('a time exactly equal to now does NOT count (strictly later) -> wraps to tomorrow', () => {
  assert.strictEqual(dr.nextFireIST(['08:00'], min('08:00'), TODAY), `${TOMORROW} 08:00 IST`);
});

test('unsorted input is handled: wraps to the earliest time tomorrow', () => {
  assert.strictEqual(dr.nextFireIST(['20:00', '08:00'], min('23:00'), TODAY), `${TOMORROW} 08:00 IST`);
});
