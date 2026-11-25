// The one-time move of the phone's database from localStorage to a file (step 1.4 C5;
// docs/step-1.4-storage-plan.md §2).
//
// This file holds the rules, not the platform: every file, plugin and storage key is reached through
// `host` (below), so the same code runs on the phone (public/storage-native.js builds the host) and in
// Node, where two node-sqlite files stand in for localStorage and the phone's file (test/storage-move.test.js).
//
// The steps (plan §2.1). Until step 6, the localStorage copy is the only real copy; the move never
// writes to it.
//   0 space check     free space >= 3 x the database size + 20 MB, or nothing starts
//   1 backup          an encrypted backup, saved by you (host.backup(): the page's own flow)
//   2 snapshot        a gzipped copy in safety-snapshots/, checked (host.snapshot())
//   3 write           the exported bytes, byte for byte, to the candidate file, forced to disk
//   4 check           storage-check.js on both copies; any difference deletes the candidate
//   5 place           the candidate is renamed to the database file (one atomic step)
//   6 switch          the marker file says native-v1 (forced to disk); the localStorage key repeats it
//
// The progress record (localStorage `plannr-storage-move`) is only a hint: which steps finished and
// the SHA-256 of the exported database at step 1. "Continue" after an interruption skips steps 1-2 only
// if the database's SHA-256 is still the same (the backup and the snapshot are still current), and
// always redoes 3-6, checking every fact again.
//
// The startup table (plan §2.2) is decideAtStartup(): which copy to use, from the marker and the files.

import { fingerprint, compareFingerprints, summarize } from './storage-check.js';

export const MARKER_NATIVE = 'native-v1';
export const MARKER_LOCAL = 'localstorage-v1';
export const MB = 1024 * 1024;
export const MARGIN_BYTES = 20 * MB;
export const STEPS = ['space', 'backup', 'snapshot', 'write', 'check', 'place', 'switch'];

/** Free space the move needs for a database of `bytes`: the new file, its journal during the checks,
 *  the snapshot and the temporary backup file, plus a margin (plan §2.5). */
export const requiredFreeBytes = (bytes) => 3 * Math.max(0, Number(bytes) || 0) + MARGIN_BYTES;

// Never understate what is needed, never overstate what is free.
const needText = (bytes) => `${Math.max(1, Math.ceil(bytes / MB))} MB`;
const freeText = (bytes) => `${Math.max(0, Math.floor(bytes / MB))} MB`;

export class MoveError extends Error {
  constructor(step, message, details) {
    super(message);
    this.step = step;
    if (details !== undefined) this.details = details;
  }
}

/** The message when there is not enough space (plan §2.5). */
export function spaceMessage(needBytes, freeBytes) {
  return `Plannr needs about ${needText(needBytes)} free to move your data. Your phone has ${freeText(freeBytes)} free. Free some space, then try again.`;
}

/** A write that failed because the disk is full (Node's ENOSPC, SQLite's SQLITE_FULL, Android's message). */
export function isDiskFull(err) {
  if (!err) return false;
  const code = err.errcode ?? err.resultCode;
  if (err.code === 'ENOSPC' || (typeof code === 'number' && (code & 0xff) === 13)) return true;
  return /ENOSPC|no space left on device|database or disk is full|SQLITE_FULL/i.test(String(err.message || err));
}

