// The database adapter interface the shared core uses (step 1.4 B1; docs/step-1.4-storage-plan.md §1).
//
// Every platform opens its database through an adapter with the same async methods:
//
//   get(sql, params)  all(sql, params)  run(sql, params) -> { changes, lastInsertRowid }
//   exec(sql)         transaction(async fn)               exportBytes()   replaceWith(bytes)
//   info() -> { engine, path, sizeBytes }                 close()
//
// params is always an array of positional values (Plannr binds no named parameters).
//
// The adapters:
//   - node-sqlite (db-adapter-node.js): the dev server, the tests, later the desktop app;
//   - wasm-kvvfs: the phone today and the browser preview (stage B2);
//   - capacitor-sqlite: the phone's database file (stage C, public/db-adapter-capacitor.js).
// node:sqlite and sqlite-wasm are synchronous underneath, so both are built by
// createSyncEngineAdapter() below: the methods do the work at once and return a settled Promise.
// The phone's SQLite plugin is async underneath; its adapter is built by createAsyncEngineAdapter().
//
// An adapter has no synchronous method: stage B kept two, prepare(sql) and execSync(sql), while it
// converted the callers, and removed them at its end (B17). Nothing here imports a platform module.

export const ADAPTER_METHODS = Object.freeze([
  'get', 'all', 'run', 'exec', 'transaction', 'exportBytes', 'replaceWith', 'info', 'close',
]);

export function checkAdapter(adapter) {
  const missing = ADAPTER_METHODS.filter((m) => !adapter || typeof adapter[m] !== 'function');
  if (missing.length) throw new Error(`The database adapter is missing: ${missing.join(', ')} (see core/db-adapter.js).`);
  if (typeof adapter.engine !== 'string' || !adapter.engine) throw new Error('The database adapter does not name its engine.');
  return adapter;
}

const toArgs = (params, method) => {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new TypeError(`db.${method}: params must be an array of positional values.`);
  return params;
};

// ROLLBACK, ignoring only "no transaction is active" (SQLite has already rolled back after some
// errors, e.g. a full disk). The same rule as rollbackQuietly() in db.js, which the core cannot import.
function rollbackAfterError(handle) {
  try { handle.exec('ROLLBACK'); } catch (e) { if (!/no transaction is active/i.test(String(e && e.message))) throw e; }
}

/**
 * An adapter over a synchronous SQLite handle with the DatabaseSync surface (node:sqlite, or
 * db-engine.js on sqlite-wasm): exec(sql), prepare(sql) -> get/all/run, close().
 *
 * platform:
 *   engine       'node-sqlite' | 'wasm-kvvfs' | ...
 *   handle()     the handle in use now (replaceWith may swap it)
 *   exportBytes(), replaceWith(bytes), info(), close()   the platform's own parts; each may be async
 *
 * Prepared statements are cached per handle and SQL text; the cache is dropped when the handle
 * changes, so a replaced database never runs a statement prepared on the old one.
 */
