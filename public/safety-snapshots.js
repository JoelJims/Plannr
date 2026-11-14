// Phone-only safety snapshots: copies of the user's data written into the app's private data folder
// (Capacitor Directory.Data, folder safety-snapshots/) BEFORE anything risky changes the database:
//   · writeJsonSnapshot()         before a JSON backup is restored (a full backup-format.js export),
//   · writePreRestoreSnapshot()   before an encrypted backup is restored (a whole-database copy),
//   · writePreMigrationSnapshot() before a schema upgrade runs at start-up (a whole-database copy).
// Each file is checked with Filesystem.stat() after writing; if the write or the check fails, the
// caller stops and the database is left untouched.
//
// Retention (Phase 2, Step 4): only the newest KEEP_SNAPSHOTS (3) are kept. Older ones are deleted
// only AFTER the new one is written and checked, and the one just written is never deleted. A failed
// clean-up never fails the operation (the new snapshot is safe; old ones simply stay a while longer).
// The desktop applies the same rule to its own pre-upgrade copies (db.js writeNodeSnapshot()).
//
// No static imports: the Capacitor plugins are loaded on demand, and every function that touches
// files takes an optional `fsApi` ({ Filesystem, Directory, Encoding }) so the rules can be tested in
// Node with an in-memory stand-in (test/safety-snapshots.test.js).
//
// In a plain browser (local-server.js test mode) there is no app data folder: the JSON snapshot
// falls back to a browser download, and the whole-database ones are skipped.

export const DIR = 'safety-snapshots';
export const KEEP_SNAPSHOTS = 3;
export const SNAPSHOT_NAME = /^plannr-(safety-snapshot|pre-restore|pre-migration)-.+\.(json|db)$/;

async function isNative() {
  const { Capacitor } = await import('@capacitor/core');
  return Capacitor.isNativePlatform();
}
const loadFs = () => import('@capacitor/filesystem');

// Which existing files to delete so that `justWritten` plus the newest others make KEEP_SNAPSHOTS.
// `entries` are Filesystem.readdir() results ({ name, mtime }); files that are not Plannr snapshots
// are never touched. Newest first by modification time (then by name, which carries a timestamp).
export function snapshotsToDelete(entries, justWritten, keep = KEEP_SNAPSHOTS) {
  const others = entries
    .filter((e) => e && e.type !== 'directory' && SNAPSHOT_NAME.test(e.name) && e.name !== justWritten)
    .sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0) || (b.name < a.name ? -1 : b.name > a.name ? 1 : 0));
  return others.slice(Math.max(0, keep - 1)).map((e) => e.name);
}

export async function pruneSnapshots(justWritten, fsApi, keep = KEEP_SNAPSHOTS) {
  const { Filesystem, Directory } = fsApi || await loadFs();
  const deleted = [];
  try {
    const { files } = await Filesystem.readdir({ path: DIR, directory: Directory.Data });
    const names = new Set(files.map((f) => f.name));
    if (!names.has(justWritten)) throw new Error(`the new snapshot ${justWritten} is not in ${DIR}/; nothing deleted`);
    for (const name of snapshotsToDelete(files, justWritten, keep)) {
      await Filesystem.deleteFile({ path: `${DIR}/${name}`, directory: Directory.Data });
      deleted.push(name);
    }
  } catch (e) {
    console.warn('[safety-snapshots] could not remove old snapshots (the new one is safe):', e);
  }
  return deleted;
}

// Write `data` (a UTF-8 string, or base64 when `base64` is true), confirm it landed in full, then
// remove snapshots beyond the newest KEEP_SNAPSHOTS. Returns the path written.
export async function saveSnapshot(filename, data, { base64 = false, expectedBytes }, fsApi) {
  const { Filesystem, Directory, Encoding } = fsApi || await loadFs();
  const path = `${DIR}/${filename}`;
  const opts = { path, data, directory: Directory.Data, recursive: true };
  if (!base64) opts.encoding = Encoding.UTF8;
  await Filesystem.writeFile(opts);
  const info = await Filesystem.stat({ path, directory: Directory.Data });
  if (!info || typeof info.size !== 'number' || info.size < expectedBytes) {
    throw new Error(`safety snapshot not verified after writing (stat: ${JSON.stringify(info)})`);
  }
  await pruneSnapshots(filename, { Filesystem, Directory, Encoding });
  return path;
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

// Before a JSON restore. Returns a description of where the copy went (shown to the user).
export async function writeJsonSnapshot(obj) {
  const filename = `plannr-safety-snapshot-${stampNow()}.json`;
  if (!(await isNative())) {
    downloadJson(filename, obj);
    return `a downloaded file (${filename})`;
  }
  const data = JSON.stringify(obj);
  const path = await saveSnapshot(filename, data, { expectedBytes: data.length });
  return `a file inside the app (${path})`;
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// A whole-database copy (a standard SQLite file, unencrypted, inside the app's private folder).
async function writeDatabaseSnapshot(filename) {
  const { exportSnapshotBytes } = await import('./local-snapshot.js');
  const bytes = exportSnapshotBytes();
  if (!bytes || !bytes.length) throw new Error('the database export for the safety snapshot was empty');
  return saveSnapshot(filename, bytesToBase64(bytes), { base64: true, expectedBytes: bytes.length });
}

// Before an encrypted restore replaces everything. Returns a description, or null in a plain browser.
export async function writePreRestoreSnapshot() {
  if (!(await isNative())) {
    console.warn('[safety-snapshots] not inside the app: no pre-restore snapshot written.');
    return null;
  }
  return `a file inside the app (${await writeDatabaseSnapshot(`plannr-pre-restore-${stampNow()}.db`)})`;
}

// Before a schema upgrade at start-up (local-bootstrap.js). `plan` is db.js's migrationPlan().
// Returns the path written, or null in a plain browser.
export async function writePreMigrationSnapshot(plan) {
  if (!(await isNative())) {
    console.warn(`[safety-snapshots] not inside the app: no pre-upgrade snapshot written (schema v${plan.from} -> v${plan.to}).`);
    return null;
  }
  const path = await writeDatabaseSnapshot(`plannr-pre-migration-v${plan.from}-to-v${plan.to}-${stampNow()}.db`);
  console.log(`[safety-snapshots] snapshot before upgrading schema v${plan.from} -> v${plan.to}: ${path}`);
  return path;
}
