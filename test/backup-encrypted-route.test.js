// Step 1.4 C11: the encrypted backup routes in core/routes/backup.js, run on a stand-in host so each
// rule is checked on its own: the passphrase rules, what is refused before anything changes, the
// order (decrypt and check, safety copy, replace, category list), each failure's answer, and the 501
// on a platform without database.restore (the dev server until D1).
// Both platforms run these routes for real: test/backup-roundtrip.test.js and
// test/passphrase-policy.test.js (the export, both passes), test-ui/backup-roundtrip.js and
// test-ui/backup-crypto.js (the phone's restore).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(ROOT, 'core', 'routes', 'backup.js')).href);
const SQLITE = new Uint8Array([...Buffer.from('SQLite format 3\0'), ...new Array(84).fill(1)]);
const PASS = 'right-passphrase';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
// Q11 wording (the owner's exact text, request-rules.js): a restore that failed after the file passed
// its checks, and a full storage.
const RESTORE_FAILED = "Couldn't restore this backup. Your data hasn't changed.";
const STORAGE_FULL = "Your phone's storage is full. Free up some space and try again. Nothing was changed.";

function res() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(n) { this.statusCode = n; return this; },
    json(o) { this.body = o; return this; },
    send(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
  };
}

async function harness({ host: hostOver = {}, decrypted = SQLITE } = {}) {
  const { register, RESTORE_UNAVAILABLE } = await load();
  const calls = [];
  const routes = {};
  const app = {
    get: (p, ...fns) => { routes[`GET ${p}`] = fns[fns.length - 1]; },
    post: (p, ...fns) => { routes[`POST ${p}`] = fns[fns.length - 1]; },
  };
  const host = {
    pdf: { render: async () => new Uint8Array() },
    now: () => new Date(),
    crypto: {
      encrypt: async (bytes, passphrase) => { calls.push(['encrypt', bytes.length, passphrase]); return new Uint8Array([80, 76, 66, 75, ...bytes]); },
      decrypt: async (bytes, passphrase) => {
        calls.push(['decrypt', bytes.length]);
        if (passphrase !== PASS) throw new Error('Wrong passphrase, or the file was changed or damaged.');
        return decrypted;
      },
    },
    database: {
      exportBytes: async () => { calls.push(['exportBytes']); return SQLITE; },
      restore: async (bytes) => { calls.push(['restore', bytes.length]); },
    },
    snapshot: {
      writeJson: async () => 'unused',
      writeDatabase: async () => { calls.push(['writeDatabase']); return 'a file inside the app (plannr-pre-restore.db)'; },
    },
  };
  for (const [k, v] of Object.entries(hostOver)) host[k] = v === undefined ? undefined : { ...host[k], ...v };
  const logged = [];
  const ctx = {
    auth: () => {}, adapter: {}, atStart: () => {}, host, logError: (...args) => logged.push(args.map(String).join(' ')), CUSTOM_CODE: 'custom',
    isStorageFullError: (e) => /database or disk is full/.test(String(e && e.message)),
    ledgerIndex: { refresh: async () => { calls.push(['refresh']); }, byCode: () => new Map() },
  };
  register(app, ctx);
  const call = async (route, body) => { const r = res(); await routes[route]({ body, query: {} }, r); return r; };
  return { calls, call, host, logged, RESTORE_UNAVAILABLE, names: () => calls.map((c) => c[0]) };
}

const restoreBody = (over = {}) => ({ passphrase: PASS, dataBase64: b64(new Uint8Array([1, 2, 3, 4, 5])), ...over });

test('export-encrypted: the passphrase rules come first, then the database is exported and encrypted', async () => {
  const h = await harness();
  for (const [body, msg] of [
    [{}, /Enter a passphrase/], [{ passphrase: '' }, /Enter a passphrase/], [{ passphrase: 42 }, /Enter a passphrase/],
    [{ passphrase: 'a'.repeat(9) }, /at least 10 characters/], [{ passphrase: '🔐'.repeat(9) }, /at least 10 characters/],
  ]) {
    const r = await h.call('POST /api/backup/export-encrypted', body);
    assert.strictEqual(r.statusCode, 400, JSON.stringify(body));
    assert.match(r.body.error, msg);
  }
  assert.deepStrictEqual(h.calls, [], 'nothing exported for a refused passphrase');
  const r = await h.call('POST /api/backup/export-encrypted', { passphrase: '🔐'.repeat(10) });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.headers['Content-Type'], 'application/octet-stream');
  assert.deepStrictEqual(h.names(), ['exportBytes', 'encrypt']);
  assert.strictEqual(h.calls[1][2], '🔐'.repeat(10));
  assert.deepStrictEqual([...r.body.slice(0, 4)], [80, 76, 66, 75]);
});

test('export-encrypted: a failure is a 500 that says what failed', async () => {
  const h = await harness({ host: { database: { exportBytes: async () => { throw new Error('VACUUM INTO failed'); } } } });
  const r = await h.call('POST /api/backup/export-encrypted', { passphrase: PASS });
  assert.strictEqual(r.statusCode, 500);
  assert.strictEqual(r.body.error, 'Could not build the encrypted backup: VACUUM INTO failed');
});

