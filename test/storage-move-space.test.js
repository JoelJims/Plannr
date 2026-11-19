// Step 1.4 C7: low space and the storage move (plan §2.5, §5.1). The check before the move refuses
// with the right numbers and changes nothing; a write that runs out of room midway (a file write
// with ENOSPC, or SQLite's own "database or disk is full" through max_page_count) removes its
// partial file, leaves localStorage untouched and gives the same message.
// Every file is in a fresh temp folder. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { makeHost, startupFacts, load, ROOT } = require('./_storage-move-host.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-storage-space-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const MB = 1024 * 1024;

let n = 0;
function newPhone() {
  const dir = fs.mkdtempSync(path.join(DIR, `phone-${++n}-`));
  const d = new DatabaseSync(path.join(dir, 'local.db'));
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec(`PRAGMA user_version = 2; WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 2000)
    INSERT INTO settings (key, value) SELECT 'bulk_' || i, printf('%.200c', 'x') FROM k`);
  d.close();
  return dir;
}

test('the space needed is 3 x the database + 20 MB; the message gives both numbers (plan §2.5)', async () => {
  const { requiredFreeBytes, spaceMessage } = await load('core/storage-move.js');
  const db = Math.round(2.8 * MB);
  assert.strictEqual(requiredFreeBytes(db), 3 * db + 20 * MB);
  assert.strictEqual(spaceMessage(requiredFreeBytes(db), 9 * MB),
    'Plannr needs about 29 MB free to move your data. Your phone has 9 MB free. Free some space, then try again.');
  assert.match(spaceMessage(20 * MB + 1, 0.4 * MB), /needs about 21 MB .* has 0 MB free/);
});

test('not enough space: nothing starts, nothing is written, and the numbers are given', async () => {
  const { moveToFile, requiredFreeBytes } = await load('core/storage-move.js');
  const dir = newPhone();
  const original = sha(path.join(dir, 'local.db'));
  const probe = await makeHost(dir);
  const bytes = (await probe.source.exportBytes()).length;
  await probe.source.close();
  const need = requiredFreeBytes(bytes);
  const host = await makeHost(dir, { freeBytes: need - 1 });
  const err = await moveToFile(host).catch((e) => e);
  await host.source.close();
  assert.strictEqual(err.step, 'space');
  assert.deepStrictEqual([err.details.needBytes, err.details.freeBytes], [need, need - 1]);
  assert.match(err.message, /^Plannr needs about \d+ MB free to move your data\. Your phone has \d+ MB free\./);
  assert.deepStrictEqual(host.calls, [], 'no backup, no snapshot, no file');
  assert.deepStrictEqual(fs.readdirSync(dir), ['local.db']);
  assert.strictEqual(sha(path.join(dir, 'local.db')), original);
  // Exactly enough is enough.
  const ok = await makeHost(dir, { freeBytes: need });
  await moveToFile(ok);
  await ok.source.close();
});

test('the file write runs out of space half-way: the partial file goes, the same message, then "Continue" works', async () => {
  const { moveToFile, decideAtStartup } = await load('core/storage-move.js');
  const dir = newPhone();
  const original = sha(path.join(dir, 'local.db'));
  const host = await makeHost(dir, { failWrite: true, freeBytes: 30 * MB });
  host.freeBytes = (() => { let k = 0; return async () => (k++ === 0 ? 30 * MB : 3 * MB); })(); // full after the write
  const err = await moveToFile(host).catch((e) => e);
  await host.source.close();
  assert.strictEqual(err.step, 'write');
  assert.match(err.message, /^Plannr needs about \d+ MB free to move your data\. Your phone has 3 MB free\. Free some space, then try again\.$/);
  assert.match(String(err.details.cause && err.details.cause.message), /ENOSPC/);
  assert.ok(!fs.existsSync(host.files.candidate), 'the partial file is removed');
  assert.strictEqual(sha(path.join(dir, 'local.db')), original);
  assert.strictEqual((await decideAtStartup(await startupFacts(host))).use, 'localstorage');
  const again = await makeHost(dir);
  await moveToFile(again);
  await again.source.close();
  assert.strictEqual((await decideAtStartup(await startupFacts(again))).use, 'native');
});

test("SQLite itself runs out of room midway (max_page_count): the partial file goes, the same message", async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = newPhone();
  const original = sha(path.join(dir, 'local.db'));
  const host = await makeHost(dir);
  // A writer that builds the file through SQLite, on a "disk" that holds only 8 pages.
  host.candidate.write = async () => {
    const d = new DatabaseSync(host.files.candidate);
    try {
      d.exec('PRAGMA foreign_keys = OFF; PRAGMA max_page_count = 8');
      d.exec(`ATTACH DATABASE '${path.join(dir, 'local.db').replace(/'/g, "''")}' AS src`);
      for (const { name, sql } of d.prepare("SELECT name, sql FROM src.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
        d.exec(sql);
        d.exec(`INSERT INTO main."${name}" SELECT * FROM src."${name}"`);
      }
    } finally { d.close(); }
  };
  const err = await moveToFile(host).catch((e) => e);
  await host.source.close();
  assert.strictEqual(err.step, 'write');
  assert.match(err.message, /^Plannr needs about \d+ MB free to move your data\./);
  assert.match(String(err.details.cause && err.details.cause.message), /database or disk is full/);
  assert.ok(!fs.existsSync(host.files.candidate), 'the partial file is removed');
  assert.strictEqual(sha(path.join(dir, 'local.db')), original);
});

test('the snapshot runs out of space: stopped at step 2, the same message, nothing else written', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = newPhone();
  const host = await makeHost(dir);
  host.snapshot = async () => { const e = new Error('ENOSPC: no space left on device, write'); e.code = 'ENOSPC'; throw e; };
  const err = await moveToFile(host).catch((e) => e);
  await host.source.close();
  assert.strictEqual(err.step, 'snapshot');
  assert.match(err.message, /^Plannr needs about/);
  assert.ok(!fs.existsSync(host.files.candidate) && !fs.existsSync(host.files.main));
});

test('isDiskFull knows a full disk from every platform, and nothing else', async () => {
  const { isDiskFull } = await load('core/storage-move.js');
  const e = (msg, extra) => Object.assign(new Error(msg), extra);
  for (const yes of [e('x', { code: 'ENOSPC' }), e('x', { errcode: 13 }), e('x', { errcode: 13 | 256 }),
    e('database or disk is full'), e('write failed: /data/x: write failed: ENOSPC (No space left on device)'),
    e('Run: SQLITE_FULL (code 13)')]) assert.strictEqual(isDiskFull(yes), true, yes.message);
  for (const no of [null, e('UNIQUE constraint failed'), e('x', { errcode: 19 }), e('disk I/O error'), e('x', { code: 'EACCES' })]) {
    assert.strictEqual(isDiskFull(no), false, String(no && no.message));
  }
});
