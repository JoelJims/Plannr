// Step 1.4 A1: known-answer files for the encrypted backup format (PLBK version 1).
//
// test/fixtures/backup-kat/ holds two files encrypted ONCE (2026-11-16) by the two versions in use
// before step 1.4: backup-crypto.js (node:crypto, desktop) and public/backup-crypto.js (WebCrypto +
// scrypt-js, phone; made in Chromium). They are never remade. Every version of the encryption code,
// now and after it becomes one shared file, must open both, so every backup made so far still opens.
// test-ui/backup-crypto.js opens the same two files in a real browser.
//
// The format check below rebuilds each file from its own salt and IV with node:crypto alone, so it
// pins the byte layout independently of either version:
//   'PLBK' | version 1 | salt(16) | iv(12) | auth tag(16) | AES-256-GCM ciphertext
// with the key = scrypt(passphrase as UTF-8, salt, N=16384, r=8, p=1, 32 bytes).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const desktopVersion = require('../backup-crypto');

const DIR = path.join(__dirname, 'fixtures', 'backup-kat');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const PASS = manifest.passphrase;
const plain = fs.readFileSync(path.join(DIR, manifest.plaintext.file));
const sha256 = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const files = manifest.files.map((f) => ({ ...f, size: f.bytes, bytes: fs.readFileSync(path.join(DIR, f.file)) }));

// The phone version reads scrypt-js from window.scrypt (data-backup.html loads it with a <script>
// tag) and uses the global WebCrypto, which Node has too.
let phoneVersion;
async function loadPhoneVersion() {
  if (!phoneVersion) {
    globalThis.window = globalThis.window || {};
    globalThis.window.scrypt = require('scrypt-js');
    phoneVersion = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'backup-crypto.js')).href);
  }
  return phoneVersion;
}

test('the fixture files are the ones the manifest describes', () => {
  assert.strictEqual(plain.length, manifest.plaintext.bytes);
  assert.strictEqual(sha256(plain), manifest.plaintext.sha256);
  assert.strictEqual(files.length, 2);
  for (const f of files) {
    assert.strictEqual(f.bytes.length, f.size, f.file);
    assert.strictEqual(sha256(f.bytes), f.sha256, `${f.file} changed since it was made`);
  }
  // A non-ASCII passphrase pins that both versions turn it into bytes the same way (UTF-8).
  assert.match(PASS, /[^\x00-\x7f]/);
});

for (const f of files) {
  test(`${f.file} has the PLBK v1 layout, rebuilt byte for byte from its own salt and IV`, () => {
    const b = f.bytes;
    assert.strictEqual(b.subarray(0, 4).toString('latin1'), 'PLBK');
    assert.strictEqual(b[4], 1);
    const salt = b.subarray(5, 21);
    const iv = b.subarray(21, 33);
    const key = nodeCrypto.scryptSync(Buffer.from(PASS, 'utf8'), salt, 32, { N: 16384, r: 8, p: 1 });
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const rebuilt = Buffer.concat([Buffer.from('PLBK', 'latin1'), Buffer.from([1]), salt, iv, cipher.getAuthTag(), ct]);
    assert.ok(rebuilt.equals(b), 'the file differs from the format rebuilt with node:crypto');
  });

  test(`the desktop version opens ${f.file}`, () => {
    const out = desktopVersion.decrypt(f.bytes, PASS);
    assert.ok(out.equals(plain));
    assert.ok(desktopVersion.looksLikeSqlite(out));
    assert.throws(() => desktopVersion.decrypt(f.bytes, PASS + 'x'), /wrong passphrase/);
  });

  test(`the phone version opens ${f.file}`, async () => {
    const phone = await loadPhoneVersion();
    const out = await phone.decrypt(new Uint8Array(f.bytes), PASS);
    assert.ok(Buffer.from(out).equals(plain));
    assert.ok(phone.looksLikeSqlite(out));
    await assert.rejects(phone.decrypt(new Uint8Array(f.bytes), PASS + 'x'), /wrong passphrase/);
  });
}
