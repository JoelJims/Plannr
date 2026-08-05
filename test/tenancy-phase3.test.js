// Tenancy Phase 3 (Part D) — permanent cross-tenant isolation tests in the node:test suite (the
// harness is the scoreboard; these pin the specific guarantees). Two tenants A and B (each its own
// household in the current model). B must see NONE of A's rows, and a cross-tenant mutation must return
// 404 (NEVER 403 — a 403 confirms the row exists) leaving A byte-identical. Plus tenant-scoped import
// isolation: A importing leaves B untouched.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let A, B;
const rowJson = (table, id) => JSON.stringify(H.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null);

before(async () => {
  await H.startApp();
  A = H.seedLoggedIn({ username: 'tenantA', displayName: 'Tenant A' });
  B = H.seedLoggedIn({ username: 'tenantB', displayName: 'Tenant B' });
});
after(async () => { await H.stopApp(); });

// Seed A's data across every tenant table (under tenant A). Returns the ids.
function seedA() {
  const cid = H.seedContract({ contractorName: 'A Contractor', tenantId: A.user.id });
  const sid = Number(H.db.prepare("INSERT INTO contract_services (contract_id, name, price_paise, tenant_id) VALUES (?, 'A svc', 4000000, ?)").run(cid, A.user.id).lastInsertRowid);
  return {
    cid, sid,
    co: H.seedCashOut({ amountPaise: 987654, byUserId: A.user.id, tenantId: A.user.id }),
    ci: H.seedCashIn({ amountPaise: 111100, byUserId: A.user.id, tenantId: A.user.id }),
    loan: Number(H.db.prepare("INSERT INTO loans (amount_paise, bank_name, tenant_id) VALUES (5000000, 'A Bank', ?)").run(A.user.id).lastInsertRowid),
    pay: H.seedPayment({ contractId: cid, tenantId: A.user.id }),
  };
}

test("a second tenant reads NONE of the first tenant's rows", async () => {
  H.clearLedger();
  seedA();
  const empty = async (p, key) => { const r = await H.get(p, { cookie: B.cookie }); assert.strictEqual((r.json[key] || []).length, 0, `${p} empty for B`); };
  await empty('/api/cash-out', 'entries');
  await empty('/api/cash-in', 'entries');
  await empty('/api/loans', 'loans');
  await empty('/api/contracts', 'contracts');
  await empty('/api/contractor-payments', 'payments');
  // overview money is all zero for B; budget null
  const ov = await H.get('/api/overview', { cookie: B.cookie });
  for (const k of ['spentBySelfPaise', 'paidToContractorsPaise', 'totalSpentPaise', 'loanReceivedPaise', 'totalContractPaise', 'owedToContractorsPaise']) {
    assert.strictEqual(ov.json.money[k], 0, `overview ${k} is 0 for B`);
  }
  assert.strictEqual(ov.json.budgetPaise, null, 'B sees no budget');
  // trash + users + roster
  const trash = await H.get('/api/trash', { cookie: B.cookie });
  assert.strictEqual(Object.values(trash.json.trash).reduce((s, a) => s + a.length, 0), 0, 'B sees no trash of A');
  const users = await H.get('/api/users', { cookie: B.cookie });
  assert.ok(users.json.users.every((u) => u.id !== A.user.id), 'B roster excludes A');
});

test('cross-tenant MUTATIONS return 404 (never 403) and leave A byte-identical', async () => {
  H.clearLedger();
  const ids = seedA();
  const mut404 = async (method, p, table, id, body) => {
    const before = rowJson(table, id);
    const r = await H.req(method, p, { cookie: B.cookie, body });
    assert.strictEqual(r.status, 404, `${method} ${p} must be 404 for B (was ${r.status}; a 403 would confirm the row)`);
    assert.strictEqual(rowJson(table, id), before, `A's ${table}#${id} byte-identical after B's ${method}`);
  };
  const coBody = { amountRupees: '9', txDate: '2025-01-01', byType: 'custom', byLabel: 'B', ledgerCode: '4.0', contractScope: 'extra' };
  await mut404('PUT', `/api/cash-out/${ids.co}`, 'cash_out', ids.co, coBody);
  await mut404('DELETE', `/api/cash-out/${ids.co}`, 'cash_out', ids.co);
  await mut404('PUT', `/api/cash-in/${ids.ci}`, 'cash_in', ids.ci, { amountRupees: '9', txDate: '2025-01-01', byType: 'custom', byLabel: 'B' });
  await mut404('DELETE', `/api/cash-in/${ids.ci}`, 'cash_in', ids.ci);
  await mut404('PUT', `/api/loans/${ids.loan}`, 'loans', ids.loan, { amountRupees: '9', bankName: 'B' });
  await mut404('DELETE', `/api/loans/${ids.loan}`, 'loans', ids.loan);
  await mut404('PUT', `/api/contractor-payments/${ids.pay}`, 'contractor_payments', ids.pay, { contractId: ids.cid, payDate: '2025-01-01', amountRupees: '9' });
  await mut404('DELETE', `/api/contractor-payments/${ids.pay}`, 'contractor_payments', ids.pay);
  // contract PUT + nested service PUT/DELETE + contract DELETE
  await mut404('PUT', `/api/contracts/${ids.cid}`, 'contract', ids.cid, { contractorName: 'B', areaOfWork: 'x', ledgerCode: '5.0', statedAmountRupees: '1', dateSigned: '2025-01-01' });
  await mut404('PUT', `/api/contracts/${ids.cid}/services/${ids.sid}`, 'contract_services', ids.sid, { name: 'B', priceRupees: '1' });
  await mut404('DELETE', `/api/contracts/${ids.cid}/services/${ids.sid}`, 'contract_services', ids.sid);
  await mut404('DELETE', `/api/contracts/${ids.cid}`, 'contract', ids.cid);
});

test('cross-tenant Recycle-Bin restore + hard-delete return 404 and leave A byte-identical', async () => {
  H.clearLedger();
  // A soft-deletes its own rows so they sit in A's trash.
  const co = H.seedCashOut({ amountPaise: 222200, byUserId: A.user.id, tenantId: A.user.id, deletedAt: '2025-01-01 00:00:00' });
  const loan = Number(H.db.prepare("INSERT INTO loans (amount_paise, bank_name, tenant_id, deleted_at) VALUES (6000000,'A',?, '2025-01-01 00:00:00')").run(A.user.id).lastInsertRowid);
  const before = rowJson('cash_out', co);
  assert.strictEqual((await H.post(`/api/trash/cash_out/${co}/restore`, undefined, { cookie: B.cookie })).status, 404, 'B restore of A row -> 404');
  assert.strictEqual((await H.del(`/api/trash/cash_out/${co}`, { cookie: B.cookie })).status, 404, 'B hard-delete of A row -> 404');
  assert.strictEqual((await H.del(`/api/trash/loans/${loan}`, { cookie: B.cookie })).status, 404, 'B hard-delete of A loan -> 404');
  assert.strictEqual(rowJson('cash_out', co), before, "A's soft-deleted row is byte-identical after B's attempts");
});

test('tenant-scoped IMPORT: A importing leaves B byte-identical', async () => {
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
