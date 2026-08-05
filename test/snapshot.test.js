// Phase 11A — WhatsApp snapshot completeness guard. Pure decision + marker round-trip only; the real
// robocopy end-to-end (live-skip vs stopped-replace) is exercised by test-ui/snapshot-verify.js (it
// shells out to robocopy — too slow/Windows-specific + real FS for the fast node:test suite).
const H = require('./helpers'); // sets PLANNR_TEST etc. before any app require
const whatsapp = require('../whatsapp');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');

test('snapshotDecision: a browser-CLOSED snapshot always runs (only it can be complete)', () => {
  assert.equal(whatsapp.snapshotDecision({ browserClosed: true, existingComplete: true }).action, 'run');
  assert.equal(whatsapp.snapshotDecision({ browserClosed: true, existingComplete: false }).action, 'run');
});

test('snapshotDecision: a LIVE-browser snapshot is REFUSED when a complete one already exists', () => {
  const d = whatsapp.snapshotDecision({ browserClosed: false, existingComplete: true });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /COMPLETE/);
});

test('snapshotDecision: a LIVE-browser snapshot bootstraps when no complete one exists yet', () => {
  assert.equal(whatsapp.snapshotDecision({ browserClosed: false, existingComplete: false }).action, 'run');
});

test('PLANNR_NO_WHATSAPP=1 makes init() a clean no-op — constructs no client (Phase 11C)', () => {
  const savedTest = process.env.PLANNR_TEST;
  delete process.env.PLANNR_TEST;               // remove the OTHER no-op so we exercise NO_WHATSAPP specifically
  process.env.PLANNR_NO_WHATSAPP = '1';
  try {
    whatsapp.init();                             // returns BEFORE requiring whatsapp-web.js -> no client, no Chromium
    assert.equal(whatsapp._hasClient(), false, 'no whatsapp-web.js client may be constructed');
    assert.equal(whatsapp.isReady(), false);
    assert.equal(whatsapp.everReady(), false);
  } finally {
    delete process.env.PLANNR_NO_WHATSAPP;
    if (savedTest !== undefined) process.env.PLANNR_TEST = savedTest;
  }
});

test('completeness marker round-trips via a sibling file; absent reads as not-complete', () => {
  const dst = path.join(os.tmpdir(), 'plannr-snap-' + crypto.randomBytes(4).toString('hex'));
  try {
    assert.equal(whatsapp.readSnapshotMarker(dst), null, 'no marker -> null');
    assert.equal(whatsapp.snapshotIsComplete(dst), false);
    whatsapp.writeSnapshotMarker(dst, true, 3);
    assert.equal(whatsapp.snapshotIsComplete(dst), true, 'complete=true marker -> complete');
    assert.equal(whatsapp.readSnapshotMarker(dst).code, 3);
    whatsapp.writeSnapshotMarker(dst, false, 11);
    assert.equal(whatsapp.snapshotIsComplete(dst), false, 'an incomplete (code 11) marker -> not complete');
    // the marker is a SIBLING (dst + ".state.json"), not inside the dir, so robocopy /PURGE can't delete it
    assert.ok(fs.existsSync(dst + '.state.json'));
  } finally { try { fs.unlinkSync(dst + '.state.json'); } catch { /* ignore */ } }
});
