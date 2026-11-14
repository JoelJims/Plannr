// Phase 2, Step 1 (M4) — a backup must rebuild the app EXACTLY on a new phone. Fill a database with
// fixture data -> back up -> wipe to a fresh install -> restore -> every table matches row by row.
// Covers the JSON backup (v2, plus v1 files still restoring) and the encrypted backup's contents.
// The phone-side code path (public/local-api.js over sqlite-wasm) runs the same round trips in a
// real browser: test-ui/backup-roundtrip.js.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { init } = require('../db');
const { decrypt } = require('../backup-crypto');
const F = require('./fixtures/full-dataset');

let base;
const snapshotsWritten = [];
before(async () => { ({ base } = await H.startApp()); });
after(async () => {
  for (const rel of snapshotsWritten) fs.rmSync(path.resolve(__dirname, '..', rel), { force: true });
  await H.stopApp();
});

// Everything gone, then init() re-seeds exactly what a brand-new install starts with (the owner,
// the default categories, the migration markers) — the state of a new phone before a restore.
function wipeToFreshInstall() {
  const db = H.db;
  db.exec('PRAGMA foreign_keys = OFF');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) db.exec(`DELETE FROM ${name}`);
  db.exec('DELETE FROM sqlite_sequence');
  db.exec('PRAGMA foreign_keys = ON');
  init();
}
const seedFixture = () => { wipeToFreshInstall(); F.seedInto(H.db, F.DATA); };
async function importJson(body) {
  const r = await H.post('/api/backup/import', body);
  if (r.json && r.json.snapshot) snapshotsWritten.push(r.json.snapshot);
  return r;
}

test('the fixture puts at least one row in every table (add fixture rows for any new table)', () => {
  seedFixture();
  const dump = F.dumpAll(H.db);
  const empty = Object.entries(dump.tables).filter(([, rows]) => rows.length === 0).map(([t]) => t);
  assert.deepStrictEqual(empty, [], `tables with no fixture rows: ${empty.join(', ')}`);
});

test('JSON backup (v2): back up -> wipe -> restore gives back every table exactly, row by row', async () => {
  seedFixture();
  const before = F.dumpAll(H.db);
  const exp = await H.get('/api/backup/export');
  assert.strictEqual(exp.status, 200);
  assert.strictEqual(exp.json.schemaVersion, 2);

  wipeToFreshInstall();
  assert.notDeepStrictEqual(F.dumpAll(H.db), before, 'the wipe must actually remove the data');

  const r = await importJson(exp.json);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.remappedUsers, 0);
  assert.deepStrictEqual(F.dumpAll(H.db), before);
});

test('JSON backup (v2): the restored categories are live straight away (no restart needed)', async () => {
  const ledgers = await H.get('/api/ledgers');
  const garden = (ledgers.json.ledgers || ledgers.json).find((l) => l.code === '90');
  assert.ok(garden, 'category 90 from the backup is listed');
  assert.deepStrictEqual(garden.subLedgers.map((s) => s.code), ['90.1', '90.2']);
});

test('JSON backup: never contains password hashes; retired contact keys only on opt-in', async () => {
  seedFixture();
  H.db.prepare("UPDATE users SET password_hash = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' WHERE id = 2").run();
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('daily_report_recipients', 'someone@example.com')").run();
  const plain = await H.get('/api/backup/export');
  assert.ok(!JSON.stringify(plain.json).includes('$2b$'), 'no bcrypt hash in the file');
  assert.ok(plain.json.tables.users.every((u) => !('password_hash' in u)));
  assert.ok(!plain.json.tables.settings.some((s) => s.key === 'daily_report_recipients'));
  const optIn = await H.get('/api/backup/export?includeContacts=1');
  assert.ok(optIn.json.tables.settings.some((s) => s.key === 'daily_report_recipients'));
});

