// SPIKE (Phase 3, Spike A) — throwaway experiment. Do NOT wire this into db.js/repo.js/server.js.
//
// Adapter exposing (most of) node:sqlite's DatabaseSync surface, backed by sql.js (SQLite compiled
// to WebAssembly/asm.js). Goal: prove/disprove whether db.js, repo.js, and server.js could keep every
// call site unchanged if the underlying engine were swapped for something that can run inside an
// Android WebView (node:sqlite cannot; sql.js is synchronous once initialized, unlike the Promise-based
// @capacitor-community/sqlite, which would force an async rewrite through the whole data layer).
//
// VERDICT: does not work as a zero-call-site-change adapter. Two independent, both-fatal findings,
// each confirmed empirically (not just reasoned about) — see the spike report for the full write-up:
//
// 1) sql.js's WASM module bootstrap (initSqlJs()) is UNCONDITIONALLY async in every build sql.js
//    ships (verified: asm.js and wasm builds both return a Promise; no synchronous entry point
//    exists anywhere in the public API). db.js's very first line, `const db = new
//    DatabaseSync(DB_PATH)`, is a synchronous, module-load-time statement. This adapter needs
//    `ready()` awaited once, before the first `new DatabaseSync(...)`, to bridge that gap — the
//    smallest possible deviation from "zero call sites change", but a real one.
//
// 2) FATAL: sql.js's ONLY persistence mechanism, `Database.export()`, INVALIDATES every other
//    already-prepared Statement on that connection the moment it's called (confirmed with an
//    isolated repro: prepare two statements, use both successfully, call .export(), and both throw
//    "Statement closed" on their next use — a freshly-.prepare()'d statement afterward works fine,
//    only pre-existing ones break). db.js/repo.js/server.js prepare ~150 statements ONCE at module
//    load and reuse them for the process's entire lifetime — that idiom is exactly what breaks.
//    There is no flush timing that avoids this while still persisting more often than "at clean
//    shutdown only" (unacceptable data-loss risk for a financial ledger on a mobile OS that can kill
//    the app without warning). The only real fix is to stop caching prepared statements at all
//    (re-`prepare()` fresh before every single call) — which is a rewrite of the data layer's
//    structure, not a "zero call site changes" adapter.
//
// Everything below is implemented as if neither problem existed, so the REST of the surface —
// .prepare()/.get()/.all()/.run()/.exec()/.close(), row shaping, changes/lastInsertRowid, PRAGMA
// handling — could be verified for correctness independently. That part works.

const fs = require('fs');
const initSqlJs = require('sql.js');

let SQL = null; // the initialized sql.js namespace (has .Database), set once by ready()
let readyPromise = null;

// Must be awaited exactly once, before the first `new DatabaseSync(...)`. Idempotent (safe to call
// more than once; later calls just return the same cached promise).
function ready() {
  if (!readyPromise) readyPromise = initSqlJs().then((mod) => { SQL = mod; });
  return readyPromise;
}

// A prepared-statement wrapper matching node:sqlite's Statement: .get(...params) -> object|undefined,
// .all(...params) -> object[], .run(...params) -> { changes, lastInsertRowid }. Holds one live sql.js
// Statement and rebinds/resets it across calls (mirrors "hot prepared statement, reused with different
// params" — the idiom every call site in this codebase already uses).
class Statement {
  constructor(adapterDb, sql) {
    this._adapterDb = adapterDb;
    this._raw = adapterDb._raw.prepare(sql);
  }
  get(...params) {
    this._raw.bind(params);
    const has = this._raw.step();
    const row = has ? this._raw.getAsObject() : undefined;
    this._raw.reset();
    return row;
  }
  all(...params) {
    this._raw.bind(params);
    const rows = [];
    while (this._raw.step()) rows.push(this._raw.getAsObject());
    this._raw.reset();
    return rows;
  }
  run(...params) {
    this._raw.bind(params);
    this._raw.step();
    this._raw.reset();
    const changes = this._adapterDb._raw.getRowsModified();
    const idRow = this._adapterDb._raw.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = idRow.length ? idRow[0].values[0][0] : 0;
    this._adapterDb._afterWrite();
    return { changes, lastInsertRowid };
  }
}

// Matches node:sqlite's DatabaseSync surface used in this codebase: constructor(path), .exec(sql),
// .prepare(sql), .close(). Persistence: sql.js is memory-only, so every write must be flushed back to
// `path` via db.export() + fs.writeFileSync. Flushing after EVERY statement would be correct but
// wasteful when a migration wraps many statements in one BEGIN..COMMIT — so this flushes on COMMIT
// (once per transaction) and immediately after any mutating statement issued OUTSIDE a transaction
// (autocommit mode), never after a ROLLBACK (nothing to persist) and never after a read-only call.
class DatabaseSync {
  constructor(path) {
    if (!SQL) throw new Error('db-sqljs-spike: ready() must be awaited once before the first `new DatabaseSync()` — see the header comment.');
    this._path = path;
    this._inTxn = false;
    this._raw = fs.existsSync(path) ? new SQL.Database(fs.readFileSync(path)) : new SQL.Database();
  }
  exec(sql) {
    const trimmed = sql.trim().toUpperCase();
    this._raw.exec(sql);
    if (trimmed === 'BEGIN' || trimmed.startsWith('BEGIN ')) { this._inTxn = true; return; }
    if (trimmed === 'ROLLBACK') { this._inTxn = false; return; } // in-memory state already reverted; nothing durable to flush
    if (trimmed === 'COMMIT') { this._inTxn = false; this._flush(); return; }
    // Any other statement (DDL, PRAGMA, a bare DML string) that runs OUTSIDE a transaction is
    // autocommit in real SQLite -> durable immediately. Inside a transaction, defer to its COMMIT.
    this._afterWrite();
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
  close() {
    this._flush();
    this._raw.close();
  }
  _afterWrite() {
    if (!this._inTxn) this._flush();
  }
  // Correct in principle — matches what a real implementation would try. In practice, THIS is the
  // call that invalidates every other already-prepared Statement (finding #2 above). Any db.js/
  // repo.js/server.js code path that flushes and then reuses a module-scope cached statement will
  // throw "Statement closed" here. Left in, not neutered, so this file honestly shows where the
  // adapter breaks rather than hiding it.
  _flush() {
    fs.writeFileSync(this._path, this._raw.export());
  }
}

module.exports = { DatabaseSync, ready };
