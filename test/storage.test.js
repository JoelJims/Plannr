// Phase 2, Step 3 (M8) — storage limit helpers that the node side can check. The phone's real limit,
// the meter and the "Storage is full" messages run in a browser: test-ui/storage-limit.js.
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
  assert.ok(isStorageFullError({ errcode: 10 }));          // SQLITE_IOERR (kvvfs quota)
  // SQLITE_FULL: a database file on a full disk (the phone after the move, the desktop; step 1.4 C11).
  // Until C11 only localStorage existed, and this asserted the opposite.
  assert.ok(isStorageFullError({ errcode: 13 }));
  assert.ok(isStorageFullError({ errcode: 13 | (1 << 8) }));
  assert.ok(isStorageFullError({ resultCode: 10 | (3 << 8) }));
  assert.ok(isStorageFullError(new Error('SQLITE_IOERR: sqlite3 result code 10: disk I/O error')));
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

test('desktop: restoring an encrypted backup answers 501 with what to do instead (until D1)', { skip: H.TARGET === 'shim' && 'the phone restores' }, async () => {
  for (const body of [{}, { passphrase: 'x'.repeat(12), dataBase64: 'AAAA' }]) {
    const r = await H.post('/api/backup/import-encrypted', body);
    assert.strictEqual(r.status, 501);
    assert.match(r.json.error, /^Restoring from an encrypted backup isn’t available when Plannr is running as a hosted server\. Use the Android app/);
  }
});
