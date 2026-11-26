// Step 1.4 A7: the JSON backup routes (core/routes/backup.js). test/backup.test.js and the
// backup-roundtrip suites check what a backup contains and that a restore works on both platforms;
// this file checks the route around it:
// 1. Over HTTP: the dev server's download name.
// 2. The core module registered on a small fake app over this file's temp database, with a fake
//    host, to check the order the import keeps: check the file, then the safety copy, then replace.
const H = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isStorageFullError, dbAdapter } = require('../db');
const repo = require('../repo');

before(async () => { await H.startApp(); });
after(async () => { await H.stopApp(); });
beforeEach(() => H.clearLedger());

const imp = (rel) => import(pathToFileURL(path.join(__dirname, '..', rel)).href);
const cashOutCount = () => H.db.prepare('SELECT COUNT(*) AS n FROM cash_out').get().n;

// ---- 1. Over HTTP ----------------------------------------------------------------------------------

test('export: the dev server names the download with the export date', { skip: H.TARGET === 'shim' && 'the phone saves the file itself' }, async () => {
  const r = await H.get('/api/backup/export');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="plannr-backup-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.ok(r.headers.get('content-disposition').includes(r.json.exportedAt.slice(0, 10)));
});

// ---- 2. The core module with a fake host -----------------------------------------------------------

async function coreApp({ writeJson }) {
  const core = await imp('core/routes/backup.js');
  const { createLedgerIndex } = await imp('core/ledger-index.js');
  const ledgerIndex = createLedgerIndex(repo);
  await ledgerIndex.refresh();
  const routes = {};
  const logged = [];
  const auth = () => {};
  const app = {};
  for (const m of ['get', 'post']) {
    app[m] = (p, a, handler) => {
      assert.strictEqual(a, auth, `${m} ${p} is registered behind ctx.auth`);
      routes[`${m.toUpperCase()} ${p}`] = handler;
    };
  }
  const starts = [];
  core.register(app, {
    auth, adapter: dbAdapter(), atStart: (fn) => starts.push(fn()), host: { snapshot: { writeJson }, now: () => new Date() },
    logError: (...args) => logged.push(args.map(String).join(' ')),
    isStorageFullError, storageFull: (what) => `Storage is full — ${what} Free up space, then try again.`,
    ledgerIndex, CUSTOM_CODE: 'CUSTOM',
  });
  assert.strictEqual(starts.length, 1, 'the module asks for one start job: the ownership check');
  await Promise.all(starts);
  const call = async (key, { body, query } = {}) => {
    const res = {
      code: 200, body: undefined, headers: {},
      status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    };
    await routes[key]({ body, query: query || {} }, res);
    return res;
  };
  return { routes, call, logged };
}

test('core: registers exactly the JSON and the encrypted export and import, and the size note, each behind auth', async () => {
  const { routes } = await coreApp({ writeJson: async () => 'x' });
  // The encrypted two since step 1.4 C11 (test/backup-encrypted-route.test.js); the size note since F14.
  assert.deepStrictEqual(Object.keys(routes).sort(), ['GET /api/backup/export', 'GET /api/backup/size-note', 'POST /api/backup/export-encrypted', 'POST /api/backup/import', 'POST /api/backup/import-encrypted']);
});

test('core: a file that fails the checks is refused before the safety copy is made', async () => {
  let snapshots = 0;
  const { call } = await coreApp({ writeJson: async () => { snapshots++; return 'x'; } });
  const r = await call('POST /api/backup/import', { body: { app: 'not plannr' } });
  assert.strictEqual(r.code, 400);
  assert.ok(r.body.error);
  assert.strictEqual(snapshots, 0);
});

test('core: if the safety copy cannot be written, the import stops and the data is unchanged', async () => {
  H.seedCashOut();
  const { call, logged } = await coreApp({ writeJson: async () => { throw new Error('disk gone'); } });
  const good = (await call('GET /api/backup/export', { query: { includeContacts: '1' } })).body;
  good.tables.cash_out = [];
  const before = cashOutCount();
  assert.ok(before > 0);
  const r = await call('POST /api/backup/import', { body: good });
  assert.strictEqual(r.code, 500);
  assert.strictEqual(r.body.error, 'Could not write the safety snapshot, so the import was aborted — your current data is unchanged.');
  assert.strictEqual(cashOutCount(), before, 'nothing replaced');
  assert.ok(logged.some((l) => /Backup snapshot failed:.*disk gone/.test(l)), 'the cause is logged');
});

test('core: the safety copy holds the data as it was (contacts included), then the import replaces it', async () => {
  H.seedCashOut();
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('daily_report_recipients', 'contact@example.test') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const copies = [];
  const { call } = await coreApp({ writeJson: async (backup) => { copies.push({ backup, cashOutThen: cashOutCount() }); return 'safety/copy-1.json'; } });
  const replacement = (await call('GET /api/backup/export')).body;
  replacement.tables.cash_out = [];
  const before = cashOutCount();
  const r = await call('POST /api/backup/import', { body: replacement });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.snapshot, 'safety/copy-1.json', 'the answer reports where the copy went');
  assert.strictEqual(copies.length, 1);
  assert.strictEqual(copies[0].cashOutThen, before, 'the copy was made before anything was replaced');
  assert.strictEqual(copies[0].backup.tables.cash_out.length, before);
  assert.ok(copies[0].backup.tables.settings.some((s) => s.key === 'daily_report_recipients'), 'the local copy keeps contacts');
  assert.strictEqual(cashOutCount(), 0, 'then the import replaced the data');
  H.db.prepare("DELETE FROM settings WHERE key = 'daily_report_recipients'").run();
});

test('core: the export leaves contacts out unless asked, and names the download', async () => {
  H.db.prepare("INSERT INTO settings (key, value) VALUES ('daily_report_whatsapp', '+910000000000') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const { call } = await coreApp({ writeJson: async () => 'x' });
  const plain = await call('GET /api/backup/export');
  assert.ok(!plain.body.tables.settings.some((s) => s.key === 'daily_report_whatsapp'));
  assert.match(plain.headers['content-disposition'], /^attachment; filename="plannr-backup-\d{4}-\d{2}-\d{2}\.json"$/);
  const withContacts = await call('GET /api/backup/export', { query: { includeContacts: '1' } });
  assert.ok(withContacts.body.tables.settings.some((s) => s.key === 'daily_report_whatsapp'));
  H.db.prepare("DELETE FROM settings WHERE key = 'daily_report_whatsapp'").run();
});
