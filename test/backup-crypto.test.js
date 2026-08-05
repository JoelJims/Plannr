// Part E — encrypted-backup round trip. Prove: encrypt a real DB snapshot, decrypt it to a scratch
// path, and the restored DB still reads 11 cash_out rows summing 78000000 paise (₹7,80,000 — the live
// fixture the README verifies). Plus: a wrong passphrase and a tampered file both fail loudly.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const backupCrypto = require('../backup-crypto');

const PASS = 'a-correct-backup-passphrase-123';
const scratch = [];
function scratchPath(suffix) {
  const p = path.join(os.tmpdir(), `plannr-enc-${process.pid}-${crypto.randomBytes(5).toString('hex')}${suffix}`);
  scratch.push(p);
  return p;
}

let plainBuf; // a clean plaintext snapshot of a DB holding exactly the fixture

before(() => {
  // Seed exactly 11 cash_out rows summing 78000000 paise (10×7,00,000 + 1×8,00,000).
  const user = H.seedUser();
  for (let i = 0; i < 10; i++) H.seedCashOut({ amountPaise: 7000000, byUserId: user.id, tenantId: user.id });
  H.seedCashOut({ amountPaise: 8000000, byUserId: user.id, tenantId: user.id });
  const fixture = H.db.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM cash_out').get();
  assert.strictEqual(fixture.n, 11);
  assert.strictEqual(fixture.s, 78000000);

  // Produce a clean, self-contained plaintext snapshot the same way backup-db.js does (VACUUM INTO).
  const snap = scratchPath('.db');
  H.db.exec(`VACUUM INTO '${snap.split('\\').join('/')}'`);
  plainBuf = fs.readFileSync(snap);
});

after(() => { for (const p of scratch) for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + s); } catch { /* ignore */ } } });

test('round trip: encrypt then decrypt reproduces a DB that still reads 11 rows / SUM 78000000', () => {
  const enc = backupCrypto.encrypt(plainBuf, PASS);
  assert.ok(!enc.equals(plainBuf), 'ciphertext must not equal plaintext');
  assert.ok(!backupCrypto.looksLikeSqlite(enc), 'the encrypted blob must NOT look like a plaintext SQLite file');

  const dec = backupCrypto.decrypt(enc, PASS);
  assert.ok(backupCrypto.looksLikeSqlite(dec), 'decrypted output must be a SQLite file');

  const out = scratchPath('.db');
  fs.writeFileSync(out, dec);
  const d = new DatabaseSync(out, { readOnly: true });
  const r = d.prepare('SELECT COUNT(*) n, SUM(amount_paise) s FROM cash_out').get();
  d.close();
  assert.strictEqual(r.n, 11, 'restored DB must hold 11 cash_out rows');
  assert.strictEqual(r.s, 78000000, 'restored DB must sum to 78000000 paise');
});

test('wrong passphrase fails loudly (never returns garbage)', () => {
  const enc = backupCrypto.encrypt(plainBuf, PASS);
  assert.throws(() => backupCrypto.decrypt(enc, 'the-wrong-passphrase'), /wrong passphrase|corrupt|tampered/);
});

test('a tampered ciphertext fails the auth tag', () => {
  const enc = backupCrypto.encrypt(plainBuf, PASS);
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 0xff; // flip a byte of the ciphertext
  assert.throws(() => backupCrypto.decrypt(tampered, PASS), /wrong passphrase|corrupt|tampered/);
});

test('an empty passphrase is refused (no key derived from nothing)', () => {
  assert.throws(() => backupCrypto.encrypt(plainBuf, ''), /empty/);
});
