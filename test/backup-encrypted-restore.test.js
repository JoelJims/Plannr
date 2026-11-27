// Step 1.4 D1: restoring an encrypted backup through the API, on both targets. The dev server
// (server.js) replaces its database file through db.js's adapter (db-adapter-node.js: checked,
// written beside it, renamed over it), after a whole-database safety copy beside it. The phone's code
// (public/local-api.js, the shim pass) runs db.js's restoreFromBytes, the path the phone takes on its
// database file since step 1.4 C9; the phone's sqlite-wasm path is test-ui/backup-roundtrip.js.
//
// Fill, export encrypted, change things, restore: every table is as it was at the export. A wrong
// passphrase, a changed file, a file that is not a database, a damaged database and a backup from a
// newer Plannr change nothing. Every database here is the test's own temp file (test/helpers.js).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { init, SCHEMA_VERSION } = require('../db');
const { encrypt, decrypt } = require('../backup-crypto');
const F = require('./fixtures/full-dataset');

const ROOT = path.join(__dirname, '..');
const PASS = 'restore-test-passphrase';
const SNAPSHOT_DIR = path.join(path.dirname(H.TEST_DB), 'safety-snapshots');
const preRestoreCopies = () => (fs.existsSync(SNAPSHOT_DIR) ? fs.readdirSync(SNAPSHOT_DIR).filter((f) => /^plannr-pre-restore-.*\.db$/.test(f)).sort() : []);

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

// Everything gone, then init() re-seeds a brand-new install; then the full fixture.
async function seedFixture() {
  const db = H.db;
  db.exec('PRAGMA foreign_keys = OFF');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) db.exec(`DELETE FROM ${name}`);
  db.exec('DELETE FROM sqlite_sequence');
  db.exec('PRAGMA foreign_keys = ON');
  await init();
  F.seedInto(H.db, F.DATA);
}
const dump = () => F.dumpAll(H.db); // H.db is read each time: a restore on the dev server swaps the handle
async function exportEncrypted() {
  const r = await H.raw('POST', '/api/backup/export-encrypted', { passphrase: PASS });
  assert.strictEqual(r.status, 200);
  return r.bytes();
}
const restore = (bytes, passphrase = PASS) => H.post('/api/backup/import-encrypted', { passphrase, dataBase64: Buffer.from(bytes).toString('base64') });
const changeThings = async () => {
  const r = await H.post('/api/cash-in', { amountRupees: '123.45', txDate: '2026-11-20', byType: 'relative', byLabel: 'D1', reason: 'made after the backup' });
  assert.strictEqual(r.status, 201);
};

test('an encrypted backup restores every table as it was at the export, after a whole-database safety copy', async () => {
  await seedFixture();
  const atExport = dump();
  const bytes = await exportEncrypted();
  await changeThings();
  const beforeRestore = dump();
  assert.notDeepStrictEqual(beforeRestore, atExport);
  const copiesBefore = preRestoreCopies();

  const r = await restore(bytes);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.deepStrictEqual(dump(), atExport);

  if (H.TARGET === 'express') {
    // The safety copy is the data as it was just before the restore, beside the database.
    assert.strictEqual(typeof r.json.snapshot, 'string');
    const file = path.resolve(ROOT, r.json.snapshot);
    assert.strictEqual(path.dirname(file).toLowerCase(), SNAPSHOT_DIR.toLowerCase());
    assert.deepStrictEqual(preRestoreCopies(), [...copiesBefore, path.basename(file)].sort());
    const copy = new DatabaseSync(file, { readOnly: true });
    try { assert.deepStrictEqual(F.dumpAll(copy), beforeRestore); } finally { copy.close(); }
  } else {
    // The phone code in Node has no app data folder: its whole-database copy is skipped (null),
    // as in a plain browser (safety-snapshots.js).
    assert.strictEqual(r.json.snapshot, null);
  }
  // Nothing of the replace is left beside the database.
  assert.deepStrictEqual(fs.readdirSync(path.dirname(H.TEST_DB)).filter((f) => /\.incoming-/.test(f)), []);

  // The app goes on working on the restored data: a save lands in it and is listed.
  const s = await H.post('/api/cash-in', { amountRupees: '9.00', txDate: '2026-11-20', byType: 'relative', byLabel: 'D1', reason: 'saved after the restore' });
  assert.strictEqual(s.status, 201);
  const list = await H.get('/api/cash-in');
  assert.ok(JSON.stringify(list.json).includes('saved after the restore'));
  assert.ok(!JSON.stringify(list.json).includes('made after the backup'));
});

