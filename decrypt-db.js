// Plannr — decrypt an encrypted backup (Part E). The matching restore step for backup-db.js.
//
//   PLANNR_BACKUP_PASSPHRASE=… node decrypt-db.js <input.db.enc> <output.db>
//
// Reads the passphrase from the SAME env var backup-db.js uses (never a prompt, never an argument —
// argv shows up in `ps`/history). Writes the decrypted plaintext SQLite file to <output.db>. Routed
// through db-guard so it REFUSES to write over the live data/plannr.db unless --i-really-mean-the-live-db
// is given (restore-to-scratch is the normal path). Prints only sizes/paths — never the passphrase.

const fs = require('node:fs');
const path = require('node:path');
const { decrypt, looksLikeSqlite } = require('./backup-crypto');
const { guardDbTarget } = require('./db-guard');

// Pick up PLANNR_BACKUP_PASSPHRASE from .env if it isn't already in the environment (an explicitly-set
// env var always wins). Guarded so restoring on a machine without a .env just uses the real environment.
if (!process.env.PLANNR_BACKUP_PASSPHRASE) { try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env — rely on the real environment */ } }

function fail(msg) { console.error(`[decrypt] ${msg}`); process.exit(1); }

const args = process.argv.slice(2).filter((a) => a !== '--i-really-mean-the-live-db');
const input = args[0];
const output = args[1];

if (!input || !output) {
  fail('usage: PLANNR_BACKUP_PASSPHRASE=… node decrypt-db.js <input.db.enc> <output.db> [--i-really-mean-the-live-db]');
}
const passphrase = process.env.PLANNR_BACKUP_PASSPHRASE || '';
if (!passphrase) {
  fail('PLANNR_BACKUP_PASSPHRASE is not set — cannot decrypt. Set it (the same value used to make the backup) and retry.');
}
if (!fs.existsSync(input)) fail(`input file not found: ${input}`);

// Guard the OUTPUT path against clobbering the live DB. guardDbTarget reads PLANNR_DB, so point it at
// the requested output; it prints the absolute target and refuses live-without-flag, changing nothing.
process.env.PLANNR_DB = path.resolve(output);
const target = guardDbTarget();

let plain;
try {
  plain = decrypt(fs.readFileSync(input), passphrase);
} catch (e) {
  fail(e.message); // "wrong passphrase, or the backup file is corrupt/tampered." — never echoes the passphrase
}
if (!looksLikeSqlite(plain)) fail('decrypted output does not look like a SQLite database — aborting.');

fs.writeFileSync(target, plain);
console.log(`[decrypt] wrote ${target} (${(plain.length / 1024).toFixed(1)} KB, decrypted, looks like SQLite).`);
console.log('[decrypt] before opening it in place: remove any stale -wal/-shm sidecars of the target (see README → Restore).');
