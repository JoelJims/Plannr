// Step 1.4 B6: legacyInit()'s oldest branches give the same writes and the same database through the
// old runner (db.js at 0e7b70b) and await init(). (Until B17 the transition initSync() was compared too.)
//
// The schema-history fixtures start at user_version 1, so they never reach the parts of legacyInit()
// written for databases older than that: the tx_date backfills, the Phase 5B and phase/subpart
// rebuilds, adding tenant_id (by ALTER on an empty table, by rebuild on a full one), the settings
// rebuild, the custom-name backfill, the owner row on an old database; and no fixture has a second
// household's rows for the Step 2a collapse to remove (L4, L5). test/fixtures/legacy-shapes/ holds made-up
// databases in those shapes (make-legacy-shapes.js). Each is upgraded both ways,
// with and without the approvals, and the two must agree write for write. Then every COMMIT of the
// upgrade is made to fail in turn (the rollback paths), and the two must still agree: the same
// error, the same writes, the same database.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const L = require('./fixtures/schema-history/lib');
const H = require('./fixtures/schema-history/harness');

const SHAPES_DIR = path.join(__dirname, 'fixtures', 'legacy-shapes');
const SHAPES = JSON.parse(fs.readFileSync(path.join(SHAPES_DIR, 'manifest.json'), 'utf8')).shapes;
const MAN = L.manifest();
const RUNNERS = ['old-init', 'init'];
const VARIANTS = [{ name: 'not approved', approve: false }, { name: 'approved', approve: true }];
const START = new Date(Date.now() - 2000).toISOString().replace('T', ' ').slice(0, 19);
const MASK = L.maskSince(START);
const writes = (r) => (r.log || []).filter((w) => !/^VACUUM INTO /.test(w));

let h, OLD_DB_JS;
const res = {}; // key -> { result, db }
const commitRuns = {}; // shape -> [{ at, runs: { runner: { result, db } } }]

function shapeSql(s) {
  const bytes = fs.readFileSync(path.join(SHAPES_DIR, s.file));
  assert.strictEqual(L.sha256(bytes), s.sha256, `${s.file} is byte for byte the file manifest.json describes`);
  return bytes.toString('utf8');
}
function base(s) {
  const file = path.join(h.tmp, `${s.file}.base.db`);
  if (!fs.existsSync(file)) { const d = new DatabaseSync(file); try { d.exec(shapeSql(s)); } finally { d.close(); } }
  return file;
}
function copyOf(s, ...parts) {
  const dir = path.join(h.tmp, s.file, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, 'plannr.db');
  fs.copyFileSync(base(s), db);
  return db;
}
// Jobs grouped by runner (each runner is one module), spread over child processes.
async function runAll(jobs) {
  const by = { 'old-init': [], init: [] };
  for (const j of jobs) by[j.run].push(j);
  await Promise.all(Object.entries(by).map(async ([run, list]) => {
    if (!list.length) return;
    const groups = list.map((j) => [j]);
    const out = await h.runGroups(groups, run === 'old-init' ? OLD_DB_JS : H.DB_JS);
    out.forEach((o, i) => { list[i].out = o[0]; });
  }));
}

before(async () => {
  h = H.createHarness('plannr-legacy-shapes-');
  const oldDir = path.join(h.tmp, 'old-runner');
  fs.mkdirSync(oldDir);
  for (const f of ['db.js', 'ledgers.js']) fs.copyFileSync(path.join(L.DIR, MAN.oldRunner.dir, f), path.join(oldDir, f));
  OLD_DB_JS = path.join(oldDir, 'db.js');

  // 1. Every shape, both variants, both runners, every write recorded.
  const jobs = [];
  for (const s of SHAPES) for (const v of VARIANTS) for (const r of RUNNERS) {
    jobs.push({ db: copyOf(s, v.approve ? 'approved' : 'plain', r), run: r, approve: v.approve, key: `${s.file}|${v.name}|${r}`, fault: { record: true } });
  }
  await runAll(jobs);
  for (const j of jobs) res[j.key] = { result: j.out, db: j.db };

  // 2. Each COMMIT of the approved upgrade fails in turn (write numbers from the old runner's log).
  const failJobs = [];
  for (const s of SHAPES) {
    const log = res[`${s.file}|approved|old-init`].result.log || [];
    const ats = log.map((w, i) => (w === 'COMMIT' ? i + 1 : 0)).filter(Boolean);
    commitRuns[s.file] = ats.map((at) => ({ at, runs: {} }));
    for (const c of commitRuns[s.file]) for (const r of RUNNERS) {
      const j = { db: copyOf(s, 'fail', String(c.at), r), run: r, approve: true, fault: { at: c.at, record: true } };
      j.c = c; failJobs.push(j);
    }
  }
  await runAll(failJobs);
  for (const j of failJobs) j.c.runs[j.run] = { result: j.out, db: j.db };

  // 3. A shape whose first approved start refuses: start each runner's result again (a copy of its
  //    folder, so the first start's files stay as they were for the tests above).
  const againJobs = [];
  for (const s of SHAPES.filter((x) => x.refusesFirstStart)) for (const r of RUNNERS) {
    const first = res[`${s.file}|approved|${r}`].db;
    const dir = path.join(h.tmp, s.file, 'second-start', r);
    fs.cpSync(path.dirname(first), dir, { recursive: true });
    againJobs.push({ db: path.join(dir, 'plannr.db'), run: r, approve: true, key: `${s.file}|second start|${r}`, fault: { record: true } });
  }
  await runAll(againJobs);
  for (const j of againJobs) res[j.key] = { result: j.out, db: j.db };
});
after(() => h && h.cleanup());

