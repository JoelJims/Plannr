// Step 1.4 B17: server.js brings its database up to date with the async init() before it listens.
// test/runtime-mode.test.js starts it on a new database; this file checks the start that must fail:
// a database saved by a newer Plannr stops the start with a clear message, nothing listens, and the
// file is left exactly as it was. The dev server only, so it does not use test/helpers.js (and the
// phone pass does not run it); the phone's start has its own test (test-ui/runtime-mode.js).
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-server-start-'));
after(() => { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('server.js: a database from a newer Plannr stops the start with a clear message; nothing listens, nothing changes', () => {
  const file = path.join(DIR, 'newer.db');
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('k', 'v'); PRAGMA user_version = 999;");
  d.close();
  const before = fs.readFileSync(file);
  const r = spawnSync(process.execPath, ['server.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PLANNR_DB: file, PLANNR_TEST: '1', PORT: '0' },
  });
  assert.strictEqual(r.status, 1, `exit code\nSTDOUT:${r.stdout}\nSTDERR:${r.stderr}`);
  assert.match(r.stderr, /\[startup\] could not start:/);
  assert.match(r.stderr, /saved by a newer version of the app \(schema v999/);
  assert.doesNotMatch(r.stdout, /running at/, 'it never listened');
  assert.ok(fs.readFileSync(file).equals(before), 'the database file is unchanged');
  assert.deepStrictEqual(fs.readdirSync(DIR).sort(), ['newer.db'], 'no snapshot or other file was written beside it');
});
