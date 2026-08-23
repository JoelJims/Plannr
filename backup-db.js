// Plannr — offsite-ready database backup.
//
// Produces a CONSISTENT, self-contained snapshot of the live DB with SQLite's `VACUUM INTO`. One
// thing this buys us: it is safe to run WHILE the server is live (it takes a read transaction, never
// writes the source). (Phase 4a: journal_mode is DELETE, not WAL — see db.js — so a plain file copy of
// plannr.db is already complete; VACUUM INTO is kept anyway for the live-server safety property above.)
//
// Snapshots are written OUTSIDE the project directory (default: ~/PlannrBackups) so a project-dir or
// disk loss doesn't take the backups with it. Point PLANNR_BACKUP_DIR at a synced/offsite folder
// (OneDrive, a network share, an external drive) to make them truly offsite — see README.
//
// Run:  node backup-db.js      (manual)  |  backup-db.cmd  (what the scheduled task runs)

// Part E — the snapshot is ENCRYPTED (AES-256-GCM) when PLANNR_BACKUP_PASSPHRASE is set. The passphrase
// comes from an env var (never a prompt) so the scheduled 02:00 task still runs unattended; it is never
// logged, never in a filename, never committed (.env is gitignored). With NO passphrase, the plaintext
// snapshot is still written (backups never silently stop) but a loud ENCRYPTION-OFF warning is printed.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('node:crypto');
const { encrypt, decrypt, looksLikeSqlite } = require('./backup-crypto');

// Load .env so PLANNR_BACKUP_PASSPHRASE set there reaches this UNATTENDED script (backup-db.cmd runs
// `node backup-db.js` without npm, so nothing else loads it). Guarded: an already-set env var wins, and
// a missing .env (e.g. restoring on another machine) is fine. Never prints the file's contents.
if (!process.env.PLANNR_BACKUP_PASSPHRASE) { try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env — rely on the real environment */ } }

const DB_PATH = process.env.PLANNR_DB || path.join(__dirname, 'data', 'plannr.db');
// OUTSIDE the project by default. Override with PLANNR_BACKUP_DIR (e.g. a OneDrive/synced folder).
const BACKUP_DIR = process.env.PLANNR_BACKUP_DIR || path.join(os.homedir(), 'PlannrBackups');
const KEEP = Number(process.env.PLANNR_BACKUP_KEEP || 14); // keep the newest N snapshots
const PASSPHRASE = process.env.PLANNR_BACKUP_PASSPHRASE || '';

// Local timestamp YYYYMMDD-HHMMSS — sorts chronologically as a plain string, so retention can sort by name.
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// Matches both the encrypted (.db.enc) and legacy/plaintext (.db) snapshot names, so retention prunes both.
const SNAP_RE = /^plannr-\d{8}-\d{6}\.db(\.enc)?$/;

// VACUUM INTO a clean, self-contained copy (safe while the server is live — see header comment).
// Prefers a read-only handle; falls back to read-write if this SQLite build wants one. Never modifies the source.
function vacuumInto(destPath) {
  const destSql = destPath.split('\\').join('/'); // SQLite wants forward slashes in the SQL string literal
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec(`VACUUM INTO '${destSql}'`);
  } catch (e) {
    try { if (db) db.close(); } catch { /* ignore */ }
    db = new DatabaseSync(DB_PATH);
    db.exec(`VACUUM INTO '${destSql}'`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Open a plaintext snapshot and count its tables — guards against a silent near-empty copy.
function tableCount(dbPath) {
  const chk = new DatabaseSync(dbPath, { readOnly: true });
  const n = chk.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
  chk.close();
  return n;
}

function snapshot() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backup] no database at ${DB_PATH} — nothing to back up.`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = `plannr-${stamp()}`;

  if (!PASSPHRASE) {
    // ── plaintext path (no passphrase) ──────────────────────────────────────────────────────────────
    console.warn('[backup] ⚠ ENCRYPTION OFF — set PLANNR_BACKUP_PASSPHRASE (in .env) to encrypt snapshots. Writing a PLAINTEXT backup.');
    const dest = path.join(BACKUP_DIR, `${base}.db`);
    vacuumInto(dest);
    const tables = tableCount(dest);
    if (tables < 1) { console.error(`[backup] snapshot ${dest} has no tables — aborting (something is wrong).`); process.exit(1); }
    console.log(`[backup] wrote ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB, ${tables} tables, UNENCRYPTED).`);
  } else {
    // ── encrypted path ──────────────────────────────────────────────────────────────────────────────
    // VACUUM INTO a temp plaintext file, sanity-check + read it, encrypt to the .db.enc, delete the temp.
    const tmp = path.join(os.tmpdir(), `plannr-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
    const dest = path.join(BACKUP_DIR, `${base}.db.enc`);
    let tables;
    try {
      vacuumInto(tmp);
      tables = tableCount(tmp);
      if (tables < 1) { console.error(`[backup] snapshot has no tables — aborting (something is wrong).`); process.exit(1); }
      const plain = fs.readFileSync(tmp);
      const enc = encrypt(plain, PASSPHRASE);
      fs.writeFileSync(dest, enc);
      // "An encrypted backup you haven't decrypted is not a backup": prove THIS file decrypts NOW with
      // the current passphrase before we trust it (and before we prune older ones).
      if (!looksLikeSqlite(decrypt(fs.readFileSync(dest), PASSPHRASE))) {
        console.error(`[backup] verification FAILED — ${dest} did not decrypt to a SQLite file. Aborting.`);
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        process.exit(1);
      }
    } finally {
      for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* ignore */ } }
    }
    console.log(`[backup] wrote ${dest} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB, ${tables} tables, ENCRYPTED aes-256-gcm; verified decryptable).`);
  }

  // Retention: keep the newest KEEP (across .db and .db.enc), delete the rest. Tolerant of delete failures.
  const snaps = fs.readdirSync(BACKUP_DIR).filter((f) => SNAP_RE.test(f)).sort();
  for (const f of snaps.slice(0, Math.max(0, snaps.length - KEEP))) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); console.log(`[backup] pruned old snapshot ${f}`); }
    catch (e) { console.error(`[backup] could not prune ${f}:`, e.message); }
  }
  console.log(`[backup] ${Math.min(snaps.length, KEEP)} snapshot(s) kept in ${BACKUP_DIR}.`);
}

snapshot();
