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
// An unfinished upgrade (step 1.4 B4): the snapshot taken before an upgrade is kept until that
// upgrade finishes. A failed upgrade can leave the database part-way, and each later start takes a
// snapshot of THAT; without this, three failed starts rotated the only copy from before the upgrade
// out. writePreMigrationSnapshot() records the first snapshot of an upgrade in PENDING_UPGRADE
// ({ snapshot, from, to, startedAt }); local-bootstrap.js calls finishUpgrade() once init() has
// completed. While the record names a snapshot that is there, no clean-up deletes it (it counts as
// one of the 3). If the record cannot be read, the clean-up deletes nothing.
//
// Compression (Phase 2, Step 5): snapshots are gzip-compressed (.json.gz / .db.gz) with the
// browser's built-in CompressionStream. Android Auto Backup copies this folder and skips the WHOLE
// backup if the app's data passes 25 MB; measured with storage full (≈13,400 entries) one JSON
// snapshot is 6.6 MB raw but 0.17 MB gzipped, a database snapshot 2.9 MB raw, 0.44 MB gzipped.
// Each compressed file is decompressed again in memory and compared before it is written.
// To read one on a computer: `gunzip plannr-pre-restore-....db.gz`.
//
// No static imports: the Capacitor plugins are loaded on demand, and every function that touches
// files takes an optional `fsApi` ({ Filesystem, Directory, Encoding }) so the rules can be tested in
// Node with an in-memory stand-in (test/safety-snapshots.test.js).
//
// In a plain browser (local-server.js test mode) there is no app data folder: the JSON snapshot
// falls back to a browser download, and the whole-database ones are skipped.

export const DIR = 'safety-snapshots';
export const KEEP_SNAPSHOTS = 3;
export const PENDING_UPGRADE = 'plannr-upgrade-pending.json';
// Matches compressed and (older, Step 2-4) uncompressed snapshots, so old ones are pruned too.
export const SNAPSHOT_NAME = /^plannr-(safety-snapshot|pre-restore|pre-migration)-.+\.(json|db)(\.gz)?$/;

async function isNative() {
  const { Capacitor } = await import('@capacitor/core');
  return Capacitor.isNativePlatform();
}
const loadFs = () => import('@capacitor/filesystem');

// Which existing files to delete so that `justWritten` plus the newest others make KEEP_SNAPSHOTS.
// `entries` are Filesystem.readdir() results ({ name, mtime }); files that are not Plannr snapshots
// are never touched. Newest first by modification time (then by name, which carries a timestamp).
// `pinned`: the snapshot an unfinished upgrade started from; never deleted, and it counts as one.
export function snapshotsToDelete(entries, justWritten, keep = KEEP_SNAPSHOTS, pinned = null) {
  const isPinned = !!pinned && pinned !== justWritten && entries.some((e) => e && e.name === pinned);
  const others = entries
    .filter((e) => e && e.type !== 'directory' && SNAPSHOT_NAME.test(e.name) && e.name !== justWritten && e.name !== pinned)
    .sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0) || (b.name < a.name ? -1 : b.name > a.name ? 1 : 0));
  return others.slice(Math.max(0, keep - 1 - (isPinned ? 1 : 0))).map((e) => e.name);
}

// The snapshot an unfinished upgrade started from (a name in `names`), or null if there is none.
// Throws if a record is there but cannot be read: the caller then deletes nothing.
async function pinnedSnapshot(names, { Filesystem, Directory, Encoding }) {
  if (!names.has(PENDING_UPGRADE)) return null;
  const { data } = await Filesystem.readFile({ path: `${DIR}/${PENDING_UPGRADE}`, directory: Directory.Data, encoding: Encoding.UTF8 });
  const p = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
  if (!p || typeof p.snapshot !== 'string' || !SNAPSHOT_NAME.test(p.snapshot)) throw new Error(`${PENDING_UPGRADE} names no snapshot`);
  return names.has(p.snapshot) ? p.snapshot : null;
}

