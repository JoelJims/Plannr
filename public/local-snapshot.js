// Phase 7 — full raw-database snapshot export/restore for the encrypted backup path (distinct from
// local-api.js's plain-JSON ledger export/import from Phase 5, which never touches schema state).
//
// Export: sqlite3_js_db_export() serializes the live kvvfs connection to a standard SQLite byte
// image — the browser equivalent of backup-db.js's `VACUUM INTO` (kvvfs has no filesystem path a
// VACUUM INTO could target, but sqlite3_js_db_export() produces the same kind of self-contained
// image; Phase 4b already confirmed this against a kvvfs connection). PRAGMA user_version is part of
// the standard SQLite file header, so export needs no special handling — it's captured automatically.
//
// Restore: kvvfs has no swappable file to overwrite, so a raw image can't just replace it directly.
// Deserialize the incoming bytes into a temporary :memory: connection, then recreate the live
// connection's schema and copy every row from there (the same technique Phase 4b validated for
// seeding a kvvfs database from an existing one). PRAGMA user_version is NOT part of sqlite_master or
// any table's rows, so this step must carry it over explicitly — the exact gap Phase 4b found: skip
// it and the restored database looks pre-migration, and init() silently re-runs its whole migration
// chain (or worse, one of the destructive presence-keyed migrations misfires) on the next boot.
// After copying, init() is called to bring an older-shaped snapshot up to the current schema, reusing
// its own tested, idempotent, version-gated chain rather than re-solving "what if this snapshot
// predates the current schema" here.
//
// Step 1.4 B17: the live database is read and written through db.js's async interface (dbAdapter()),
// the same one the capacitor-sqlite adapter answers in stage C. Only the platform parts stay on
// sqlite-wasm here: exporting the live image and opening the incoming one.

import { db, init, SCHEMA_VERSION, dbAdapter } from './db.js';
import { getSqlite3 } from './db-engine.js';

export function exportSnapshotBytes() {
  const sqlite3 = getSqlite3();
  return sqlite3.capi.sqlite3_js_db_export(db.nativeHandle());
}

export async function restoreSnapshotBytes(bytes) {
  const sqlite3 = getSqlite3();
  const tempDb = new sqlite3.oo1.DB(':memory:', 'c');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    tempDb.pointer, 'main', p, bytes.length, bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  );
  if (rc !== 0) { tempDb.close(); throw new Error(`restoreSnapshotBytes: not a valid SQLite image (deserialize rc=${rc}).`); }

  try {
    const userVersion = tempDb.selectValue('PRAGMA user_version');
    // Phase 2 (Step 2): a backup from a NEWER Plannr has a schema this version cannot read. Refuse
    // before anything is touched (init() would refuse it after the copy, leaving the app unusable).
    if (Number(userVersion) > SCHEMA_VERSION) {
      const err = new Error(`This backup was made by a newer version of Plannr (schema v${userVersion}; this version understands up to v${SCHEMA_VERSION}). Nothing was changed — update Plannr, then restore it.`);
      err.code = 'BACKUP_TOO_NEW';
      throw err;
    }
    const tableSchema = tempDb.selectObjects("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name <> 'sqlite_sequence'");
    const indexSchema = tempDb.selectObjects("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL");

    // The live database is written through the async interface (step 1.4 B17), in one transaction.
    // PRAGMA foreign_keys is a no-op inside a transaction — set it BEFORE it, restore AFTER (the same
    // trap db.js's own rebuilds guard against).
    const live = dbAdapter();
    await live.exec('PRAGMA foreign_keys = OFF');
    const fkOff = (await live.get('PRAGMA foreign_keys')).foreign_keys;
    if (fkOff !== 0) throw new Error(`restoreSnapshotBytes: foreign_keys still ${fkOff} after OFF — aborting to avoid a partial restore.`);

    try {
      await live.transaction(async (tx) => {
        // Drop every current table (any order — FKs are off) and rebuild from the snapshot's own
        // schema, which may differ from the live one (an older or newer Plannr install's shape).
        const liveTableNames = (await tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).map((r) => r.name);
        for (const t of liveTableNames) await tx.exec(`DROP TABLE IF EXISTS ${t}`);
        for (const t of tableSchema) await tx.exec(t.sql);
        for (const idx of indexSchema) await tx.exec(idx.sql);

        for (const t of tableSchema) {
          const rows = tempDb.selectObjects(`SELECT * FROM ${t.name}`);
          if (!rows.length) continue;
          const cols = Object.keys(rows[0]);
          const insert = `INSERT INTO ${t.name} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
          for (const r of rows) await tx.run(insert, cols.map((c) => r[c]));
        }

        // sqlite_sequence is excluded from the CREATE loop above (SQLite creates it implicitly on the
        // first AUTOINCREMENT insert and rejects an explicit CREATE) — but every row insert just above
        // ALSO auto-populated/incremented it as a side effect, tracking only what THIS restore inserted,
        // not the snapshot's true high-water marks. Clear that out and copy the snapshot's actual
        // sqlite_sequence rows fresh (a plain INSERT into it, unlike CREATE, is allowed) — otherwise a
        // table whose snapshot high-water mark was ahead of its row count (ids deleted after creation,
        // same case Phase 2's own tenant rebuilds guard against) would let a future insert REUSE an id.
        await tx.exec('DELETE FROM sqlite_sequence');
        const seqRows = tempDb.selectObjects('SELECT * FROM sqlite_sequence');
        for (const r of seqRows) await tx.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [r.name, r.seq]);

        // The carry-over this whole module exists to get right (see header comment).
        await tx.exec(`PRAGMA user_version = ${Number(userVersion) || 0}`);
      }); // COMMIT; anything thrown above rolls the whole restore back
    } finally {
      await live.exec('PRAGMA foreign_keys = ON');
    }

    // Outside the transaction above — init() manages its own transactions for whichever
    // migrations it decides to run, and SQLite does not support nesting a second BEGIN inside one.
    await init({ snapshot: false });

    const fkViol = await live.all('PRAGMA foreign_key_check');
    if (fkViol.length) throw new Error('restoreSnapshotBytes: foreign_key_check failed after restore: ' + JSON.stringify(fkViol));
  } finally {
    tempDb.close();
  }
}
