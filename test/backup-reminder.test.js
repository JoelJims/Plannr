// Step 1.4 A6: the backup-overdue reminder routes (core/routes/backup-reminder.js).
//
// 1. Over HTTP, through test/helpers.js, so run-tests.js runs these against both platforms (server.js
//    and the phone's public/local-api.js). The clock is real here, so only "today" is checked.
// 2. With a fixed clock: the core module registered on a small fake app, over an in-memory
//    node:sqlite settings table (through the async adapter, db-adapter-node.js), with a host whose
//    now() is set by the test. This is where the
//    "days since" rounding and the overdue boundary are checked.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const clearReminderSettings = () => H.db.prepare(
  "DELETE FROM settings WHERE key IN ('last_encrypted_export_at', 'backup_reminder_days')",
).run();

// ---- 1. Over HTTP, both platforms ------------------------------------------------------------------

beforeEach(() => clearReminderSettings());

test('reminder: a never-exported install is overdue, with the default 7 days and no false day count', async () => {
  const r = await H.get('/api/backup/reminder');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { lastExportAt: null, reminderDays: 7, daysSince: null, overdue: true });
});

test('reminder: mark-exported stamps now (UTC, the *_at shape) and clears overdue', async () => {
  const before = Date.now();
  const r = await H.post('/api/backup/mark-exported');
  assert.strictEqual(r.status, 200);
  assert.match(r.json.lastExportAt, STAMP);
  const stamped = new Date(r.json.lastExportAt.replace(' ', 'T') + 'Z').getTime();
  assert.ok(stamped >= Math.floor(before / 1000) * 1000 && stamped <= Date.now(), `stamp ${r.json.lastExportAt} is now`);
  assert.strictEqual(r.json.daysSince, 0);
  assert.strictEqual(r.json.overdue, false);
  const row = H.db.prepare("SELECT value FROM settings WHERE key = 'last_encrypted_export_at'").get();
  assert.strictEqual(row.value, r.json.lastExportAt);
});

test('reminder: PUT off (null or "off") disables it, and a whole number sets it', async () => {
  for (const days of [null, 'off']) {
    const r = await H.put('/api/backup/reminder', { days });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.reminderDays, null);
    assert.strictEqual(r.json.overdue, false, 'never overdue while off');
  }
  const r = await H.put('/api/backup/reminder', { days: 30 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.reminderDays, 30);
  assert.strictEqual(H.db.prepare("SELECT value FROM settings WHERE key = 'backup_reminder_days'").get().value, '30');
  assert.strictEqual((await H.put('/api/backup/reminder', { days: '14' })).json.reminderDays, 14, 'a numeric string is accepted');
});

test('reminder: PUT refuses anything but a whole number of days from 1 to 365, and stores nothing', async () => {
  for (const days of [0, 366, 1.5, -3, 'abc', '', undefined]) {
    const r = await H.put('/api/backup/reminder', { days });
    assert.strictEqual(r.status, 400, `days=${JSON.stringify(days)}`);
    assert.match(r.json.error, /whole number of days between 1 and 365, or turn it off/);
  }
  assert.strictEqual(H.db.prepare("SELECT value FROM settings WHERE key = 'backup_reminder_days'").get(), undefined);
  assert.strictEqual((await H.put('/api/backup/reminder', { days: 1 })).json.reminderDays, 1);
  assert.strictEqual((await H.put('/api/backup/reminder', { days: 365 })).json.reminderDays, 365);
});

