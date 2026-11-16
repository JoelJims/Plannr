// Step 1.4: known-answer files for the encrypted backup format (PLBK version 1).
//
// test/fixtures/backup-kat/ holds two files encrypted ONCE (2026-11-16, part A1) by the two versions
// in use before step 1.4: backup-crypto.js (node:crypto, desktop) and the old public/backup-crypto.js
// (WebCrypto + scrypt-js, phone; made in Chromium). They are never remade. Every version of the
// encryption code must open both, so every backup made so far still opens.
// test-ui/backup-crypto.js opens the same two files in a real browser.
//
// Since part A2 the one encryption is core/backup-crypto.js; the platform supplies scrypt (scrypt-js
// on the phone, node:crypto on the desktop). It is checked here with both, and its own files must
// open with the desktop version, which still has its own code until part A3.
//
// The layout check rebuilds a file from its own salt and IV with node:crypto alone, so it pins the
// byte layout independently of every version:
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

const ROOT = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'fixtures', 'backup-kat');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const PASS = manifest.passphrase;
const plain = fs.readFileSync(path.join(DIR, manifest.plaintext.file));
const sha256 = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const files = manifest.files.map((f) => ({ ...f, size: f.bytes, bytes: fs.readFileSync(path.join(DIR, f.file)) }));
const importFile = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// The two scrypt functions the platforms supply, both with scrypt-js's signature.
const scryptJs = require('scrypt-js').scrypt;
const scryptNode = (pw, salt, N, r, p, dkLen) => new Promise((resolve, reject) => {
  nodeCrypto.scrypt(pw, salt, dkLen, { N, r, p }, (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))));
});
const KDFS = [['scrypt-js (phone)', scryptJs], ['node:crypto (desktop)', scryptNode]];

// The phone's entry point reads scrypt-js from window.scrypt (data-backup.html loads it with a
// <script> tag) and uses the global WebCrypto, which Node has too.
let phoneEntry;
async function loadPhoneEntry() {
  if (!phoneEntry) {
    globalThis.window = globalThis.window || {};
    globalThis.window.scrypt = require('scrypt-js');
    phoneEntry = await importFile('public/backup-crypto.js');
  }
  return phoneEntry;
}

function assertLayout(bytes) {
  const b = Buffer.from(bytes);
  assert.strictEqual(b.subarray(0, 4).toString('latin1'), 'PLBK');
  assert.strictEqual(b[4], 1);
  const salt = b.subarray(5, 21);
  const iv = b.subarray(21, 33);
  const key = nodeCrypto.scryptSync(Buffer.from(PASS, 'utf8'), salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const rebuilt = Buffer.concat([Buffer.from('PLBK', 'latin1'), Buffer.from([1]), salt, iv, cipher.getAuthTag(), ct]);
  assert.ok(rebuilt.equals(b), 'the file differs from the format rebuilt with node:crypto');
}

test('the fixture files are the ones the manifest describes', () => {
  assert.strictEqual(plain.length, manifest.plaintext.bytes);
  assert.strictEqual(sha256(plain), manifest.plaintext.sha256);
  assert.strictEqual(files.length, 2);
  for (const f of files) {
    assert.strictEqual(f.bytes.length, f.size, f.file);
    assert.strictEqual(sha256(f.bytes), f.sha256, `${f.file} changed since it was made`);
  }
  // A non-ASCII passphrase pins that every version turns it into bytes the same way (UTF-8).
  assert.match(PASS, /[^\x00-\x7f]/);
});

test('scrypt-js and node:crypto derive the same key', async () => {
  const salt = files[0].bytes.subarray(5, 21);
  const pw = new TextEncoder().encode(PASS);
  const a = await scryptJs(pw, salt, 16384, 8, 1, 32);
  const b = await scryptNode(pw, salt, 16384, 8, 1, 32);
  assert.ok(Buffer.from(a).equals(Buffer.from(b)));
});

for (const f of files) {
  test(`${f.file} has the PLBK v1 layout, rebuilt byte for byte from its own salt and IV`, () => {
    assertLayout(f.bytes);
  });

  test(`the desktop version opens ${f.file}`, () => {
    const out = desktopVersion.decrypt(f.bytes, PASS);
    assert.ok(out.equals(plain));
    assert.ok(desktopVersion.looksLikeSqlite(out));
    assert.throws(() => desktopVersion.decrypt(f.bytes, PASS + 'x'), /wrong passphrase/);
  });

  test(`the phone's entry point (public/backup-crypto.js) opens ${f.file}`, async () => {
    const phone = await loadPhoneEntry();
    const out = await phone.decrypt(new Uint8Array(f.bytes), PASS);
    assert.ok(Buffer.from(out).equals(plain));
    assert.ok(phone.looksLikeSqlite(out));
    await assert.rejects(phone.decrypt(new Uint8Array(f.bytes), PASS + 'x'), /wrong passphrase/);
  });

  for (const [kdfName, scrypt] of KDFS) {
    test(`core/backup-crypto.js with ${kdfName} opens ${f.file}`, async () => {
      const core = await importFile('core/backup-crypto.js');
      const { decrypt } = core.createBackupCrypto({ scrypt });
      const out = await decrypt(f.bytes, PASS); // a Buffer is a Uint8Array
      assert.ok(Buffer.from(out).equals(plain));
      assert.ok(core.looksLikeSqlite(out));
      await assert.rejects(decrypt(f.bytes, PASS + 'x'), /wrong passphrase/);
    });
  }
}

for (const [kdfName, scrypt] of KDFS) {
  test(`core/backup-crypto.js with ${kdfName} writes the same layout, and the desktop version opens it`, async () => {
    const core = await importFile('core/backup-crypto.js');
    const enc = await core.createBackupCrypto({ scrypt }).encrypt(new Uint8Array(plain), PASS);
    assert.ok(enc instanceof Uint8Array);
    assert.strictEqual(enc.length, core.HEADER_LEN + plain.length);
    assertLayout(enc);
    assert.ok(desktopVersion.decrypt(Buffer.from(enc), PASS).equals(plain));
  });
}

test('core/backup-crypto.js refuses to start without a scrypt, and keeps its other checks', async () => {
  const core = await importFile('core/backup-crypto.js');
  assert.throws(() => core.createBackupCrypto(), /scrypt/);
  const { encrypt, decrypt } = core.createBackupCrypto({ scrypt: scryptNode });
  await assert.rejects(encrypt(new Uint8Array(plain), ''), /empty/);
  await assert.rejects(decrypt(new Uint8Array(10), PASS), /too short/);
  await assert.rejects(decrypt(new Uint8Array(files[0].bytes.length), PASS), /bad magic/);
  const v2 = Buffer.from(files[0].bytes); v2[4] = 2;
  await assert.rejects(decrypt(v2, PASS), /unsupported backup version 2/);
  const changed = Buffer.from(files[0].bytes); changed[changed.length - 1] ^= 1;
  await assert.rejects(decrypt(changed, PASS), /wrong passphrase|corrupt/);
  assert.strictEqual(core.looksLikeSqlite(new TextEncoder().encode('not a database at all')), false);
  assert.strictEqual(core.MIN_PASSPHRASE_LEN, desktopVersion.MIN_PASSPHRASE_LEN);
});

test('public/backup-crypto.js has no encryption code of its own (it uses core/backup-crypto.js)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'backup-crypto.js'), 'utf8');
  assert.match(src, /from '\.\/core\/backup-crypto\.js'/);
  assert.doesNotMatch(src, /subtle|getRandomValues|AES-GCM|PLBK|0x50, 0x4c/);
});
