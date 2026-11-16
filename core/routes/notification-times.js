// Cross-platform plan, step 1.3 — the reminder times on Home: up to 5 "HH:MM" times, stored as one
// settings row. The phone schedules the reminders itself (public/notifications.js); these routes only
// store the list. The only copy: server.js and public/local-api.js both call register(app, ctx).
// See core/routes/people.js for what `app` and `ctx` are.

export function register(app, ctx) {
  const { db, auth } = ctx;

  // Phase 6b — up to 5 daily local-notification times ("HH:MM", 24h), replacing the deleted
  // scheduled-email report (Phase 1.3 removed daily-report.js, nodemailer, and its scheduling UI).
  // Reuses the old daily_report_times settings key; its old rows are inert (unread by any code before
  // this), so no format migration is needed. Actual notification scheduling is client-side
  // (public/notifications.js) — this is just persistence, like the budget (core/routes/budget.js).
  const NOTIF_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function normalizeNotificationTimes(raw) {
    if (!Array.isArray(raw) || raw.length > 5) return null;
    const seen = new Set(); const out = [];
    for (const t of raw) {
      const s = String(t ?? '').trim();
      if (!NOTIF_TIME_RE.test(s)) return null;
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out.sort();
  }
  function getNotificationTimes() {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'daily_report_times'").get();
    if (!r || r.value == null) return [];
    try { return normalizeNotificationTimes(JSON.parse(r.value)) || []; } catch { return []; }
  }

  app.get('/api/notification-times', auth, (req, res) => {
    res.json({ times: getNotificationTimes() });
  });

  app.put('/api/notification-times', auth, (req, res) => {
    const times = normalizeNotificationTimes(req.body.times);
    if (times === null) return res.status(400).json({ error: 'Send up to 5 unique times as "HH:MM" (24h).' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('daily_report_times', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(times));
    res.json({ times });
  });
}