test('import-encrypted: decrypt and check, then the safety copy, then replace, then the category list', async () => {
  const h = await harness();
  const r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body, { ok: true, snapshot: 'a file inside the app (plannr-pre-restore.db)' });
  assert.deepStrictEqual(h.names(), ['decrypt', 'writeDatabase', 'restore', 'refresh']);
  assert.strictEqual(h.calls[0][1], 5, 'the base64 body decoded');
  assert.strictEqual(h.calls[2][1], SQLITE.length, 'the decrypted bytes are what replaces the database');
});

test('import-encrypted: refused before anything changes (no safety copy, no restore)', async () => {
  for (const [body, status, msg] of [
    [{ dataBase64: 'AAAA' }, 400, /^Enter the passphrase this backup was encrypted with\.$/],
    [{ passphrase: PASS }, 400, /^Choose an encrypted backup file first\.$/],
    [restoreBody({ dataBase64: '%%% not base64 %%%' }), 400, /could not be read/],
    [restoreBody({ passphrase: 'wrong-passphrase' }), 400, /^Wrong passphrase/],
  ]) {
    const h = await harness();
    const r = await h.call('POST /api/backup/import-encrypted', body);
    assert.strictEqual(r.statusCode, status, JSON.stringify(body));
    assert.match(r.body.error, msg);
    assert.ok(!h.names().some((n) => n === 'writeDatabase' || n === 'restore' || n === 'refresh'), h.names().join());
  }
  const h = await harness({ decrypted: new Uint8Array(100) });
  const r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.body.error, /does not look like a SQLite database/);
  assert.deepStrictEqual(h.names(), ['decrypt']);
});

test('import-encrypted: no safety copy, no restore', async () => {
  const h = await harness({ host: { snapshot: { writeDatabase: async () => { throw new Error('no room'); } } } });
  const r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([r.statusCode, r.body], [500, { error: RESTORE_FAILED }]);
  assert.deepStrictEqual(h.names(), ['decrypt']);
  assert.ok(h.logged.some((l) => /Pre-restore snapshot failed.*no room/.test(l)), 'the cause is logged');
  const full = await harness({ host: { snapshot: { writeDatabase: async () => { throw new Error('database or disk is full'); } } } });
  const f = await full.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([f.statusCode, f.body], [500, { error: STORAGE_FULL }]);
  assert.deepStrictEqual(full.names(), ['decrypt']);
});

test('import-encrypted: each restore failure gets its own answer', async () => {
  const fail = (err) => harness({ host: { database: { restore: async () => { throw err; } } } });
  const tooNew = Object.assign(new Error('This backup was made by a newer version of Plannr.'), { code: 'BACKUP_TOO_NEW' });
  let h = await fail(tooNew);
  let r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([r.statusCode, r.body], [400, { error: 'This backup was made by a newer version of Plannr.' }]);
  const SNAP = 'a file inside the app (plannr-pre-restore.db)';
  h = await fail(new Error('database or disk is full'));
  r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([r.statusCode, r.body], [500, { error: STORAGE_FULL, snapshot: SNAP }]);
  // S3/Q6: every other failure left the data as it was (refused before the replace, or put back after
  // it): the owner's restore text (Q11), with the cause logged, not shown.
  h = await fail(new Error('not a SQLite database'));
  r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([r.statusCode, r.body], [500, { error: RESTORE_FAILED, snapshot: SNAP }]);
  assert.ok(h.logged.some((l) => /Encrypted import failed:.*not a SQLite database/.test(l)), 'the cause is logged');
  const undone = Object.assign(new Error('put back'), { code: 'RESTORE_UNDONE', cause: new Error('foreign_key_check failed') });
  h = await fail(undone);
  r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([r.statusCode, r.body], [500, { error: RESTORE_FAILED, snapshot: SNAP }]);
  assert.ok(!h.names().includes('refresh'));
  const undoneFull = Object.assign(new Error('put back'), { code: 'RESTORE_UNDONE', cause: new Error('database or disk is full') });
  h = await fail(undoneFull);
  r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([r.statusCode, r.body.error], [500, STORAGE_FULL]);
  const undoFailed = Object.assign(new Error('The restore failed (x), and putting the data back failed too (y).'), { code: 'RESTORE_UNDO_FAILED' });
  h = await fail(undoFailed);
  r = await h.call('POST /api/backup/import-encrypted', restoreBody());
  assert.deepStrictEqual([r.statusCode, r.body], [500, {
    error: `The restore failed, and putting your data back failed too. Make no changes: restore the safety copy (${SNAP}) or your latest backup. The restore failed (x), and putting the data back failed too (y).`,
    snapshot: SNAP,
  }]);
  assert.ok(!h.names().includes('refresh'));
});

test('import-encrypted: on a platform without database.restore, a 501 that says what to do, before anything is read', async () => {
  const h = await harness({ host: { database: { exportBytes: async () => SQLITE }, snapshot: { writeJson: async () => '' } } });
  delete h.host.database.restore;
  delete h.host.snapshot.writeDatabase;
  for (const body of [{}, restoreBody()]) {
    const r = await h.call('POST /api/backup/import-encrypted', body);
    assert.strictEqual(r.statusCode, 501);
    assert.strictEqual(r.body.error, h.RESTORE_UNAVAILABLE);
  }
  assert.deepStrictEqual(h.calls, []);
  assert.match(h.RESTORE_UNAVAILABLE, /Use the Android app to restore an encrypted backup, or restore this server from the plain JSON backup instead\.$/);
});
