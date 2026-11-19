// Stand-ins for the phone's two storage plugins (CapacitorSQLite and Plannr's own PlannrStorage), for
// the Chromium suites of step 1.4 C9-C10 (test-ui/storage-startup.js, ...). Loaded into every page
// with page.addInitScript() BEFORE the app's scripts; it sets window.__plannrTestPlugins, which
// public/local-bootstrap.js passes to storage-native.js instead of asking Capacitor.
//
// The "files" live in sessionStorage (key "fakefs:<path>", base64), so they survive a page reload in
// the same tab, as files do; localStorage (the kvvfs copy) is left to the app. A database file is
// opened as an in-memory sqlite-wasm database (the app's own engine, db-engine.js) and written back to
// its "file" after every statement that ends outside a transaction, so a reload in the middle of a
// transaction loses it, as a killed app would. VACUUM INTO <path> is answered by writing the image to
// that path. The free space comes from sessionStorage "fakefs-free" (default 8 GB).
// Behaves as the C1 spike measured the real plugin: run() refuses a statement that returns rows, and
// reports changes as the total_changes() difference; execute() is refused.
(() => {
  if (window.__plannrTestPlugins) return;
  const ROOT = '/data/user/0/com.plannr.app';
  const DIRS = { dataDir: ROOT, databasesDir: ROOT + '/databases', filesDir: ROOT + '/files', cacheDir: ROOT + '/cache' };
  const ss = window.sessionStorage;
  const KEY = (p) => 'fakefs:' + p;
  const b64enc = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const b64dec = (b64) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
  const getFile = (p) => { const v = ss.getItem(KEY(p)); return v == null ? null : b64dec(v); };
  const putFile = (p, bytes) => ss.setItem(KEY(p), b64enc(bytes));
  const delFile = (p) => ss.removeItem(KEY(p));
  const norm = (p) => {
    if (typeof p !== 'string' || !p) throw new Error('a path is missing');
    const plain = p.replace(/^file:\/\//, '');
    if (!plain.startsWith('/')) throw new Error('a path must be absolute: ' + p);
    const parts = [];
    for (const seg of plain.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
    const full = '/' + parts.join('/');
    if (!full.startsWith(ROOT + '/')) throw new Error("a path is outside the app's own folder: " + p);
    return full;
  };
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const calls = [];

  const storage = {
    async info() { calls.push(['storage.info']); return { freeBytes: Number(ss.getItem('fakefs-free') || 8e9), totalBytes: 16e9, ...DIRS }; },
    async sizes({ paths }) { const out = {}; for (const p of paths) { const b = getFile(norm(p)); out[p] = b ? b.length : -1; } return out; },
    async readFile({ path }) { const b = getFile(norm(path)); if (!b) throw new Error('no such file: ' + path); return { data: b64enc(b), bytes: b.length }; },
    async writeFile({ path, data }) {
      calls.push(['storage.writeFile', path]);
      let bytes;
      try { bytes = b64dec(data); } catch { throw new Error('write failed: the data is not base64'); }
      putFile(norm(path), bytes);
      return { bytes: bytes.length };
    },
    async rename({ from, to }) {
      calls.push(['storage.rename', from, to]);
      const a = norm(from); const b = norm(to);
      if (dirOf(a) !== dirOf(b)) throw new Error('rename only within one folder (one atomic step)');
      const bytes = getFile(a);
      if (!bytes) throw new Error(`nothing to rename: ${from} does not exist`);
      putFile(b, bytes); delFile(a);
      return {};
    },
    async remove({ path }) { const p = norm(path); const existed = getFile(p) != null; delFile(p); return { existed }; },
  };

  let sqlite3 = null;
  const engine = async () => {
    if (!sqlite3) { const e = await import('/db-engine.js'); await e.ready(); sqlite3 = e.getSqlite3(); }
    return sqlite3;
  };
  const fileOf = (name) => `${DIRS.databasesDir}/${name}SQLite.db`;
  const conns = new Map(); // 'RW_name' -> { name, readonly, db }
  const key = (name, ro) => (ro ? 'RO_' : 'RW_') + name;
  const fail = (method, e) => { throw new Error(`${method}: ${e && e.message ? e.message : e}`); };
  const conn = (method, database, readonly) => {
    const c = conns.get(key(database, !!readonly));
    if (!c) throw new Error(`${method}: No available connection for database ${database}`);
    if (!c.db) throw new Error(`${method}: database ${database} not opened`);
    return c;
  };
  const persist = (c) => {
    if (c.readonly) return;
    if (!sqlite3.capi.sqlite3_get_autocommit(c.db.pointer)) return; // inside a transaction: not yet on "disk"
    putFile(fileOf(c.name), sqlite3.capi.sqlite3_js_db_export(c.db.pointer));
  };
  const totalChanges = (db) => db.selectValue('SELECT total_changes()');

  const sqlite = {
    calls,
    async createConnection({ database, readonly = false }) {
      calls.push(['createConnection', database, readonly]);
      if (conns.has(key(database, !!readonly))) throw new Error(`createConnection: Connection ${database} already exists`);
      conns.set(key(database, !!readonly), { name: database, readonly: !!readonly, db: null });
    },
    async open({ database, readonly = false }) {
      calls.push(['open', database, readonly]);
      const c = conns.get(key(database, !!readonly));
      if (!c) throw new Error(`Open: No available connection for database ${database}`);
      const s3 = await engine();
      const bytes = getFile(fileOf(database));
      if (!bytes && readonly) fail('Open', new Error('unable to open database file'));
      const db = new s3.oo1.DB(':memory:', 'c');
      try {
        if (bytes && bytes.length) {
          const p = s3.wasm.allocFromTypedArray(bytes);
          const rc = s3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length,
            s3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
          if (rc !== 0) throw new Error(`file is not a database (code ${rc})`);
        }
        db.exec('PRAGMA foreign_keys = ON');
        db.selectValue('SELECT COUNT(*) FROM sqlite_master'); // touches the file, as Android does
      } catch (e) { db.close(); fail('Open', e); }
      c.db = db;
      if (!bytes) persist(c); // opening creates the file
    },
    async close({ database, readonly = false }) {
      const c = conns.get(key(database, !!readonly));
      if (!c) throw new Error(`Close: No available connection for database ${database}`);
      if (c.db) { c.db.close(); c.db = null; }
    },
    async closeConnection({ database, readonly = false }) {
      calls.push(['closeConnection', database, readonly]);
      const c = conns.get(key(database, !!readonly));
      if (!c) throw new Error(`CloseConnection: No available connection for database ${database}`);
      if (c.db) c.db.close();
      conns.delete(key(database, !!readonly));
    },
    async query({ database, statement, values = [], readonly = false }) {
      const c = conn('Query', database, readonly);
      try {
        const rows = [];
        c.db.exec({ sql: statement, bind: values.length ? values : undefined, rowMode: 'object', resultRows: rows });
        persist(c); // a PRAGMA that writes, or VACUUM INTO through query
        return { values: rows };
      } catch (e) { fail('Query', e); }
    },
    async run({ database, statement, values = [], transaction = true, readonly = false }) {
      if (transaction !== false) throw new Error('the adapter must pass transaction: false (plan §1.2)');
      const c = conn('Run', database, readonly);
      const into = /^\s*VACUUM\s+INTO\s+'((?:[^']|'')*)'\s*;?\s*$/i.exec(statement);
      if (into) { putFile(norm(into[1].replace(/''/g, "'")), sqlite3.capi.sqlite3_js_db_export(c.db.pointer)); return { changes: { changes: 0, lastId: 0 } }; }
      let st;
      try {
        st = c.db.prepare(statement);
        if (st.columnCount > 0) {
          if (values.length) st.bind(values);
          st.step();
          throw new Error('unknown error (code 0): Queries can be performed using SQLiteDatabase query or rawQuery methods only.');
        }
      } catch (e) { if (st) st.finalize(); fail('Run', e); }
      try {
        const before = totalChanges(c.db);
        if (values.length) st.bind(values);
        st.stepReset();
        st.finalize(); st = null;
        const lastId = c.db.selectValue('SELECT last_insert_rowid()');
        const changes = totalChanges(c.db) - before;
        persist(c);
        return { changes: { changes, lastId } };
      } catch (e) { if (st) st.finalize(); fail('Run', e); }
    },
    async execute() { throw new Error('the adapter must never call execute() (C1)'); },
    async executeSet() { throw new Error('the adapter must never call executeSet()'); },
  };

  window.__plannrTestPlugins = { sqlite, storage };
  window.__plannrFakeFs = { getFile, putFile, delFile, DIRS, fileOf, calls, list: () => Object.keys(ss).filter((k) => k.startsWith('fakefs:')).map((k) => k.slice(7)).sort() };
})();
