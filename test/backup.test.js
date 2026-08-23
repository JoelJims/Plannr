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
  await H.put('/api/budget', { budgetRupees: '500.00' }, { cookie });
});
const settingKeys = (backup) => backup.tables.settings.map((r) => r.key);

test('a default export contains NEITHER contact key (but keeps budget)', async () => {
  const b = (await H.get('/api/backup/export', { cookie })).json;
  const keys = settingKeys(b);
  assert.ok(!CONTACT.some((k) => keys.includes(k)), 'no contact keys: ' + JSON.stringify(keys));
  assert.ok(keys.includes('budget_paise'), 'budget kept');
});

test('an invalid import rolls back completely with the snapshot written', async () => {
  const before = (await H.get('/api/cash-out', { cookie })).json.entries.length;
  const good = (await H.get('/api/backup/export?includeContacts=1', { cookie })).json;
  // Passes row-level validation (validateBackup checks each row in isolation, never cross-row
  // uniqueness) but violates the id PRIMARY KEY on the second INSERT -> transaction throws -> full
  // rollback. Two cash_out rows sharing the same id:
  const bad = JSON.parse(JSON.stringify(good));
  const dupeRow = (id) => ({
    id, amount_paise: 100, tx_date: '2026-07-01', by_type: 'user', by_user_id: null, by_label: null,
    ledger_code: '1.0', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null,
    reason: null, contract_scope: 'extra', contract_stated_paise: null, contract_service_id: null,
    created_at: '2026-07-01 00:00:00', updated_at: '2026-07-01 00:00:00', deleted_at: null,
  });
  bad.tables.cash_out = [dupeRow(1), dupeRow(1)]; // duplicate id -> PRIMARY KEY violation on insert
  const imp = await H.post('/api/backup/import', bad, { cookie });
  assert.notStrictEqual(imp.status, 200, 'a constraint-violating import must not succeed');
  assert.ok(imp.json.snapshot, 'a safety snapshot path is reported');
  const after = (await H.get('/api/cash-out', { cookie })).json.entries.length;
  assert.strictEqual(after, before, 'original data unchanged after rollback');
});

test('a pre-Phase-5-shaped backup (no contract_stated_paise) still imports', async () => {
  const b = (await H.get('/api/backup/export?includeContacts=1', { cookie })).json;
  for (const r of b.tables.cash_out) delete r.contract_stated_paise;
  const imp = await H.post('/api/backup/import', b, { cookie });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.json));
});