test('the legacy shapes are the files make-legacy-shapes.js wrote, all from before user_version 2', () => {
  assert.ok(SHAPES.length >= 4);
  for (const s of SHAPES) {
    shapeSql(s);
    assert.ok(s.userVersion < 2, s.file);
    const d = new DatabaseSync(base(s), { readOnly: true });
    try { assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, s.userVersion); } finally { d.close(); }
  }
});

for (const s of SHAPES) {
  for (const v of VARIANTS) {
    test(`${s.file} (${v.name}): old init() and await init() make the same writes and the same database`, () => {
      const [old, neu] = RUNNERS.map((r) => res[`${s.file}|${v.name}|${r}`]);
      assert.deepStrictEqual({ ok: neu.result.ok, error: neu.result.error }, { ok: old.result.ok, error: old.result.error }, 'await init(): same outcome as the old init()');
      const want = L.fingerprintFile(old.db, { mask: MASK });
      assert.deepStrictEqual(L.fingerprintFile(neu.db, { mask: MASK }), want, 'await init(): same database');
      assert.ok(writes(neu.result).length > 50, `the upgrade wrote (${writes(neu.result).length} writes)`);
      assert.deepStrictEqual(writes(neu.result), writes(old.result), 'the same writes as the old init(), in the same order');
      if ((v.approve || s.approvedInSettings) && !s.refusesFirstStart) { // L2 and L3 store the approvals they need as settings
        assert.ok(old.result.ok, old.result.error);
        assert.strictEqual(want.userVersion, 2);
        assert.deepStrictEqual(L.checks(old.db), { integrity: 'ok', foreignKeyViolations: 0 });
      }
      if (v.approve && s.refusesFirstStart) {
        assert.ok(!old.result.ok && new RegExp(`row-count guard failed for ${s.refusesFirstStart}`).test(old.result.error), old.result.error);
        assert.strictEqual(want.userVersion, s.userVersion, 'the version is not stamped');
      }
      for (const snap of H.snapshotsBeside(neu.db)) assert.deepStrictEqual(L.fingerprintFile(snap), L.fingerprintFile(base(s)), 'the snapshot is the database before the upgrade');
      assert.strictEqual(H.snapshotsBeside(neu.db).length, 1, 'a snapshot was taken before the upgrade');
    });
  }
}

// What the oldest branches did, read from the upgraded database (so a branch that silently stopped
// running fails here even if both runners agreed).
const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const open = (s) => new DatabaseSync(res[`${s}|approved|init`].db, { readOnly: true });
const shapeFile = (prefix) => SHAPES.find((s) => s.file.startsWith(prefix)).file;

