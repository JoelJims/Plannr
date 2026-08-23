// One-time maintenance: wipe ALL Plannr data for a fresh start.
//
// Empties every table but LEAVES THE SCHEMA INTACT (no DROP/ALTER — tables and
// columns stay, just emptied) and resets the AUTOINCREMENT counters so new rows
// start at id 1. Prints a before/after row count per table.
//
// Run via `npm run reset-db` (which passes --confirm). --confirm only confirms INTENT; the
// db-guard below confirms the TARGET — it prints the absolute path about to be wiped and refuses
// the LIVE database unless --i-really-mean-the-live-db is also given. There is deliberately NO
// in-app button.
//
// Table list is DERIVED from sqlite_master (every real table, excluding SQLite's
// internal sqlite_% tables) — never a hardcoded array — so a table added later
// (or a legacy one like contract_services that the schema file doesn't create) can
// never be silently skipped and then falsely reported as "all empty". Deletion order
// is removed as a concern entirely: foreign keys are disabled for the wipe, so any
// order is safe; PRAGMA foreign_key_check afterwards proves nothing was orphaned.

// Guard the TARGET first (prints the absolute path; refuses live without the flag) — BEFORE
// require('./db'), which opens the connection at load time.
require('./db-guard').guardDbTarget();

if (!process.argv.includes('--confirm')) {
  console.error('reset-db: this DELETES ALL DATA in every table (schema stays intact).');
  console.error('          Re-run with `npm run reset-db` (or add --confirm) to proceed.');
  process.exit(1);
}

const { db, init } = require('./db');

init(); // make sure the schema exists before counting/deleting

// SINGLE SOURCE OF TRUTH: every real table, straight from the catalogue.
const TABLES = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

const count = () => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
const before = count();

// Disable foreign keys for the wipe so deletion ORDER stops mattering (no parent-
// before-child ordering, no accidental cascade). CRITICAL: PRAGMA foreign_keys is a
// NO-OP inside a transaction, so it MUST be set BEFORE BEGIN and restored AFTER COMMIT.
db.exec('PRAGMA foreign_keys = OFF');
// Verify empirically that enforcement is actually OFF now — don't assume the statement
// took (if we were somehow mid-transaction it would silently stay ON).
const fkDuringWipe = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
if (fkDuringWipe !== 0) {
  console.error(`reset-db: refused — foreign keys are still ENFORCED (PRAGMA foreign_keys = ${fkDuringWipe}) after asking to disable them. Aborting to avoid an order-dependent partial wipe.`);
  process.exit(1);
}

db.exec('BEGIN');
for (const t of TABLES) db.exec(`DELETE FROM ${t}`); // any order — FKs are off
// Reset AUTOINCREMENT counters (only AUTOINCREMENT tables appear here) → ids restart at 1.
try { db.exec('DELETE FROM sqlite_sequence'); } catch { /* table absent if no autoincrement rows ever existed */ }
db.exec('COMMIT');

db.exec('PRAGMA foreign_keys = ON'); // restore enforcement
// Prove the wipe left NO dangling foreign key (empty tables can't, but assert it rather
// than trust it — this is the real check that FK-off didn't hide an integrity problem).
const fkViolations = db.prepare('PRAGMA foreign_key_check').all();

const after = count();

const pad = (s, n) => String(s).padEnd(n);
console.log('\n  Plannr data wipe — per-table row counts:\n');
console.log('  ' + pad('table', 24) + pad('before', 9) + 'after');
console.log('  ' + '-'.repeat(40));
for (const t of TABLES) console.log('  ' + pad(t, 24) + pad(before[t], 9) + after[t]);

const remaining = TABLES.reduce((a, t) => a + after[t], 0);
const clean = remaining === 0 && fkViolations.length === 0;
console.log('\n  foreign_keys during wipe: OFF (verified) — post-wipe foreign_key_check: ' +
  (fkViolations.length === 0 ? 'clean' : `${fkViolations.length} violation(s) — ${JSON.stringify(fkViolations)}`));
console.log('  ' + (clean
  ? '✓ all tables empty; schema intact; AUTOINCREMENT ids reset to start at 1.'
  : (remaining > 0 ? '✗ ' + remaining + ' rows remain (unexpected).' : '✗ foreign key check failed after wipe.')));

try { db.close(); } catch { /* ignore */ }
process.exit(clean ? 0 : 1);