// A full disk during a step: the same message as the check before the move, with the space free now.
async function spaceError(host, step, need, err) {
  let free = NaN;
  try { free = Number(await host.freeBytes()); } catch { /* unknown */ }
  return new MoveError(step, spaceMessage(need, Number.isFinite(free) ? free : 0), { needBytes: need, freeBytes: free, cause: err });
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readProgress(host) {
  try { const p = await host.progress.read(); return p && typeof p === 'object' ? p : null; } catch { return null; }
}
async function writeProgress(host, p) {
  try { await host.progress.write(p); } catch { /* only a hint: losing it costs a repeated step */ }
}
const point = (host, name) => (host.checkpoint ? host.checkpoint(name) : undefined);

/**
 * Run the move (or continue an interrupted one). Resolves with { summary, marker } once the app has
 * switched to the file; throws a MoveError naming the step that stopped it, with the localStorage
 * copy unchanged and no candidate file left behind.
 *
 * host:
 *   source                  the adapter on the localStorage copy (only read)
 *   freeBytes()             the phone's free space
 *   backup()                step 1: the encrypted backup, saved; rejects if it was not saved
 *   snapshot(bytes)         step 2: write and check a snapshot; resolves with its name
 *   candidate.write(bytes)  step 3: write the candidate file, forced to disk
 *   candidate.open()        an adapter on the candidate
 *   candidate.remove()      delete the candidate (and its journal); fine if there is none
 *   candidate.place()       step 5: rename the candidate to the database file (atomic)
 *   main.remove()           undo step 5 when a later step fails before the switch
 *   marker.read()           (to tell, after a failure, whether the switch happened)
 *   marker.write(obj)       step 6: the marker file, forced to disk
 *   markerKey.write(obj)    step 6: the localStorage key that repeats it
 *   progress.read/write/clear()   the progress record (localStorage)
 *   now()                   the time (a Date)
 *   checkpoint(name)        optional: called between steps (tests stop or kill the process there)
 * onStep(index, name)       optional: progress for the page ("Moving your data…")
 */
export async function moveToFile(host, { onStep } = {}) {
  const step = async (i) => { await point(host, `before-${STEPS[i]}`); if (onStep) onStep(i, STEPS[i]); };
  // The database exactly as it is now: what the space check and "Continue" go by.
  let bytes = await host.source.exportBytes();
  let checksum = await sha256Hex(bytes);
  const before = await readProgress(host);
  const current = !!(before && before.checksum === checksum && Array.isArray(before.done) && before.done.includes('snapshot'));

  await step(0);
  const need = requiredFreeBytes(bytes.length);
  const free = Number(await host.freeBytes());
  if (!(free >= need)) throw new MoveError('space', spaceMessage(need, free), { needBytes: need, freeBytes: free });

  const progress = current ? { ...before } : { checksum, done: ['space'], startedAt: host.now().toISOString() };
  if (!current) {
    await step(1);
    await host.backup();
    // Saving the backup records its time in the database (settings.last_encrypted_export_at), so the
    // database is exported again: the snapshot, the file and the check all use it as it is now.
    bytes = await host.source.exportBytes();
    checksum = await sha256Hex(bytes);
    progress.checksum = checksum;
    progress.done.push('backup');
    progress.backupAt = host.now().toISOString();
    await writeProgress(host, progress);

    await step(2);
    try {
      progress.snapshot = await host.snapshot(bytes);
    } catch (e) {
      if (isDiskFull(e)) throw await spaceError(host, 'snapshot', need, e);
      throw e;
    }
    progress.done.push('snapshot');
    await writeProgress(host, progress);
  }

  // Steps 3-6. If anything fails before the marker says native-v1, undo what this run made: the
  // candidate, and the database file if it was already renamed into place (plan §5.1, C6).
  let placed = false;
  try {
    await step(3);
    await host.candidate.remove();
    try {
      await host.candidate.write(bytes);
    } catch (e) {
      if (isDiskFull(e)) throw await spaceError(host, 'write', need, e);
      throw new MoveError('write', `The new file could not be written: ${e && e.message ? e.message : e}`, { cause: e });
    }
    await point(host, 'after-write');

    await step(4);
    let fpNew;
    let candidate = null;
    try {
      candidate = await host.candidate.open();
      fpNew = await fingerprint(candidate);
    } catch (e) {
      throw new MoveError('check', `The new file could not be checked: ${e && e.message ? e.message : e}`, { cause: e });
    } finally {
      if (candidate) await candidate.close().catch(() => {});
    }
    const fpOld = await fingerprint(host.source);
    const diffs = compareFingerprints(fpOld, fpNew);
    if (diffs.length) throw new MoveError('check', `The new file does not match your data, so nothing was switched: ${diffs[0]}`, { diffs });
    await point(host, 'after-check');

    await step(5);
    await host.candidate.place();
    placed = true;
    await point(host, 'after-place');

    await step(6);
    const summary = summarize(fpOld);
    const at = host.now().toISOString();
    const marker = {
      storage: MARKER_NATIVE,
      movedAt: at,
      check: { tables: summary.tables, rows: summary.rows, perTable: summary.perTable },
      oldCopy: { kept: true, since: at, bytes: bytes.length, checksum },
    };
    await host.marker.write(marker);
    await point(host, 'after-marker');
    try { await host.markerKey.write({ storage: MARKER_NATIVE, movedAt: at }); } catch { /* the file is what counts */ }
    try { await host.progress.clear(); } catch { /* a stale hint is harmless once the marker says native-v1 */ }
    return { summary, marker };
  } catch (err) {
    let switched = false;
    if (placed) {
      try { const m = await host.marker.read(); switched = !!(m && m.storage === MARKER_NATIVE); } catch { /* unreadable: not switched */ }
    }
    if (!switched) {
      await host.candidate.remove().catch(() => {});
      if (placed) await host.main.remove().catch(() => {});
    }
    throw err;
  }
}

/**
 * Which copy to use at startup (plan §2.2), from facts only:
 *   marker          the marker file's content (or, if the file is missing, the localStorage key's), or null
 *   candidate       the candidate file (plannr-movingSQLite.db) is there
 *   main            the database file (plannrSQLite.db) is there
 *   mainOk          the database file opens and PRAGMA quick_check is ok (only asked when needed)
 *   moveInProgress  the progress record says a move had started
 *   markerUnreadable the marker file is there but could not be read (Q5): the move may have finished,
 *                   so the database file may hold the live data and is set aside, never deleted
 * Returns { use: 'localstorage' | 'native' | 'recovery', remove: [...], setAside: [...], prompt? }.
 * remove/setAside name files the caller deletes or renames aside before going on ('candidate' | 'main').
 */
export async function decideAtStartup({ marker, candidate, main, mainOk, moveInProgress: started, markerUnreadable = false }) {
  const moveInProgress = started && !markerUnreadable;
  const kind = marker && marker.storage;
  if (kind === MARKER_NATIVE) {
    const ok = main && (await mainOk());
    if (ok) return { use: 'native', remove: candidate ? ['candidate'] : [], setAside: [] };
    return { use: 'recovery', remove: [], setAside: [], reason: main ? 'damaged' : 'missing' };
  }
  if (kind === MARKER_LOCAL) return { use: 'localstorage', remove: candidate ? ['candidate'] : [], setAside: [] };
  if (!candidate && !main) return { use: 'localstorage', remove: [], setAside: [] };
  // A move was interrupted before the switch: localStorage is still the only real copy.
  // A database file that no move record explains is renamed aside rather than deleted.
  return {
    use: 'localstorage',
    remove: [...(candidate ? ['candidate'] : []), ...(main && moveInProgress ? ['main'] : [])],
    setAside: main && !moveInProgress ? ['main'] : [],
    prompt: 'interrupted',
  };
}

// ---- After the move: the way back, the emergency path, deleting the old copy (plan §2.4; C8) --------
//
// More of host, used only here:
//   file                     the adapter on the database file in use (after the move)
//   local.limitChars         the localStorage limit in characters (local-api.js LOCALSTORAGE_LIMIT_CHARS)
//   local.usedChars()        optional: { copy, other } characters localStorage holds now: the old copy's
//                            kvvfs-local-* keys, and every other key (Q4). Without it the old copy is
//                            measured from its bytes and other keys count as 0.
//   local.exists()           the old localStorage copy is there
//   local.exportBytes()      its bytes (for the snapshot before it is replaced)
//   local.replaceWith(bytes) replace it, all or nothing (kvvfs: one transaction)
//   local.open()             an adapter on it (for the check)
//   local.clear()            delete it (the kvvfs-local-* keys)
//   main.exists(), main.quickCheckOk(), main.setAside(stamp)
//   lastEncryptedBackupAt()  settings.last_encrypted_export_at of the data in use ('YYYY-MM-DD HH:MM:SS', UTC) or null

/** kvvfs keeps a database byte as up to 2 characters of localStorage (hex; runs of zeros are shorter). */
export const KVVFS_CHARS_PER_BYTE = 2;
/** The way back is allowed only under 90% of the localStorage limit, because that limit applies again. */
export const MOVE_BACK_FRACTION = 0.9;
export const moveBackLimitBytes = (limitChars) => Math.floor((MOVE_BACK_FRACTION * Number(limitChars)) / KVVFS_CHARS_PER_BYTE);
export const moveBackFits = (bytes, limitChars) => Number(bytes) <= moveBackLimitBytes(limitChars);
/**
 * Q4: what localStorage must hold while the old copy is replaced. The old copy stays until the
 * commit, kvvfs's rollback journal (kvvfs-local-jrnl) can hold every one of its pages, and other
 * keys take quota too. So the peak is: other + max(new, old copy) + old copy, in characters.
 * Returns the largest incoming size in bytes that still fits under 90% of the limit (0 if none).
 */
export function moveBackRoomBytes({ limitChars, copyChars = 0, otherChars = 0 }) {
  const room = MOVE_BACK_FRACTION * Number(limitChars) - Number(otherChars) - Number(copyChars);
  if (!(room >= Number(copyChars))) return 0; // not even the journal of the old copy fits
  return Math.floor(room / KVVFS_CHARS_PER_BYTE);
}

const mbText = (bytes) => `${(Math.ceil((Number(bytes) / MB) * 10) / 10).toFixed(1)} MB`;
const dayText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'the move' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};
/** settings stamps are 'YYYY-MM-DD HH:MM:SS' in UTC; ISO strings and Dates are taken as they are. */
export function stampTime(v) {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? '');
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isNaN(t) ? NaN : t;
}

