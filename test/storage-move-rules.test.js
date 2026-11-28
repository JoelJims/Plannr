// Step 1.4 C8: after the move (plan §2.4, §5.1). "Move data back" (the 90% limit, the confirmation,
// snapshots first, all or nothing), the emergency "use the old copy" (only when the file is missing or
// damaged; the damaged file is kept), and "Delete the old copy" (a confirmation and an encrypted backup
// since the move; never on its own). Two node-sqlite files stand in for localStorage and the phone's
// file (test/_storage-move-host.js).
// Every file is in a fresh temp folder. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { makeHost, startupFacts, load, ROOT } = require('./_storage-move-host.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-storage-rules-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const MOVED_AT = '2026-11-19T10:00:00.000Z';

let n = 0;
function newPhone() {
  const dir = fs.mkdtempSync(path.join(DIR, `phone-${++n}-`));
  const d = new DatabaseSync(path.join(dir, 'local.db'));
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec(`PRAGMA user_version = 2; WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 200)
    INSERT INTO settings (key, value) SELECT 'bulk_' || i, 'value ' || i FROM k`);
  d.close();
  return dir;
}

/** A phone that has moved: the file in use (host.file open), the old copy kept. */
async function moved(opts = {}) {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = newPhone();
  const first = await makeHost(dir);
  await moveToFile(first);
  await first.source.close();
  const host = await makeHost(dir, opts);
  await host.source.close(); // the old copy is reached through host.local from here on
  await host.openFile();
  return { dir, host };
}
const marker = (host) => JSON.parse(fs.readFileSync(host.files.marker, 'utf8'));
const decide = async (host) => (await load('core/storage-move.js')).decideAtStartup(await startupFacts(host));
async function sameData(fileA, fileB) {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const { fingerprint, compareFingerprints } = await load('core/storage-check.js');
  const a = openNodeSqliteAdapter(fileA, { readOnly: true });
  const b = openNodeSqliteAdapter(fileB, { readOnly: true });
  try { return compareFingerprints(await fingerprint(a), await fingerprint(b)); } finally { await a.close(); await b.close(); }
}

// ---- Move data back ------------------------------------------------------------------------------

test('the 90% limit: 2 characters per byte, under 90% of the localStorage limit', async () => {
  const { moveBackLimitBytes, moveBackFits } = await load('core/storage-move.js');
  const LIMIT = 5 * 1024 * 1024;
  assert.strictEqual(moveBackLimitBytes(LIMIT), 2359296);
  assert.strictEqual(moveBackFits(2359296, LIMIT), true);
  assert.strictEqual(moveBackFits(2359297, LIMIT), false);
});

test('move data back: snapshots first, your current data replaces the old copy, checked, then the marker says localstorage-v1; the file is kept', async () => {
  const { moveBack, moveToFile, MARKER_LOCAL } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  await host.file.run("INSERT INTO settings (key, value) VALUES ('entered_after_the_move', 'yes')");
  const res = await moveBack(host, { confirmed: true });
  await host.file.close();
  assert.deepStrictEqual(host.calls, ['snapshot:old-copy', 'snapshot:pre-move-back', 'local.replaceWith']);
  assert.strictEqual(fs.readdirSync(host.files.snapshots).length, 3, 'the move\'s snapshot plus the two new ones');
  const m = marker(host);
  assert.strictEqual(m.storage, MARKER_LOCAL);
  assert.strictEqual(m.file.kept, true);
  assert.strictEqual(m.check.rows, res.summary.rows);
  assert.strictEqual(JSON.parse(fs.readFileSync(host.files.ls, 'utf8'))['plannr-storage'].storage, MARKER_LOCAL);
  assert.deepStrictEqual(await sameData(path.join(dir, 'local.db'), host.files.main), [], 'the old storage now holds the current data');
  const d = new DatabaseSync(path.join(dir, 'local.db'), { readOnly: true });
  assert.ok(d.prepare("SELECT 1 FROM settings WHERE key = 'entered_after_the_move'").get());
  d.close();
  assert.ok(fs.existsSync(host.files.main), 'the file is kept');
  assert.deepStrictEqual(await decide(host), { use: 'localstorage', remove: [], setAside: [] });
  // And the move can be made again.
  const again = await makeHost(dir);
  await moveToFile(again);
  await again.source.close();
  assert.strictEqual((await decide(again)).use, 'native');
  assert.deepStrictEqual(await sameData(path.join(dir, 'local.db'), again.files.main), []);
});

