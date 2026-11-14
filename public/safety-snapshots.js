// Phone-only safety snapshots: copies of the user's data written into the app's private data folder
// (Capacitor Directory.Data, folder safety-snapshots/) BEFORE anything risky changes the database:
//   · writeJsonSnapshot()       before a JSON backup is restored (a full backup-format.js export),
//   · writePreMigrationSnapshot() before a schema upgrade runs at start-up (a whole-database copy).
// Each file is checked with Filesystem.stat() after writing; if the write or the check fails, the
// caller stops and the database is left untouched.
//
// The desktop server writes its own snapshots beside the database file (server.js for imports,
// db.js's init() for upgrades). In a plain browser (local-server.js test mode) there is no app data
// folder: the JSON snapshot falls back to a browser download, the pre-migration one is skipped.

const DIR = 'safety-snapshots';

async function isNative() {
  const { Capacitor } = await import('@capacitor/core');
  return Capacitor.isNativePlatform();
}

// Write `data` (a UTF-8 string, or base64 when `base64` is true) and confirm it landed in full.
async function writeVerified(filename, data, { base64 = false, expectedBytes }) {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const path = `${DIR}/${filename}`;
  const opts = { path, data, directory: Directory.Data, recursive: true };
  if (!base64) opts.encoding = Encoding.UTF8;
  await Filesystem.writeFile(opts);
  const info = await Filesystem.stat({ path, directory: Directory.Data });
  if (!info || typeof info.size !== 'number' || info.size < expectedBytes) {
    throw new Error(`safety snapshot not verified after writing (stat: ${JSON.stringify(info)})`);
  }
  return path;
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

// Before a JSON restore. Returns a description of where the copy went (shown to the user).
export async function writeJsonSnapshot(obj) {
  const filename = `plannr-safety-snapshot-${stampNow()}.json`;
  if (!(await isNative())) {
    downloadJson(filename, obj);
    return `a downloaded file (${filename})`;
  }
  const data = JSON.stringify(obj);
  const path = await writeVerified(filename, data, { expectedBytes: data.length });
  return `a file inside the app (${path})`;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Before a schema upgrade at start-up (local-bootstrap.js). `plan` is db.js's migrationPlan().
// The copy is a standard SQLite file (the same bytes an encrypted backup holds, unencrypted, inside
// the app's private folder). Returns the path written, or null in a plain browser.
export async function writePreMigrationSnapshot(plan) {
  if (!(await isNative())) {
    console.warn(`[safety-snapshots] not inside the app: no pre-upgrade snapshot written (schema v${plan.from} -> v${plan.to}).`);
    return null;
  }
  const { exportSnapshotBytes } = await import('./local-snapshot.js');
  const bytes = exportSnapshotBytes();
  if (!bytes || !bytes.length) throw new Error('the database export for the safety snapshot was empty');
  const filename = `plannr-pre-migration-v${plan.from}-to-v${plan.to}-${stampNow()}.db`;
  const path = await writeVerified(filename, bytesToBase64(bytes), { base64: true, expectedBytes: bytes.length });
  console.log(`[safety-snapshots] snapshot before upgrading schema v${plan.from} -> v${plan.to}: ${path}`);
  return path;
}
