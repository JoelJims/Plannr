// The backup-overdue reminder, shared by the phone and the dev server (step 1.4 A6; Phase 15).
//
// last_encrypted_export_at is stamped only by a VERIFIED encrypted full backup (see saveFile() in
// data-backup.html, gated on the encrypted file name). A JSON export or a Ledger List CSV is not a
// complete restore point, so neither touches it. backup_reminder_days is the user's overdue
// threshold: unset = the default (7), the literal string 'off' = disabled, otherwise a whole number
// of days.
//
// The time comes from ctx.host.now() (core/host.js), never from the platform or from SQLite's
// datetime('now'), so a test can fix the clock.

export const BACKUP_REMINDER_DEFAULT_DAYS = 7;
export const BACKUP_REMINDER_MIN_DAYS = 1;
export const BACKUP_REMINDER_MAX_DAYS = 365;

const DAY_MS = 86400000;

// `date` as 'YYYY-MM-DD HH:MM:SS' in UTC, the shape of every other *_at column (SQLite's
// datetime('now'), which this route used before A6).
export function toUtcStamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Whole days from `utc` ('YYYY-MM-DD HH:MM:SS') to `now` (a Date), floored, so "6 days and 23 hours"
// reads as 6 rather than rounding up to a false "7 days ago". A stamp in the future reads as 0.
export function daysSinceUtc(utc, now) {
  const then = new Date(String(utc).replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS));
}

export function register(app, ctx) {
  const { auth, db, host } = ctx;

  const setSetting = (key, value) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);

  function getLastExportAt() {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'last_encrypted_export_at'").get();
    return (r && r.value) ? r.value : null;
  }

  function getBackupReminderDays() {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'backup_reminder_days'").get();
    if (!r || r.value == null) return BACKUP_REMINDER_DEFAULT_DAYS;
    if (r.value === 'off') return null;
    const n = Number(r.value);
    return Number.isInteger(n) && n >= BACKUP_REMINDER_MIN_DAYS && n <= BACKUP_REMINDER_MAX_DAYS ? n : BACKUP_REMINDER_DEFAULT_DAYS;
  }

  function getBackupReminderStatus() {
    const lastExportAt = getLastExportAt();
    const reminderDays = getBackupReminderDays();
    const since = lastExportAt ? daysSinceUtc(lastExportAt, host.now()) : null;
    const overdue = reminderDays != null && (since === null || since > reminderDays);
    return { lastExportAt, reminderDays, daysSince: since, overdue };
  }

  app.get('/api/backup/reminder', auth, (req, res) => { res.json(getBackupReminderStatus()); });

  app.put('/api/backup/reminder', auth, (req, res) => {
    const raw = req.body.days;
    if (raw === null || raw === 'off') {
      setSetting('backup_reminder_days', 'off');
      return res.json(getBackupReminderStatus());
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < BACKUP_REMINDER_MIN_DAYS || n > BACKUP_REMINDER_MAX_DAYS) {
      return res.status(400).json({ error: `Enter a whole number of days between ${BACKUP_REMINDER_MIN_DAYS} and ${BACKUP_REMINDER_MAX_DAYS}, or turn it off.` });
    }
    setSetting('backup_reminder_days', String(n));
    res.json(getBackupReminderStatus());
  });

  // Called only after the encrypted backup file is verified to actually exist (Filesystem.stat() on
  // native, the closest browser equivalent otherwise): see saveFile() in data-backup.html.
  app.post('/api/backup/mark-exported', auth, (req, res) => {
    setSetting('last_encrypted_export_at', toUtcStamp(host.now()));
    res.json(getBackupReminderStatus());
  });
}
