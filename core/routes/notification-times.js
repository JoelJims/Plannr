// Cross-platform plan, step 1.3 — the reminder times on Home: up to 5 "HH:MM" times, stored as one
// settings row. The phone schedules the reminders itself (public/notifications.js); these routes only
// store the list. The only copy: server.js and public/local-api.js both call register(app, ctx).
// See core/routes/people.js for what `app` and `ctx` are. The row is read and written through ctx.adapter,
// the async database interface (step 1.4 B14).

export function register(app, ctx) {
  const { adapter, auth } = ctx;

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
  async function getNotificationTimes() {
    const r = await adapter.get("SELECT value FROM settings WHERE key = 'daily_report_times'");
    if (!r || r.value == null) return [];
    try { return normalizeNotificationTimes(JSON.parse(r.value)) || []; } catch { return []; }
  }

  app.get('/api/notification-times', auth, async (req, res) => {
    res.json({ times: await getNotificationTimes() });
  });

  app.put('/api/notification-times', auth, async (req, res) => {
    const times = normalizeNotificationTimes(req.body.times);
    if (times === null) return res.status(400).json({ error: 'Send up to 5 unique times as "HH:MM" (24h).' });
    await adapter.run("INSERT INTO settings (key, value) VALUES ('daily_report_times', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(times)]);
    res.json({ times });
  });

  // Share settings for "send the PDF to WhatsApp or email" (docs/share-and-reminder-pdf-plan.md,
  // section 3). Kept here, next to the reminder times, because both hosts already call this register().
  // New keys only: the retired daily_report_recipients / daily_report_whatsapp rows are never read, so
  // no address is used that was not typed here. share_email_to is contact data (backup-format.js
  // CONTACT_SETTINGS_KEYS). No WhatsApp number is stored: WhatsApp opens on its own contact picker.
  const SHARE_TARGETS = ['whatsapp', 'email', 'ask'];
  const SHARE_DEFAULTS = { target: 'ask', emailTo: [], emailSubject: 'Plannr report – {date}' };
  const MAX_RECIPIENTS = 5;
  const MAX_SUBJECT = 120;
  const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)+$/;
  // A list or comma-separated text -> trimmed addresses without repeats (any case); null when invalid.
  function normalizeRecipients(raw) {
    const list = typeof raw === 'string' ? raw.split(',') : raw;
    if (!Array.isArray(list)) return null;
    const seen = new Set(); const out = [];
    for (const a of list) {
      if (typeof a !== 'string') return null;
      const s = a.trim();
      if (!s) continue;
      if (s.length > 254 || !EMAIL_RE.test(s)) return null;
      if (!seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    }
    return out.length > MAX_RECIPIENTS ? null : out;
  }
  async function readSetting(key) {
    const r = await adapter.get('SELECT value FROM settings WHERE key = ?', [key]);
    return r && r.value != null ? String(r.value) : null;
  }
  async function getShareSettings() {
    const target = await readSetting('share_target');
    let emailTo = [];
    try { emailTo = normalizeRecipients(JSON.parse(await readSetting('share_email_to'))) || []; } catch { emailTo = []; }
    const subject = (await readSetting('share_email_subject')) || '';
    return {
      target: SHARE_TARGETS.includes(target) ? target : SHARE_DEFAULTS.target,
      emailTo,
      emailSubject: subject.trim() && subject.length <= MAX_SUBJECT ? subject.trim() : SHARE_DEFAULTS.emailSubject,
    };
  }
  const putSetting = (key, value) => adapter.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);

  app.get('/api/share-settings', auth, async (req, res) => {
    res.json(await getShareSettings());
  });

  app.put('/api/share-settings', auth, async (req, res) => {
    const body = req.body || {};
    if (!SHARE_TARGETS.includes(body.target)) return res.status(400).json({ error: 'Choose where PDFs go: WhatsApp, email, or ask each time.' });
    const emailTo = normalizeRecipients(body.emailTo ?? []);
    if (emailTo === null) return res.status(400).json({ error: `Give up to ${MAX_RECIPIENTS} email addresses, separated by commas.` });
    if (body.emailSubject != null && typeof body.emailSubject !== 'string') return res.status(400).json({ error: 'The email subject must be text.' });
    const subject = (body.emailSubject || '').trim();
    if (subject.length > MAX_SUBJECT) return res.status(400).json({ error: `Keep the email subject to ${MAX_SUBJECT} characters.` });
    await putSetting('share_target', body.target);
    await putSetting('share_email_to', JSON.stringify(emailTo));
    await putSetting('share_email_subject', subject);
    res.json(await getShareSettings());
  });
}
