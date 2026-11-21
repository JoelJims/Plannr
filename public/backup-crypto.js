// The phone's backup encryption. Since step 1.4 A2 the code itself is core/backup-crypto.js, shared
// with the desktop; this file only supplies the phone's scrypt. The file format is unchanged.
//
// scrypt comes from scrypt-js, which data-backup.html loads with a classic
// <script src="/node_modules/scrypt-js/scrypt.js"> (a UMD build with no ES export; see that tag's
// comment), so it is window.scrypt here. WebCrypto has no scrypt, and switching to PBKDF2 would
// weaken the key derivation and still need scrypt to read existing backups.

import { createBackupCrypto } from './core/backup-crypto.js';

export { looksLikeSqlite, MIN_PASSPHRASE_LEN, HEADER_LEN, VERSION } from './core/backup-crypto.js';

function scryptFromPage(password, salt, N, r, p, dkLen) {
  if (!window.scrypt || typeof window.scrypt.scrypt !== 'function') {
    throw new Error('backup-crypto: scrypt-js was not loaded — this page needs <script src="/node_modules/scrypt-js/scrypt.js"> before this module is used.');
  }
  return window.scrypt.scrypt(password, salt, N, r, p, dkLen);
}

export const { encrypt, decrypt } = createBackupCrypto({ scrypt: scryptFromPage });
