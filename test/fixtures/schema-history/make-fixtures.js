// Makes the schema-history fixtures (step 1.4 B4). Run by hand, never by the tests:
//
//   node test/fixtures/schema-history/make-fixtures.js
//
// For every commit that changed db.js, it runs THAT commit's db.js (from git) in its own temp folder,
// with PLANNR_DB pointing into that folder, so its init() builds a brand-new database exactly as that
// version of the app would have. It then adds made-up rows to every table (no real data) and saves
// the database as SQL text. Versions whose database comes out identical (ignoring timestamps) are
// kept once. It also saves the migration code as it was before B4 (runner-0e7b70b/), byte for byte
// from git, so the tests can keep running the OLD runner after db.js changes.
//
// It writes only inside this folder and the OS temp folder. It never opens data/plannr.db.
'use strict';
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const L = require('./lib');

const ROOT = path.join(__dirname, '..', '..', '..');
const OLD_RUNNER_COMMIT = '0e7b70b';
const COMMITS = ['7cfcf89', '2ebaf69', '42ff006', '6f2c653', '4b65b0f', 'bcafa73', 'ba3fb6a', '9ae518c', 'f89af97', '852445d', 'f9552fc', 'cb55abf', '8e89166', '266614c', 'd9c1ab3', 'e7b98d3'];
const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 64 << 20 });

// ---- child: run one old db.js's init() and add the made-up rows ------------------------------------
if (process.argv[2] === '--child') {
  const dir = process.argv[3];
  process.env.PLANNR_DB = path.join(dir, 'plannr.db');
  process.env.PLANNR_TEST = '1';
  const m = require(path.join(dir, 'db.js'));
  m.init();
  seed(m.db);
  m.db.close();
  process.exit(0);
}

