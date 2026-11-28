// Q11 (review 2026-11-21), decided by the owner: "only real storage-quota errors show 'storage
// full'; other errors show 'Couldn't save – try again'". isStorageFullError (db.js) used to count
// every SQLITE_IOERR as a full storage. Now a full storage is SQLITE_FULL (13) on any engine, or, on
// the phone's localStorage (kvvfs) engine, an I/O error that the browser's quota caused: kvvfs
// catches the QuotaExceededError from localStorage.setItem, logs it through sqlite3.config.error and
// fails the write with SQLITE_IOERR, so db.js listens on that logger. Any other failed save answers
// exactly "Couldn't save – try again." (a failed GET still answers "Something went wrong.").
// The owner's wording of 2026-11-28: a full storage answers STORAGE_FULL below, and a failed Ledger
// List import (one transaction: nothing changed) answers IMPORT_FAILED (test/ws4a-failure-wording.test.js).
// The routes run on both test passes (desktop and phone code).
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { isStorageFullError, watchKvvfsQuota } = require('../db');

const SAVE_FAILED = "Couldn't save – try again."; // a straight apostrophe and an en dash
const STORAGE_FULL = "Your phone's storage is full. Free up some space and try again. Nothing was changed.";
const IMPORT_FAILED = "Couldn't import this file. Nothing was changed. Please try again.";
const quota = () => new DOMException("Failed to execute 'setItem' on 'Storage': exceeded the quota.", 'QuotaExceededError');

let cookie;
before(async () => { await H.startApp(); cookie = H.seedLoggedIn().cookie; });
after(async () => { await H.stopApp(); });
beforeEach(() => { H.clearLedger(); });

test('Q11: SQLITE_FULL is a full storage on any engine; an I/O error alone is not', () => {
  assert.ok(isStorageFullError({ errcode: 13 }));
  assert.ok(isStorageFullError({ errcode: 13 | (1 << 8) }));
  assert.ok(isStorageFullError({ resultCode: 13 }));
  assert.ok(isStorageFullError(new Error('Run: database or disk is full (code 13 SQLITE_FULL)')));
  assert.ok(isStorageFullError(new Error('SQLITE_FULL')));
  // An I/O error with no sign of the browser's quota (a bad sector, a broken file, a locked file).
  assert.ok(!isStorageFullError({ errcode: 10 }));
  assert.ok(!isStorageFullError({ resultCode: 10 | (3 << 8) }));  // SQLITE_IOERR_WRITE
  assert.ok(!isStorageFullError(new Error('SQLITE_IOERR: sqlite3 result code 10: disk I/O error')));
  assert.ok(!isStorageFullError(new Error('UNIQUE constraint failed')));
  assert.ok(!isStorageFullError({ errcode: 19 }));
  assert.ok(!isStorageFullError(null));
});

test('Q11: a save that fails for another reason answers "Couldn\'t save – try again."', async () => {
  // A trigger stands in for a failed write. Its text mentions an I/O error, which used to be read as
  // "Storage is full".
  H.db.exec("CREATE TEMP TRIGGER q11_refuse_settings BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const quiet = console.error; console.error = () => {};
  try {
    const r = await H.put('/api/budget', { budgetRupees: '1000' }, { cookie });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json.error, SAVE_FAILED);
  } finally { console.error = quiet; H.db.exec('DROP TRIGGER q11_refuse_settings'); }

  const id = H.seedCashOut({ amountPaise: 100 });
  H.db.exec(`CREATE TEMP TRIGGER q11_refuse_out BEFORE UPDATE ON cash_out BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  console.error = () => {};
  try {
    const row = { id, amountRupees: '5', txDate: '2026-07-12', byType: 'custom', byLabel: 'Site', ledgerCode: '1.0', contractScope: 'extra' };
    const edit = await H.put(`/api/cash-out/${id}`, row, { cookie });
    assert.deepStrictEqual([edit.status, edit.json.error], [500, SAVE_FAILED], 'a single edit');
    const batch = await H.post('/api/cash-out/batch', { rows: [row] }, { cookie });
    assert.deepStrictEqual([batch.status, batch.json.error], [500, SAVE_FAILED], 'Save All');
  } finally { console.error = quiet; H.db.exec('DROP TRIGGER q11_refuse_out'); }
});

test('Q11: a real full storage still answers the storage-full text', async () => {
  H.db.exec("CREATE TEMP TRIGGER q11_full BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
  const quiet = console.error; console.error = () => {};
  try {
    const r = await H.put('/api/budget', { budgetRupees: '1000' }, { cookie });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.json.error, STORAGE_FULL);
  } finally { console.error = quiet; H.db.exec('DROP TRIGGER q11_full'); }
});

test('Q11: a failed ledger-list import answers the import text, not the raw error', async () => {
  const csv = await H.get('/api/ledgers/csv', { cookie });
  assert.strictEqual(csv.status, 200);
  H.db.exec("CREATE TEMP TRIGGER q11_refuse_mains BEFORE INSERT ON ledger_mains BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
  const quiet = console.error; console.error = () => {};
  try {
    const r = await H.post('/api/ledgers/csv', { csv: csv.text }, { cookie });
    assert.deepStrictEqual([r.status, r.json.error], [500, IMPORT_FAILED]);
  } finally { console.error = quiet; H.db.exec('DROP TRIGGER q11_refuse_mains'); }
});

// Last: it records a quota error, and for a few seconds after that an I/O error counts as the quota's.
test('Q11: an I/O error the browser quota caused is a full storage', () => {
  assert.ok(isStorageFullError(quota()), 'the QuotaExceededError itself');
  assert.ok(isStorageFullError(Object.assign(new Error('disk I/O error'), { resultCode: 778, cause: quota() })), 'an I/O error caused by it');
  // kvvfs: the quota error is only logged; the error the app gets is a bare SQLITE_IOERR_WRITE.
  const logged = [];
  const sqlite3 = { config: { error: (...args) => logged.push(args) } };
  watchKvvfsQuota(sqlite3);
  const ioErr = Object.assign(new Error('SQLITE_IOERR_WRITE: sqlite3 result code 778: disk I/O error'), { resultCode: 778 });
  sqlite3.config.error('kvvfs:', 'kvrecordRead()', new Error('some other storage failure'));
  assert.ok(!isStorageFullError(ioErr), 'another logged kvvfs error is not the quota');
  sqlite3.config.error('kvvfs:', 'kvrecordWrite()', quota());
  assert.strictEqual(logged.length, 2, 'sqlite-wasm\'s own logger still runs');
  assert.ok(isStorageFullError(ioErr), 'an I/O error right after the quota refused a write');
  assert.ok(!isStorageFullError({ errcode: 19 }), 'a constraint error is still not a full storage');
});
