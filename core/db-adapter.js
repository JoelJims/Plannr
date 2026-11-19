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
//   - capacitor-sqlite: the phone's database file (stage C).
// node:sqlite and sqlite-wasm are synchronous underneath, so both are built by
// createSyncEngineAdapter() below: the methods do the work at once and return a settled Promise.
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
