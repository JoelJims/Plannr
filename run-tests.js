// `npm test` entrypoint: run the node:test suite AND enforce the whole-run safety invariant that the
// live data/plannr.db is never opened — record its mtime before and after and assert it's unchanged.
// (Uses Node's built-in runner; no test framework dependency.)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LIVE = path.join(__dirname, 'data', 'plannr.db');
const stamp = () => (fs.existsSync(LIVE) ? fs.statSync(LIVE).mtimeMs : null);

const before = stamp();
console.log(`[run-tests] data/plannr.db mtime BEFORE: ${before === null ? '(absent)' : new Date(before).toISOString()}`);

const files = fs.readdirSync(path.join(__dirname, 'test'))
  .filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: __dirname });

// Tenancy Phase 3 (Part D) — the cross-tenant ISOLATION HARNESS is now a permanent part of `npm test`.
// It was excluded while red (it MEASURED the leak); green (0 leaks) makes it a permanent regression net:
// any future unfiltered query re-opens a leak and fails the whole suite. Its own isolated temp DB.
console.log('\n[run-tests] running the cross-tenant isolation harness (must reach 0 leaks)…');
const iso = spawnSync(process.execPath, [path.join('test-isolation', 'run.js')], { stdio: 'inherit', cwd: __dirname });

const after = stamp();
console.log(`[run-tests] data/plannr.db mtime AFTER:  ${after === null ? '(absent)' : new Date(after).toISOString()}`);

if (before !== after) {
  console.error('[run-tests] ✖ FAIL: data/plannr.db was modified during the run — the suite must NEVER open the live database.');
  process.exit(1);
}
console.log('[run-tests] ✓ data/plannr.db mtime unchanged — the live database was never opened.');
if (iso.status !== 0) {
  console.error('[run-tests] ✖ FAIL: the isolation harness reported cross-tenant leaks (exit ' + iso.status + '). A tenant filter regressed.');
  process.exit(1);
}
console.log('[run-tests] ✓ isolation harness: 0 cross-tenant leaks.');
process.exit(r.status == null ? 1 : r.status);
