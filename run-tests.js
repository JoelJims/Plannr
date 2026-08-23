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

const after = stamp();
console.log(`[run-tests] data/plannr.db mtime AFTER:  ${after === null ? '(absent)' : new Date(after).toISOString()}`);

if (before !== after) {
  console.error('[run-tests] ✖ FAIL: data/plannr.db was modified during the run — the suite must NEVER open the live database.');
  process.exit(1);
}
console.log('[run-tests] ✓ data/plannr.db mtime unchanged — the live database was never opened.');
process.exit(r.status == null ? 1 : r.status);