test('move data back is refused without the confirmation, and when the app is not on the file; nothing changes', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  const before = sha(path.join(dir, 'local.db'));
  const e1 = await moveBack(host).catch((e) => e);
  assert.strictEqual(e1.step, 'confirm');
  assert.match(e1.message, /replaces the old copy with your current data/);
  assert.deepStrictEqual(host.calls, []);
  await host.file.close();
  // A phone that never moved.
  const plain = await makeHost(newPhone());
  await plain.source.close();
  const e2 = await moveBack(plain, { confirmed: true }).catch((e) => e);
  assert.strictEqual(e2.step, 'state');
  assert.strictEqual(sha(path.join(dir, 'local.db')), before);
  assert.strictEqual(marker(host).storage, 'native-v1');
});

test('move data back is refused when the data is over 90% of the localStorage limit, with the numbers', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  const bytes = (await host.file.exportBytes()).length;
  host.local.limitChars = Math.floor((bytes * 2) / 0.9) - 1024; // just too small
  const before = sha(path.join(dir, 'local.db'));
  const err = await moveBack(host, { confirmed: true }).catch((e) => e);
  await host.file.close();
  assert.strictEqual(err.step, 'size');
  assert.match(err.message, /^Your data \(\d+\.\d MB\) is too big to move back: the old storage holds at most about \d+\.\d MB\. It stays in the new storage\.$/);
  assert.ok(err.details.bytes > err.details.limitBytes);
  assert.deepStrictEqual(host.calls, []);
  assert.strictEqual(sha(path.join(dir, 'local.db')), before);
  assert.strictEqual((await decide(host)).use, 'native');
});

test('without the confirmation, move data back only checks: too big and too little space come before the question (C10)', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  const before = sha(path.join(dir, 'local.db'));
  const bytes = (await host.file.exportBytes()).length;
  const limit = host.local.limitChars;
  host.local.limitChars = Math.floor((bytes * 2) / 0.9) - 1024; // just too small
  const e1 = await moveBack(host).catch((e) => e);
  assert.strictEqual(e1.step, 'size', 'too big: said instead of asking');
  host.local.limitChars = limit;
  host.freeBytes = async () => 1024;
  const e2 = await moveBack(host).catch((e) => e);
  assert.strictEqual(e2.step, 'space', 'too little space: said instead of asking');
  host.freeBytes = async () => 8e9;
  const e3 = await moveBack(host).catch((e) => e);
  assert.strictEqual(e3.step, 'confirm', 'it can be done: then the question');
  await host.file.close();
  assert.deepStrictEqual(host.calls, []);
  assert.strictEqual(sha(path.join(dir, 'local.db')), before);
  assert.strictEqual(marker(host).storage, 'native-v1');
});

for (const point of ['back-size', 'back-snapshot', 'back-write', 'local-replace', 'back-check', 'back-switch', 'marker-write']) {
  test(`move data back stopped at "${point}": the app stays on the file, which is unchanged`, async () => {
    const { moveBack } = await load('core/storage-move.js');
    const { host } = await moved({ checkpoint: (name) => { if (name === point) throw new Error(`forced failure at ${point}`); } });
    const fileBefore = await host.file.exportBytes();
    await assert.rejects(moveBack(host, { confirmed: true }), new RegExp(`forced failure at ${point}`));
    assert.deepStrictEqual(Buffer.from(await host.file.exportBytes()), Buffer.from(fileBefore));
    await host.file.close();
    assert.strictEqual(marker(host).storage, 'native-v1');
    assert.strictEqual((await decide(host)).use, 'native');
  });
}

