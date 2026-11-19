// The two one-row settings routes in the core: the overall budget (core/routes/budget.js) and the
// reminder times on Home (core/routes/notification-times.js). Each value is written, then read back
// through its own GET, in both passes (server.js and the phone's public/local-api.js). The backup
// reminder's settings have their own file (test/backup-reminder.test.js).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

const KEYS = "('budget_paise', 'daily_report_times')";
const stored = (key) => H.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
beforeEach(() => { H.db.prepare(`DELETE FROM settings WHERE key IN ${KEYS}`).run(); });

test('budget: set, read back, clear; a bad value is refused and changes nothing', async () => {
  assert.deepStrictEqual((await H.get('/api/budget')).json, { budgetPaise: null }, 'unset reads as null');
  const set = await H.put('/api/budget', { budgetRupees: '1234.50' });
  assert.strictEqual(set.status, 200);
  assert.deepStrictEqual(set.json, { budgetPaise: 123450 });
  assert.deepStrictEqual((await H.get('/api/budget')).json, { budgetPaise: 123450 });
  assert.strictEqual(stored('budget_paise').value, '123450');

  const bad = await H.put('/api/budget', { budgetRupees: '-5' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /valid budget/);
  assert.deepStrictEqual((await H.get('/api/budget')).json, { budgetPaise: 123450 }, 'unchanged after a refused value');

  const cleared = await H.put('/api/budget', { budgetRupees: '' });
  assert.deepStrictEqual(cleared.json, { budgetPaise: null });
  assert.deepStrictEqual((await H.get('/api/budget')).json, { budgetPaise: null });
  assert.strictEqual(stored('budget_paise').value, null, 'the row stays, with no value');
});

test('reminder times: saved sorted without repeats, read back; bad lists refused; a damaged row reads as none', async () => {
  assert.deepStrictEqual((await H.get('/api/notification-times')).json, { times: [] }, 'none saved yet');
  const set = await H.put('/api/notification-times', { times: ['21:00', '08:30', ' 08:30 '] });
  assert.strictEqual(set.status, 200);
  assert.deepStrictEqual(set.json, { times: ['08:30', '21:00'] });
  assert.deepStrictEqual((await H.get('/api/notification-times')).json, { times: ['08:30', '21:00'] });

  for (const times of [['24:00'], ['8:30'], ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00'], 'not a list']) {
    const r = await H.put('/api/notification-times', { times });
    assert.strictEqual(r.status, 400, JSON.stringify(times));
  }
  assert.deepStrictEqual((await H.get('/api/notification-times')).json, { times: ['08:30', '21:00'] }, 'unchanged after refused lists');

  H.db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'daily_report_times'").run();
  assert.deepStrictEqual((await H.get('/api/notification-times')).json, { times: [] });
  const empty = await H.put('/api/notification-times', { times: [] });
  assert.deepStrictEqual(empty.json, { times: [] });
  assert.strictEqual(stored('daily_report_times').value, '[]');
});
