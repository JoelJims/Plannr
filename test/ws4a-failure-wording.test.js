// Q11 wording (the owner's exact text, 2026-11-28), on both hosts (the routes run on both test
// passes: server.js and the phone's public/local-api.js):
//   - a JSON import that fails after the file passed its checks (the safety snapshot, or the
//     replace itself): "Couldn't import this file. Nothing was changed. Please try again."
//   - an encrypted restore that fails after the file passed its checks (the safety snapshot, or the
//     restore itself, put back): "Couldn't restore this backup. Your data hasn't changed."
//   - every save, import or restore that hits a full storage: "Your phone's storage is full. Free up
//     some space and try again. Nothing was changed."
// The technical cause is still logged; it is no longer shown. A bad file (HTTP 400) keeps its own
// message. The Ledger List CSV import replaces the list in one transaction (all or nothing), so its
// failure gets the import text too.
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { encrypt, decrypt } = require('../backup-crypto');

const ROOT = path.join(__dirname, '..');
const IMPORT_FAILED = "Couldn't import this file. Nothing was changed. Please try again.";
const RESTORE_FAILED = "Couldn't restore this backup. Your data hasn't changed.";
const STORAGE_FULL = "Your phone's storage is full. Free up some space and try again. Nothing was changed.";
const PASS = 'wording-test-passphrase';

let userId;
before(async () => {
  await H.startApp();
  userId = H.seedLoggedIn().user.id;
  const cid = H.seedContract();
  H.seedPayment({ contractId: cid });
  H.seedCashIn();
});
after(async () => { await H.stopApp(); });

const dump = () => Object.fromEntries(['cash_in', 'cash_out', 'contract', 'contractor_payments', 'loans', 'settings', 'ledger_mains', 'ledger_subs']
  .map((t) => [t, H.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map((r) => ({ ...r }))]));

// Run fn with a temporary trigger that refuses every write of `when` with `message`, quietly (the
// hosts log the cause on purpose).
async function refusing(name, when, message, fn) {
  H.db.exec(`CREATE TEMP TRIGGER ${name} ${when} BEGIN SELECT RAISE(ABORT, '${message}'); END`);
  const quiet = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = quiet; H.db.exec(`DROP TRIGGER IF EXISTS ${name}`); }
}

test('Q11: the three texts are the owner\'s words, shared by both hosts (request-rules.js)', async () => {
  const rules = await import(pathToFileURL(path.join(ROOT, 'request-rules.js')).href);
  assert.deepStrictEqual([rules.IMPORT_FAILED, rules.RESTORE_FAILED, rules.STORAGE_FULL], [IMPORT_FAILED, RESTORE_FAILED, STORAGE_FULL]);
});

test('Q11: a save that hits a full storage answers the storage-full text, and changes nothing', async () => {
  const id = H.seedCashOut({ amountPaise: 100 });
  const before = dump();
  // A single setting (the error handler), a single add, and Save All (its own catch in core/ledger-crud.js).
  await refusing('q11_full_settings', 'BEFORE INSERT ON settings', 'database or disk is full', async () => {
    const r = await H.put('/api/budget', { budgetRupees: '1000' });
    assert.deepStrictEqual([r.status, r.json.error], [500, STORAGE_FULL], 'the budget');
  });
  await refusing('q11_full_in', 'BEFORE INSERT ON cash_in', 'database or disk is full', async () => {
    const r = await H.post('/api/cash-in', { amountRupees: '12', txDate: '2026-07-12', byType: 'user', byUserId: userId });
    assert.deepStrictEqual([r.status, r.json.error], [500, STORAGE_FULL], 'a single add');
  });
  await refusing('q11_full_out', 'BEFORE UPDATE ON cash_out', 'database or disk is full', async () => {
    const row = { id, amountRupees: '5', txDate: '2026-07-12', byType: 'custom', byLabel: 'Site', ledgerCode: '1.0', contractScope: 'extra' };
    const r = await H.post('/api/cash-out/batch', { rows: [row] });
    assert.deepStrictEqual([r.status, r.json.error], [500, STORAGE_FULL], 'Save All');
  });
  assert.deepStrictEqual(dump(), before);
});

