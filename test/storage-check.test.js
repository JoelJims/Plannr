// Step 1.4 C4: core/storage-check.js, the checks the storage move runs on both copies (plan §2.3, §5.1).
// Identical copies pass; each kind of difference fails with a message that names it.
// The "old copy" is the newest schema-history fixture (made-up rows in every table) in a temp file;
// the "new copy" is a byte copy of it, changed one way per test. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-storage-check-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();

let n = 0;
function makeOld() {
  const file = path.join(DIR, `old-${++n}.db`);
  const d = new DatabaseSync(file);
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec("CREATE TABLE typed (id INTEGER PRIMARY KEY AUTOINCREMENT, n, note TEXT); INSERT INTO typed (n, note) VALUES (1, 'a'), (2.5, NULL), ('x', 'b'); CREATE INDEX typed_n ON typed (n);");
  d.exec('PRAGMA user_version = 2');
  d.close();
  return file;
}
function copyOf(file, change) {
  const to = path.join(DIR, `new-${++n}.db`);
  fs.copyFileSync(file, to);
  if (change) { const d = new DatabaseSync(to); try { change(d); } finally { d.close(); } }
  return to;
}
async function check(oldFile, newFile) {
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const { fingerprint, compareFingerprints } = await load('core/storage-check.js');
  const a = openNodeSqliteAdapter(oldFile, { readOnly: true });
  const b = openNodeSqliteAdapter(newFile, { readOnly: true });
  try {
    const fa = await fingerprint(a);
    const fb = await fingerprint(b);
    return { fa, fb, diffs: compareFingerprints(fa, fb) };
  } finally { await a.close(); await b.close(); }
}

test('identical copies pass, and the summary counts every table and row', async () => {
  const old = makeOld();
  const { fa, diffs } = await check(old, copyOf(old));
  assert.deepStrictEqual(diffs, []);
  const { summarize, summaryText } = await load('core/storage-check.js');
  const s = summarize(fa);
  assert.ok(s.tables >= 10, `${s.tables} tables`);
  assert.ok('sqlite_sequence' in fa.tables, 'the AUTOINCREMENT counters are checked');
  assert.ok(Object.values(fa.tables).every((t) => /^[0-9a-f]{64}$/.test(t.sha256)));
  assert.strictEqual(s.rows, Object.values(fa.tables).reduce((x, t) => x + t.rows, 0));
  assert.match(summaryText(s), /^All \d+ tables match \([\d,]+ rows\)\.$/);
  assert.strictEqual(fa.integrity, 'ok');
  assert.strictEqual(fa.userVersion, 2);
});

test('a copy made by VACUUM INTO (renumbered rowids, same order) still passes', async () => {
  const old = makeOld();
  const to = path.join(DIR, `vac-${++n}.db`);
  const d = new DatabaseSync(old);
  d.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  d.close();
  assert.deepStrictEqual((await check(old, to)).diffs, []);
});

const CASES = [
  ['one changed value', (d) => d.exec("UPDATE typed SET note = 'A' WHERE id = 1"), /table typed: the same number of rows \(3\), but their contents differ/],
  ['a missing row', (d) => d.exec('DELETE FROM typed WHERE id = 3'), /table typed: 3 rows before, 2 after/],
  ['an extra row', (d) => d.exec("INSERT INTO typed (n, note) VALUES (4, 'd')"), /table typed: 3 rows before, 4 after/],
  ['1 against 1.0 (the same number, another type)', (d) => d.exec('UPDATE typed SET n = 1.0 WHERE id = 1'), /table typed: .*contents differ/],
  ["1 against '1'", (d) => d.exec("UPDATE typed SET n = '1' WHERE id = 1"), /table typed: .*contents differ/],
  ['a schema line only in the new copy', (d) => d.exec('CREATE INDEX typed_note ON typed (note)'), /index typed_note is in the new copy only/],
  ['a changed schema line (the same index on another column)', (d) => d.exec('DROP INDEX typed_n; CREATE INDEX typed_n ON typed (note)'), /the schema of index typed_n differs/],
  ['a different user_version', (d) => d.exec('PRAGMA user_version = 3'), /user_version differs: 2 before, 3 after/],
  ['an AUTOINCREMENT counter moved on', (d) => d.exec("UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'typed'"), /table sqlite_sequence: .*contents differ/],
  ['the same rows in another order', (d) => d.exec("CREATE TABLE t2 AS SELECT * FROM settings ORDER BY key DESC; DELETE FROM settings; INSERT INTO settings SELECT * FROM t2; DROP TABLE t2"), /table settings: .*contents differ/],
];
for (const [name, change, want] of CASES) {
  test(`a difference fails the check: ${name}`, async () => {
    const old = makeOld();
    const { diffs } = await check(old, copyOf(old, change));
    assert.ok(diffs.length >= 1 && diffs.some((m) => want.test(m)), JSON.stringify(diffs));
  });
}

test('a missing table and a damaged new copy are reported', async () => {
  const { compareFingerprints } = await load('core/storage-check.js');
  const old = makeOld();
  const { fa, fb } = await check(old, copyOf(old, (d) => d.exec('DROP TABLE typed')));
  assert.ok(compareFingerprints(fa, fb).some((m) => /table typed is missing from the new copy/.test(m)));
  const broken = { ...fa, integrity: '*** in database main ***\nPage 5 is never used' };
  assert.match(compareFingerprints(fa, broken)[0], /the new copy failed its integrity check/);
});