test('an old v1 JSON backup still restores, and leaves this install\'s categories and people alone', async () => {
  seedFixture();
  const v2 = (await H.get('/api/backup/export')).json;
  // What a pre-v2 export looked like: no people, no categories, no counters — and (to be restorable
  // on a fresh install) only category codes that every install has.
  const v1 = { app: 'plannr', kind: 'plannr-backup', schemaVersion: 1, exportedAt: v2.exportedAt, tables: {} };
  for (const [t, rows] of Object.entries(v2.tables)) if (!['users', 'ledger_mains', 'ledger_subs', 'ledger_customs'].includes(t)) v1.tables[t] = rows;
  v1.tables.cash_out = v1.tables.cash_out.map((r) => (r.ledger_code === '90' ? { ...r, ledger_code: '22.0', subledger_code: null } : r));

  wipeToFreshInstall();
  const freshCategories = F.dumpAll(H.db).tables.ledger_mains;
  const r = await importJson(v1);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const after = F.dumpAll(H.db);
  for (const t of ['contract', 'contract_services', 'contract_allowances', 'contract_payment_dates', 'contractor_payments', 'loans']) {
    assert.deepStrictEqual(after.tables[t], v1.tables[t].map((row) => ({ ...row })), t);
  }
  assert.deepStrictEqual(after.tables.ledger_mains, freshCategories, 'categories untouched by a v1 restore');
  assert.deepStrictEqual(after.tables.users.map((u) => u.username), ['owner'], 'people untouched by a v1 restore');
  // Entries by person 2 (not on this install) keep their row; the link drops to NULL ("Unknown").
  assert.strictEqual(r.json.remappedUsers, 2);
});

test('a v1 backup that uses a category this install lacks is refused cleanly, data unchanged', async () => {
  seedFixture();
  const v2 = (await H.get('/api/backup/export')).json;
  const v1 = { ...v2, schemaVersion: 1, tables: { ...v2.tables } };
  for (const t of ['users', 'ledger_mains', 'ledger_subs', 'ledger_customs']) delete v1.tables[t];
  wipeToFreshInstall();
  const before = F.dumpAll(H.db);
  const r = await importJson(v1);
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /unknown ledger_code "90"/);
  assert.deepStrictEqual(F.dumpAll(H.db), before);
});

test('a malformed v2 backup is refused before anything changes', async () => {
  seedFixture();
  const good = (await H.get('/api/backup/export')).json;
  const before = F.dumpAll(H.db);
  const cases = [
    [{ ...good, schemaVersion: 3 }, /Unsupported backup version/],
    [{ ...good, tables: { ...good.tables, users: [] } }, /no users/],
    [{ ...good, tables: { ...good.tables, users: [...good.tables.users, { ...good.tables.users[0], id: 77 }] } }, /appears twice/],
    [{ ...good, tables: { ...good.tables, ledger_subs: [...good.tables.ledger_subs, { code: '91.1', main_code: '91', name: 'x', sort_order: 1 }] } }, /not in the backup/],
    [{ ...good, sequences: { not_a_table: 1 } }, /unknown table/],
  ];
  for (const [body, re] of cases) {
    const r = await importJson(body);
    assert.strictEqual(r.status, 400, re.toString());
    assert.match(r.json.error, re);
  }
  assert.deepStrictEqual(F.dumpAll(H.db), before);
});

test('encrypted backup: contains every table exactly (whole-database copy, counters and version included)', async () => {
  seedFixture();
  const before = F.dumpAll(H.db);
  const pass = 'roundtrip-passphrase-123';
  const res = await fetch(base + '/api/backup/export-encrypted', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pass }),
  });
  assert.strictEqual(res.status, 200);
  const plain = decrypt(Buffer.from(await res.arrayBuffer()), pass);
  const tmp = path.join(os.tmpdir(), `plannr-enc-roundtrip-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  fs.writeFileSync(tmp, plain);
  const copy = new DatabaseSync(tmp, { readOnly: true });
  try {
    assert.deepStrictEqual(F.dumpAll(copy), before);
  } finally {
    copy.close();
    fs.rmSync(tmp, { force: true });
  }
  // Restoring an encrypted backup is a phone feature (desktop answers 501); the phone's restore is
  // round-tripped in test-ui/backup-roundtrip.js.
});
