// Backup (Phase 8B privacy + Phase 5 restore) — contact-key exclusion, absent≠clear, rollback+snapshot.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const CONTACT = ['daily_report_recipients', 'daily_report_whatsapp'];

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => {
  await H.stopApp();
  // The import writes an auto-snapshot beside the (temp) DB; clean them up.
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  try { for (const f of fs.readdirSync(os.tmpdir())) if (/^auto-snapshot-before-import-.*\.json$/.test(f)) fs.unlinkSync(path.join(os.tmpdir(), f)); } catch { /* ignore */ }
});
beforeEach(async () => {
  H.clearLedger();
  await H.put('/api/daily-report', { recipients: ['keep@gmail.com'], whatsappRecipients: ['+919999999999'], sendTimes: ['09:00'], whatsappSendTimes: ['10:00'] }, { cookie });
  await H.put('/api/budget', { budgetRupees: '500.00' }, { cookie });
});
const settingKeys = (backup) => backup.tables.settings.map((r) => r.key);

test('a default export contains NEITHER contact key (but keeps budget + schedule)', async () => {
  const b = (await H.get('/api/backup/export', { cookie })).json;
  const keys = settingKeys(b);
  assert.ok(!CONTACT.some((k) => keys.includes(k)), 'no contact keys: ' + JSON.stringify(keys));
  assert.ok(keys.includes('budget_paise') && keys.includes('daily_report_times'), 'budget + schedule kept');
});

test('an opt-in export contains the email contact key', async () => {
  const b = (await H.get('/api/backup/export?includeContacts=1', { cookie })).json;
  const keys = settingKeys(b);
  assert.ok(keys.includes('daily_report_recipients'), 'email contact key present: ' + JSON.stringify(keys));
});

test('importing an export with contact keys ABSENT leaves existing recipients intact', async () => {
  const dflt = (await H.get('/api/backup/export', { cookie })).json;   // no contacts
  // change the install's contacts, then import the default export (which omits them)
  await H.put('/api/daily-report', { recipients: ['other@gmail.com'] }, { cookie });
  const imp = await H.post('/api/backup/import', dflt, { cookie });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.json));
  const cfg = (await H.get('/api/daily-report', { cookie })).json;
  assert.deepStrictEqual(cfg.recipients, ['other@gmail.com'], 'absent contact key = leave untouched, not clear');
  assert.ok(cfg.sendTimes.length === 1, 'schedule still present (Daily Report still scheduled)');
});

test('an invalid import rolls back completely with the snapshot written', async () => {
  const before = (await H.get('/api/cash-out', { cookie })).json.entries.length;
  const good = (await H.get('/api/backup/export?includeContacts=1', { cookie })).json;
  // Passes row-level validation but violates the one-live-contract DB index on insert -> transaction
  // throws -> full rollback. Two live contracts:
  const bad = JSON.parse(JSON.stringify(good));
  bad.tables.contract = [
    { id: 1, contractor_name: 'A', area_of_work: 'x', ledger_code: '5.0', price_of_contract_paise: 100, date_signed: '2026-07-01', deleted_at: null, created_at: '2026-07-01 00:00:00', updated_at: '2026-07-01 00:00:00' },
    { id: 2, contractor_name: 'B', area_of_work: 'y', ledger_code: '5.0', price_of_contract_paise: 100, date_signed: '2026-07-01', deleted_at: null, created_at: '2026-07-01 00:00:00', updated_at: '2026-07-01 00:00:00' },
  ];
  const imp = await H.post('/api/backup/import', bad, { cookie });
  assert.notStrictEqual(imp.status, 200, 'a constraint-violating import must not succeed');
  assert.ok(imp.json.snapshot, 'a safety snapshot path is reported');
  const liveContracts = H.db.prepare('SELECT COUNT(*) n FROM contract WHERE deleted_at IS NULL').get().n;
  assert.ok(liveContracts <= 1, 'the one-live invariant survived the rolled-back import');
  const after = (await H.get('/api/cash-out', { cookie })).json.entries.length;
  assert.strictEqual(after, before, 'original data unchanged after rollback');
});

test('a pre-Phase-5-shaped backup (no contract_stated_paise) still imports', async () => {
  const b = (await H.get('/api/backup/export?includeContacts=1', { cookie })).json;
  for (const r of b.tables.cash_out) delete r.contract_stated_paise;
  const imp = await H.post('/api/backup/import', b, { cookie });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.json));
});
