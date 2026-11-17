// Step 1.4 B4: the next start after an upgrade that did not finish. Two fixes, both found by the
// failure tests (test/slow/migration-faults-v1.test.js):
//  1. legacyInit() mistook a half-upgraded contract_services (a v1 database whose upgrade stopped
//     after tenant_id was taken off it) for the pre-Phase-5 table and dropped it with every row. Now
//     a table with the Services-phase columns is kept, and an unrecognised old table that still holds
//     rows is set aside (contract_services_pre_phase5), never dropped.
//  2. Each failed start took a new safety snapshot, and three of them rotated out the only copy from
//     before the upgrade. Now that one is kept until an upgrade finishes
//     (safety-snapshots/plannr-upgrade-pending.json). The phone's side is in
//     test/safety-snapshots.test.js.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const L = require('./fixtures/schema-history/lib');
const H = require('./fixtures/schema-history/harness');

const MAN = L.manifest();
const V1 = MAN.fixtures.find((f) => f.userVersion === 1);
const CURRENT = MAN.fixtures[MAN.fixtures.length - 1];
const START = new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);
const MASK = L.maskSince(START);

let h;
before(() => { h = H.createHarness('plannr-upgrade-retry-'); });
after(() => h && h.cleanup());

const all = (db, sql) => { const d = new DatabaseSync(db, { readOnly: true }); try { return d.prepare(sql).all().map((r) => ({ ...r })); } finally { d.close(); } };
const edit = (db, fn) => { const d = new DatabaseSync(db); try { fn(d); } finally { d.close(); } };
const one = async (job) => (await h.runGroups([[job]]))[0][0];
const pendingRecord = (db) => {
  const f = path.join(path.dirname(db), 'safety-snapshots', 'plannr-upgrade-pending.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
const tableNames = (db) => all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
// A v1 fixture's contract_services replaced by a made-up pre-Phase-5 shape (that shape is older than
// the git history; all that matters is that it lacks the Services-phase columns), with `rows` rows.
function withOldShapeServices(db, rows) {
  edit(db, (d) => {
    d.exec('PRAGMA foreign_keys = OFF');
    const cashOutCols = d.prepare('PRAGMA table_info(cash_out)').all().map((c) => c.name);
    if (cashOutCols.includes('contract_service_id')) d.exec('UPDATE cash_out SET contract_service_id = NULL');
    d.exec('DROP TABLE contract_services');
    d.exec('CREATE TABLE contract_services (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER REFERENCES contract(id), name TEXT, units_covered INTEGER)');
    for (let i = 1; i <= rows; i++) d.prepare('INSERT INTO contract_services (contract_id, name, units_covered) VALUES (1, ?, ?)').run(`Old service ${i}`, i * 10);
  });
}

test('1a. a v1 database whose upgrade stopped after contract_services lost tenant_id: the next start keeps every row and finishes as if never interrupted', async () => {
  const ref = h.fresh(V1, 'ref');
  const db = h.fresh(V1, 'half');
  // What legacyInit()'s Step 2a leaves behind (it commits before user_version becomes 2).
  edit(db, (d) => {
    const cols = d.prepare('PRAGMA table_info(contract_services)').all().map((c) => c.name).filter((c) => c !== 'tenant_id');
    assert.ok(cols.includes('created_at') && cols.length === 7, cols.join());
    d.exec('PRAGMA foreign_keys = OFF');
    d.exec('BEGIN');
    d.exec(`CREATE TABLE cs_half (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      name TEXT NOT NULL, price_paise INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT)`);
    d.exec(`INSERT INTO cs_half (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM contract_services`);
    d.exec('DROP TABLE contract_services');
    d.exec('ALTER TABLE cs_half RENAME TO contract_services');
    d.exec('COMMIT');
  });
  const serviceRows = all(db, 'SELECT id, name FROM contract_services ORDER BY id');
  assert.ok(serviceRows.length > 0);
  const [[r0], [r1]] = await h.runGroups([[{ db: ref, run: 'init', approve: true }], [{ db, run: 'init', approve: true }]]);
  assert.ok(r0.ok, r0.error);
  assert.ok(r1.ok, `the next start finishes: ${r1.error || ''}`);
  assert.deepStrictEqual(all(db, 'SELECT id, name FROM contract_services ORDER BY id'), serviceRows, 'every service row is still there');
  assert.deepStrictEqual(L.fingerprintFile(db, { mask: MASK }), L.fingerprintFile(ref, { mask: MASK }), 'the same database as an uninterrupted upgrade');
  assert.deepStrictEqual(L.checks(db), { integrity: 'ok', foreignKeyViolations: 0 });
});

test('1b. an old (pre-Phase-5) contract_services that still holds rows is set aside with its rows, never dropped', async () => {
  const db = h.fresh(V1, 'old-shape-rows');
  withOldShapeServices(db, 2);
  const r = await one({ db, run: 'init', approve: true });
  assert.ok(r.ok, r.error);
  assert.ok(tableNames(db).includes('contract_services_pre_phase5'));
  assert.deepStrictEqual(all(db, 'SELECT id, contract_id, name, units_covered FROM contract_services_pre_phase5 ORDER BY id'),
    [{ id: 1, contract_id: 1, name: 'Old service 1', units_covered: 10 }, { id: 2, contract_id: 1, name: 'Old service 2', units_covered: 20 }]);
  const cols = all(db, 'PRAGMA table_info(contract_services)').map((c) => c.name);
  assert.deepStrictEqual(cols, ['id', 'contract_id', 'name', 'created_at', 'updated_at', 'deleted_at'], 'a new contract_services in the current shape');
  assert.deepStrictEqual(L.checks(db), { integrity: 'ok', foreignKeyViolations: 0 });
  assert.deepStrictEqual(all(db, "SELECT name FROM sqlite_master WHERE sql LIKE '%contract_services_pre_phase5%'").map((r) => r.name), ['contract_services_pre_phase5'],
    'nothing else refers to the table set aside');
  assert.ok(all(db, "SELECT name FROM sqlite_master WHERE name = 'cash_out'")[0] && all(db, 'PRAGMA foreign_key_list(cash_out)').filter((k) => k.from === 'contract_service_id').every((k) => k.table === 'contract_services'),
    'cash_out still points at the new contract_services');
  // The next start leaves it all alone.
  const fp = L.fingerprintFile(db, { mask: MASK });
  assert.ok((await one({ db, run: 'init', approve: true })).ok);
  assert.deepStrictEqual(L.fingerprintFile(db, { mask: MASK }), fp);
});

test('1c. an empty old contract_services is dropped and recreated, as before', async () => {
  const db = h.fresh(V1, 'old-shape-empty');
  withOldShapeServices(db, 0);
  const r = await one({ db, run: 'init', approve: true });
  assert.ok(r.ok, r.error);
  assert.ok(!tableNames(db).some((t) => t.startsWith('contract_services_pre_phase5')));
  assert.deepStrictEqual(all(db, 'PRAGMA table_info(contract_services)').map((c) => c.name), ['id', 'contract_id', 'name', 'created_at', 'updated_at', 'deleted_at']);
});

test('1d. both old shapes give the same database and the same writes through initSync() as through await init() (step 1.4 B5)', async () => {
  // No schema-history fixture has the old table, so the equivalence test never takes these paths.
  for (const rows of [2, 0]) {
    const a = h.fresh(V1, `old-shape-${rows}-init`);
    const b = h.fresh(V1, `old-shape-${rows}-initSync`);
    withOldShapeServices(a, rows);
    withOldShapeServices(b, rows);
    const [[ra], [rb]] = await h.runGroups([[{ db: a, run: 'init', approve: true, fault: { record: true } }], [{ db: b, run: 'initSync', approve: true, fault: { record: true } }]]);
    assert.ok(ra.ok && rb.ok, `${rows} row(s): ${ra.error || ''} ${rb.error || ''}`);
    const writes = (r) => r.log.filter((w) => !/^VACUUM INTO /.test(w)); // the snapshot's file name differs
    assert.ok(writes(ra).some((w) => /contract_services/.test(w)), `${rows} row(s): the old-shape step ran`);
    assert.deepStrictEqual(writes(rb), writes(ra), `${rows} row(s): the same writes, in the same order`);
    assert.deepStrictEqual(L.fingerprintFile(b, { mask: MASK }), L.fingerprintFile(a, { mask: MASK }), `${rows} row(s): the same database`);
  }
});

test('2a. an upgrade that keeps failing: the snapshot from before it survives every failed start, never more than 3; when one finishes it rotates out as usual', async () => {
  const db = h.fresh(CURRENT, 'retry');
  const base = L.fingerprintFile(db);
  const names = () => H.snapshotsBeside(db).map((s) => path.basename(s));
  let first;
  for (let i = 1; i <= 5; i++) {
    const r = await one({ db, run: 'init', approve: true, chain: { failAt: 3 } });
    assert.match(r.error || '', /v3 .*rolled back/, `start ${i} fails`);
    if (i === 1) first = names()[0];
    assert.ok(names().includes(first), `after ${i} failed starts the snapshot from before the upgrade is there`);
    assert.strictEqual(names().length, Math.min(i, 3), `after ${i} failed starts: ${names().join(', ')}`);
    assert.strictEqual(pendingRecord(db).snapshot, first);
  }
  assert.deepStrictEqual(L.fingerprintFile(path.join(path.dirname(db), 'safety-snapshots', first)), base, 'and it holds the database exactly as before the upgrade');
  // A start that finishes (only v3 this time): the record goes; the snapshot is still there.
  assert.ok((await one({ db, run: 'init', approve: true, chain: { upTo: 3 } })).ok);
  assert.strictEqual(pendingRecord(db), null, 'the record is removed once init() completes');
  assert.ok(names().includes(first));
  assert.strictEqual(names().length, 3);
  // The next upgrade (v4): the old one is an ordinary snapshot again and rotates out.
  assert.ok((await one({ db, run: 'init', approve: true, chain: { upTo: 4 } })).ok);
  assert.ok(!names().includes(first));
  assert.strictEqual(names().length, 3);
  assert.strictEqual(pendingRecord(db), null);
});

test('2b. initSync() (server.js until B17) also clears the record once it completes, and keeps the snapshot', async () => {
  const db = h.fresh(CURRENT, 'retry-sync');
  assert.ok(!(await one({ db, run: 'init', approve: true, chain: { failAt: 3 } })).ok);
  const first = path.basename(H.snapshotsBeside(db)[0]);
  assert.strictEqual(pendingRecord(db).snapshot, first);
  // Today's app has no numbered steps, so this start has nothing to upgrade and completes.
  assert.ok((await one({ db, run: 'initSync', approve: true })).ok);
  assert.strictEqual(pendingRecord(db), null);
  assert.deepStrictEqual(H.snapshotsBeside(db).map((s) => path.basename(s)), [first]);
});

test('2c. a record that cannot be read: nothing is deleted, and the upgrade still runs', async () => {
  const db = h.fresh(CURRENT, 'retry-bad-record');
  const dir = path.join(path.dirname(db), 'safety-snapshots');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(dir, `plannr-pre-migration-v2-to-v5-old-${i}.db`), 'x');
  fs.writeFileSync(path.join(dir, 'plannr-upgrade-pending.json'), '{not json');
  assert.ok((await one({ db, run: 'init', approve: true, chain: {} })).ok);
  assert.strictEqual(H.snapshotsBeside(db).length, 4, 'nothing deleted');
});
