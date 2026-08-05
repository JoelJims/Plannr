// Backup import re-ownership (server.js ~2218-2268). A cash_out/cash_in row whose by_user_id is not a
// user in THIS install must NOT fail the import: the by_user_id is dropped to NULL (displays as
// "Unknown" via the existing fallback) while by_type/by_label survive, and the count is reported as
// json.remappedUsers. We craft a backup with exactly two such rows and assert the whole contract.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => {
  await H.stopApp();
  // The successful import writes an auto-snapshot beside the (temp) DB; clean them up.
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  try { for (const f of fs.readdirSync(os.tmpdir())) if (/^auto-snapshot-before-import-.*\.json$/.test(f)) fs.unlinkSync(path.join(os.tmpdir(), f)); } catch { /* ignore */ }
});

test('rows with an unknown by_user_id import with by_user_id NULL, remappedUsers counted, by_type/by_label kept', async () => {
  H.clearLedger();
  // Start from a real (now-empty) export so the envelope/settings shape is exactly what the app writes,
  // then inject two rows whose by_user_id (999999) is not a user here.
  const backup = (await H.get('/api/backup/export?includeContacts=1', { cookie })).json;
  backup.tables.cash_out = [{
    id: 90001, amount_paise: 12300, tx_date: '2026-07-15', by_type: 'custom', by_user_id: 999999, by_label: 'Ghost Payer',
    ledger_code: '1.0', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null, reason: 'reown-out',
    contract_scope: 'extra', contract_stated_paise: null, contract_service_id: null,
    created_at: '2026-07-15 00:00:00', updated_at: '2026-07-15 00:00:00', deleted_at: null,
  }];
  backup.tables.cash_in = [{
    id: 90002, amount_paise: 45600, tx_date: '2026-07-16', by_type: 'custom', by_user_id: 999999, by_label: 'Ghost Giver',
    reason: 'reown-in', created_at: '2026-07-16 00:00:00', updated_at: '2026-07-16 00:00:00', deleted_at: null,
  }];

  const imp = await H.post('/api/backup/import', backup, { cookie });
  assert.strictEqual(imp.status, 200, JSON.stringify(imp.json));
  assert.strictEqual(imp.json.remappedUsers, 2, 'both unknown-user rows were remapped');

  const out = H.db.prepare('SELECT by_user_id, by_type, by_label FROM cash_out WHERE id = 90001').get();
  assert.strictEqual(out.by_user_id, null, 'unknown by_user_id dropped to NULL');
  assert.strictEqual(out.by_type, 'custom', 'by_type survives');
  assert.strictEqual(out.by_label, 'Ghost Payer', 'by_label survives');

  const inn = H.db.prepare('SELECT by_user_id, by_type, by_label FROM cash_in WHERE id = 90002').get();
  assert.strictEqual(inn.by_user_id, null, 'unknown by_user_id dropped to NULL');
  assert.strictEqual(inn.by_type, 'custom', 'by_type survives');
  assert.strictEqual(inn.by_label, 'Ghost Giver', 'by_label survives');
});