test('move data back: a write that fails leaves the old copy as it was', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  const before = sha(path.join(dir, 'local.db'));
  host.local.replaceWith = async () => { throw new Error('QuotaExceededError: the quota has been exceeded'); };
  const err = await moveBack(host, { confirmed: true }).catch((e) => e);
  await host.file.close();
  assert.strictEqual(err.step, 'write');
  assert.match(err.message, /the old copy is unchanged/);
  assert.strictEqual(sha(path.join(dir, 'local.db')), before);
  assert.strictEqual((await decide(host)).use, 'native');
});

test('move data back: a copy that does not match is not switched to', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  const real = host.local.replaceWith;
  host.local.replaceWith = async (bytes) => {
    await real(bytes);
    const d = new DatabaseSync(path.join(dir, 'local.db'));
    d.exec("DELETE FROM settings WHERE key = 'bulk_7'");
    d.close();
  };
  const err = await moveBack(host, { confirmed: true }).catch((e) => e);
  await host.file.close();
  assert.strictEqual(err.step, 'check');
  assert.match(err.message, /does not match your data, so nothing was switched; you stay on the new storage .*table settings/);
  assert.ok(err.details.snapshots.oldCopy, 'the old copy was saved first');
  assert.strictEqual((await decide(host)).use, 'native');
});

// ---- The emergency path ----------------------------------------------------------------------------

test('use the old copy: only when the file is missing or damaged, only after you confirm; the damaged file is kept aside', async () => {
  const { useOldCopy, MARKER_LOCAL } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  await host.file.close();
  const oldCopy = sha(path.join(dir, 'local.db'));
  const fine = await useOldCopy(host, { confirmed: true }).catch((e) => e);
  assert.strictEqual(fine.step, 'state', 'the file is fine: refused');
  assert.match(fine.message, /only for when the file is missing or damaged/);

  fs.writeFileSync(host.files.main, 'damaged: not a database any more');
  assert.deepStrictEqual(await decide(host), { use: 'recovery', remove: [], setAside: [], reason: 'damaged' });
  const ask = await useOldCopy(host).catch((e) => e);
  assert.strictEqual(ask.step, 'confirm');
  assert.match(ask.message, /^The old copy is your data as it was on 19 Nov 2026\. Anything entered after that is not in it\./);
  assert.ok(fs.existsSync(host.files.main), 'nothing changed before the confirmation');

  const res = await useOldCopy(host, { confirmed: true });
  const m = marker(host);
  assert.strictEqual(m.storage, MARKER_LOCAL);
  assert.strictEqual(m.emergency, true);
  assert.strictEqual(m.oldCopyFrom, MOVED_AT);
  assert.ok(!fs.existsSync(host.files.main), 'the damaged file is out of the way');
  assert.strictEqual(fs.readFileSync(path.join(dir, res.setAside), 'utf8'), 'damaged: not a database any more', 'and kept');
  assert.strictEqual(sha(path.join(dir, 'local.db')), oldCopy, 'the old copy is used as it was');
  assert.deepStrictEqual(await decide(host), { use: 'localstorage', remove: [], setAside: [] });
});

test('use the old copy with the file missing; refused once the old copy has been deleted', async () => {
  const { useOldCopy } = await load('core/storage-move.js');
  const a = await moved();
  await a.host.file.close();
  fs.rmSync(a.host.files.main);
  assert.strictEqual((await decide(a.host)).reason, 'missing');
  const res = await useOldCopy(a.host, { confirmed: true });
  assert.strictEqual(res.setAside, null);
  assert.strictEqual(marker(a.host).file.reason, 'missing');
  assert.strictEqual((await decide(a.host)).use, 'localstorage');

  const b = await moved();
  await b.host.file.close();
  fs.rmSync(b.host.files.main);
  fs.rmSync(path.join(b.dir, 'local.db')); // the old copy was deleted
  const err = await useOldCopy(b.host, { confirmed: true }).catch((e) => e);
  assert.strictEqual(err.step, 'missing');
  assert.match(err.message, /Restore an encrypted backup instead/);
  assert.strictEqual((await decide(b.host)).use, 'recovery', 'still the recovery screen');
});

