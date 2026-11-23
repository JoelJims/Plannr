// Q4: "Move data back" must count what localStorage already holds while the copy is replaced:
// the old copy stays until the commit and kvvfs's rollback journal can hold all of its pages,
// and other keys take quota too. Before the fix only the incoming size was counted.
// Every file is in a fresh temp folder. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeHost, load, ROOT } = require('./_storage-move-host.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-q4-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();

let n = 0;
async function moved() {
  const { moveToFile } = await load('core/storage-move.js');
  const dir = fs.mkdtempSync(path.join(DIR, `phone-${++n}-`));
  const d = new DatabaseSync(path.join(dir, 'local.db'));
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec(`PRAGMA user_version = 2; WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 200)
    INSERT INTO settings (key, value) SELECT 'bulk_' || i, 'value ' || i FROM k`);
  d.close();
  const first = await makeHost(dir);
  await moveToFile(first);
  await first.source.close();
  const host = await makeHost(dir);
  await host.source.close();
  await host.openFile();
  return { dir, host };
}

test('Q4: the data alone fits, but with the old copy and its journal it does not: refused before anything changes', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { host } = await moved();
  const bytes = (await host.file.exportBytes()).length;
  host.local.limitChars = Math.ceil((bytes * 2) / 0.9) + 1024; // room for the incoming data only
  const err = await moveBack(host, { confirmed: true }).catch((e) => e);
  await host.file.close();
  assert.ok(err instanceof Error, 'move back was not refused');
  assert.strictEqual(err.step, 'size');
  assert.ok(err.details.bytes > err.details.limitBytes);
  assert.deepStrictEqual(host.calls, [], 'nothing may be written');
});

test('Q4: other localStorage keys count too', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { host } = await moved();
  const bytes = (await host.file.exportBytes()).length;
  const oldBytes = (await host.local.exportBytes()).length;
  const room = 2 * Math.max(bytes, oldBytes) + 2 * oldBytes;
  host.local.limitChars = Math.ceil((room + 4096) / 0.9); // fits with 4 KB of other keys...
  host.local.usedChars = async () => ({ copy: 2 * oldBytes, other: 64 * 1024 }); // ...but they hold 64 KB
  const err = await moveBack(host, { confirmed: true }).catch((e) => e);
  await host.file.close();
  assert.ok(err instanceof Error, 'move back was not refused');
  assert.strictEqual(err.step, 'size');
  assert.deepStrictEqual(host.calls, []);
});

test('Q4: with room for the old copy, its journal and the other keys, move data back still works', async () => {
  const { moveBack } = await load('core/storage-move.js');
  const { host } = await moved();
  const bytes = (await host.file.exportBytes()).length;
  const oldBytes = (await host.local.exportBytes()).length;
  const room = 2 * Math.max(bytes, oldBytes) + 2 * oldBytes;
  host.local.limitChars = Math.ceil((room + 8192) / 0.9);
  host.local.usedChars = async () => ({ copy: 2 * oldBytes, other: 4096 });
  await moveBack(host, { confirmed: true });
  await host.file.close();
  assert.ok(host.calls.includes('local.replaceWith'));
});
