// The capacitor-sqlite database adapter (step 1.4 C3; docs/step-1.4-storage-plan.md §1.2).
//
// The phone's database as a real SQLite file, /data/data/com.plannr.app/databases/plannrSQLite.db,
// through @capacitor-community/sqlite 8.1.1 (the plugin), with Plannr's own PlannrStorage helper
// (android/.../PlannrStoragePlugin.java, C2) for what the plugin cannot do: free space, file sizes,
// and a write that is forced to disk before it answers.
//
// How the plugin is used (the C1 spike, plan §8):
//   - run() for a statement without rows, query() for one with rows (returnsRows, core/db-adapter.js);
//     an exec() script is split here, one statement per call. The plugin's own execute() and
//     executeSet() are never used: execute() rewrites SQL inside string literals.
//   - transaction: false on every call; BEGIN/COMMIT/ROLLBACK are ours (createAsyncEngineAdapter).
//   - The plugin reports `changes` as the change in total_changes(), so a DELETE that cascades to
//     3 children says 4. When it says more than 1, `SELECT changes()` gives the real count, as
//     node:sqlite reports it.
//   - Only null, numbers and strings travel to the plugin (it gets JSON); anything else is refused
//     here with a clear message rather than stored as something else.
//   - Each page of the app is a new page load, but the plugin's connections live on in Java. Opening
//     therefore closes a connection a previous page left open first: if that page was in the middle
//     of a transaction, closing the database rolls it back, so it never leaks into this page.
//
// exportBytes(): VACUUM INTO a file in the app's cache folder, read it, delete it.
// replaceWith(bytes): write the new image next to the database (forced to disk), open it read-only
// and check it (integrity_check, foreign_key_check), close the database, rename the new file over it
// (one atomic step), reopen. If any check fails, the new file is deleted and nothing changed.
// info(): the file's real size on disk (plus its -journal while a write is in progress), and the
// phone's free space.

import { createAsyncEngineAdapter, checkAdapter } from './core/db-adapter.js';
import { looksLikeSqlite } from './core/backup-crypto.js';

export const ENGINE = 'capacitor-sqlite';
export const DB_NAME = 'plannr'; // the plugin adds "SQLite.db": databases/plannrSQLite.db
const SUFFIX = 'SQLite.db';

const NO_ROW_TYPES = new Set(['number', 'string']);
function wireValues(params) {
  return params.map((v, i) => {
    if (v === null || (NO_ROW_TYPES.has(typeof v) && (typeof v !== 'number' || Number.isFinite(v)))) return v;
    const what = v === undefined ? 'undefined' : (v instanceof Uint8Array ? 'binary data' : typeof v);
    throw new TypeError(`db (${ENGINE}): parameter ${i + 1} is ${what}; only null, numbers and strings can be stored.`);
  });
}

