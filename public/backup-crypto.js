// Phase 7 — browser-side backup encryption (Web Crypto + scrypt-js). Mirrors backup-crypto.js's
// exact binary format so a file encrypted by either side decrypts on the other:
//
//   MAGIC(4) | VERSION(1) | salt(16) | iv(12) | authTag(16) | ciphertext(...)
//
// Key derivation: scrypt(passphrase, salt, N=16384, r=8, p=1, dkLen=32) — Node's crypto.scryptSync
// defaults, reproduced exactly via scrypt-js (a real dependency, deliberately — see Phase 7's report
// for why: Web Crypto has no scrypt, and switching to PBKDF2 would either weaken the KDF or still need
// scrypt for reading pre-existing backups, so it doesn't actually avoid the dependency). Loaded as a
// classic <script src="/node_modules/scrypt-js/scrypt.js"> (a UMD build, no ES export — see that tag's
// comment in data-backup.html), exposing window.scrypt.
//
// AES-256-GCM via crypto.subtle for the cipher. One real format-boundary translation: Web Crypto's
// AES-GCM returns ciphertext with the auth tag APPENDED at the end of one buffer; Node's API returns
// them separately (cipher.getAuthTag() vs cipher.update()+cipher.final()). This module splits/joins
// them at encrypt/decrypt time so the ON-DISK LAYOUT (tag BEFORE ciphertext, per the format above)
// matches Node's byte-for-byte.

const MAGIC = new Uint8Array([0x50, 0x4c, 0x42, 0x4b]); // 'PLBK'
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12; // GCM's standard nonce length
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN; // 4+1+16+12+16 = 49

// 16 bytes, matching backup-crypto.js's Node-side constant EXACTLY: "SQLite format 3" + a trailing
// NUL byte (not a space — easy to mistranscribe, since a NUL renders invisibly; TextEncoder would
// encode a literal space as 0x20, not SQLite's real header byte 0x00).
const SQLITE_MAGIC = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]);

function bytesStartWith(haystack, needle) {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) if (haystack[i] !== needle[i]) return false;
  return true;
}

// A SQLite file always starts with this 16-byte magic string — a cheap "did we really decrypt a DB?".
export function looksLikeSqlite(bytes) {
  return bytes instanceof Uint8Array && bytesStartWith(bytes, SQLITE_MAGIC);
}

async function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('backup passphrase is empty — refusing to derive a key from nothing.');
  }
  if (!window.scrypt || typeof window.scrypt.scrypt !== 'function') {
    throw new Error('backup-crypto: scrypt-js was not loaded — this page needs <script src="/node_modules/scrypt-js/scrypt.js"> before this module is used.');
  }
  const passwordBytes = new TextEncoder().encode(passphrase); // UTF-8 — matches Node's string->key handling for scryptSync
  const keyBytes = await window.scrypt.scrypt(passwordBytes, salt, 16384, 8, 1, 32); // N/r/p/dkLen = Node's scryptSync defaults
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Uint8Array -> encrypted Uint8Array.
export async function encrypt(plain, passphrase) {
  if (!(plain instanceof Uint8Array)) throw new Error('encrypt() expects a Uint8Array.');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);
  // See header comment: split the tag off the end so it can be written BEFORE the ciphertext, as
  // Node's format expects.
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: TAG_LEN * 8 }, key, plain));
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

// encrypted Uint8Array -> decrypted Uint8Array. Throws on a bad passphrase, a tampered file, or a bad header.
export async function decrypt(enc, passphrase) {
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
  // Web Crypto wants the tag APPENDED to the ciphertext for decrypt — rejoin in that order (the
  // reverse of encrypt()'s split above).
  const combined = new Uint8Array(ciphertext.length + TAG_LEN);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: TAG_LEN * 8 }, key, combined));
  } catch {
    // crypto.subtle.decrypt rejects on a failed auth-tag check — same "fail loudly, never garbage"
    // property as Node's decipher.final() throw.
    throw new Error('decryption failed — wrong passphrase, or the backup file is corrupt/tampered.');
  }
}
