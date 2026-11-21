// Step 1.4 C9: public/storage-native.js, the phone's host for the storage move and the startup
// decision, over the stand-in plugins of test/_fake-capacitor-sqlite.js (as the C1 spike measured the
// real ones) and a Map standing in for localStorage. The move's source (the kvvfs copy) is a
// node-sqlite file here. Chromium and the emulator test the same code with the real page (C9's UI
// suite, C13-C15).
// Every file is in a fresh temp folder. Nothing opens data/plannr.db.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { makeFakePlugins } = require('./_fake-capacitor-sqlite.js');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plannr-storage-native-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const FIXTURE = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'schema-history')).filter((f) => f.endsWith('.sql')).sort().pop();

class FakeLocalStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

let n = 0;
function newPhone() {
  const dir = fs.mkdtempSync(path.join(DIR, `phone-${++n}-`));
  const plugins = makeFakePlugins(path.join(dir, 'app'));
  const ls = new FakeLocalStorage();
  ls.setItem('kvvfs-local-1', 'a page of the old copy'); // what local.exists() looks for
  const localFile = path.join(dir, 'local.db');
  const d = new DatabaseSync(localFile);
  d.exec(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'schema-history', FIXTURE), 'utf8'));
  d.exec(`PRAGMA user_version = 2; WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 150)
    INSERT INTO settings (key, value) SELECT 'bulk_' || i, 'value ' || i FROM k`);
  d.close();
  return { dir, plugins, ls, localFile };
}
const files = (phone) => fs.readdirSync(phone.plugins.databasesDir).sort();

async function moveHost(phone, extra = {}) {
  const { makePhoneHost } = await load('public/storage-native.js');
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const source = openNodeSqliteAdapter(phone.localFile, { readOnly: true });
  const host = await makePhoneHost({ plugins: phone.plugins, localStorage: phone.ls, backup: async () => {}, source, ...extra });
  host.snapshot = async () => 'safety-snapshots/plannr-pre-move-test.db.gz'; // the Filesystem plugin is the page's
  return host;
}

test('no plugins (the browser preview, the UI suites): localStorage, and nothing is touched', async () => {
  const { chooseStorage } = await load('public/storage-native.js');
  const ls = new FakeLocalStorage();
  const got = await chooseStorage({ plugins: null, localStorage: ls });
  assert.deepStrictEqual(got, { use: 'localstorage', native: false });
  assert.strictEqual(ls.length, 0);
});

test('the paths: the database, the candidate and the marker in the app\'s own folders', async () => {
  const { phonePaths } = await load('public/storage-native.js');
  const phone = newPhone();
  const p = await phonePaths(phone.plugins.storage);
  assert.strictEqual(p.main, `${phone.plugins.databasesDir}/plannrSQLite.db`);
  assert.strictEqual(p.candidate, `${phone.plugins.databasesDir}/plannr-movingSQLite.db`);
  assert.strictEqual(p.marker, `${phone.plugins.filesDir}/plannr-storage.json`);
});

test('quick_check on a missing database file answers "not ok" and does not make an empty file', async () => {
  // Opening a missing file through the plugin creates an empty database, whose quick_check is "ok".
  const phone = newPhone();
  const host = await moveHost(phone);
  assert.strictEqual(await host.main.exists(), false);
  assert.strictEqual(await host.main.quickCheckOk(), false);
  assert.strictEqual(await host.main.exists(), false, 'no file was made');
  await host.source.close();
});

test('a phone that never moved: localStorage, no prompt, no file made', async () => {
  const { chooseStorage } = await load('public/storage-native.js');
  const phone = newPhone();
  const got = await chooseStorage({ plugins: phone.plugins, localStorage: phone.ls });
  assert.deepStrictEqual({ use: got.use, native: got.native, prompt: got.prompt, marker: got.marker }, { use: 'localstorage', native: true, prompt: undefined, marker: null });
  assert.deepStrictEqual(files(phone), []);
});

test('the move on the phone host, then startup opens the file; the marker is written whole', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const { chooseStorage, MARKER_KEY, PROGRESS_KEY } = await load('public/storage-native.js');
  const phone = newPhone();
  const host = await moveHost(phone);
  const res = await moveToFile(host);
  await host.source.close();
  assert.deepStrictEqual(files(phone), ['plannrSQLite.db']);
  assert.ok(!fs.existsSync(path.join(phone.plugins.filesDir, 'plannr-storage.json.tmp')), 'no temporary marker left');
  const marker = JSON.parse(fs.readFileSync(path.join(phone.plugins.filesDir, 'plannr-storage.json'), 'utf8'));
  assert.strictEqual(marker.storage, 'native-v1');
  assert.strictEqual(marker.check.rows, res.summary.rows);
  assert.strictEqual(JSON.parse(phone.ls.getItem(MARKER_KEY)).storage, 'native-v1');
  assert.strictEqual(phone.ls.getItem(PROGRESS_KEY), null);
  const got = await chooseStorage({ plugins: phone.plugins, localStorage: phone.ls });
  assert.strictEqual(got.use, 'native');
  try {
    assert.strictEqual((await got.adapter.get("SELECT value FROM settings WHERE key = 'bulk_150'")).value, 'value 150');
    assert.strictEqual((await got.adapter.info()).engine, 'capacitor-sqlite');
  } finally { await got.adapter.close(); }
});

test('the marker file unreadable: the localStorage key that repeats it decides', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const { chooseStorage } = await load('public/storage-native.js');
  const phone = newPhone();
  const host = await moveHost(phone);
  await moveToFile(host);
  await host.source.close();
  fs.writeFileSync(path.join(phone.plugins.filesDir, 'plannr-storage.json'), '{ half a marker');
  const got = await chooseStorage({ plugins: phone.plugins, localStorage: phone.ls });
  assert.strictEqual(got.use, 'native');
  await got.adapter.close();
});