// The plugin's errors read "Run: ...: <SQLite's message> (code 2067 SQLITE_CONSTRAINT_UNIQUE)".
// Keep the message, and give the error SQLite's result code as `errcode`, like node:sqlite does.
function sqlError(e, sql) {
  const msg = String((e && e.message) || e);
  const err = new Error(msg);
  const m = /\(code (\d+)/.exec(msg);
  if (m) err.errcode = Number(m[1]);
  err.sql = sql;
  return err;
}

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const plainPath = (p) => String(p).replace(/^file:\/\//, '');
const quoteLiteral = (s) => "'" + String(s).split("'").join("''") + "'";

/**
 * Open the phone's database file.
 *   sqlite   the plugin (Capacitor.Plugins.CapacitorSQLite)
 *   storage  Plannr's helper (Capacitor.Plugins.PlannrStorage)
 *   name     the database name (default 'plannr'); the file is <databases>/<name>SQLite.db
 */
export async function openCapacitorAdapter({ sqlite, storage, name = DB_NAME } = {}) {
  if (!sqlite || !storage) throw new Error(`db (${ENGINE}): the SQLite plugin and PlannrStorage are both needed.`);
  const dirs = await storage.info();
  const mainFile = `${plainPath(dirs.databasesDir)}/${name}${SUFFIX}`;
  const incomingName = `${name}-incoming`;
  const incomingFile = `${plainPath(dirs.databasesDir)}/${incomingName}${SUFFIX}`;

  const connect = async (database, readonly) => {
    // The plugin keeps connections across page loads, so the last page's connection may still be
    // here, even inside a transaction that page began. On Android that BEGIN holds an EXCLUSIVE lock,
    // and closing the connection does not end it (the next open fails "database is locked"; the
    // emulator showed this in C3). So end it first: a ROLLBACK, as SQLite does after a crash. An
    // error means there was no connection or no transaction.
    try { await sqlite.run({ database, statement: 'ROLLBACK', values: [], transaction: false, readonly }); } catch { /* none */ }
    try { await sqlite.closeConnection({ database, readonly }); } catch { /* none was open */ }
    await sqlite.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly });
    await sqlite.open({ database, readonly });
  };
  const disconnect = async (database, readonly) => {
    try { await sqlite.close({ database, readonly }); } finally { await sqlite.closeConnection({ database, readonly }); }
  };
  const queryOn = async (database, readonly, sql, params) => {
    try {
      const r = await sqlite.query({ database, statement: sql, values: wireValues(params), readonly });
      return (r && r.values) || [];
    } catch (e) { throw sqlError(e, sql); }
  };
  const query = (sql, params) => queryOn(name, false, sql, params);
  const write = async (sql, params) => {
    let r;
    try {
      r = await sqlite.run({ database: name, statement: sql, values: wireValues(params), transaction: false, readonly: false, returnMode: 'no' });
    } catch (e) { throw sqlError(e, sql); }
    const c = (r && r.changes) || {};
    let changes = Number(c.changes) || 0;
    if (changes > 1) changes = Number((await query('SELECT changes() AS n', []))[0].n);
    return { changes, lastInsertRowid: Number(c.lastId) || 0 };
  };
  const setUp = async () => {
    await query('PRAGMA journal_mode = DELETE', []);
    await write('PRAGMA foreign_keys = ON', []);
  };

  await connect(name, false);
  await setUp();

  const platform = {
    engine: ENGINE,
    query,
    write,

    async exportBytes() {
      const file = `${plainPath(dirs.cacheDir)}/plannr-export-${Date.now()}.db`;
      await storage.remove({ path: file });
      try {
        await write(`VACUUM INTO ${quoteLiteral(file)}`, []);
        const { data } = await storage.readFile({ path: file });
        return fromBase64(data);
      } finally {
        await storage.remove({ path: file });
      }
    },

    async replaceWith(bytes) {
      if (!(bytes instanceof Uint8Array) || !looksLikeSqlite(bytes)) {
        throw new Error(`db (${ENGINE}): replaceWith was given something that is not a SQLite database.`);
      }
      let image = bytes;
      if (image[18] === 2 || image[19] === 2) { image = image.slice(); image[18] = 1; image[19] = 1; } // WAL-stamped: open it in rollback mode
      await storage.remove({ path: incomingFile });
      await storage.remove({ path: incomingFile + '-journal' });
      try {
        await storage.writeFile({ path: incomingFile, data: toBase64(image) });
        // Check the new file on its own read-only connection before the database is touched.
        try {
          await connect(incomingName, true);
        } catch (e) {
          throw new Error(`db (${ENGINE}): replaceWith was given something that is not a SQLite database (${sqlError(e).message}).`);
        }
        try {
          const check = (await queryOn(incomingName, true, 'PRAGMA integrity_check', [])).map((r) => Object.values(r)[0]).join('; ');
          if (check !== 'ok') throw new Error(`db (${ENGINE}): the new database failed its integrity check (${check}).`);
          const fk = await queryOn(incomingName, true, 'PRAGMA foreign_key_check', []);
          if (fk.length) throw new Error(`db (${ENGINE}): the new database has ${fk.length} broken foreign key reference(s).`);
        } catch (e) {
          throw /^db \(/.test(e.message) ? e : new Error(`db (${ENGINE}): the new database failed its integrity check (${e.message}).`);
        } finally {
          await disconnect(incomingName, true);
        }
        // Swap: close, rename over (one atomic step, the folder forced to disk), reopen.
        await disconnect(name, false);
        try {
          const sizes = await storage.sizes({ paths: [mainFile + '-journal'] });
          if (Number(sizes[mainFile + '-journal']) >= 0) throw new Error(`db (${ENGINE}): the database still has a journal after closing; nothing was replaced.`);
          await storage.rename({ from: incomingFile, to: mainFile });
        } finally {
          await connect(name, false);
          await setUp();
        }
      } finally {
        await storage.remove({ path: incomingFile });
      }
    },

    async info() {
      const [sizes, space] = await Promise.all([
        storage.sizes({ paths: [mainFile, mainFile + '-journal'] }),
        storage.info(),
      ]);
      const main = Math.max(0, Number(sizes[mainFile]) || 0);
      const journal = Math.max(0, Number(sizes[mainFile + '-journal']) || 0);
      return { engine: ENGINE, path: mainFile, sizeBytes: main + journal, freeBytes: Number(space.freeBytes) };
    },

    async close() { await disconnect(name, false); },
  };
  return checkAdapter(createAsyncEngineAdapter(platform));
}

/** The two native plugins, if this build has them (the app with the plugin, on a phone). */
export function nativePlugins(Capacitor) {
  const p = Capacitor && Capacitor.Plugins;
  const sqlite = p && p.CapacitorSQLite;
  const storage = p && p.PlannrStorage;
  return sqlite && storage && Capacitor.isPluginAvailable('CapacitorSQLite') && Capacitor.isPluginAvailable('PlannrStorage')
    ? { sqlite, storage } : null;
}