export function createSyncEngineAdapter(platform) {
  const { engine } = platform;
  let cacheFor = null;
  let cache = new Map();
  let inTransaction = false;

  const handle = () => {
    const h = platform.handle();
    if (!h) throw new Error(`db (${engine}): the database is closed.`);
    if (h !== cacheFor) { cacheFor = h; cache = new Map(); }
    return h;
  };
  const statement = (sql) => {
    const h = handle();
    let s = cache.get(sql);
    if (!s) { s = h.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const notInTransaction = (what) => {
    if (inTransaction) throw new Error(`db (${engine}): ${what} cannot run inside a transaction.`);
  };

  const adapter = {
    engine,

    async get(sql, params) { return statement(sql).get(...toArgs(params, 'get')); },
    async all(sql, params) { return statement(sql).all(...toArgs(params, 'all')); },
    async run(sql, params) {
      const r = statement(sql).run(...toArgs(params, 'run'));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    async exec(sql) { handle().exec(sql); },

    // BEGIN, await fn(adapter), COMMIT. Anything thrown (by SQL or by fn) rolls back and is passed
    // on. One at a time: a nested call is refused (stage B3's request queue keeps two requests from
    // sharing one). PRAGMA foreign_keys is a no-op inside a transaction, so set it before calling.
    async transaction(fn) {
      if (typeof fn !== 'function') throw new TypeError('db.transaction: pass a function.');
      if (inTransaction) throw new Error(`db (${engine}): a transaction is already open (nested transactions are not supported).`);
      const h = handle();
      h.exec('BEGIN');
      inTransaction = true;
      try {
        const result = await fn(adapter);
        handle().exec('COMMIT');
        return result;
      } catch (err) {
        try { rollbackAfterError(handle()); } catch (rollbackError) { err.rollbackError = rollbackError; }
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    get inTransaction() { return inTransaction; },

    async exportBytes() { notInTransaction('exportBytes'); return platform.exportBytes(); },
    async replaceWith(bytes) {
      notInTransaction('replaceWith');
      await platform.replaceWith(bytes);
      cacheFor = null; cache = new Map();
    },
    async info() { return platform.info(); },
    async close() {
      notInTransaction('close');
      cacheFor = null; cache = new Map();
      await platform.close();
    },
  };
  return adapter;
}

// ---- Engines that are async underneath (step 1.4 C3) ------------------------------------------------

// Split an exec() script into single statements. Semicolons inside string literals, quoted names,
// comments and a trigger's BEGIN ... END body do not split. Comments stay with their statement;
// a piece that is only whitespace and comments is dropped. (The phone's SQLite plugin has a
// multi-statement call of its own, but it rewrites SQL inside string literals: step 1.4 C1.)
export function splitStatements(sql) {
  const s = String(sql);
  const out = [];
  let start = 0;
  let i = 0;
  let words = [];        // the statement's first words, upper-cased, to spot CREATE [TEMP] TRIGGER
  let depth = 0;         // BEGIN/CASE ... END nesting inside a trigger
  let code = false;      // the current piece has something besides whitespace and comments
  const isTrigger = () => words[0] === 'CREATE' && (words[1] === 'TRIGGER' || ((words[1] === 'TEMP' || words[1] === 'TEMPORARY') && words[2] === 'TRIGGER'));
  const finish = (end) => {
    if (code) out.push(s.slice(start, end).trim());
    start = end + 1; words = []; depth = 0; code = false;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      code = true;
      const close = c;
      i++;
      while (i < s.length) {
        if (s[i] === close) { if (s[i + 1] === close) { i += 2; continue; } break; }
        i++;
      }
      i++;
    } else if (c === '[') {
      code = true;
      const j = s.indexOf(']', i + 1);
      i = j === -1 ? s.length : j + 1;
    } else if (c === '-' && s[i + 1] === '-') {
      const j = s.indexOf('\n', i + 2);
      i = j === -1 ? s.length : j + 1;
    } else if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      i = j === -1 ? s.length : j + 2;
    } else if (c === ';') {
      if (depth > 0 && isTrigger()) { i++; continue; }
      finish(i);
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      code = true;
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
      const w = s.slice(i, j).toUpperCase();
      if (words.length < 3) words.push(w);
      if (isTrigger()) {
        if (w === 'BEGIN' || w === 'CASE') depth++;
        else if (w === 'END' && depth > 0) depth--;
      }
      i = j;
    } else {
      if (!/\s/.test(c)) code = true;
      i++;
    }
  }
  finish(s.length);
  return out;
}

// PRAGMAs that answer with a row even when they set something.
const PRAGMAS_WITH_A_ROW = new Set(['journal_mode', 'locking_mode', 'max_page_count', 'mmap_size', 'busy_timeout',
  'journal_size_limit', 'soft_heap_limit', 'hard_heap_limit', 'threads', 'wal_autocheckpoint', 'analysis_limit', 'wal_checkpoint']);

// Does one statement answer with rows? (The phone's plugin runs those through query(), the others
// through run(), which refuses a statement that returns a row.)
export function returnsRows(statement) {
  const s = String(statement).replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  const first = (/^[A-Za-z]+/.exec(s) || [''])[0].toUpperCase();
  if (first === 'SELECT' || first === 'VALUES' || first === 'EXPLAIN') return true;
  if (first === 'WITH') return !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s);
  if (first !== 'PRAGMA') return false;
  const m = /^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(=)?/i.exec(s);
  if (!m) return true;
  return !m[2] || PRAGMAS_WITH_A_ROW.has(m[1].toLowerCase());
}

/**
 * An adapter over an engine that is async underneath: the phone's SQLite plugin (step 1.4 C3).
 * Same methods and the same rules as createSyncEngineAdapter() (one transaction at a time, a nested
 * one refused, exportBytes/replaceWith/close refused inside one).
 *
 * platform:
 *   engine
 *   query(sql, params) -> rows                              a statement that answers with rows
 *   write(sql, params) -> { changes, lastInsertRowid }      a statement that does not
 *   exportBytes(), replaceWith(bytes), info(), close()      the platform's own parts
 * exec(sql) splits the script here (splitStatements) and sends each statement to query() or write()
 * (returnsRows), so nothing ever goes through the plugin's own multi-statement call.
 */
export function createAsyncEngineAdapter(platform) {
  const { engine } = platform;
  let inTransaction = false;
  let closed = false;
  const open = () => { if (closed) throw new Error(`db (${engine}): the database is closed.`); };
  const notInTransaction = (what) => {
    if (inTransaction) throw new Error(`db (${engine}): ${what} cannot run inside a transaction.`);
  };
  const one = async (statement) => {
    if (returnsRows(statement)) await platform.query(statement, []);
    else await platform.write(statement, []);
  };
  const rollback = async () => {
    try { await platform.write('ROLLBACK', []); } catch (e) { if (!/no transaction is active/i.test(String(e && e.message))) throw e; }
  };

  const adapter = {
    engine,

    async get(sql, params) { open(); const rows = await platform.query(sql, toArgs(params, 'get')); return rows[0]; },
    async all(sql, params) { open(); return platform.query(sql, toArgs(params, 'all')); },
    async run(sql, params) {
      open();
      const args = toArgs(params, 'run');
      if (returnsRows(sql)) { await platform.query(sql, args); return { changes: 0, lastInsertRowid: 0 }; }
      const r = await platform.write(sql, args);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    async exec(sql) {
      open();
      for (const statement of splitStatements(sql)) await one(statement);
    },

    async transaction(fn) {
      if (typeof fn !== 'function') throw new TypeError('db.transaction: pass a function.');
      if (inTransaction) throw new Error(`db (${engine}): a transaction is already open (nested transactions are not supported).`);
      open();
      inTransaction = true;
      try {
        await platform.write('BEGIN', []);
      } catch (err) {
        inTransaction = false;
        throw err;
      }
      try {
        const result = await fn(adapter);
        await platform.write('COMMIT', []);
        return result;
      } catch (err) {
        try { await rollback(); } catch (rollbackError) { err.rollbackError = rollbackError; }
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    get inTransaction() { return inTransaction; },

    async exportBytes() { open(); notInTransaction('exportBytes'); return platform.exportBytes(); },
    async replaceWith(bytes) { open(); notInTransaction('replaceWith'); await platform.replaceWith(bytes); },
    async info() { open(); return platform.info(); },
    async close() {
      notInTransaction('close');
      if (closed) return;
      closed = true;
      await platform.close();
    },
  };
  return adapter;
}

// One SQL text on an adapter, in the shape of a prepared statement: get/all/run(...params), each
// returning a Promise. For code written against prepare() (repo.js, step 1.4 B10-B12), so a call
// site keeps its shape and only gains an await. The adapter prepares each SQL text once and keeps it.
export function statementOn(adapter, sql) {
  return {
    get: (...params) => adapter.get(sql, params),
    all: (...params) => adapter.all(sql, params),
    run: (...params) => adapter.run(sql, params),
  };
}
