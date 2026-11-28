// F14 (review 2026-11-21), decided by the owner: "warn at export when a backup is getting large, and
// raise the encrypted-restore limit to a safe higher value". A restore body was limited to 20 MB, and
// an encrypted file travels as base64 (a third larger), so a database over about 15 MB could not be
// restored. The limit is now 32 MB (request-rules.js BODY_LIMITS.backup): an encrypted file of up to
// 24 MB. The Data Backup page asks GET /api/backup/size-note after an export, and shows a note when the
// file is at 75% of what a restore takes or more. Runs on both test passes (desktop and phone code).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { BODY_LIMITS, RESTORE_FILE_LIMITS, BACKUP_WARN_FRACTION, backupSizeNote, tooLarge } = require('../request-rules');

const MB = 1024 * 1024;
before(async () => { await H.startApp(); H.seedLoggedIn(); });
after(async () => { await H.stopApp(); });

function bodyOfSize(bytes, fields = {}) {
  const base = JSON.stringify({ ...fields, pad: '' });
  return JSON.stringify({ ...fields, pad: 'p'.repeat(bytes - base.length) });
}

test('F14: one limit, 32 MB, and the largest file each restore takes', () => {
  assert.strictEqual(BODY_LIMITS.backup, 32 * MB);
  assert.strictEqual(RESTORE_FILE_LIMITS.json, 32 * MB);
  // An encrypted file as base64 (4 characters per 3 bytes), with 1 KB left for the passphrase.
  assert.strictEqual(RESTORE_FILE_LIMITS.encrypted, Math.floor((32 * MB - 1024) / 4) * 3);
  const enc = RESTORE_FILE_LIMITS.encrypted;
  const body = JSON.stringify({ passphrase: 'p'.repeat(200), dataBase64: Buffer.alloc(enc).toString('base64') });
  assert.ok(body.length <= BODY_LIMITS.backup, 'an encrypted file at the limit, with a long passphrase, fits the body limit');
  assert.ok(enc > 23.9 * MB, 'every database the storage meter calls healthy (under 23 MB) can be restored');
  assert.strictEqual(tooLarge('backup').error, 'That backup file is too large to restore: the limit is 24 MB for an encrypted backup and 32 MB for a JSON backup.');
});

test('F14: a restore body over the old 20 MB limit is no longer refused for its size', async () => {
  for (const route of ['/api/backup/import', '/api/backup/import-encrypted']) {
    const old = await H.post(route, bodyOfSize(20 * MB + 1, { passphrase: 'x'.repeat(12), dataBase64: 'AAAA' }));
    assert.notStrictEqual(old.status, 413, `${route}: ${JSON.stringify(old.json)}`);
    const over = await H.post(route, bodyOfSize(BODY_LIMITS.backup + 1, { passphrase: 'x'.repeat(12) }));
    assert.strictEqual(over.status, 413, route);
    assert.strictEqual(over.json.error, tooLarge('backup').error, route);
  }
});

test('F14: the export note shows from 75% of the restore limit, and not below it', () => {
  assert.strictEqual(BACKUP_WARN_FRACTION, 0.75);
  for (const kind of ['encrypted', 'json']) {
    const limit = RESTORE_FILE_LIMITS[kind];
    const from = Math.ceil(limit * 0.75);
    assert.strictEqual(backupSizeNote(kind, 300 * 1024), null, `${kind}: a normal backup gets no note`);
    assert.strictEqual(backupSizeNote(kind, from - 1), null, `${kind}: just under 75%`);
    const near = backupSizeNote(kind, from);
    assert.ok(near, `${kind}: at 75%`);
    assert.match(near, /^This backup is getting large: [\d.]+ MB of the (24|32) MB that Plannr can restore/, near);
    assert.match(near, /Recycle Bin/, 'it says what to do');
    const over = backupSizeNote(kind, limit + 1);
    assert.match(over, /over the (24|32) MB limit/, over);
    assert.match(over, /cannot be restored/, over);
  }
  assert.match(backupSizeNote('encrypted', 20 * MB), /^This backup is getting large: 20 MB of the 24 MB that Plannr can restore from an encrypted backup\./);
  assert.strictEqual(backupSizeNote('csv', 99 * MB), null, 'an unknown kind gets no note');
});

test('F14: the API answers the note for a file size (what the Data Backup page asks)', async () => {
  const none = await H.get(`/api/backup/size-note?kind=encrypted&bytes=${300 * 1024}`);
  assert.deepStrictEqual([none.status, none.json], [200, { note: null }]);
  const near = await H.get(`/api/backup/size-note?kind=encrypted&bytes=${20 * MB}`);
  assert.strictEqual(near.status, 200);
  assert.strictEqual(near.json.note, backupSizeNote('encrypted', 20 * MB));
  const json = await H.get(`/api/backup/size-note?kind=json&bytes=${30 * MB}`);
  assert.strictEqual(json.json.note, backupSizeNote('json', 30 * MB));
  for (const q of ['kind=zip&bytes=5', 'kind=json&bytes=-1', 'kind=json&bytes=abc', 'kind=json']) {
    const bad = await H.get(`/api/backup/size-note?${q}`);
    assert.strictEqual(bad.status, 400, q);
  }
});
