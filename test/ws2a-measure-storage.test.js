// Q7 (docs/security-quality-review-2026-11-21.md): measureStorage() in public/local-api.js reports
// how much of localStorage the database takes. kvvfs's rollback journal (the kvvfs-local-jrnl key)
// is not data: a leftover one still takes quota (usedBytes), but it is not database bytes.
// The phone code needs a page, so this runs in the phone pass only (run-tests.js pass 2).
const H = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const phone = H.TARGET === 'shim';
let measureStorage;

before(async () => {
  if (!phone) return;
  await H.startApp(); // gives the phone code its page (window, localStorage)
  ({ measureStorage } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'local-api.js')).href));
});
after(() => { if (phone) H.stopApp(); });

function fakeStorage(entries) {
  const keys = Object.keys(entries);
  return { get length() { return keys.length; }, key: (i) => keys[i] ?? null, getItem: (k) => entries[k] ?? null };
}

test('Q7: a leftover kvvfs journal record takes quota but is not counted as database bytes', { skip: !phone && 'phone code only (pass 2)' }, () => {
  const page = 'a'.repeat(100);
  const journal = 'b'.repeat(40);
  const other = 'c'.repeat(10);
  const s = fakeStorage({ 'kvvfs-local-1': page, 'kvvfs-local-jrnl': journal, theme: other });
  const r = measureStorage(s);
  const chars = (k, v) => k.length + v.length;
  assert.strictEqual(r.usedBytes, 2 * (chars('kvvfs-local-1', page) + chars('kvvfs-local-jrnl', journal) + chars('theme', other)));
  assert.strictEqual(r.databaseBytes, 2 * chars('kvvfs-local-1', page), 'the journal record is not database data');
});

test('Q7: with no journal record, the database bytes are every kvvfs-local key', { skip: !phone && 'phone code only (pass 2)' }, () => {
  const s = fakeStorage({ 'kvvfs-local-1': 'x'.repeat(8), 'kvvfs-local-2': 'y'.repeat(8), 'kvvfs-local-sz': '8192' });
  const r = measureStorage(s);
  assert.strictEqual(r.databaseBytes, r.usedBytes);
});
