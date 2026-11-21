// Incident 2 (step 1.4): no test may open the live data/plannr.db. db.js refuses to open it under
// Node's test runner (NODE_TEST_CONTEXT); outside it (the desktop server, the scripts) nothing changes.
// run-tests.js's mtime check could not see an open that wrote nothing.
//
// Every case runs on a COPY of db.js (and the two files it imports) in a temp folder, so the "live"
// database here is <temp>/data/plannr.db. If the guard were broken, the child would open that copy's
// file, never the real one.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-live-db-guard-'));
after(() => { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

for (const f of ['db.js', 'ledgers.js', path.join('core', 'db-adapter.js')]) {
  fs.mkdirSync(path.dirname(path.join(DIR, f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(DIR, f));
}
fs.writeFileSync(path.join(DIR, 'opens.test.js'), "require('node:test').test('loads db.js', () => { require('./db.js'); });\n");
const LIVE = path.join(DIR, 'data', 'plannr.db');

// The environment of a child: this one's, without PLANNR_DB or NODE_TEST_CONTEXT, plus `extra`.
function envWith(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['PLANNR_DB', 'NODE_TEST_CONTEXT']) if (!(k in extra)) delete env[k];
  return env;
}
const underTestRunner = (extra = {}) => spawnSync(process.execPath, ['--test', 'opens.test.js'], { cwd: DIR, encoding: 'utf8', env: envWith(extra), timeout: 60000 });

test('under the test runner, db.js refuses the live database when PLANNR_DB is not set', () => {
  const r = underTestRunner();
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout + r.stderr, /a test was about to open the live database \(data\/plannr\.db\)/);
  assert.ok(!fs.existsSync(LIVE), 'the live file was not opened (opening would have created it)');
});

test('…and when PLANNR_DB names the live file itself (any case, either slash)', () => {
  for (const p of [LIVE, LIVE.toUpperCase(), LIVE.split(path.sep).join('/')]) {
    const r = underTestRunner({ PLANNR_DB: p });
    assert.notStrictEqual(r.status, 0, p);
    assert.match(r.stdout + r.stderr, /a test was about to open the live database/, p);
  }
  assert.ok(!fs.existsSync(LIVE));
});

test('a test with a file of its own opens it as before', () => {
  const own = path.join(DIR, 'own.db');
  const r = underTestRunner({ PLANNR_DB: own });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(own));
  assert.ok(!fs.existsSync(LIVE));
});

test('outside the test runner (the desktop server, the scripts) the live database opens as before', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./db.js')"], { cwd: DIR, encoding: 'utf8', env: envWith({}), timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(LIVE), 'opened (and so created) in the temp copy');
});

// Review R2/S10: a PLANNR_DB that is set but empty (or only spaces) is refused, inside and outside the
// test runner, before anything is opened. On its own copy of db.js, so a broken check could only ever
// open that copy's data/plannr.db.
test('a PLANNR_DB that is set but empty is refused and nothing is opened (outside and inside the test runner)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-blank-db-env-'));
  try {
    for (const f of ['db.js', 'ledgers.js', path.join('core', 'db-adapter.js')]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, 'opens.test.js'), "require('node:test').test('loads db.js', () => { require('./db.js'); });\n");
    const live = path.join(dir, 'data', 'plannr.db');
    for (const value of ['', '   ']) {
      const plain = spawnSync(process.execPath, ['-e', "require('./db.js')"], { cwd: dir, encoding: 'utf8', env: envWith({ PLANNR_DB: value }), timeout: 60000 });
      assert.notStrictEqual(plain.status, 0, `outside the test runner, PLANNR_DB=${JSON.stringify(value)} must not start`);
      assert.match(plain.stderr, /PLANNR_DB is set but empty/);
      const runner = spawnSync(process.execPath, ['--test', 'opens.test.js'], { cwd: dir, encoding: 'utf8', env: envWith({ PLANNR_DB: value }), timeout: 60000 });
      assert.notStrictEqual(runner.status, 0, `under the test runner, PLANNR_DB=${JSON.stringify(value)} must not start`);
      assert.ok(!fs.existsSync(live), `nothing opened (and so created) data/plannr.db for PLANNR_DB=${JSON.stringify(value)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
