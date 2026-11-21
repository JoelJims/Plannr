// Review finding Q1 (R1): a database first made by the two oldest schemas (v1, commits 7cfcf89 and
// 2ebaf69) still has the old login's `sessions` table after its upgrade (nothing drops it; its rows
// are dead since login was removed). It has a foreign key into `users`, so the start-up check that
// every table pointing into an import-owned table is itself import-owned refused it, and the app
// could not start: on the dev server, and on the phone after restoring an encrypted backup from such
// a database. `sessions` is now import-owned (a JSON import clears it, children-first, before
// `users`). This starts the real server.js on each fixture that has the table and checks it starts,
// keeps every entry, and that a JSON import onto it clears the dead sessions.
// The dev server only (no test/helpers.js): the phone runs the same start job
// (core/routes/backup.js) and the same backup-format.js.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-legacy-sessions-'));
after(() => { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const FIXTURES = [
  ['schema-history', '01-7cfcf89.sql'],
  ['schema-history', '02-2ebaf69.sql'],
  ['legacy-shapes', 'L1-pre-tenancy.sql'],
];

function waitFor(proc, re, ms = 60000) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}; output so far:\n${out}`)), ms);
    proc.stdout.on('data', (d) => { out += d; if (re.test(out)) { clearTimeout(timer); resolve(out); } });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early (${code}):\n${out}`)); });
  });
}
async function stop(proc) {
  proc.removeAllListeners('exit');
  const exited = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
  proc.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}
function count(file, sql) {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return d.prepare(sql).get().n; } finally { d.close(); }
}

for (const [folder, name] of FIXTURES) {
  test(`server.js starts on a database from ${name} (old login's sessions table kept), and a JSON import clears the dead sessions`, async () => {
    const file = path.join(DIR, `${path.basename(name, '.sql')}-${crypto.randomBytes(3).toString('hex')}.db`);
    const d = new DatabaseSync(file);
    d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', folder, name), 'utf8'));
    const tenant = d.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('settings') WHERE name = 'tenant_id'").get().n > 0;
    // The two one-off clean-ups that need the owner's approval, approved (as the upgrade tests do).
    d.exec(tenant
      ? "INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (1, '_service_price_drop_approved', '1'), (1, '_taxonomy_wipe_approved', '1')"
      : "INSERT OR REPLACE INTO settings (key, value) VALUES ('_service_price_drop_approved', '1'), ('_taxonomy_wipe_approved', '1')");
    const hasSessions = d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get().n === 1;
    const cashIn = d.prepare('SELECT COUNT(*) AS n FROM cash_in').get().n;
    const sessionRows = hasSessions ? d.prepare('SELECT COUNT(*) AS n FROM sessions').get().n : 0;
    d.close();
    assert.ok(hasSessions && sessionRows > 0, `${name} has the old sessions table, with rows (the case under test)`);

    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLANNR_DB: file, PLANNR_TEST: '1', PORT: String(port) },
    });
    try {
      const out = await waitFor(proc, /running at/);
      assert.doesNotMatch(out, /could not start|IMPORT_OWNED_TABLES/);
      const base = `http://127.0.0.1:${port}`;
      const backup = await (await fetch(`${base}/api/backup/export?includeContacts=1`)).json();
      assert.strictEqual(backup.tables.cash_in.length, cashIn, 'every cash-in entry is still there after the upgrade');
      const r = await fetch(`${base}/api/backup/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
      assert.strictEqual(r.status, 200, `the JSON import answers 200: ${await r.text()}`);
    } finally {
      await stop(proc);
    }
    assert.strictEqual(count(file, 'SELECT COUNT(*) AS n FROM sessions'), 0, 'the import cleared the dead sessions rows');
    assert.strictEqual(count(file, 'SELECT COUNT(*) AS n FROM cash_in'), cashIn, 'and kept every entry');
  });
}
