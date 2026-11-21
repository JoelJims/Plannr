// The node-sqlite database adapter (step 1.4 B1; docs/step-1.4-storage-plan.md §1.1 and §1.3).
//
// node:sqlite on a file path: the dev server and the tests now, the desktop app in Phase 4 (which
// only passes in the path). The interface is core/db-adapter.js; this file adds what only a file on
// disk can do:
//   - exportBytes(): VACUUM INTO a temporary file, read it, delete it (as server.js does today for
//     the encrypted backup).
//   - replaceWith(bytes): check the bytes are a sound SQLite database, write them beside the file and
//     force them to disk, close, rename over the old file in one step, reopen. The caller then runs
//     its own init() (db.js), as after any open.
//   - info(): the real size on disk (the file plus any -journal or -wal).
//
// Node only: it imports node:sqlite and node:fs, so it is not copied to public/.
// The three file operations are also exported on their own (step 1.4 D1): db.js keeps its own
// connection under Node and uses them for its adapter, so the dev server (and later the desktop app)
// can export, replace and measure its database file the same way.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSyncEngineAdapter, checkAdapter } from './core/db-adapter.js';
import { looksLikeSqlite } from './core/backup-crypto.js';

const SIDE_FILES = ['-journal', '-wal'];
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const sqlPath = (p) => p.split('\\').join('/').split("'").join("''"); // a SQL string literal

function openHandle(file, readOnly) {
  const h = new DatabaseSync(file, { readOnly: !!readOnly });
  if (!readOnly) h.exec('PRAGMA journal_mode = DELETE');
  h.exec('PRAGMA foreign_keys = ON');
  return h;
}

// Write bytes to `p` and force them to disk before returning.
function writeDurably(p, bytes) {
  const fd = fs.openSync(p, 'wx');
  try {
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Make a rename durable where the platform allows it (not on Windows, where a folder cannot be
// opened for fsync; NTFS records the rename in its own journal).
function fsyncFolder(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function integrityOk(file) {
  const h = new DatabaseSync(file, { readOnly: true });
  try { return h.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join('; '); } finally { h.close(); }
}

/** The whole database behind `handle` as SQLite file bytes: VACUUM INTO a temporary file, read it, delete it. */
export function exportFileBytes(handle) {
  const tmp = path.join(os.tmpdir(), `plannr-export-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    handle.exec(`VACUUM INTO '${sqlPath(tmp)}'`);
    return new Uint8Array(fs.readFileSync(tmp));
  } finally {
    for (const s of ['', ...SIDE_FILES]) { try { fs.unlinkSync(tmp + s); } catch { /* not there */ } }
  }
}

/**
 * Replace the database file `file` with `bytes`, all or nothing: check they are a SQLite database,
 * write them beside it and force them to disk, check their integrity, then call closeHandle() (the
 * caller closes its open handle on the file), rename over the old file in one step and make the
 * rename durable. On any error the old file stays as it was and the written copy is removed. Either
 * way the caller reopens `file` afterwards: the new database, or the old one if the rename never
 * happened.
 */
export function replaceDatabaseFile(file, bytes, closeHandle) {
  if (!(bytes instanceof Uint8Array) || !looksLikeSqlite(bytes)) {
    throw new Error('db (node-sqlite): replaceWith was given something that is not a SQLite database.');
  }
  const incoming = `${file}.incoming-${crypto.randomBytes(6).toString('hex')}`;
  writeDurably(incoming, bytes);
  try {
    const check = integrityOk(incoming);
    if (check !== 'ok') throw new Error(`db (node-sqlite): the new database failed its integrity check (${check}).`);
    closeHandle();
    const leftover = SIDE_FILES.map((s) => file + s).filter((p) => fs.existsSync(p));
    if (leftover.length) {
      throw new Error(`db (node-sqlite): ${leftover.map((p) => path.basename(p)).join(', ')} is still beside the database; it was not replaced.`);
    }
    fs.renameSync(incoming, file);
    fsyncFolder(path.dirname(path.resolve(file)));
  } catch (err) {
    try { fs.unlinkSync(incoming); } catch { /* already renamed or never written */ }
    throw err;
  }
}

/** The real size of the database file on disk: the file plus any -journal or -wal. */
export function databaseFileInfo(file) {
  return { engine: 'node-sqlite', path: path.resolve(file), sizeBytes: [file, ...SIDE_FILES.map((s) => file + s)].reduce((n, p) => n + sizeOf(p), 0) };
}

/**
 * Open `file` (a path, or ':memory:') with node:sqlite. Options: { readOnly }.
 * Never point this at data/plannr.db from a test.
 */
export function openNodeSqliteAdapter(file, { readOnly = false } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('openNodeSqliteAdapter: pass a file path or ":memory:".');
  const inMemory = file === ':memory:';
  let current = openHandle(file, readOnly);

  const platform = {
    engine: 'node-sqlite',
    handle: () => current,

    exportBytes() { return exportFileBytes(current); },

    replaceWith(bytes) {
      if (inMemory) throw new Error('db (node-sqlite): replaceWith needs a database file, not :memory:.');
      if (readOnly) throw new Error('db (node-sqlite): the database was opened read-only.');
      try {
        replaceDatabaseFile(file, bytes, () => { current.close(); current = null; });
      } finally {
        if (!current) current = openHandle(file, false); // the new file, or the old one if the rename never happened
      }
    },

    info() {
      if (inMemory) {
        const p = current.prepare('PRAGMA page_count').get().page_count * current.prepare('PRAGMA page_size').get().page_size;
        return { engine: 'node-sqlite', path: ':memory:', sizeBytes: p };
      }
      return databaseFileInfo(file);
    },

    close() {
      if (current) { current.close(); current = null; }
    },
  };

  return checkAdapter(createSyncEngineAdapter(platform));
}
