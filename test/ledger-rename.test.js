// The five contract-/region-specific sub-ledger LABELS removed from ledgers.js are renamed in place
// on an existing database, because the Phase 10b seed only ever runs against an empty ledger_subs.
// Unlike the Phase 10a taxonomy cleanup this destroys nothing — no row is deleted and no CODE
// changes — so it needs no approval hatch; the fixture is what proves that rather than asserts it.
// The real init() chain binds PLANNR_DB at require time, so the proof runs in a fresh process
// (_ledger-rename-fixture.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('generic-name migration renames seeded labels in place, loses no spend, and never stomps an owner edit (spawned)', () => {
  const env = { ...process.env };
  delete env.PLANNR_ALLOW_TAXONOMY_WIPE; // nothing here should need an approval hatch
  const r = spawnSync(process.execPath, ['test/_ledger-rename-fixture.js'], { cwd: ROOT, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `ledger rename fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/, 'fixture proved: fresh seed + rename in place + codes/spend intact + owner edit respected + not repeated');
});
