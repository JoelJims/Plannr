// Phase 11B — the console-independent graceful stop. The sentinel watcher must (a) remove a STALE
// sentinel on setup so a leftover can't stop a fresh boot, and (b) route a freshly-created sentinel
// into the SAME stop callback the signal handlers use. In boot, watchStopSentinel(STOP_SENTINEL,
// shutdown) is wired to the same shutdown() as process.on('SIGINT'/'SIGTERM') — the test drives that
// wiring with a spy callback (calling the real shutdown() would process.exit the test runner).
const H = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpSentinel = () => path.join(os.tmpdir(), 'plannr-stop-' + crypto.randomBytes(4).toString('hex'));

test('a STALE sentinel is removed on setup and does NOT stop a fresh boot', async () => {
  const p = tmpSentinel();
  fs.writeFileSync(p, 'leftover');              // a sentinel left behind by a previous run
  let stops = 0;
  const timer = H.app._watchStopSentinel(p, () => { stops++; }, 25);
  await delay(120);                             // several poll intervals
  assert.equal(fs.existsSync(p), false, 'the stale sentinel must be removed on setup');
  assert.equal(stops, 0, 'a stale sentinel must NOT trigger a stop on a fresh boot');
  clearInterval(timer);
});

test('creating the sentinel triggers the stop callback exactly once (same path as SIGINT)', async () => {
  const p = tmpSentinel();
  let stops = 0;
  const timer = H.app._watchStopSentinel(p, () => { stops++; }, 25); // boot passes shutdown() here
  await delay(90);
  assert.equal(stops, 0, 'no stop before the sentinel appears');
  fs.writeFileSync(p, 'stop');                  // stop-plannr.cmd does exactly this
  await delay(140);
  assert.equal(stops, 1, 'the sentinel must invoke the stop callback exactly once — the boot wires it to the same shutdown() as SIGINT');
  clearInterval(timer);
  try { fs.unlinkSync(p); } catch { /* ignore */ }
});
