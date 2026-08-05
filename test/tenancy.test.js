// Tenancy Phase 2 — schema + backfill (NO read/write filters yet). These tests assert the tenant
// DIMENSION exists and behaves per-tenant at the storage/index level; the app's cross-tenant READS
// stay unfiltered on purpose (the isolation harness still measures 60 leaks until Phase 3).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SIX = ['cash_out', 'cash_in', 'loans', 'contract', 'contract_payment_dates', 'contractor_payments'];

let userId;
before(async () => { await H.startApp(); userId = H.seedLoggedIn().user.id; });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

// ── Part A ──────────────────────────────────────────────────────────────────────────────────────
test('tenant_id is NOT NULL on all six tenant tables', () => {
  for (const t of SIX) {
    const col = H.db.prepare(`PRAGMA table_info(${t})`).all().find((c) => c.name === 'tenant_id');
    assert.ok(col, `${t} has a tenant_id column`);
    assert.strictEqual(col.notnull, 1, `${t}.tenant_id is NOT NULL`);
    assert.strictEqual(col.dflt_value, null, `${t}.tenant_id has NO default (a forgotten insert must hard-fail, not silently mis-tenant)`);
  }
});

test('an insert omitting tenant_id is rejected on every tenant table', () => {
  const cid = H.seedContract(); // a live parent for the two child tables
  const omit = {
    cash_out: "INSERT INTO cash_out (amount_paise, tx_date, by_type, ledger_code, contract_scope) VALUES (1,'2025-01-01','user','4.0','extra')",
    cash_in: "INSERT INTO cash_in (amount_paise, by_type) VALUES (1,'user')",
    loans: "INSERT INTO loans (amount_paise, bank_name) VALUES (1,'Bank')",
    contract: "INSERT INTO contract (contractor_name, price_of_contract_paise, date_signed) VALUES ('C',1,'2025-01-01')",
    contract_payment_dates: `INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (${cid},'2025-01-01')`,
    contractor_payments: `INSERT INTO contractor_payments (contract_id, pay_date, amount_paise) VALUES (${cid},'2025-01-01',1)`,
  };
  for (const [t, sql] of Object.entries(omit)) {
    assert.throws(() => H.db.prepare(sql).run(), /NOT NULL/, `${t}: omitting tenant_id must raise NOT NULL`);
  }
});

// ── Part B — the per-tenant contract index, tested DIRECTLY (not via the API) ─────────────────────
const insContract = (tenant, deleted = false) => Number(H.db.prepare(
  `INSERT INTO contract (contractor_name, price_of_contract_paise, date_signed, tenant_id, deleted_at) VALUES ('C',1,'2025-01-01', ?, ${deleted ? "datetime('now')" : 'NULL'})`
).run(tenant).lastInsertRowid);

test('per-tenant index: one live contract per tenant; a second live for the SAME tenant is refused', () => {
  insContract(userId);                                   // A's one live contract
  assert.throws(() => insContract(userId), /UNIQUE/, 'a second live contract for the same tenant is refused');
  const soft = insContract(userId, true);                // a soft-deleted one coexists with the live one
  assert.strictEqual(H.db.prepare('SELECT COUNT(*) n FROM contract WHERE tenant_id=? AND deleted_at IS NULL').get(userId).n, 1, 'still exactly one live');
  assert.throws(() => H.db.prepare('UPDATE contract SET deleted_at=NULL WHERE id=?').run(soft), /UNIQUE/, 'restoring a second live for the same tenant is refused');
});

test('two tenants can each hold a live contract simultaneously (impossible under the old db-wide index)', () => {
  const b = H.seedUser();
  insContract(userId);
  assert.doesNotThrow(() => insContract(b.id), 'tenant B creates a live contract while tenant A has one');
  assert.strictEqual(H.db.prepare('SELECT COUNT(*) n FROM contract WHERE deleted_at IS NULL').get().n, 2, 'two live contracts, one per tenant');
});