// ---- Delete the old copy -----------------------------------------------------------------------------

test('delete the old copy: needs an encrypted backup saved after the move, then the confirmation', async () => {
  const { deleteOldCopy } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  for (const last of [null, '2026-11-19 09:59:59', '2026-11-19 10:00:00', 'not a date']) {
    host.lastBackupAt = last;
    const err = await deleteOldCopy(host, { confirmed: true }).catch((e) => e);
    assert.strictEqual(err.step, 'backup', String(last));
    assert.match(err.message, /^Save an encrypted backup first: none has been saved since the move on 19 Nov 2026\.$/);
  }
  host.lastBackupAt = '2026-11-19 10:00:01';
  const ask = await deleteOldCopy(host).catch((e) => e);
  assert.strictEqual(ask.step, 'confirm');
  assert.match(ask.message, /cannot be undone/);
  assert.ok(fs.existsSync(path.join(dir, 'local.db')), 'nothing deleted yet');
  assert.deepStrictEqual(host.calls, []);

  const res = await deleteOldCopy(host, { confirmed: true });
  await host.file.close();
  assert.ok(!fs.existsSync(path.join(dir, 'local.db')), 'the old copy is gone');
  assert.strictEqual(marker(host).oldCopy.kept, false);
  assert.ok(res.freedBytes > 0);
  assert.strictEqual((await decide(host)).use, 'native', 'the file is still in use');
});

test('delete the old copy: stopped after it is recorded, doing it again finishes; never on the copy in use', async () => {
  const { deleteOldCopy, moveBack } = await load('core/storage-move.js');
  const { dir, host } = await moved({ lastBackupAt: '2026-11-20 08:00:00', checkpoint: (name) => { if (name === 'delete-recorded') throw new Error('killed'); } });
  await assert.rejects(deleteOldCopy(host, { confirmed: true }), /killed/);
  assert.strictEqual(marker(host).oldCopy.kept, false);
  assert.ok(fs.existsSync(path.join(dir, 'local.db')), 'not deleted yet');
  const h2 = await makeHost(dir, { lastBackupAt: '2026-11-20 08:00:00' });
  await h2.source.close();
  await deleteOldCopy(h2, { confirmed: true });
  assert.ok(!fs.existsSync(path.join(dir, 'local.db')));
  const err = await deleteOldCopy(h2, { confirmed: true }).catch((e) => e);
  assert.strictEqual(err.step, 'missing');
  await host.file.close();

  // After a move back, the localStorage copy is the data in use: refused.
  const b = await moved({ lastBackupAt: '2026-11-20 08:00:00' });
  await moveBack(b.host, { confirmed: true });
  await b.host.file.close();
  const e2 = await deleteOldCopy(b.host, { confirmed: true }).catch((e) => e);
  assert.strictEqual(e2.step, 'state');
  assert.ok(fs.existsSync(path.join(b.dir, 'local.db')));
});

// ---- Q12: confirming the move ------------------------------------------------------------------------
// The move's safety copy is kept until the owner confirms the move in the app. The marker file (the
// move's own record) says whether that happened; a move back resets it.

