// GET /api/storage, the storage meter on the Data Backup page, shared by the phone and the dev server
// (step 1.4 C11; docs/step-1.4-storage-plan.md §3.2, §4).
//
// Each platform says what it knows through ctx.host.storage.info() (core/host.js); this file turns it
// into one answer shape, with the level and the numbers the page shows:
//   { mode, kind, databaseBytes, usedBytes, limitBytes, backupBytes, backupLimitBytes, freeBytes,
//     oldCopyBytes, fraction, level, freeLow }
// The three kinds of storage:
//   - 'localstorage': the phone before the move, and the browser preview. The data lives in
//     localStorage, which is full at a fixed size: the meter is localStorage used / its limit
//     (warning from 70%, strongly from 90%), as since Phase 2 Step 3.
//   - 'file': the phone after the move. The file can grow with the phone's free space, so the limit
//     that matters is Android's Google backup, which skips an app whose data is over 25 MB: the
//     meter is the backup estimate (the file, plus the old localStorage copy while it is kept)
//     against 25 MB, warning from 20 MB and strongly from 23 MB (decision D5). Free space under
//     100 MB is said too, since new entries fail when the phone is full. oldCopyBytes is what the old
//     copy holds in localStorage now (0 once it is deleted): the one count of its size, which the
//     page's storage meter and its storage-move section both show (owner's decision 2026-11-28).
//   - 'desktop': the dev server; a database file with no limit here.

export const MB = 1024 * 1024;
export const LOCAL_WARN_AT = 0.7;
export const LOCAL_STRONG_AT = 0.9;
export const BACKUP_LIMIT_BYTES = 25 * MB;
export const BACKUP_WARN_BYTES = 20 * MB;
export const BACKUP_STRONG_BYTES = 23 * MB;
export const FREE_LOW_BYTES = 100 * MB;

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** The answer for what the platform reported (host.storage.info()). */
export function storageAnswer(info) {
  const kind = info && info.kind;
  if (kind === 'localstorage') {
    const used = num(info.usedBytes) ?? 0;
    const limit = num(info.limitBytes);
    const fraction = limit ? used / limit : 0;
    return {
      mode: 'phone', kind,
      databaseBytes: num(info.databaseBytes), usedBytes: used, limitBytes: limit,
      backupBytes: null, backupLimitBytes: null, freeBytes: null, oldCopyBytes: null,
      fraction,
      level: fraction >= LOCAL_STRONG_AT ? 'critical' : fraction >= LOCAL_WARN_AT ? 'warning' : 'ok',
      freeLow: false,
    };
  }
  if (kind === 'file') {
    const database = num(info.databaseBytes) ?? 0;
    const oldCopy = num(info.oldCopyBytes) ?? 0;
    const backup = database + oldCopy;
    const free = num(info.freeBytes);
    return {
      mode: 'phone', kind,
      databaseBytes: database, usedBytes: null, limitBytes: null,
      backupBytes: backup, backupLimitBytes: BACKUP_LIMIT_BYTES, freeBytes: free, oldCopyBytes: oldCopy,
      fraction: backup / BACKUP_LIMIT_BYTES,
      level: backup >= BACKUP_STRONG_BYTES ? 'critical' : backup >= BACKUP_WARN_BYTES ? 'warning' : 'ok',
      freeLow: free !== null && free < FREE_LOW_BYTES,
    };
  }
  return {
    mode: 'desktop', kind: 'desktop',
    databaseBytes: num(info && info.databaseBytes), usedBytes: null, limitBytes: null,
    backupBytes: null, backupLimitBytes: null, freeBytes: null, oldCopyBytes: null,
    fraction: null, level: 'ok', freeLow: false,
  };
}

export function register(app, ctx) {
  const { auth, host } = ctx;
  app.get('/api/storage', auth, async (req, res, next) => {
    try {
      res.json(storageAnswer(await host.storage.info()));
    } catch (e) {
      if (next) return next(e);
      throw e;
    }
  });
}