// ── Part C — settings ─────────────────────────────────────────────────────────────────────────────
test('per-tenant settings: writing tenant A budget leaves tenant B untouched', async () => {
  const A = H.seedLoggedIn();
  const B = H.seedLoggedIn();
  assert.strictEqual((await H.put('/api/budget', { budgetRupees: '1000' }, { cookie: A.cookie })).status, 200);
  assert.strictEqual((await H.put('/api/budget', { budgetRupees: '2000' }, { cookie: B.cookie })).status, 200);
  const val = (uid) => { const r = H.db.prepare("SELECT value FROM settings WHERE key='budget_paise' AND tenant_id=?").get(uid); return r ? r.value : null; };
  assert.strictEqual(val(A.user.id), '100000', "A's budget is its own row (₹1000)");
  assert.strictEqual(val(B.user.id), '200000', "B's budget is its own row (₹2000)");
  // re-writing B does not disturb A
  await H.put('/api/budget', { budgetRupees: '9999' }, { cookie: B.cookie });
  assert.strictEqual(val(A.user.id), '100000', "A's budget row is byte-identical after B writes again");
});

// ── Part C — edit locks ────────────────────────────────────────────────────────────────────────────
test('per-tenant edit locks: tenant A holding the lock does NOT block tenant B', async () => {
  const A = H.seedLoggedIn();
  const B = H.seedLoggedIn();
  assert.strictEqual((await H.post('/api/overview/lock', undefined, { cookie: A.cookie })).status, 200, 'A acquires its lock');
  const b = await H.post('/api/overview/lock', undefined, { cookie: B.cookie });
  assert.strictEqual(b.status, 200, 'B acquires ITS OWN lock while A still holds theirs (would be 409 under a global lock)');
  assert.strictEqual(b.json.lock.byMe, true, "B holds B's lock");
  // both locks coexist as distinct per-tenant scopes
  const scopes = H.db.prepare("SELECT scope FROM edit_locks ORDER BY scope").all().map((r) => r.scope);
  assert.deepStrictEqual(scopes, [`overview:${A.user.id}`, `overview:${B.user.id}`], 'two independent per-tenant lock rows');
});

// ── Part F — a pre-tenancy backup still imports ────────────────────────────────────────────────────
test('a pre-tenancy backup (rows carry no tenant_id) still imports and is re-owned by the importer', async () => {
  const { cookie, user } = H.seedLoggedIn();
  // Produce a valid backup for THIS user's tenant (the export is tenant-scoped), then STRIP tenant_id
  // from every row to look like a pre-tenancy file.
  H.seedContract({ contractorName: 'Imp', tenantId: user.id });
  H.seedCashOut({ byUserId: user.id, amountPaise: 4242, tenantId: user.id });
  H.db.prepare("INSERT INTO loans (amount_paise, bank_name, tenant_id) VALUES (7777,'ImpBank', ?)").run(user.id);
  const exp = await H.get('/api/backup/export?includeContacts=1', { cookie });
  const backup = exp.json;
  for (const t of SIX) for (const r of (backup.tables[t] || [])) delete r.tenant_id; // simulate pre-tenancy rows
  for (const r of (backup.tables.settings || [])) delete r.tenant_id;

  const imp = await H.post('/api/backup/import', backup, { cookie });
  assert.strictEqual(imp.status, 200, 'pre-tenancy backup imports: ' + JSON.stringify(imp.json));
  // every imported ledger row is stamped with the importing tenant (NOT NULL satisfied)
  for (const t of SIX) {
    const bad = H.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE tenant_id IS NULL`).get().n;
    assert.strictEqual(bad, 0, `${t}: no NULL tenant_id after import`);
  }
  assert.ok(H.db.prepare('SELECT 1 FROM cash_out WHERE amount_paise=4242 AND tenant_id=?').get(user.id), 'imported cash_out re-owned by the importer');
});

// ── Part A/F — the real pre->post migration (idempotency + sqlite_sequence) in a fresh process ─────
test('the pre->tenancy migration is idempotent and preserves sqlite_sequence (spawned)', () => {
  const r = spawnSync(process.execPath, ['test/_tenancy-migrate-fixture.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `migration fixture failed:\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
  assert.match(r.stdout, /FIXTURE OK/, 'fixture asserted the full migration + idempotency + sqlite_sequence survival');
});
