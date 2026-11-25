// Share settings for "send the PDF to WhatsApp or email" (docs/share-and-reminder-pdf-plan.md,
// section 3): where PDFs go (whatsapp / email / ask), the email recipient(s) and the email subject.
// GET/PUT /api/share-settings live in core/routes/notification-times.js, so both hosts (server.js and
// the phone's public/local-api.js) already serve them. Runs in both passes.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });

const KEYS = "('share_target', 'share_email_to', 'share_email_subject')";
const stored = (key) => H.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
beforeEach(() => { H.db.prepare(`DELETE FROM settings WHERE key IN ${KEYS}`).run(); });

const DEFAULTS = { target: 'ask', emailTo: [], emailSubject: 'Plannr report – {date}' };

test('share settings: defaults, then saved and read back', async () => {
  const first = await H.get('/api/share-settings');
  assert.strictEqual(first.status, 200, 'GET /api/share-settings exists');
  assert.deepStrictEqual(first.json, DEFAULTS, 'nothing saved yet: ask each time, no recipient, the default subject');

  const set = await H.put('/api/share-settings', { target: 'email', emailTo: [' a@example.com ', 'b@example.org', 'A@example.com'], emailSubject: '  Site report  ' });
  assert.strictEqual(set.status, 200);
  const want = { target: 'email', emailTo: ['a@example.com', 'b@example.org'], emailSubject: 'Site report' };
  assert.deepStrictEqual(set.json, want, 'trimmed, repeats (any case) dropped');
  assert.deepStrictEqual((await H.get('/api/share-settings')).json, want);
  assert.strictEqual(stored('share_target').value, 'email');
  assert.deepStrictEqual(JSON.parse(stored('share_email_to').value), ['a@example.com', 'b@example.org']);
  assert.strictEqual(stored('share_email_subject').value, 'Site report');

  const commaList = await H.put('/api/share-settings', { target: 'whatsapp', emailTo: 'c@example.com, d@example.com', emailSubject: '' });
  assert.strictEqual(commaList.status, 200);
  assert.deepStrictEqual(commaList.json, { target: 'whatsapp', emailTo: ['c@example.com', 'd@example.com'], emailSubject: DEFAULTS.emailSubject }, 'a comma-separated text is accepted; an empty subject goes back to the default');
});

test('share settings: bad values are refused and change nothing', async () => {
  const good = { target: 'email', emailTo: ['a@example.com'], emailSubject: 'Report' };
  assert.strictEqual((await H.put('/api/share-settings', good)).status, 200);
  const bad = [
    { ...good, target: 'sms' },
    { ...good, target: undefined },
    { ...good, emailTo: ['not an address'] },
    { ...good, emailTo: ['a@example.com', 'b@'] },
    { ...good, emailTo: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com', 'f@example.com'] },
    { ...good, emailTo: 42 },
    { ...good, emailSubject: 'x'.repeat(121) },
    { ...good, emailSubject: 12 },
  ];
  for (const body of bad) {
    const r = await H.put('/api/share-settings', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.ok(r.json && typeof r.json.error === 'string' && r.json.error.length > 0, 'a plain error message');
  }
  assert.deepStrictEqual((await H.get('/api/share-settings')).json, good, 'unchanged after refused values');
  assert.strictEqual((await H.put('/api/share-settings', { ...good, emailSubject: 'x'.repeat(120) })).status, 200, '120 characters is allowed');
});

test('share settings: a damaged row reads as the default', async () => {
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('share_email_to', 'not json'), ('share_target', 'carrier pigeon')").run();
  assert.deepStrictEqual((await H.get('/api/share-settings')).json, DEFAULTS);
});

test('the email recipients are contact data: left out of a JSON backup unless contacts are asked for', async () => {
  assert.strictEqual((await H.put('/api/share-settings', { target: 'email', emailTo: ['a@example.com'], emailSubject: 'Report' })).status, 200);
  const plain = (await H.get('/api/backup/export')).json;
  assert.ok(!plain.tables.settings.some((s) => s.key === 'share_email_to'), 'no recipient in a plain backup');
  assert.ok(!JSON.stringify(plain).includes('a@example.com'), 'the address appears nowhere in a plain backup');
  assert.ok(plain.tables.settings.some((s) => s.key === 'share_target'), 'the target is not contact data and stays');
  const optIn = (await H.get('/api/backup/export?includeContacts=1')).json;
  assert.ok(optIn.tables.settings.some((s) => s.key === 'share_email_to'), 'included when contacts are asked for');
});