export async function pruneSnapshots(justWritten, fsApi, keep = KEEP_SNAPSHOTS) {
  const { Filesystem, Directory, Encoding } = fsApi || await loadFs();
  const deleted = [];
  try {
    const { files } = await Filesystem.readdir({ path: DIR, directory: Directory.Data });
    const names = new Set(files.map((f) => f.name));
    if (!names.has(justWritten)) throw new Error(`the new snapshot ${justWritten} is not in ${DIR}/; nothing deleted`);
    const pinned = await pinnedSnapshot(names, { Filesystem, Directory, Encoding });
    for (const name of snapshotsToDelete(files, justWritten, keep, pinned)) {
      await Filesystem.deleteFile({ path: `${DIR}/${name}`, directory: Directory.Data });
      deleted.push(name);
    }
  } catch (e) {
    console.warn('[safety-snapshots] could not remove old snapshots (the new one is safe):', e);
  }
  return deleted;
}

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
export const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Compress `bytes`, check the compressed copy decompresses back to exactly `bytes`, write it as
// `<filename>.gz`, confirm with stat that it landed in full, then remove snapshots beyond the
// newest KEEP_SNAPSHOTS. Returns the path written.
export async function saveSnapshot(filename, bytes, fsApi) {
  const { Filesystem, Directory, Encoding } = fsApi || await loadFs();
  const packed = await gzip(bytes);
  if (!sameBytes(await gunzip(packed), bytes)) throw new Error('safety snapshot compression check failed');
  const name = `${filename}.gz`;
  const path = `${DIR}/${name}`;
  await Filesystem.writeFile({ path, data: bytesToBase64(packed), directory: Directory.Data, recursive: true });
  const info = await Filesystem.stat({ path, directory: Directory.Data });
  if (!info || typeof info.size !== 'number' || info.size < packed.length) {
    throw new Error(`safety snapshot not verified after writing (stat: ${JSON.stringify(info)})`);
  }
  await pruneSnapshots(name, { Filesystem, Directory, Encoding });
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
  const path = await saveSnapshot(filename, new TextEncoder().encode(JSON.stringify(obj)));
  return `a file inside the app (${path})`;
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// A whole-database copy (a standard SQLite file, unencrypted, gzipped, in the app's private folder).
async function writeDatabaseSnapshot(filename, fsApi) {
  const { exportSnapshotBytes } = await import('./local-snapshot.js');
  const bytes = exportSnapshotBytes();
  if (!bytes || !bytes.length) throw new Error('the database export for the safety snapshot was empty');
  return saveSnapshot(filename, bytes, fsApi);
}

// Before an encrypted restore replaces everything. Returns a description, or null in a plain browser.
export async function writePreRestoreSnapshot() {
  if (!(await isNative())) {
    console.warn('[safety-snapshots] not inside the app: no pre-restore snapshot written.');
    return null;
  }
  return `a file inside the app (${await writeDatabaseSnapshot(`plannr-pre-restore-${stampNow()}.db`)})`;
}

// Before a schema upgrade at start-up (local-bootstrap.js). `plan` is db.js's planMigrations() answer.
// Returns the path written, or null in a plain browser.
export async function writePreMigrationSnapshot(plan) {
  if (!(await isNative())) {
    console.warn(`[safety-snapshots] not inside the app: no pre-upgrade snapshot written (schema v${plan.from} -> v${plan.to}).`);
    return null;
  }
  const filename = `plannr-pre-migration-v${plan.from}-to-v${plan.to}-${stampNow()}.db`;
  return savePreMigrationSnapshot(filename, plan, (fsApi) => writeDatabaseSnapshot(filename, fsApi), await loadFs());
}

// The steps of writePreMigrationSnapshot() after the native check, testable in Node: `write(fsApi)`
// saves the snapshot (saveSnapshot); then, if no unfinished upgrade is recorded, this one is.
export async function savePreMigrationSnapshot(filename, plan, write, fsApi) {
  const { Filesystem, Directory, Encoding } = fsApi;
  const path = await write(fsApi);
  const { files } = await Filesystem.readdir({ path: DIR, directory: Directory.Data });
  const names = new Set(files.map((f) => f.name));
  let pinned;
  try { pinned = await pinnedSnapshot(names, fsApi); } catch { pinned = undefined; }
  if (pinned === null) {
    await Filesystem.writeFile({ path: `${DIR}/${PENDING_UPGRADE}`, directory: Directory.Data, encoding: Encoding.UTF8,
      data: JSON.stringify({ snapshot: `${filename}.gz`, from: plan.from, to: plan.to, startedAt: new Date().toISOString() }) });
    console.log(`[safety-snapshots] snapshot before upgrading schema v${plan.from} -> v${plan.to}: ${path}`);
  } else if (pinned) {
    console.log(`[safety-snapshots] snapshot before retrying the upgrade v${plan.from} -> v${plan.to}: ${path}; the one from before the first try is kept: ${DIR}/${pinned}`);
  }
  return path;
}

// init() completed: the snapshot from before the upgrade goes back into the normal rotation. Never
// fails the start (a record left behind only keeps one extra snapshot until the next upgrade).
export async function finishUpgrade(fsApi) {
  try {
    const { Filesystem, Directory } = fsApi || await loadFs();
    const { files } = await Filesystem.readdir({ path: DIR, directory: Directory.Data });
    if (files.some((f) => f.name === PENDING_UPGRADE)) await Filesystem.deleteFile({ path: `${DIR}/${PENDING_UPGRADE}`, directory: Directory.Data });
  } catch (e) {
    console.warn('[safety-snapshots] could not clear the upgrade record:', e);
  }
}
