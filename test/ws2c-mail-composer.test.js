// "Send by email" (docs/share-and-reminder-pdf-plan.md, section 7): the mail-composer plugin is
// pinned to exactly 0.2.2, copied into public/node_modules by sync-public-modules.js (its
// VENDOR_PACKAGES list), and reachable from the import maps of Overview and Home, the two pages
// that use it. A caret range or a missing import-map entry would fail on the phone only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG = '@capawesome/capacitor-mail-composer';
const json = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

test('pinned exactly to 0.2.2 in package.json and package-lock.json', () => {
  assert.strictEqual(json('package.json').dependencies[PKG], '0.2.2');
  const lock = json('package-lock.json');
  assert.strictEqual(lock.packages[''].dependencies[PKG], '0.2.2');
  assert.strictEqual(lock.packages[`node_modules/${PKG}`].version, '0.2.2');
});

test('sync-public-modules.js copies it into public/node_modules', () => {
  const { VENDOR_PACKAGES } = require('../sync-public-modules.js');
  assert.ok(VENDOR_PACKAGES.map((p) => p.split(path.sep).join('/')).includes(PKG), VENDOR_PACKAGES.join(', '));
});

for (const page of ['overview.html', 'home.html']) {
  test(`${page}: the import map points at the plugin's installed ESM entry`, () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    const map = JSON.parse(src.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
    const target = map.imports[PKG];
    assert.ok(target, `${page} has no import-map entry for ${PKG}`);
    assert.ok(target.startsWith(`/node_modules/${PKG}/`), target);
    assert.ok(fs.existsSync(path.join(ROOT, target)), `${target} exists in node_modules`);
  });
}
