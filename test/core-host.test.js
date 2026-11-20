// Step 1.4 A4: core/host.js, the platform services the shared core may call.
//
// checkHost() runs when each platform starts (server.js and public/local-api.js), so if either
// host were incomplete, every other test file would fail to start. This file checks checkHost and
// hostError themselves, and that both platforms really build their host through checkHost and hand
// it to the core.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const loadHostModule = () => import(pathToFileURL(path.join(ROOT, 'core', 'host.js')).href);
const fn = async () => {};
const completeHost = () => ({
  pdf: { render: fn }, snapshot: { writeJson: fn }, now: () => new Date(),
  crypto: { encrypt: fn, decrypt: fn }, database: { exportBytes: fn }, storage: { info: fn },
});

test('checkHost accepts a host with every listed service, and returns it', async () => {
  const { checkHost, HOST_SERVICES, HOST_OPTIONAL } = await loadHostModule();
  assert.deepStrictEqual(Object.keys(HOST_SERVICES).sort(), ['crypto.decrypt', 'crypto.encrypt', 'database.exportBytes', 'now', 'pdf.render', 'snapshot.writeJson', 'storage.info']);
  assert.deepStrictEqual(Object.keys(HOST_OPTIONAL).sort(), ['database.restore', 'snapshot.writeDatabase']);
  const h = completeHost();
  assert.strictEqual(checkHost(h), h);
});

test('checkHost names every missing or non-function service', async () => {
  const { checkHost } = await loadHostModule();
  const without = (over) => ({ ...completeHost(), ...over });
  assert.throws(() => checkHost(undefined), /missing: pdf\.render, snapshot\.writeJson, now, crypto\.encrypt, crypto\.decrypt, database\.exportBytes, storage\.info \(/);
  assert.throws(() => checkHost(without({ snapshot: undefined })), /missing: snapshot\.writeJson \(/);
  assert.throws(() => checkHost(without({ pdf: { render: 'not a function' } })), /missing: pdf\.render \(/);
  assert.throws(() => checkHost(without({ pdf: null })), /missing: pdf\.render \(/);
  assert.throws(() => checkHost(without({ now: new Date() })), /missing: now \(/);
  assert.throws(() => checkHost(without({ crypto: { encrypt: fn } })), /missing: crypto\.decrypt \(/);
  assert.throws(() => checkHost(without({ database: {} })), /missing: database\.exportBytes \(/);
  assert.throws(() => checkHost(without({ storage: { info: {} } })), /missing: storage\.info \(/);
});

test('checkHost: the optional services may be left out, but if given they are functions, and the restore comes with its safety copy (C11)', async () => {
  const { checkHost, hostService } = await loadHostModule();
  const h = completeHost();
  assert.strictEqual(checkHost(h), h, 'neither: fine (the dev server until D1)');
  const both = { ...completeHost(), database: { exportBytes: fn, restore: fn }, snapshot: { writeJson: fn, writeDatabase: fn } };
  assert.strictEqual(checkHost(both), both, 'both: fine (the phone)');
  assert.strictEqual(hostService(both, 'database.restore'), fn);
  assert.strictEqual(hostService(h, 'database.restore'), undefined);
  assert.throws(() => checkHost({ ...completeHost(), database: { exportBytes: fn, restore: 'yes' } }), /missing: database\.restore \(not a function\)/);
  assert.throws(() => checkHost({ ...completeHost(), database: { exportBytes: fn, restore: fn } }), /missing: snapshot\.writeDatabase \(needed with database\.restore\)/);
  assert.throws(() => checkHost({ ...completeHost(), snapshot: { writeJson: fn, writeDatabase: fn } }), /missing: database\.restore \(needed with snapshot\.writeDatabase\)/);
});

test('hostError carries the status and the exact message for the page, and the cause for logs', async () => {
  const { hostError } = await loadHostModule();
  const cause = new Error('chromium crashed');
  const e = hostError(503, 'The server is busy.', cause);
  assert.ok(e instanceof Error);
  assert.strictEqual(e.status, 503);
  assert.strictEqual(e.userMessage, 'The server is busy.');
  assert.strictEqual(e.message, 'The server is busy.');
  assert.strictEqual(e.cause, cause);
  assert.ok(!('cause' in hostError(500, 'x')));
});

for (const [file, importLine] of [
  ['server.js', /const \{ checkHost, hostError \} = require\('\.\/core\/host\.js'\);/],
  ['public/local-api.js', /import \{ checkHost, hostError \} from '\.\/core\/host\.js';/],
]) {
  test(`${file} builds its host through checkHost and gives it to the core`, () => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, importLine);
    assert.match(src, /const host = checkHost\(\{/);
    const ctx = src.match(/const coreContext = \{([\s\S]*?)\n\s*\};/);
    assert.ok(ctx, 'coreContext found');
    assert.match(ctx[1], /\bhost,/);
    // A7: the JSON import (and its safety copy) is core/routes/backup.js, so neither platform keeps
    // its own backup helpers.
    assert.doesNotMatch(src, /\b(?:const|function)\s+(?:buildBackup|validateBackup)\b/);
    // A6: the clock is the real one on both platforms.
    assert.match(src, /\n\s*now: \(\) => new Date\(\),\n/);
    // C11: the encrypted backup and /api/storage are the core's; each platform keeps only its host part.
    assert.match(src, /\n\s*crypto: \{ encrypt: \(bytes, passphrase\) => encrypt\(bytes, passphrase\), decrypt: \(bytes, passphrase\) => decrypt\(bytes, passphrase\) \},\r?\n/);
    assert.match(src, /\n\s*storage: \{ info: /);
    assert.doesNotMatch(src, /\.post\('\/api\/backup\/(?:export|import)-encrypted'/);
    assert.doesNotMatch(src, /MIN_PASSPHRASE_LEN|looksLikeSqlite/);
  });
}

test('the phone and the dev server both restore an encrypted backup, each after a whole-database safety copy (C11, D1)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const phone = fs.readFileSync(path.join(ROOT, 'public', 'local-api.js'), 'utf8');
  assert.match(server, /database: \{ exportBytes: async \(\) => dbAdapter\(\)\.exportBytes\(\), restore: \(bytes\) => restoreFromBytes\(bytes\) \}/);
  assert.match(server, /writeDatabase: async \(\) => projectPath\(writeRestoreSnapshot\(\)\)/);
  assert.match(phone, /database: \{ exportBytes: async \(\) => exportSnapshotBytes\(\), restore: \(bytes\) => restoreSnapshotBytes\(bytes\) \}/);
  assert.match(phone, /writeDatabase: \(\) => writePreRestoreSnapshot\(\)/);
});

test('the shared PDF route renders through host.pdf.render (step 1.4 A5)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core', 'routes', 'pdf.js'), 'utf8');
  // Step 1.4 B5: the page is built inside the request queue, then rendered outside it.
  assert.match(src, /const html = await exclusive\(\(\) => overviewPdfHtml\(/);
  assert.match(src, /await host\.pdf\.render\(html, /);
});

test('the shared JSON import saves its safety copy through host.snapshot.writeJson (step 1.4 A7)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core', 'routes', 'backup.js'), 'utf8');
  assert.match(src, /await host\.snapshot\.writeJson\(await backupFormat\.buildBackup\(adapter, \{ includeContacts: true \}\)\)/);
});

test('the backup reminder reads the time only through host.now (step 1.4 A6)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core', 'routes', 'backup-reminder.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, ''); // comments may name what is not used
  assert.match(code, /host\.now\(\)/);
  assert.doesNotMatch(code, /Date\.now\(|new Date\(\)|datetime\('now'\)/);
});
