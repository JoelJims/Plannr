// The database adapter contract suite (step 1.4 B1; docs/step-1.4-storage-plan.md §5.1).
//
// The same checks run against every adapter: node-sqlite in Node (test/db-adapter-node.test.js),
// wasm-kvvfs in Chromium (stage B2), capacitor-sqlite on the emulator (stage C3). So this file
// imports nothing: no node:test, no node:assert, no file system.
//
// Each case is { name, needsFile?, run(db, env) }. `db` is a fresh, empty adapter; the assertion
// helpers are `t` below. needsFile marks the cases that replace the database, which needs a real
// file (or kvvfs's slot), not :memory:. `env` is what the runner hands in from the shared core:
// { createRequestQueue } (core/request-queue.js, B3), so the same queue is tested on every engine.

export class ContractFailure extends Error {}

const show = (v) => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? `<${x.length} bytes>` : x));
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v))); // node:sqlite rows have a null prototype

export const t = {
  ok(cond, msg) { if (!cond) throw new ContractFailure(msg || 'expected a true value'); },
  eq(actual, expected, msg) {
    if (show(plain(actual)) !== show(plain(expected))) {
      throw new ContractFailure(`${msg ? msg + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
    }
  },
  async rejects(promiseOrFn, pattern, msg) {
    let err = null;
    try { await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn); } catch (e) { err = e; }
    if (!err) throw new ContractFailure(`${msg ? msg + ': ' : ''}expected it to fail`);
    if (pattern && !pattern.test(String(err.message))) {
      throw new ContractFailure(`${msg ? msg + ': ' : ''}failed with "${err.message}", expected ${pattern}`);
    }
    return err;
  },
};

const SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, paise INTEGER NOT NULL);
  CREATE TABLE child (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES item(id));
`;
// The settings upsert as Plannr writes it (core/routes/backup-reminder.js, db.js and others).
const UPSERT = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
const count = async (db, table) => (await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;

export const CONTRACT_CASES = [
  {
    name: 'get, all and run: rows, no row, row ids and change counts',
    async run(db) {
      await db.exec(SCHEMA);
      const a = await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['cement', 125050]);
      const b = await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['sand', 0]);
      t.eq([a, b], [{ changes: 1, lastInsertRowid: 1 }, { changes: 1, lastInsertRowid: 2 }]);
      t.eq(await db.get('SELECT name, paise FROM item WHERE id = ?', [1]), { name: 'cement', paise: 125050 });
      t.eq(await db.get('SELECT name FROM item WHERE id = ?', [99]), undefined, 'no row');
      t.eq(await db.all('SELECT id, name FROM item ORDER BY id'), [{ id: 1, name: 'cement' }, { id: 2, name: 'sand' }]);
      t.eq(await db.all('SELECT id FROM item WHERE paise < ?', [-1]), [], 'no rows');
      t.eq((await db.run('UPDATE item SET paise = paise + 1')).changes, 2, 'an UPDATE reports its change count');
      t.eq(await db.get('SELECT NULL AS n, 1.5 AS r, ? AS s', ['ünïcödé ✓']), { n: null, r: 1.5, s: 'ünïcödé ✓' });
    },
  },
  {
    name: 'ON CONFLICT ... DO UPDATE keeps one row and updates it',
    async run(db) {
      await db.exec(SCHEMA);
      await db.run(UPSERT, ['backup_reminder_days', '7']);
      await db.run(UPSERT, ['backup_reminder_days', '30']);
      t.eq(await db.all('SELECT key, value FROM settings'), [{ key: 'backup_reminder_days', value: '30' }]);
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', ['cement', 1]);
      const again = await db.run('INSERT INTO item (name, paise) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', ['cement', 2]);
      t.eq(again.changes, 0, 'DO NOTHING changes no row');
      t.eq(await db.all('SELECT name, paise FROM item'), [{ name: 'cement', paise: 1 }]);
    },
  },
  {
    name: 'params must be an array of positional values',
    async run(db) {
      await db.exec(SCHEMA);
      await t.rejects(() => db.get('SELECT 1 WHERE ? = 1', { 1: 1 }), /params must be an array/);
      t.eq(await db.get('SELECT ? + ? AS s', [2, 3]), { s: 5 });
    },
  },
  {
    name: 'foreign keys are enforced',
    async run(db) {
      await db.exec(SCHEMA);
      t.eq(await db.get('PRAGMA foreign_keys'), { foreign_keys: 1 });
      await t.rejects(() => db.run('INSERT INTO child (item_id) VALUES (?)', [42]), /FOREIGN KEY/i);
    },
  },
  {
    name: 'transaction commits and returns what fn returns',
    async run(db) {
      await db.exec(SCHEMA);
      const out = await db.transaction(async (tx) => {
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['steel', 900]);
        await tx.run(UPSERT, ['k', 'v']);
        return 'done';
      });
      t.eq(out, 'done');
      t.eq([await count(db, 'item'), await count(db, 'settings')], [1, 1]);
      t.eq(db.inTransaction, false);
    },
  },
  {
    name: 'transaction rolls back everything when a statement fails, and the adapter still works',
    async run(db) {
      await db.exec(SCHEMA);
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['cement', 1]);
      await t.rejects(db.transaction(async (tx) => {
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['brick', 2]);
        await tx.run(UPSERT, ['k', 'v']);
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['cement', 3]); // UNIQUE fails
      }), /UNIQUE/i);
      t.eq(await db.all('SELECT name FROM item'), [{ name: 'cement' }], 'brick rolled back');
      t.eq(await count(db, 'settings'), 0, 'the upsert rolled back');
      t.eq(db.inTransaction, false);
      await db.transaction(async (tx) => { await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['brick', 2]); });
      t.eq(await count(db, 'item'), 2, 'a later transaction commits');
    },
  },
  {
    name: 'transaction rolls back when fn throws something that is not SQL',
    async run(db) {
      await db.exec(SCHEMA);
      await t.rejects(db.transaction(async (tx) => {
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['brick', 2]);
        await Promise.resolve();
        throw new Error('the caller changed its mind');
      }), /changed its mind/);
      t.eq(await count(db, 'item'), 0);
    },
  },
  {
    name: 'a nested transaction is refused, and the outer one rolls back',
    async run(db) {
      await db.exec(SCHEMA);
      await t.rejects(db.transaction(async (tx) => {
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['brick', 2]);
        await tx.transaction(async () => {});
      }), /already open/);
      t.eq(await count(db, 'item'), 0);
      t.eq(db.inTransaction, false);
    },
  },
  {
    name: 'one migration step: the table and user_version change together, or not at all',
    async run(db) {
      await db.exec(SCHEMA);
      t.eq(await db.get('PRAGMA user_version'), { user_version: 0 });
      const step = (version, sql) => db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.exec(`PRAGMA user_version = ${version}`);
      });
      await step(1, 'ALTER TABLE item ADD COLUMN note TEXT');
      t.eq(await db.get('PRAGMA user_version'), { user_version: 1 });
      await t.rejects(step(2, 'ALTER TABLE item ADD COLUMN extra TEXT; ALTER TABLE no_such_table ADD COLUMN x TEXT'), /no such table/i);
      t.eq(await db.get('PRAGMA user_version'), { user_version: 1 }, 'the failed step left user_version');
      const cols = (await db.all('PRAGMA table_info(item)')).map((c) => c.name);
      t.eq(cols, ['id', 'name', 'paise', 'note'], 'the failed step left the table');
    },
  },
  {
    name: 'exportBytes gives a SQLite file with the data; replaceWith brings that data back',
    needsFile: true,
    async run(db) {
      await db.exec(SCHEMA);
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['cement', 125050]);
      await db.run(UPSERT, ['budget_paise', '5000000']);
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['deleted later', 1]); // id 2, then gone:
      await db.run("DELETE FROM item WHERE name = 'deleted later'");              // the sequence stays at 2
      const bytes = await db.exportBytes();
      t.ok(bytes instanceof Uint8Array && bytes.length >= 512, 'bytes');
      t.eq(String.fromCharCode(...bytes.subarray(0, 15)), 'SQLite format 3', 'a SQLite header');
      const read = 'SELECT name, paise FROM item ORDER BY id'; // the same SQL text before and after
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['later', 1]);
      await db.run('DELETE FROM settings');
      t.eq((await db.all(read)).length, 2);
      await db.replaceWith(bytes);
      t.eq(await db.all(read), [{ name: 'cement', paise: 125050 }], 'the exported data is back');
      t.eq(await db.all('SELECT key, value FROM settings'), [{ key: 'budget_paise', value: '5000000' }]);
      t.eq(await db.get('PRAGMA foreign_keys'), { foreign_keys: 1 }, 'foreign keys on after reopening');
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['after', 2]);
      t.eq((await db.get("SELECT id FROM item WHERE name = 'after'")).id, 3, 'id 2 is not reused: the AUTOINCREMENT sequence came back too');
    },
  },
  {
    name: 'replaceWith refuses bytes that are not a SQLite database and changes nothing',
    needsFile: true,
    async run(db) {
      await db.exec(SCHEMA);
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['cement', 1]);
      await t.rejects(() => db.replaceWith(new TextEncoder().encode('not a database at all, just text that is long enough')), /not a SQLite database/);
      const good = await db.exportBytes();
      const cut = good.slice(0, 600); // a real header, then nothing: a broken file
      await t.rejects(() => db.replaceWith(cut), /integrity|malformed|not a database|disk image/i);
      t.eq(await db.all('SELECT name FROM item'), [{ name: 'cement' }], 'the data is untouched');
      await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['still writable', 2]);
    },
  },
  {
    name: 'exportBytes, replaceWith and close are refused inside a transaction',
    needsFile: true,
    async run(db) {
      await db.exec(SCHEMA);
      const bytes = await db.exportBytes();
      await t.rejects(db.transaction(async (tx) => {
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['x', 1]);
        await tx.exportBytes();
      }), /inside a transaction/);
      await t.rejects(db.transaction(async (tx) => { await tx.replaceWith(bytes); }), /inside a transaction/);
      await t.rejects(db.transaction(async (tx) => { await tx.close(); }), /inside a transaction/);
      t.eq(await count(db, 'item'), 0);
    },
  },
  {
    name: 'info names the engine and gives a size',
    async run(db) {
      await db.exec(SCHEMA);
      const i = await db.info();
      t.eq(i.engine, db.engine);
      t.ok(typeof i.path === 'string' && i.path.length > 0, 'a path');
      t.ok(Number.isInteger(i.sizeBytes) && i.sizeBytes > 0, `a size (${i.sizeBytes})`);
    },
  },
  {
    name: 'two writes at once through the request queue, one failing: only the failed one is undone',
    async run(db, env) {
      t.ok(env && typeof env.createRequestQueue === 'function', 'the runner hands in createRequestQueue');
      await db.exec(SCHEMA);
      const later = () => new Promise((r) => setTimeout(r, 0)); // a real wait, as on an async engine
      const queue = env.createRequestQueue();
      const a = queue.run(() => db.transaction(async (tx) => {
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['A first', 100]);
        await later();
        await tx.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['A second', 200]);
        throw new Error('A failed half way');
      }));
      const b = queue.run(async () => { await later(); await db.run('INSERT INTO item (name, paise) VALUES (?, ?)', ['B', 300]); });
      const c = queue.run(() => db.transaction(async (tx) => { await tx.run(UPSERT, ['saved_by', 'C']); }));
      const [ra, rb, rc] = await Promise.allSettled([a, b, c]);
      t.eq([ra.status, String(ra.reason && ra.reason.message)], ['rejected', 'A failed half way'], 'A fails');
      t.eq([rb.status, rc.status], ['fulfilled', 'fulfilled'], `B and C succeed (C: ${rc.reason ? rc.reason.message : 'ok'})`);
      t.eq(await db.all('SELECT name, paise FROM item ORDER BY id'), [{ name: 'B', paise: 300 }]);
      t.eq(await db.all('SELECT key, value FROM settings'), [{ key: 'saved_by', value: 'C' }]);
      t.eq(db.inTransaction, false);
    },
  },
];
