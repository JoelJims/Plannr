// Shared LIVE-database guard for NON-SERVER entry points (dev / maintenance / verification scripts).
//
// Why this exists: db.js defaults DB_PATH to the live data/plannr.db when PLANNR_DB is unset. That
// default is correct for server.js, but for a one-off script a single forgotten `PLANNR_DB=…`
// silently targets PRODUCTION — which has now written to the live DB twice during testing. Every
// script that can write MUST call guardDbTarget() BEFORE it opens a database or requires ./db.
//
// The guard treats an UNSET PLANNR_DB as "targeting live" (not a neutral default): it prints the
// absolute path it is about to use and REFUSES if that path is the live database, unless the caller
// passes the unmistakable flag --i-really-mean-the-live-db. Server.js does NOT use this guard and
// keeps defaulting to live with no flag.
//
// It is ONE shared module on purpose: a guard copied per script is one that eventually gets omitted.

const path = require('path');

// The live path, resolved the SAME way db.js resolves its default (repo /data/plannr.db).
const LIVE_DB_PATH = path.resolve(__dirname, 'data', 'plannr.db');
const LIVE_FLAG = '--i-really-mean-the-live-db';

// Case-insensitive absolute compare on Windows (its filesystem is case-insensitive).
function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

// Resolve + guard the database a script is about to write to. Prints the absolute target to stderr.
// Refuses (exit 1, having changed nothing) if it is the live DB and the live flag is absent. On
// success it makes the resolved absolute path authoritative by writing it back to process.env.
// PLANNR_DB, so a subsequent require('./db') opens exactly the path that was printed and approved.
// Returns the resolved absolute path.
function guardDbTarget() {
  const raw = process.env.PLANNR_DB && process.env.PLANNR_DB.trim() !== '' ? process.env.PLANNR_DB.trim() : null;
  const target = raw ? path.resolve(raw) : LIVE_DB_PATH;   // UNSET PLANNR_DB == targeting live
  const live = samePath(target, LIVE_DB_PATH);
  const flag = process.argv.includes(LIVE_FLAG);
  const script = path.basename(process.argv[1] || 'script.js');

  console.error(`[db-guard] target database: ${target}${raw ? '' : '   (PLANNR_DB is UNSET — that means LIVE)'}`);

  if (live && !flag) {
    console.error('[db-guard] REFUSING — this is the LIVE database (data/plannr.db) and nothing has been changed.');
    console.error(`[db-guard]   • to run against an isolated copy:   PLANNR_DB=/tmp/plannr-test.db node ${script} …`);
    console.error(`[db-guard]   • to DELIBERATELY target live, add:  ${LIVE_FLAG}`);
    process.exit(1);
  }
  if (live) console.error(`[db-guard] proceeding against the LIVE database (${LIVE_FLAG} was given).`);

  process.env.PLANNR_DB = target; // make the approved absolute path authoritative for require('./db')
  return target;
}

module.exports = { guardDbTarget, LIVE_DB_PATH, LIVE_FLAG };