// Made-up rows for whichever tables and columns this version has. Columns a version lacks are left
// out; a NOT NULL column with no default that this list does not know gets a generic value.
function seed(d) {
  const T = (i) => `2025-0${1 + (i % 8)}-1${i % 10} 0${i % 10}:15:00`;
  const has = (t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const colsOf = (t) => d.prepare(`PRAGMA table_info(${t})`).all();
  const insert = (t, row) => {
    const cols = colsOf(t);
    const names = new Set(cols.map((c) => c.name));
    const r = {};
    for (const [k, v] of Object.entries(row)) if (names.has(k)) r[k] = v;
    for (const c of cols) {
      if (c.name in r || c.pk || !c.notnull || c.dflt_value !== null) continue;
      if (c.name === 'tenant_id') r.tenant_id = 1;
      else r[c.name] = /INT/i.test(c.type) ? 1 : /REAL/i.test(c.type) ? 1.5 : `${c.name} value`;
    }
    if ('created_at' in r === false && names.has('created_at')) r.created_at = T(Object.keys(r).length);
    const keys = Object.keys(r);
    try {
      d.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => r[k]));
      return true;
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/.test(e.message)) return false; // this version allows only one (e.g. one contract per tenant)
      throw new Error(`${t}: ${e.message} (${JSON.stringify(r)})`);
    }
  };
  const ts = (i, deleted) => ({ created_at: T(i), updated_at: T(i + 1), deleted_at: deleted ? T(i + 2) : null, tenant_id: 1 });

  d.exec('BEGIN');
  // People: the owner (versions before the default-owner seed had none) and a helper.
  if (!d.prepare('SELECT 1 FROM users WHERE id = 1').get()) insert('users', { id: 1, username: 'owner', display_name: 'Owner', password_hash: 'local-single-user-no-auth', created_at: T(0) });
  insert('users', { id: 2, username: 'site-helper', display_name: 'Site helper (Ravi)', password_hash: 'local-single-user-no-auth', created_at: T(1) });
  if (has('sessions')) insert('sessions', { token_hash: 'ab'.repeat(32), user_id: 1, created_at: T(2), expires_at: '2025-12-01 00:00:00', ip: '127.0.0.1', user_agent: 'test agent' });
  if (has('edit_locks')) insert('edit_locks', { scope: 'ledger', holder_user_id: 1, holder_display_name: 'Owner', acquired_at: T(3), last_heartbeat_at: T(3) });

  // Categories: this version's own list if it keeps one in the database, plus a custom one.
  let codes = [['4.0', '4.2'], ['22.0', '22.5'], ['5.0', null]];
  if (has('ledger_mains')) {
    insert('ledger_mains', { code: '90', name: 'GARDEN & LANDSCAPING', sort_order: 900, created_at: T(4), updated_at: T(4) });
    insert('ledger_subs', { code: '90.1', main_code: '90', name: 'Lawn & turf', sort_order: 1, created_at: T(4), updated_at: T(5) });
    d.prepare("UPDATE ledger_subs SET name = name || ' (renamed)' WHERE code = (SELECT MIN(code) FROM ledger_subs WHERE main_code = (SELECT MIN(code) FROM ledger_mains))").run();
    const subs = d.prepare('SELECT main_code, code FROM ledger_subs ORDER BY sort_order, code LIMIT 40').all();
    codes = [[subs[0].main_code, subs[0].code], [subs[7].main_code, subs[7].code], [subs[20].main_code, null], ['90', '90.1']];
  }
  if (has('ledger_customs')) {
    insert('ledger_customs', { id: 1, name: 'Temple donation for bhoomi pooja', created_at: T(5), tenant_id: 1 });
    insert('ledger_customs', { id: 4, name: 'Neighbour wall repair — गेट', created_at: T(6), tenant_id: 1 });
  }

  // The contract and everything hanging off it.
  insert('contract', { id: 1, contractor_name: 'Example Builders', area_of_work: 'Civil work', company: 'Example Builders Pvt Ltd', ledger_code: codes[0][0], subledger_code: codes[0][1],
    amount_paise: 900000000, price_of_contract_paise: 900000000, contract_end_date: '2026-12-31', date_signed: '2025-05-30', rate_per_sqft_paise: 250000,
    measured_area_milli_sqft: 2400000, completion_period_months: 14, supervision_rate_pct: 2.5, specified_brands: 'Cement: Brand A', excluded_scope: 'Interiors', ...ts(6) });
  insert('contract', { id: 2, contractor_name: 'Old Painter', area_of_work: 'Painting', ledger_code: 'CUSTOM', ledger_custom_name: 'Painting work', amount_paise: 4500000, date_signed: '2025-04-01', ...ts(7, true) });
  const services = [['Excavation', 1500000], ['Plastering — प्लास्टर', null], ['Waterproofing', 250000]];
  services.forEach(([name, price], i) => insert('contract_services', { id: i + 1, contract_id: 1, name, price_paise: price, ...ts(8 + i, i === 2) }));
  if (has('contract_allowances')) {
    insert('contract_allowances', { id: 1, contract_id: 1, name: 'Tiles allowance', cap_kind: 'per_sqft', cap_rate_per_sqft_paise: 9000, area_milli_sqft: 1200000, sort_order: 1, ...ts(9) });
    insert('contract_allowances', { id: 2, contract_id: 1, name: 'Sanitary fittings', cap_kind: 'lump', cap_paise: 5000000, sort_order: 2, ...ts(10) });
  }
  ['2025-07-01', '2025-09-01', '2025-11-01'].forEach((pay_date, i) => insert('contract_payment_dates', { id: i + 1, contract_id: 1, pay_date, created_at: T(11 + i), tenant_id: 1 }));
  [[150000000, '2025-07-02', null, 'Advance — ₹1.5L', false], [200000000, '2025-09-03', 'CUSTOM', 'Second stage', false], [99, '2025-09-04', null, null, true], [250000000, '2025-11-02', null, 'Roof slab', false]]
    .forEach(([amount, date, ledger, remarks, deleted], i) => insert('contractor_payments', { id: i + 1, contract_id: 1, pay_date: date, amount_paise: amount,
      ledger_code: ledger || codes[1][0], subledger_code: ledger ? null : codes[1][1], ledger_custom_name: ledger ? 'Contractor extras' : null, subledger_custom_name: ledger ? 'Stage 2' : null,
      phase: i % 2 ? 2 : null, subpart: i % 2 ? 'b' : null, remarks, ...ts(12 + i, deleted) }));

  // Money in and out, loans, settings.
  [[50000000, 'user', 1, null, 'Savings'], [25000000, 'user', 2, null, 'Salary'], [1234500, 'relative', null, 'Father', 'Family contribution'],
    [99, 'relative', null, 'Brother — भाई', null], [300000000, 'user', 1, null, 'Loan disbursement'], [7500000, 'relative', null, 'Relative', 'Gift']]
    .forEach(([amount, by, uid, label, reason], i) => insert('cash_in', { id: i + 1, amount_paise: amount, tx_date: `2025-06-0${i + 1}`, by_type: by, by_user_id: uid, by_label: label, reason, ...ts(14 + i, i === 3) }));
  for (let i = 0; i < 10; i++) {
    const [ledger, sub] = codes[i % codes.length];
    const custom = i === 4;
    insert('cash_out', { id: i + 1, amount_paise: [123456, 99, 4500000, 78000, 250000, 1000000, 333, 5600000, 120000, 98000][i], tx_date: i === 9 ? null : `2025-07-${10 + i}`,
      by_type: i % 3 === 2 ? 'custom' : 'user', by_user_id: i % 3 === 2 ? null : 1 + (i % 2), by_label: i % 3 === 2 ? 'Mason' : null,
      ledger_code: custom ? 'CUSTOM' : ledger, subledger_code: custom ? null : sub, ledger_custom_name: custom ? 'Pooja flowers' : null, subledger_custom_name: custom ? 'Marigold — गेंदा' : null,
      reason: ['Stamp duty', 'Cement 50 bags', 'Steel rods', null, 'Pooja', 'Sand load', 'Nails', 'Tiles', 'Paint', 'Transport'][i],
      contract_scope: i % 2 ? 'included' : 'extra', contract_stated_paise: i === 1 ? 98 : null, phase: i % 4 === 1 ? 2 : null, subpart: i % 4 === 1 ? 'b' : null,
      contract_service_id: i === 1 ? 1 : null, contract_allowance_id: i === 2 ? 2 : null, ...ts(20 + i, i === 7) });
  }
  insert('loans', { id: 1, amount_paise: 2500000000, bank_name: 'Example Bank', interest_rate: 8.4, tenure: '15 years', ...ts(30) });
  insert('loans', { id: 2, amount_paise: 50000000, bank_name: 'Cooperative Society', interest_rate: 10.25, tenure: '3 years', ...ts(31, true) });
  for (const [key, value] of [['budget_paise', '5000000000'], ['backup_reminder_days', '14']]) insert('settings', { key, value, tenant_id: 1 });
  // AUTOINCREMENT counters ahead of the highest id (rows that were permanently deleted once).
  if (has('sqlite_sequence')) d.prepare("UPDATE sqlite_sequence SET seq = seq + 30 WHERE name IN ('cash_out', 'cash_in')").run();
  d.exec('COMMIT');
}

