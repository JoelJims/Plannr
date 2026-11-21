// A stand-in for the phone's two native plugins, for Node tests of public/db-adapter-capacitor.js
// (step 1.4 C3). It copies the behaviour the C1 spike measured on the emulator, so the adapter's
// work-arounds are tested here too; the real plugins are tested on the emulator (contract suite).
//
//   CapacitorSQLite (over node:sqlite, files in a temp folder):
//     - createConnection refuses a name that is already connected ("Connection <name> already exists");
//     - run() refuses a statement that answers with a row, with Android's own message;
//     - run() reports changes as the difference in total_changes() (a cascade counts);
//     - errors come back as "<Method>: <SQLite's message> (code <n> ...)";
//     - values arrive as JSON (as over the bridge);
//     - execute() and executeSet() exist but rewrite SQL like the real ones, so a test notices if the
//       adapter ever uses them;
//     - BEGIN through run() takes an EXCLUSIVE lock (Android turns it into
//       SQLiteSession.beginTransaction, EXCLUSIVE mode), and closing a connection that is still in a
//       transaction does not release it: close() refuses ("failed to close still in transaction"),
//       and closeConnection() drops the connection but its lock stays (Android keeps the session's
//       connection until the transaction ends, which no one can now do). Found on the emulator in C3.
//   PlannrStorage (over node:fs): info, sizes, readFile, writeFile, rename, remove; paths must be
//   inside the fake data folder.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function makeFakePlugins(dataDir, opts = {}) {
  const databasesDir = path.join(dataDir, 'databases');
  const cacheDir = path.join(dataDir, 'cache');
  const filesDir = path.join(dataDir, 'files');
  for (const d of [databasesDir, cacheDir, filesDir]) fs.mkdirSync(d, { recursive: true });
  const calls = [];
  const conns = new Map(); // key -> { name, readonly, db|null }
  const leaked = []; // connections dropped while in a transaction: their locks are still held
  const key = (database, readonly) => (readonly ? 'RO_' : 'RW_') + database;
  const fileOf = (name) => path.join(databasesDir, name + 'SQLite.db');
  const wire = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));
  // Android binds a whole number as a long (INTEGER); node:sqlite would bind it as REAL, so send BigInt.
  const bind = (values) => wire(values).map((v) => (Number.isInteger(v) ? BigInt(v) : v));
  const fail = (method, e) => {
    const code = e && (e.errcode ?? e.code);
    throw new Error(`${method}: ${e && e.message ? e.message : e}${typeof code === 'number' ? ` (code ${code})` : ''}`);
  };
  const conn = (method, database, readonly) => {
    const c = conns.get(key(database, !!readonly));
    if (!c) throw new Error(`${method}: No available connection for database ${database}`);
    if (!c.db) throw new Error(`${method}: database ${database} not opened`);
    return c.db;
  };
  const totalChanges = (db) => db.prepare('SELECT total_changes() AS t').get().t;

  const sqlite = {
    calls,
    async createConnection({ database, readonly = false }) {
      calls.push(['createConnection', database, readonly]);
      const k = key(database, !!readonly);
      if (conns.has(k)) throw new Error(`createConnection: Connection ${database} already exists`);
      conns.set(k, { name: database, readonly: !!readonly, db: null });
    },
    async open({ database, readonly = false }) {
      calls.push(['open', database, readonly]);
      const c = conns.get(key(database, !!readonly));
      if (!c) throw new Error(`Open: No available connection for database ${database}`);
      try {
        if (readonly && !fs.existsSync(fileOf(database))) throw new Error('unable to open database file');
        c.db = new DatabaseSync(fileOf(database), readonly ? { readOnly: true } : {});
        c.db.exec('PRAGMA foreign_keys = ON');
        if (!readonly) c.db.prepare('SELECT COUNT(*) FROM sqlite_master').get(); // touches the file, as Android does
      } catch (e) { if (c.db) { try { c.db.close(); } catch { /* not open */ } } c.db = null; fail('Open', e); }
    },
    async close({ database, readonly = false }) {
      calls.push(['close', database, readonly]);
      const c = conns.get(key(database, !!readonly));
      if (!c) throw new Error(`Close: No available connection for database ${database}`);
      if (c.db && c.db.isTransaction) throw new Error(`Close: database ${database} failed to close still in transaction`);
      if (c.db) { try { c.db.close(); } catch (e) { fail('Close', e); } c.db = null; }
    },
    async closeConnection({ database, readonly = false }) {
      calls.push(['closeConnection', database, readonly]);
      const k = key(database, !!readonly);
      const c = conns.get(k);
      if (!c) throw new Error(`CloseConnection: No available connection for database ${database}`);
      if (c.db && c.db.isTransaction) leaked.push(c.db); // its lock stays, as on Android
      else if (c.db) { try { c.db.close(); } catch { /* as the plugin */ } }
      conns.delete(k);
    },
    async getUrl({ database }) { return { url: 'file://' + fileOf(database) }; },
    async query({ database, statement, values = [], readonly = false }) {
      calls.push(['query', statement]);
      if (opts.beforeCall) opts.beforeCall('query', statement);
      const db = conn('Query', database, readonly);
      try {
        const rows = db.prepare(statement).all(...bind(values));
        return wire({ values: rows.map((r) => ({ ...r })) });
      } catch (e) { fail('Query', e); }
    },
    async run({ database, statement, values = [], transaction = true, readonly = false }) {
      calls.push(['run', statement, transaction]);
      if (opts.beforeCall) opts.beforeCall('run', statement);
      if (transaction !== false) throw new Error('the adapter must pass transaction: false (plan §1.2)');
      const db = conn('Run', database, readonly);
      try {
        const before = totalChanges(db);
        if (/^\s*BEGIN\s*(TRANSACTION)?\s*;?\s*$/i.test(statement)) { // Android: beginTransaction(), EXCLUSIVE
          db.exec('BEGIN EXCLUSIVE');
          return wire({ changes: { changes: 0, lastId: 0, values: [] } });
        }
        const st = db.prepare(statement);
        if (st.columns().length > 0) {
          // Android steps the statement once, then refuses it.
          st.get(...bind(values));
          throw new Error('unknown error (code 0): Queries can be performed using SQLiteDatabase query or rawQuery methods only.');
        }
        st.run(...bind(values));
        const lastId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
        return wire({ changes: { changes: totalChanges(db) - before, lastId, values: [] } });
      } catch (e) {
        if (/^unknown error/.test(e.message)) throw new Error('Run: ' + e.message);
        fail('Run', e);
      }
    },
    async execute() { calls.push(['execute']); throw new Error('the adapter must never call execute(): it rewrites SQL inside string literals (C1)'); },
    async executeSet() { calls.push(['executeSet']); throw new Error('the adapter must never call executeSet() (plugin issue #671)'); },
  };

  const root = fs.realpathSync(dataDir);
  const inside = (p) => {
    if (typeof p !== 'string' || !p) throw new Error('a path is missing');
    const plain = p.replace(/^file:\/\//, '');
    if (!path.isAbsolute(plain)) throw new Error('a path must be absolute: ' + p);
    const full = path.resolve(plain);
    const real = fs.existsSync(full) ? fs.realpathSync(full) : path.join(fs.realpathSync(path.dirname(full)), path.basename(full));
    if (!real.startsWith(root + path.sep)) throw new Error("a path is outside the app's own folder: " + p);
    return real;
  };
  const storage = {
    calls,
    async info() {
      calls.push(['storage.info']);
      return { freeBytes: opts.freeBytes ?? 8e9, totalBytes: 16e9, dataDir, databasesDir, filesDir, cacheDir };
    },
    async sizes({ paths }) {
      const out = {};
      for (const p of paths) { const f = inside(p); out[p] = fs.existsSync(f) && fs.statSync(f).isFile() ? fs.statSync(f).size : -1; }
      return out;
    },
    async readFile({ path: p }) {
      calls.push(['storage.readFile', p]);
      const f = inside(p);
      if (!fs.existsSync(f)) throw new Error('no such file: ' + path.basename(f));
      const b = fs.readFileSync(f);
      return { data: b.toString('base64'), bytes: b.length };
    },
    async writeFile({ path: p, data }) {
      calls.push(['storage.writeFile', p]);
      if (opts.beforeCall) opts.beforeCall('storage.writeFile', p);
      const f = inside(p);
      fs.writeFileSync(f, Buffer.from(data, 'base64'));
      return { bytes: fs.statSync(f).size };
    },
    async rename({ from, to }) {
      calls.push(['storage.rename', from, to]);
      if (opts.beforeCall) opts.beforeCall('storage.rename', from);
      const a = inside(from); const b = inside(to);
      if (!fs.existsSync(a)) throw new Error('nothing to rename');
      if (path.dirname(a) !== path.dirname(b)) throw new Error('rename only within one folder (one atomic step)');
      fs.renameSync(a, b);
    },
    async remove({ path: p }) {
      calls.push(['storage.remove', p]);
      const f = inside(p);
      const existed = fs.existsSync(f);
      if (existed) { if (fs.statSync(f).isDirectory()) throw new Error('refusing to remove a folder'); fs.unlinkSync(f); }
      return { existed };
    },
  };
  return { sqlite, storage, databasesDir, cacheDir, filesDir, fileOf, leaked };
}

module.exports = { makeFakePlugins };
