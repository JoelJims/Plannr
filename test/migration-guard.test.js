// Phase 11B — the cash_out phase_custom_name rebuild guard must be UNAMBIGUOUS: a re-added column on
// an already-migrated DB must never re-trigger the destructive rebuild (the Phase-5B landmine class),
// while a genuine pre-marker DB must still rebuild losslessly. The real init() migration chain binds
// PLANNR_DB at require time, so the proof runs in a fresh process (see _migration-guard-fixture.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('cash_out rebuild guard is version-gated: re-add is defused; pre-marker DB still rebuilds losslessly (spawned)', () => {
  const r = spawnSync(process.execPath, ['test/_migration-guard-fixture.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `guard fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/, 'fixture proved defuse (marked DB) + still-fires (pre-marker DB) with no data loss');
});