test('a wrong passphrase, a changed file, a file that is not a database and a damaged database change nothing', async () => {
  await seedFixture();
  const bytes = await exportEncrypted();
  await changeThings();
  const now = dump();

  const wrong = await restore(bytes, 'not-the-passphrase');
  assert.strictEqual(wrong.status, 400);
  assert.match(wrong.json.error, /wrong passphrase/);

  const changed = Buffer.from(bytes);
  changed[changed.length - 20] ^= 0xff;
  const tampered = await restore(changed);
  assert.strictEqual(tampered.status, 400);

  const notDb = await restore(await encrypt(Buffer.alloc(4096, 7), PASS));
  assert.strictEqual(notDb.status, 400);
  assert.match(notDb.json.error, /does not look like a SQLite database/);

  // A real database header, then damage further in: the replace checks it before anything is replaced.
  const plain = Buffer.from(await decrypt(bytes, PASS));
  const pageSize = plain.readUInt16BE(16) || 65536;
  plain.fill(0xa5, pageSize + 8, pageSize * 3);
  const damaged = await restore(await encrypt(plain, PASS));
  assert.strictEqual(damaged.status, 500);
  assert.match(damaged.json.error, /^This backup could not be restored\. Nothing was changed: your data is as it was before\. Reason: /);

  assert.deepStrictEqual(dump(), now);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(H.TEST_DB)).filter((f) => /\.incoming-/.test(f)), []);
  const s = await H.post('/api/cash-in', { amountRupees: '1.00', txDate: '2026-11-20', byType: 'relative', byLabel: 'D1', reason: 'still works' });
  assert.strictEqual(s.status, 201);
});

test('a backup from a newer Plannr is refused with a clear message, and nothing changes', async () => {
  await seedFixture();
  const plain = Buffer.from(await decrypt(await exportEncrypted(), PASS));
  plain.writeUInt32BE(SCHEMA_VERSION + 1, 60); // PRAGMA user_version in the file header
  await changeThings();
  const now = dump();
  const r = await restore(await encrypt(plain, PASS));
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, new RegExp(`^This backup was made by a newer version of Plannr \\(schema v${SCHEMA_VERSION + 1}; this version understands up to v${SCHEMA_VERSION}\\)\\. Nothing was changed`));
  assert.deepStrictEqual(dump(), now);
});

// The backup with SQL run on it (foreign keys off, as a hand-edited or damaged backup would be).
function backupWith(plain, statements) {
  const file = path.join(path.dirname(H.TEST_DB), `edited-backup-${process.pid}.db`);
  fs.writeFileSync(file, plain);
  const d = new DatabaseSync(file);
  try {
    d.exec('PRAGMA foreign_keys = OFF');
    for (const sql of statements) d.exec(sql);
  } finally { d.close(); }
  try { return fs.readFileSync(file); } finally { fs.rmSync(file, { force: true }); }
}