async function readMarker(host) {
  try { const m = await host.marker.read(); return m && typeof m === 'object' ? m : null; } catch { return null; }
}

async function snapshotOrStop(host, step, bytes, kind) {
  try { return await host.snapshot(bytes, kind); } catch (e) {
    if (isDiskFull(e)) throw new MoveError(step, `There is not enough space for the safety snapshot. ${spaceMessage(requiredFreeBytes(bytes.length), Number(await host.freeBytes().catch(() => 0)))}`, { cause: e });
    throw new MoveError(step, `The safety snapshot could not be saved, so nothing was changed: ${e && e.message ? e.message : e}`, { cause: e });
  }
}

/**
 * "Move data back" (plan §2.4): copy the data in use (the file) into localStorage, replacing the old
 * copy, check it, then set the marker to localstorage-v1. The file is kept. Allowed only when the
 * data fits under 90% of the localStorage limit, and only after you confirm (it replaces the old copy).
 * Snapshots of the old copy and of the data in use come first. Until the marker changes the app
 * stays on the file, so a failure at any point leaves it working on the file.
 */
export async function moveBack(host, { confirmed = false, onStep } = {}) {
  const marker = await readMarker(host);
  if (!marker || marker.storage !== MARKER_NATIVE) throw new MoveError('state', 'Your data is not in the new storage, so there is nothing to move back.');
  const say = async (name) => { await point(host, `back-${name}`); if (onStep) onStep(name); };
  // Without `confirmed` this only checks: the size and the free space are refused before the
  // question is asked (the page asks only what can be done), and then the question itself.

  await say('size');
  const bytes = await host.file.exportBytes();
  // Q4: count the old copy (kept until the commit, and journaled) and the other keys, not only the data.
  let used = host.local.usedChars ? await host.local.usedChars() : null;
  if (!used) used = { copy: (await host.local.exists()) ? (await host.local.exportBytes()).length * KVVFS_CHARS_PER_BYTE : 0, other: 0 };
  const limit = Math.min(moveBackLimitBytes(host.local.limitChars),
    moveBackRoomBytes({ limitChars: host.local.limitChars, copyChars: used.copy, otherChars: used.other }));
  if (!(bytes.length <= limit)) {
    throw new MoveError('size', `Your data (${mbText(bytes.length)}) is too big to move back: the old storage holds at most about ${mbText(limit)}. It stays in the new storage.`, { bytes: bytes.length, limitBytes: limit });
  }
  const free = Number(await host.freeBytes());
  const need = requiredFreeBytes(bytes.length);
  if (!(free >= need)) throw new MoveError('space', spaceMessage(need, free), { needBytes: need, freeBytes: free });
  if (confirmed !== true) throw new MoveError('confirm', 'Moving your data back replaces the old copy with your current data. Confirm to go on.');

  await say('snapshot');
  const snapshots = {};
  if (await host.local.exists()) snapshots.oldCopy = await snapshotOrStop(host, 'snapshot', await host.local.exportBytes(), 'old-copy');
  snapshots.current = await snapshotOrStop(host, 'snapshot', bytes, 'pre-move-back');

  await say('write');
  try {
    await host.local.replaceWith(bytes);
  } catch (e) {
    throw new MoveError('write', `Your data could not be written back, so nothing was switched (the old copy is unchanged): ${e && e.message ? e.message : e}`, { cause: e });
  }

  await say('check');
  let local = null;
  let diffs;
  let fpFile;
  try {
    local = await host.local.open();
    fpFile = await fingerprint(host.file);
    diffs = compareFingerprints(fpFile, await fingerprint(local));
  } finally {
    if (local) await local.close().catch(() => {});
  }
  if (diffs.length) {
    throw new MoveError('check', `The copy in the old storage does not match your data, so nothing was switched; you stay on the new storage (a snapshot of the old copy was saved): ${diffs[0]}`, { diffs, snapshots });
  }

  await say('switch');
  const summary = summarize(fpFile);
  const at = host.now().toISOString();
  const next = {
    storage: MARKER_LOCAL,
    movedBackAt: at,
    movedAt: marker.movedAt,
    check: { tables: summary.tables, rows: summary.rows, perTable: summary.perTable },
    file: { kept: true, since: at },
    snapshots,
  };
  await host.marker.write(next);
  try { await host.markerKey.write({ storage: MARKER_LOCAL, movedBackAt: at }); } catch { /* the file is what counts */ }
  return { summary, marker: next };
}

