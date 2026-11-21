// Phase 6b — local notification scheduling for the daily-report reminder (replaces the Phase 1.3
// deleted email scheduler: no automated sending, just a tap-to-open-Overview reminder).
//
// @capacitor/core self-installs a JS-only `window.Capacitor` fallback when no native bridge is
// present (confirmed by reading its source — createCapacitor() runs unconditionally at import time),
// so importing this module is always safe: Capacitor.isNativePlatform() is simply false under
// server.js/local-server.js, and every exported function below is a deliberate no-op there. Nothing
// here ever touches money, local-api.js's handlers, or backup-crypto.js.
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

// One fixed id per slot (max 5 configured times). Cancelling all five every reschedule — whether or
// not that slot is currently used — is simpler than diffing against whatever's actually pending, and
// just as correct: it's how "cancel and reschedule rather than accumulating duplicates" is satisfied.
const SLOT_IDS = [101, 102, 103, 104, 105];

// Phase 15 — the backup-overdue reminder. A single fixed id, well clear of SLOT_IDS above.
const BACKUP_REMINDER_ID = 201;

function toScheduleOn(hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return { hour, minute }; // hour+minute with no day/month = repeats daily (Capacitor's cron-like `on`)
}

// Exact alarms only when Android already allows them. Every schedule() call sets isExactNotification
// explicitly because its default (true) makes @capacitor/local-notifications 8.3+ open Android's
// "Alarms & reminders" settings screen whenever exact alarms are not allowed, which is the default
// on Android 14+. Found on the emulator (Phase 2, Step 9): the screen opened on every app start.
// Plannr opens it only when the user taps "Allow on-time reminders" on Home (openExactAlarmSetting
// below). Without the permission a reminder is an inexact alarm: Android may deliver it late (on the
// emulator a reminder due in 2 minutes had not arrived 2 minutes after its time).
async function exactAlarmsAllowed() {
  try { return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted'; }
  catch { return false; }
}

// Only ever called from a button the user taps (Home → "Allow on-time reminders"); the caller then
// reschedules with onTimesChanged() so the reminders pick up the new permission.
export async function openExactAlarmSetting() {
  if (!Capacitor.isNativePlatform()) return false;
  try { await LocalNotifications.changeExactNotificationSetting(); } catch { /* the screen may not exist on this phone */ }
  return exactAlarmsAllowed();
}

async function scheduleAll(times) {
  const exact = await exactAlarmsAllowed();
  await LocalNotifications.schedule({
    notifications: times.map((t, i) => ({
      id: SLOT_IDS[i],
      title: 'Plannr',
      body: "Time for today's report.",
      schedule: { on: toScheduleOn(t), allowWhileIdle: true },
      isExactNotification: exact,
      extra: { openTarget: 'overview' },
    })),
  });
  return exact;
}

// Tapping a notification opens whatever page it's about — Overview for the daily-report reminders,
// Data Backup for the backup-overdue one (Phase 15) — via the `extra.openTarget` every schedule()
// call below sets. Registered once, unconditionally — a no-op add on a plugin whose native side
// doesn't exist outside a real Capacitor WebView.
if (Capacitor.isNativePlatform()) {
  LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
    const target = action && action.notification && action.notification.extra && action.notification.extra.openTarget;
    location.href = target === 'data-backup' ? '/data-backup.html' : '/overview.html';
  });
}

// Called on app start with whatever times are already saved. Never prompts for permission — only
// re-applies it if already granted from an earlier "set a time" action. Silent no-op otherwise (and
// entirely outside a native WebView), so this is always safe to call unconditionally on every load.
// Returns the same shape as onTimesChanged() (undefined outside the app), so Home can show its
// "Allow on-time reminders" button for times saved before exact alarms were handled this way.
export async function onAppStart(times) {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.cancel({ notifications: SLOT_IDS.map((id) => ({ id })) });
  if (!times.length) return { scheduled: false, reason: 'no-times' };
  const perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') return { scheduled: false, reason: 'permission-denied' }; // app launch is not the moment to prompt
  const exact = await scheduleAll(times);
  return { scheduled: true, exact };
}

// Called from the settings UI whenever the times list changes (an add or a remove). This IS the
// "user first sets a time" moment — permission is requested here if not yet decided. Returns whether
// notifications actually got (re)scheduled, so the UI can show a plain-language degrade message
// rather than silently pretending it worked.
export async function onTimesChanged(times) {
  if (!Capacitor.isNativePlatform()) return { scheduled: false, reason: 'not-native' };
  await LocalNotifications.cancel({ notifications: SLOT_IDS.map((id) => ({ id })) });
  if (!times.length) return { scheduled: false, reason: 'no-times' };
  let perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
  if (perm.display !== 'granted') return { scheduled: false, reason: 'permission-denied' };
  const exact = await scheduleAll(times);
  return { scheduled: true, exact }; // exact: false -> Home offers "Allow on-time reminders"
}

// Phase 15 — called on app start with the current overdue state (home.html computes it from
// /api/backup/reminder). `daysSince` is null when not overdue (reminder off, or last export within
// the configured window) — cancel and stop. Otherwise the literal string 'never' or a day count.
// Same rule as onAppStart above: launch is never the moment to prompt for permission — only fires if
// already granted from an earlier "set a time" action; the in-app banner is the fallback otherwise.
export async function checkBackupReminder(daysSince) {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.cancel({ notifications: [{ id: BACKUP_REMINDER_ID }] });
  if (daysSince == null) return;
  const perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') return;
  const body = daysSince === 'never'
    ? 'You have never backed up. Export one to keep your ledger safe.'
    : `Your last backup was ${daysSince} day${daysSince === 1 ? '' : 's'} ago. Export one to keep your ledger safe.`;
  await LocalNotifications.schedule({
    // Shown now (no schedule), so no alarm is involved; false stops the plugin's settings-screen prompt.
    notifications: [{ id: BACKUP_REMINDER_ID, title: 'Plannr', body: 'Plannr — ' + body, isExactNotification: false, extra: { openTarget: 'data-backup' } }],
  });
}
