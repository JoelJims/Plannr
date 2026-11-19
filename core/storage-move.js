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

const mbText = (bytes) => `${Math.max(1, Math.ceil(bytes / MB))} MB`;

export class MoveError extends Error {
  constructor(step, message, details) {
    super(message);
    this.step = step;
    if (details !== undefined) this.details = details;
  }
}

/** The message when there is not enough space (plan §2.5). */
export function spaceMessage(needBytes, freeBytes) {
  return `Plannr needs about ${mbText(needBytes)} free to move your data. Your phone has ${mbText(freeBytes)} free. Free some space, then try again.`;
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
    progress.snapshot = await host.snapshot(bytes);
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
 * Returns { use: 'localstorage' | 'native' | 'recovery', remove: [...], setAside: [...], prompt? }.
 * remove/setAside name files the caller deletes or renames aside before going on ('candidate' | 'main').
 */
export async function decideAtStartup({ marker, candidate, main, mainOk, moveInProgress }) {
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
