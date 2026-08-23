// A genuinely pre-tenancy database (no tenant_id anywhere) must boot through the full migration
// chain — add tenant_id, then Step 2a collapses it back off — and, critically, a SECOND boot (a
// real restart against the same file) must be a complete no-op. The real init() migration chain
// binds PLANNR_DB at require time, so the proof runs in a fresh process (see
// _tenancy-migrate-fixture.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('a pre-tenancy database boots through the full collapse and a second boot is a no-op (spawned)', () => {
  const r = spawnSync(process.execPath, ['test/_tenancy-migrate-fixture.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `tenancy-migrate fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/, 'fixture proved the collapse completes and a second boot changes nothing');
});
