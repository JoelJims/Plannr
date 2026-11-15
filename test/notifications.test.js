// Phase 2, Step 9 follow-up — public/notifications.js never sends the user to Android's "Alarms &
// reminders" settings screen. @capacitor/local-notifications 8.3+ opens that screen from schedule()
// whenever a notification leaves isExactNotification at its default (true) and exact alarms are not
// allowed (the default on Android 14+); on the emulator it opened on every app start.
// The module is loaded with fake Capacitor objects in place of its two imports.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'notifications.js'), 'utf8');

function fakePlugin({ display = 'granted', exact = 'denied' } = {}) {
  const calls = [];
  return {
    calls,
    schedule: async (o) => { calls.push(['schedule', o]); return { notifications: [] }; },
    cancel: async (o) => { calls.push(['cancel', o]); },
    checkPermissions: async () => { calls.push(['checkPermissions']); return { display }; },
    requestPermissions: async () => { calls.push(['requestPermissions']); return { display }; },
    checkExactNotificationSetting: async () => { calls.push(['checkExactNotificationSetting']); return { exact_alarm: exact }; },
    changeExactNotificationSetting: async () => { calls.push(['changeExactNotificationSetting']); return { exact_alarm: exact }; },
    addListener: async () => {},
  };
}

let loads = 0;
async function load(plugin, native = true) {
  const key = `__plannrNotificationsTest${++loads}`;
  globalThis[key] = { Capacitor: { isNativePlatform: () => native }, LocalNotifications: plugin };
  const src = SRC
    .replace(/^import \{ Capacitor \} from '@capacitor\/core';\r?$/m, `const { Capacitor } = globalThis.${key};`)
    .replace(/^import \{ LocalNotifications \} from '@capacitor\/local-notifications';\r?$/m, `const { LocalNotifications } = globalThis.${key};`);
  assert.ok(!/^import /m.test(src), 'both imports were replaced');
  return import('data:text/javascript,' + encodeURIComponent(src));
}

const scheduled = (plugin) => plugin.calls.filter(([c]) => c === 'schedule').flatMap(([, o]) => o.notifications);
const never = (plugin, ...names) => { for (const n of names) assert.ok(!plugin.calls.some(([c]) => c === n), `${n} must not be called`); };

test('app start, exact alarms not allowed: reminders are inexact and nothing prompts', async () => {
  const plugin = fakePlugin({ exact: 'denied' });
  const m = await load(plugin);
  await m.onAppStart(['09:00', '18:30']);
  const n = scheduled(plugin);
  assert.strictEqual(n.length, 2);
  for (const x of n) assert.strictEqual(x.isExactNotification, false);
  never(plugin, 'changeExactNotificationSetting', 'requestPermissions');
});

test('app start, exact alarms already allowed: reminders use them', async () => {
  const plugin = fakePlugin({ exact: 'granted' });
  const m = await load(plugin);
  await m.onAppStart(['07:15']);
  assert.deepStrictEqual(scheduled(plugin).map((x) => x.isExactNotification), [true]);
  never(plugin, 'changeExactNotificationSetting', 'requestPermissions');
});

test('the backup-overdue reminder sets isExactNotification false and never prompts', async () => {
  const plugin = fakePlugin({ exact: 'denied' });
  const m = await load(plugin);
  await m.checkBackupReminder('never');
  await m.checkBackupReminder(12);
  const n = scheduled(plugin);
  assert.strictEqual(n.length, 2);
  for (const x of n) assert.strictEqual(x.isExactNotification, false);
  assert.match(n[1].body, /12 days ago/);
  never(plugin, 'changeExactNotificationSetting', 'requestPermissions');
});

test('setting a reminder time may ask for notification permission, never opens the exact-alarm screen', async () => {
  const plugin = fakePlugin({ display: 'granted', exact: 'denied' });
  const m = await load(plugin);
  assert.deepStrictEqual(await m.onTimesChanged(['20:00']), { scheduled: true, exact: false });
  assert.deepStrictEqual(scheduled(plugin).map((x) => x.isExactNotification), [false]);
  never(plugin, 'changeExactNotificationSetting');
  const granted = fakePlugin({ display: 'granted', exact: 'granted' });
  assert.deepStrictEqual(await (await load(granted)).onTimesChanged(['20:00']), { scheduled: true, exact: true });
});

test('the exact-alarm screen opens only through openExactAlarmSetting (the Home button)', async () => {
  const plugin = fakePlugin({ exact: 'denied' });
  const m = await load(plugin);
  assert.strictEqual(await m.openExactAlarmSetting(), false);
  assert.deepStrictEqual(plugin.calls.map(([c]) => c), ['changeExactNotificationSetting', 'checkExactNotificationSetting']);
  const off = fakePlugin();
  assert.strictEqual(await (await load(off, false)).openExactAlarmSetting(), false);
  assert.deepStrictEqual(off.calls, []);
});

test('if the exact-alarm check fails, reminders fall back to inexact', async () => {
  const plugin = fakePlugin();
  plugin.checkExactNotificationSetting = async () => { throw new Error('not implemented'); };
  const m = await load(plugin);
  await m.onAppStart(['10:00']);
  assert.deepStrictEqual(scheduled(plugin).map((x) => x.isExactNotification), [false]);
});

test('outside the Android app nothing is scheduled', async () => {
  const plugin = fakePlugin();
  const m = await load(plugin, false);
  await m.onAppStart(['09:00']);
  await m.checkBackupReminder('never');
  assert.deepStrictEqual(await m.onTimesChanged(['09:00']), { scheduled: false, reason: 'not-native' });
  assert.deepStrictEqual(plugin.calls, []);
});

test('every schedule() call in notifications.js is covered above (two of them); one place opens the setting', () => {
  assert.strictEqual((SRC.match(/LocalNotifications\.schedule\(/g) || []).length, 2, 'a new schedule() call needs isExactNotification and a test here');
  assert.strictEqual((SRC.match(/LocalNotifications\.changeExactNotificationSetting\(/g) || []).length, 1, 'only openExactAlarmSetting may open it');
});

test('Home offers the setting with a button and opens it only on a tap', () => {
  const home = fs.readFileSync(path.join(__dirname, '..', 'public', 'home.html'), 'utf8');
  assert.match(home, /<button type="button" id="notifExactBtn"[^>]*hidden>Allow on-time reminders<\/button>/);
  const calls = home.match(/notif\.openExactAlarmSetting\(/g) || [];
  assert.strictEqual(calls.length, 1);
  assert.match(home, /notifExactBtn\.addEventListener\('click', async \(\) => \{\s*await notif\.openExactAlarmSetting\(\);/);
});