test('Q12: after a move the marker names the safety copy, unconfirmed; confirming asks first, then records it in the marker', async () => {
  const { confirmMove, moveConfirmed } = await load('core/storage-move.js');
  const { dir, host } = await moved({ now: '2026-11-21T09:30:00.000Z' });
  const before = marker(host);
  assert.deepStrictEqual(before.safetyCopy, { snapshot: 'plannr-pre-move-1.db', confirmed: false });
  assert.strictEqual(moveConfirmed(before), false);
  const ask = await confirmMove(host).catch((e) => e);
  assert.strictEqual(ask.step, 'confirm');
  assert.match(ask.message, /safety copy from before the move is removed in the normal rotation/);
  assert.deepStrictEqual(marker(host), before, 'nothing recorded without the confirmation');
  const res = await confirmMove(host, { confirmed: true });
  await host.file.close();
  const after = marker(host);
  assert.deepStrictEqual(after.safetyCopy, { snapshot: 'plannr-pre-move-1.db', confirmed: true, confirmedAt: '2026-11-21T09:30:00.000Z' });
  assert.deepStrictEqual({ ...after, safetyCopy: before.safetyCopy }, before, 'the rest of the marker is unchanged');
  assert.deepStrictEqual(res.marker, after);
  assert.strictEqual(moveConfirmed(after), true);
  // It is in the marker file, so it holds after a restart; confirming again changes nothing.
  const again = await makeHost(dir, { now: '2026-11-22T09:30:00.000Z' });
  await again.source.close();
  assert.strictEqual(moveConfirmed(await again.marker.read()), true);
  await confirmMove(again, { confirmed: true });
  assert.strictEqual(marker(again).safetyCopy.confirmedAt, '2026-11-21T09:30:00.000Z');
  assert.strictEqual((await decide(again)).use, 'native', 'the app still opens the file');
});

test('Q12: a move back resets the confirmation; the next move asks again; never confirmed off the file', async () => {
  const { confirmMove, moveConfirmed, moveBack, moveToFile, MARKER_LOCAL } = await load('core/storage-move.js');
  const { dir, host } = await moved();
  await confirmMove(host, { confirmed: true });
  await moveBack(host, { confirmed: true });
  await host.file.close();
  const back = marker(host);
  assert.strictEqual(back.storage, MARKER_LOCAL);
  assert.strictEqual(moveConfirmed(back), false, 'a move back resets it');
  assert.ok(!back.safetyCopy || back.safetyCopy.confirmed !== true, JSON.stringify(back.safetyCopy));
  const e1 = await confirmMove(host, { confirmed: true }).catch((e) => e);
  assert.strictEqual(e1.step, 'state', 'nothing to confirm on the old storage');
  assert.deepStrictEqual(marker(host), back);
  // The move again: a new safety copy, unconfirmed.
  const again = await makeHost(dir);
  await moveToFile(again);
  await again.source.close();
  const m = marker(again);
  assert.strictEqual(moveConfirmed(m), false);
  assert.deepStrictEqual(m.safetyCopy, { snapshot: 'plannr-pre-move-1.db', confirmed: false });
  // A phone that never moved; and a marker written before Q12 (no safetyCopy) counts as unconfirmed.
  const plain = await makeHost(newPhone());
  await plain.source.close();
  assert.strictEqual((await confirmMove(plain, { confirmed: true }).catch((e) => e)).step, 'state');
  assert.strictEqual(moveConfirmed({ storage: 'native-v1', movedAt: MOVED_AT }), false);
  assert.strictEqual(moveConfirmed(null), false);
});

test('stampTime reads the settings stamp as UTC, and ISO strings and Dates as they are', async () => {
  const { stampTime } = await load('core/storage-move.js');
  assert.strictEqual(stampTime('2026-11-19 10:00:01'), Date.UTC(2026, 10, 19, 10, 0, 1));
  assert.strictEqual(stampTime('2026-11-19T10:00:00.000Z'), Date.UTC(2026, 10, 19, 10, 0, 0));
  assert.strictEqual(stampTime(new Date(5)), 5);
  assert.ok(Number.isNaN(stampTime(null)) && Number.isNaN(stampTime('soon')));
});
