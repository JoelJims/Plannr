// Review finding F20: the desktop code and the whole test suite open the database through
// `node:sqlite`, which Node 22 provides without the --experimental-sqlite flag only from 22.13.0.
// So the lowest Node version that package.json (and the root entry of package-lock.json) promises
// must be 22.13.0, not 22.12.0.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const json = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

test('package.json engines: Node >=22.13.0 (node:sqlite without a flag)', () => {
  assert.strictEqual(json('package.json').engines.node, '>=22.13.0');
});

test('package-lock.json root entry says the same', () => {
  assert.strictEqual(json('package-lock.json').packages[''].engines.node, '>=22.13.0');
});

test('the desktop database code really uses node:sqlite (why the floor is 22.13.0)', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'db-adapter-node.js'), 'utf8'), /node:sqlite/);
});
