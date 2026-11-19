// Step 1.4 C3: the capacitor-sqlite adapter (public/db-adapter-capacitor.js) in Node, over a stand-in
// for the phone's two plugins (test/_fake-capacitor-sqlite.js) that behaves as the C1 spike measured
// the real ones. The same contract suite runs on the emulator against the real plugins (C3's
// emulator script); this file also checks the work-arounds one by one, and splitStatements() and
// returnsRows() in core/db-adapter.js.
//
// Every database here is a new file in a fresh temp folder. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { makeFakePlugins } = require('./_fake-capacitor-sqlite.js');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-capacitor-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

let n = 0;
const newPhone = (opts) => makeFakePlugins(fs.mkdtempSync(path.join(DIR, `phone-${++n}-`)), opts);
async function withAdapter(fn, phone = newPhone()) {
  const { openCapacitorAdapter } = await load('public/db-adapter-capacitor.js');
  const db = await openCapacitorAdapter(phone);
  try { return await fn(db, phone); } finally { try { await db.close(); } catch { /* a case may close it */ } }
}
const coreEnv = async () => ({ createRequestQueue: (await load('core/request-queue.js')).createRequestQueue });

// ---- The contract suite --------------------------------------------------------------------------------

test('every contract case passes on the capacitor-sqlite adapter (stand-in plugins)', async () => {
  const { CONTRACT_CASES } = await load('test/adapter-contract.mjs');
  const env = await coreEnv();
  assert.ok(CONTRACT_CASES.length >= 14);
  for (const c of CONTRACT_CASES) {
    const phone = newPhone();
    await withAdapter((db) => c.run(db, env), phone).catch((e) => { e.message = `${c.name}: ${e.message}`; throw e; });
    assert.ok(!phone.sqlite.calls.some(([m]) => m === 'execute' || m === 'executeSet'), `${c.name}: never execute()/executeSet()`);
    assert.ok(phone.sqlite.calls.filter(([m]) => m === 'run').every(([, , tx]) => tx === false), `${c.name}: transaction: false on every run()`);
  }
});

test('the adapter is a capacitor-sqlite adapter on databases/plannrSQLite.db, with journal_mode DELETE and foreign keys on', async () => {
  await withAdapter(async (db, phone) => {
    assert.strictEqual(db.engine, 'capacitor-sqlite');
    assert.deepStrictEqual(await db.get('PRAGMA journal_mode'), { journal_mode: 'delete' });
    assert.deepStrictEqual(await db.get('PRAGMA foreign_keys'), { foreign_keys: 1 });
    const i = await db.info();
    assert.strictEqual(path.resolve(i.path), path.resolve(phone.fileOf('plannr')));
    assert.ok(Number.isFinite(i.freeBytes) && i.freeBytes > 0, 'free space');
    for (const m of ['prepare', 'execSync']) assert.strictEqual(db[m], undefined, `no ${m}()`);
  });
});

// ---- The plugin's quirks (C1), one by one --------------------------------------------------------------