test('L1: tx_date backfilled, Phase 5B rebuild kept every row and the counter, tenant_id added then removed, settings and custom names carried', () => {
  const d = open(shapeFile('L1'));
  const b = new DatabaseSync(base(SHAPES.find((s) => s.file.startsWith('L1'))), { readOnly: true });
  try {
    assert.deepStrictEqual(d.prepare('SELECT id FROM cash_in WHERE tx_date IS NULL OR tx_date <> date(created_at)').all(), [], 'cash_in.tx_date = date(created_at)');
    assert.deepStrictEqual(d.prepare('SELECT id FROM cash_out WHERE tx_date IS NULL OR tx_date <> date(created_at)').all(), [], 'cash_out.tx_date = date(created_at)');
    assert.ok(cols(d, 'cash_out').includes('contract_stated_paise') && !cols(d, 'cash_out').includes('units_covered'));
    assert.deepStrictEqual(d.prepare('SELECT id, amount_paise FROM cash_out ORDER BY id').all(), b.prepare('SELECT id, amount_paise FROM cash_out ORDER BY id').all(), 'every cash_out row and id');
    assert.strictEqual(d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'cash_out'").get().seq, b.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'cash_out'").get().seq, 'the AUTOINCREMENT counter is kept');
    for (const t of ['cash_out', 'cash_in', 'loans', 'contract', 'contract_payment_dates', 'contractor_payments', 'settings', 'ledger_customs', 'contract_services']) assert.ok(!cols(d, t).includes('tenant_id'), `${t} has no tenant_id`);
    for (const r of b.prepare('SELECT key, value FROM settings').all()) assert.deepStrictEqual({ ...d.prepare('SELECT value FROM settings WHERE key = ?').get(r.key) }, { value: r.value }, `setting ${r.key} kept`);
    assert.ok(d.prepare("SELECT 1 FROM ledger_customs WHERE name = 'Pooja flowers'").get(), 'the custom name in use became selectable');
    assert.ok(cols(d, 'contract').includes('company') && cols(d, 'contract').includes('contract_end_date'));
  } finally { d.close(); b.close(); }
});

test('L2: the phase/subpart rebuild maps old values to the new scalars', () => {
  const d = open(shapeFile('L2'));
  try {
    assert.ok(!cols(d, 'cash_out').includes('phase_custom_name') && !cols(d, 'cash_out').includes('subpart_custom_name'));
    const rows = d.prepare('SELECT id, phase, typeof(phase) AS pt, subpart FROM cash_out ORDER BY id').all();
    const wantPhase = { 0: 3, 1: null, 2: null, 3: null, 4: 1 };
    const wantSub = { 0: 'b', 1: null, 2: null, 3: 'c' };
    for (const r of rows) {
      assert.strictEqual(r.phase, wantPhase[r.id % 5], `row ${r.id} phase`);
      if (r.phase !== null) assert.strictEqual(r.pt, 'integer');
      assert.strictEqual(r.subpart, wantSub[r.id % 4], `row ${r.id} subpart`);
    }
  } finally { d.close(); }
});

test('L3: an old database with no users gets the owner row; the taxonomy wipe approved in settings ran', () => {
  for (const v of VARIANTS) {
    const d = new DatabaseSync(res[`${shapeFile('L3')}|${v.name}|init`].db, { readOnly: true });
    try {
      assert.deepStrictEqual(d.prepare('SELECT username FROM users').all().map((u) => u.username), ['owner'], `${v.name}: the owner row`);
      assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM cash_in').get().n, 6, `${v.name}: every cash_in row kept`);
      assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM cash_out').get().n, 0, `${v.name}: the approved wipe emptied cash_out`);
      assert.deepStrictEqual({ ...d.prepare("SELECT value FROM settings WHERE key = '_migrated_ledger_taxonomy_v1'").get() }, { value: '1' }, `${v.name}: the taxonomy marker is set`);
    } finally { d.close(); }
  }
});

test('L1 without approval: the service price drop is refused, the version is not stamped and no row is lost', () => {
  const r = res[`${shapeFile('L1')}|not approved|init`];
  assert.ok(!r.result.ok && /PLANNR_ALLOW_SERVICE_PRICE_DROP/.test(r.result.error), r.result.error);
  const d = new DatabaseSync(r.db, { readOnly: true });
  const b = new DatabaseSync(base(SHAPES.find((x) => x.file.startsWith('L1'))), { readOnly: true });
  try {
    assert.strictEqual(d.prepare('PRAGMA user_version').get().user_version, 0, 'not stamped, so the next start asks again');
    for (const t of ['cash_out', 'cash_in', 'contract', 'contractor_payments', 'settings']) {
      assert.strictEqual(d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, b.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, `${t}: every row kept`);
    }
  } finally { d.close(); b.close(); }
});

