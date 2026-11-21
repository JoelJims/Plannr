// Step 1.4 D1: under Node, db.js's own connection is a database file, and its adapter exports,
// replaces and measures it (db-adapter-node.js's file operations). A replace swaps the handle: the
// old one is closed, `db` (read at the time of use) is the new one, and nothing else changes when the
// new bytes are refused. Every database here is the test's own temp file (test/helpers.js).
const H = require('./helpers');
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dbModule = require('../db');

before(async () => { await H.ready; });

const count = () => dbModule.db.prepare('SELECT COUNT(*) AS n FROM cash_in').get().n;
const leftovers = () => fs.readdirSync(path.dirname(H.TEST_DB)).filter((f) => /\.incoming-/.test(f));

test('info: the engine, the file and its size on disk', async () => {
  const i = await dbModule.dbAdapter().info();
  assert.strictEqual(i.engine, 'node-sqlite');
  assert.strictEqual(i.path.toLowerCase(), path.resolve(H.TEST_DB).toLowerCase());
  assert.strictEqual(i.sizeBytes, fs.statSync(H.TEST_DB).size);
});

test('exportBytes gives the whole database; replaceWith puts it back and swaps the handle', async () => {
  H.seedCashIn({ reason: 'in the export' });
  const n = count();
  const bytes = await dbModule.dbAdapter().exportBytes();
  assert.ok(bytes instanceof Uint8Array);
  assert.strictEqual(Buffer.from(bytes.subarray(0, 16)).toString('latin1'), 'SQLite format 3\0');
  H.seedCashIn({ reason: 'after the export' });
  assert.strictEqual(count(), n + 1);

  const old = dbModule.db;
  await dbModule.dbAdapter().replaceWith(bytes);
  assert.notStrictEqual(dbModule.db, old, 'a new handle on the new file');
  assert.throws(() => old.prepare('SELECT 1'), /not open/i, 'the old handle is closed');
  assert.strictEqual(count(), n);
  assert.strictEqual(dbModule.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.strictEqual(dbModule.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.strictEqual(H.db, dbModule.db, 'test/helpers.js reads the current handle');
  assert.deepStrictEqual(leftovers(), []);
  // The adapter's own calls reach the new file too.
  assert.strictEqual((await dbModule.dbAdapter().get('SELECT COUNT(*) AS n FROM cash_in')).n, n);
});

test('replaceWith refuses bytes that are not a sound database and keeps the same handle and data', async () => {
  const handle = dbModule.db;
  const n = count();
  await assert.rejects(() => dbModule.dbAdapter().replaceWith(new Uint8Array(4096)), /not a SQLite database/);
  const bytes = Buffer.from(await dbModule.dbAdapter().exportBytes());
  const pageSize = bytes.readUInt16BE(16) || 65536;
  bytes.fill(0xa5, pageSize + 8, Math.min(bytes.length, pageSize * 3));
  await assert.rejects(() => dbModule.dbAdapter().replaceWith(new Uint8Array(bytes)));
  assert.strictEqual(dbModule.db, handle, 'the same handle, still open');
  assert.strictEqual(count(), n);
  assert.deepStrictEqual(leftovers(), []);
});

test('only db.js\'s own connection exports or replaces: another handle is refused', async () => {
  const other = new DatabaseSync(':memory:');
  try {
    await assert.rejects(() => dbModule.dbAdapter(other).exportBytes(), /only for its own database file/);
    await assert.rejects(() => dbModule.dbAdapter(other).replaceWith(new Uint8Array(100)), /only for its own database file/);
  } finally { other.close(); }
});

test('writeRestoreSnapshot: a whole-database copy in safety-snapshots/ beside the file', async () => {
  const file = dbModule.writeRestoreSnapshot();
  try {
    assert.strictEqual(path.dirname(file).toLowerCase(), path.join(path.dirname(H.TEST_DB), 'safety-snapshots').toLowerCase());
    assert.match(path.basename(file), /^plannr-pre-restore-\d{4}-\d\d-\d\dT[\d-]+Z\.db$/);
    const copy = new DatabaseSync(file, { readOnly: true });
    try { assert.strictEqual(copy.prepare('SELECT COUNT(*) AS n FROM cash_in').get().n, count()); } finally { copy.close(); }
  } finally { fs.rmSync(file, { force: true }); }
});
