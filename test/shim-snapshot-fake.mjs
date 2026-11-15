// Stand-in for public/local-snapshot.js in the phone-code test pass (test/shim-target.js redirects
// every import of it here). In the app, the whole-database copy behind an encrypted backup comes from
// sqlite-wasm (sqlite3_js_db_export), which Node does not have. Here the phone code shares the
// node:sqlite database, so the copy is made with VACUUM INTO, the way server.js makes its own.
// Everything around it (passphrase checks, the phone's own encryption in public/backup-crypto.js)
// is the real phone code. Restoring stays covered by test-ui/backup-roundtrip.js in a real browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db.js';

export function exportSnapshotBytes() {
  const tmp = path.join(os.tmpdir(), `plannr-shim-snapshot-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    return new Uint8Array(fs.readFileSync(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export async function restoreSnapshotBytes() {
  throw new Error('restoring an encrypted backup is not available in the phone-code test pass (see test-ui/backup-roundtrip.js)');
}