// After the Step 2a collapse: exactly the first household's rows; its setting wins a shared key.
function firstHouseholdOnly(s, file) {
  const b = new DatabaseSync(base(s), { readOnly: true });
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const u1 = b.prepare('SELECT MIN(id) AS id FROM users').get().id;
    const wiped = !b.prepare("SELECT 1 FROM settings WHERE key = '_migrated_ledger_taxonomy_v1'").get(); // the approved wipe empties cash_out
    const tables = ['contract', 'contract_payment_dates', 'contractor_payments', 'contract_services', 'cash_in', 'loans', 'ledger_customs', ...(wiped ? [] : ['cash_out'])];
    let removed = 0;
    for (const t of tables) {
      const want = b.prepare(`SELECT id FROM ${t} WHERE tenant_id = ? ORDER BY id`).all(u1).map((r) => r.id);
      removed += b.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id <> ?`).get(u1).n;
      assert.deepStrictEqual(d.prepare(`SELECT id FROM ${t} ORDER BY id`).all().map((r) => r.id), want, `${t}: exactly the first household's rows`);
    }
    assert.ok(removed >= tables.length - 1, `the fixture had second-household rows to remove (${removed})`);
    const shared = b.prepare("SELECT key FROM settings WHERE tenant_id <> ? AND key <> 'second_household_only'").get(u1).key;
    assert.deepStrictEqual({ ...d.prepare('SELECT value FROM settings WHERE key = ?').get(shared) }, { ...b.prepare('SELECT value FROM settings WHERE key = ? AND tenant_id = ?').get(shared, u1) }, `${shared}: the first household's value`);
    assert.deepStrictEqual({ ...d.prepare("SELECT value FROM settings WHERE key = 'second_household_only'").get() }, { value: '1' }, 'a key only the second household had is kept');
    assert.ok(!cols(d, 'settings').includes('tenant_id'));
  } finally { d.close(); b.close(); }
}

test("L4: the Step 2a collapse keeps exactly the first household's rows; its setting wins a shared key", () => {
  firstHouseholdOnly(SHAPES.find((x) => x.file.startsWith('L4')), res[`${shapeFile('L4')}|approved|init`].db);
});

// The old runner is no reference for the second start: before the B4 fix it took the already
// rebuilt contract_services for the pre-Services one and dropped it (docs/step-1.4-storage-plan.md,
// B4 "Found by the failure tests"), which then fails the cash_out foreign-key check.
test('L5: the cascade is not counted, so the first start refuses; the next start finishes', () => {
  const s = SHAPES.find((x) => x.file.startsWith('L5'));
  const [old, neu] = RUNNERS.map((r) => res[`${s.file}|second start|${r}`]);
  assert.ok(!old.result.ok && /cash_out tenant rebuild: foreign_key_check found .*contract_services/.test(old.result.error), `the old runner's known pre-B4 failure (${old.result.error})`);
  assert.ok(neu.result.ok, neu.result.error);
  assert.ok(writes(neu.result).length > 50, `the second start wrote (${writes(neu.result).length} writes)`);
  const want = L.fingerprintFile(neu.db, { mask: MASK });
  assert.strictEqual(want.userVersion, 2);
  assert.deepStrictEqual(L.checks(neu.db), { integrity: 'ok', foreignKeyViolations: 0 });
  firstHouseholdOnly(s, neu.db);
  const before = JSON.stringify(L.fingerprintFile(base(s)));
  for (const r of [neu]) {
    assert.ok(H.snapshotsBeside(r.db).some((f) => JSON.stringify(L.fingerprintFile(f)) === before), 'the snapshot from before the first start is still there');
  }
});

test('every COMMIT of each old upgrade, made to fail: both runners report the same error, make the same writes and leave the same database', () => {
  let n = 0;
  for (const s of SHAPES) {
    assert.ok(commitRuns[s.file].length >= 5, `${s.file}: ${commitRuns[s.file].length} commits`);
    for (const c of commitRuns[s.file]) {
      const [old, neu] = RUNNERS.map((r) => c.runs[r]);
      const where = `${s.file}, COMMIT at write ${c.at}`;
      assert.ok(!old.result.ok && /INJECTED FAULT/.test(old.result.error), `${where}: the old runner failed there (${old.result.error})`);
      for (const r of [neu]) {
        assert.strictEqual(r.result.error, old.result.error, `${where}: same error`);
        assert.deepStrictEqual(writes(r.result), writes(old.result), `${where}: same writes`);
        assert.deepStrictEqual(L.fingerprintFile(r.db, { mask: MASK }), L.fingerprintFile(old.db, { mask: MASK }), `${where}: same database`);
      }
      assert.deepStrictEqual(L.checks(neu.db), { integrity: 'ok', foreignKeyViolations: L.checks(old.db).foreignKeyViolations }, `${where}: the file is sound`);
      n++;
    }
  }
  assert.ok(n >= 15, `${n} failure points`);
});
