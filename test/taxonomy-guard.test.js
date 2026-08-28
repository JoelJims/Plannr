// The Phase 10a ledger-taxonomy cleanup does `DELETE FROM cash_out` and is MARKER-gated, not
// version-gated — so `user_version` being already current is NO indication that nothing will run.
// Before the guard, installing an update onto any database that predates Phase 10a silently wiped
// the entire Money Debited history. This asserts it now refuses instead, loses nothing, keeps
// refusing until explicitly approved, and leaves the ordinary paths alone. The real init() chain
// binds PLANNR_DB at require time, so the proof runs in a fresh process (_taxonomy-guard-fixture.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('taxonomy cleanup refuses to wipe a non-empty cash_out, and only proceeds when approved (spawned)', () => {
  const env = { ...process.env };
  delete env.PLANNR_ALLOW_TAXONOMY_WIPE; // the fixture drives approval itself
  const r = spawnSync(process.execPath, ['test/_taxonomy-guard-fixture.js'], { cwd: ROOT, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `taxonomy guard fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/, 'fixture proved: refuse + lose nothing + repeat + both approval paths + ordinary paths unaffected');
});
