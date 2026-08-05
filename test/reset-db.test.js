// reset-db.js — spawned as a real subprocess (it opens its own DB connection + calls process.exit).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

test('wipes a fully-seeded DB: every table -> 0, ids restart at 1, foreign_key_check clean', () => {
  // Seed across every table, then checkpoint + copy the file to a dedicated reset target.
  const u = H.seedUser();
  const c = H.seedContract();
  H.seedPayment({ contractId: c });
  H.seedCashOut({ byUserId: u.id });
  H.seedCashIn({ byUserId: u.id });
  H.db.prepare('INSERT INTO loans (amount_paise, bank_name, tenant_id) VALUES (?, ?, (SELECT MIN(id) FROM users))').run(500000, 'Bank');
  H.seedSession(u.id);
  H.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES ((SELECT MIN(id) FROM users), 'budget_paise', '12345') ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value").run();
  H.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const target = path.join(os.tmpdir(), `plannr-reset-${process.pid}.db`);
  fs.copyFileSync(H.TEST_DB, target);

  const r = spawnSync(process.execPath, ['reset-db.js', '--confirm'], { cwd: ROOT, env: Object.assign({}, process.env, { PLANNR_DB: target }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'reset-db should exit 0\nSTDOUT:' + r.stdout + '\nSTDERR:' + r.stderr);

  const dbT = new DatabaseSync(target);
  const tables = dbT.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  assert.ok(tables.length >= 5, 'schema intact (tables still present)');
  for (const t of tables) assert.strictEqual(dbT.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} must be empty`);
  dbT.exec("INSERT INTO users (username, display_name, password_hash) VALUES ('x','x','x')");
  assert.strictEqual(dbT.prepare('SELECT id FROM users').get().id, 1, 'AUTOINCREMENT ids restart at 1');
  assert.strictEqual(dbT.prepare('PRAGMA foreign_key_check').all().length, 0, 'foreign_key_check clean');
  dbT.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(target + s); } catch { /* ignore */ } }
});

test('REFUSES when PLANNR_DB is unset (the live-DB guard from the prerequisites phase)', () => {
  const env = Object.assign({}, process.env); delete env.PLANNR_DB; // unset -> resolves to live -> must refuse
  const r = spawnSync(process.execPath, ['reset-db.js', '--confirm'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'must refuse with a non-zero exit');
  assert.match((r.stderr || '') + (r.stdout || ''), /REFUSING|LIVE database/i, 'must print the live-DB refusal');
});
