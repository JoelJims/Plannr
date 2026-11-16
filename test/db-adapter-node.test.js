// Step 1.4 B1: the node-sqlite adapter (db-adapter-node.js) against the adapter contract suite
// (test/adapter-contract.mjs), plus what only a file on disk has: no temporary files left behind,
// a crash-safe replace, and the real size on disk.
//
// Every database here is a new file in a fresh temp folder. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const LIVE_DB = path.resolve(ROOT, 'data', 'plannr.db').toLowerCase();
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-adapter-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// What the contract cases get from the shared core (see test/adapter-contract.mjs).
const coreEnv = async () => ({ createRequestQueue: (await load('core/request-queue.js')).createRequestQueue });

let n = 0;
async function withAdapter(fn, { file = true } = {}) {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const p = file ? path.join(DIR, `contract-${++n}.db`) : ':memory:';
  assert.notStrictEqual(path.resolve(p).toLowerCase(), LIVE_DB);
  const db = openNodeSqliteAdapter(p);
  try { return await fn(db, p); } finally { try { await db.close(); } catch { /* a case may close it */ } }
}

// ---- The contract suite: on a file, and (where it needs no file) in memory ------------------------

test('the contract suite has cases', async () => {
  const { CONTRACT_CASES } = await load('test/adapter-contract.mjs');
  assert.ok(CONTRACT_CASES.length >= 10);
});

const NAMES = [
  'get, all and run: rows, no row, row ids and change counts',
  'ON CONFLICT ... DO UPDATE keeps one row and updates it',
  'params must be an array of positional values',
  'foreign keys are enforced',
  'transaction commits and returns what fn returns',
  'transaction rolls back everything when a statement fails, and the adapter still works',
  'transaction rolls back when fn throws something that is not SQL',
  'a nested transaction is refused, and the outer one rolls back',
  'one migration step: the table and user_version change together, or not at all',
  'exportBytes gives a SQLite file with the data; replaceWith brings that data back',
  'replaceWith refuses bytes that are not a SQLite database and changes nothing',
  'exportBytes, replaceWith and close are refused inside a transaction',
  'info names the engine and gives a size',
  'two writes at once through the request queue, one failing: only the failed one is undone',
];

test('this file runs every contract case', async () => {
  const { CONTRACT_CASES } = await load('test/adapter-contract.mjs');
  assert.deepStrictEqual(CONTRACT_CASES.map((c) => c.name), NAMES);
});

for (const name of NAMES) {
  test(`contract (node-sqlite, file): ${name}`, async () => {
    const { CONTRACT_CASES } = await load('test/adapter-contract.mjs');
    const env = await coreEnv();
    await withAdapter((db) => CONTRACT_CASES.find((c) => c.name === name).run(db, env));
  });
}
for (const name of NAMES) {
  test(`contract (node-sqlite, :memory:): ${name}`, async (t) => {
    const { CONTRACT_CASES } = await load('test/adapter-contract.mjs');
    const c = CONTRACT_CASES.find((x) => x.name === name);
    if (c.needsFile) return t.skip('replaces the database, which needs a file');
    const env = await coreEnv();
    await withAdapter((db) => c.run(db, env), { file: false });
  });
}

// ---- What only the file adapter has ----------------------------------------------------------------

test('the adapter passes checkAdapter, keeps the transition methods, and names its engine', async () => {
  const { checkAdapter, ADAPTER_METHODS, TRANSITION_SYNC_METHODS } = await load('core/db-adapter.js');
  await withAdapter(async (db) => {
    assert.strictEqual(checkAdapter(db), db);
    assert.strictEqual(db.engine, 'node-sqlite');
    for (const m of [...ADAPTER_METHODS, ...TRANSITION_SYNC_METHODS]) assert.strictEqual(typeof db[m], 'function', m);
    db.execSync('CREATE TABLE t (x)');
    db.prepare('INSERT INTO t VALUES (?)').run(7);
    assert.deepStrictEqual({ ...(await db.get('SELECT x FROM t')) }, { x: 7 }, 'sync and async calls see the same database');
  });
  assert.throws(() => checkAdapter({ engine: 'x', get() {} }), /missing: all, run, exec, transaction, exportBytes, replaceWith, info, close/);
});

test('exportBytes leaves no temporary file behind', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`plannr-export-${process.pid}-`));
  await withAdapter(async (db) => {
    await db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    await db.exportBytes();
    await db.exportBytes();
  });
  const afterFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`plannr-export-${process.pid}-`));
  assert.deepStrictEqual(afterFiles, before);
});

test('replaceWith leaves only the database file: no incoming copy, no journal', async () => {
  await withAdapter(async (db, p) => {
    await db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    const bytes = await db.exportBytes();
    await db.exec('INSERT INTO t VALUES (2)');
    await db.replaceWith(bytes);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p))), [path.basename(p)]);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS c FROM t')).c, 1);
    assert.deepStrictEqual({ ...(await db.get('PRAGMA journal_mode')) }, { journal_mode: 'delete' });
  });
});

test('replaceWith refuses while a -wal file sits beside the database, and keeps the old data open', async () => {
  await withAdapter(async (db, p) => {
    await db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    const bytes = await db.exportBytes();
    await db.exec('INSERT INTO t VALUES (2)');
    fs.writeFileSync(p + '-wal', ''); // an empty stand-in; SQLite ignores it in DELETE mode
    try {
      await assert.rejects(db.replaceWith(bytes), /-wal is still beside the database; it was not replaced/);
    } finally {
      fs.unlinkSync(p + '-wal');
    }
    assert.strictEqual((await db.get('SELECT COUNT(*) AS c FROM t')).c, 2, 'the old database, reopened');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p) + '.incoming-')), []);
  });
});

test('a database replaced by one adapter is what the next open sees (it is on disk)', async () => {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const p = path.join(DIR, 'reopen.db');
  const a = openNodeSqliteAdapter(p);
  await a.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
  const bytes = await a.exportBytes();
  await a.exec('INSERT INTO t VALUES (2), (3)');
  await a.replaceWith(bytes);
  await a.close();
  const b = openNodeSqliteAdapter(p);
  try { assert.strictEqual((await b.get('SELECT COUNT(*) AS c FROM t')).c, 1); } finally { await b.close(); }
});

test('info gives the size on disk; :memory: and read-only adapters cannot be replaced', async () => {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  await withAdapter(async (db, p) => {
    await db.exec('CREATE TABLE t (x TEXT); INSERT INTO t VALUES (zeroblob(20000))');
    const i = await db.info();
    assert.deepStrictEqual(i, { engine: 'node-sqlite', path: path.resolve(p), sizeBytes: fs.statSync(p).size });
  });
  await withAdapter(async (db) => {
    const bytes = await db.exportBytes();
    await assert.rejects(db.replaceWith(bytes), /needs a database file, not :memory:/);
  }, { file: false });
  const p = path.join(DIR, 'ro.db');
  const w = openNodeSqliteAdapter(p); await w.exec('CREATE TABLE t (x)'); const bytes = await w.exportBytes(); await w.close();
  const ro = openNodeSqliteAdapter(p, { readOnly: true });
  try { await assert.rejects(ro.replaceWith(bytes), /opened read-only/); } finally { await ro.close(); }
});

test('after close, every call says the database is closed', async () => {
  await withAdapter(async (db) => {
    await db.close();
    await assert.rejects(db.get('SELECT 1'), /the database is closed/);
    assert.throws(() => db.prepare('SELECT 1'), /the database is closed/);
  });
});
