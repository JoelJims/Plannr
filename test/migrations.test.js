// Phase 2, Step 2 — database versioning. db.js's migration runner is shared by the desktop server and
// the phone app (public/db.js is a copy), so these tests cover both. They use throwaway in-memory
// databases and made-up migrations; the REAL init() chain on an old database (with its safety
// snapshot) is exercised in a fresh process by _versioned-migrate-fixture.js (last test below).
const H = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_VERSION, MIGRATIONS, assertMigrationList, migrationPlan, runMigrations, schemaVersionOf, dbAdapter } = require('../db');

const ROOT = path.join(__dirname, '..');
const BASELINE = 2;

function memDb(version = BASELINE, withTable = true) {
  const d = new DatabaseSync(':memory:');
  if (withTable) d.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO notes (body) VALUES ('keep me')");
  d.exec(`PRAGMA user_version = ${version}`);
  return d;
}
const tables = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

// Steps use the async interface (step 1.4 B4): up(tx) awaits tx.exec / tx.run / tx.get / tx.all.
const addTag = { version: 3, name: 'add notes.tag', up: async (tx) => { await tx.exec("ALTER TABLE notes ADD COLUMN tag TEXT NOT NULL DEFAULT 'none'"); } };
const addLog = { version: 4, name: 'add log table', up: async (tx) => { await tx.exec('CREATE TABLE log (id INTEGER PRIMARY KEY, at TEXT)'); } };

test('the shipped migration list is valid and SCHEMA_VERSION is its last version', () => {
  assert.doesNotThrow(() => assertMigrationList(MIGRATIONS));
  assert.strictEqual(SCHEMA_VERSION, MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : BASELINE);
  assert.strictEqual(schemaVersionOf(H.db), SCHEMA_VERSION, 'the test database was brought up to SCHEMA_VERSION by init()');
});

test('a migration list must count up by one from v3, each step with a name and up()', () => {
  assert.throws(() => assertMigrationList([addLog]), /expected 3/);
  assert.throws(() => assertMigrationList([addTag, { ...addLog, version: 5 }]), /expected 4/);
  assert.throws(() => assertMigrationList([{ version: 3, name: 'no up' }]), /up\(tx\)/);
  assert.doesNotThrow(() => assertMigrationList([addTag, addLog]));
});

test('runMigrations upgrades step by step, stamping user_version after each, and keeps the data', async () => {
  const d = memDb();
  const seen = [];
  const spy = (m) => ({ ...m, up: async (tx) => { seen.push([m.version, (await tx.get('PRAGMA user_version')).user_version]); await m.up(tx); } });
  assert.deepStrictEqual(await runMigrations(dbAdapter(d), [spy(addTag), spy(addLog)]), [3, 4]);
  assert.deepStrictEqual(seen, [[3, 2], [4, 3]], 'each step sees the version the previous step stamped');
  assert.strictEqual(schemaVersionOf(d), 4);
  assert.deepStrictEqual(d.prepare('SELECT id, body, tag FROM notes').all().map((r) => ({ ...r })), [{ id: 1, body: 'keep me', tag: 'none' }]);
  assert.deepStrictEqual(tables(d), ['log', 'notes']);
  assert.deepStrictEqual(await runMigrations(dbAdapter(d), [addTag, addLog]), [], 'a second run applies nothing');
});

test('a database part-way up the chain only gets the steps it is missing', async () => {
  const d = memDb(3);
  d.exec("ALTER TABLE notes ADD COLUMN tag TEXT NOT NULL DEFAULT 'none'"); // v3 already applied
  assert.deepStrictEqual(await runMigrations(dbAdapter(d), [addTag, addLog]), [4]);
  assert.strictEqual(schemaVersionOf(d), 4);
});

test('a failing step rolls back completely (its changes AND its version stamp); earlier steps stay', async () => {
  const d = memDb();
  const broken = { version: 4, name: 'half-done step', up: async (tx) => { await tx.exec('CREATE TABLE half (id INTEGER)'); await tx.run("INSERT INTO notes (body) VALUES ('x')"); throw new Error('boom'); } };
  await assert.rejects(runMigrations(dbAdapter(d), [addTag, broken]), (e) => /schema v4 \(half-done step\) failed and was rolled back/.test(e.message) && /unchanged at v3/.test(e.message) && e.cause.message === 'boom');
  assert.strictEqual(schemaVersionOf(d), 3, 'v3 committed, v4 rolled back');
  assert.deepStrictEqual(tables(d), ['notes'], 'the failed step left no table behind');
  assert.strictEqual(d.prepare('SELECT COUNT(*) n FROM notes').get().n, 1, 'the failed step left no row behind');
  assert.doesNotThrow(() => { d.exec('BEGIN'); d.exec('ROLLBACK'); }, 'no transaction left open');
  // Fixed in a later app version: the next start retries from v3.
  assert.deepStrictEqual(await runMigrations(dbAdapter(d), [addTag, addLog]), [4]);
});

test('migrationPlan says what would run without changing anything', () => {
  const empty = memDb(0, false);
  assert.deepStrictEqual(migrationPlan(empty, [addTag]), {
    from: 0, to: 3, tooNew: false, needsSnapshot: false, // a brand-new install has nothing to protect
    steps: [{ version: 2, name: 'baseline: historic migrations up to schema v2' }, { version: 3, name: 'add notes.tag' }],
  });
  const old = memDb(2);
  const plan = migrationPlan(old, [addTag, addLog]);
  assert.deepStrictEqual([plan.from, plan.to, plan.steps.map((s) => s.version), plan.needsSnapshot, plan.tooNew], [2, 4, [3, 4], true, false]);
  assert.strictEqual(schemaVersionOf(old), 2, 'planning changed nothing');
  const current = migrationPlan(memDb(4), [addTag, addLog]);
  assert.deepStrictEqual([current.steps.length, current.needsSnapshot, current.tooNew], [0, false, false]);
  const newer = migrationPlan(memDb(5), [addTag, addLog]);
  assert.strictEqual(newer.tooNew, true, 'a database from a newer app version is flagged');
});

test('an old database migrates through the REAL init(): data kept, snapshot first, newer DB refused (spawned)', () => {
  const r = spawnSync(process.execPath, ['test/_versioned-migrate-fixture.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `versioned-migrate fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/);
});
