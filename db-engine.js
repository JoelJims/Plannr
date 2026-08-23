// Phase 4b — WASM SQLite engine adapter (Phase 3 chose @sqlite.org/sqlite-wasm, kvvfs backend).
//
// A DatabaseSync-compatible class for the browser/Capacitor runtime, covering exactly the surface
// Phase 4a's audit found in db.js/repo.js/server.js: new DatabaseSync(path[, {readOnly}]), .exec(sql),
// .prepare(sql) -> .get()/.all()/.run(), .close(). NOT wired into db.js/repo.js/server.js yet — those
// still run on node:sqlite. This file is proven standalone (see the Phase 4b proof harness).
//
// ── Async bootstrap ─────────────────────────────────────────────────────────────────────────────
// sqlite-wasm's own module init is unconditionally async (confirmed in Spike A for the sql.js build;
// same constraint here). `ready()` must be awaited exactly once, before the first `new DatabaseSync()`
// — same contract as the sql.js spike adapter, not hidden behind a synchronous constructor.
//
// ── Persistence: kvvfs, not export() ────────────────────────────────────────────────────────────
// Backed by sqlite3.oo1.JsStorageDb — a real incremental VFS (one localStorage record per DB page),
// not sql.js's whole-database export(). This is the entire reason this engine was chosen: cached
// PreparedStatement handles survive writes (Spike A2), unlike sql.js's export() which invalidated
// every other open statement on the connection.
//
// ── Single kvvfs slot ────────────────────────────────────────────────────────────────────────────
// kvvfs's JsStorageDb supports exactly two fixed namespaces, 'local' or 'session' storage — not
// arbitrary filenames. This app has exactly one database, so `path` is accepted (for surface
// compatibility with `new DatabaseSync(path)`) but is not used to select storage: every instance
// opens the same 'local' (persistent) kvvfs namespace. This deliberately does not generalize to
// multiple named databases — there is no current need for one, and kvvfs does not cleanly support it
// anyway (only two slots exist).
//
// ── Error shape ──────────────────────────────────────────────────────────────────────────────────
// sqlite-wasm's real error class (SQLite3Error) carries the SQLite result code as `.resultCode` — NOT
// `.sqlite3Rc`, despite that being the property name isStorageFullError() in db.js was written to
// check (that name came from an earlier spike script's own ad-hoc guess, not from this package's
// actual API). Rather than special-case this in db.js, every error this adapter lets escape also gets
// `.sqlite3Rc` mirrored from `.resultCode`, so isStorageFullError()'s existing check keeps working
// unchanged once this adapter is eventually wired in.

let sqlite3 = null;
let readyPromise = null;

/** Must be awaited exactly once, before the first `new DatabaseSync()`. Idempotent. */
export function ready() {
  if (!readyPromise) {
    readyPromise = import('@sqlite.org/sqlite-wasm')
      .then((mod) => mod.default())
      .then((mod) => { sqlite3 = mod; });
  }
  return readyPromise;
}

/**
 * Escape hatch onto the underlying sqlite3 API namespace (capi, kvvfs, oo1, ...) for tooling that
 * is genuinely outside the DatabaseSync surface — e.g. a future one-time import of an existing
 * node:sqlite-created database into kvvfs. Not part of the DatabaseSync-compatible contract.
 */
export function getSqlite3() {
  if (!sqlite3) throw new Error('db-engine: ready() must be awaited before getSqlite3().');
  return sqlite3;
}

const KVVFS_SLOT = 'local'; // persistent (vs. 'session', which is wiped when the tab/WebView closes)

// See header comment: mirrors sqlite-wasm's real `.resultCode` onto `.sqlite3Rc` so db.js's existing
// isStorageFullError() (err.errcode ?? err.sqlite3Rc) recognizes a SQLITE_IOERR from this engine.
function normalizeError(err) {
  if (err && typeof err === 'object' && err.resultCode != null && err.sqlite3Rc == null) {
    try { err.sqlite3Rc = err.resultCode; } catch { /* non-configurable — nothing more we can do */ }
  }
  return err;
}

// A prepared-statement wrapper matching node:sqlite's Statement: .get(...params) -> object|undefined,
// .all(...params) -> object[], .run(...params) -> { changes, lastInsertRowid }. Rows are built as
// null-prototype objects (matches node:sqlite exactly — verified empirically, and relied on by tests)
// via cached column names, rather than via sqlite-wasm's own `stmt.get({})` convenience, so the exact
// shape is explicit rather than depending on how that convenience treats a non-plain-object target.
class Statement {
  constructor(rawDb, sql) {
    this._raw = rawDb.prepare(sql);
    this._rawDb = rawDb;
    this._cols = this._raw.columnCount > 0 ? this._raw.getColumnNames() : null;
  }
  _row() {
    const row = Object.create(null);
    for (let i = 0; i < this._cols.length; i++) row[this._cols[i]] = this._raw.get(i);
    return row;
  }
  // Every path below resets in a `finally`, not just after a clean return. node:sqlite leaves a
  // cached statement fully reusable after a throw (e.g. a constraint violation) — verified
  // empirically — and a cached statement left un-reset after an error is exactly the kind of thing
  // that would break every later call site sharing it, so this must match.
  get(...params) {
    try {
      if (params.length) this._raw.bind(params);
      const has = this._raw.step();
      return has && this._cols ? this._row() : undefined;
    } catch (e) { throw normalizeError(e); }
    finally { this._raw.reset(true); }
  }
  all(...params) {
    try {
      if (params.length) this._raw.bind(params);
      const rows = [];
      if (this._cols) { while (this._raw.step()) rows.push(this._row()); }
      return rows;
    } catch (e) { throw normalizeError(e); }
    finally { this._raw.reset(true); }
  }
  run(...params) {
    try {
      if (params.length) this._raw.bind(params);
      this._raw.step();
    } catch (e) { throw normalizeError(e); }
    finally { this._raw.reset(true); }
    const changes = this._rawDb.changes();
    const lastInsertRowid = Number(sqlite3.capi.sqlite3_last_insert_rowid(this._rawDb.pointer));
    return { changes, lastInsertRowid };
  }
}

// Matches node:sqlite's DatabaseSync surface used in this codebase: constructor(path[, {readOnly}]),
// .exec(sql), .prepare(sql), .close(). No BEGIN/COMMIT/ROLLBACK bookkeeping here (unlike the sql.js
// spike adapter) — kvvfs persists each write as it happens, so there is nothing to flush.
export class DatabaseSync {
  constructor(path, opts = {}) {
    if (!sqlite3) throw new Error('db-engine: ready() must be awaited once before the first `new DatabaseSync()` — see the header comment.');
    this.filename = path; // kept for API parity; see header comment on the single kvvfs slot
    try {
      this._raw = new sqlite3.oo1.JsStorageDb({ filename: KVVFS_SLOT, flags: opts.readOnly ? 'r' : 'c' });
    } catch (e) { throw normalizeError(e); }
  }
  exec(sql) {
    try { this._raw.exec(sql); } catch (e) { throw normalizeError(e); }
  }
  prepare(sql) {
    try { return new Statement(this._raw, sql); } catch (e) { throw normalizeError(e); }
  }
  close() {
    try { if (this._raw.isOpen()) this._raw.close(); } catch (e) { throw normalizeError(e); }
  }
}