test('reminder: a stored value out of range or not a number reads as the default', async () => {
  for (const bad of ['0', '400', '2.5', 'weekly']) {
    H.db.prepare("INSERT INTO settings (key, value) VALUES ('backup_reminder_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(bad);
    assert.strictEqual((await H.get('/api/backup/reminder')).json.reminderDays, 7, `stored ${bad}`);
  }
});

// ---- 2. Fixed clock: the core module itself --------------------------------------------------------

const loadCore = () => import(pathToFileURL(path.join(__dirname, '..', 'core', 'routes', 'backup-reminder.js')).href);

// A fake app that records the routes, and a res that records the answer.
async function fixedClockApp() {
  const core = await loadCore();
  const { openNodeSqliteAdapter } = await import(pathToFileURL(path.join(__dirname, '..', 'db-adapter-node.js')).href);
  const adapter = openNodeSqliteAdapter(':memory:');
  await adapter.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  const clock = { now: new Date('2026-03-10T12:00:00Z') };
  const routes = {};
  const app = {};
  const auth = () => {};
  for (const m of ['get', 'put', 'post']) {
    app[m] = (p, a, handler) => {
      assert.strictEqual(a, auth, `${m} ${p} is registered behind ctx.auth`);
      routes[`${m.toUpperCase()} ${p}`] = handler;
    };
  }
  core.register(app, { auth, adapter, host: { now: () => new Date(clock.now.getTime()) } });
  const call = async (key, body) => {
    const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[key]({ body: body || {}, query: {} }, res);
    return res;
  };
  return { core, adapter, clock, routes, call, status: async () => (await call('GET /api/backup/reminder')).body };
}

test('fixed clock: the core registers exactly the three reminder routes, each behind auth', async () => {
  const { routes } = await fixedClockApp();
  assert.deepStrictEqual(Object.keys(routes).sort(), ['GET /api/backup/reminder', 'POST /api/backup/mark-exported', 'PUT /api/backup/reminder']);
});

test('fixed clock: mark-exported stamps host.now() exactly, not the database clock', async () => {
  const { call, adapter } = await fixedClockApp();
  const r = await call('POST /api/backup/mark-exported');
  assert.strictEqual(r.body.lastExportAt, '2026-03-10 12:00:00');
  assert.strictEqual((await adapter.get("SELECT value FROM settings WHERE key = 'last_encrypted_export_at'")).value, '2026-03-10 12:00:00');
  assert.deepStrictEqual(r.body, { lastExportAt: '2026-03-10 12:00:00', reminderDays: 7, daysSince: 0, overdue: false });
});

test('fixed clock: days since is floored, and overdue starts only AFTER the threshold', async () => {
  const { call, clock, status } = await fixedClockApp();
  await call('POST /api/backup/mark-exported'); // 2026-03-10 12:00:00
  const at = (iso) => { clock.now = new Date(iso); return status(); };
  assert.deepStrictEqual([(await at('2026-03-11T11:59:59Z')).daysSince, (await at('2026-03-11T12:00:00Z')).daysSince], [0, 1]);
  const almost7 = await at('2026-03-17T11:59:59Z');
  assert.deepStrictEqual([almost7.daysSince, almost7.overdue], [6, false], '6 days 23:59:59 reads as 6');
  const day7 = await at('2026-03-17T12:00:00Z');
  assert.deepStrictEqual([day7.daysSince, day7.overdue], [7, false], 'exactly the threshold is not overdue yet');
  const day8 = await at('2026-03-18T12:00:00Z');
  assert.deepStrictEqual([day8.daysSince, day8.overdue], [8, true]);
  // Turning it off clears overdue; a longer threshold moves the boundary.
  assert.strictEqual((await call('PUT /api/backup/reminder', { days: 'off' })).body.overdue, false);
  assert.deepStrictEqual((await call('PUT /api/backup/reminder', { days: 8 })).body.overdue, false);
  assert.strictEqual((await at('2026-03-19T12:00:00Z')).overdue, true);
});

test('fixed clock: a clock set back before the last backup reads as 0 days, not negative', async () => {
  const { call, clock, status } = await fixedClockApp();
  await call('POST /api/backup/mark-exported');
  clock.now = new Date('2026-03-01T00:00:00Z');
  const s = await status();
  assert.deepStrictEqual([s.daysSince, s.overdue], [0, false]);
});

test('fixed clock: daysSinceUtc and toUtcStamp on their own', async () => {
  const { daysSinceUtc, toUtcStamp } = await loadCore();
  assert.strictEqual(toUtcStamp(new Date('2026-12-31T23:59:59.999Z')), '2026-12-31 23:59:59');
  assert.strictEqual(daysSinceUtc('2026-01-01 00:00:00', new Date('2026-01-31T00:00:00Z')), 30);
  // The stamp is UTC: India's midnight (18:30 UTC the day before) is not a day boundary.
  assert.strictEqual(daysSinceUtc('2026-01-01 18:00:00', new Date('2026-01-01T19:00:00Z')), 0);
});