test('a DELETE that cascades reports 1 change, as node:sqlite does (the plugin says 4)', async () => {
  await withAdapter(async (db, phone) => {
    await db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY);
      CREATE TABLE k (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ON DELETE CASCADE);`);
    await db.run('INSERT INTO p (id) VALUES (1)');
    for (let i = 0; i < 3; i++) await db.run('INSERT INTO k (p) VALUES (1)');
    const r = await db.run('DELETE FROM p WHERE id = ?', [1]);
    assert.deepStrictEqual(r.changes, 1);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS c FROM k')).c, 0);
    assert.ok(phone.sqlite.calls.some(([m, s]) => m === 'query' && /SELECT changes\(\)/.test(s)), 'asked SQLite for the real count');
    const u = await db.run('UPDATE k SET p = p WHERE 0');
    assert.strictEqual(u.changes, 0);
  });
});

test('an exec() script with ";" and "--" inside literals, comments and a trigger runs statement by statement, unchanged', async () => {
  await withAdapter(async (db, phone) => {
    await db.exec(`
      -- a comment; with a semicolon
      CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT NOT NULL DEFAULT 'a -- b; c', "odd;name" TEXT);
      /* block; comment */
      INSERT INTO t (note) VALUES ('the end; really');
      CREATE TABLE log (msg TEXT);
      CREATE TRIGGER t_log AFTER INSERT ON t BEGIN
        INSERT INTO log (msg) VALUES (CASE WHEN NEW.note = 'x' THEN 'x; one' ELSE 'other' END);
        INSERT INTO log (msg) VALUES ('second;');
      END;
      PRAGMA user_version = 5
    `);
    await db.run("INSERT INTO t (note) VALUES ('x')");
    assert.deepStrictEqual(await db.all('SELECT note FROM t ORDER BY id'), [{ note: 'the end; really' }, { note: 'x' }]);
    // the trigger was made after the first INSERT, so only the second one fired it
    assert.deepStrictEqual(await db.all('SELECT msg FROM log ORDER BY rowid'), [{ msg: 'x; one' }, { msg: 'second;' }]);
    assert.match((await db.get("SELECT sql FROM sqlite_master WHERE name = 't'")).sql, /DEFAULT 'a -- b; c'/);
    assert.deepStrictEqual(await db.get('PRAGMA user_version'), { user_version: 5 });
    assert.ok(!phone.sqlite.calls.some(([m]) => m === 'execute'));
  });
});

test('a statement that answers with a row goes through query(), the rest through run()', async () => {
  await withAdapter(async (db, phone) => {
    phone.sqlite.calls.length = 0;
    await db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA user_version = 3; SELECT 1');
    const sent = phone.sqlite.calls.filter(([m]) => m === 'run' || m === 'query').map(([m, s]) => `${m} ${s}`);
    assert.deepStrictEqual(sent, ['query PRAGMA journal_mode = DELETE', 'run PRAGMA foreign_keys = ON', 'run PRAGMA user_version = 3', 'query SELECT 1']);
  });
});

test('values the plugin cannot carry are refused with a clear message, before anything is sent', async () => {
  await withAdapter(async (db) => {
    await db.exec('CREATE TABLE v (x)');
    for (const [bad, what] of [[undefined, 'undefined'], [new Uint8Array([1]), 'binary data'], [10n, 'bigint'], [true, 'boolean'], [NaN, 'number'], [{}, 'object']]) {
      await assert.rejects(db.run('INSERT INTO v (x) VALUES (?)', [bad]), new RegExp(`parameter 1 is ${what}; only null, numbers and strings`));
    }
    assert.strictEqual((await db.get('SELECT COUNT(*) AS c FROM v')).c, 0);
    await db.run('INSERT INTO v (x) VALUES (?), (?), (?), (?)', [null, -5, 2.5, '₹ 1,00,000 ✓']);
    assert.deepStrictEqual((await db.all('SELECT x, typeof(x) AS t FROM v ORDER BY rowid')).map((r) => r.t), ['null', 'integer', 'real', 'text']);
  });
});

test("SQLite's errors keep their message and carry SQLite's code as errcode", async () => {
  await withAdapter(async (db) => {
    await db.exec('CREATE TABLE u (k TEXT UNIQUE)');
    await db.run("INSERT INTO u VALUES ('a')");
    const e = await assert.rejects(db.run("INSERT INTO u VALUES ('a')"), /UNIQUE constraint failed: u\.k/);
    void e;
    try { await db.run("INSERT INTO u VALUES ('a')"); } catch (err) { assert.strictEqual(err.errcode, 2067); }
  });
});

test('a page reload: the next page closes the connection the last one left, and its open transaction is rolled back', async () => {
  const phone = newPhone();
  const { openCapacitorAdapter } = await load('public/db-adapter-capacitor.js');
  const first = await openCapacitorAdapter(phone);
  await first.exec('CREATE TABLE t (x)');
  await first.run('INSERT INTO t VALUES (1)');
  // The page goes away in the middle of a transaction: BEGIN and one INSERT reached the plugin.
  let release;
  const stuck = first.transaction(async (tx) => { await tx.run('INSERT INTO t VALUES (2)'); await new Promise((r) => { release = r; }); });
  await new Promise((r) => setTimeout(r, 10));
  // A new page: no "Connection plannr already exists", and no "database is locked" (on Android the
  // old connection's BEGIN is EXCLUSIVE and closing it does not end it; the emulator showed this).
  const second = await openCapacitorAdapter(phone);
  assert.deepStrictEqual(phone.leaked, [], 'the old connection was rolled back before it was closed, so it holds no lock');
  assert.deepStrictEqual(await second.all('SELECT x FROM t'), [{ x: 1 }], 'the half-done transaction is gone');
  await second.transaction(async (tx) => { await tx.run('INSERT INTO t VALUES (3)'); });
  assert.deepStrictEqual(await second.all('SELECT x FROM t ORDER BY x'), [{ x: 1 }, { x: 3 }]);
  release();
  await assert.rejects(stuck); // the old page's adapter finds its connection gone
  await second.close();
});

// ---- exportBytes / replaceWith / info on files -----------------------------------------------------

test('exportBytes leaves nothing in the cache folder; replaceWith leaves no candidate file', async () => {
  await withAdapter(async (db, phone) => {
    await db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    const bytes = await db.exportBytes();
    assert.deepStrictEqual(fs.readdirSync(phone.cacheDir), [], 'the VACUUM INTO file is gone');
    await db.replaceWith(bytes);
    assert.deepStrictEqual(fs.readdirSync(phone.databasesDir).sort(), ['plannrSQLite.db']);
    await assert.rejects(db.replaceWith(bytes.slice(0, 600)), /integrity|malformed|not a database|disk image/i);
    assert.deepStrictEqual(fs.readdirSync(phone.databasesDir).sort(), ['plannrSQLite.db'], 'the refused candidate is removed');
    assert.deepStrictEqual(await db.all('SELECT x FROM t'), [{ x: 1 }]);
  });
});

test('replaceWith takes a WAL-stamped image and keeps the database in rollback (DELETE) mode', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const src = path.join(DIR, `wal-${++n}.db`);
  const w = new DatabaseSync(src);
  w.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES ('wal');");
  w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  w.close();
  const bytes = new Uint8Array(fs.readFileSync(src));
  assert.strictEqual(bytes[18], 2, 'the image is stamped WAL');
  await withAdapter(async (db, phone) => {
    await db.replaceWith(bytes);
    assert.deepStrictEqual(await db.all('SELECT x FROM t'), [{ x: 'wal' }]);
    assert.deepStrictEqual(await db.get('PRAGMA journal_mode'), { journal_mode: 'delete' });
    assert.ok(!fs.existsSync(phone.fileOf('plannr') + '-wal'));
  });
});

test('replaceWith refuses an image that opens but fails integrity_check, and changes nothing', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const src = path.join(DIR, `damaged-${++n}.db`);
  const w = new DatabaseSync(src);
  w.exec("CREATE TABLE t (a TEXT); CREATE INDEX i ON t(a); INSERT INTO t VALUES ('KEY-0001'), ('KEY-0002'), ('KEY-0003')");
  const root = w.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'i'").get().rootpage;
  const pageSize = w.prepare('PRAGMA page_size').get().page_size;
  w.close();
  // One key changed in the index only: the file opens and reads, but the index no longer matches.
  const bytes = fs.readFileSync(src);
  const page = bytes.subarray((root - 1) * pageSize, root * pageSize);
  page.write('KEY-9992', page.indexOf('KEY-0002'));
  await withAdapter(async (db, phone) => {
    await db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('mine')");
    await assert.rejects(db.replaceWith(new Uint8Array(bytes)), /failed its integrity check \(row 2 missing from index i/);
    assert.deepStrictEqual(fs.readdirSync(phone.databasesDir).sort(), ['plannrSQLite.db'], 'the refused candidate is removed');
    assert.deepStrictEqual(await db.all('SELECT a FROM t'), [{ a: 'mine' }]);
  });
});

test('replaceWith refuses to swap while the database still has a journal, and changes nothing', async () => {
  await withAdapter(async (db, phone) => {
    await db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    const bytes = await db.exportBytes();
    await db.run('INSERT INTO t VALUES (2)');
    const realRename = phone.storage.rename;
    phone.storage.rename = async (a) => { throw new Error('rename must not be reached: ' + JSON.stringify(a)); };
    const realSizes = phone.storage.sizes;
    phone.storage.sizes = async (a) => { const r = await realSizes(a); for (const p of a.paths) if (p.endsWith('plannrSQLite.db-journal')) r[p] = 0; return r; };
    await assert.rejects(db.replaceWith(bytes), /still has a journal after closing; nothing was replaced/);
    phone.storage.rename = realRename; phone.storage.sizes = realSizes;
    assert.deepStrictEqual(await db.all('SELECT x FROM t ORDER BY x'), [{ x: 1 }, { x: 2 }]);
    await db.run('INSERT INTO t VALUES (3)'); // reopened and writable
  });
});

test('info gives the size on disk of the file (and its journal) and the free space', async () => {
  await withAdapter(async (db, phone) => {
    await db.exec('CREATE TABLE t (x)');
    for (let i = 0; i < 50; i++) await db.run('INSERT INTO t VALUES (?)', ['x'.repeat(200)]);
    const i = await db.info();
    assert.strictEqual(i.sizeBytes, fs.statSync(phone.fileOf('plannr')).size);
    assert.strictEqual(i.freeBytes, 8e9);
  }, newPhone());
});

// ---- splitStatements and returnsRows (core/db-adapter.js) --------------------------------------------

test('splitStatements splits on ";" only outside literals, names, comments and trigger bodies', async () => {
  const { splitStatements } = await load('core/db-adapter.js');
  const cases = [
    ['', []],
    ['  ;; -- only a comment\n /* and another */ ;', []],
    ['SELECT 1', ['SELECT 1']],
    ['SELECT 1; SELECT 2;', ['SELECT 1', 'SELECT 2']],
    ["INSERT INTO t VALUES ('a;b', 'it''s; ok'); SELECT 2", ["INSERT INTO t VALUES ('a;b', 'it''s; ok')", 'SELECT 2']],
    ['SELECT "a;b", `c;d`, [e;f] FROM x; SELECT 3', ['SELECT "a;b", `c;d`, [e;f] FROM x', 'SELECT 3']],
    ["SELECT 1 -- not ; split\n; SELECT 2", ['SELECT 1 -- not ; split', 'SELECT 2']],
    ['SELECT /* ; */ 1; SELECT 2', ['SELECT /* ; */ 1', 'SELECT 2']],
    ['CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = CASE WHEN 1 THEN 2 END; DELETE FROM u; END; SELECT 1',
      ['CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = CASE WHEN 1 THEN 2 END; DELETE FROM u; END', 'SELECT 1']],
    ['create temp trigger tr after delete on t begin select 1; end;select 2', ['create temp trigger tr after delete on t begin select 1; end', 'select 2']],
    ["SELECT CASE WHEN 1 THEN 'end;' END; SELECT 2", ["SELECT CASE WHEN 1 THEN 'end;' END", 'SELECT 2']],
  ];
  for (const [sql, want] of cases) assert.deepStrictEqual(splitStatements(sql), want, JSON.stringify(sql));
});

test('returnsRows: which statements answer with rows', async () => {
  const { returnsRows } = await load('core/db-adapter.js');
  const yes = ['SELECT 1', '  select 1', '-- c\nSELECT 1', '/* c */ VALUES (1)', 'PRAGMA user_version', 'PRAGMA table_info(t)',
    'PRAGMA journal_mode = DELETE', 'pragma main.journal_mode=delete', 'PRAGMA integrity_check', 'PRAGMA foreign_key_check',
    'PRAGMA max_page_count = 10', 'WITH x AS (SELECT 1) SELECT * FROM x', 'EXPLAIN SELECT 1'];
  const no = ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'CREATE TABLE t (x)', 'BEGIN', 'COMMIT',
    'ROLLBACK', 'PRAGMA foreign_keys = ON', 'PRAGMA user_version = 3', "VACUUM INTO 'x'", 'DROP TABLE t',
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'REPLACE INTO t VALUES (1)'];
  for (const s of yes) assert.strictEqual(returnsRows(s), true, s);
  for (const s of no) assert.strictEqual(returnsRows(s), false, s);
});
