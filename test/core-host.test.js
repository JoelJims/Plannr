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
const completeHost = () => ({ pdf: { render: fn }, snapshot: { writeJson: fn }, now: () => new Date() });

test('checkHost accepts a host with every listed service, and returns it', async () => {
  const { checkHost, HOST_SERVICES } = await loadHostModule();
  assert.deepStrictEqual(Object.keys(HOST_SERVICES).sort(), ['now', 'pdf.render', 'snapshot.writeJson']);
  const h = completeHost();
  assert.strictEqual(checkHost(h), h);
});

test('checkHost names every missing or non-function service', async () => {
  const { checkHost } = await loadHostModule();
  assert.throws(() => checkHost(undefined), /missing: pdf\.render, snapshot\.writeJson, now \(/);
  assert.throws(() => checkHost({ pdf: { render: fn }, now: fn }), /missing: snapshot\.writeJson \(/);
  assert.throws(() => checkHost({ pdf: { render: 'not a function' }, snapshot: { writeJson: fn }, now: fn }), /missing: pdf\.render \(/);
  assert.throws(() => checkHost({ pdf: null, snapshot: { writeJson: fn }, now: fn }), /missing: pdf\.render \(/);
  assert.throws(() => checkHost({ pdf: { render: fn }, snapshot: { writeJson: fn }, now: new Date() }), /missing: now \(/);
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
  });
}

test('the shared PDF route renders through host.pdf.render (step 1.4 A5)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core', 'routes', 'pdf.js'), 'utf8');
  assert.match(src, /await host\.pdf\.render\(overviewPdfHtml\(/);
});

test('the shared JSON import saves its safety copy through host.snapshot.writeJson (step 1.4 A7)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core', 'routes', 'backup.js'), 'utf8');
  assert.match(src, /await host\.snapshot\.writeJson\(backupFormat\.buildBackup\(db, \{ includeContacts: true \}\)\)/);
});

test('the backup reminder reads the time only through host.now (step 1.4 A6)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core', 'routes', 'backup-reminder.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, ''); // comments may name what is not used
  assert.match(code, /host\.now\(\)/);
  assert.doesNotMatch(code, /Date\.now\(|new Date\(\)|datetime\('now'\)/);
});
