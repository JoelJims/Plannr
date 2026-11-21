// The wasm-kvvfs database adapter (step 1.4 B2; docs/step-1.4-storage-plan.md §1.1 and §1.4).
//
// sqlite-wasm with its kvvfs storage: the database lives in localStorage, one record per page. This
// is where the phone keeps its data today, and what the browser preview and the UI suites run on.
// It is kept after the move (stage C) for the way back. The interface is core/db-adapter.js; this
// file adds what kvvfs can do:
//   - exportBytes(): sqlite3_js_db_export, a standard SQLite file image.
//   - replaceWith(bytes): kvvfs has no file to swap, so the new image is opened in memory, checked
//     (SQLite header, integrity_check, foreign_key_check), and then copied over the live database
//     in ONE transaction: every table with its rows, the AUTOINCREMENT sequences, user_version, then
//     indexes, triggers and views. If anything fails, the transaction rolls back and the live data is
//     unchanged. The caller then runs its own init() (db.js), as after any open.
//   - info(): the database's size (page_count x page_size).
//
// Not used by the app yet: db.js still opens its own handle until stage B5. Never call replaceWith
// on the phone's real database outside the tested restore and move paths.

import { createSyncEngineAdapter, checkAdapter } from './core/db-adapter.js';
import { looksLikeSqlite } from './core/backup-crypto.js';
import { ready, getSqlite3, DatabaseSync } from './db-engine.js';

const KVVFS_PATH = 'kvvfs:local'; // db-engine.js uses the one persistent kvvfs slot, 'local'

function openHandle() {
  const h = new DatabaseSync('plannr');
  h.exec('PRAGMA journal_mode = DELETE');
  h.exec('PRAGMA foreign_keys = ON');
  return h;
}

const q = (name) => '"' + String(name).split('"').join('""') + '"';

// The incoming image as a separate in-memory database, checked before the live data is touched.
function openImage(sqlite3, bytes) {
  const img = new sqlite3.oo1.DB(':memory:', 'c');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(img.pointer, 'main', p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
  if (rc !== 0) { img.close(); throw new Error(`db (wasm-kvvfs): replaceWith was given something that is not a SQLite database (rc=${rc}).`); }
  try {
    const check = img.selectValues('PRAGMA integrity_check').join('; ');
    if (check !== 'ok') throw new Error(`db (wasm-kvvfs): the new database failed its integrity check (${check}).`);
    const fk = img.selectArrays('PRAGMA foreign_key_check');
    if (fk.length) throw new Error(`db (wasm-kvvfs): the new database has ${fk.length} broken foreign key reference(s).`);
  } catch (err) {
    img.close();
    throw err;
  }
  return img;
}

function copyInto(live, img) {
  const objects = (type) => img.selectObjects(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = '${type}' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`);
  const tables = objects('table');
  const userVersion = Number(img.selectValue('PRAGMA user_version')) || 0;
  const hasSequence = img.selectValue("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_sequence'") > 0;

  // PRAGMA foreign_keys does nothing inside a transaction: turn it off first, and prove it.
  live.exec('PRAGMA foreign_keys = OFF');
  try {
    if (live.prepare('PRAGMA foreign_keys').get().foreign_keys !== 0) throw new Error('db (wasm-kvvfs): foreign_keys did not turn off; nothing was replaced.');
    live.exec('BEGIN');
    try {
      const liveObjects = (type) => live.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
      for (const v of liveObjects('view')) live.exec(`DROP VIEW IF EXISTS ${q(v)}`);
      for (const t of liveObjects('table')) live.exec(`DROP TABLE IF EXISTS ${q(t)}`); // its indexes and triggers go with it
      for (const t of tables) live.exec(t.sql);
      for (const t of tables) {
        const cols = img.selectValues(`SELECT name FROM pragma_table_info(${"'" + t.name.split("'").join("''") + "'"})`);
        const insert = live.prepare(`INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const row of img.selectArrays(`SELECT ${cols.map(q).join(', ')} FROM ${q(t.name)}`)) insert.run(...row);
      }
      // The rows above moved the sequences on; put back the image's own high-water marks.
      if (hasSequence) {
        live.exec('DELETE FROM sqlite_sequence');
        const seq = live.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
        for (const [name, s] of img.selectArrays('SELECT name, seq FROM sqlite_sequence')) seq.run(name, s);
      }
      for (const type of ['index', 'trigger', 'view']) for (const o of objects(type)) live.exec(o.sql);
      live.exec(`PRAGMA user_version = ${userVersion}`);
      live.exec('COMMIT');
    } catch (err) {
      try { live.exec('ROLLBACK'); } catch (e) { if (!/no transaction is active/i.test(String(e && e.message))) err.rollbackError = e; }
      throw err;
    }
  } finally {
    live.exec('PRAGMA foreign_keys = ON');
  }
}

/** Open the kvvfs database (the one 'local' slot). */
export async function openKvvfsAdapter() {
  await ready();
  const sqlite3 = getSqlite3();
  let current = openHandle();

  const platform = {
    engine: 'wasm-kvvfs',
    handle: () => current,
    exportBytes() {
      return sqlite3.capi.sqlite3_js_db_export(current.nativeHandle());
    },
    replaceWith(bytes) {
      if (!(bytes instanceof Uint8Array) || !looksLikeSqlite(bytes)) {
        throw new Error('db (wasm-kvvfs): replaceWith was given something that is not a SQLite database.');
      }
      const img = openImage(sqlite3, bytes);
      try { copyInto(current, img); } finally { img.close(); }
    },
    info() {
      // The table-valued forms: the plain PRAGMA's result column is not named alike on every build.
      const { n } = current.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get();
      return { engine: 'wasm-kvvfs', path: KVVFS_PATH, sizeBytes: Number(n) };
    },
    close() {
      if (current) { current.close(); current = null; }
    },
  };
  return checkAdapter(createSyncEngineAdapter(platform));
}
