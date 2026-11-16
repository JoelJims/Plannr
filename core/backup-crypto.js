// The one backup encryption, shared by the phone and the desktop (step 1.4 A2).
//
// File layout, PLBK version 1 (unchanged; test/fixtures/backup-kat/ pins it byte for byte):
//
//   'PLBK'(4) | version 1 (1) | salt(16) | iv(12) | auth tag(16) | ciphertext(...)
//
// Key: scrypt(passphrase as UTF-8, salt, N=16384, r=8, p=1, 32 bytes). Cipher: AES-256-GCM. GCM's
// auth tag makes a wrong passphrase or a changed file FAIL LOUDLY on decrypt, never return garbage.
//
// AES-GCM comes from WebCrypto (globalThis.crypto.subtle), which the Android WebView, Chromium and
// Node 22+ all have. WebCrypto has no scrypt, so each platform supplies one through
// createBackupCrypto({ scrypt }):
//   - the phone: scrypt-js, loaded by data-backup.html as window.scrypt (public/backup-crypto.js);
//   - the desktop: node:crypto's scrypt (backup-crypto.js, step 1.4 A3).
// Both give the same bytes for the same inputs (test/backup-kat.test.js checks it).
//
// WebCrypto returns the auth tag APPENDED to the ciphertext. The file keeps it BEFORE the
// ciphertext (the layout the desktop has always written), so encrypt() splits them and decrypt()
// joins them back.
//
// Whole-file buffers: a Plannr database is KB to a few MB.

const MAGIC = new Uint8Array([0x50, 0x4c, 0x42, 0x4b]); // 'PLBK', "Plannr BacKup"
export const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12; // GCM's standard nonce length
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN; // 4+1+16+12+16 = 49
export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, dkLen: 32 }); // dkLen 32 = AES-256

// Minimum passphrase length for NEW encrypted backups. The export routes check it; decrypt() does
// not, so older backups made with shorter passphrases still open. data-backup.html shows the same
// number.
export const MIN_PASSPHRASE_LEN = 10;

// A SQLite file starts with these 16 bytes: "SQLite format 3" and a NUL (0x00, not a space).
// A cheap "did we really decrypt a database?".
const SQLITE_MAGIC = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]);

function bytesStartWith(haystack, needle) {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) if (haystack[i] !== needle[i]) return false;
  return true;
}

// Accepts any Uint8Array (a Node Buffer is one).
export function looksLikeSqlite(bytes) {
  return bytes instanceof Uint8Array && bytesStartWith(bytes, SQLITE_MAGIC);
}

// scrypt(passwordBytes, salt, N, r, p, dkLen) -> Promise<Uint8Array> (scrypt-js's signature).
export function createBackupCrypto({ scrypt } = {}) {
  if (typeof scrypt !== 'function') throw new Error('createBackupCrypto: the platform must supply a scrypt function.');
  const subtle = globalThis.crypto && globalThis.crypto.subtle;

  async function deriveKey(passphrase, salt) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      throw new Error('backup passphrase is empty — refusing to derive a key from nothing.');
    }
    if (!subtle) throw new Error('backup-crypto: this platform has no WebCrypto (crypto.subtle).');
    const { N, r, p, dkLen } = SCRYPT_PARAMS;
    const keyBytes = await scrypt(new TextEncoder().encode(passphrase), salt, N, r, p, dkLen);
    return subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // Uint8Array -> encrypted Uint8Array.
  async function encrypt(plain, passphrase) {
    if (!(plain instanceof Uint8Array)) throw new Error('encrypt() expects a Uint8Array.');
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(passphrase, salt);
    const combined = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: TAG_LEN * 8 }, key, plain));
    const ciphertext = combined.subarray(0, combined.length - TAG_LEN);
    const tag = combined.subarray(combined.length - TAG_LEN);

    const out = new Uint8Array(HEADER_LEN + ciphertext.length);
    let o = 0;
    out.set(MAGIC, o); o += MAGIC.length;
    out[o] = VERSION; o += 1;
    out.set(salt, o); o += SALT_LEN;
    out.set(iv, o); o += IV_LEN;
    out.set(tag, o); o += TAG_LEN;
    out.set(ciphertext, o);
    return out;
  }

  // Encrypted Uint8Array -> decrypted Uint8Array. Throws on a wrong passphrase, a changed file or a
  // bad header.
  async function decrypt(enc, passphrase) {
    if (!(enc instanceof Uint8Array)) throw new Error('decrypt() expects a Uint8Array.');
    if (enc.length < HEADER_LEN) throw new Error('not a Plannr encrypted backup (too short).');
    if (!bytesStartWith(enc, MAGIC)) throw new Error('not a Plannr encrypted backup (bad magic).');
    let o = MAGIC.length;
    const version = enc[o]; o += 1;
    if (version !== VERSION) throw new Error(`unsupported backup version ${version} (this build reads v${VERSION}).`);
    const salt = enc.subarray(o, o + SALT_LEN); o += SALT_LEN;
    const iv = enc.subarray(o, o + IV_LEN); o += IV_LEN;
    const tag = enc.subarray(o, o + TAG_LEN); o += TAG_LEN;
    const ciphertext = enc.subarray(o);
    const key = await deriveKey(passphrase, salt);
    const combined = new Uint8Array(ciphertext.length + TAG_LEN);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: TAG_LEN * 8 }, key, combined));
    } catch {
      // A failed auth-tag check rejects: the wrong-passphrase signal.
      throw new Error('decryption failed — wrong passphrase, or the backup file is corrupt/tampered.');
    }
  }

  return { encrypt, decrypt };
}
