// Phase 2, Step 1 — a fake but complete dataset for the backup round-trip tests. It puts at least one
// row in EVERY table (the tests fail if a table is ever left empty, so a new table must get fixture
// rows), and deliberately includes the cases that broke restores before backup format v2:
//   · a category and sub-category that a fresh install does not have (90 / 90.1) and renamed ones,
//   · a second person (users id 2) that entries point at,
//   · saved custom category names (ledger_customs),
//   · soft-deleted rows, NULLs, non-ASCII text, legacy phase/subpart values,
//   · AUTOINCREMENT counters ahead of the highest id (rows that were permanently deleted).
// No real data: every name, number and date here is made up.
//
// seedInto() and dumpAll() take a database handle and use only prepare()/exec(), so the same code
// runs against node:sqlite (desktop tests) and, passed as source text, against the phone's
// sqlite-wasm database inside Playwright (test-ui/backup-roundtrip.js). Keep them self-contained.

const NO_PASSWORD = 'local-single-user-no-auth';
const T0 = '2026-01-05 09:30:00';
const T1 = '2026-02-10 18:05:41';

const DATA = {
  // Children first. ledger_mains/ledger_subs and settings are edited in place, not cleared, so the
  // fresh install's own seeded categories and migration markers stay as they are.
  clearOrder: ['cash_out', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments', 'contract', 'cash_in', 'loans', 'ledger_customs', 'users'],
  insertOrder: ['users', 'ledger_customs', 'contract', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments', 'loans', 'cash_in', 'cash_out'],
  ledgerEdits: [
    ["UPDATE ledger_mains SET name = ?, updated_at = ? WHERE code = '22.0'", ['TAXES, FINANCE & INSURANCE (renamed)', T1]],
    ["UPDATE ledger_subs SET name = ?, updated_at = ? WHERE code = '22.5'", ['Home-loan interest', T1]],
    ['INSERT INTO ledger_mains (code, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['90', 'GARDEN & LANDSCAPING', 900, T0, T0]],
    ['INSERT INTO ledger_subs (code, main_code, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['90.1', '90', 'Lawn & turf', 1, T0, T0]],
    ['INSERT INTO ledger_subs (code, main_code, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['90.2', '90', 'Irrigation', 2, T0, T1]],
  ],
  rows: {
    users: [
      { id: 1, username: 'owner', display_name: 'Owner', password_hash: NO_PASSWORD, created_at: T0 },
      { id: 2, username: 'site-helper', display_name: 'Site helper (Ravi)', password_hash: NO_PASSWORD, created_at: T1 },
    ],
    ledger_customs: [
      { id: 1, name: 'Temple donation for bhoomi pooja', created_at: T0 },
      { id: 4, name: 'Neighbour wall repair — गेट', created_at: T1 },
    ],
    contract: [
      { id: 1, contractor_name: 'Sri Lakshmi Builders', area_of_work: 'Civil work, ground + 1', ledger_code: '22.0', subledger_code: '22.5', ledger_custom_name: null, subledger_custom_name: null,
        amount_paise: 1250000000, price_of_contract_paise: 1250000000, contract_end_date: '2026-12-31', date_signed: '2026-01-04', company: 'SLB Constructions Pvt Ltd',
        rate_per_sqft_paise: 220000, measured_area_milli_sqft: 1850500, completion_period_months: 11, supervision_rate_pct: 7.5,
        specified_brands: 'Cement: any ISI 53 grade\nSteel: Fe 500D', excluded_scope: 'Compound wall; sump', owner_obligations: 'Water & power on site',
        created_at: T0, updated_at: T1, deleted_at: null },
      { id: 3, contractor_name: 'Old quote (cancelled)', area_of_work: null, ledger_code: 'CUSTOM', subledger_code: null, ledger_custom_name: 'Misc', subledger_custom_name: null,
        amount_paise: null, price_of_contract_paise: null, contract_end_date: null, date_signed: null, company: null,
        rate_per_sqft_paise: null, measured_area_milli_sqft: null, completion_period_months: null, supervision_rate_pct: null,
        specified_brands: null, excluded_scope: null, owner_obligations: null,
        created_at: T0, updated_at: T0, deleted_at: T1 },
    ],
    contract_services: [
      { id: 1, contract_id: 1, name: 'Plastering', created_at: T0, updated_at: T0, deleted_at: null },
      { id: 2, contract_id: 1, name: 'Waterproofing (dropped)', created_at: T0, updated_at: T1, deleted_at: T1 },
    ],
    contract_allowances: [
      { id: 1, contract_id: 1, name: 'Tiles', cap_kind: 'per_sqft', cap_paise: null, cap_rate_per_sqft_paise: 8500, area_milli_sqft: 1200000, sort_order: 0, created_at: T0, updated_at: T0, deleted_at: null },
      { id: 2, contract_id: 1, name: 'Main door', cap_kind: 'lump', cap_paise: 4500000, cap_rate_per_sqft_paise: null, area_milli_sqft: null, sort_order: 1, created_at: T0, updated_at: T1, deleted_at: null },
    ],
    contract_payment_dates: [
      { id: 1, contract_id: 1, pay_date: '2026-03-01', created_at: T0 },
      { id: 2, contract_id: 1, pay_date: '2026-06-01', created_at: T0 },
    ],
    contractor_payments: [
      { id: 1, contract_id: 1, pay_date: '2026-03-02', amount_paise: 250000000, ledger_code: '22.0', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null,
        phase: 2, subpart: 'b', remarks: 'Foundation stage', created_at: T0, updated_at: T0, deleted_at: null },
      { id: 2, contract_id: 1, pay_date: '2026-04-15', amount_paise: 99, ledger_code: 'CUSTOM', subledger_code: 'CUSTOM', ledger_custom_name: 'Extra', subledger_custom_name: 'Labour tip',
        phase: null, subpart: null, remarks: null, created_at: T1, updated_at: T1, deleted_at: T1 },
    ],
    loans: [
      { id: 1, amount_paise: 3500000000, bank_name: 'Example Co-op Bank', interest_rate: 8.65, tenure: '20 years', created_at: T0, updated_at: T0, deleted_at: null },
    ],
    cash_in: [
      { id: 1, amount_paise: 1000000000, tx_date: '2026-01-10', by_type: 'user', by_user_id: 1, by_label: null, reason: 'Savings transfer', created_at: T0, updated_at: T0, deleted_at: null },
      { id: 2, amount_paise: 50000000, tx_date: null, by_type: 'relative', by_user_id: null, by_label: 'Uncle', reason: 'Gift', created_at: T0, updated_at: T1, deleted_at: null },
      { id: 5, amount_paise: 1, tx_date: '2026-02-01', by_type: 'user', by_user_id: 2, by_label: null, reason: 'Entered by mistake', created_at: T1, updated_at: T1, deleted_at: T1 },
    ],
    cash_out: [
      { id: 1, amount_paise: 123456, tx_date: '2026-01-12', by_type: 'user', by_user_id: 1, by_label: null, ledger_code: '90', subledger_code: '90.1', ledger_custom_name: null, subledger_custom_name: null,
        reason: 'Turf for the front yard', contract_scope: 'extra', contract_stated_paise: null, phase: null, subpart: null, contract_service_id: null, contract_allowance_id: null, created_at: T0, updated_at: T0, deleted_at: null },
      { id: 2, amount_paise: 7500000, tx_date: '2026-02-03', by_type: 'user', by_user_id: 2, by_label: null, ledger_code: '22.0', subledger_code: '22.5', ledger_custom_name: null, subledger_custom_name: null,
        reason: 'EMI interest — Feb', contract_scope: 'included', contract_stated_paise: 7400000, phase: 3, subpart: 'a', contract_service_id: 1, contract_allowance_id: null, created_at: T0, updated_at: T1, deleted_at: null },
      { id: 3, amount_paise: 250000, tx_date: null, by_type: 'custom', by_user_id: null, by_label: 'Mason', ledger_code: 'CUSTOM', subledger_code: 'CUSTOM', ledger_custom_name: 'Temple donation for bhoomi pooja', subledger_custom_name: 'Flowers',
        reason: null, contract_scope: 'included', contract_stated_paise: null, phase: null, subpart: null, contract_service_id: null, contract_allowance_id: 1, created_at: T1, updated_at: T1, deleted_at: null },
      { id: 9, amount_paise: 42, tx_date: '2026-02-04', by_type: 'contractor', by_user_id: null, by_label: 'Legacy row', ledger_code: '90', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null,
        reason: 'Deleted entry', contract_scope: 'extra', contract_stated_paise: null, phase: null, subpart: null, contract_service_id: null, contract_allowance_id: null, created_at: T1, updated_at: T1, deleted_at: T1 },
    ],
  },
  settings: [
    { key: 'budget_paise', value: '4200000000' },
    { key: 'backup_reminder_days', value: '14' },
    { key: 'fixture_note', value: 'ünïcödé ✓' },
  ],
  // Counters ahead of the highest id, as if later rows had been permanently deleted.
  sequences: { users: 3, ledger_customs: 6, contract: 5, cash_in: 8, cash_out: 40, loans: 2 },
};

function seedInto(db, data) {
  const ins = (t, r) => {
    const cols = Object.keys(r);
    db.prepare('INSERT INTO ' + t + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')').run(...cols.map((c) => r[c]));
  };
  db.exec('BEGIN');
  try {
    for (const t of data.clearOrder) db.prepare('DELETE FROM ' + t).run();
    for (const [sql, params] of data.ledgerEdits) db.prepare(sql).run(...params);
    for (const t of data.insertOrder) for (const r of (data.rows[t] || [])) ins(t, r);
    for (const r of data.settings) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(r.key, r.value);
    for (const [name, seq] of Object.entries(data.sequences)) {
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name);
      db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Every table, every column, every row (ordered by primary key), plus the AUTOINCREMENT counters and
// PRAGMA user_version — the "is this the same database?" fingerprint the round-trip tests compare.
function dumpAll(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const out = { tables: {}, sequences: [], userVersion: db.prepare('PRAGMA user_version').get().user_version };
  for (const t of tables) {
    const pk = db.prepare('PRAGMA table_info(' + t + ')').all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    out.tables[t] = db.prepare('SELECT * FROM ' + t + ' ORDER BY ' + (pk.length ? pk.join(', ') : 'rowid')).all().map((r) => Object.assign({}, r));
  }
  out.sequences = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all().map((r) => Object.assign({}, r));
  return out;
}

module.exports = { DATA, seedInto, dumpAll, NO_PASSWORD };
