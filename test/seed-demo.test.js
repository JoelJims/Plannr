// seed-demo.js (npm run seed:demo) as a real subprocess on a new, isolated database. Step 1.4 B17: it
// brings the database up to date with the async init() before it wipes and seeds, so a file that does
// not exist yet gets the full schema first. A small seed (PLANNR_SEED_ROWS) keeps it quick; the
// deterministic generator makes the counts exact.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-seed-demo-'));
after(() => { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('seed-demo on a new database: the schema is made first, then the demo data is seeded', () => {
  const file = path.join(DIR, 'demo.db');
  const r = spawnSync(process.execPath, ['seed-demo.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PLANNR_DB: file, PLANNR_SEED_ROWS: '60' },
  });
  assert.strictEqual(r.status, 0, `STDOUT:${r.stdout}\nSTDERR:${r.stderr}`);
  const d = new DatabaseSync(file, { readOnly: true });
  const n = (t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  try {
    assert.strictEqual(n('cash_out'), 60, 'the requested number of outflow rows');
    assert.ok(n('contract') >= 1 && n('cash_in') >= 1 && n('loans') === 2, 'a contract, inflows and two loans');
    assert.ok(n('ledger_mains') > 10, 'the ledger list was there to seed against');
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'demo'").get().n, 1);
    assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, require('../db').SCHEMA_VERSION);
    assert.strictEqual(d.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    d.close();
  }
});
