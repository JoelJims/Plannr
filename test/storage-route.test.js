// Step 1.4 C11: GET /api/storage, core/routes/storage.js. One answer shape for the three kinds of
// storage (plan §3.2, §4, decision D5): localStorage against its limit (70% / 90%), the phone's file
// against Android's 25 MB Google backup limit (20 MB / 23 MB, the old copy counted while it is kept,
// free space under 100 MB said), and the desktop file (no limit).
// The real platforms: test/storage.test.js (the dev server), test-ui/storage-limit.js (localStorage),
// test-ui/storage-startup.js (the file, with the stand-in plugins).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(ROOT, 'core', 'routes', 'storage.js')).href);
const MB = 1024 * 1024;
const KEYS = ['mode', 'kind', 'databaseBytes', 'usedBytes', 'limitBytes', 'backupBytes', 'backupLimitBytes', 'freeBytes', 'fraction', 'level', 'freeLow'].sort();

test('localStorage: used against the limit; warning from 70%, strongly from 90%', async () => {
  const { storageAnswer } = await load();
  const limit = 10 * MB;
  const at = (f) => storageAnswer({ kind: 'localstorage', usedBytes: Math.round(limit * f), limitBytes: limit, databaseBytes: 1234 });
  const a = at(0.5);
  assert.deepStrictEqual(Object.keys(a).sort(), KEYS);
  assert.deepStrictEqual(a, { mode: 'phone', kind: 'localstorage', databaseBytes: 1234, usedBytes: limit / 2, limitBytes: limit, backupBytes: null, backupLimitBytes: null, freeBytes: null, fraction: 0.5, level: 'ok', freeLow: false });
  assert.strictEqual(at(0.6999).level, 'ok');
  assert.strictEqual(at(0.7).level, 'warning');
  assert.strictEqual(at(0.8999).level, 'warning');
  assert.strictEqual(at(0.9).level, 'critical');
  assert.strictEqual(at(1.2).level, 'critical');
});

test('the file: the Google backup estimate (file + old copy) against 25 MB; warning from 20 MB, strongly from 23 MB', async () => {
  const { storageAnswer, BACKUP_LIMIT_BYTES } = await load();
  assert.strictEqual(BACKUP_LIMIT_BYTES, 25 * MB);
  const at = (databaseBytes, oldCopyBytes = 0, freeBytes = 8e9) => storageAnswer({ kind: 'file', databaseBytes, oldCopyBytes, freeBytes });
  const a = at(3 * MB, 2 * MB);
  assert.deepStrictEqual(Object.keys(a).sort(), KEYS);
  assert.deepStrictEqual(a, { mode: 'phone', kind: 'file', databaseBytes: 3 * MB, usedBytes: null, limitBytes: null, backupBytes: 5 * MB, backupLimitBytes: 25 * MB, freeBytes: 8e9, fraction: 0.2, level: 'ok', freeLow: false });
  assert.strictEqual(at(20 * MB - 1).level, 'ok');
  assert.strictEqual(at(20 * MB).level, 'warning');
  assert.strictEqual(at(15 * MB, 5 * MB).level, 'warning', 'the old copy counts');
  assert.strictEqual(at(15 * MB, 0).level, 'ok', 'without it, the same file is fine');
  assert.strictEqual(at(23 * MB - 1).level, 'warning');
  assert.strictEqual(at(23 * MB).level, 'critical');
  assert.strictEqual(at(30 * MB).fraction, 1.2);
  assert.strictEqual(at(MB, 0, 100 * MB - 1).freeLow, true);
  assert.strictEqual(at(MB, 0, 100 * MB).freeLow, false);
  assert.strictEqual(at(MB, 0, null).freeLow, false, 'unknown free space is not "low"');
  assert.strictEqual(storageAnswer({ kind: 'file', databaseBytes: MB }).backupBytes, MB, 'no old copy reported: the file alone');
});

test('desktop: the file size, no limit', async () => {
  const { storageAnswer } = await load();
  const a = storageAnswer({ kind: 'desktop', databaseBytes: 4096 });
  assert.deepStrictEqual(Object.keys(a).sort(), KEYS);
  assert.deepStrictEqual(a, { mode: 'desktop', kind: 'desktop', databaseBytes: 4096, usedBytes: null, limitBytes: null, backupBytes: null, backupLimitBytes: null, freeBytes: null, fraction: null, level: 'ok', freeLow: false });
  assert.strictEqual(storageAnswer({ kind: 'desktop', databaseBytes: null }).databaseBytes, null);
});

test('the route answers from host.storage.info, and passes a failure on', async () => {
  const { register } = await load();
  const routes = {};
  const app = { get: (p, ...fns) => { routes[p] = fns[fns.length - 1]; } };
  let info = { kind: 'file', databaseBytes: 21 * MB, oldCopyBytes: 0, freeBytes: 50 * MB };
  register(app, { auth: () => {}, host: { storage: { info: async () => info } } });
  const res = { body: null, json(o) { this.body = o; return this; } };
  await routes['/api/storage']({}, res);
  assert.strictEqual(res.body.level, 'warning');
  assert.strictEqual(res.body.freeLow, true);
  info = Promise.reject(new Error('plugin gone'));
  info.catch(() => {});
  let passed = null;
  await routes['/api/storage']({}, res, (e) => { passed = e; });
  assert.match(String(passed && passed.message), /plugin gone/);
});

test('both platforms register the shared route and keep no /api/storage of their own', () => {
  for (const [file, reg] of [['server.js', /require\('\.\/core\/routes\/storage\.js'\)\.register\(api, coreContext\);/], ['public/local-api.js', /storageRoutes\.register\(localApp, coreContext\);/]]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, reg, file);
    assert.doesNotMatch(src, /\.get\('\/api\/storage'/, file);
  }
});