test('an interrupted move: the candidate is deleted, the prompt is "interrupted", the progress hint is kept for "Continue"', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const { chooseStorage, PROGRESS_KEY } = await load('public/storage-native.js');
  const phone = newPhone();
  const host = await moveHost(phone);
  host.checkpoint = async (name) => { if (name === 'before-check') throw new Error('killed'); };
  host.candidate.remove = async () => {}; // a kill leaves the candidate behind; the cleanup never ran
  await assert.rejects(moveToFile(host), /killed/);
  await host.source.close();
  assert.deepStrictEqual(files(phone), ['plannr-movingSQLite.db']);
  const got = await chooseStorage({ plugins: phone.plugins, localStorage: phone.ls });
  assert.deepStrictEqual([got.use, got.prompt], ['localstorage', 'interrupted']);
  assert.deepStrictEqual(files(phone), []);
  assert.ok(JSON.parse(phone.ls.getItem(PROGRESS_KEY)).checksum, 'the hint stays');
});

test('a database file nothing explains is set aside (kept), not deleted', async () => {
  const { chooseStorage } = await load('public/storage-native.js');
  const phone = newPhone();
  fs.copyFileSync(phone.localFile, path.join(phone.plugins.databasesDir, 'plannrSQLite.db'));
  const got = await chooseStorage({ plugins: phone.plugins, localStorage: phone.ls });
  assert.deepStrictEqual([got.use, got.prompt], ['localstorage', 'interrupted']);
  const left = files(phone);
  assert.strictEqual(left.length, 1);
  assert.match(left[0], /^plannr-setaside-[0-9A-Za-z-]+SQLite\.db$/);
});

test('native-v1 with the file missing or damaged: the recovery answer, nothing changed', async () => {
  const { moveToFile } = await load('core/storage-move.js');
  const { chooseStorage } = await load('public/storage-native.js');
  const phone = newPhone();
  const host = await moveHost(phone);
  await moveToFile(host);
  await host.source.close();
  const main = path.join(phone.plugins.databasesDir, 'plannrSQLite.db');
  fs.writeFileSync(main, 'damaged');
  let got = await chooseStorage({ plugins: phone.plugins, localStorage: phone.ls });
  assert.deepStrictEqual([got.use, got.reason], ['recovery', 'damaged']);
  assert.strictEqual(fs.readFileSync(main, 'utf8'), 'damaged', 'not touched');
  fs.rmSync(main);
  got = await chooseStorage({ plugins: phone.plugins, localStorage: phone.ls });
  assert.deepStrictEqual([got.use, got.reason], ['recovery', 'missing']);
  assert.deepStrictEqual(files(phone), [], 'quick_check did not create an empty file');
});

test('the way back and deleting the old copy on the phone host', async () => {
  const { moveToFile, moveBack, deleteOldCopy } = await load('core/storage-move.js');
  const { makePhoneHost, KVVFS_PREFIX } = await load('public/storage-native.js');
  const { openNodeSqliteAdapter } = await load('db-adapter-node.js');
  const { openCapacitorAdapter } = await load('public/db-adapter-capacitor.js');
  const phone = newPhone();
  const h = await moveHost(phone);
  await moveToFile(h);
  await h.source.close();
  const file = await openCapacitorAdapter({ ...phone.plugins, name: 'plannr' });
  // The old copy (kvvfs on the phone) is the node-sqlite file here.
  const kvvfs = async () => openNodeSqliteAdapter(phone.localFile);
  const host = await makePhoneHost({ plugins: phone.plugins, localStorage: phone.ls, file, kvvfs, lastEncryptedBackupAt: async () => '2099-01-01 00:00:00' });
  host.snapshot = async (bytes, kind) => `safety-snapshots/plannr-${kind}.db.gz`;
  await file.run("INSERT INTO settings (key, value) VALUES ('after_the_move', 'yes')");
  await moveBack(host, { confirmed: true });
  const back = new DatabaseSync(phone.localFile, { readOnly: true });
  assert.ok(back.prepare("SELECT 1 FROM settings WHERE key = 'after_the_move'").get(), 'the current data went back');
  back.close();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(phone.plugins.filesDir, 'plannr-storage.json'), 'utf8')).storage, 'localstorage-v1');
  await file.close(); // the page reloads after the way back; the file is not open on localStorage
  // Move again (over the kept file), then delete the old copy: its kvvfs-local keys go.
  const h2 = await moveHost(phone);
  await moveToFile(h2);
  await h2.source.close();
  const file2 = await openCapacitorAdapter({ ...phone.plugins, name: 'plannr' });
  assert.ok(await file2.get("SELECT 1 AS one FROM settings WHERE key = 'after_the_move'"), 'the file now holds the data that went back');
  const host2 = await makePhoneHost({ plugins: phone.plugins, localStorage: phone.ls, file: file2, kvvfs, lastEncryptedBackupAt: async () => '2099-01-01 00:00:00' });
  await deleteOldCopy(host2, { confirmed: true });
  assert.ok(![...phone.ls.m.keys()].some((k) => k.startsWith(KVVFS_PREFIX)), 'no kvvfs-local key left');
  await file2.close();
});

test('the localStorage limit here is the one the storage meter uses', async () => {
  const api = fs.readFileSync(path.join(ROOT, 'public', 'local-api.js'), 'utf8');
  const native = fs.readFileSync(path.join(ROOT, 'public', 'storage-native.js'), 'utf8');
  const a = api.match(/export const LOCALSTORAGE_LIMIT_CHARS = ([^;]+);/)[1];
  const b = native.match(/limitChars: ([^,]+),/)[1];
  assert.strictEqual(a.trim(), b.trim());
});
