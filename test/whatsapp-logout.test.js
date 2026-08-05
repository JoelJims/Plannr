// Part C — a remote logout must not crash the server. These exercise the pure/ordered cleanup pieces
// of whatsapp.js without launching a real client (the suite can never boot WhatsApp): the reason gate
// (only 'LOGOUT' cleans up — a network drop must not), the tolerant recursive remove (a locked file is
// skipped, siblings still go, degrades to "not fully gone"), and the orchestrator (browser closed
// FIRST, never throws, degrades on a locked file).
const H = require('./helpers'); // sets PLANNR_TEST etc. before any app require
const whatsapp = require('../whatsapp');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');

// A throwaway session-shaped tree: root/session/{a.bin, Default/b.bin}
function tmpTree() {
  const root = path.join(os.tmpdir(), 'plannr-logout-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(path.join(root, 'session', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(root, 'session', 'a.bin'), 'x');
  fs.writeFileSync(path.join(root, 'session', 'Default', 'b.bin'), 'y');
  return root;
}
// Make fs.unlinkSync throw EBUSY for ONE path (simulate the file a running Chromium still holds).
function lockFile(target) {
  const real = fs.unlinkSync;
  fs.unlinkSync = (p) => {
    if (path.resolve(p) === path.resolve(target)) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
    return real(p);
  };
  return () => { fs.unlinkSync = real; try { real(target); } catch { /* ignore */ } };
}

test('shouldCleanupOnDisconnect: ONLY "LOGOUT" triggers cleanup — network/state reasons never do', () => {
  assert.equal(whatsapp.shouldCleanupOnDisconnect('LOGOUT'), true);
  for (const r of ['TIMEOUT', 'CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE', 'Max qrcode retries reached', 'NAVIGATION', undefined, null, '']) {
    assert.equal(whatsapp.shouldCleanupOnDisconnect(r), false, `reason "${r}" must NOT trigger a session wipe`);
  }
});

test('rmTolerant: removes a full session tree and reports it gone', () => {
  const root = tmpTree();
  assert.equal(whatsapp.rmTolerant(root), true);
  assert.equal(fs.existsSync(root), false);
});

test('rmTolerant: a locked file is skipped, siblings still removed, reports NOT fully gone — never throws', () => {
  const root = tmpTree();
  const locked = path.join(root, 'session', 'Default', 'b.bin');
  const restore = lockFile(locked);
  let gone;
  try { gone = whatsapp.rmTolerant(root); } finally { restore(); }
  assert.equal(gone, false, 'a locked file means the tree is not fully gone (degraded, unknown state)');
  assert.equal(fs.existsSync(path.join(root, 'session', 'a.bin')), false, 'the unlocked sibling was still removed');
  try { whatsapp.rmTolerant(root); } catch { /* ignore */ }
});

test('handleRemoteLogout: closes the browser BEFORE cleanup, clears the session, never rejects', async () => {
  const root = tmpTree();
  let filesPresentAtClose = null;
  const destroyFn = async () => { filesPresentAtClose = fs.existsSync(path.join(root, 'session', 'a.bin')); };
  await assert.doesNotReject(whatsapp.handleRemoteLogout({ destroyFn, dir: root }));
  assert.equal(filesPresentAtClose, true, 'session files still existed at browser-close time -> removal ran AFTER the close');
  assert.equal(fs.existsSync(root), false, 'session dir was cleared');
});

test('handleRemoteLogout: degrades (no throw, keeps going) when the session cannot be fully removed', async () => {
  const root = tmpTree();
  const locked = path.join(root, 'session', 'a.bin');
  const restore = lockFile(locked);
  let closed = false;
  try {
    await assert.doesNotReject(whatsapp.handleRemoteLogout({ destroyFn: async () => { closed = true; }, dir: root }));
  } finally { restore(); }
  assert.equal(closed, true, 'the browser was still closed first');
  try { whatsapp.rmTolerant(root); } catch { /* ignore */ }
});
