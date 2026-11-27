// F10 (docs/security-quality-review-2026-11-21.md): run-tests.js picks the files for its phone pass
// (pass 2) by whether they load test/helpers.js. It matched one literal spelling only, so
// require("./helpers") or require('./helpers.js') silently left a file out of the phone pass.
// The check is usesHelpers(source); requiring run-tests.js must not start a test run.
const { test } = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');

function loadRunTests() {
  const spawned = [];
  const realSpawn = childProcess.spawnSync;
  const realExit = process.exit;
  childProcess.spawnSync = (...args) => { spawned.push(args[1]); return { status: 0, stdout: '', stderr: '' }; };
  process.exit = (code) => { throw new Error(`run-tests.js called process.exit(${code}) on require`); };
  try {
    return { mod: require('../run-tests'), spawned };
  } finally {
    childProcess.spawnSync = realSpawn;
    process.exit = realExit;
  }
}

test('F10: requiring run-tests.js starts no test run', () => {
  const { spawned } = loadRunTests();
  assert.deepStrictEqual(spawned, []);
});

test('F10: the phone pass finds every way a test file loads test/helpers.js', () => {
  const { mod } = loadRunTests();
  assert.strictEqual(typeof mod.usesHelpers, 'function');
  for (const src of [
    "const H = require('./helpers');",
    'const H = require("./helpers");',
    'const H = require(`./helpers`);',
    "const H = require('./helpers.js');",
    "const H = require( './helpers' );",
    "const { req, startApp } = require('./helpers');",
  ]) assert.strictEqual(mod.usesHelpers(src), true, src);
  for (const src of [
    "const x = require('./helpers-other');",
    "const x = require('./shim-target');",
    '// not loaded here: test/helpers.js',
    "const y = require('../helpers');",
  ]) assert.strictEqual(mod.usesHelpers(src), false, src);
});
