// Phase 2, Step 3 (M8) — storage limit helpers that the node side can check. The phone's real limit,
// the meter and the storage-full message run in a browser: test-ui/storage-limit.js (the message on
// both hosts: test/ws4a-failure-wording.test.js).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { rollbackQuietly, isStorageFullError } = require('../db');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

test('rollbackQuietly: rolls back an open transaction', () => {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE t (x)');
  d.exec('BEGIN'); d.exec('INSERT INTO t VALUES (1)');
  rollbackQuietly(d);
  assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM t').get().n, 0);
});

test('rollbackQuietly: no error when SQLite has already rolled back (keeps the original error visible)', () => {
  const d = new DatabaseSync(':memory:');
  assert.throws(() => d.exec('ROLLBACK'), /no transaction is active/, 'a bare ROLLBACK throws — the error this helper absorbs');
  assert.doesNotThrow(() => rollbackQuietly(d));
});

test('rollbackQuietly: any other rollback failure is still thrown', () => {
  const fake = { exec() { throw new Error('database disk image is malformed'); } };
  assert.throws(() => rollbackQuietly(fake), /malformed/);
});

test('isStorageFullError: SQLITE_FULL / SQLITE_IOERR codes and messages', () => {
  // Q11 (the owner's decision): an SQLITE_IOERR alone is no longer "full". It is only when the browser's
  // quota caused it (test/ws3a-save-errors.test.js); until Q11 these three asserted the opposite.
  assert.ok(!isStorageFullError({ errcode: 10 }));
  // SQLITE_FULL: a database file on a full disk (the phone after the move, the desktop; step 1.4 C11).
  // Until C11 only localStorage existed, and this asserted the opposite.
  assert.ok(isStorageFullError({ errcode: 13 }));
  assert.ok(isStorageFullError({ errcode: 13 | (1 << 8) }));
  assert.ok(!isStorageFullError({ resultCode: 10 | (3 << 8) }));
  assert.ok(!isStorageFullError(new Error('SQLITE_IOERR: sqlite3 result code 10: disk I/O error')));
  assert.ok(isStorageFullError(new Error('Run: database or disk is full (code 13 SQLITE_FULL)')));
  assert.ok(isStorageFullError(new Error('SQLITE_FULL')));
  assert.ok(!isStorageFullError(new Error('UNIQUE constraint failed')));
  assert.ok(!isStorageFullError({ errcode: 19 }));         // SQLITE_CONSTRAINT
  assert.ok(!isStorageFullError(null));
});

test('desktop /api/storage: database size, no app storage limit', async () => {
  const r = await H.get('/api/storage');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.mode, 'desktop');
  assert.strictEqual(r.json.kind, 'desktop');
  assert.ok(r.json.databaseBytes > 0);
  assert.strictEqual(r.json.limitBytes, null);
  assert.strictEqual(r.json.level, 'ok');
});

test('restoring an encrypted backup is there on both targets: the dev server too since D1, no 501', async () => {
  // The whole restore: test/backup-encrypted-restore.test.js. Here only that the route answers.
  const r = await H.post('/api/backup/import-encrypted', {});
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'Enter the passphrase this backup was encrypted with.');
});