// ---- parent ---------------------------------------------------------------------------------------
const out = [];
const seen = new Map();
for (const [n, c] of COMMITS.entries()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `plannr-history-${c}-`));
  try {
    const src = git('show', `${c}:db.js`);
    fs.writeFileSync(path.join(dir, 'db.js'), src);
    if (/from '\.\/ledgers\.js'/.test(src.toString('utf8'))) fs.writeFileSync(path.join(dir, 'ledgers.js'), git('show', `${c}:ledgers.js`));
    const r = spawnSync(process.execPath, [__filename, '--child', dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`);
    const file = path.join(dir, 'plannr.db');
    const d = new DatabaseSync(file, { readOnly: true });
    let sql, fp;
    try {
      // The same database, ignoring when it was made: rows the old init() seeded carry today's time.
      fp = JSON.stringify(L.fingerprint(d, { mask: (t, col, type) => (type === 'text' && /^(created|updated)_at$/.test(col) ? 'T"<time>"' : null) }));
      const subject = git('log', '-1', '--format=%ad %s', '--date=short', c).toString('utf8').trim();
      sql = L.dumpSql(d, [
        `Plannr test database: the schema db.js built at commit ${c} (${subject}),`,
        'with made-up rows in every table (no real data). Made by make-fixtures.js; do not edit by hand.',
      ]);
    } finally { d.close(); }
    if (seen.has(fp)) { console.log(`${c}: same database as ${seen.get(fp)}, not kept`); continue; }
    seen.set(fp, c);
    // The SQL must rebuild the database exactly.
    const check = new DatabaseSync(':memory:');
    check.exec(sql);
    const back = JSON.stringify(L.fingerprint(check, { mask: (t, col, type) => (type === 'text' && /^(created|updated)_at$/.test(col) ? 'T"<time>"' : null) }));
    check.close();
    if (back !== fp) throw new Error(`${c}: the SQL text does not rebuild the same database`);
    const name = `${String(out.length + 1).padStart(2, '0')}-${c}.sql`;
    fs.writeFileSync(path.join(__dirname, name), sql);
    const fpu = JSON.parse(fp);
    out.push({ file: name, commit: c, userVersion: fpu.userVersion, tables: Object.fromEntries(Object.entries(fpu.tables).map(([t, v]) => [t, v.rows])), sha256: L.sha256(Buffer.from(sql, 'utf8')) });
    console.log(`${c}: kept as ${name} (user_version ${fpu.userVersion}, ${Object.keys(fpu.tables).length} tables)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  void n;
}

// The migration code as it was before B4, byte for byte.
const runnerDir = path.join(__dirname, `runner-${OLD_RUNNER_COMMIT}`);
fs.mkdirSync(runnerDir, { recursive: true });
const runner = {};
for (const f of ['db.js', 'ledgers.js']) {
  fs.writeFileSync(path.join(runnerDir, f), git('show', `${OLD_RUNNER_COMMIT}:${f}`));
  runner[f] = git('rev-parse', `${OLD_RUNNER_COMMIT}:${f}`).toString('utf8').trim();
}
fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify({
  note: 'Made by make-fixtures.js. sha256 is of each file\'s exact bytes; oldRunner.blobs are git blob ids at that commit.',
  oldRunner: { commit: OLD_RUNNER_COMMIT, dir: `runner-${OLD_RUNNER_COMMIT}`, blobs: runner },
  fixtures: out,
}, null, 2) + '\n');
console.log(`${out.length} fixtures; old runner saved in ${path.basename(runnerDir)}/`);
