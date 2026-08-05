// Tenancy Phase 3 (Part C) — the per-tenant scheduler + the bounded, non-shedding render queue.
// Confirms that N households sharing a minute NEVER exceed RENDER_CONCURRENCY concurrent Chromium
// renders (the old bug: the scheduler called generateOverviewPdf directly, unbounded), that every
// enqueued render still completes (non-shedding — no 503, no drop), and that reschedule() creates one
// cron job per (tenant, minute) across households. NOTHING is sent (a stub render replaces Chromium).
const H = require('./helpers');
const dr = require('../daily-report');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); });
after(async () => { dr._stopAll(); await H.stopApp(); });
afterEach(() => { dr._stopAll(); H.clearLedger(); }); // clear settings so a prior test's schedule doesn't leak in

// Drive N renders through the bounded queue with a stub that tracks PEAK concurrency.
async function drive(n) {
  let active = 0, peak = 0, done = 0;
  dr.init(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 3)); // hold the "render" briefly so overlap is observable
    active--; done++;
    return Buffer.from('%PDF-1.4 stub');
  });
  await Promise.all(Array.from({ length: n }, (_, i) => dr.buildPdf(i + 1))); // one render per tenant
  return { peak, done };
}

test('bounded queue: 5 households sharing a minute never exceed concurrency 2, and all 5 complete', async () => {
  const { peak, done } = await drive(5);
  assert.ok(peak <= dr.renderQueueState().concurrency, `peak ${peak} <= ${dr.renderQueueState().concurrency}`);
  assert.strictEqual(done, 5, 'every render completed (non-shedding — none dropped)');
});

test('bounded queue: 20 households never exceed concurrency 2, and all 20 complete (no shedding)', async () => {
  const { peak, done } = await drive(20);
  assert.ok(peak <= dr.renderQueueState().concurrency, `peak ${peak} <= ${dr.renderQueueState().concurrency}`);
  assert.strictEqual(done, 20, 'all 20 renders completed — enqueue-and-wait, never 503-shed');
  assert.strictEqual(dr.renderQueueState().queued, 0, 'queue fully drained');
});

test('reschedule schedules one job per (tenant, minute) across households', () => {
  dr.init(() => Promise.resolve(Buffer.from('%PDF'))); // stub; no sends
  // Two households, each with an email time; one also has a WhatsApp time at a DISTINCT minute.
  dr.saveConfig({ recipients: ['a@gmail.com'], sendTimes: ['09:00'] }, 101);
  dr.saveConfig({ recipients: ['b@gmail.com'], sendTimes: ['09:00'], whatsappRecipients: ['+919999999999'], whatsappSendTimes: ['18:30'] }, 202);
  // tenant 101: one minute (09:00). tenant 202: two distinct minutes (09:00, 18:30). Total = 3 jobs.
  assert.strictEqual(dr._scheduledCount(), 3, 'one cron job per (tenant, distinct-minute)');
  dr._stopAll();
});

test('a tenant with no schedule contributes no jobs (idle)', () => {
  dr.init(() => Promise.resolve(Buffer.from('%PDF')));
  dr.saveConfig({ recipients: [], sendTimes: [] }, 303); // configured empty
  assert.strictEqual(dr._scheduledCount(), 0, 'no times -> no jobs for that household');
  dr._stopAll();
});