/**
 * The emergency path (plan §2.4): only when the marker says native-v1 and the file is missing or
 * damaged. Switches back to the old localStorage copy as it was on the day of the move, without
 * copying anything, so entries made since then are not in it (the dialog says so; `confirmed`). The
 * damaged file is renamed aside and kept.
 */
export async function useOldCopy(host, { confirmed = false } = {}) {
  const marker = await readMarker(host);
  if (!marker || marker.storage !== MARKER_NATIVE) throw new MoveError('state', 'The app is not using the new storage, so there is nothing to switch back from.');
  const main = await host.main.exists();
  if (main && (await host.main.quickCheckOk())) throw new MoveError('state', 'The database file is fine. The old copy is only for when the file is missing or damaged.');
  const kept = !(marker.oldCopy && marker.oldCopy.kept === false) && (await host.local.exists());
  if (!kept) throw new MoveError('missing', 'There is no old copy to go back to. Restore an encrypted backup instead.');
  const since = (marker.oldCopy && marker.oldCopy.since) || marker.movedAt;
  if (confirmed !== true) throw new MoveError('confirm', `The old copy is your data as it was on ${dayText(since)}. Anything entered after that is not in it. Confirm to go on.`);

  const at = host.now().toISOString();
  let setAside = null;
  if (main) setAside = await host.main.setAside(at.replace(/[:.]/g, '-'));
  const next = { storage: MARKER_LOCAL, emergency: true, at, oldCopyFrom: since, movedAt: marker.movedAt, file: { kept: !!setAside, setAside, reason: main ? 'damaged' : 'missing' } };
  await host.marker.write(next);
  try { await host.markerKey.write({ storage: MARKER_LOCAL, at, emergency: true }); } catch { /* the file is what counts */ }
  return { marker: next, setAside };
}

