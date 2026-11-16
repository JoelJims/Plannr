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
const completeHost = () => ({ pdf: { render: fn }, snapshot: { writeJson: fn } });

test('checkHost accepts a host with every listed service, and returns it', async () => {
  const { checkHost, HOST_SERVICES } = await loadHostModule();
  assert.deepStrictEqual(Object.keys(HOST_SERVICES).sort(), ['pdf.render', 'snapshot.writeJson']);
  const h = completeHost();
  assert.strictEqual(checkHost(h), h);
});

test('checkHost names every missing or non-function service', async () => {
  const { checkHost } = await loadHostModule();
  assert.throws(() => checkHost(undefined), /missing: pdf\.render, snapshot\.writeJson/);
  assert.throws(() => checkHost({ pdf: { render: fn } }), /missing: snapshot\.writeJson\b/);
  assert.throws(() => checkHost({ pdf: { render: 'not a function' }, snapshot: { writeJson: fn } }), /missing: pdf\.render\b/);
  assert.throws(() => checkHost({ pdf: null, snapshot: { writeJson: fn } }), /missing: pdf\.render\b/);
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
    // The routes that use a service call it through the host, not the platform function directly.
    assert.match(src, /await host\.snapshot\.writeJson\(buildBackup\(/);
  });
}

test('the shared PDF route renders through host.pdf.render (step 1.4 A5)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'core', 'routes', 'pdf.js'), 'utf8');
  assert.match(src, /await host\.pdf\.render\(overviewPdfHtml\(/);
});