test('Q11: a JSON import whose replace fails answers the import text (or the storage-full text), and changes nothing', async () => {
  H.seedCashOut({ amountPaise: 200 });
  const backup = (await H.get('/api/backup/export?includeContacts=1')).json;
  assert.ok(backup.tables.cash_out.length >= 1);
  const before = dump();
  await refusing('q11_import_out', 'BEFORE INSERT ON cash_out', 'refused by the test', async () => {
    const r = await H.post('/api/backup/import', backup);
    assert.deepStrictEqual([r.status, r.json.error], [500, IMPORT_FAILED]);
  });
  assert.deepStrictEqual(dump(), before, 'rolled back');
  await refusing('q11_import_full', 'BEFORE INSERT ON cash_out', 'database or disk is full', async () => {
    const r = await H.post('/api/backup/import', backup);
    assert.deepStrictEqual([r.status, r.json.error], [500, STORAGE_FULL]);
  });
  assert.deepStrictEqual(dump(), before, 'rolled back');
});

test('Q11: a failed Ledger List import answers the import text (or the storage-full text), and changes nothing', async () => {
  const csv = await H.get('/api/ledgers/csv');
  assert.strictEqual(csv.status, 200);
  const before = dump();
  await refusing('q11_mains', 'BEFORE INSERT ON ledger_mains', 'refused by the test', async () => {
    const r = await H.post('/api/ledgers/csv', { csv: csv.text });
    assert.deepStrictEqual([r.status, r.json.error], [500, IMPORT_FAILED]);
  });
  await refusing('q11_mains_full', 'BEFORE INSERT ON ledger_mains', 'database or disk is full', async () => {
    const r = await H.post('/api/ledgers/csv', { csv: csv.text });
    assert.deepStrictEqual([r.status, r.json.error], [500, STORAGE_FULL]);
  });
  assert.deepStrictEqual(dump(), before);
});

// The current database as an encrypted backup, with SQL run on it (foreign keys off, as a hand-edited
// or damaged backup would be).
async function encryptedBackupWith(statements) {
  const r = await H.raw('POST', '/api/backup/export-encrypted', { passphrase: PASS });
  assert.strictEqual(r.status, 200);
  const file = path.join(path.dirname(H.TEST_DB), `wording-backup-${process.pid}.db`);
  fs.writeFileSync(file, Buffer.from(await decrypt(await r.bytes(), PASS)));
  const d = new DatabaseSync(file);
  try { d.exec('PRAGMA foreign_keys = OFF'); for (const sql of statements) d.exec(sql); } finally { d.close(); }
  try { return Buffer.from(await encrypt(fs.readFileSync(file), PASS)).toString('base64'); } finally { fs.rmSync(file, { force: true }); }
}

test('Q11: an encrypted restore whose restore fails answers the restore text, and changes nothing', async () => {
  // Copied in, then the foreign-key check fails: the data from before is put back (db.js undoFailedRestore).
  const dataBase64 = await encryptedBackupWith(["INSERT INTO contract_payment_dates (contract_id, pay_date) VALUES (999999, '2026-12-01')"]);
  H.seedCashOut({ amountPaise: 300 }); // made after the backup: must still be there
  const before = dump();
  const quiet = console.error; console.error = () => {};
  let r;
  try { r = await H.post('/api/backup/import-encrypted', { passphrase: PASS, dataBase64 }); } finally { console.error = quiet; }
  assert.deepStrictEqual([r.status, r.json.error], [500, RESTORE_FAILED]);
  assert.deepStrictEqual(dump(), before, 'put back as it was');
});

test('Q11: the Data Backup page falls back to the same texts when an answer has no message', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'data-backup.html'), 'utf8');
  assert.ok(page.includes(`const IMPORT_FAILED = ${JSON.stringify(IMPORT_FAILED)};`), 'the import text');
  assert.ok(page.includes(`const RESTORE_FAILED = ${JSON.stringify(RESTORE_FAILED)};`), 'the restore text');
  assert.ok(page.includes("importMsg.show(data.error || IMPORT_FAILED, 'error');"), 'the JSON import');
  assert.ok(page.includes("encImportMsg.show(data.error || RESTORE_FAILED, 'error');"), 'the encrypted restore');
  assert.ok(page.includes("ledgerCsvMsg.show(data.error || IMPORT_FAILED, 'error');"), 'the Ledger List import');
});