/**
 * "Delete the old copy" (plan §2.4): only after you confirm, and only with an encrypted backup saved
 * since the move. The marker records it first, then the localStorage copy is deleted; if the delete
 * is interrupted, doing it again finishes it. Nothing ever calls this on its own.
 */
export async function deleteOldCopy(host, { confirmed = false } = {}) {
  const marker = await readMarker(host);
  if (!marker || marker.storage !== MARKER_NATIVE) throw new MoveError('state', 'The old copy is the data in use, so it cannot be deleted.');
  const recorded = !(marker.oldCopy && marker.oldCopy.kept === false);
  if (!(await host.local.exists())) {
    if (recorded) await host.marker.write({ ...marker, oldCopy: { ...(marker.oldCopy || {}), kept: false, deletedAt: host.now().toISOString() } });
    throw new MoveError('missing', 'There is no old copy to delete.');
  }
  const last = await host.lastEncryptedBackupAt();
  const lastAt = stampTime(last);
  const movedAt = stampTime(marker.movedAt);
  if (!(Number.isFinite(lastAt) && Number.isFinite(movedAt) && lastAt > movedAt)) {
    throw new MoveError('backup', `Save an encrypted backup first: none has been saved since the move on ${dayText(marker.movedAt)}.`, { lastBackupAt: last || null });
  }
  if (confirmed !== true) throw new MoveError('confirm', 'Deleting the old copy cannot be undone. Your encrypted backup stays your safety net. Confirm to go on.');
  const at = host.now().toISOString();
  const bytes = (marker.oldCopy && marker.oldCopy.bytes) || null;
  const next = { ...marker, oldCopy: { ...(marker.oldCopy || {}), kept: false, deletedAt: at } };
  await host.marker.write(next);
  await point(host, 'delete-recorded');
  await host.local.clear();
  return { marker: next, freedBytes: bytes };
}