// S3/Q6 (review 2026-11-21): a restore is all or nothing. A backup that copies in cleanly but fails a
// later check (here the foreign-key check, which runs last) used to stay live behind an error.
test('a backup that fails its foreign-key check after it is copied in is undone: the data is as it was, and the answer says so', async () => {
  await seedFixture();
  const plain = Buffer.from(await decrypt(await exportEncrypted(), PASS));
  const bad = backupWith(plain, [
    "INSERT INTO cash_in (amount_paise, tx_date, by_type, by_label, reason) VALUES (100, '2026-11-20', 'relative', 'D1', 'only in the bad backup')",
    "INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (999999, '2026-12-01')", // no such contract
  ]);
  await changeThings();
  const now = dump();
  const copiesBefore = preRestoreCopies();

  const r = await restore(await encrypt(bad, PASS));
  assert.deepStrictEqual(dump(), now, 'the data from before the restore must be back');
  assert.strictEqual(r.status, 500, JSON.stringify(r.json));
  assert.match(r.json.error, /^This backup could not be restored\. Nothing was changed: your data is as it was before\. Reason: .*foreign_key_check/);
  assert.deepStrictEqual(H.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.strictEqual(H.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  if (H.TARGET === 'express') {
    // The safety copy was still written first, and is named in the answer.
    assert.strictEqual(preRestoreCopies().length, Math.min(copiesBefore.length + 1, 3));
    assert.strictEqual(path.basename(r.json.snapshot), preRestoreCopies().at(-1));
  }
  assert.deepStrictEqual(fs.readdirSync(path.dirname(H.TEST_DB)).filter((f) => /\.incoming-/.test(f)), []);
  const s = await H.post('/api/cash-in', { amountRupees: '2.00', txDate: '2026-11-20', byType: 'relative', byLabel: 'D1', reason: 'saved after the undone restore' });
  assert.strictEqual(s.status, 201);
});

test('undoFailedRestore: puts the data back and says why the backup failed; if putting it back fails, says both', async () => {
  const { undoFailedRestore } = require('../db');
  let putBack = 0;
  await assert.rejects(undoFailedRestore(new Error('the check failed'), async () => { putBack++; }),
    (e) => e.code === 'RESTORE_UNDONE' && e.cause.message === 'the check failed' && /put back/.test(e.message));
  assert.strictEqual(putBack, 1);
  await assert.rejects(undoFailedRestore(new Error('the check failed'), async () => { throw new Error('the disk is gone'); }),
    (e) => e.code === 'RESTORE_UNDO_FAILED' && /the check failed/.test(e.message) && /the disk is gone/.test(e.message));
});

test('if putting the data back fails too, the answer says so and points to the safety copy',
  { skip: H.TARGET === 'shim' && 'the phone code uses its own copy of db.js (public/db.js): no hook from here' }, async () => {
    await seedFixture();
    const plain = Buffer.from(await decrypt(await exportEncrypted(), PASS));
    const bad = backupWith(plain, ["INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (999999, '2026-12-01')"]);
    const { dbAdapter } = require('../db');
    const live = dbAdapter();
    const replaceWith = live.replaceWith;
    let calls = 0;
    live.replaceWith = async function (bytes) { if (++calls === 2) throw new Error('injected: the put-back failed'); return replaceWith.call(this, bytes); };
    try {
      const r = await restore(await encrypt(bad, PASS));
      assert.strictEqual(calls, 2);
      assert.strictEqual(r.status, 500, JSON.stringify(r.json));
      assert.match(r.json.error, /^The restore failed, and putting your data back failed too\. Make no changes: restore the safety copy \(.+plannr-pre-restore-.+\.db\) or your latest backup\./);
      assert.match(r.json.error, /injected: the put-back failed/);
      assert.strictEqual(typeof r.json.snapshot, 'string');
    } finally {
      live.replaceWith = replaceWith;
    }
  });

test('the dev server keeps the newest 3 safety copies from before a restore', { skip: H.TARGET === 'shim' && 'the phone keeps its own (test/safety-snapshots.test.js)' }, async () => {
  await seedFixture();
  const bytes = await exportEncrypted();
  const made = [];
  for (let i = 0; i < 4; i++) {
    const r = await restore(bytes);
    assert.strictEqual(r.status, 200);
    made.push(path.basename(r.json.snapshot));
    await new Promise((res) => setTimeout(res, 20)); // distinct times, to the millisecond
  }
  const kept = preRestoreCopies();
  assert.strictEqual(kept.length, 3);
  assert.deepStrictEqual(kept, made.slice(1).sort());
});
