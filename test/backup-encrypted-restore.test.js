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
  assert.match(damaged.json.error, /^Restore failed partway through: /);

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
