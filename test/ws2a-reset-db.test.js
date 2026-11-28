// F13 (docs/security-quality-review-2026-11-21.md): reset-db.js empties every table, but the
// settings rows named _migrated_* are not data: they record which one-off clean-ups already ran
// (db.js LEGACY_MARKERS). Deleting them made the next start treat those clean-ups as work again.
// reset-db keeps them; every other row still goes.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

test('F13: reset-db keeps the _migrated_* markers and empties everything else', () => {
  H.seedUser();
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('budget_paise', '12345') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('_migrated_ws2a_check', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('xmigratedx', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const markers = H.db.prepare("SELECT key, value FROM settings WHERE key LIKE '\\_migrated\\_%' ESCAPE '\\' ORDER BY key").all().map((r) => ({ ...r }));
  assert.ok(markers.length >= 1);

  const target = path.join(os.tmpdir(), `plannr-ws2a-reset-${process.pid}.db`);
  fs.copyFileSync(H.TEST_DB, target);
  const r = spawnSync(process.execPath, ['reset-db.js', '--confirm'], { cwd: ROOT, env: Object.assign({}, process.env, { PLANNR_DB: target }), encoding: 'utf8' });
  try {
    assert.strictEqual(r.status, 0, 'reset-db should exit 0\nSTDOUT:' + r.stdout + '\nSTDERR:' + r.stderr);
    const dbT = new DatabaseSync(target);
    const kept = dbT.prepare('SELECT key, value FROM settings ORDER BY key').all().map((x) => ({ ...x }));
    assert.deepStrictEqual(kept, markers, 'only the _migrated_* markers stay, unchanged');
    assert.strictEqual(dbT.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
    dbT.close();
  } finally {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(target + s); } catch { /* ignore */ } }
  }
});
