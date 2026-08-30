// Contract Phase A's A3 step drops contract_services.price_paise, and is MARKER-gated, not
// version-gated — so `user_version` being already current is NO indication that nothing will run.
// Without the guard, installing an update onto any database that predates Phase A would silently
// destroy every price the owner had typed against a service. This asserts it refuses instead, loses
// nothing, keeps refusing until explicitly approved, archives the figures when it does proceed, and
// leaves the ordinary paths alone. The real init() chain binds PLANNR_DB at require time, so the
// proof runs in a fresh process (_service-price-guard-fixture.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

test('the service-price drop refuses against stored prices, and only proceeds when approved (spawned)', () => {
  const env = { ...process.env };
  delete env.PLANNR_ALLOW_SERVICE_PRICE_DROP; // the fixture drives approval itself
  const r = spawnSync(process.execPath, ['test/_service-price-guard-fixture.js'], { cwd: ROOT, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `service-price guard fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/, 'fixture proved: refuse + lose nothing + repeat + both approval paths + archive + ordinary paths unaffected');
});
