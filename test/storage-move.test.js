// Step 1.4 C5: core/storage-move.js, the move from localStorage to the file (plan §2, §5.1), with two
// node-sqlite files standing in for the two copies (test/_storage-move-host.js). This file: a full
// move and its checks, "Continue" after an interruption, and every row of the startup table (§2.2).
// Forced failures and real kills are C6, low space C7, the way back C8.
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

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-storage-move-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let n = 0;
/** A folder with local.db: the newest schema fixture plus `extra` generated entries. */
function newPhone(extra = 0) {
  const dir = fs.mkdtempSync(path.join(DIR, `phone-${++n}-`));
  const d = new DatabaseSync(path.join(dir, 'local.db'));
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec('PRAGMA user_version = 2');
  if (extra) d.exec(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${extra})
    INSERT INTO settings (key, value) SELECT 'bulk_' || i, 'value ' || i || ' ₹ 1.0' FROM k`);
  d.close();
  return dir;
}
async function closeAll(host) { try { await host.source.close(); } catch { /* closed */ } }

test('a full move: the file holds exactly the data, the marker says native-v1, localStorage is untouched', async () => {
  const dir = newPhone(500);
  const before = sha(path.join(dir, 'local.db'));
  const host = await makeHost(dir);
  const { moveToFile, MARKER_NATIVE } = await load('core/storage-move.js');
  const steps = [];
  const res = await moveToFile(host, { onStep: (i, name) => steps.push(`${i}:${name}`) });
  await closeAll(host);
  assert.deepStrictEqual(steps, ['0:space', '1:backup', '2:snapshot', '3:write', '4:check', '5:place', '6:switch']);
  assert.strictEqual(sha(path.join(dir, 'local.db')), before, 'the localStorage copy was only read');
  assert.ok(!fs.existsSync(host.files.candidate), 'no candidate left');
  const marker = JSON.parse(fs.readFileSync(host.files.marker, 'utf8'));
  assert.strictEqual(marker.storage, MARKER_NATIVE);
  assert.strictEqual(marker.check.tables, res.summary.tables);
  assert.ok(marker.check.rows > 500 && marker.check.perTable.settings.rows >= 500);
  assert.strictEqual(marker.oldCopy.kept, true);
  const ls = JSON.parse(fs.readFileSync(host.files.ls, 'utf8'));
  assert.strictEqual(ls['plannr-storage'].storage, MARKER_NATIVE, 'the localStorage key repeats the marker');
  assert.ok(!('plannr-storage-move' in ls), 'the progress record is cleared');
  // The file and the old copy match by the same checks the move ran.
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const { fingerprint, compareFingerprints } = await load('core/storage-check.js');
  const a = openNodeSqliteAdapter(path.join(dir, 'local.db'), { readOnly: true });
  const b = openNodeSqliteAdapter(host.files.main, { readOnly: true });
  assert.deepStrictEqual(compareFingerprints(await fingerprint(a), await fingerprint(b)), []);
  await a.close(); await b.close();
  assert.deepStrictEqual(host.calls, ['backup', 'snapshot', 'candidate.write', 'candidate.place']);
  assert.strictEqual(fs.readdirSync(host.files.snapshots).length, 1, 'one snapshot');
});

test('a copy that does not match is deleted and nothing switches', async () => {
  const dir = newPhone();
  const host = await makeHost(dir);
  const real = host.candidate.write;
  host.candidate.write = async (bytes) => {
    await real(bytes);
    const d = new DatabaseSync(host.files.candidate);
    d.exec("UPDATE settings SET value = value || '!' WHERE rowid = (SELECT MIN(rowid) FROM settings)");
    d.close();
  };
  const { moveToFile } = await load('core/storage-move.js');
  const err = await moveToFile(host).catch((e) => e);
  await closeAll(host);
  assert.strictEqual(err.step, 'check');
  assert.match(err.message, /does not match your data, so nothing was switched: table settings/);
  assert.ok(!fs.existsSync(host.files.candidate) && !fs.existsSync(host.files.main) && !fs.existsSync(host.files.marker));
});

test('"Continue": with the database unchanged the backup and snapshot are not repeated; changed, they are', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = newPhone();
  let host = await makeHost(dir, { checkpoint: (name) => { if (name === 'before-write') throw new Error('stopped'); } });
  await assert.rejects(moveToFile(host), /stopped/);
  await closeAll(host);
  const rec = JSON.parse(fs.readFileSync(host.files.ls, 'utf8'))['plannr-storage-move'];
  assert.deepStrictEqual(rec.done, ['space', 'backup', 'snapshot']);
  assert.match(rec.checksum, /^[0-9a-f]{64}$/);
  host = await makeHost(dir);
  await moveToFile(host);
  await closeAll(host);
  assert.deepStrictEqual(host.calls, ['candidate.write', 'candidate.place'], 'unchanged: steps 1-2 skipped');

  const dir2 = newPhone();
  host = await makeHost(dir2, { checkpoint: (name) => { if (name === 'before-write') throw new Error('stopped'); } });
  await assert.rejects(moveToFile(host), /stopped/);
  await closeAll(host);
  const d = new DatabaseSync(path.join(dir2, 'local.db'));
  d.exec("INSERT INTO settings (key, value) VALUES ('changed_since', 'yes')");
  d.close();
  host = await makeHost(dir2);
  await moveToFile(host);
  await closeAll(host);
  assert.deepStrictEqual(host.calls, ['backup', 'snapshot', 'candidate.write', 'candidate.place'], 'changed: from step 1 again');
});

test('the backup records its time in the database: the move uses the database after it, and "Continue" still skips', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const stampingBackup = (host, at) => {
    const real = host.backup;
    host.backup = async () => {
      await real();
      // What mark-exported does on the phone once the encrypted backup is saved.
      const d = new DatabaseSync(host.files.local);
      d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_encrypted_export_at', ?)").run(at);
      d.close();
    };
  };
  const dir = newPhone(20);
  let host = await makeHost(dir, { checkpoint: (name) => { if (name === 'before-write') throw new Error('stopped'); } });
  stampingBackup(host, '2026-11-19 10:00:00');
  await assert.rejects(moveToFile(host), /stopped/);
  await closeAll(host);
  const stampIn = (file) => {
    const s = new DatabaseSync(file, { readOnly: true });
    try { return (s.prepare("SELECT value FROM settings WHERE key = 'last_encrypted_export_at'").get() || {}).value; } finally { s.close(); }
  };
  const snap = path.join(host.files.snapshots, fs.readdirSync(host.files.snapshots)[0]);
  assert.strictEqual(stampIn(snap), '2026-11-19 10:00:00', 'the snapshot holds the database after the backup');
  host = await makeHost(dir);
  await moveToFile(host);
  await closeAll(host);
  assert.deepStrictEqual(host.calls, ['candidate.write', 'candidate.place'], '"Continue" knows the database after the backup');

  const dir2 = newPhone(20);
  host = await makeHost(dir2);
  stampingBackup(host, '2026-11-19 10:00:00');
  const res = await moveToFile(host);
  await closeAll(host);
  assert.strictEqual(res.marker.storage, 'native-v1');
  assert.strictEqual(stampIn(host.files.main), '2026-11-19 10:00:00', 'the file has the backup time');
});

test('a lost or unreadable progress record only costs repeating steps 1-2', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = newPhone();
  let host = await makeHost(dir, { checkpoint: (name) => { if (name === 'before-write') throw new Error('stopped'); } });
  await assert.rejects(moveToFile(host), /stopped/);
  await closeAll(host);
  fs.writeFileSync(host.files.ls, JSON.stringify({ 'plannr-storage-move': 'garbage' }));
  host = await makeHost(dir);
  host.progress.read = async () => { throw new Error('localStorage is not available'); };
  await moveToFile(host);
  await closeAll(host);
  assert.deepStrictEqual(host.calls, ['backup', 'snapshot', 'candidate.write', 'candidate.place']);
});

test('the backup step not done (the share sheet closed): nothing else happens', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = newPhone();
  const host = await makeHost(dir, { backupFails: true });
  await assert.rejects(moveToFile(host), /the backup was not saved/);
  await closeAll(host);
  assert.deepStrictEqual(host.calls, ['backup']);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['local.db']);
});

// ---- The startup table (plan §2.2): every row -----------------------------------------------------

const ROWS = [
  // [name, facts, expected]
  ['no marker, no files: localStorage', { marker: null, candidate: false, main: false }, { use: 'localstorage', remove: [], setAside: [] }],
  ['no marker, the candidate there: the move was interrupted, delete it',
    { marker: null, candidate: true, main: false, moveInProgress: true }, { use: 'localstorage', remove: ['candidate'], setAside: [], prompt: 'interrupted' }],
  ['no marker, the file there and a move record: interrupted after the rename, delete it',
    { marker: null, candidate: false, main: true, moveInProgress: true }, { use: 'localstorage', remove: ['main'], setAside: [], prompt: 'interrupted' }],
  ['no marker, both there, a move record: delete both',
    { marker: null, candidate: true, main: true, moveInProgress: true }, { use: 'localstorage', remove: ['candidate', 'main'], setAside: [], prompt: 'interrupted' }],
  ['no marker, a database file nothing explains: kept aside, not deleted',
    { marker: null, candidate: false, main: true, moveInProgress: false }, { use: 'localstorage', remove: [], setAside: ['main'], prompt: 'interrupted' }],
  ['native-v1 and the file opens with quick_check ok: the file',
    { marker: { storage: 'native-v1' }, candidate: false, main: true, ok: true }, { use: 'native', remove: [], setAside: [] }],
  ['native-v1, the file ok, a stale candidate: the file, the candidate deleted',
    { marker: { storage: 'native-v1' }, candidate: true, main: true, ok: true }, { use: 'native', remove: ['candidate'], setAside: [] }],
  ['native-v1 and the file missing: the recovery screen, nothing changed',
    { marker: { storage: 'native-v1' }, candidate: false, main: false }, { use: 'recovery', remove: [], setAside: [], reason: 'missing' }],
  ['native-v1 and the file damaged: the recovery screen, nothing changed',
    { marker: { storage: 'native-v1' }, candidate: false, main: true, ok: false }, { use: 'recovery', remove: [], setAside: [], reason: 'damaged' }],
  ['localstorage-v1 (after a move back): localStorage, the file kept',
    { marker: { storage: 'localstorage-v1' }, candidate: false, main: true }, { use: 'localstorage', remove: [], setAside: [] }],
  ['localstorage-v1 and a stale candidate: localStorage, the candidate deleted, the file kept',
    { marker: { storage: 'localstorage-v1' }, candidate: true, main: true }, { use: 'localstorage', remove: ['candidate'], setAside: [] }],
  ['an unknown marker is treated like no marker (nothing deleted without a record)',
    { marker: { storage: 'something-else' }, candidate: false, main: true, moveInProgress: false }, { use: 'localstorage', remove: [], setAside: ['main'], prompt: 'interrupted' }],
];
for (const [name, facts, want] of ROWS) {
  test(`startup: ${name}`, async () => {
    const { decideAtStartup } = await load('core/storage-move.js');
    let asked = 0;
    const got = await decideAtStartup({ ...facts, mainOk: async () => { asked++; return !!facts.ok; } });
    assert.deepStrictEqual(got, want);
    if (!(facts.marker && facts.marker.storage === 'native-v1' && facts.main)) assert.strictEqual(asked, 0, 'quick_check only when it decides');
  });
}

test('startup facts come from the files: after a full move the file is used; with the marker gone the file is set aside', async () => {
  const { moveToFile, decideAtStartup } = await load('core/storage-move.js');
  const dir = newPhone();
  const host = await makeHost(dir);
  await moveToFile(host);
  await closeAll(host);
  assert.strictEqual((await decideAtStartup(await startupFacts(host))).use, 'native');
  fs.rmSync(host.files.marker);
  const ls = JSON.parse(fs.readFileSync(host.files.ls, 'utf8')); delete ls['plannr-storage']; fs.writeFileSync(host.files.ls, JSON.stringify(ls));
  assert.deepStrictEqual(await decideAtStartup(await startupFacts(host)), { use: 'localstorage', remove: [], setAside: ['main'], prompt: 'interrupted' });
  fs.writeFileSync(host.files.marker, JSON.stringify({ storage: 'native-v1' }));
  fs.writeFileSync(host.files.main, 'not a database, damaged');
  assert.strictEqual((await decideAtStartup(await startupFacts(host))).use, 'recovery');
});
