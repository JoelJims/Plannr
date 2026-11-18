// Step 1.4 B6: test databases in the shapes from BEFORE user_version 1, which legacyInit() still
// upgrades but which no db.js in this repository's history ever built (the schema-history fixtures
// start at user_version 1). Without them, legacyInit()'s oldest branches (the tx_date backfills, the
// Phase 5B and phase/subpart rebuilds, the tenant_id additions, the settings rebuild, the custom-name
// backfill, the owner row on an old database) are never run by any test.
//
// These shapes are MADE UP from the oldest schema-history fixture (01-7cfcf89.sql): each table is
// rebuilt in the older form that legacyInit() checks for, keeping every row, id and AUTOINCREMENT
// counter. They are not copies of real historical files; what matters is that the old runner
// (0e7b70b) upgrades them, so the new runners can be compared against it write for write
// (test/migration-legacy-shapes.test.js). All names and amounts are the fixture's made-up ones.
//
//   node test/fixtures/legacy-shapes/make-legacy-shapes.js   (rewrites the .sql files and manifest.json)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const L = require('../schema-history/lib');

const OUT = __dirname;
const SOURCE = L.manifest().fixtures[0]; // 01-7cfcf89.sql, user_version 1

// Rebuild `table` with `ddl` (the older shape), copying the columns both shapes have, by name.
function reshape(d, table, ddl, { fill = {} } = {}) {
  const oldCols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const seq = d.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table);
  d.exec(`ALTER TABLE ${table} RENAME TO ${table}__old`);
  d.exec(ddl);
  const newCols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const cols = newCols.filter((c) => oldCols.includes(c) || c in fill);
  const sel = cols.map((c) => (c in fill ? fill[c] : c)).join(', ');
  d.exec(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel} FROM ${table}__old ORDER BY rowid`);
  d.exec(`DROP TABLE ${table}__old`);
  // The counter goes back as an INTEGER literal (node:sqlite binds a JS number as REAL).
  if (seq) { d.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table); d.exec(`INSERT INTO sqlite_sequence (name, seq) VALUES ('${table}', ${Math.trunc(Number(seq.seq))})`); }
}

const TS = "created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT";

// Before tenancy (user_version 0): no tenant_id anywhere, settings keyed by key alone, the
// database-wide one-live-contract index, no contract.company / contract_end_date.
function preTenancy(d) {
  reshape(d, 'cash_in', `CREATE TABLE cash_in (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, reason TEXT, ${TS})`);
  reshape(d, 'loans', `CREATE TABLE loans (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, bank_name TEXT, interest_rate REAL, tenure TEXT, ${TS})`);
  reshape(d, 'contract', `CREATE TABLE contract (id INTEGER PRIMARY KEY AUTOINCREMENT, contractor_name TEXT NOT NULL, area_of_work TEXT, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, amount_paise INTEGER, price_of_contract_paise INTEGER, date_signed TEXT, ${TS})`);
  reshape(d, 'contract_payment_dates', "CREATE TABLE contract_payment_dates (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE, pay_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  reshape(d, 'contractor_payments', `CREATE TABLE contractor_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id), pay_date TEXT NOT NULL, amount_paise INTEGER NOT NULL, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, phase INTEGER, subpart TEXT, remarks TEXT, ${TS})`);
  reshape(d, 'settings', 'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  // Services-era custom names, made with tenant_id at creation and still empty: the backfill fills it.
  d.exec('DELETE FROM ledger_customs');
  d.exec('DROP INDEX IF EXISTS idx_contract_single_live_tenant');
  const live = d.prepare('SELECT COUNT(*) AS n FROM contract WHERE deleted_at IS NULL').get().n;
  if (live > 1) throw new Error(`the source fixture has ${live} live contracts; the old index allows one`);
  d.exec('CREATE UNIQUE INDEX idx_contract_single_live ON contract((1)) WHERE deleted_at IS NULL');
}

const SHAPES = [
  {
    file: 'L1-pre-tenancy.sql',
    approvedInSettings: false,
    what: 'user_version 0, before tenancy, before Phase 1 and 4C (no tx_date), before Phase 5B (cash_out keeps the old contract_service_id and units_covered, no contract_stated_paise); loans empty, every other tenant table has rows; settings rows; an empty Services-era ledger_customs',
    make(d) {
      preTenancy(d);
      reshape(d, 'cash_out', `CREATE TABLE cash_out (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, ledger_code TEXT NOT NULL, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, reason TEXT, contract_scope TEXT NOT NULL, contract_service_id INTEGER REFERENCES contract_services(id), units_covered INTEGER, phase INTEGER, subpart TEXT, ${TS})`,
        { fill: { units_covered: 'CASE WHEN contract_service_id IS NULL THEN NULL ELSE 1 END' } });
      d.exec('DELETE FROM loans');
      d.exec('CREATE INDEX idx_cash_out_ledger_code ON cash_out(ledger_code)');
      // The ledger-taxonomy move already happened, so the wipe is not asked for; the service price drop still is.
      d.exec("INSERT INTO settings (key, value) VALUES ('_migrated_ledger_taxonomy_v1', '1')");
    },
  },
  {
    file: 'L2-phase-custom.sql',
    approvedInSettings: true,
    what: "user_version 0, before tenancy, cash_out in the old phase/subpart design (text values, 'CUSTOM' sentinels, phase_custom_name / subpart_custom_name), without the services link; cash_in already dated; taxonomy already moved and the service price drop approved in settings",
    make(d) {
      preTenancy(d);
      d.exec('ALTER TABLE cash_in ADD COLUMN tx_date TEXT');
      d.exec('UPDATE cash_in SET tx_date = substr(created_at, 1, 10)');
      reshape(d, 'cash_out', `CREATE TABLE cash_out (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, ledger_code TEXT NOT NULL, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, reason TEXT, contract_scope TEXT NOT NULL, phase TEXT, subpart TEXT, phase_custom_name TEXT, subpart_custom_name TEXT, ${TS})`,
        { fill: {
          phase: "CASE id % 5 WHEN 0 THEN '3' WHEN 1 THEN 'CUSTOM' WHEN 2 THEN '2a' WHEN 3 THEN NULL ELSE '1' END",
          subpart: "CASE id % 4 WHEN 0 THEN 'B' WHEN 1 THEN 'CUSTOM' WHEN 2 THEN 'ab' ELSE 'c' END",
          phase_custom_name: "CASE id % 5 WHEN 1 THEN 'Plinth extra' ELSE NULL END",
          subpart_custom_name: "CASE id % 4 WHEN 1 THEN 'Side wall' ELSE NULL END",
        } });
      // Taxonomy already moved; the service price drop approved through settings, so this one upgrades either way.
      d.exec("INSERT INTO settings (key, value) VALUES ('_migrated_ledger_taxonomy_v1', '1'), ('_service_price_drop_approved', '1')");
    },
  },
  {
    file: 'L3-no-users.sql',
    approvedInSettings: true,
    what: 'L1 with no users, sessions or edit locks (by_user_id cleared): the owner row is added to an old database before the tenant backfill; before the taxonomy move, with both one-off approvals stored as settings (so the cash_out wipe runs)',
    make(d) {
      SHAPES[0].make(d);
      // contract_services.tenant_id points at users too, so with no users it holds no rows.
      d.exec('UPDATE cash_in SET by_user_id = NULL; UPDATE cash_out SET by_user_id = NULL, contract_service_id = NULL, units_covered = NULL;');
      d.exec('DELETE FROM contract_services; DELETE FROM sessions; DELETE FROM edit_locks; DELETE FROM users;');
      // Before the taxonomy move, with both one-off approvals stored as settings: the wipe runs either way.
      d.exec("DELETE FROM settings WHERE key = '_migrated_ledger_taxonomy_v1'");
      d.exec("INSERT INTO settings (key, value) VALUES ('_taxonomy_wipe_approved', '1'), ('_service_price_drop_approved', '1')");
    },
  },
];

function build() {
  const entries = [];
  for (const s of SHAPES) {
    const d = new DatabaseSync(':memory:');
    d.exec(L.fixtureSql(SOURCE));
    d.exec('PRAGMA foreign_keys = OFF');
    d.exec('PRAGMA legacy_alter_table = ON'); // a rename must not rewrite other tables' references to it
    d.exec('BEGIN');
    s.make(d);
    d.exec('PRAGMA user_version = 0');
    d.exec('COMMIT');
    const fk = d.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) throw new Error(`${s.file}: foreign key problems ${JSON.stringify(fk)}`);
    const sql = L.dumpSql(d, [`Made by make-legacy-shapes.js from ${SOURCE.file}. MADE-UP data, made-up older shape:`, s.what]);
    // The dump must load back to exactly this database.
    const back = new DatabaseSync(':memory:');
    back.exec(sql);
    const fa = L.fingerprint(back), fb = L.fingerprint(d);
    for (const k of Object.keys(fb)) {
      if (JSON.stringify(fa[k]) === JSON.stringify(fb[k])) continue;
      const parts = Object.keys({ ...fa[k], ...fb[k] }).filter((p) => JSON.stringify(fa[k][p]) !== JSON.stringify(fb[k][p]));
      throw new Error(`${s.file}: the SQL does not rebuild the same database (${k}: ${parts.map((p) => `${p} ${JSON.stringify(fa[k][p])} vs ${JSON.stringify(fb[k][p])}`).join('; ').slice(0, 600)})`);
    }
    const tables = Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((r) => [r.name, d.prepare(`SELECT COUNT(*) AS n FROM "${r.name}"`).get().n]));
    fs.writeFileSync(path.join(OUT, s.file), sql);
    entries.push({ file: s.file, from: SOURCE.file, userVersion: 0, approvedInSettings: s.approvedInSettings, what: s.what, sha256: L.sha256(Buffer.from(sql)), tables });
    d.close(); back.close();
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ note: 'Made by make-legacy-shapes.js. sha256 is of each file\'s exact bytes. Made-up shapes from before user_version 1; see the script.', shapes: entries }, null, 2) + '\n');
  for (const e of entries) console.log(`${e.file}: ${Object.entries(e.tables).map(([t, n]) => `${t} ${n}`).join(', ')}`);
}

if (require.main === module) build();
module.exports = { build };
