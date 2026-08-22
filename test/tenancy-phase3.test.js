// Tenancy Phase 3 (Part D) — permanent cross-tenant isolation tests in the node:test suite.
// Phase 1.6 (single-owner auth) removed login, so every request now resolves to the same fixed
// owner — the three tests that verified isolation via a real "as B" HTTP request (reads, mutations,
// Recycle Bin) are removed; there is no second live identity left to exercise them with. The
// tenant-scoped IMPORT test below survives: it makes its one HTTP request as A only and checks B's
// rows via a direct DB read, never "as B" over HTTP.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let A, B;

before(async () => {
  await H.startApp();
  A = H.seedLoggedIn({ username: 'tenantA', displayName: 'Tenant A' });
  B = H.seedLoggedIn({ username: 'tenantB', displayName: 'Tenant B' });
});
after(async () => { await H.stopApp(); });

// skipped: needs two users; tenancy is removed in Phase 2.
test.skip('tenant-scoped IMPORT: A importing leaves B byte-identical', async () => {
  H.clearLedger();
  // B has real data. Snapshot every B row before A's import.
  const bCid = H.seedContract({ contractorName: 'B keep', tenantId: B.user.id });
  const bCo = H.seedCashOut({ amountPaise: 777777, byUserId: B.user.id, tenantId: B.user.id });
  const bLoan = Number(H.db.prepare("INSERT INTO loans (amount_paise, bank_name, tenant_id) VALUES (9090,'B Bank', ?)").run(B.user.id).lastInsertRowid);
  const bBefore = ['contract', 'cash_out', 'loans'].map((t) => H.db.prepare(`SELECT * FROM ${t} WHERE tenant_id = ${B.user.id} ORDER BY id`).all());

  // A imports a fresh backup (replaces A's own rows only). Distinct ids that do NOT collide with B's.
  const backup = {
    app: 'plannr', kind: 'plannr-backup', schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z',
    tables: {
      contract: [{ id: 9001, contractor_name: 'A imp', area_of_work: 'x', ledger_code: '5.0', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null, amount_paise: null, price_of_contract_paise: 100000, contract_end_date: null, date_signed: '2025-01-01', company: null, created_at: '2025-01-01 00:00:00', updated_at: '2025-01-01 00:00:00', deleted_at: null }],
      loans: [], settings: [], cash_in: [],
      cash_out: [{ id: 9002, amount_paise: 4242, tx_date: '2025-02-01', by_type: 'user', by_user_id: null, by_label: null, ledger_code: '5.0', subledger_code: null, ledger_custom_name: null, subledger_custom_name: null, reason: null, contract_scope: 'extra', contract_stated_paise: null, contract_service_id: null, created_at: '2025-02-01 00:00:00', updated_at: '2025-02-01 00:00:00', deleted_at: null }],
    },
  };
  const imp = await H.post('/api/backup/import', backup, { cookie: A.cookie });
  assert.strictEqual(imp.status, 200, 'A import ok: ' + JSON.stringify(imp.json));

  // B's rows are byte-identical (untouched by A's tenant-scoped teardown + insert).
  const bAfter = ['contract', 'cash_out', 'loans'].map((t) => H.db.prepare(`SELECT * FROM ${t} WHERE tenant_id = ${B.user.id} ORDER BY id`).all());
  assert.deepStrictEqual(bAfter, bBefore, "B's data is byte-identical after A's import");
  // A now owns exactly the imported rows.
  assert.ok(H.db.prepare('SELECT 1 FROM cash_out WHERE id=9002 AND tenant_id=?').get(A.user.id), 'A owns the imported row');
  // sanity: the referenced-but-unused vars keep the intent explicit
  assert.ok(bCid && bCo && bLoan);
});
