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
const { SCHEMA_VERSION, MIGRATIONS, assertMigrationList, migrationPlan, planMigrations, runMigrations, schemaVersionOf, dbAdapter } = require('../db');
const fs = require('node:fs');

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

// Step 1.4 B9: the plan is made of database calls like legacyInit(); planMigrations() awaits them
// through the async interface (init(), the phone's start), migrationPlan() makes them at once.
function plannrLike(version, markers) {
  const d = memDb(version);
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  for (const k of markers) d.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(k);
  return d;
}
const ALL_MARKERS = ['_migrated_service_price_removed_v1', '_migrated_ledger_taxonomy_v1', '_migrated_generic_ledger_names_v1'];
// Only the async methods, each answering a tick later: a synchronous call path has nothing to call.
function asyncOnly(d, calls) {
  const a = dbAdapter(d);
  const later = (v) => new Promise((r) => setImmediate(() => r(v)));
  return {
    get: async (sql, p) => { calls.push(sql); return later(await a.get(sql, p)); },
    all: async (sql, p) => { calls.push(sql); return later(await a.all(sql, p)); },
    run: async (sql, p) => { calls.push(sql); return later(await a.run(sql, p)); },
    exec: async (sql) => { calls.push(sql); return later(await a.exec(sql)); },
  };
}

test("planMigrations gives migrationPlan's answer through the async interface alone, for every kind of database", async () => {
  const cases = {
    'brand new': () => memDb(0, false),
    'v2, no settings table': () => memDb(2),
    'v2, every one-off marker': () => plannrLike(2, ALL_MARKERS),
    'v2, the taxonomy marker missing': () => plannrLike(2, ALL_MARKERS.filter((k) => k !== '_migrated_ledger_taxonomy_v1')),
    'v2, every marker missing': () => plannrLike(2, []),
    'v1': () => plannrLike(1, ALL_MARKERS),
    'v4 (current)': () => memDb(4),
    'v5 (newer)': () => memDb(5),
  };
  for (const [name, make] of Object.entries(cases)) {
    for (const list of [[], [addTag, addLog]]) {
      const calls = [];
      const want = migrationPlan(make(), list);
      assert.deepStrictEqual(await planMigrations(asyncOnly(make(), calls), list), want, `${name}, ${list.length} steps`);
      assert.ok(calls.length >= 2 && calls[0] === 'PRAGMA user_version', `${name}: planned through the async interface (${calls.length} calls)`);
    }
  }
  const missing = await planMigrations(asyncOnly(plannrLike(2, ALL_MARKERS.slice(1)), []), []);
  assert.deepStrictEqual(missing.steps.map((st) => st.name), ['baseline: one-off clean-ups this database has not had yet']);
  assert.strictEqual(missing.needsSnapshot, true, 'a v2 database that still needs a one-off clean-up gets a snapshot first');
});

test("init() and the phone's start plan through planMigrations (the async interface)", () => {
  const src = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const init = src.slice(src.indexOf('export async function init('), src.indexOf('export function initSync('));
  assert.match(init, /await planMigrations\(/, 'init() awaits the plan');
  assert.doesNotMatch(init, /migrationPlan\(/, 'init() does not plan at once');
  const boot = fs.readFileSync(path.join(ROOT, 'public', 'local-bootstrap.js'), 'utf8');
  assert.match(boot, /await planMigrations\(\)/, 'the phone awaits the plan');
  assert.doesNotMatch(boot, /migrationPlan\(/, 'the phone does not plan at once');
});

test('an old database migrates through the REAL init(): data kept, snapshot first, newer DB refused (spawned)', () => {
  const r = spawnSync(process.execPath, ['test/_versioned-migrate-fixture.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `versioned-migrate fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/);
});
