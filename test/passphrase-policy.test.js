// Phase 1 safety — new encrypted backups need a passphrase of at least MIN_PASSPHRASE_LEN characters
// (a short one can be brute-forced by anyone holding the file). Only NEW backups are checked: the
// limit lives in the export route, not in decrypt(), so older backups with short passphrases still open.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MIN_PASSPHRASE_LEN, decrypt, encrypt } = require('../backup-crypto');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

// H.raw rather than H.post: the success body is binary, which H.req would decode as text.
const exportEnc = (passphrase) => H.raw('POST', '/api/backup/export-encrypted', { passphrase });

test('the minimum is 10 characters', () => {
  assert.strictEqual(MIN_PASSPHRASE_LEN, 10);
});

test('export-encrypted refuses a passphrase shorter than the minimum', async () => {
  const res = await exportEnc('a'.repeat(MIN_PASSPHRASE_LEN - 1));
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /at least 10 characters/);
});

test('export-encrypted counts characters, not bytes', async () => {
  // 9 two-byte characters = 18 bytes but only 9 characters, so it is still too short.
  assert.strictEqual((await exportEnc('é'.repeat(9))).status, 400);
});

test('export-encrypted accepts a passphrase of exactly the minimum, and it decrypts', async () => {
  const pass = 'b'.repeat(MIN_PASSPHRASE_LEN);
  const res = await exportEnc(pass);
  assert.strictEqual(res.status, 200);
  const enc = await res.bytes();
  assert.ok(decrypt(enc, pass).length > 0);
});

test('an old backup with a short passphrase still decrypts', () => {
  const enc = encrypt(Buffer.from('SQLite format 3\0old backup'), 'short');
  assert.strictEqual(decrypt(enc, 'short').toString('latin1'), 'SQLite format 3\0old backup');
});
